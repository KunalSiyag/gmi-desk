/**
 * Chat threads and streaming replies.
 *
 * send(): validate → budget check → inference key present → append the user message and a `streaming`
 * assistant placeholder → persist → emit → stream in the background through the GMI gateway (harness.md §4.8:
 * purpose `chat`, priority `interactive`). Progress goes out on `chat:stream` (start → delta… → routing →
 * done | error), thread summaries on `chat:threads`. The gateway owns the wire (bodies, parsers, key, retries,
 * breaker, metering); chat maps its events to the unchanged ChatStreamEvents and writes one ledger row per reply.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CatalogModel } from '@shared/contracts/catalog';
import type {
  ChatApi,
  ChatMessage,
  ChatMessageStatus,
  ChatSettings,
  ChatStreamEvent,
  ChatThread,
  ChatThreadSummary,
  TokenUsage,
} from '@shared/contracts/chat';
import { GmiError, toGmiError, type GmiErrorShape } from '@shared/contracts/errors';
import type { GatewayRequest, GwMessage } from '@shared/contracts/gateway';
import { formatNumber, truncate } from '@shared/lib/format';
import { roundPrice } from '@shared/lib/money';
import type { AppContext } from '../../core/context';
import type { BudgetGuard, CatalogService, GmiGateway, KeyProvider } from '../../core/services';
import { BREAKER_OPEN_DETAIL } from '../gateway/types';
import { estimateReplyCostUsd } from './cost';
import { buildSeedThreads, mockCostUsd } from './mock';
import { isModelId, normalizeChatSettings } from './settings';
import { assertThreadId, DEFAULT_TITLE, isThreadId, ThreadStore, toPublicThread, type ThreadRecord } from './store';
import type { ChatPlan, ChatRoute, HistoryMessage } from './types';

export interface ChatDeps {
  /** Every reply goes through the GMI gateway (harness.md §4.8), set up before chat. */
  gateway: GmiGateway;
  catalog: CatalogService;
  budget: BudgetGuard;
  /**
   * Only to refuse send() up front with `no_api_key` (outside mock mode), so the renderer can offer Connect chat
   * before anything is appended. The gateway fetches the key itself and reports refused keys (D15).
   */
  keys?: KeyProvider;
}

export interface ChatOptions {
  /** A reply that receives no bytes for this long fails with `timeout`. Default 2 minutes. */
  idleTimeoutMs?: number;
  /** Deltas are batched into one `chat:stream` event at most this often. Default 40ms. */
  flushIntervalMs?: number;
  /** Long replies are saved to disk this often while streaming. Default 2s. */
  persistIntervalMs?: number;
  /** Mock-mode pacing of the private gateway createChatSlice builds when none is passed (tests). */
  mockSpeed?: number;
}

export interface ChatService {
  api: ChatApi;
  dispose(): Promise<void>;
}

export const MAX_MESSAGE_CHARS = 200_000;
const TITLE_MAX_CHARS = 60;
const CUSTOM_TITLE_MAX_CHARS = 200;

type AbortReason = 'user' | 'idle' | 'dispose';

interface Run {
  threadId: string;
  messageId: string;
  controller: AbortController;
  abortReason: AbortReason | null;
  finished: Promise<void>;
}

interface Prepared {
  route: ChatRoute;
  model: string | null;
  /** A reached budget limit that is not enforced (warn-only): the reply goes ahead, the user is told. */
  budgetWarning: string | null;
  /** "Try anyway": the reply being regenerated failed fast on an open circuit breaker (harness.md §4.6). */
  forceBreakerProbe: boolean;
}

/** What the renderer shows for a chat whose context no longer fits (harness.md §4.8 behaviour change 1). */
export const CONTEXT_FULL_MESSAGE = "Start a new chat (the model's context is full).";
/** The breaker fast-fail (§4.6): Retry on this reply forces the half-open probe ("Try anyway"). */
export const BREAKER_OPEN_MESSAGE = 'GMI is failing for this model right now. Try anyway sends the request regardless.';

const MAX_KEEP_IDS = 10_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** First user message → thread title (no LLM call). */
export function titleFromMessage(content: string): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\s`]+/, '')
    .trim();
  return flat ? truncate(flat, TITLE_MAX_CHARS) : DEFAULT_TITLE;
}

/** Messages sent upstream: earlier user turns and finished assistant turns that have text. */
export function historyFor(messages: ChatMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content.trim()) out.push({ role: 'user', content: m.content });
    } else if (m.status !== 'error' && m.status !== 'streaming' && m.content.trim()) {
      out.push({ role: 'assistant', content: m.content });
    }
  }
  return out;
}

/** When the catalog does not know a model: OpenAI codex / pro models only work on the Responses API. */
export function guessApi(modelId: string): 'chat' | 'responses' {
  return /^openai\/.*(codex|-pro)(?![\w.])/i.test(modelId) ? 'responses' : 'chat';
}

/** The gateway's canonical messages for a reply: the system prompt, then the history (no reasoning replayed). */
export function gatewayMessages(settings: Pick<ChatSettings, 'systemPrompt'>, history: HistoryMessage[]): GwMessage[] {
  const out: GwMessage[] = [];
  if (settings.systemPrompt) out.push({ role: 'system', content: settings.systemPrompt });
  for (const m of history) out.push({ role: m.role, content: m.content });
  return out;
}

/** The gateway request for one reply (harness.md §4.8). `forceBreakerProbe` is read by the gateway (contract addition pending). */
export function chatGatewayRequest(requestId: string, threadId: string, plan: ChatPlan, forceBreakerProbe = false): GatewayRequest & { forceBreakerProbe?: boolean } {
  const router = plan.route === 'router';
  const req: GatewayRequest & { forceBreakerProbe?: boolean } = {
    requestId,
    purpose: 'chat',
    priority: 'interactive',
    scope: { threadId, turnId: null, runId: null, step: null },
    target: router || !plan.model ? { router: plan.settings.routerMode } : { model: plan.model },
    messages: gatewayMessages(plan.settings, plan.history),
    maxOutputTokens: plan.settings.maxTokens,
    // GMI Router takes plain chat only (it ignores these) [V: D6].
    temperature: router ? null : plan.settings.temperature,
    reasoningEffort: router ? null : plan.settings.reasoningEffort,
    prefixHash: null,
  };
  if (forceBreakerProbe) req.forceBreakerProbe = true;
  return req;
}

/** A gateway error as chat stores and shows it. */
export function chatError(error: GmiErrorShape): GmiErrorShape {
  if (error.code === 'context_overflow') return { ...error, message: CONTEXT_FULL_MESSAGE, detail: error.detail ?? error.message };
  if (error.detail === BREAKER_OPEN_DETAIL) return { ...error, message: BREAKER_OPEN_MESSAGE };
  return error;
}

function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new GmiError('invalid_input', 'The title must be text.');
  return truncate(raw.replace(/\s+/g, ' ').trim(), CUSTOM_TITLE_MAX_CHARS);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GmiError('invalid_input', `${what} must be an object.`);
  return value as Record<string, unknown>;
}

/** createThread's `keepIds`: chat ids (validated before they are compared with anything). */
function keepIdsFrom(raw: unknown): ReadonlySet<string> {
  if (raw === undefined || raw === null) return new Set();
  if (!Array.isArray(raw) || raw.length > MAX_KEEP_IDS || !raw.every(isThreadId)) {
    throw new GmiError('invalid_input', 'keepIds must be a list of chat ids.');
  }
  return new Set(raw);
}

export async function createChatService(ctx: AppContext, deps: ChatDeps, opts: ChatOptions = {}): Promise<ChatService> {
  const log = ctx.log.child('chat');
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  const flushIntervalMs = opts.flushIntervalMs ?? 40;
  const persistIntervalMs = opts.persistIntervalMs ?? 2_000;

  const store = new ThreadStore(join(ctx.paths.data, 'chat'), log, () => ctx.now());
  await store.init();
  if (ctx.mock && !store.indexExisted && store.list().length === 0) {
    for (const record of buildSeedThreads(ctx.now())) await store.put(record);
    log.info('seeded demo chats');
  }

  const runs = new Map<string, Run>();
  const starting = new Set<string>();
  let disposed = false;

  const nowIso = () => ctx.now().toISOString();

  function summaries(): ChatThreadSummary[] {
    return store.list().map((s) => (runs.has(s.id) ? { ...s, streaming: true } : s));
  }
  const emitThreads = () => ctx.events.emit('chat:threads', summaries());
  const emitStream = (event: ChatStreamEvent) => ctx.events.emit('chat:stream', event);
  const publicThread = (record: ThreadRecord): ChatThread => structuredClone(toPublicThread(record));

  async function findModel(id: string): Promise<CatalogModel | null> {
    try {
      return await deps.catalog.findModel(id);
    } catch (error) {
      log.warn(`catalog lookup failed for ${id}`, error);
      return null;
    }
  }

  async function costFor(modelId: string, usage: TokenUsage): Promise<number | null> {
    const cost = estimateReplyCostUsd(usage, await findModel(modelId));
    if (cost === null && ctx.mock) return mockCostUsd(modelId, usage);
    return cost;
  }

  async function defaultSettings(): Promise<ChatSettings> {
    const app = ctx.settings.get();
    const base: ChatSettings = {
      mode: 'auto',
      model: null,
      routerMode: app.defaultRouterMode,
      maxTokens: app.chatMaxTokens,
      temperature: null,
      reasoningEffort: null,
      systemPrompt: null,
    };
    let model = isModelId(app.defaultChatModel) ? app.defaultChatModel : null;
    if (!model) {
      try {
        const snapshot = await deps.catalog.getSnapshot();
        model = snapshot.models.find((m) => m.kind === 'llm' && m.featured && m.api === 'chat' && m.available)?.id ?? null;
      } catch (error) {
        log.warn('catalog unavailable while picking the default chat model', error);
      }
    }
    if (model) {
      base.mode = 'model';
      base.model = model;
    }
    return base;
  }

  /**
   * Empty, never-named threads are drafts: starting another new chat discards them. Not discarded: threads in
   * `keep` (the renderer still holds unsent text for them) and threads given a system prompt or temperature,
   * which the user took the time to set up.
   */
  async function pruneEmptyDrafts(keep: ReadonlySet<string>): Promise<void> {
    for (const s of store.list()) {
      if (s.messageCount > 0 || keep.has(s.id) || runs.has(s.id) || starting.has(s.id)) continue;
      const record = await store.get(s.id).catch(() => null);
      if (!record || record.titleCustom || record.messages.length > 0) continue;
      if (record.settings.systemPrompt !== null || record.settings.temperature !== null) continue;
      await store.remove(s.id).catch(() => undefined);
    }
  }

  async function withStartGuard<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    if (disposed) throw new GmiError('cancelled', 'The app is shutting down.');
    if (runs.has(threadId) || starting.has(threadId)) {
      throw new GmiError('invalid_input', 'A reply is still being written in this chat. Stop it first.');
    }
    starting.add(threadId);
    try {
      return await fn();
    } finally {
      starting.delete(threadId);
    }
  }

  /** Validates that the thread can get a reply right now and decides which API serves it. */
  async function prepare(record: ThreadRecord, forceBreakerProbe = false): Promise<Prepared> {
    const settings = record.settings;
    let route: ChatRoute = 'router';
    let model: string | null = null;
    if (settings.mode === 'model') {
      if (!settings.model) throw new GmiError('invalid_input', 'Choose a model for this chat first.');
      model = settings.model;
      const info = await findModel(model);
      const api = info?.api ?? guessApi(model);
      if (api === 'queue') {
        throw new GmiError('invalid_input', `${info?.name ?? model} generates media and cannot chat. Pick a language model.`);
      }
      route = api === 'responses' ? 'responses' : 'chat';
    }
    const check = await deps.budget.check(null, 'chat');
    if (!check.allowed) throw new GmiError('budget_exceeded', check.reason ?? 'This would go over the budget you set in Usage.');
    // Refused before anything is appended, so the renderer offers Connect chat (the gateway fetches the key itself).
    if (!ctx.mock && deps.keys) await deps.keys.requireInferenceKey();
    // Allowed with a reason = a limit is reached but not enforced (warn-only): chat goes on, the user is warned.
    return { route, model, budgetWarning: check.reason || null, forceBreakerProbe };
  }

  /** Appends the streaming placeholder, persists, emits `start` and streams in the background. */
  async function startReply(record: ThreadRecord, prepared: Prepared): Promise<ChatMessage> {
    const history = historyFor(record.messages);
    const assistant: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      reasoning: null,
      model: prepared.model,
      routing: null,
      usage: null,
      costUsd: null,
      createdAt: nowIso(),
      status: 'streaming',
      error: null,
      finishReason: null,
      completedAt: null,
      // The limit this request carries (GMI Router takes none), so a "cut off" notice names the right one.
      maxTokens: prepared.route === 'router' ? null : record.settings.maxTokens,
    };
    record.messages.push(assistant);
    record.updatedAt = assistant.createdAt;

    let resolveFinished: () => void = () => undefined;
    const run: Run = {
      threadId: record.id,
      messageId: assistant.id,
      controller: new AbortController(),
      abortReason: null,
      finished: new Promise<void>((resolve) => {
        resolveFinished = resolve;
      }),
    };
    runs.set(record.id, run);
    await store.put(record);
    emitThreads();
    emitStream({ threadId: record.id, messageId: assistant.id, type: 'start', model: prepared.model });

    const plan: ChatPlan = { route: prepared.route, model: prepared.model, settings: { ...record.settings }, history };
    void execute(run, record, assistant, plan, prepared.forceBreakerProbe)
      .catch((error: unknown) => log.error('chat stream crashed', error))
      .finally(resolveFinished);
    return assistant;
  }

  async function execute(run: Run, record: ThreadRecord, msg: ChatMessage, plan: ChatPlan, forceBreakerProbe: boolean): Promise<void> {
    const { controller } = run;
    let pendingContent = '';
    let pendingReasoning = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPersist = Date.now();
    let usage: TokenUsage | null = null;
    let usageEstimated = false;
    // Sum over the gateway's billed attempts (null: none priced).
    let gatewayCostUsd: number | null = null;
    let finishReason: string | null = null;
    let failure: GmiErrorShape | null = null;

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pendingContent && !pendingReasoning) return;
      const event: Extract<ChatStreamEvent, { type: 'delta' }> = { threadId: run.threadId, messageId: run.messageId, type: 'delta' };
      if (pendingContent) {
        event.content = pendingContent;
        event.contentOffset = msg.content.length;
        msg.content += pendingContent;
        pendingContent = '';
      }
      if (pendingReasoning) {
        const before = msg.reasoning ?? '';
        event.reasoning = pendingReasoning;
        event.reasoningOffset = before.length;
        msg.reasoning = before + pendingReasoning;
        pendingReasoning = '';
      }
      emitStream(event);
      if (Date.now() - lastPersist >= persistIntervalMs) {
        lastPersist = Date.now();
        void store.putIfExists(record, { index: false });
      }
    };
    const scheduleFlush = () => {
      if (flushIntervalMs <= 0) flush();
      else flushTimer ??= setTimeout(flush, flushIntervalMs);
    };
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        run.abortReason ??= 'idle';
        controller.abort();
      }, idleTimeoutMs);
    };

    touch();
    try {
      // The stream is read to its end even after an abort: the gateway settles the request (estimated usage for a
      // stopped reply, whose prompt GMI billed) and then ends it with a `cancelled` error.
      for await (const ev of deps.gateway.stream(chatGatewayRequest(msg.id, run.threadId, plan, forceBreakerProbe), controller.signal)) {
        if (!controller.signal.aborted) touch();
        switch (ev.type) {
          case 'text':
            if (controller.signal.aborted) break;
            pendingContent += ev.text;
            scheduleFlush();
            break;
          case 'reasoning':
            if (controller.signal.aborted) break;
            pendingReasoning += ev.text;
            scheduleFlush();
            break;
          case 'model':
            if (!msg.model && plan.route !== 'router') msg.model = ev.model;
            break;
          case 'routing':
            flush();
            msg.routing = ev.routing;
            msg.model = ev.routing.selectedModel;
            emitStream({ threadId: run.threadId, messageId: run.messageId, type: 'routing', routing: ev.routing });
            break;
          case 'usage':
            usage = ev.usage;
            usageEstimated = ev.estimated;
            if (ev.costUsd !== null) gatewayCostUsd = (gatewayCostUsd ?? 0) + ev.costUsd;
            break;
          case 'finish':
            finishReason = ev.raw ?? ev.reason;
            break;
          case 'error':
            failure = ev.error;
            break;
          default:
            // queued / started / retry: progress only (ChatStreamEvent is unchanged); chat sends no tools.
            break;
        }
      }
    } catch (error) {
      // The gateway throws only for a request it refuses outright (invalid_input).
      if (!run.abortReason) failure = toGmiError(error).toShape();
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
    flush();

    let status: ChatMessageStatus = 'complete';
    let error: GmiErrorShape | null = null;
    if (run.abortReason === 'idle') {
      status = 'error';
      error = new GmiError('timeout', `GMI stopped sending the reply (nothing received for ${Math.round(idleTimeoutMs / 1000)}s).`).toShape();
    } else if (run.abortReason || failure?.code === 'cancelled') {
      // Stopped by the user, or the gateway shut down under it (quit): keep what arrived.
      status = 'stopped';
    } else if (failure) {
      status = 'error';
      // The gateway already removed the key from upstream text and reported a refused credential (D15).
      error = chatError(failure);
    } else if (!msg.content && !msg.reasoning && !finishReason && !usage) {
      status = 'error';
      error = new GmiError('upstream', 'GMI ended the reply without sending anything.').toShape();
    }

    const modelId = msg.routing?.selectedModel ?? msg.model;
    if (usage) {
      // Measured, or estimated by the gateway whenever GMI answered 2xx without token counts (stopped, timed out,
      // failed mid-stream, or a GMI Router stream without a usage chunk): the prompt and every generated token
      // are still billed, so the spend is never left out of the budget.
      msg.usage = usage;
      if (usageEstimated) msg.usageEstimated = true;
    }
    if (msg.usage) {
      // Unknown model or prices (e.g. stopped before GMI Router said which model it picked): the cost stays
      // null, i.e. unknown. Never $0 as if it had been measured.
      msg.costUsd = gatewayCostUsd ?? (modelId ? await costFor(modelId, msg.usage) : null);
      // A cost the gateway priced is already in the ledger (its meter records the chat row, ref = this message id,
      // before the reservation is released); only a cost priced here is recorded here.
      if (gatewayCostUsd === null && modelId && msg.costUsd !== null && msg.costUsd > 0) {
        await deps.budget
          .record({ kind: 'chat', modelId, usd: msg.costUsd, ref: msg.id })
          .catch((e: unknown) => log.warn('could not record chat spend', e));
      } else if (msg.usageEstimated && msg.costUsd === null) {
        log.warn(`chat reply ${msg.id} has no usage and could not be priced (model ${modelId ?? 'unknown'})`);
      }
    }

    msg.status = status;
    msg.error = error;
    msg.finishReason = finishReason;
    msg.completedAt = nowIso();
    // updatedAt stays at the send time, so the thread list does not reshuffle when replies finish.
    runs.delete(run.threadId);
    await store.putIfExists(record);

    const message = structuredClone(msg);
    if (error) emitStream({ threadId: run.threadId, messageId: run.messageId, type: 'error', error, message });
    else emitStream({ threadId: run.threadId, messageId: run.messageId, type: 'done', message });
    emitThreads();
  }

  async function abortRun(run: Run, reason: AbortReason): Promise<void> {
    run.abortReason ??= reason;
    run.controller.abort();
    await Promise.race([run.finished, delay(3_000)]);
  }

  const api: ChatApi = {
    async listThreads() {
      return summaries();
    },

    async getThread(id) {
      assertThreadId(id);
      try {
        return publicThread(await store.get(id));
      } catch (error) {
        if (error instanceof GmiError && error.code === 'not_found') emitThreads();
        throw error;
      }
    },

    async createThread(init) {
      const options = init === undefined || init === null ? {} : asObject(init, 'Chat options');
      const keep = keepIdsFrom(options.keepIds);
      const base = await defaultSettings();
      const settings = options.settings === undefined ? base : normalizeChatSettings(asObject(options.settings, 'Chat settings'), base, { strict: true });
      const title = options.title === undefined ? '' : cleanTitle(options.title);
      await pruneEmptyDrafts(keep);
      const now = nowIso();
      const record: ThreadRecord = {
        id: randomUUID(),
        title: title || DEFAULT_TITLE,
        mode: settings.mode,
        model: settings.mode === 'model' ? settings.model : null,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        costUsd: 0,
        settings,
        messages: [],
        titleCustom: Boolean(title),
        discardedCostUsd: 0,
      };
      await store.put(record);
      emitThreads();
      return publicThread(record);
    },

    async updateThread(id, patch) {
      assertThreadId(id);
      const changes = asObject(patch, 'The update');
      const record = await store.get(id);
      if (changes.title !== undefined) {
        const title = cleanTitle(changes.title);
        if (title) {
          record.title = title;
          record.titleCustom = true;
        } else {
          const firstUser = record.messages.find((m) => m.role === 'user');
          record.title = firstUser ? titleFromMessage(firstUser.content) : DEFAULT_TITLE;
          record.titleCustom = false;
        }
      }
      if (changes.settings !== undefined) {
        record.settings = normalizeChatSettings(asObject(changes.settings, 'Chat settings'), record.settings, { strict: true });
        record.mode = record.settings.mode;
        record.model = record.settings.mode === 'model' ? record.settings.model : null;
      }
      await store.put(record);
      emitThreads();
      return publicThread(record);
    },

    async deleteThread(id) {
      assertThreadId(id);
      const run = runs.get(id);
      if (run) await abortRun(run, 'user');
      await store.remove(id);
      emitThreads();
    },

    async send(threadId, content) {
      assertThreadId(threadId);
      if (typeof content !== 'string') throw new GmiError('invalid_input', 'The message must be text.');
      const text = content.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd();
      if (!text.trim()) throw new GmiError('invalid_input', 'Type a message first.');
      if (text.length > MAX_MESSAGE_CHARS) {
        throw new GmiError('invalid_input', `Messages are limited to ${formatNumber(MAX_MESSAGE_CHARS)} characters.`);
      }
      return withStartGuard(threadId, async () => {
        const record = await store.get(threadId);
        const prepared = await prepare(record);
        const user: ChatMessage = {
          id: randomUUID(),
          role: 'user',
          content: text,
          reasoning: null,
          model: null,
          routing: null,
          usage: null,
          costUsd: null,
          createdAt: nowIso(),
          status: 'complete',
          error: null,
        };
        if (!record.titleCustom && !record.messages.some((m) => m.role === 'user')) record.title = titleFromMessage(text);
        record.messages.push(user);
        const assistant = await startReply(record, prepared);
        return { userMessageId: user.id, assistantMessageId: assistant.id, budgetWarning: prepared.budgetWarning };
      });
    },

    async stop(threadId) {
      assertThreadId(threadId);
      const run = runs.get(threadId);
      if (run) await abortRun(run, 'user');
    },

    async regenerate(threadId) {
      assertThreadId(threadId);
      return withStartGuard(threadId, async () => {
        const record = await store.get(threadId);
        const last = record.messages[record.messages.length - 1];
        const question = last?.role === 'assistant' ? record.messages[record.messages.length - 2] : last;
        if (!question || question.role !== 'user') throw new GmiError('invalid_input', 'There is no message to answer yet.');
        // Retrying a reply that failed fast on an open breaker is "Try anyway": the gateway lets it probe the model.
        const tryAnyway = last?.role === 'assistant' && last.status === 'error' && last.error?.detail === BREAKER_OPEN_DETAIL;
        const prepared = await prepare(record, tryAnyway);
        if (last?.role === 'assistant') {
          record.messages.pop();
          // The discarded reply was still paid for: keep it in the thread's cost.
          if (last.costUsd) record.discardedCostUsd = roundPrice(record.discardedCostUsd + last.costUsd);
        }
        const assistant = await startReply(record, prepared);
        return { assistantMessageId: assistant.id, budgetWarning: prepared.budgetWarning };
      });
    },
  };

  return {
    api,
    async dispose() {
      disposed = true;
      const active = [...runs.values()];
      for (const run of active) {
        run.abortReason ??= 'dispose';
        run.controller.abort();
        // The quit sequence does not wait for promises: save what has arrived synchronously.
        const record = store.peek(run.threadId);
        if (record) store.writeSync(record);
      }
      await Promise.race([Promise.all(active.map((r) => r.finished)), delay(1_500)]);
      await store.flush();
    },
  };
}
