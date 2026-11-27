/**
 * Context compaction (harness.md §7.3 range-ledger hook, §7.4 layer 1, §7.5 layer 2; H2-C).
 *
 * Storage model (invariant 3: history is append-only, content is never edited):
 * - A compaction stores its summary in `compactions` (`upto_ord` = the anchor) and marks every message with
 *   `ord <= upto_ord` out of context.
 * - The current turn's request (its first user message and its steering messages) is re-inserted after the summary
 *   as new `pinned = 1` rows, byte-identical (capped at 8k tokens), when the anchor summarised it.
 * - What the model sees after `[system][tools][user#0]` is `compactedContext()`: the `[summary]` message of the
 *   latest compaction, then the pinned rows, then the remaining history, each in `ord` order. Every row with
 *   `ord <= upto_ord` of the latest compaction is out of the view, pinned or not, so the view is the same whether or
 *   not the store's `markOutOfContext` skips pinned rows. The loop's context builder (H2-B) must use this order.
 */
import { CODE_DEFAULTS } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayRequest, GwMessage, GwToolDef } from '@shared/contracts/gateway';
import {
  contextIdOf,
  newId,
  turnIdOf,
  type Ceiling,
  type CeilingInput,
  type CompactionRequest,
  type CompactionResult,
  type CompactionRow,
  type CompactionTrigger,
  type Compactor,
  type CompactorDeps,
  type MessageRow,
  type Store,
  type StoredEvent,
  type TriggerInput,
} from '@harness/types';
import {
  cleanSummary,
  composeSummary,
  fallbackSummary,
  renderFileLedger,
  renderTranscript,
  stripFileLedger,
  SUMMARY_SYSTEM,
  summaryInstruction,
  summaryMessage,
  transcriptRequestText,
  type FileLedger,
} from './summary-prompt';

// ─── Numbers (§7.4, §7.5) ─────────────────────────────────────────────────────────────────────────────────────

export const COMPACTION_LIMITS = {
  /** An unknown context window is treated as 128k. */
  unknownContextTokens: 128_000,
  reserveFraction: 0.15,
  reserveMinTokens: 16_384,
  /** Economy: stay below 95 % of the next price tier. */
  economyTierFraction: 0.95,
  /** Economy is enabled only when C ≥ prefix + keep + this (the summary's room). */
  economyMarginTokens: 8_192,
  keepMaxTokens: 20_000,
  keepFraction: 0.25,
  /** Summary output cap: 8k by default, 16k at most; below 1k nothing useful fits. */
  summaryTokens: 8_192,
  summaryMaxTokens: 16_384,
  summaryMinTokens: 1_024,
  /** Precompute at 85 % of a trigger, and for the token trigger only from 32k on. */
  precomputeFraction: 0.85,
  precomputeMinTokens: 32_000,
  /** Swap a precomputed summary in only if the tail since its anchor is ≤ max(2·keep, 30k) and ≤ 25 % of C. */
  swapTailMinTokens: 30_000,
  swapTailFraction: 0.25,
  /** Hysteresis: after a layer-1 compaction the context is ≤ 50 % of C. */
  targetFraction: 0.5,
  /** The pinned current-turn block is capped at 8k tokens. */
  pinnedMaxTokens: 8_192,
  /** After a compaction at most this many messages stay (half the message trigger, far from main's 2,048). */
  keptMessagesMax: Math.floor(CODE_DEFAULTS.compactMessageCount / 2),
  /** "Drop old tool outputs" (§7.5): characters of each tool result kept in the summariser's transcript. */
  droppedToolOutputChars: 400,
  /** Role markers and separators per message (same as chat's estimate). */
  messageOverheadTokens: 4,
  /** User requests quoted by the no-model fallback summary. */
  fallbackRequestChars: 2_000,
} as const;

/** Layer 2 (§7.5): shrink to 85 %, 70 %, 50 % and 35 % of the rejected size, one retry per level. */
export const OVERFLOW_LEVELS = [0.85, 0.7, 0.5, 0.35] as const;

/** The `shrinkToTokens` of each layer-2 retry for a request of `rejectedTokens` (main's size refusals included). */
export function overflowTargets(rejectedTokens: number): number[] {
  const size = Math.max(0, Math.floor(rejectedTokens));
  return OVERFLOW_LEVELS.map((f) => Math.floor(size * f));
}

// ─── Token estimates (§7.2) ───────────────────────────────────────────────────────────────────────────────────

/** 4 ASCII characters ≈ 1 token, any other character 1 (the existing chat estimator, on the high side). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (code < 0xdc00 || code > 0xdfff) other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** A stored message's size: its `est_tokens`, or an estimate of its content and tool calls. */
export function messageTokens(row: Pick<MessageRow, 'content' | 'toolCalls' | 'estTokens'>): number {
  if (row.estTokens !== null && row.estTokens !== undefined && row.estTokens >= 0) return row.estTokens;
  let n = estimateTokens(row.content) + COMPACTION_LIMITS.messageOverheadTokens;
  for (const call of row.toolCalls ?? []) n += estimateTokens(call.name) + estimateTokens(call.arguments) + COMPACTION_LIMITS.messageOverheadTokens;
  return n;
}

/** The longest prefix of `text` whose estimate is ≤ `tokens`. */
function truncateToTokens(text: string, tokens: number): string {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (code < 0xdc00 || code > 0xdfff) other++;
    if (Math.ceil(ascii / 4) + other > tokens) {
      // Never split a surrogate pair.
      const end = code >= 0xdc00 && code <= 0xdfff ? i - 1 : i;
      return text.slice(0, Math.max(0, end));
    }
  }
  return text;
}

// ─── Ceiling and triggers (§7.4) ──────────────────────────────────────────────────────────────────────────────

export function computeCeiling(input: CeilingInput): Ceiling {
  const L = COMPACTION_LIMITS;
  const model = input.modelContextTokens && input.modelContextTokens > 0 ? input.modelContextTokens : L.unknownContextTokens;
  const windowTokens = Math.max(0, Math.floor(Math.min(model, input.maxContextTokens ?? Number.POSITIVE_INFINITY)));
  const reserveTokens = Math.max(Math.floor(L.reserveFraction * windowTokens), L.reserveMinTokens) + Math.max(0, input.maxOutputTokens);
  const base = Math.max(0, windowTokens - reserveTokens);
  const keepOf = (c: number) => Math.min(L.keepMaxTokens, Math.floor(L.keepFraction * c));
  let ceilingTokens = base;
  let economy: Ceiling['economy'] = 'off';
  const tier = input.tierBoundaryTokens;
  if (input.economy && tier !== null && tier > 0) {
    const econ = Math.min(base, Math.floor(L.economyTierFraction * tier));
    if (econ >= input.prefixTokens + keepOf(econ) + L.economyMarginTokens) {
      ceilingTokens = econ;
      economy = 'on';
    } else {
      economy = 'disabled';
    }
  }
  return { windowTokens, reserveTokens, ceilingTokens, keepTokens: keepOf(ceilingTokens), economy, tierBoundaryTokens: tier };
}

function costLimit(input: TriggerInput): number | null {
  if (input.nextStepCachedUsd === null || input.perTurnUsd === null || !(input.perTurnUsd > 0)) return null;
  return input.perTurnUsd / CODE_DEFAULTS.compactCostDivisor;
}

export function compactionTrigger(input: TriggerInput): CompactionTrigger | null {
  if (input.sizeTokens >= input.ceiling.ceilingTokens) return 'tokens';
  if (input.messageCount > CODE_DEFAULTS.compactMessageCount) return 'messages';
  const limit = costLimit(input);
  if (limit !== null && (input.nextStepCachedUsd as number) > limit) return 'cost';
  return null;
}

export function shouldPrecompute(input: TriggerInput): boolean {
  const f = COMPACTION_LIMITS.precomputeFraction;
  if (input.sizeTokens >= f * input.ceiling.ceilingTokens && input.sizeTokens >= COMPACTION_LIMITS.precomputeMinTokens) return true;
  if (input.messageCount > f * CODE_DEFAULTS.compactMessageCount) return true;
  const limit = costLimit(input);
  return limit !== null && (input.nextStepCachedUsd as number) > f * limit;
}

// ─── The compacted context (what the model sees after the prefix) ────────────────────────────────────────────

/** The compaction in effect for a context: the one with the highest anchor. */
export function latestCompaction(store: Store, contextId: string): CompactionRow | null {
  let latest: CompactionRow | null = null;
  for (const row of store.compactions.list(contextId)) if (!latest || row.uptoOrd >= latest.uptoOrd) latest = row;
  return latest;
}

export interface CompactedContext {
  compaction: CompactionRow | null;
  /** The `[summary]` message (§7.1), or null before the first compaction. */
  summary: GwMessage | null;
  /** Pinned rows (the current request re-inserted after the summary), then the history, each in `ord` order. */
  rows: MessageRow[];
  pinned: MessageRow[];
  history: MessageRow[];
}

/** The history the model sees for `contextId`, after `[system][tools][user#0]` (§7.1). Partial rows are left out. */
export function compactedContext(store: Store, contextId: string): CompactedContext {
  const compaction = latestCompaction(store, contextId);
  const upto = compaction?.uptoOrd ?? 0;
  const visible = store.messages.list(contextId, { inContextOnly: true, afterOrd: upto }).filter((m) => !m.partial && m.ord > upto);
  const pinned = visible.filter((m) => m.pinned);
  const history = visible.filter((m) => !m.pinned);
  return { compaction, summary: compaction ? summaryMessage(compaction.summary) : null, rows: [...pinned, ...history], pinned, history };
}

/** A stored message as the gateway sees it (reasoning is not replayed here; the loop applies its replay rule). */
export function defaultToWire(rows: readonly MessageRow[]): GwMessage[] {
  return rows.map((m): GwMessage => {
    const msg: GwMessage = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) msg.toolCalls = m.toolCalls.map((c) => ({ ...c }));
    if (m.toolCallId) msg.toolCallId = m.toolCallId;
    return msg;
  });
}

// ─── File ledger (§7.4: read and modified paths from tool events, appended by code) ───────────────────────────

const READ_TOOLS = new Set(['read']);
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch']);

function argPaths(tool: string, rawArgs: string): string[] {
  let args: unknown;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return [];
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return [];
  const a = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['path', 'file_path', 'filePath']) if (typeof a[key] === 'string' && a[key]) out.push(a[key] as string);
  if (tool === 'apply_patch') {
    const patch = [a.patch, a.input, a.diff].find((v): v is string => typeof v === 'string') ?? '';
    for (const line of patch.split('\n')) {
      const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line) ?? /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
      if (m && m[1] && m[1].trim() !== '/dev/null') out.push(m[1].trim());
    }
  }
  return out;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
}

/**
 * Paths this context read and modified, most recent first: the `effects` of `tool.finished` events when the loop
 * records them, and the arguments of every succeeded read/write/edit/apply_patch call. A path both read and
 * modified is listed as modified. Spill reads are left out.
 */
export function fileLedger(store: Store, threadId: string, contextId: string): FileLedger {
  const read: string[] = [];
  const modified: string[] = [];
  const add = (list: string[], paths: readonly string[]) => {
    for (const p of paths) if (!p.startsWith('spill:')) list.push(p);
  };
  for (const ev of store.events.list(threadId, { types: ['tool.finished'] })) {
    if (ev.contextId !== contextId) continue;
    const effects = (ev.payload as { effects?: { readPaths?: unknown; changedPaths?: unknown } } | null)?.effects;
    if (!effects) continue;
    add(read, stringList(effects.readPaths));
    add(modified, stringList(effects.changedPaths));
  }
  for (const m of store.messages.list(contextId)) {
    if (m.role !== 'assistant' || !m.toolCalls || m.pinned) continue;
    for (const call of m.toolCalls) {
      const isRead = READ_TOOLS.has(call.name);
      if (!isRead && !WRITE_TOOLS.has(call.name)) continue;
      const tc = store.toolCalls.byWireId(contextId, call.id);
      if (!tc || tc.status !== 'succeeded') continue;
      add(isRead ? read : modified, argPaths(call.name, tc.args || call.arguments));
    }
  }
  const recentFirst = (list: string[]) => [...new Set([...list].reverse())];
  const mod = recentFirst(modified);
  const modSet = new Set(mod);
  return { modified: mod, read: recentFirst(read).filter((p) => !modSet.has(p)) };
}

// ─── Options the loop provides ────────────────────────────────────────────────────────────────────────────────

export interface CompactionPrefix {
  /** `[system]` and `[user#0]` exactly as the thread sends them. */
  messages: GwMessage[];
  /** The tools frozen for this turn (sent with `toolChoice: 'none'` so the prefix stays cached). */
  tools: GwToolDef[];
  prefixHash: string | null;
  /** The loop's own serialisation of history rows (reasoning replay rule), for byte-identical requests. */
  toWire?(rows: readonly MessageRow[]): GwMessage[];
}

export interface CompactionContextInfo {
  /** The ceiling the loop computed for this context (`Compactor.ceiling`). */
  ceiling: Ceiling;
  /** Estimated tokens of `[system]+[tools]+[user#0]`. */
  prefixTokens: number;
  /** Calibration factor `k` (§7.2), applied to message estimates; default 1. */
  k?: number;
  /** For summaries on the thread's own model: the thread's exact prefix (cache hit). */
  prefix?: CompactionPrefix | null;
}

export interface CompactorOptions {
  /** What the loop knows about the context. Without it: the thread's settings, an unknown window (128k), no prefix. */
  contextInfo?(req: { threadId: string; contextId: string; model: string; turn: number }): CompactionContextInfo | null;
  /** Called with each public durable event the compactor stores (the timeline's compaction item), for main. */
  onEvent?(event: StoredEvent): void;
  /** Summary output cap (default 8,192; at most 16,384). */
  summaryTokens?: number;
  /**
   * Called as soon as a summary request reports what it cost (precompute or compaction, kept or dropped, success or
   * failure), so the thread's cost counts every charge (review H2). Without it the cost is only in the result.
   */
  onCost?(threadId: string, contextId: string, usd: number): void;
}

// ─── Compactor ────────────────────────────────────────────────────────────────────────────────────────────────

interface Cut {
  uptoOrd: number;
  keptTokens: number;
  keptCount: number;
  /** Rows of the current turn's request that need a pinned copy at this cut. */
  pinSources: MessageRow[];
  pinTokens: number;
}

interface Precomputed {
  controller: AbortController;
  done: boolean;
  promise: Promise<void>;
  baseCompactionId: string | null;
  compactionModel: string;
  turn: number;
  uptoOrd: number;
  /** The summary was told that the request of `turn` is pinned. */
  requestPinned: boolean;
  summary: string | null;
  model: string;
  costUsd: number | null;
}

interface SummaryOutcome {
  summary: string;
  model: string;
  /** False: built from the log after two failed requests. */
  byModel: boolean;
}

const MONEY_STOPS = new Set(['budget_exceeded', 'limit_reached', 'payment_required']);

function cancelled(): GmiError {
  return new GmiError('cancelled', 'Cancelled.');
}

function asGmiError(e: unknown): GmiError {
  if (e instanceof GmiError) return e;
  return new GmiError('internal', e instanceof Error ? e.message : 'Summary request failed.');
}

/** The current turn's request: its first user message and its steering messages (originals, never copies). */
function turnRequestRows(all: readonly MessageRow[], turn: number): MessageRow[] {
  const users = all.filter((m) => m.role === 'user' && m.turn === turn && !m.pinned && !m.partial);
  const first = users[0];
  if (!first) return [];
  return users.filter((m) => m === first || m.steering === true);
}

/** Byte-identical copies, capped at 8k tokens in total (each row gets its share), with a pointer when cut. */
function pinCopies(sources: readonly MessageRow[], k: number): Array<{ source: MessageRow; content: string; tokens: number }> {
  const cap = COMPACTION_LIMITS.pinnedMaxTokens;
  const sizes = sources.map((s) => estimateTokens(s.content));
  const total = sizes.reduce((a, b) => a + b, 0);
  return sources.map((source, i) => {
    let content = source.content;
    if (total > cap) {
      const share = Math.max(64, Math.floor((cap * (sizes[i] as number)) / total));
      if ((sizes[i] as number) > share) {
        const note = `\n\n[Message truncated to about ${share} tokens here; the full text is message ${source.id} in this thread's log.]`;
        content = truncateToTokens(source.content, Math.max(0, share - estimateTokens(note))) + note;
      }
    }
    return { source, content, tokens: Math.ceil(messageTokens({ content, toolCalls: null, estTokens: null }) * k) };
  });
}

export function createCompactor(deps: CompactorDeps, opts: CompactorOptions = {}): Compactor & { idle(): Promise<void> } {
  const { store, gateway, clock } = deps;
  const log = deps.log.child('compaction');
  const L = COMPACTION_LIMITS;
  const summaryTokens = Math.max(L.summaryMinTokens, Math.min(L.summaryMaxTokens, Math.floor(opts.summaryTokens ?? L.summaryTokens)));
  const precomputed = new Map<string, Precomputed>();
  const busy = new Set<string>();
  const iso = () => new Date(clock.now()).toISOString();

  function contextInfo(req: { threadId: string; contextId: string; model: string; turn: number }): Required<Omit<CompactionContextInfo, 'prefix'>> & { prefix: CompactionPrefix | null } {
    const info = opts.contextInfo?.(req) ?? null;
    if (info) return { ceiling: info.ceiling, prefixTokens: Math.max(0, info.prefixTokens), k: info.k && info.k > 0 ? info.k : 1, prefix: info.prefix ?? null };
    const settings = store.threads.get(req.threadId)?.settings;
    const ceiling = computeCeiling({
      modelContextTokens: null,
      maxContextTokens: settings ? settings.maxContextTokens : CODE_DEFAULTS.maxContextTokens,
      maxOutputTokens: settings?.maxOutputTokens ?? CODE_DEFAULTS.maxOutputTokens,
      economy: false,
      tierBoundaryTokens: null,
      prefixTokens: 0,
    });
    return { ceiling, prefixTokens: 0, k: 1, prefix: null };
  }

  /** Every valid anchor after the current one, in increasing `ord`: user/assistant boundaries with no call cut off. */
  function cuts(view: CompactedContext, all: readonly MessageRow[], turn: number, k: number): Cut[] {
    const size = (m: MessageRow) => Math.ceil(messageTokens(m) * k);
    const hist = view.history;
    const suffixTokens: number[] = new Array<number>(hist.length + 1).fill(0);
    for (let i = hist.length - 1; i >= 0; i--) suffixTokens[i] = (suffixTokens[i + 1] as number) + size(hist[i] as MessageRow);
    const request = turnRequestRows(all, turn);
    // Sources at a cut are a prefix of `request` (sorted by ord): memoise their size by length.
    const pinTokensOf = new Map<number, number>();
    const pinSize = (sources: MessageRow[]) => {
      let n = pinTokensOf.get(sources.length);
      if (n === undefined) {
        n = pinCopies(sources, k).reduce((a, p) => a + p.tokens, 0);
        pinTokensOf.set(sources.length, n);
      }
      return n;
    };
    const out: Cut[] = [];
    const open = new Set<string>();
    for (let i = 0; i < hist.length; i++) {
      const row = hist[i] as MessageRow;
      if (row.role === 'assistant') for (const c of row.toolCalls ?? []) open.add(c.id);
      if (row.role === 'tool' && row.toolCallId) open.delete(row.toolCallId);
      const next = hist[i + 1];
      if (open.size > 0) continue;
      if (next && next.role !== 'user' && next.role !== 'assistant') continue;
      const u = row.ord;
      const keptPinned = view.pinned.filter((p) => p.ord > u);
      const blockSurvives = keptPinned.some((p) => p.turn === turn);
      const pinSources = blockSurvives ? [] : request.filter((r) => r.ord <= u);
      const pinTokens = pinSize(pinSources);
      out.push({
        uptoOrd: u,
        keptTokens: (suffixTokens[i + 1] as number) + keptPinned.reduce((a, p) => a + size(p), 0) + pinTokens,
        keptCount: hist.length - i - 1 + keptPinned.length + pinSources.length,
        pinSources,
        pinTokens,
      });
    }
    return out;
  }

  /** The last boundary that leaves at least `keep` tokens after it (pinned block included), within the message cap. */
  function chooseCut(all: Cut[], keep: number): Cut {
    const counted = all.filter((c) => c.keptCount <= L.keptMessagesMax);
    if (counted.length === 0) return all[all.length - 1] as Cut;
    let best: Cut | null = null;
    for (const c of counted) if (c.keptTokens >= keep) best = c;
    return best ?? (counted[0] as Cut);
  }

  /** The tail since a precomputed anchor is ≤ max(2·keep, 30k) and ≤ 25 % of C (§7.4). */
  function swapTailOk(cut: Cut, ceiling: Ceiling): boolean {
    return cut.keptTokens <= Math.max(2 * ceiling.keepTokens, L.swapTailMinTokens) && cut.keptTokens <= L.swapTailFraction * ceiling.ceilingTokens;
  }

  function regionRows(view: CompactedContext, uptoOrd: number): MessageRow[] {
    return view.history.filter((m) => m.ord <= uptoOrd);
  }

  /** Streams one summary request; adds what it cost to `spent` even when it fails. */
  async function requestSummary(request: GatewayRequest, signal: AbortSignal, spent: { usd: number | null }): Promise<{ text: string; model: string }> {
    let text = '';
    let model = (request.target as { model: string }).model;
    for await (const ev of gateway.stream(request, signal) as AsyncIterable<GatewayEvent>) {
      if (ev.type === 'text') text += ev.text;
      else if (ev.type === 'model') model = ev.model;
      else if (ev.type === 'usage' && ev.costUsd !== null) {
        spent.usd = (spent.usd ?? 0) + ev.costUsd;
        if (ev.costUsd > 0 && request.scope.threadId) {
          try {
            opts.onCost?.(request.scope.threadId, contextOf.get(request.requestId) ?? '', ev.costUsd);
          } catch (e) {
            log.warn('compaction cost listener failed', { code: asGmiError(e).code });
          }
        }
      }
      else if (ev.type === 'error') throw GmiError.fromShape(ev.error);
    }
    if (signal.aborted) throw cancelled();
    const cleaned = cleanSummary(text);
    if (!cleaned) throw new GmiError('upstream', 'The summary was empty.');
    return { text: cleaned, model };
  }

  interface SummaryJob {
    threadId: string;
    contextId: string;
    runId: string;
    turn: number;
    model: string;
    compactionModel: string;
    view: CompactedContext;
    uptoOrd: number;
    requestPinned: boolean;
    pinnedIds: ReadonlySet<string>;
    info: ReturnType<typeof contextInfo>;
    maxOutputTokens: number;
    priority: 'foreground' | 'idle';
    /** Layer 2: never reuse the thread's prefix (that context just overflowed). */
    allowPrefix: boolean;
  }

  /** requestId → contextId of the summary requests in flight (onCost). */
  const contextOf = new Map<string, string>();

  function buildRequest(job: SummaryJob, mode: { usePrefix: boolean; dropToolOutputs: boolean }): GatewayRequest {
    const { dropToolOutputs } = mode;
    const previous = job.view.compaction ? stripFileLedger(job.view.compaction.summary) : null;
    const region = regionRows(job.view, job.uptoOrd);
    const prefix = job.info.prefix;
    const sameModel = mode.usePrefix && job.allowPrefix && !dropToolOutputs && prefix !== null && job.compactionModel === job.model;
    let messages: GwMessage[];
    let tools: GwToolDef[] | undefined;
    if (sameModel && prefix) {
      // The thread's exact bytes up to the anchor, then the instruction: everything before it is a cache hit.
      const toWire = prefix.toWire ?? defaultToWire;
      messages = [
        ...prefix.messages,
        ...(job.view.summary ? [job.view.summary] : []),
        ...toWire([...job.view.pinned, ...region]),
        { role: 'user', content: summaryInstruction({ previousSummary: previous, currentRequestPinned: job.requestPinned, conversationAbove: true }) },
      ];
      tools = prefix.tools.length > 0 ? prefix.tools : undefined;
    } else {
      const transcript = renderTranscript([...job.view.pinned, ...region], {
        toolOutputChars: dropToolOutputs ? L.droppedToolOutputChars : null,
        pinnedIds: job.pinnedIds,
      });
      const instruction = summaryInstruction({ previousSummary: previous, currentRequestPinned: job.requestPinned, conversationAbove: false });
      messages = [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: transcriptRequestText({ instruction, previousSummary: previous, transcript }) },
      ];
    }
    const requestId = newId('req', clock.now());
    contextOf.set(requestId, job.contextId);
    while (contextOf.size > 256) contextOf.delete(contextOf.keys().next().value as string);
    return {
      requestId,
      purpose: 'compaction',
      priority: job.priority,
      scope: { threadId: job.threadId, turnId: turnIdOf(job.threadId, job.turn), runId: job.runId, step: null },
      target: { model: job.compactionModel },
      messages,
      ...(tools ? { tools, toolChoice: 'none' as const } : {}),
      maxOutputTokens: job.maxOutputTokens,
      prefixHash: sameModel && prefix ? prefix.prefixHash : null,
    };
  }

  /**
   * Two attempts (the second drops tool outputs from the transcript after an overflow, or in layer 2), then a summary
   * built from the log (§7.4 failure path). Cancellation and money stops are rethrown.
   */
  async function summarise(job: SummaryJob, signal: AbortSignal, spent: { usd: number | null }, layer: 1 | 2): Promise<SummaryOutcome> {
    let lastCode: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (signal.aborted) throw cancelled();
      // The second attempt never reuses the prefix (no tools to call by mistake) and drops tool outputs after an
      // overflow or in layer 2 (§7.5 step 2).
      const drop = attempt === 2 && (layer === 2 || lastCode === 'context_overflow');
      try {
        const r = await requestSummary(buildRequest(job, { usePrefix: attempt === 1, dropToolOutputs: drop }), signal, spent);
        return { summary: r.text, model: r.model, byModel: true };
      } catch (e) {
        const err = asGmiError(e);
        if (signal.aborted || err.code === 'cancelled') throw cancelled();
        if (MONEY_STOPS.has(err.code)) throw err;
        lastCode = err.code;
        log.warn('compaction summary failed', { threadId: job.threadId, contextId: job.contextId, attempt, code: err.code });
      }
    }
    const previous = job.view.compaction ? stripFileLedger(job.view.compaction.summary) : null;
    const requests = regionRows(job.view, job.uptoOrd)
      .filter((m) => m.role === 'user')
      .map((m) => m.content);
    const text = fallbackSummary({ previousSummary: previous, userRequests: requests, maxRequestChars: L.fallbackRequestChars });
    return { summary: truncateToTokens(text, job.maxOutputTokens), model: job.compactionModel, byModel: false };
  }

  function pruneReads(contextId: string, uptoOrd: number): void {
    for (const row of store.reads.list(contextId)) {
      // `ord` is the oldest result whose lines are in `ranges`: at or before the anchor, some of them left the context.
      if (row.ord === null || row.ord <= uptoOrd) store.reads.delete(contextId, row.path);
    }
  }

  function dropPrecomputed(contextId: string): void {
    const p = precomputed.get(contextId);
    if (!p) return;
    precomputed.delete(contextId);
    if (!p.done) p.controller.abort();
  }

  const compactor: Compactor & { idle(): Promise<void> } = {
    ceiling: computeCeiling,
    trigger: compactionTrigger,
    shouldPrecompute,

    precompute(req) {
      const { contextId } = req;
      if (busy.has(contextId)) return;
      const existing = precomputed.get(contextId);
      if (existing && !existing.done) return;
      const info = contextInfo(req);
      const view = compactedContext(store, contextId);
      const all = store.messages.list(contextId);
      const candidates = cuts(view, all, req.turn, info.k);
      if (candidates.length === 0) return;
      const room = Math.floor(L.targetFraction * info.ceiling.ceilingTokens) - info.prefixTokens - summaryTokens;
      const cut = chooseCut(candidates, Math.min(info.ceiling.keepTokens, Math.max(0, room)));
      if (existing?.done && existing.baseCompactionId === (view.compaction?.id ?? null) && existing.compactionModel === req.compactionModel) {
        // Still swappable: keep it rather than paying for a new one every step.
        const at = candidates.find((c) => c.uptoOrd === existing.uptoOrd);
        if (at && swapTailOk(at, info.ceiling)) return;
      }
      dropPrecomputed(contextId);
      const controller = new AbortController();
      const requestPinned = cut.pinSources.length > 0 || view.pinned.some((p) => p.turn === req.turn);
      const entry: Precomputed = {
        controller,
        done: false,
        promise: Promise.resolve(),
        baseCompactionId: view.compaction?.id ?? null,
        compactionModel: req.compactionModel,
        turn: req.turn,
        uptoOrd: cut.uptoOrd,
        requestPinned,
        summary: null,
        model: req.compactionModel,
        costUsd: null,
      };
      const job: SummaryJob = {
        ...req,
        view,
        uptoOrd: cut.uptoOrd,
        requestPinned,
        pinnedIds: new Set(view.pinned.filter((p) => p.turn === req.turn).map((p) => p.id)),
        info,
        maxOutputTokens: summaryTokens,
        priority: 'idle',
        allowPrefix: true,
      };
      const spent = { usd: null as number | null };
      entry.promise = (async () => {
        try {
          const r = await requestSummary(buildRequest(job, { usePrefix: true, dropToolOutputs: false }), controller.signal, spent);
          entry.summary = r.text;
          entry.model = r.model;
          entry.costUsd = spent.usd;
          entry.done = true;
          log.debug('compaction precomputed', { threadId: req.threadId, contextId, uptoOrd: cut.uptoOrd });
        } catch (e) {
          if (precomputed.get(contextId) === entry) precomputed.delete(contextId);
          if (!controller.signal.aborted) log.debug('compaction precompute failed', { threadId: req.threadId, contextId, code: asGmiError(e).code });
        }
      })();
      precomputed.set(contextId, entry);
    },

    async compact(req) {
      const { threadId, contextId } = req;
      if (req.signal.aborted) throw cancelled();
      if (busy.has(contextId)) throw new GmiError('conflict', 'A compaction is already running for this context.');
      busy.add(contextId);
      try {
        const startedAt = clock.now();
        const layer: 1 | 2 = req.reason === 'overflow' ? 2 : 1;
        const info = contextInfo(req);
        const k = info.k;
        const C = info.ceiling.ceilingTokens;
        const view = compactedContext(store, contextId);
        const all = store.messages.list(contextId);
        const ledger = fileLedger(store, threadId, contextId);
        const ledgerTokens = Math.ceil(estimateTokens(renderFileLedger(ledger)) * k);
        const sized = (m: MessageRow) => Math.ceil(messageTokens(m) * k);
        const summaryMsgTokens = (s: string) => Math.ceil(estimateTokens(String(summaryMessage(s).content)) * k) + L.messageOverheadTokens;
        const beforeTokens = info.prefixTokens + (view.compaction ? summaryMsgTokens(view.compaction.summary) : 0) + view.rows.reduce((a, m) => a + sized(m), 0);

        const candidates = cuts(view, all, req.turn, k);
        if (candidates.length === 0) throw new GmiError('context_overflow', 'Nothing in this context can be compacted.');
        const target = layer === 2 ? Math.max(0, Math.floor(req.shrinkToTokens ?? L.targetFraction * C)) : Math.floor(L.targetFraction * C);
        const room = target - info.prefixTokens - ledgerTokens - L.messageOverheadTokens * 2;
        const minKept = (candidates[candidates.length - 1] as Cut).keptTokens;

        let maxOutputTokens = summaryTokens;
        let cut: Cut;
        if (layer === 1) {
          // The anchor keeps `keep` tokens (§7.4); only when that would miss the 0.5·C target by a lot is it lowered,
          // never below half of keep (small economy ceilings).
          const keep = info.ceiling.keepTokens;
          cut = chooseCut(candidates, Math.min(keep, Math.max(Math.floor(keep / 2), room - summaryTokens)));
        } else {
          maxOutputTokens = Math.min(summaryTokens, room - minKept);
          if (maxOutputTokens < L.summaryMinTokens) throw new GmiError('context_overflow', 'This task no longer fits the model context.');
          const fits = (c: Cut) => c.keptTokens <= room - maxOutputTokens;
          const preferred = chooseCut(candidates, Math.min(info.ceiling.keepTokens, Math.max(0, room - maxOutputTokens)));
          cut = fits(preferred) ? preferred : (candidates.find(fits) as Cut);
        }

        // A precomputed summary is swapped in when its anchor is still valid and the tail since it is short (§7.4).
        let outcome: SummaryOutcome | null = null;
        let usedPrecomputed = false;
        const spent = { usd: null as number | null };
        const pre = precomputed.get(contextId);
        if (pre?.done && pre.summary !== null) {
          const preCut = candidates.find((c) => c.uptoOrd === pre.uptoOrd);
          const tailOk = preCut !== undefined && swapTailOk(preCut, info.ceiling);
          const sameBase = pre.baseCompactionId === (view.compaction?.id ?? null) && pre.compactionModel === req.compactionModel;
          const turnOk = pre.turn === req.turn || !pre.requestPinned;
          const fitsTarget = layer === 1 || (preCut !== undefined && info.prefixTokens + ledgerTokens + summaryMsgTokens(pre.summary) + preCut.keptTokens <= target);
          if (preCut && tailOk && sameBase && turnOk && fitsTarget) {
            cut = preCut;
            outcome = { summary: pre.summary, model: pre.model, byModel: true };
            spent.usd = pre.costUsd;
            usedPrecomputed = true;
          }
        }
        dropPrecomputed(contextId);

        if (!outcome) {
          outcome = await summarise(
            {
              threadId,
              contextId,
              runId: req.runId,
              turn: req.turn,
              model: req.model,
              compactionModel: req.compactionModel,
              view,
              uptoOrd: cut.uptoOrd,
              requestPinned: cut.pinSources.length > 0 || view.pinned.some((p) => p.turn === req.turn && p.ord > cut.uptoOrd),
              pinnedIds: new Set(view.pinned.filter((p) => p.turn === req.turn).map((p) => p.id)),
              info,
              maxOutputTokens,
              priority: 'foreground',
              allowPrefix: layer === 1,
            },
            req.signal,
            spent,
            layer,
          );
        }
        if (req.signal.aborted) throw cancelled();

        const summary = composeSummary(outcome.summary, ledger);
        const pins = pinCopies(cut.pinSources, k);
        const keptRows = view.rows.filter((m) => m.ord > cut.uptoOrd);
        const afterTokens = info.prefixTokens + summaryMsgTokens(summary) + keptRows.reduce((a, m) => a + sized(m), 0) + pins.reduce((a, p) => a + p.tokens, 0);
        if (afterTokens > target) log.warn('compaction above its target', { threadId, contextId, layer, after: afterTokens, target });
        const resultLayer: 1 | 2 = layer === 2 || !outcome.byModel ? 2 : 1;

        const compactionId = newId('cmp', clock.now());
        const at = iso();
        const row: CompactionRow = {
          id: compactionId,
          threadId,
          contextId,
          uptoOrd: cut.uptoOrd,
          summary,
          model: outcome.model,
          beforeTokens,
          afterTokens,
          costUsd: spent.usd,
          createdAt: at,
        };
        const publicEvents: StoredEvent[] = [];
        store.transaction(() => {
          store.messages.markOutOfContext(contextId, cut.uptoOrd);
          for (const pin of pins) {
            store.messages.append({
              id: newId('msg', clock.now()),
              threadId,
              contextId,
              turn: pin.source.turn,
              role: 'user',
              content: pin.content,
              toolCalls: null,
              toolCallId: null,
              reasoning: null,
              reasoningFamily: null,
              model: pin.source.model,
              inContext: true,
              pinned: true,
              partial: false,
              estTokens: pin.tokens,
              ...(pin.source.steering ? { steering: true } : {}),
            });
          }
          store.compactions.insert(row);
          const base = { threadId, contextId, runId: req.runId, turn: req.turn, step: null };
          // Review H2: no internal `compaction` event here. Every stored event takes a thread_seq and internal events are
          // never forwarded, so the renderer saw a gap (and refetched) at every compaction. The compactions row and the
          // public item below hold the data; the log line has the rest.
          // The timeline's compaction marker (§12.3); its seq is the event's own thread_seq.
          if (contextId === contextIdOf(threadId)) {
            const seq = store.events.lastSeq(threadId) + 1;
            const item = { kind: 'compaction' as const, id: compactionId, seq, beforeTokens, afterTokens, model: outcome.model, costUsd: spent.usd, at };
            publicEvents.push(store.events.append({ ...base, type: 'item', payload: { type: 'item', item } }));
          }
        });
        pruneReads(contextId, cut.uptoOrd);
        for (const ev of publicEvents) {
          try {
            opts.onEvent?.(ev);
          } catch (e) {
            log.warn('compaction event listener failed', { code: asGmiError(e).code });
          }
        }
        log.info('compaction', {
          threadId,
          contextId,
          before: beforeTokens,
          after: afterTokens,
          model: outcome.model,
          ms: clock.now() - startedAt,
          costUsd: spent.usd,
          layer: resultLayer,
          precomputed: usedPrecomputed,
          reason: req.reason,
          pinned: pins.length,
        });
        return { compactionId, uptoOrd: cut.uptoOrd, beforeTokens, afterTokens, model: outcome.model, costUsd: spent.usd, layer: resultLayer, usedPrecomputed };
      } finally {
        busy.delete(contextId);
      }
    },

    pruneReads,

    cancel(contextId) {
      dropPrecomputed(contextId);
    },

    async idle() {
      await Promise.all([...precomputed.values()].map((p) => p.promise));
    },
  };
  return compactor;
}
