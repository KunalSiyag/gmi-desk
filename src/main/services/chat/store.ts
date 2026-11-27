/**
 * Chat persistence: one JSON file per thread (<data>/chat/threads/<id>.json) plus an index of
 * summaries (<data>/chat/index.json). Writes are atomic (temp + rename), coalesced and serialised per
 * file. Ids are validated (UUID) before they are ever used in a path.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@shared/contracts/app';
import type { ChatMessage, ChatMessageStatus, ChatSettings, ChatThread, ChatThreadSummary, RoutingInfo, TokenUsage } from '@shared/contracts/chat';
import { GmiError, type GmiErrorCode, type GmiErrorShape } from '@shared/contracts/errors';
import { roundPrice } from '@shared/lib/money';
import type { Logger } from '../../core/logger';
import { atomicWriteFile, readJsonFile } from '../../core/store';
import { normalizeChatSettings } from './settings';

export const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID_PATTERN.test(value);
}

export function assertThreadId(value: unknown, what = 'chat'): asserts value is string {
  if (!isThreadId(value)) throw new GmiError('invalid_input', `Invalid ${what} id.`);
}

/** What is stored on disk: the public thread plus bookkeeping the renderer does not need. */
export interface ThreadRecord extends ChatThread {
  /** True once the user named the thread; the title then never follows the first message. */
  titleCustom: boolean;
  /** Spend on replies that were regenerated away (still paid for, still part of the thread's cost). */
  discardedCostUsd: number;
}

export const DEFAULT_TITLE = 'New chat';
const FILE_VERSION = 1;

export function threadCost(record: Pick<ThreadRecord, 'messages' | 'discardedCostUsd'>): number {
  let total = record.discardedCostUsd;
  for (const m of record.messages) if (m.costUsd !== null && Number.isFinite(m.costUsd)) total += m.costUsd;
  return roundPrice(total);
}

export function summarize(record: ThreadRecord): ChatThreadSummary {
  return {
    id: record.id,
    title: record.title,
    mode: record.mode,
    model: record.model,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
    costUsd: threadCost(record),
  };
}

/** The public view (bookkeeping stripped, derived fields recomputed). */
export function toPublicThread(record: ThreadRecord): ChatThread {
  const { titleCustom: _custom, discardedCostUsd: _discarded, ...thread } = record;
  return { ...thread, messageCount: record.messages.length, costUsd: threadCost(record) };
}

// ---------------------------------------------------------------------------------------------
// Normalisation of files read from disk (never trust them blindly: a crash or a hand edit may
// have left anything there).

const STATUSES: readonly ChatMessageStatus[] = ['complete', 'streaming', 'error', 'stopped'];
const ERROR_CODES: readonly GmiErrorCode[] = [
  'not_signed_in',
  'reauth_required',
  'insufficient_scope',
  'no_api_key',
  'invalid_api_key',
  'unauthorized',
  'payment_required',
  'budget_exceeded',
  'confirmation_required',
  'rate_limited',
  'upstream',
  'network',
  'timeout',
  'cancelled',
  'not_found',
  'invalid_input',
  'not_implemented',
  'internal',
];

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function s(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function n(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function iso(value: unknown, fallback: string): string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function normalizeUsage(raw: unknown): TokenUsage | null {
  const u = rec(raw);
  if (!u) return null;
  const prompt = n(u.promptTokens);
  const completion = n(u.completionTokens);
  if (prompt === null || completion === null) return null;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: n(u.totalTokens) ?? prompt + completion,
    reasoningTokens: n(u.reasoningTokens),
    cachedTokens: n(u.cachedTokens),
  };
}

function normalizeRouting(raw: unknown): RoutingInfo | null {
  const r = rec(raw);
  const selected = r ? s(r.selectedModel) : null;
  if (!r || !selected) return null;
  return {
    selectedModel: selected,
    taskType: s(r.taskType),
    mode: s(r.mode),
    fallbackModels: Array.isArray(r.fallbackModels) ? r.fallbackModels.filter((m): m is string => typeof m === 'string') : [],
    recommendationId: s(r.recommendationId),
  };
}

function normalizeError(raw: unknown): GmiErrorShape | null {
  const e = rec(raw);
  if (!e) return null;
  const code = ERROR_CODES.includes(e.code as GmiErrorCode) ? (e.code as GmiErrorCode) : 'internal';
  return { code, message: s(e.message) ?? 'Something went wrong.', detail: s(e.detail), status: n(e.status), retryAfterSec: n(e.retryAfterSec) };
}

function normalizeMessage(raw: unknown, fallbackTime: string): ChatMessage | null {
  const m = rec(raw);
  if (!m) return null;
  const id = s(m.id);
  const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
  if (!id || !role) return null;
  let status: ChatMessageStatus = STATUSES.includes(m.status as ChatMessageStatus) ? (m.status as ChatMessageStatus) : 'complete';
  // A reply that was streaming when the app quit or crashed: keep what arrived.
  if (status === 'streaming') status = 'stopped';
  const createdAt = iso(m.createdAt, fallbackTime);
  const usage = normalizeUsage(m.usage);
  const message: ChatMessage = {
    id,
    role,
    content: s(m.content) ?? '',
    reasoning: s(m.reasoning) || null,
    model: s(m.model),
    routing: normalizeRouting(m.routing),
    usage,
    costUsd: n(m.costUsd),
    createdAt,
    status,
    error: status === 'error' ? (normalizeError(m.error) ?? { code: 'internal', message: 'The reply failed.' }) : null,
    finishReason: s(m.finishReason),
    completedAt: role === 'assistant' ? (typeof m.completedAt === 'string' ? iso(m.completedAt, createdAt) : status === 'stopped' ? createdAt : null) : null,
  };
  if (usage && m.usageEstimated === true) message.usageEstimated = true;
  // Absent on replies saved before it was recorded (the renderer then names no number).
  if (role === 'assistant') {
    const limit = n(m.maxTokens);
    if (m.maxTokens === null) message.maxTokens = null;
    else if (limit !== null && limit > 0) message.maxTokens = Math.round(limit);
  }
  return message;
}

export function defaultChatSettings(): ChatSettings {
  return {
    mode: 'auto',
    model: null,
    routerMode: DEFAULT_SETTINGS.defaultRouterMode,
    maxTokens: DEFAULT_SETTINGS.chatMaxTokens,
    temperature: null,
    reasoningEffort: null,
    systemPrompt: null,
  };
}

/** Validates a thread file. Returns null when it is not a usable thread. */
export function normalizeThreadRecord(raw: unknown, expectedId: string, now: string): ThreadRecord | null {
  const t = rec(raw);
  if (!t || t.id !== expectedId) return null;
  const createdAt = iso(t.createdAt, now);
  const settings = normalizeChatSettings(t.settings, defaultChatSettings());
  const messages = (Array.isArray(t.messages) ? t.messages : [])
    .map((m) => normalizeMessage(m, createdAt))
    .filter((m): m is ChatMessage => m !== null);
  const title = (s(t.title) ?? '').trim() || DEFAULT_TITLE;
  const record: ThreadRecord = {
    id: expectedId,
    title,
    mode: settings.mode,
    model: settings.mode === 'model' ? settings.model : null,
    createdAt,
    updatedAt: iso(t.updatedAt, createdAt),
    messageCount: messages.length,
    costUsd: 0,
    settings,
    messages,
    titleCustom: t.titleCustom === true,
    discardedCostUsd: Math.max(0, n(t.discardedCostUsd) ?? 0),
  };
  record.costUsd = threadCost(record);
  return record;
}

function normalizeSummary(raw: unknown): ChatThreadSummary | null {
  const r = rec(raw);
  if (!r || !isThreadId(r.id)) return null;
  const createdAt = iso(r.createdAt, new Date(0).toISOString());
  return {
    id: r.id,
    title: (s(r.title) ?? '').trim() || DEFAULT_TITLE,
    mode: r.mode === 'auto' ? 'auto' : 'model',
    model: s(r.model),
    createdAt,
    updatedAt: iso(r.updatedAt, createdAt),
    messageCount: Math.max(0, n(r.messageCount) ?? 0),
    costUsd: Math.max(0, n(r.costUsd) ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------

/** Coalescing, per-path serialised writer: only the latest content of a path is written. */
class FileWriter {
  private readonly pending = new Map<string, () => string | null>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly log: Logger) {}

  /** `produce` returns the file content, or null to delete the file. */
  schedule(path: string, produce: () => string | null): Promise<void> {
    this.pending.set(path, produce);
    const existing = this.running.get(path);
    if (existing) return existing;
    const run = (async () => {
      // Let synchronous callers finish mutating before the first snapshot is taken.
      await Promise.resolve();
      for (;;) {
        const next = this.pending.get(path);
        if (!next) {
          // Checked and cleared in the same tick, so a later schedule() always starts a new loop.
          this.running.delete(path);
          return;
        }
        this.pending.delete(path);
        try {
          const text = next();
          if (text === null) await rm(path, { force: true });
          else await atomicWriteFile(path, text);
        } catch (error) {
          this.log.error(`failed to write ${path}`, error);
        }
      }
    })();
    this.running.set(path, run);
    return run;
  }

  async flush(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }
}

export class ThreadStore {
  readonly dir: string;
  readonly threadsDir: string;
  readonly indexPath: string;
  /** False on first run (no index file yet). */
  indexExisted = false;

  private readonly records = new Map<string, ThreadRecord>();
  private readonly summaries = new Map<string, ChatThreadSummary>();
  private readonly loading = new Map<string, Promise<ThreadRecord>>();
  private readonly writer: FileWriter;

  constructor(
    dir: string,
    private readonly log: Logger,
    private readonly now: () => Date,
  ) {
    this.dir = dir;
    this.threadsDir = join(dir, 'threads');
    this.indexPath = join(dir, 'index.json');
    this.writer = new FileWriter(log);
  }

  threadPath(id: string): string {
    assertThreadId(id);
    return join(this.threadsDir, `${id}.json`);
  }

  /** Loads the index and reconciles it with the thread files (rebuilds it when missing or corrupt). */
  async init(): Promise<void> {
    await mkdir(this.threadsDir, { recursive: true });
    let changed = false;
    try {
      const raw = await readJsonFile<unknown>(this.indexPath);
      this.indexExisted = raw !== null;
      const list = rec(raw)?.threads;
      if (Array.isArray(list)) {
        for (const item of list) {
          const summary = normalizeSummary(item);
          if (summary) this.summaries.set(summary.id, summary);
        }
      } else if (raw !== null) changed = true;
    } catch (error) {
      this.indexExisted = true;
      const aside = `${this.indexPath}.corrupt-${Date.now()}`;
      this.log.warn(`chat index was unreadable; rebuilding (old copy at ${aside})`, error);
      await rename(this.indexPath, aside).catch(() => undefined);
      changed = true;
    }

    const files = new Set(
      (await readdir(this.threadsDir).catch(() => [] as string[]))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .filter(isThreadId),
    );
    for (const id of [...this.summaries.keys()]) {
      if (!files.has(id)) {
        this.summaries.delete(id);
        changed = true;
      }
    }
    for (const id of files) {
      if (this.summaries.has(id)) continue;
      const record = await this.load(id).catch(() => null);
      if (record) {
        this.summaries.set(id, summarize(record));
        changed = true;
      }
    }
    if (changed) await this.writeIndex();
  }

  /** Summaries, most recently updated first. */
  list(): ChatThreadSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  }

  has(id: string): boolean {
    return this.summaries.has(id);
  }

  /** The cached record, if loaded. */
  peek(id: string): ThreadRecord | undefined {
    return this.records.get(id);
  }

  async get(id: string): Promise<ThreadRecord> {
    assertThreadId(id);
    const cached = this.records.get(id);
    if (cached) return cached;
    if (!this.summaries.has(id)) throw new GmiError('not_found', 'That chat no longer exists.');
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.load(id).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (error instanceof GmiError && error.code === 'not_found' && this.summaries.delete(id)) void this.writeIndex();
      throw error;
    }
  }

  /** Creates or saves a thread. `index: false` skips the index rewrite (periodic saves while streaming). */
  put(record: ThreadRecord, opts: { index?: boolean } = {}): Promise<void> {
    assertThreadId(record.id);
    this.records.set(record.id, record);
    const writes = [this.writer.schedule(this.threadPath(record.id), () => this.serialize(record.id))];
    if (opts.index !== false) {
      this.summaries.set(record.id, summarize(record));
      writes.push(this.writeIndex());
    }
    return Promise.all(writes).then(() => undefined);
  }

  /** Saves only if the thread still exists (a stream finishing after its thread was deleted must not resurrect it). */
  putIfExists(record: ThreadRecord, opts: { index?: boolean } = {}): Promise<void> {
    if (!this.summaries.has(record.id)) return Promise.resolve();
    return this.put(record, opts);
  }

  async remove(id: string): Promise<void> {
    assertThreadId(id);
    const existed = this.summaries.delete(id);
    this.records.delete(id);
    if (!existed) throw new GmiError('not_found', 'That chat no longer exists.');
    await Promise.all([this.writer.schedule(this.threadPath(id), () => null), this.writeIndex()]);
  }

  /** Synchronous save for app shutdown (the quit sequence does not wait for promises). */
  writeSync(record: ThreadRecord): void {
    if (!this.summaries.has(record.id)) return;
    const text = this.serialize(record.id);
    if (text === null) return;
    const path = this.threadPath(record.id);
    const tmp = `${path}.tmp-${process.pid}-sync`;
    try {
      mkdirSync(this.threadsDir, { recursive: true });
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    } catch (error) {
      this.log.error(`failed to write ${path} on shutdown`, error);
    }
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  private serialize(id: string): string | null {
    const record = this.records.get(id);
    if (!record || !this.summaries.has(id)) return null;
    record.messageCount = record.messages.length;
    record.costUsd = threadCost(record);
    return JSON.stringify({ version: FILE_VERSION, ...record }, null, 2);
  }

  private writeIndex(): Promise<void> {
    return this.writer.schedule(this.indexPath, () => JSON.stringify({ version: FILE_VERSION, threads: this.list() }, null, 2));
  }

  private async load(id: string): Promise<ThreadRecord> {
    const path = this.threadPath(id);
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(path);
    } catch (error) {
      const aside = `${path}.corrupt-${Date.now()}`;
      this.log.warn(`chat ${id} was unreadable; moved to ${aside}`, error);
      await rename(path, aside).catch(() => undefined);
      throw new GmiError('not_found', 'That chat could not be read.');
    }
    if (raw === null) throw new GmiError('not_found', 'That chat no longer exists.');
    const record = normalizeThreadRecord(raw, id, this.now().toISOString());
    if (!record) throw new GmiError('not_found', 'That chat could not be read.');
    // Another load may have raced us; keep the first record so in-flight streams see one object.
    const existing = this.records.get(id);
    if (existing) return existing;
    this.records.set(id, record);
    return record;
  }
}
