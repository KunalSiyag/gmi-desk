/**
 * The agent loop (harness.md §6): one active run per thread, the step algorithm, tool batches, caps, doom-loop
 * guard, steering, cancellation and the host → main event stream.
 *
 * Invariants (§6.1):
 * 1. Every assistant tool call stored in history has exactly one tool result before the next request. Calls that do
 *    not run get a synthetic result; incomplete calls (partial deltas, arguments cut by `length`) are never stored.
 * 2. Side effects run only after `tool.started` (with arguments) is committed.
 * 3. History is append-only (compaction marks rows out of context and adds a summary row; it never edits).
 * 4. One in-flight main-loop gateway request per context; every mutation holds the thread's worktree mutation lock.
 * 5. The wall-clock cap counts only active time: awaiting_approval and awaiting_user pause it.
 *
 * Token thrift: the prefix ([system]+[tools]+[user#0]) is frozen per turn and byte-stable (context.ts); volatile
 * data lives only in the turn's user message; tool output is capped per result (tools) and per step (40k tokens);
 * the context is compacted before it reaches the 160k default working window's ceiling (§7.4, H2-C).
 */
import { CODE_DEFAULTS, type ApprovalDecision, type ApprovalRequest, type CodeThreadEvent, type ContextMeter, type NoticeReason, type QueueReason, type RunStatus, type StepUsage, type TimelineItem, type ToolStatus } from '@shared/contracts/code';
import { GmiError, toGmiError, type GmiErrorShape } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayPriority, GatewayPurpose, GatewayRequest, GwMessage, GwToolCall, GwToolDef } from '@shared/contracts/gateway';
import { canonicalJson, type RunStartedResult } from '../protocol';
import {
  contextIdOf,
  harnessPaths,
  newId,
  turnIdOf,
  type Ceiling,
  type Compactor,
  type GitService,
  type HostClock,
  type HostLog,
  type MainLink,
  type MessageRow,
  type MutationLock,
  type PermissionContext,
  type PermissionEngine,
  type ProjectRow,
  type SandboxRunner,
  type Store,
  type StoredEvent,
  type ThreadGitRecord,
  type ThreadRow,
  type ToolCallInfo,
  type ToolCallStatus,
  type ToolDefinition,
  type ToolErrorKind,
  type ToolRegistry,
  type ToolResult,
  type ToolRunContext,
} from '../types';
import { capStepResults, isParallelEligible, planBatches, runBatches } from './batch';
import { ActiveClock, CAP_LIMITS, checkCaps, emptyRunLog, resolveBudget, summaryFromLog, type ResolvedBudget, type RunLog } from './caps';
import {
  assignWireIds,
  budgetLine,
  buildPrefix,
  environmentBlock,
  historyView,
  instructionsFromSnapshot,
  reasoningFamily,
  requestMessages,
  threadGitRecord,
  turnMessage,
  volatileBlock,
  toWire,
  type HistoryView,
  type Prefix,
} from './context';
import type { CompactionContextInfo } from './compaction';
import { DoomDetector, type DoomResult, type DoomSignal } from './doom';
import { subtractRange } from '../tools/fs';
import { MAX_STEPS_OUTPUT_TOKENS, PROMPTS, SYNTHETIC } from './prompts';
import { fallbackTitle, generateTitle } from './side-tasks';
import { SteerQueue } from './steer';
import { Calibration, EstimateCache, estimateMessage, sizeEstimate, type SizeBaseline } from './tokens';

// ─── Public surface ───────────────────────────────────────────────────────────────────────────────────────────

/** What the host knows of a model (from main's catalog; integration supplies it). Unknown → conservative defaults. */
export interface ModelInfo {
  /** Catalog context length; null → 128k (§7.4). */
  contextTokens: number | null;
  /** Next long-context price tier boundary (prompt tokens), or null. */
  tierBoundaryTokens: number | null;
  /** $ per million tokens; null when unknown (no cost trigger, no next-step estimate). */
  pricing: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number | null } | null;
}

/** Eval determinism (§16): fixed `<environment>`, date and budget line, so requests do not depend on the machine. */
export interface EvalFixtures {
  date: string;
  environment: string;
  budget: string;
}

export interface LoopDeps {
  store: Store;
  link: MainLink;
  tools: ToolRegistry;
  perm: PermissionEngine;
  sandbox: SandboxRunner;
  git: GitService;
  lock: MutationLock;
  compactor: Compactor;
  clock: HostClock;
  log: HostLog;
  /** `init.dataDir` (spill paths, §8.7). */
  dataDir: string;
  platform?: NodeJS.Platform;
  ripgrep?: boolean;
  modelInfo?: (model: string) => ModelInfo;
  evalMode?: EvalFixtures | null;
  /**
   * Starts a run's first step after the command result is sent (main opens the run on `cmd.result`, H2-0
   * convention). Default: setImmediate.
   */
  defer?: (fn: () => void) => void;
  /**
   * The compactor credits each summary request's cost as it is charged (its `onCost` wired to `creditCost`), so the
   * loop does not add a compaction's result cost again (review H2).
   */
  compactionCostReported?: boolean;
}

export interface SendOptions {
  commandId?: string;
  /** Scheduled or eval runs: `ask` becomes deny and awaiting_user becomes stopped(doom_loop) (§6.4, §9.3). */
  unattended?: boolean;
}

/** A subagent's run on its own context (§8.6, used by H3-E's task tool). */
export interface ChildRunInput {
  threadId: string;
  toolCallId?: string;
  /** The parent's run: main tracks it; the child's requests use its scope. */
  parentRunId: string;
  /** The child's context id (its child run id, §5.2). */
  contextId: string;
  prompt: string;
  model: string;
  maxSteps: number;
  maxUsd: number | null;
  toolFilter: (def: ToolDefinition) => boolean;
  signal: AbortSignal;
}

export interface ChildRunResult {
  status: RunStatus;
  text: string;
  steps: number;
  costUsd: number;
}

/**
 * What tools receive beyond the frozen ToolRunContext (additive; requested for types.ts at integration):
 * - `sensitiveWrites`: the user's "allow writes to sensitive files" on an allow_once (§8.2.6);
 * - `askUser`: the `question` tool's way to ask (awaiting_user, wall clock paused, answer as ApprovalDecision).
 */
export interface LoopToolContext extends ToolRunContext {
  sensitiveWrites: boolean;
  askUser(question: { question: string; options?: string[] }): Promise<ApprovalDecision>;
}

export interface AgentLoop {
  /** Starts a turn (or queues the text as steering when a run is active). */
  send(threadId: string, text: string, opts?: SendOptions): Promise<RunStartedResult>;
  /** Queues steering for the active run; refused (conflict) when none is active. */
  steer(threadId: string, text: string): void;
  interrupt(threadId: string): Promise<void>;
  /** Continues an interrupted, stopped or cancelled turn with a new run. */
  resume(threadId: string, opts?: SendOptions): Promise<RunStartedResult>;
  /** Host start (§5.1): runs that were active → interrupted; unsettled calls → synthetic results. */
  recoverThread(threadId: string): Promise<void>;
  /** Threads whose state needs recovery after a restart. */
  threadsToRecover(): string[];
  runChild(input: ChildRunInput): Promise<ChildRunResult>;
  active(threadId: string): { runId: string; turn: number; status: RunStatus } | null;
  /**
   * H2-C's `CompactorOptions.contextInfo`: the ceiling, calibration and — for summaries on the thread's own model —
   * the exact frozen prefix and history serialisation, so the summary request hits the prompt cache.
   */
  compactionContext(req: { threadId: string; contextId: string; model: string; turn: number }): CompactionContextInfo | null;
  /** H2-C's `CompactorOptions.onEvent`: forwards a public durable event stored by another module (deltas first). */
  forwardStored(event: StoredEvent): void;
  /** Resolves when the thread's current run (if any) has ended. */
  idle(threadId: string): Promise<void>;
  /**
   * Money main charged outside a step's own stream (a compaction or precompute summary, a request cancelled before
   * its usage arrived): added to the thread's cost and to the active run's turn cost (review H2).
   */
  creditCost(threadId: string, contextId: string | null, usd: number): void;
  shutdown(graceMs: number): Promise<void>;
}

// ─── Constants ────────────────────────────────────────────────────────────────────────────────────────────────

export const LOOP_LIMITS = {
  /** Host-side delta batching per thread (§6.6). */
  deltaBatchMs: 40,
  /** Meter events at most 4/s per thread (§6.6). */
  meterIntervalMs: 250,
  /** Partial (streaming checkpoint) message rows at most every 1 s (§5.2). */
  partialEveryMs: 1_000,
  /** Tool output streamed live, then a 1 Hz tail window (§6.6). */
  liveOutputChars: 32 * 1024,
  tailOutputChars: 4 * 1024,
  tailIntervalMs: 1_000,
  /** Durable payload caps (§5.2: outputs ≤ 64 KiB). */
  eventArgsChars: 16 * 1024,
  argsPreviewChars: 512,
  approvalArgsChars: 4 * 1024,
  approvalDiffLines: 200,
  approvalTtlMs: 24 * 60 * 60 * 1000,
  /** cache_miss_suspect after this many steps (§7.1). */
  cacheCheckAfterStep: 3,
  unknownContextTokens: 128_000,
} as const;

const ACTIVE: ReadonlySet<RunStatus> = new Set(['queued', 'running', 'awaiting_approval', 'awaiting_user', 'compacting']);
const RESUMABLE: ReadonlySet<RunStatus> = new Set(['interrupted', 'stopped', 'cancelled']);
/** Gateway errors the user must fix (key, sign-in, refusals): `failed`; everything else: `stopped` + Continue. */
const FATAL_CODES = new Set(['no_api_key', 'invalid_api_key', 'unauthorized', 'not_signed_in', 'reauth_required', 'insufficient_scope', 'invalid_input', 'permission_denied', 'not_implemented']);

type AbortReason = 'user' | 'time_cap' | 'shutdown' | 'parent';

class RunAborted extends Error {
  constructor(readonly reason: AbortReason) {
    super(`run aborted: ${reason}`);
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

/** At most `max` characters including the ellipsis (review H2: a 4,097-character args field broke main's schema). */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Tool names main's request validators accept (§13.2). Anything else is stored in history under a fixed name. */
const WIRE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const INVALID_TOOL_NAME = 'invalid_tool_name';
const MONEY_STOP_CODES = new Set(['limit_reached', 'budget_exceeded', 'payment_required']);

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim() === '' ? '{}' : raw;
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid JSON' };
  }
}

function errorResult(kind: ToolErrorKind, content: string): ToolResult {
  return { ok: false, errorKind: kind, content, preview: { text: clip(content, 65_536), truncated: content.length > 65_536, totalBytes: Buffer.byteLength(content), spillId: null } };
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<{ aborted: false; value: T } | { aborted: true }> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve({ aborted: false, value });
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Host-side batching of ephemeral deltas: 40 ms per thread, flushed before any durable event (§6.6). */
class DeltaBatcher {
  private readonly pending = new Map<string, Map<string, { itemId: string; field: 'text' | 'reasoning' | 'output' | 'args'; text: string; offset: number }>>();
  private readonly timers = new Map<string, unknown>();
  constructor(
    private readonly clock: HostClock,
    private readonly send: (e: CodeThreadEvent) => void,
  ) {}

  push(threadId: string, itemId: string, field: 'text' | 'reasoning' | 'output' | 'args', text: string, offset: number): void {
    if (!text) return;
    let byKey = this.pending.get(threadId);
    if (!byKey) {
      byKey = new Map();
      this.pending.set(threadId, byKey);
    }
    const key = `${itemId}\0${field}`;
    const cur = byKey.get(key);
    if (cur && cur.offset + cur.text.length === offset) cur.text += text;
    else {
      if (cur) this.emit(threadId, cur);
      byKey.set(key, { itemId, field, text, offset });
    }
    if (!this.timers.has(threadId)) this.timers.set(threadId, this.clock.setTimeout(() => this.flush(threadId), LOOP_LIMITS.deltaBatchMs));
  }

  flush(threadId: string): void {
    const t = this.timers.get(threadId);
    if (t !== undefined) this.clock.clearTimeout(t);
    this.timers.delete(threadId);
    const byKey = this.pending.get(threadId);
    this.pending.delete(threadId);
    if (byKey) for (const d of byKey.values()) this.emit(threadId, d);
  }

  private emit(threadId: string, d: { itemId: string; field: 'text' | 'reasoning' | 'output' | 'args'; text: string; offset: number }): void {
    this.send({ threadId, seq: null, type: 'delta', itemId: d.itemId, field: d.field, text: d.text, offset: d.offset });
  }
}

// ─── Run state ────────────────────────────────────────────────────────────────────────────────────────────────

interface Run {
  threadId: string;
  projectId: string;
  contextId: string;
  runId: string;
  turn: number;
  child: boolean;
  parent: Run | null;
  purpose: GatewayPurpose;
  priority: GatewayPriority;
  model: string;
  controller: AbortController;
  abortReason: AbortReason | null;
  status: RunStatus;
  stepsDone: number;
  budget: ResolvedBudget;
  active: ActiveClock;
  doom: DoomDetector;
  log: RunLog;
  turnCostUsd: number;
  lengthHits: number;
  argsLengthHits: number;
  prefix: Prefix;
  frozenTools: GwToolDef[];
  frozenNames: Set<string>;
  unattended: boolean;
  record: ThreadGitRecord | null;
  worktree: string;
  pendingApprovals: number;
  pendingNotes: string[];
  queue: { position: number | null; reason: QueueReason | null };
  cacheLowNoticed: boolean;
  lastPromptTokens: number | null;
  done: Promise<void>;
  finalStatus: RunStatus | null;
  lastText: string;
}

interface StreamOutcome {
  text: string;
  reasoning: string;
  model: string;
  calls: GwToolCall[];
  /** Tool-call delta slots that never became a complete call (cut streams). */
  incompleteDeltas: Array<{ index: number; name: string | null }>;
  finish: Extract<GatewayEvent, { type: 'finish' }> | null;
  error: { error: GmiErrorShape; afterOutput: boolean } | null;
  usage: Extract<GatewayEvent, { type: 'usage' }> | null;
  /** The run was aborted while streaming. */
  aborted: boolean;
  latencyMs: number;
  partialId: string | null;
  itemId: string;
  itemShown: boolean;
}

interface PreparedCall {
  index: number;
  tc: ToolCallInfo;
  def: ToolDefinition | null;
  args: unknown;
  error: string | null;
  invalid: boolean;
}

interface CallOutcome {
  status: ToolCallStatus;
  itemStatus: ToolStatus;
  result: ToolResult;
  byUser: boolean;
  startedAt: number | null;
  finishedAt: number;
}

type StepEnd = { kind: 'continue' } | { kind: 'done' } | { kind: 'stop'; status: RunStatus; reason: NoticeReason; level: 'info' | 'warning' | 'error'; text: string };

// ─── The loop ─────────────────────────────────────────────────────────────────────────────────────────────────

export function createAgentLoop(deps: LoopDeps): AgentLoop {
  const { store, link, clock } = deps;
  const log = deps.log.child('loop');
  const runs = new Map<string, Run>();
  /** Every active run (main and subagent) by context id. */
  const byContext = new Map<string, Run>();
  const steering = new SteerQueue();
  const calibration = new Calibration();
  const estimates = new EstimateCache();
  const baselines = new Map<string, SizeBaseline>();
  const economyNoticed = new Set<string>();
  const lastMeterAt = new Map<string, number>();
  const meterTimers = new Map<string, unknown>();
  const deltas = new DeltaBatcher(clock, (e) => link.events.event(e));
  const defer = deps.defer ?? ((fn: () => void) => void setImmediate(fn));
  const paths = harnessPaths(deps.dataDir);
  let shuttingDown = false;
  const modelInfo = (model: string): ModelInfo => deps.modelInfo?.(model) ?? { contextTokens: null, tierBoundaryTokens: null, pricing: null };

  // ── Events ──

  type DurablePayload =
    | { type: 'item'; item: TimelineItem }
    | { type: 'status'; status: RunStatus; reason: string | null; queuePosition: number | null; queueReason: QueueReason | null };

  /**
   * Stores a public durable event with the thread's next thread_seq and forwards it (§6.6). `inTx` runs in the same
   * transaction (row updates that must be durable together with the event).
   *
   * The loop writes ONLY public event types: every stored event takes a thread_seq, and the renderer treats a gap in
   * the seqs it receives as lost events (refetch). Internal facts (a call started or finished, a turn's number) live
   * in the `tool_calls` / `messages` rows, committed in the same transaction as the public item.
   */
  function emitDurable(threadId: string, scope: { contextId: string; runId: string | null; turn: number | null; step: number | null }, build: (seq: number) => DurablePayload, inTx?: () => void): number {
    deltas.flush(threadId);
    const stored = store.transaction(() => {
      inTx?.();
      const seq = store.events.lastSeq(threadId) + 1;
      const payload = build(seq);
      const ev = store.events.append({ threadId, contextId: scope.contextId, runId: scope.runId, turn: scope.turn, step: scope.step, type: payload.type, payload });
      return { ev, payload };
    });
    const { ev, payload } = stored;
    if (payload.type === 'item' && payload.item.seq !== ev.seq) (payload.item as { seq: number }).seq = ev.seq;
    link.events.event({ threadId, seq: ev.seq, ...payload } as CodeThreadEvent);
    return ev.seq;
  }

  const scopeOf = (run: Run, step: number | null = run.stepsDone || null) => ({ contextId: run.contextId, runId: run.runId, turn: run.turn, step });

  function emitItem(run: Run, item: Omit<TimelineItem, 'seq'>, step: number | null = null, inTx?: () => void): void {
    if (run.child && item.kind !== 'approval') {
      if (inTx) store.transaction(inTx);
      return;
    }
    emitDurable(run.threadId, scopeOf(run, step), (seq) => ({ type: 'item', item: { ...item, seq } as TimelineItem }), inTx);
  }

  function notice(run: Run, reason: NoticeReason, level: 'info' | 'warning' | 'error', text: string): void {
    if (run.child) return;
    emitItem(run, { kind: 'notice', id: newId('ev', clock.now()), level, reason, text, at: iso(clock.now()) } as Omit<TimelineItem, 'seq'>);
  }

  function publishSummary(threadId: string): void {
    try {
      link.events.threads(store.threads.summaries().filter((t) => t.id === threadId));
    } catch (error) {
      log.warn('thread summary failed', { code: toGmiError(error).code });
    }
  }

  function setStatus(run: Run, status: RunStatus, reason: string | null = null, queue: { position: number | null; reason: QueueReason | null } = { position: null, reason: null }): void {
    if (run.child) return;
    if (run.status === status && run.queue.position === queue.position && run.queue.reason === queue.reason && reason === null) return;
    run.status = status;
    run.queue = queue;
    store.threads.update(run.threadId, { status, statusReason: reason });
    emitDurable(run.threadId, scopeOf(run), () => ({ type: 'status', status, reason, queuePosition: queue.position, queueReason: queue.reason }));
    publishSummary(run.threadId);
  }

  function setThreadStatus(threadId: string, status: RunStatus, reason: string | null): void {
    store.threads.update(threadId, { status, statusReason: reason });
    emitDurable(threadId, { contextId: contextIdOf(threadId), runId: null, turn: null, step: null }, () => ({ type: 'status', status, reason, queuePosition: null, queueReason: null }));
    publishSummary(threadId);
  }

  // ── Meter (ephemeral, ≤ 4/s per thread) ──

  interface MeterInput {
    ceiling: Ceiling;
    sizeTokens: number;
    estimated: boolean;
    messageCount: number;
    nextStepUsd: number | null;
  }
  const lastMeter = new Map<string, MeterInput>();

  function sendMeter(run: Run, input?: MeterInput): void {
    if (run.child) return;
    if (input) lastMeter.set(run.threadId, input);
    const m = lastMeter.get(run.threadId);
    if (!m) return;
    const now = clock.now();
    const last = lastMeterAt.get(run.threadId) ?? -Infinity;
    if (now - last < LOOP_LIMITS.meterIntervalMs) {
      if (!meterTimers.has(run.threadId)) {
        meterTimers.set(
          run.threadId,
          clock.setTimeout(() => {
            meterTimers.delete(run.threadId);
            sendMeter(run);
          }, LOOP_LIMITS.meterIntervalMs - (now - last)),
        );
      }
      return;
    }
    lastMeterAt.set(run.threadId, now);
    const thread = store.threads.get(run.threadId);
    if (!thread) return;
    const usage = store.usage.list(run.threadId, { contextId: run.contextId });
    const lastUsage = usage[usage.length - 1];
    const meter: ContextMeter = {
      windowTokens: m.ceiling.windowTokens,
      ceilingTokens: m.ceiling.ceilingTokens,
      usedTokens: m.sizeTokens,
      reserveTokens: m.ceiling.reserveTokens,
      cachedRatio: lastUsage && lastUsage.prompt > 0 ? lastUsage.cached / lastUsage.prompt : null,
      compactions: store.compactions.list(run.contextId).length,
      tierBoundaryTokens: m.ceiling.tierBoundaryTokens,
      messageCount: m.messageCount,
      nextStepUsd: m.nextStepUsd,
      estimated: m.estimated,
    };
    link.events.event({ threadId: run.threadId, seq: null, type: 'meter', meter, tokens: thread.tokens, costUsd: thread.costUsd });
  }

  // ── Threads, prefix and turns ──

  function loadThread(threadId: string): { thread: ThreadRow; project: ProjectRow } {
    const thread = store.threads.get(threadId);
    if (!thread) throw new GmiError('not_found', 'Thread not found.');
    const project = store.projects.get(thread.projectId);
    if (!project) throw new GmiError('not_found', 'Project not found.');
    return { thread, project };
  }

  function assertRunnable(thread: ThreadRow): void {
    if (thread.archived) throw new GmiError('invalid_input', 'This thread is archived.');
    if (thread.setupState !== 'ready') throw new GmiError('invalid_input', 'This thread is not ready yet.');
    if (!thread.worktreePath) throw new GmiError('invalid_input', 'This thread has no worktree.');
  }

  /** The frozen `<environment>` block: computed once per thread and stored (§7.1). */
  function environmentOf(thread: ThreadRow, project: ProjectRow): string {
    if (deps.evalMode) return deps.evalMode.environment;
    if (thread.envBlock) return thread.envBlock;
    const sb = deps.sandbox.state();
    const env = environmentBlock({
      platform: deps.platform ?? process.platform,
      shell: 'bash',
      repoName: project.name,
      worktreePath: thread.worktreePath ?? project.rootPath,
      baseBranch: thread.baseRef,
      branch: thread.branch,
      ripgrep: deps.ripgrep ?? false,
      sandbox: sb.ok ? `${sb.kind}, network ${sb.network}` : 'unavailable (every shell command asks)',
    });
    store.threads.update(thread.id, { envBlock: env });
    return env;
  }

  function freezeTools(filter?: (def: ToolDefinition) => boolean): GwToolDef[] {
    return deps.tools.definitions(filter);
  }

  /** The thread's last turn number: the highest `turn` of its main context's messages. */
  function lastTurn(threadId: string): number {
    let max = 0;
    for (const m of store.messages.list(contextIdOf(threadId))) if (m.turn !== null && m.turn > max) max = m.turn;
    return max;
  }

  function threadSpend(threadId: string): number {
    return store.threads.get(threadId)?.costUsd ?? 0;
  }

  async function gitStatusOf(record: ThreadGitRecord | null): Promise<string | null> {
    if (!record) return null;
    try {
      return await deps.git.statusShort(record);
    } catch (error) {
      log.warn('git status failed', { code: toGmiError(error).code });
      return null;
    }
  }

  // ── Run creation ──

  function newRun(input: { thread: ThreadRow; project: ProjectRow; turn: number; unattended: boolean; prefix: Prefix; tools: GwToolDef[] }): Run {
    const budget = resolveBudget(input.thread.settings);
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const run: Run = {
      threadId: input.thread.id,
      projectId: input.project.id,
      contextId: contextIdOf(input.thread.id),
      runId: newId('run', clock.now()),
      turn: input.turn,
      child: false,
      parent: null,
      purpose: 'agent',
      priority: 'foreground',
      model: input.thread.settings.model,
      controller: new AbortController(),
      abortReason: null,
      status: input.thread.status,
      stepsDone: 0,
      budget,
      active: null as unknown as ActiveClock,
      doom: new DoomDetector(),
      log: emptyRunLog(),
      turnCostUsd: 0,
      lengthHits: 0,
      argsLengthHits: 0,
      prefix: input.prefix,
      frozenTools: input.tools,
      frozenNames: new Set(input.tools.map((t) => t.name)),
      unattended: input.unattended,
      record: threadGitRecord(input.thread, input.project),
      worktree: input.thread.worktreePath ?? input.project.rootPath,
      pendingApprovals: 0,
      pendingNotes: [],
      queue: { position: null, reason: null },
      cacheLowNoticed: false,
      lastPromptTokens: null,
      done,
      finalStatus: null,
      lastText: '',
    };
    run.active = new ActiveClock(clock, budget.maxActiveMs, () => abort(run, 'time_cap'));
    (run as { resolveDone?: () => void }).resolveDone = resolveDone;
    return run;
  }

  function abort(run: Run, reason: AbortReason): void {
    if (run.abortReason) return;
    run.abortReason = reason;
    run.controller.abort(new RunAborted(reason));
  }

  function throwIfAborted(run: Run): void {
    if (run.abortReason) throw new RunAborted(run.abortReason);
  }

  async function prepareTurn(thread: ThreadRow, project: ProjectRow): Promise<{ prefix: Prefix; tools: GwToolDef[]; instructionsChanged: boolean }> {
    const tools = freezeTools();
    const instructions = instructionsFromSnapshot(store, project);
    const prefix = buildPrefix({ tools, instructions, environment: environmentOf(thread, project) });
    const instructionsChanged = thread.instructionsHash !== null && thread.instructionsHash !== prefix.instructionsHash;
    if (thread.instructionsHash !== prefix.instructionsHash) store.threads.update(thread.id, { instructionsHash: prefix.instructionsHash });
    return { prefix, tools, instructionsChanged };
  }

  function startDriving(run: Run): void {
    runs.set(run.threadId, run);
    defer(() => {
      void drive(run);
    });
  }

  // ── send / resume / steer / interrupt ──

  async function send(threadId: string, text: string, opts: SendOptions = {}): Promise<RunStartedResult> {
    if (opts.commandId) {
      const receipt = store.receipts.get(opts.commandId);
      if (receipt) return receipt.result as RunStartedResult;
    }
    const body = text.trim();
    if (!body) throw new GmiError('invalid_input', 'The message is empty.');
    const current = runs.get(threadId);
    if (current) {
      // §6.5: a message sent while a run is active is queued as steering.
      if (!steering.push(threadId, body, clock.now())) throw new GmiError('conflict', 'Too many queued messages.');
      const result: RunStartedResult = { runId: current.runId, turn: current.turn, budgetWarning: null };
      if (opts.commandId) store.receipts.put(opts.commandId, threadId, result);
      return result;
    }
    const { thread, project } = loadThread(threadId);
    assertRunnable(thread);
    const turn = lastTurn(threadId) + 1;
    const { prefix, tools, instructionsChanged } = await prepareTurn(thread, project);
    const run = newRun({ thread, project, turn, unattended: opts.unattended ?? false, prefix, tools });
    const volatile = volatileBlock({
      date: deps.evalMode?.date ?? iso(clock.now()).slice(0, 10),
      mode: thread.settings.mode,
      gitStatus: await gitStatusOf(run.record),
      todos: store.todos.get(run.contextId),
      budget: deps.evalMode?.budget ?? budgetLine({ perTurnUsd: run.budget.perTurnUsd, perThreadUsd: run.budget.perThreadUsd, turnSpentUsd: 0, threadSpentUsd: thread.costUsd }),
    });
    // Re-check: another send may have started a run while we awaited git.
    if (runs.has(threadId)) return send(threadId, text, opts);
    const content = turnMessage(body, volatile);
    const at = clock.now();
    runs.set(threadId, run);
    const msgId = newId('msg', at);
    emitItem(run, { kind: 'user', id: msgId, turn, text: body, steering: false, at: iso(at) } as Omit<TimelineItem, 'seq'>, null, () => {
      appendMessage(run, { id: msgId, role: 'user', content, turn });
    });
    if (instructionsChanged) notice(run, 'instructions_changed', 'info', 'The project instructions changed; the new version applies from this turn.');
    if (!thread.title.trim()) store.threads.update(threadId, { title: fallbackTitle(body) });
    setStatus(run, 'running');
    const result: RunStartedResult = { runId: run.runId, turn, budgetWarning: null };
    if (opts.commandId) store.receipts.put(opts.commandId, threadId, result);
    startDriving(run);
    const sideModel = thread.settings.sideTaskModel;
    // Deferred like the run itself: main accepts requests for the run only after it saw the command result.
    if (!thread.title.trim() && sideModel) defer(() => titleInBackground(run, body, sideModel));
    return result;
  }

  function titleInBackground(run: Run, text: string, model: string): void {
    const controller = new AbortController();
    run.controller.signal.addEventListener('abort', () => controller.abort(), { once: true });
    void generateTitle(link.gateway, { scope: { threadId: run.threadId, turnId: turnIdOf(run.threadId, run.turn), runId: run.runId, step: null }, model, text, signal: controller.signal })
      .then(({ title, costUsd }) => {
        if (costUsd) addCost(run, costUsd, null);
        store.threads.update(run.threadId, { title });
        publishSummary(run.threadId);
      })
      .catch((error: unknown) => log.debug('title failed', { code: toGmiError(error).code }));
  }

  async function resume(threadId: string, opts: SendOptions = {}): Promise<RunStartedResult> {
    if (opts.commandId) {
      const receipt = store.receipts.get(opts.commandId);
      if (receipt) return receipt.result as RunStartedResult;
    }
    if (runs.has(threadId)) throw new GmiError('conflict', 'A run is already active in this thread.');
    const { thread, project } = loadThread(threadId);
    assertRunnable(thread);
    if (!RESUMABLE.has(thread.status)) throw new GmiError('invalid_input', 'Only an interrupted, stopped or cancelled run can be continued.');
    const turn = lastTurn(threadId);
    if (turn === 0) throw new GmiError('invalid_input', 'Nothing to continue.');
    settleUnsettled(threadId, SYNTHETIC.restarted, SYNTHETIC.restartedNotRun);
    const { prefix, tools, instructionsChanged } = await prepareTurn(thread, project);
    const run = newRun({ thread, project, turn, unattended: opts.unattended ?? false, prefix, tools });
    const view = historyView(store, run.contextId);
    const last = view.entries[view.entries.length - 1]?.row;
    // The model needs a user message after its own last answer; after tool results it simply continues.
    if (!last || last.role === 'assistant') appendMessage(run, { role: 'user', content: PROMPTS.resume, turn, steering: true });
    runs.set(threadId, run);
    if (instructionsChanged) notice(run, 'instructions_changed', 'info', 'The project instructions changed; the new version applies from this turn.');
    setStatus(run, 'running');
    const result: RunStartedResult = { runId: run.runId, turn, budgetWarning: null };
    if (opts.commandId) store.receipts.put(opts.commandId, threadId, result);
    startDriving(run);
    return result;
  }

  function steer(threadId: string, text: string): void {
    if (!runs.has(threadId)) throw new GmiError('conflict', 'No run is active in this thread; send the message instead.');
    if (!steering.push(threadId, text, clock.now())) throw new GmiError('conflict', 'Too many queued messages.');
  }

  async function interrupt(threadId: string): Promise<void> {
    const run = runs.get(threadId);
    if (!run) return;
    abort(run, 'user');
    await run.done;
  }

  // ── Messages ──

  function appendMessage(run: Run, m: { id?: string; role: MessageRow['role']; content: string; turn: number; toolCalls?: GwToolCall[] | null; toolCallId?: string | null; reasoning?: string | null; model?: string | null; steering?: boolean }): MessageRow {
    const row: Omit<MessageRow, 'ord'> = {
      id: m.id ?? newId('msg', clock.now()),
      threadId: run.threadId,
      contextId: run.contextId,
      turn: m.turn,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls ?? null,
      toolCallId: m.toolCallId ?? null,
      reasoning: m.reasoning ?? null,
      reasoningFamily: m.reasoning ? reasoningFamily(m.model ?? run.model) : null,
      model: m.model ?? null,
      inContext: true,
      pinned: false,
      partial: false,
      estTokens: null,
      ...(m.steering ? { steering: true } : {}),
    };
    row.estTokens = estimateMessage({ role: row.role === 'system' ? 'user' : row.role, content: row.content, ...(row.toolCalls ? { toolCalls: row.toolCalls } : {}), ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}), ...(row.reasoning ? { reasoning: { text: row.reasoning, family: row.reasoningFamily ?? '' } } : {}) });
    return store.messages.append(row);
  }

  // ── Usage and money ──

  function addCost(run: Run, costUsd: number, tokens: { input: number; cached: number; output: number; reasoning: number } | null): void {
    const thread = store.threads.get(run.threadId);
    if (!thread) return;
    const t = thread.tokens;
    store.threads.update(run.threadId, {
      costUsd: thread.costUsd + costUsd,
      tokens: tokens ? { input: t.input + tokens.input, cached: t.cached + tokens.cached, output: t.output + tokens.output, reasoning: t.reasoning + tokens.reasoning } : t,
    });
    for (let r: Run | null = run; r; r = r.parent) r.turnCostUsd += costUsd;
  }

  function recordUsage(run: Run, step: number, ev: Extract<GatewayEvent, { type: 'usage' }>, model: string, req: { estimatedPrompt: number; uptoOrd: number; compactions: number }): void {
    const u = ev.usage;
    const cached = u.cachedTokens ?? 0;
    const expectedCached = run.lastPromptTokens;
    store.usage.insert({
      threadId: run.threadId,
      contextId: run.contextId,
      runId: run.runId,
      turn: run.turn,
      step,
      model,
      prompt: u.promptTokens,
      cached,
      expectedCached,
      completion: u.completionTokens,
      reasoning: u.reasoningTokens ?? 0,
      costUsd: ev.costUsd,
      estimated: ev.estimated,
      prefixHash: run.prefix.hash,
      at: iso(clock.now()),
    });
    addCost(run, ev.costUsd ?? 0, { input: u.promptTokens, cached, output: u.completionTokens, reasoning: u.reasoningTokens ?? 0 });
    if (!ev.estimated && u.promptTokens > 0) {
      calibration.observe(run.threadId, model, u.promptTokens, req.estimatedPrompt);
      baselines.set(run.contextId, { measuredPrompt: u.promptTokens, uptoOrd: req.uptoOrd, prefixHash: run.prefix.hash, compactions: req.compactions });
      // §7.1 diagnostics: measured cached tokens below 50 % of the expected (the previous prompt) after step 3.
      const cachePriced = (modelInfo(model).pricing?.cacheReadPerMTok ?? null) !== null;
      if (cachePriced && !run.cacheLowNoticed && step > LOOP_LIMITS.cacheCheckAfterStep && expectedCached !== null && expectedCached > 0 && cached < 0.5 * expectedCached) {
        run.cacheLowNoticed = true;
        log.warn('cache_miss_suspect', { threadId: run.threadId, step, cached, expected: expectedCached, model });
        notice(run, 'cache_low', 'info', 'Low prompt-cache hit rate: steps cost more than expected.');
      }
      run.lastPromptTokens = u.promptTokens;
    }
  }

  // ── Context for one request ──

  interface BuiltContext {
    view: HistoryView;
    messageCount: number;
    messages: GwMessage[];
    ceiling: Ceiling;
    sizeTokens: number;
    estimated: boolean;
    estimatedPrompt: number;
    uptoOrd: number;
    compactions: number;
    nextStepUsd: number | null;
    /** The §7.4 cost trigger's input (null: no trigger): cached-rate projection, only when compaction can help. */
    nextStepCachedUsd: number | null;
  }

  function buildContext(run: Run): BuiltContext {
    const settings = store.threads.get(run.threadId)?.settings;
    const view = historyView(store, run.contextId);
    const info = modelInfo(run.model);
    const compactions = store.compactions.list(run.contextId).length;
    const ests = view.entries.map((h) => ({ ord: h.row.ord, est: estimates.get(h.row.id, h.msg) }));
    if (view.summary) ests.unshift({ ord: 0, est: estimates.get(view.summary.id, view.summary.msg) });
    const k = calibration.get(run.threadId, run.model);
    const size = sizeEstimate({ baseline: baselines.get(run.contextId) ?? null, prefixHash: run.prefix.hash, compactions, k, prefixTokens: run.prefix.tokens, messages: ests });
    const ceiling = deps.compactor.ceiling({
      modelContextTokens: info.contextTokens,
      maxContextTokens: settings ? settings.maxContextTokens : CODE_DEFAULTS.maxContextTokens,
      maxOutputTokens: settings?.maxOutputTokens ?? CODE_DEFAULTS.maxOutputTokens,
      economy: settings?.economy ?? false,
      tierBoundaryTokens: info.tierBoundaryTokens,
      prefixTokens: Math.ceil(k * run.prefix.tokens),
    });
    const baseline = baselines.get(run.contextId);
    let nextStepUsd: number | null = null;
    if (info.pricing) {
      const cachedPart = baseline && baseline.prefixHash === run.prefix.hash && baseline.compactions === compactions ? Math.min(baseline.measuredPrompt, size.tokens) : 0;
      const cacheRate = info.pricing.cacheReadPerMTok ?? info.pricing.inputPerMTok;
      nextStepUsd = (cachedPart * cacheRate + (size.tokens - cachedPart) * info.pricing.inputPerMTok) / 1e6;
    }
    // Review H2: the cost trigger compares the CACHED cost of the next step (S × cache-read price) with perTurn/20.
    // It fires only for models with a cache-read price, only when compacting can bring the floor (prefix + summary +
    // kept tail) well under the limit, and not again until the context has doubled since the last compaction.
    let nextStepCachedUsd: number | null = null;
    const cacheRead = info.pricing?.cacheReadPerMTok ?? null;
    const perTurn = run.budget.perTurnUsd;
    if (cacheRead !== null && cacheRead > 0 && perTurn !== null && perTurn > 0) {
      const limit = perTurn / CODE_DEFAULTS.compactCostDivisor;
      const summaryTokens = view.summary ? estimates.get(view.summary.id, view.summary.msg) : 0;
      const floorTokens = Math.ceil(k * run.prefix.tokens) + summaryTokens + ceiling.keepTokens;
      const feasible = (floorTokens * cacheRead) / 1e6 < 0.5 * limit;
      const rows = store.compactions.list(run.contextId);
      const last = rows.length > 0 ? rows.reduce((a, b) => (b.uptoOrd >= a.uptoOrd ? b : a)) : null;
      const grown = last === null || size.tokens >= 2 * last.afterTokens;
      if (feasible && grown) nextStepCachedUsd = (size.tokens * cacheRead) / 1e6;
    }
    return {
      view,
      messageCount: ests.length,
      messages: requestMessages(run.prefix, view),
      ceiling,
      sizeTokens: size.tokens,
      estimated: size.estimated,
      estimatedPrompt: run.prefix.tokens + ests.reduce((s, e) => s + e.est, 0),
      uptoOrd: ests.reduce((m, e) => Math.max(m, e.ord), 0),
      compactions,
      nextStepUsd,
      nextStepCachedUsd,
    };
  }

  /** The run id main knows for this run's requests: a subagent uses its parent's. */
  function scopeRunId(run: Run): string {
    return run.parent?.runId ?? run.runId;
  }

  /** Compaction triggers before a request (§7.4); returns the (possibly rebuilt) context. */
  async function maybeCompact(run: Run, step: number, ctx: BuiltContext): Promise<BuiltContext> {
    const thread = store.threads.get(run.threadId);
    if (ctx.ceiling.economy === 'disabled' && !economyNoticed.has(`${run.threadId}\0${run.model}`)) {
      economyNoticed.add(`${run.threadId}\0${run.model}`);
      notice(run, 'economy_disabled', 'info', "This model's cheap price tier is too small for agent work; economy is off for it.");
    }
    const trigger = { ceiling: ctx.ceiling, sizeTokens: ctx.sizeTokens, messageCount: ctx.messageCount, nextStepCachedUsd: ctx.nextStepCachedUsd, perTurnUsd: run.budget.perTurnUsd };
    const fired = deps.compactor.trigger(trigger);
    const compactionModel = thread?.settings.compactionModel ?? run.model;
    if (!fired) {
      if (deps.compactor.shouldPrecompute(trigger)) deps.compactor.precompute({ threadId: run.threadId, contextId: run.contextId, runId: scopeRunId(run), turn: run.turn, model: run.model, compactionModel });
      return ctx;
    }
    await compact(run, step, { reason: fired, compactionModel });
    return buildContext(run);
  }

  async function compact(run: Run, step: number, opts: { reason: 'tokens' | 'messages' | 'cost' | 'overflow'; compactionModel: string; shrinkToTokens?: number }): Promise<void> {
    const prev = run.status;
    setStatus(run, 'compacting');
    try {
      const result = await deps.compactor.compact({
        threadId: run.threadId,
        contextId: run.contextId,
        // Review H2: a subagent's requests use the parent's run (main tracks only that one), like gwRequest.
        runId: scopeRunId(run),
        turn: run.turn,
        model: run.model,
        compactionModel: opts.compactionModel,
        reason: opts.reason,
        ...(opts.shrinkToTokens !== undefined ? { shrinkToTokens: opts.shrinkToTokens } : {}),
        signal: run.controller.signal,
      });
      // The compactor stores the summary, the `compaction` event and the timeline item itself, and prunes the
      // read ranges (H2-C); its public events reach main through `forwardStored`.
      baselines.delete(run.contextId);
      // The context changed: the previous prompt is no longer the expected cached size (cache_low diagnostic).
      run.lastPromptTokens = null;
      // With `compactionCostReported` the compactor already credited every summary request as it was charged.
      if (result.costUsd && !deps.compactionCostReported) addCost(run, result.costUsd, null);
      log.debug('compacted', { threadId: run.threadId, step, layer: result.layer, before: result.beforeTokens, after: result.afterTokens });
    } catch (error) {
      throwIfAborted(run);
      throw error;
    } finally {
      if (!run.abortReason) setStatus(run, prev === 'compacting' ? 'running' : prev);
    }
  }

  // ── Streaming one request ──

  async function stream(run: Run, step: number, req: GatewayRequest): Promise<StreamOutcome> {
    const started = clock.now();
    const out: StreamOutcome = {
      text: '',
      reasoning: '',
      model: run.model,
      calls: [],
      incompleteDeltas: [],
      finish: null,
      error: null,
      usage: null,
      latencyMs: 0,
      partialId: null,
      itemId: newId('msg', started),
      itemShown: false,
      aborted: false,
    };
    const slots = new Map<number, { name: string | null }>();
    let lastPartial = started;
    const showItem = () => {
      if (out.itemShown) return;
      out.itemShown = true;
      emitItem(run, { kind: 'assistant', id: out.itemId, turn: run.turn, step, text: '', reasoning: null, model: out.model, usage: null, status: 'streaming', at: iso(clock.now()) } as Omit<TimelineItem, 'seq'>, step);
    };
    const checkpointPartial = () => {
      const now = clock.now();
      if (now - lastPartial < LOOP_LIMITS.partialEveryMs || !out.text) return;
      lastPartial = now;
      store.messages.upsertPartial({ id: out.itemId, threadId: run.threadId, contextId: run.contextId, turn: run.turn, role: 'assistant', content: out.text, toolCalls: null, toolCallId: null, reasoning: out.reasoning || null, reasoningFamily: out.reasoning ? reasoningFamily(out.model) : null, model: out.model, inContext: true, pinned: false, estTokens: null });
      out.partialId = out.itemId;
    };
    try {
      for await (const ev of link.gateway.stream(req, run.controller.signal)) {
        switch (ev.type) {
          case 'queued':
            if (!run.child) setStatus(run, 'queued', null, { position: ev.position, reason: ev.reason });
            break;
          case 'started':
            if (ev.model) out.model = ev.model;
            if (run.status === 'queued') setStatus(run, 'running');
            break;
          case 'model':
            out.model = ev.model;
            break;
          case 'text':
            showItem();
            if (!run.child) deltas.push(run.threadId, out.itemId, 'text', ev.text, out.text.length);
            out.text += ev.text;
            checkpointPartial();
            break;
          case 'reasoning':
            showItem();
            if (!run.child) deltas.push(run.threadId, out.itemId, 'reasoning', ev.text, out.reasoning.length);
            out.reasoning += ev.text;
            break;
          case 'tool_call_delta': {
            const slot = slots.get(ev.index) ?? { name: null };
            if (ev.name) slot.name = ev.name;
            slots.set(ev.index, slot);
            break;
          }
          case 'tool_call':
            out.calls.push(ev.call);
            break;
          case 'usage':
            out.usage = ev;
            break;
          case 'finish':
            out.finish = ev;
            break;
          case 'error':
            out.error = { error: ev.error, afterOutput: ev.afterOutput };
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (run.abortReason) {
        out.latencyMs = clock.now() - started;
        deltas.flush(run.threadId);
        out.aborted = true;
        return out;
      }
      const e = toGmiError(error);
      out.error = { error: { code: e.code, message: e.message }, afterOutput: out.text.length > 0 || slots.size > 0 };
    }
    deltas.flush(run.threadId);
    out.latencyMs = clock.now() - started;
    // Cut streams: delta slots that never became a complete call.
    if (out.calls.length < slots.size) {
      for (const [index, slot] of [...slots].sort((a, b) => a[0] - b[0])) if (index >= out.calls.length) out.incompleteDeltas.push({ index, name: slot.name });
    }
    if (!out.finish && !out.error && !run.abortReason) out.error = { error: { code: 'upstream', message: 'The stream ended without a finish.' }, afterOutput: out.text.length > 0 || slots.size > 0 };
    return out;
  }

  // ── Storing a step's assistant message ──

  function storeAssistant(run: Run, step: number, s: StreamOutcome, calls: GwToolCall[], status: 'complete' | 'stopped' | 'error'): { row: MessageRow; infos: ToolCallInfo[] } {
    const wire = assignWireIds({ calls, turn: run.turn, step, isUsed: (id) => store.toolCalls.byWireId(run.contextId, id) !== null });
    // Review H2: a hallucinated name ('read file', '', 300 characters) stored as is made every later request of the
    // thread fail main's validation (the thread was bricked). History gets a fixed safe name; the raw name (clipped)
    // stays in tool_calls and in the "unknown tool" result.
    const toolCalls: GwToolCall[] = calls.map((c, i) => ({ id: wire[i]!, name: WIRE_TOOL_NAME.test(c.name) ? c.name : INVALID_TOOL_NAME, arguments: c.arguments }));
    const infos: ToolCallInfo[] = calls.map((c, i) => ({ id: newId('tc', clock.now()), wireId: wire[i]!, name: clip(c.name, 128), rawArgs: c.arguments }));
    const content = s.text;
    const row = store.transaction(() => {
      const base = {
        threadId: run.threadId,
        contextId: run.contextId,
        turn: run.turn,
        role: 'assistant' as const,
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        toolCallId: null,
        reasoning: s.reasoning || null,
        reasoningFamily: s.reasoning ? reasoningFamily(s.model) : null,
        model: s.model,
        inContext: true,
        pinned: false,
        estTokens: estimateMessage({ role: 'assistant', content, ...(toolCalls.length > 0 ? { toolCalls } : {}), ...(s.reasoning ? { reasoning: { text: s.reasoning, family: reasoningFamily(s.model) } } : {}) }),
      };
      const stored = s.partialId ? store.messages.finalizePartial(s.partialId, base) : store.messages.append({ id: s.itemId, ...base, partial: false });
      calls.forEach((c, i) => {
        store.toolCalls.insert({
          id: infos[i]!.id,
          wireId: wire[i]!,
          providerCallId: c.id || null,
          threadId: run.threadId,
          contextId: run.contextId,
          runId: run.runId,
          turn: run.turn,
          step,
          tool: clip(c.name, 128),
          args: c.arguments,
          status: 'started',
          resultMessageId: null,
          spillPath: null,
          exitCode: null,
          startedAt: null,
          finishedAt: null,
        });
      });
      return stored;
    });
    run.lastText = content || run.lastText;
    run.log.lastText = run.lastText;
    const u = s.usage;
    const usage: StepUsage | null = u
      ? { promptTokens: u.usage.promptTokens, cachedTokens: u.usage.cachedTokens ?? 0, completionTokens: u.usage.completionTokens, reasoningTokens: u.usage.reasoningTokens ?? 0, costUsd: u.costUsd, estimated: u.estimated, model: s.model, latencyMs: s.latencyMs }
      : null;
    if (content || s.reasoning || s.itemShown) {
      emitItem(run, { kind: 'assistant', id: row.id, turn: run.turn, step, text: content, reasoning: s.reasoning || null, model: s.model, usage, status, at: iso(clock.now()) } as Omit<TimelineItem, 'seq'>, step);
    }
    return { row, infos };
  }

  // ── Executing tool calls ──

  function prepareCalls(run: Run, infos: ToolCallInfo[]): PreparedCall[] {
    return infos.map((tc, index) => {
      const def = run.frozenNames.has(tc.name) ? deps.tools.get(tc.name) : null;
      if (!def) {
        const names = [...run.frozenNames].join(', ');
        return { index, tc, def: null, args: null, invalid: true, error: `Error: unknown tool "${clip(tc.name, 64)}". Available tools: ${names || 'none'}.` };
      }
      const json = parseArgs(tc.rawArgs);
      if (!json.ok) return { index, tc, def, args: null, invalid: true, error: invalidArgsText(def, `invalid JSON (${json.error})`) };
      const parsed = def.parse(json.value);
      if (!parsed.ok) return { index, tc, def, args: null, invalid: true, error: invalidArgsText(def, parsed.error) };
      return { index, tc, def, args: parsed.args, invalid: false, error: null };
    });
  }

  function invalidArgsText(def: ToolDefinition, error: string): string {
    return `Error: invalid arguments for ${def.name}: ${clip(error, 500)}\nExpected JSON matching this schema: ${clip(canonicalJson(def.parameters), 4_000)}`;
  }

  function toolItem(run: Run, step: number, p: PreparedCall, status: ToolStatus, output: ToolResult['preview'] | null, durationMs: number | null, at: number, inTx?: () => void): void {
    let title = p.tc.name;
    try {
      if (p.def && !p.invalid) title = p.def.title(p.args);
    } catch {
      /* the default title */
    }
    emitItem(
      run,
      { kind: 'tool', id: p.tc.id, turn: run.turn, step, toolCallId: p.tc.id, tool: clip(p.tc.name, 128), title: clip(title, 200), argsPreview: clip(p.tc.rawArgs, LOOP_LIMITS.argsPreviewChars), status, output, durationMs, at: iso(at) } as Omit<TimelineItem, 'seq'>,
      step,
      inTx,
    );
  }

  function permContext(run: Run): PermissionContext {
    const thread = store.threads.get(run.threadId);
    return { threadId: run.threadId, projectId: run.projectId, runId: run.runId, mode: thread?.settings.mode ?? CODE_DEFAULTS.mode, unattended: run.unattended, sandbox: deps.sandbox.state(), worktree: run.worktree };
  }

  async function askApproval(run: Run, step: number, p: PreparedCall, subject: ReturnType<ToolDefinition['subject']>, verdict: { risk: ApprovalRequest['risk']; suggestedRule: ApprovalRequest['suggestedRule'] }): Promise<ApprovalDecision> {
    const now = clock.now();
    const request: ApprovalRequest = {
      requestId: newId('apr', now),
      threadId: run.threadId,
      runId: run.runId,
      toolCallId: p.tc.id,
      kind: subject.kind,
      tool: subject.tool,
      title: clip(subject.title, 200),
      detail: approvalDetail(subject),
      risk: verdict.risk,
      suggestedRule: verdict.suggestedRule,
      allowedDecisions: [],
      createdAt: iso(now),
      expiresAt: iso(now + LOOP_LIMITS.approvalTtlMs),
    };
    toolItem(run, step, p, 'awaiting_approval', null, null, now);
    return waitForDecision(run, step, request, 'awaiting_approval');
  }

  /** Approval or question: pauses the active clock and reports the waiting status while pending. */
  async function waitForDecision(run: Run, step: number, request: ApprovalRequest, waiting: 'awaiting_approval' | 'awaiting_user'): Promise<ApprovalDecision> {
    store.approvals.insert({ requestId: request.requestId, threadId: run.threadId, runId: run.runId, toolCallId: request.toolCallId, kind: request.kind, request, decision: null, decidedAt: null });
    emitItem(run, { kind: 'approval', id: request.requestId, request, decision: null } as Omit<TimelineItem, 'seq'>, step);
    const statusRun = run.child && run.parent ? run.parent : run;
    statusRun.active.pause();
    if (run !== statusRun) run.active.pause();
    statusRun.pendingApprovals += 1;
    setStatus(statusRun, waiting);
    let decision: ApprovalDecision;
    try {
      decision = await link.approvals.request(request, run.controller.signal);
    } catch (error) {
      decision = { kind: 'cancel_run' };
      store.approvals.decide(request.requestId, decision, iso(clock.now()));
      emitItem(run, { kind: 'approval', id: request.requestId, request, decision } as Omit<TimelineItem, 'seq'>, step);
      throwIfAborted(run);
      throw error;
    } finally {
      statusRun.pendingApprovals -= 1;
      statusRun.active.resume();
      if (run !== statusRun) run.active.resume();
      if (statusRun.pendingApprovals === 0 && !statusRun.abortReason) setStatus(statusRun, 'running');
    }
    store.approvals.decide(request.requestId, decision, iso(clock.now()));
    emitItem(run, { kind: 'approval', id: request.requestId, request, decision } as Omit<TimelineItem, 'seq'>, step);
    return decision;
  }

  async function ensureCheckpoint(run: Run, step: number): Promise<void> {
    if (!run.record) return;
    if (store.checkpoints.list(run.threadId).some((c) => c.turn === run.turn)) return;
    try {
      const ckpt = await deps.git.checkpoint(run.record, run.turn);
      store.checkpoints.insert(ckpt);
      emitItem(run.parent ?? run, { kind: 'checkpoint', id: ckpt.id, checkpointId: ckpt.id, turn: run.turn, filesChanged: ckpt.filesChanged, at: ckpt.createdAt } as Omit<TimelineItem, 'seq'>, step);
    } catch (error) {
      const e = toGmiError(error);
      log.warn('checkpoint failed', { threadId: run.threadId, turn: run.turn, code: e.code });
      if (e.detail === 'git_tampered') notice(run, 'git_tampered', 'error', 'Git metadata of this thread changed unexpectedly; no checkpoint was taken.');
    }
  }

  function runContext(run: Run, step: number, p: PreparedCall, extra: { sensitiveWrites: boolean }): LoopToolContext {
    const thread = store.threads.get(run.threadId)!;
    let outChars = 0;
    let tail = '';
    let tailTimer: unknown = null;
    const flushTail = () => {
      tailTimer = null;
      if (!tail) return;
      deltas.push(run.threadId, p.tc.id, 'output', tail, Math.max(0, outChars - tail.length));
      tail = '';
    };
    return {
      threadId: run.threadId,
      projectId: run.projectId,
      contextId: run.contextId,
      runId: run.runId,
      turn: run.turn,
      step,
      call: p.tc,
      worktree: run.worktree,
      dataDir: deps.dataDir,
      settings: thread.settings,
      signal: run.controller.signal,
      store,
      sandbox: deps.sandbox,
      git: deps.git,
      lock: deps.lock,
      perm: deps.perm,
      clock,
      log: log.child('tool'),
      sensitiveWrites: extra.sensitiveWrites,
      askUser(question) {
        // Review H2: nobody can answer in an unattended run; never block it on a human.
        if (run.unattended) return Promise.resolve<ApprovalDecision>({ kind: 'deny', feedback: 'Unattended run: no one can answer. Use your best judgement.' });
        const now = clock.now();
        const request: ApprovalRequest = {
          requestId: newId('apr', now),
          threadId: run.threadId,
          runId: run.runId,
          toolCallId: p.tc.id,
          kind: 'question',
          tool: p.tc.name,
          title: clip(question.question, 200),
          detail: { question: clip(question.question, 4_000), ...(question.options ? { options: question.options.slice(0, 10).map((o) => clip(o, 200)) } : {}) },
          risk: [],
          suggestedRule: null,
          allowedDecisions: [],
          createdAt: iso(now),
          expiresAt: iso(now + LOOP_LIMITS.approvalTtlMs),
        };
        return waitForDecision(run, step, request, 'awaiting_user');
      },
      emitOutput(chunk: string) {
        if (run.child || !chunk) return;
        // §6.6: the first 32 KiB live, then a 1 Hz tail window of the last 4 KiB (offset = its absolute start).
        if (outChars < LOOP_LIMITS.liveOutputChars) {
          const live = chunk.slice(0, LOOP_LIMITS.liveOutputChars - outChars);
          deltas.push(run.threadId, p.tc.id, 'output', live, outChars);
          outChars += live.length;
          chunk = chunk.slice(live.length);
          if (!chunk) return;
        }
        outChars += chunk.length;
        tail = (tail + chunk).slice(-LOOP_LIMITS.tailOutputChars);
        if (tailTimer === null) tailTimer = clock.setTimeout(flushTail, LOOP_LIMITS.tailIntervalMs);
      },
    };
  }

  async function executeCall(run: Run, step: number, p: PreparedCall): Promise<CallOutcome> {
    const skip = (content: string, status: ToolCallStatus = 'not_executed', itemStatus: ToolStatus = 'interrupted', kind: ToolErrorKind = 'not_executed'): CallOutcome => ({ status, itemStatus, result: errorResult(kind, content), byUser: true, startedAt: null, finishedAt: clock.now() });
    if (run.abortReason) return skip(abortedText(run.abortReason, false));
    if (p.invalid || !p.def) return { status: 'failed', itemStatus: 'failed', result: errorResult('invalid_args', p.error ?? 'Error: invalid call.'), byUser: false, startedAt: null, finishedAt: clock.now() };
    const def = p.def;
    let subject: ReturnType<ToolDefinition['subject']>;
    let sensitiveWrites = false;
    const ctx0 = runContext(run, step, p, { sensitiveWrites });
    try {
      subject = def.subject(p.args, ctx0);
    } catch (error) {
      return { status: 'failed', itemStatus: 'failed', result: errorResult('invalid_args', `Error: ${clip(toGmiError(error).message, 500)}`), byUser: false, startedAt: null, finishedAt: clock.now() };
    }
    const pctx = permContext(run);
    const verdict = deps.perm.evaluate(subject, pctx);
    if (verdict.effect === 'deny') {
      return { status: 'denied', itemStatus: 'denied', result: errorResult('denied', `Denied: ${verdict.reason}`), byUser: verdict.via !== 'hard' && verdict.via !== 'rule', startedAt: null, finishedAt: clock.now() };
    }
    if (verdict.effect === 'ask') {
      if (run.unattended) return { status: 'denied', itemStatus: 'denied', result: errorResult('denied', 'Denied: this run is unattended and the call needs approval.'), byUser: true, startedAt: null, finishedAt: clock.now() };
      const decision = await askApproval(run, step, p, subject, { risk: verdict.risk, suggestedRule: verdict.suggestedRule });
      switch (decision.kind) {
        case 'allow_once':
          sensitiveWrites = decision.sensitiveWrites === true;
          break;
        case 'allow_thread':
        case 'allow_always':
          try {
            deps.perm.record(
              { requestId: '', threadId: run.threadId, runId: run.runId, toolCallId: p.tc.id, kind: subject.kind, tool: subject.tool, title: subject.title, detail: {}, risk: verdict.risk, suggestedRule: verdict.suggestedRule, allowedDecisions: [], createdAt: iso(clock.now()), expiresAt: null },
              decision,
              pctx,
            );
          } catch (error) {
            log.warn('rule record failed', { code: toGmiError(error).code });
          }
          break;
        case 'cancel_run':
          abort(run.parent ?? run, 'user');
          abort(run, run.parent ? 'parent' : 'user');
          return skip(SYNTHETIC.cancelled, 'denied', 'denied', 'cancelled');
        case 'deny':
        case 'answer': {
          const feedback = decision.kind === 'deny' ? decision.feedback : decision.text;
          return skip(feedback?.trim() ? `Denied by the user: ${clip(feedback.trim(), 2_000)}` : 'Denied by the user.', 'denied', 'denied', 'denied');
        }
      }
    }
    if (run.abortReason) return skip(abortedText(run.abortReason, false));
    let release: (() => void) | null = null;
    let mutates: boolean;
    try {
      mutates = def.mutates(p.args);
    } catch (error) {
      return { status: 'failed', itemStatus: 'failed', result: errorResult('invalid_args', `Error: ${clip(toGmiError(error).message, 500)}`), byUser: false, startedAt: null, finishedAt: clock.now() };
    }
    if (mutates) {
      await ensureCheckpoint(run, step);
      try {
        release = await deps.lock.acquire(run.threadId, run.controller.signal);
      } catch {
        return skip(abortedText(run.abortReason ?? 'user', false));
      }
    }
    // Invariant 2: `tool.started` (with arguments) is committed before any side effect.
    // The row (with its arguments, stored with the assistant message) gets `started_at` in the same transaction as
    // the public `running` item.
    const startedAt = clock.now();
    toolItem(run, step, p, 'running', null, null, startedAt, () => store.toolCalls.update(p.tc.id, { startedAt: iso(startedAt) }));
    const ctx = runContext(run, step, p, { sensitiveWrites });
    let promise: Promise<ToolResult>;
    try {
      promise = Promise.resolve(def.run(p.args, ctx));
    } catch (error) {
      promise = Promise.reject(error);
    }
    // The lock is released when the tool really finishes, even if the run stopped waiting for it.
    if (release) {
      const rel = release;
      promise.then(rel, rel);
    }
    try {
      const raced = await raceAbort(promise, run.controller.signal);
      if (raced.aborted) {
        promise.catch(() => undefined);
        return { status: 'interrupted', itemStatus: 'interrupted', result: errorResult('cancelled', abortedText(run.abortReason ?? 'user', true)), byUser: true, startedAt, finishedAt: clock.now() };
      }
      const r = raced.value;
      const status: ToolCallStatus = r.ok ? 'succeeded' : 'failed';
      return { status, itemStatus: r.ok ? 'succeeded' : 'failed', result: r, byUser: false, startedAt, finishedAt: clock.now() };
    } catch (error) {
      if (run.abortReason) return { status: 'interrupted', itemStatus: 'interrupted', result: errorResult('cancelled', abortedText(run.abortReason, true)), byUser: true, startedAt, finishedAt: clock.now() };
      const e = toGmiError(error);
      const kind: ToolErrorKind = e.code === 'timeout' ? 'timeout' : e.code === 'permission_denied' ? 'denied' : 'execution';
      return { status: 'failed', itemStatus: 'failed', result: errorResult(kind, `Error: ${clip(e.message, 2_000)}`), byUser: false, startedAt, finishedAt: clock.now() };
    }
  }

  function abortedText(reason: AbortReason, running: boolean): string {
    switch (reason) {
      case 'time_cap':
        return running ? SYNTHETIC.timeCapRunning : SYNTHETIC.timeCap;
      case 'shutdown':
        return SYNTHETIC.shutdown;
      default:
        return SYNTHETIC.cancelled;
    }
  }

  /** Appends every result in call order, settles the rows, and logs `tool.finished` — one transaction (§6.1). */
  function commitResults(run: Run, step: number, prepared: PreparedCall[], outcomes: CallOutcome[]): void {
    const contents = capStepResults(
      outcomes.map((o) => o.result.content),
      CAP_LIMITS.stepOutputTokens,
    );
    store.transaction(() => {
      prepared.forEach((p, i) => {
        const o = outcomes[i]!;
        // Review H2: the step cap cut this result, so the lines the read recorded are not all in context: forget that
        // range, or a narrowed re-read would answer "unchanged" for lines the model never saw.
        const range = o.result.effects?.readRange;
        if (range && contents[i] !== o.result.content) {
          const row = store.reads.get(run.contextId, range.key);
          if (row) store.reads.put({ ...row, ranges: subtractRange(row.ranges, [range.start, range.end]) });
        }
        const msg = appendMessage(run, { role: 'tool', content: contents[i]!, turn: run.turn, toolCallId: p.tc.wireId });
        const spill = o.result.spillId ? paths.spillFile(run.threadId, p.tc.id) : null;
        store.toolCalls.update(p.tc.id, { status: o.status, resultMessageId: msg.id, exitCode: o.result.exitCode ?? null, spillPath: spill, finishedAt: iso(o.finishedAt) });
      });
    });
    prepared.forEach((p, i) => {
      const o = outcomes[i]!;
      toolItem(run, step, p, o.itemStatus, { ...o.result.preview, ...(o.result.exitCode !== undefined ? { exitCode: o.result.exitCode } : {}) }, o.startedAt === null ? null : o.finishedAt - o.startedAt, o.finishedAt);
      run.log.toolCalls += 1;
      if (!o.result.ok) run.log.failedCalls += 1;
      for (const path of o.result.effects?.changedPaths ?? []) run.log.changedPaths.add(path);
      if (o.result.effects?.command) run.log.commands.push(o.result.effects.command);
      const sensitive = o.result.effects?.sensitiveChanged ?? [];
      if (sensitive.length > 0) notice(run.parent ?? run, 'execution_sensitive', 'warning', `A command changed execution-sensitive files: ${clip(sensitive.slice(0, 10).join(', '), 2_000)}. Review them before merging.`);
    });
  }

  async function runTools(run: Run, step: number, infos: ToolCallInfo[]): Promise<{ prepared: PreparedCall[]; outcomes: CallOutcome[]; invalid: number }> {
    const prepared = prepareCalls(run, infos);
    const invalid = prepared.filter((p) => p.invalid).length;
    const outcomes: CallOutcome[] = new Array(prepared.length);
    if (invalid > CAP_LIMITS.invalidCallsPerStep) {
      // §6.2 step 5: at most 2 invalid calls per step, then model_error. Nothing in this step runs.
      prepared.forEach((p, i) => {
        outcomes[i] = p.invalid
          ? { status: 'failed', itemStatus: 'failed', result: errorResult('invalid_args', p.error ?? 'Error: invalid call.'), byUser: false, startedAt: null, finishedAt: clock.now() }
          : { status: 'not_executed', itemStatus: 'interrupted', result: errorResult('not_executed', SYNTHETIC.invalidBudget), byUser: true, startedAt: null, finishedAt: clock.now() };
      });
      commitResults(run, step, prepared, outcomes);
      return { prepared, outcomes, invalid };
    }
    const plan = planBatches(
      prepared.map((p) => {
        let readOnly = false;
        try {
          readOnly = !!p.def && !p.invalid && p.def.readOnly(p.args) && !p.def.mutates(p.args);
        } catch {
          readOnly = false;
        }
        return { index: p.index, parallel: isParallelEligible({ known: !!p.def, parsed: !p.invalid, readOnly, toolClass: p.def?.class ?? null }) };
      }),
    );
    let fatal: unknown = null;
    const { results, notStarted } = await runBatches(
      plan,
      async (i) => {
        try {
          return await executeCall(run, step, prepared[i]!);
        } catch (error) {
          if (!(error instanceof RunAborted)) fatal ??= error;
          return { status: 'interrupted', itemStatus: 'interrupted', result: errorResult('cancelled', abortedText(run.abortReason ?? 'user', false)), byUser: true, startedAt: null, finishedAt: clock.now() } satisfies CallOutcome;
        }
      },
      () => run.abortReason !== null || fatal !== null,
    );
    for (const [i, o] of results) outcomes[i] = o;
    for (const i of notStarted) {
      outcomes[i] = { status: 'not_executed', itemStatus: 'interrupted', result: errorResult('not_executed', run.abortReason ? abortedText(run.abortReason, false) : SYNTHETIC.runStopped), byUser: true, startedAt: null, finishedAt: clock.now() };
    }
    commitResults(run, step, prepared, outcomes);
    if (fatal) throw fatal;
    return { prepared, outcomes, invalid };
  }

  /** Synthetic results for calls that will not run (step cap, a second length in arguments …). */
  function settleNotRun(run: Run, step: number, infos: ToolCallInfo[], content: string): void {
    if (infos.length === 0) return;
    const prepared = prepareCalls(run, infos);
    commitResults(
      run,
      step,
      prepared,
      prepared.map(() => ({ status: 'not_executed', itemStatus: 'interrupted', result: errorResult('not_executed', content), byUser: true, startedAt: null, finishedAt: clock.now() })),
    );
  }

  // ── One step ──

  function gwRequest(run: Run, step: number, ctx: BuiltContext, over: Partial<GatewayRequest> = {}): GatewayRequest {
    const settings = store.threads.get(run.threadId)?.settings;
    const req: GatewayRequest = {
      requestId: newId('req', clock.now()),
      purpose: run.purpose,
      priority: run.priority,
      scope: { threadId: run.threadId, turnId: turnIdOf(run.threadId, run.turn), runId: scopeRunId(run), step },
      target: { model: run.model },
      messages: ctx.messages,
      maxOutputTokens: settings?.maxOutputTokens ?? CODE_DEFAULTS.maxOutputTokens,
      prefixHash: run.prefix.hash,
      ...(settings?.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
      ...over,
    };
    if (run.frozenTools.length > 0 && !('tools' in over)) req.tools = run.frozenTools;
    return req;
  }

  /** Appends queued notes, steering and the doom hint as ONE user message after the step's results (§6.5). */
  function appendAfterStep(run: Run, extra: string[] = []): boolean {
    const steer = run.child ? null : steering.drain(run.threadId);
    const notes = [...run.pendingNotes, ...extra];
    run.pendingNotes = [];
    if (!steer && notes.length === 0) return false;
    const content = [...(steer ? [steer.text] : []), ...notes].join('\n\n');
    const msg = appendMessage(run, { role: 'user', content, turn: run.turn, steering: !!steer });
    if (steer) emitItem(run, { kind: 'user', id: msg.id, turn: run.turn, text: steer.text, steering: true, at: iso(clock.now()) } as Omit<TimelineItem, 'seq'>);
    return true;
  }

  function stopForError(run: Run, err: GmiErrorShape): StepEnd {
    switch (err.code) {
      case 'budget_exceeded':
        return { kind: 'stop', status: 'stopped', reason: 'budget', level: 'warning', text: `The app budget is reached. ${summaryFromLog(run.log)}` };
      case 'payment_required':
        return { kind: 'stop', status: 'stopped', reason: 'budget', level: 'warning', text: `GMI needs a payment or credit before more requests. ${summaryFromLog(run.log)}` };
      case 'limit_reached':
        return { kind: 'stop', status: 'stopped', reason: 'cost_cap', level: 'warning', text: `A thread or turn cost cap is reached. ${summaryFromLog(run.log)}` };
      case 'rate_limited':
        return { kind: 'stop', status: 'stopped', reason: 'rate_limited', level: 'warning', text: 'GMI kept rate-limiting this model. Continue when ready.' };
      case 'network':
        return { kind: 'stop', status: 'stopped', reason: 'offline', level: 'warning', text: 'Could not reach GMI. Continue when back online.' };
      default:
        if (FATAL_CODES.has(err.code)) return { kind: 'stop', status: 'failed', reason: 'model_error', level: 'error', text: clip(err.message, 500) };
        return { kind: 'stop', status: 'stopped', reason: 'model_error', level: 'warning', text: `${clip(err.message, 500)} Continue to retry.` };
    }
  }

  async function step(run: Run): Promise<StepEnd> {
    run.stepsDone += 1;
    const step = run.stepsDone;
    run.log.steps = step;
    let afterOutputs = 0;
    let overflowLevel = 0;
    let rejectedSize = 0;
    for (;;) {
      throwIfAborted(run);
      let ctx = buildContext(run);
      try {
        ctx = await maybeCompact(run, step, ctx);
      } catch (error) {
        throwIfAborted(run);
        const e = toGmiError(error);
        // Review H2: main refused the summary for money: stopped(cost_cap | budget), resumable, not failed.
        if (MONEY_STOP_CODES.has(e.code)) return stopForError(run, e.toShape());
        throw error;
      }
      throwIfAborted(run);
      sendMeter(run, { ceiling: ctx.ceiling, sizeTokens: ctx.sizeTokens, estimated: ctx.estimated, messageCount: ctx.messageCount, nextStepUsd: ctx.nextStepUsd });
      const req = gwRequest(run, step, ctx);
      const s = await stream(run, step, req);
      if (s.usage) recordUsage(run, step, s.usage, s.model, { estimatedPrompt: ctx.estimatedPrompt, uptoOrd: ctx.uptoOrd, compactions: ctx.compactions });
      sendMeter(run);
      if (s.aborted || run.abortReason) {
        // Cancelled mid-stream: keep what the user saw (text only; incomplete calls are never stored).
        if (s.text || s.reasoning) storeAssistant(run, step, s, [], 'stopped');
        throwIfAborted(run);
      }

      if (s.error) {
        const err = s.error.error;
        if (err.code === 'context_overflow') {
          // Layer 2 (§7.5): shrink to 85/70/50/35 % of the rejected size, one retry per level.
          if (rejectedSize === 0) rejectedSize = ctx.sizeTokens;
          const level = CAP_LIMITS.overflowLevels[overflowLevel];
          if (level === undefined) return { kind: 'stop', status: 'stopped', reason: 'overflow', level: 'error', text: "This task no longer fits the model's context. Start a new thread from this summary." };
          overflowLevel += 1;
          try {
            await compact(run, step, { reason: 'overflow', compactionModel: store.threads.get(run.threadId)?.settings.compactionModel ?? run.model, shrinkToTokens: Math.floor(level * rejectedSize) });
          } catch (error) {
            throwIfAborted(run);
            const e = toGmiError(error);
            if (MONEY_STOP_CODES.has(e.code)) return stopForError(run, e.toShape());
            log.warn('overflow compaction failed', { code: e.code, level });
            return { kind: 'stop', status: 'stopped', reason: 'overflow', level: 'error', text: "This task no longer fits the model's context. Start a new thread from this summary." };
          }
          continue;
        }
        if (s.error.afterOutput) {
          afterOutputs += 1;
          if (afterOutputs >= 2) {
            if (s.text && s.incompleteDeltas.length === 0) storeAssistant(run, step, s, [], 'error');
            return { kind: 'stop', status: 'stopped', reason: 'model_error', level: 'warning', text: 'The model stream was cut twice in a row. Continue to retry.' };
          }
          if (s.incompleteDeltas.length > 0 || !s.text) {
            // Incomplete tool-call deltas: discard the partial message (never stored) and re-issue the same step.
            if (s.itemShown) emitItem(run, { kind: 'assistant', id: s.itemId, turn: run.turn, step, text: s.text, reasoning: s.reasoning || null, model: s.model, usage: null, status: 'error', at: iso(clock.now()) } as Omit<TimelineItem, 'seq'>, step);
            continue;
          }
          // Partial text, no incomplete calls: keep it and ask for a continuation.
          storeAssistant(run, step, s, [], 'stopped');
          appendMessage(run, { role: 'user', content: PROMPTS.continuationCut, turn: run.turn });
          continue;
        }
        if (s.text || s.reasoning) storeAssistant(run, step, s, [], 'error');
        return stopForError(run, err);
      }

      // Finished.
      let calls = s.calls;
      let droppedTool: string | null = null;
      if (s.finish?.reason === 'length' && calls.length > 0) {
        const last = calls[calls.length - 1]!;
        if (!parseArgs(last.arguments).ok) {
          droppedTool = last.name;
          calls = calls.slice(0, -1);
        }
      }
      if (s.incompleteDeltas.length > 0 && !droppedTool) droppedTool = s.incompleteDeltas[0]!.name ?? 'a tool';

      if (s.finish?.reason === 'length' && calls.length === 0 && !droppedTool) {
        storeAssistant(run, step, s, [], 'stopped');
        run.lengthHits += 1;
        if (run.lengthHits >= 2) return { kind: 'stop', status: 'stopped', reason: 'output_limit', level: 'warning', text: 'The model hit its output limit twice. Raise the output limit or split the work.' };
        run.pendingNotes.unshift(PROMPTS.continuationLength);
        appendAfterStep(run);
        return { kind: 'continue' };
      }

      const { infos } = storeAssistant(run, step, s, calls, 'complete');
      if (droppedTool) {
        run.argsLengthHits += 1;
        if (run.argsLengthHits >= 2) {
          settleNotRun(run, step, infos, SYNTHETIC.runStopped);
          return { kind: 'stop', status: 'stopped', reason: 'output_limit', level: 'warning', text: 'The model hit its output limit while writing tool arguments twice. Raise the output limit or split the work.' };
        }
        run.pendingNotes.push(PROMPTS.lengthInArgs(droppedTool));
      }

      if (infos.length === 0) {
        if (appendAfterStep(run)) return { kind: 'continue' };
        return { kind: 'done' };
      }

      const { prepared, outcomes, invalid } = await runTools(run, step, infos);
      throwIfAborted(run);
      if (invalid > CAP_LIMITS.invalidCallsPerStep) {
        return { kind: 'stop', status: 'stopped', reason: 'model_error', level: 'error', text: `The model made ${invalid} invalid tool calls in one step. ${s.text ? `Last text: ${clip(s.text, 300)}` : ''}`.trim() };
      }

      // Doom check (§6.4) after the results are appended.
      const doomResults: DoomResult[] = outcomes.map((o) => ({ ok: o.result.ok, errorKind: o.result.errorKind, byUser: o.byUser, content: o.result.content, ...(o.result.effects ? { effects: o.result.effects } : {}) }));
      const action = run.doom.observe({ text: s.text, calls: prepared.map((p) => ({ name: p.tc.name, args: p.tc.rawArgs })), results: doomResults });
      const extra: string[] = [];
      if (action?.kind === 'hint') extra.push(PROMPTS.doomHint);
      if (action?.kind === 'ask') {
        appendAfterStep(run, extra);
        if (run.unattended || run.child) return { kind: 'stop', status: 'stopped', reason: 'doom_loop', level: 'warning', text: `${action.text} The run stopped.` };
        const answer = await askUser(run, step, action.signal, action.text);
        if (answer.kind === 'stop') return { kind: 'stop', status: 'stopped', reason: 'doom_loop', level: 'info', text: `${action.text} Stopped by the user.` };
        run.doom.reset(action.signal);
        if (answer.kind === 'hint') appendAfterStep(run, [answer.text]);
        return { kind: 'continue' };
      }
      appendAfterStep(run, extra);
      return { kind: 'continue' };
    }
  }

  /** `awaiting_user` for the doom-loop question: Continue / Stop / a hint (any other answer). */
  async function askUser(run: Run, step: number, signal: DoomSignal, text: string): Promise<{ kind: 'continue' } | { kind: 'stop' } | { kind: 'hint'; text: string }> {
    const now = clock.now();
    const request: ApprovalRequest = {
      requestId: newId('apr', now),
      threadId: run.threadId,
      runId: run.runId,
      toolCallId: null,
      kind: 'question',
      tool: 'doom_loop',
      title: clip(text, 200),
      detail: { question: `${text} Continue, stop, or give the agent a hint?`, options: ['Continue', 'Stop'] },
      risk: [],
      suggestedRule: null,
      allowedDecisions: [],
      createdAt: iso(now),
      expiresAt: iso(now + LOOP_LIMITS.approvalTtlMs),
    };
    log.info('doom loop', { threadId: run.threadId, step, signal });
    const decision = await waitForDecision(run, step, request, 'awaiting_user');
    switch (decision.kind) {
      case 'answer': {
        const t = decision.text.trim();
        if (/^stop$/i.test(t)) return { kind: 'stop' };
        if (!t || /^continue$/i.test(t)) return { kind: 'continue' };
        return { kind: 'hint', text: clip(t, 8_000) };
      }
      case 'allow_once':
      case 'allow_thread':
      case 'allow_always':
        return { kind: 'continue' };
      case 'cancel_run':
        abort(run, 'user');
        throw new RunAborted('user');
      default:
        return { kind: 'stop' };
    }
  }

  /** The step-cap answer (§6.3): one request with tool_choice "none" and 1,500 output tokens; calls get synthetic results. */
  async function stepCapSummary(run: Run): Promise<void> {
    run.pendingNotes.push(PROMPTS.maxSteps);
    appendAfterStep(run);
    const step = run.stepsDone + 1;
    const ctx = buildContext(run);
    const req = gwRequest(run, step, ctx, { toolChoice: 'none', maxOutputTokens: MAX_STEPS_OUTPUT_TOKENS });
    const s = await stream(run, step, req);
    if (s.usage) recordUsage(run, step, s.usage, s.model, { estimatedPrompt: ctx.estimatedPrompt, uptoOrd: ctx.uptoOrd, compactions: ctx.compactions });
    throwIfAborted(run);
    if (s.error && !s.text) return;
    const calls = s.finish?.reason === 'length' ? s.calls.filter((c) => parseArgs(c.arguments).ok) : s.calls;
    const { infos } = storeAssistant(run, step, s, s.error ? [] : calls, s.error ? 'error' : 'complete');
    settleNotRun(run, step, infos, SYNTHETIC.stepCap);
  }

  // ── Driving a run ──

  async function drive(run: Run): Promise<void> {
    let end: StepEnd | null = null;
    byContext.set(run.contextId, run);
    run.active.start();
    try {
      if (!run.child && run.record) {
        // Persist the baseline before any model/tool request. Never silently accept a previous unresolved change.
        for (const prior of store.refSnapshots.list().filter((r) => r.threadId === run.threadId)) {
          const snapshot = store.refSnapshots.get(prior.runId);
          if (snapshot && (await deps.git.compareRefs(run.record, snapshot.refs)).length) {
            throw new GmiError('permission_denied', 'Repository refs changed during an earlier run. Review and restore them before continuing.');
          }
          store.refSnapshots.delete(prior.runId);
        }
        store.refSnapshots.put(run.runId, run.threadId, await deps.git.refSnapshot(run.record));
      }
      for (;;) {
        throwIfAborted(run);
        const cap = checkCaps({ stepsDone: run.stepsDone, budget: run.budget, turnCostUsd: run.turnCostUsd, threadCostUsd: run.child ? 0 : threadSpend(run.threadId), activeExpired: run.active.isExpired() });
        if (cap) {
          if (cap.reason === 'time_cap') throw new RunAborted('time_cap');
          if (cap.reason === 'step_cap') {
            await stepCapSummary(run);
            end = { kind: 'stop', status: 'stopped', reason: 'step_cap', level: 'info', text: `${cap.text} Continue to keep going.` };
          } else end = { kind: 'stop', status: 'stopped', reason: 'cost_cap', level: 'warning', text: `${cap.text}\n${summaryFromLog(run.log)}` };
          break;
        }
        const r = await step(run);
        if (r.kind === 'continue') continue;
        end = r;
        break;
      }
    } catch (error) {
      if (error instanceof RunAborted || run.abortReason) {
        const reason = run.abortReason ?? (error as RunAborted).reason;
        settleUnsettledRun(run);
        if (reason === 'time_cap') end = { kind: 'stop', status: 'stopped', reason: 'time_cap', level: 'warning', text: `The turn reached its time limit (${Math.round(run.budget.maxActiveMs / 60_000)} min of active time). Continue to keep going.` };
        else if (reason === 'shutdown') end = { kind: 'stop', status: 'interrupted', reason: 'interrupted', level: 'info', text: 'The app closed during this run. Continue to resume it.' };
        else end = { kind: 'stop', status: 'cancelled', reason: 'interrupted', level: 'info', text: 'Stopped by the user.' };
      } else {
        const e = toGmiError(error);
        log.error('run failed', { threadId: run.threadId, runId: run.runId, code: e.code });
        try {
          settleUnsettledRun(run);
        } catch (inner) {
          log.error('settle after failure failed', { code: toGmiError(inner).code });
        }
        end = { kind: 'stop', status: 'failed', reason: 'model_error', level: 'error', text: `The run failed: ${clip(e.message, 300)}` };
      }
    } finally {
      run.active.stop();
      if (!run.child && run.record) {
        const snapshot = store.refSnapshots.get(run.runId);
        if (snapshot) {
          try {
            const changed = await deps.git.compareRefs(run.record, snapshot.refs);
            if (changed.length) {
              end = { kind: 'stop', status: 'stopped', reason: 'ref_changed', level: 'error', text: `Repository refs changed outside this thread: ${changed.slice(0, 8).map((r) => r.ref).join(', ')}. Review these changes before continuing.` };
            } else store.refSnapshots.delete(run.runId);
          } catch {
            end = { kind: 'stop', status: 'stopped', reason: 'ref_changed', level: 'error', text: 'Could not verify repository refs after this run. Review the repository before continuing.' };
          }
        }
      }
      if (byContext.get(run.contextId) === run) byContext.delete(run.contextId);
    }
    finish(run, end ?? { kind: 'done' });
  }

  function finish(run: Run, end: StepEnd): void {
    const status: RunStatus = end.kind === 'stop' ? end.status : 'completed';
    run.finalStatus = status;
    try {
      deltas.flush(run.threadId);
      if (!run.child) {
        if (end.kind === 'stop') {
          notice(run, end.reason, end.level, end.text);
        }
        log.info('run ended', { threadId: run.threadId, runId: run.runId, status, steps: run.stepsDone, costUsd: run.turnCostUsd });
        setStatus(run, status, end.kind === 'stop' ? end.reason : null);
        sendMeter(run);
      }
    } catch (error) {
      log.error('run finish failed', { code: toGmiError(error).code });
    } finally {
      let pending: { text: string } | null = null;
      if (!run.child) {
        // Review H2: steering that arrived too late for a step is never dropped (it had a receipt).
        pending = steering.drain(run.threadId);
        if (runs.get(run.threadId) === run) runs.delete(run.threadId);
        steering.clear(run.threadId);
        link.events.runEnded(run.threadId, run.runId);
      }
      if (pending) keepLateSteering(run, status, pending.text);
      if (!run.child) {
        try {
          deps.compactor.cancel(run.contextId);
        } catch {
          /* nothing precomputed */
        }
      }
      (run as { resolveDone?: () => void }).resolveDone?.();
    }
  }

  /**
   * Steering queued while the run ended: after a completed run it starts the next turn; otherwise it is stored as the
   * user's message (history and timeline) for Continue or the next turn, with a notice that it is not answered yet.
   */
  function keepLateSteering(run: Run, status: RunStatus, text: string): void {
    try {
      if (status === 'completed' && !shuttingDown) {
        defer(() => {
          send(run.threadId, text, { unattended: run.unattended }).catch((error: unknown) => {
            log.warn('follow-up turn failed', { code: toGmiError(error).code });
            storeLateSteering(run, text);
          });
        });
        return;
      }
      storeLateSteering(run, text);
    } catch (error) {
      log.warn('late steering not stored', { code: toGmiError(error).code });
    }
  }

  function storeLateSteering(run: Run, text: string): void {
    const at = clock.now();
    const msgId = newId('msg', at);
    emitItem(run, { kind: 'user', id: msgId, turn: run.turn, text, steering: true, at: iso(at) } as Omit<TimelineItem, 'seq'>, null, () => {
      appendMessage(run, { id: msgId, role: 'user', content: text, turn: run.turn, steering: true });
    });
    notice(run, 'interrupted', 'info', 'Your last message arrived as the run ended; it is not answered yet. Continue or send a message to go on.');
  }

  // ── Settling unpaired calls (cancel, crash recovery) ──

  /** Calls of this run's context stored without a result (an abort between storing and committing). */
  function settleUnsettledRun(run: Run): void {
    const reason = run.abortReason ?? 'user';
    settleContext(run.threadId, run.contextId, abortedText(reason, true), abortedText(reason, false), run);
  }

  function settleUnsettled(threadId: string, runningText: string, notRunText: string): void {
    const contexts = new Set(store.toolCalls.unsettled(threadId).map((t) => t.contextId));
    for (const contextId of contexts) settleContext(threadId, contextId, runningText, notRunText, null);
  }

  /**
   * Appends synthetic results, in call order, for every stored call of `contextId` that has no result message,
   * and marks its row interrupted / not_executed (§5.1 replay, §6.1 invariant 1).
   */
  function settleContext(threadId: string, contextId: string, runningText: string, notRunText: string, run: Run | null): void {
    const unsettled = store.toolCalls.unsettled(threadId).filter((t) => t.contextId === contextId);
    if (unsettled.length === 0) return;
    const byWire = new Map(unsettled.map((t) => [t.wireId, t]));
    const rows = store.messages.list(contextId);
    const answered = new Set(rows.filter((r) => r.role === 'tool' && r.toolCallId).map((r) => r.toolCallId!));
    const order: string[] = [];
    for (const r of rows) for (const c of r.toolCalls ?? []) if (byWire.has(c.id) && !answered.has(c.id)) order.push(c.id);
    const now = clock.now();
    store.transaction(() => {
      for (const wireId of order) {
        const t = byWire.get(wireId)!;
        const ran = t.startedAt !== null;
        const msg = store.messages.append({
          id: newId('msg', now),
          threadId,
          contextId,
          turn: t.turn,
          role: 'tool',
          content: ran ? runningText : notRunText,
          toolCalls: null,
          toolCallId: wireId,
          reasoning: null,
          reasoningFamily: null,
          model: null,
          inContext: true,
          pinned: false,
          partial: false,
          estTokens: null,
        });
        store.toolCalls.update(t.id, { status: ran ? 'interrupted' : 'not_executed', resultMessageId: msg.id, finishedAt: iso(now) });
      }
      // Rows whose result exists already (settled in a crash window): only the status.
      for (const t of unsettled) if (answered.has(t.wireId)) store.toolCalls.update(t.id, { status: 'interrupted', finishedAt: iso(now) });
    });
    if (contextId !== contextIdOf(threadId)) return;
    for (const wireId of order) {
      const t = byWire.get(wireId)!;
      const content = t.startedAt !== null ? runningText : notRunText;
      emitDurable(threadId, { contextId, runId: t.runId, turn: t.turn, step: t.step }, (seq) => ({
        type: 'item',
        item: { kind: 'tool', id: t.id, seq, turn: t.turn ?? 0, step: t.step ?? 0, toolCallId: t.id, tool: t.tool, title: t.tool, argsPreview: clip(t.args, LOOP_LIMITS.argsPreviewChars), status: 'interrupted', output: { text: content, truncated: false, totalBytes: Buffer.byteLength(content), spillId: null }, durationMs: null, at: iso(now) },
      }));
    }
    void run;
  }

  function threadsToRecover(): string[] {
    const ids = new Set<string>();
    for (const t of store.threads.list()) if (ACTIVE.has(t.status)) ids.add(t.id);
    for (const t of store.toolCalls.unsettled()) ids.add(t.threadId);
    return [...ids].filter((id) => !runs.has(id));
  }

  async function recoverThread(threadId: string): Promise<void> {
    if (runs.has(threadId)) return;
    const thread = store.threads.get(threadId);
    if (!thread) return;
    settleUnsettled(threadId, SYNTHETIC.restarted, SYNTHETIC.restartedNotRun);
    const at = iso(clock.now());
    for (const a of store.approvals.pending(threadId)) store.approvals.decide(a.requestId, { kind: 'cancel_run' }, at);
    steering.clear(threadId);
    if (ACTIVE.has(thread.status)) {
      // Runs never resume automatically (cost safety): the thread shows "Continue".
      emitDurable(threadId, { contextId: contextIdOf(threadId), runId: null, turn: null, step: null }, (seq) => ({
        type: 'item',
        item: { kind: 'notice', id: newId('ev', clock.now()), seq, level: 'warning', reason: 'interrupted', text: 'The runtime restarted during this run. Continue to resume it.', at },
      }));
      setThreadStatus(threadId, 'interrupted', 'interrupted');
    }
  }

  // ── Subagents (§8.6) ──

  async function runChild(input: ChildRunInput): Promise<ChildRunResult> {
    const parent = runs.get(input.threadId);
    if (!parent || parent.runId !== input.parentRunId) throw new GmiError('invalid_input', 'The parent run is not active.');
    const { thread, project } = loadThread(input.threadId);
    const tools = freezeTools(input.toolFilter);
    const prefix = buildPrefix({ tools, instructions: instructionsFromSnapshot(store, project), environment: environmentOf(thread, project) });
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const budget: ResolvedBudget = { maxSteps: Math.max(1, Math.min(input.maxSteps, parent.budget.maxSteps)), maxActiveMs: parent.budget.maxActiveMs, perTurnUsd: input.maxUsd, perThreadUsd: null };
    const child: Run = {
      ...parent,
      contextId: input.contextId,
      runId: input.contextId,
      child: true,
      parent,
      purpose: 'subagent',
      priority: 'background',
      model: input.model,
      controller: new AbortController(),
      abortReason: null,
      status: 'running',
      stepsDone: 0,
      budget,
      active: null as unknown as ActiveClock,
      doom: new DoomDetector(),
      log: emptyRunLog(),
      turnCostUsd: 0,
      lengthHits: 0,
      argsLengthHits: 0,
      prefix,
      frozenTools: tools,
      frozenNames: new Set(tools.map((t) => t.name)),
      pendingApprovals: 0,
      pendingNotes: [],
      queue: { position: null, reason: null },
      cacheLowNoticed: false,
      lastPromptTokens: null,
      done,
      finalStatus: null,
      lastText: '',
    };
    (child as { resolveDone?: () => void }).resolveDone = resolveDone;
    child.active = new ActiveClock(clock, budget.maxActiveMs, () => abort(child, 'time_cap'));
    const onParentAbort = () => abort(child, 'parent');
    parent.controller.signal.addEventListener('abort', onParentAbort, { once: true });
    input.signal.addEventListener('abort', onParentAbort, { once: true });
    if (input.signal.aborted || parent.abortReason) abort(child, 'parent');
    appendMessage(child, { role: 'user', content: input.prompt, turn: child.turn });
    const publishChild = (status: RunStatus, summary: string | null, costUsd: number | null) => {
      if (input.toolCallId) emitItem(parent, { kind: 'subagent', id: input.contextId, toolCallId: input.toolCallId, agent: 'task', model: input.model, status, summary, costUsd } as Omit<TimelineItem, 'seq'>);
    };
    publishChild('running', null, null);
    try {
      await drive(child);
    } finally {
      publishChild(child.finalStatus ?? 'failed', child.lastText.slice(0, 2_000), child.turnCostUsd);
      parent.controller.signal.removeEventListener('abort', onParentAbort);
      input.signal.removeEventListener('abort', onParentAbort);
    }
    return { status: child.finalStatus ?? 'failed', text: child.lastText, steps: child.stepsDone, costUsd: child.turnCostUsd };
  }

  // ── Lifecycle ──

  return {
    send,
    steer,
    interrupt,
    resume,
    recoverThread,
    threadsToRecover,
    runChild,
    active(threadId) {
      const run = runs.get(threadId);
      return run ? { runId: run.runId, turn: run.turn, status: run.status } : null;
    },
    compactionContext(req) {
      const run = byContext.get(req.contextId);
      if (!run || run.threadId !== req.threadId) return null;
      const ctx = buildContext(run);
      const k = calibration.get(run.threadId, run.model);
      return {
        ceiling: ctx.ceiling,
        prefixTokens: Math.ceil(k * run.prefix.tokens),
        k,
        prefix:
          req.model === run.model
            ? { messages: [run.prefix.system, run.prefix.user0], tools: run.frozenTools, prefixHash: run.prefix.hash, toWire: (rows) => toWire(rows).map((h) => h.msg) }
            : null,
      };
    },
    forwardStored(event) {
      if (event.type !== 'item' && event.type !== 'status' && event.type !== 'todo' && event.type !== 'diff') return;
      deltas.flush(event.threadId);
      link.events.event({ ...(event.payload as object), threadId: event.threadId, seq: event.seq } as CodeThreadEvent);
    },
    async idle(threadId) {
      const run = runs.get(threadId);
      if (run) await run.done;
    },
    creditCost(threadId, contextId, usd) {
      if (!(usd > 0) || !Number.isFinite(usd)) return;
      const run = (contextId ? byContext.get(contextId) : undefined) ?? runs.get(threadId);
      if (run && run.threadId === threadId) {
        addCost(run, usd, null);
        return;
      }
      const thread = store.threads.get(threadId);
      if (!thread) return;
      store.threads.update(threadId, { costUsd: thread.costUsd + usd });
      publishSummary(threadId);
    },
    async shutdown(graceMs) {
      shuttingDown = true;
      const all = [...runs.values()];
      for (const run of all) abort(run, 'shutdown');
      let timer: unknown = null;
      await Promise.race([
        Promise.all(all.map((r) => r.done)),
        new Promise<void>((resolve) => {
          timer = clock.setTimeout(resolve, graceMs);
        }),
      ]);
      if (timer !== null) clock.clearTimeout(timer);
      for (const t of meterTimers.values()) clock.clearTimeout(t);
      meterTimers.clear();
    },
  };
}

/** Pretty JSON / diff limits of the approval card (§9.4). */
function approvalDetail(subject: { command?: string; cwd?: string; paths?: string[]; diff?: string; url?: string; host?: string; server?: string; args?: unknown; costUsd?: number | null }): ApprovalRequest['detail'] {
  const d: ApprovalRequest['detail'] = {};
  // Every field within main's approval schema (review H2: an over-long diff or args made main drop the request).
  if (subject.command !== undefined) d.command = clip(subject.command, 2_048);
  if (subject.cwd !== undefined) d.cwd = clip(subject.cwd, 4_096);
  if (subject.paths) d.paths = subject.paths.slice(0, 20).map((p) => clip(p, 4_096));
  if (subject.diff !== undefined) {
    const lines = subject.diff
      .split('\n')
      .slice(0, LOOP_LIMITS.approvalDiffLines)
      .map((l) => (l.length > 1_000 ? `${l.slice(0, 1_000)} …` : l));
    d.diff = clip(lines.join('\n'), 64 * 1024);
  }
  if (subject.url !== undefined) d.url = clip(subject.url, 8_192);
  if (subject.host !== undefined) d.host = clip(subject.host, 1_024);
  if (subject.server !== undefined) d.server = clip(subject.server, 256);
  if (subject.args !== undefined) {
    let text: string;
    try {
      text = JSON.stringify(subject.args, null, 2) ?? '';
    } catch {
      text = String(subject.args);
    }
    d.args = clip(text, LOOP_LIMITS.approvalArgsChars);
  }
  if (subject.costUsd !== undefined) d.costUsd = subject.costUsd;
  return d;
}
