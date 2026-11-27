/**
 * Internal interfaces of the GMI gateway (harness.md §4, §24 H1-0). Frozen for H1: H1-A (gateway core: index,
 * gateway, capabilities, messages, body-*, parsers, mock) and H1-B (money + flow: meter, estimate, reservations,
 * threads, scheduler, retry, breaker, connectivity, trace, status) build against these in parallel. The public
 * surface is `GmiGateway` in core/services.ts and the shared contract in @shared/contracts/gateway.
 *
 * Changes after H1-0 are additive only, applied by the H1 integrator (never by two slices).
 *
 * Who calls whom (all synchronous unless the signature says Promise):
 *
 *   gateway.ts (H1-A)                                        H1-B
 *   stream(req, signal, owner)
 *     validate ─ RunRegistry.validateRequest (host port) / size caps (GATEWAY_LIMITS)
 *     resolve  ─ ModelResolver.resolve (H1-A, sync over a cached catalog)
 *     estimate ─────────────────────────────────────────────► Estimator.estimate
 *     precheck ─────────────────────────────────────────────► Reservations.precheck (actual spend only)
 *     queue    ─────────────────────────────────────────────► Scheduler.enqueue(ticket{reserve → Reservations.tryReserve})
 *     send     ─ Estimator.commit, body-*, fetch, parsers, RetryPolicy.watchdogs
 *     failure  ─────────────────────────────────────────────► RetryPolicy.decide → slot.requeue / retry / fail
 *                                                               ConnectivityGate.report*, Breaker.record
 *     settle (finally) ─────────────────────────────────────► Meter.charge (→ ThreadLedger.add) → slot.release
 *                                                               (→ Reservation.release) → Estimator.observe
 *                                                               → GatewayTrace.record → GatewayStatusTracker.changed
 */
import type { GatewayEvent, GatewayPriority, GatewayPurpose, GatewayRequest, GatewayScope, GatewayStatus, GwMessage, GwToolDef } from '@shared/contracts/gateway';
import type { GmiErrorShape } from '@shared/contracts/errors';
import type { LlmPricing } from '@shared/contracts/catalog';
import type { TokenUsage } from '@shared/contracts/chat';
import type { RouterMode } from '@shared/contracts/app';
import type { QueueReason } from '@shared/contracts/code';
import type { AppContext } from '../../core/context';
import type { BudgetGuard, CatalogService, GmiGateway, KeyProvider, SpendSource, ThreadCaps } from '../../core/services';

// ─── Constants both halves must agree on (harness.md §4.4–4.6, §21) ─────────────────────────────────────────────

/** Purposes a harness host may send (§4.4). `probe`/`eval` are main's Diagnostics only; `chat` is the chat slice's. */
export const HOST_PURPOSES = ['agent', 'subagent', 'compaction', 'title', 'commit_message'] as const satisfies readonly GatewayPurpose[];
export type HostPurpose = (typeof HOST_PURPOSES)[number];

/** Purposes whose spend is per thread (ThreadLedger) and always reserved (§4.3, §4.4). Same set as HOST_PURPOSES. */
export const AGENT_PURPOSES: readonly GatewayPurpose[] = HOST_PURPOSES;

/** Purposes only main may originate (never accepted with an `owner`). */
export const MAIN_PURPOSES = ['chat', 'probe', 'eval'] as const satisfies readonly GatewayPurpose[];

/** Higher admits first (§4.5). A host request may be at most `foreground`. */
export const PRIORITY_RANK: Readonly<Record<GatewayPriority, number>> = { interactive: 3, foreground: 2, background: 1, idle: 0 };

/** The highest priority a host request may carry (§4.4). */
export const MAX_HOST_PRIORITY: GatewayPriority = 'foreground';

/**
 * `GmiErrorShape.detail` of the chat fast-fail while a model's breaker is open (§4.6): chat (H1-C) shows
 * "Try anyway" for exactly this detail.
 */
export const BREAKER_OPEN_DETAIL = 'breaker_open';

/** The numbers of §4.4–4.6 and §21 in one place (k = 1,000 tokens, as in CODE_DEFAULTS). */
export const GATEWAY_LIMITS = {
  /** Main's size caps on a request; refusals are `context_overflow` (§4.6, §13.3). */
  maxMessages: 2_048,
  maxBodyBytes: 4 * 1024 * 1024,
  maxTools: 128,
  /** Output cap for a model whose limit is unknown (until probe H-P4, §4.2). */
  unknownMaxOutputTokens: 32_768,
  concurrency: {
    global: 16,
    perModel: 6,
    /** Per thread: 1 main-loop request (purpose agent), 2 subagents, 1 compaction (§4.5). */
    perThread: { agent: 1, subagent: 2, compaction: 1 } as Readonly<Partial<Record<GatewayPurpose, number>>>,
  },
  tpm: {
    windowMs: 60_000,
    /** AIMD on 429: effective = max(floor·limit, decrease·effective); +increase·limit per quiet window. */
    aimdFloor: 0.25,
    aimdDecrease: 0.7,
    aimdIncrease: 0.05,
    aimdQuietMs: 60_000,
  },
  /** +1 priority class per this wait, up to foreground (§4.5). */
  agingStepMs: 30_000,
  /** Head-of-line: after this wait the head request is admitted anyway, with a warning (§4.5). */
  headOfLineMaxWaitMs: 120_000,
  retry: {
    /** Full jitter: random(0, min(cap, base · factor^n)). */
    backoffBaseMs: 1_000,
    backoffFactor: 2,
    backoffCapMs: 20_000,
    /** Maybe-billed failures: at most this many retries, none above `maybeBilledMaxPromptTokens` (§4.6). */
    maybeBilledRetries: 1,
    maybeBilledMaxPromptTokens: 32_000,
    /** Continuous 429s before `rate_limited`: 10 min, 60 s for the interactive class (chat). */
    rateLimitGiveUpMs: 600_000,
    rateLimitGiveUpInteractiveMs: 60_000,
  },
  watchdog: {
    /** First byte: base + perTenKPromptMs per 10k prompt tokens (prefill of a large prompt is slow). */
    firstByteBaseMs: 90_000,
    firstBytePerTenKPromptMs: 1_000,
    idleMs: 120_000,
    totalMs: 900_000,
  },
  breaker: {
    /** 5xx / first-byte timeouts within the window that open the breaker. */
    failures: 5,
    windowMs: 60_000,
    openMs: 30_000,
    /** Each failed half-open probe doubles the open time, up to this. */
    maxOpenMs: 300_000,
  },
  /** Unflushed agent spend becomes a ledger row at this amount or age, or when the turn settles (§4.3). */
  agentFlushUsd: 0.1,
  agentFlushMs: 60_000,
  /** Display estimate: the previous request counts as cached only within this TTL (until H-P2, §4.4). */
  cacheTtlMs: 300_000,
  /** Calibration factor k = measured / estimated prompt tokens: EMA α, clamped (§7.2). */
  calibrationAlpha: 0.3,
  calibrationMin: 0.5,
  calibrationMax: 2.5,
  /** Purpose `probe`: reservation cap (§4.4). */
  probeReserveCapUsd: 0.05,
  /** Per-request trace ring (§4.3). */
  traceRing: 1_000,
  /** `gw.events` batching per request (§4.1). */
  eventBatchMinMs: 16,
  eventBatchMaxMs: 40,
  /** `code:gateway` status events at most this often. */
  statusMinIntervalMs: 1_000,
} as const;

// ─── Time ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Injected everywhere a module needs time, so tests drive a fake clock (no real timers in unit tests). */
export interface GatewayClock {
  /** Milliseconds since the epoch (like Date.now()). */
  now(): number;
  setTimeout(fn: () => void, ms: number): GatewayTimer;
  clearTimeout(timer: GatewayTimer): void;
  /** [0, 1): backoff jitter. */
  random(): number;
}
/** Opaque timer handle (a Node Timeout in production, anything a fake clock likes in tests). */
export type GatewayTimer = unknown;

// ─── Model resolution (H1-A: capabilities.ts) ─────────────────────────────────────────────────────────────────

/** Per-model behaviour (§4.2 table). Local table by id pattern, overridden by probes and catalog data. */
export interface ModelCapabilities {
  api: 'chat' | 'responses';
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  maxOutputTokens: number;
  tools: boolean;
  parallelToolCalls: boolean;
  toolChoiceRequired: boolean;
  strictTools: boolean;
  reasoningReplay: 'tool_loop' | 'always' | 'never' | 'empty';
  /** Send `context_length_exceeded_behavior: "error"`; false = stripped and `truncationRisk` (§4.2). */
  ctxExceededParam: boolean;
  includeUsage: boolean;
  cacheKeyParam: 'prompt_cache_key' | 'user' | null;
  developerRole: boolean;
  /** Whether `temperature` / `reasoning_effort` may be sent (unknown parameters answer 400). */
  temperature: boolean;
  reasoningEffort: boolean;
}

/** A request target resolved against the catalog and the capability table. */
export interface ResolvedModel {
  /** Model id sent upstream; null for GMI Router (the routed model arrives in the stream). */
  model: string | null;
  router: RouterMode | null;
  api: 'chat' | 'responses' | 'router';
  /** Key for the scheduler (head-of-line, per-model concurrency), breaker, calibration and prefix cache. */
  modelKey: string;
  /** List prices (null: unknown, e.g. the router before routing). */
  pricing: LlmPricing | null;
  discount: number | null;
  contextLength: number | null;
  /** Null for the router. */
  capabilities: ModelCapabilities | null;
  /** min(req.maxOutputTokens, capabilities.maxOutputTokens); the request's own value for the router. */
  maxOutputTokens: number;
  /** The family rejects `context_length_exceeded_behavior` (the harness compacts at 70 %). */
  truncationRisk: boolean;
}

/**
 * Synchronous model lookup (GmiGateway.estimate and admission are synchronous), over a catalog snapshot the
 * implementation keeps fresh. `routerModelKey(mode)` = `router:<mode>`.
 */
export interface ModelResolver {
  /** Null: unknown model (the gateway then refuses with invalid_input). */
  resolve(target: GatewayRequest['target'], maxOutputTokens: number, opts?: { purpose?: GatewayPurpose }): ResolvedModel | null;
  /** The routed model's prices once the router names it (null: unknown). */
  resolveRouted(modelId: string): Pick<ResolvedModel, 'pricing' | 'discount'> | null;
  /** Reload the snapshot from CatalogService (also done in the background by the implementation). */
  refresh(): Promise<void>;
}

/** The router's scheduler/breaker key. */
export function routerModelKey(mode: RouterMode): string {
  return `router:${mode}`;
}

// ─── Estimator (H1-B: estimate.ts) ────────────────────────────────────────────────────────────────────────────

/** What the estimator needs; built by the gateway core from the request and the resolved model. */
export interface EstimateInput {
  scope: GatewayScope;
  resolved: Pick<ResolvedModel, 'modelKey' | 'pricing' | 'discount' | 'maxOutputTokens'>;
  messages: readonly GwMessage[];
  tools?: readonly GwToolDef[] | null;
  /** Purpose `probe` caps the reservation at GATEWAY_LIMITS.probeReserveCapUsd. */
  purpose: GatewayPurpose;
}

/**
 * The cumulative per-unit hash chain of a request (tools first, then one unit per message, canonically
 * serialised): `hashes[i]` covers units 0..i, `tokens[i]` their estimated tokens. Two requests share a cached
 * prefix up to the last equal hash.
 */
export interface PrefixFingerprint {
  readonly hashes: readonly string[];
  readonly tokens: readonly number[];
}

/** Main's own estimate (§4.4); the protocol carries no host-supplied counts. */
export interface GatewayEstimate {
  /** P: calibrated estimate of the prompt (messages + tools). */
  promptTokens: number;
  /** maxOut after the capability clamp. */
  maxOutputTokens: number;
  /** C: tokens of the common prefix with the previous request of the same (thread, model) within the TTL; 0 ≤ C ≤ P. */
  expectedCachedTokens: number;
  /** Worst case: (P × in + maxOut × out) × (1 − discount) at the tier P selects, cached counted as 0. Null: unpriced. */
  reserveUsd: number | null;
  /** Display estimate at the expected cache share C. Null: unpriced. */
  expectedUsd: number | null;
  /** P + maxOut: debited from the TPM window at admission. */
  tpmTokens: number;
  /** Pass to Estimator.commit() once the request is actually sent. */
  prefix: PrefixFingerprint;
}

export interface Estimator {
  /** Pure: no state changes (GmiGateway.estimate calls it for display). */
  estimate(input: EstimateInput): GatewayEstimate;
  /** Uncalibrated tokens of a text (the chat slice's estimateTokens rule: 4 ASCII chars ≈ 1 token, others 1). */
  textTokens(text: string): number;
  /** Remembers a sent request as "previous" for the display estimate of the next one with the same (thread, modelKey). */
  commit(scope: GatewayScope, modelKey: string, prefix: PrefixFingerprint, at: number): void;
  /** Learns the calibration factor for (thread, modelKey) from a measured prompt (EMA, clamped). */
  observe(scope: GatewayScope, modelKey: string, estimatedPromptTokens: number, measuredPromptTokens: number): void;
}

// ─── Meter (H1-B: meter.ts) ───────────────────────────────────────────────────────────────────────────────────

/** The `usage` GatewayEvent without its tag. */
export type MeteredUsage = Omit<Extract<GatewayEvent, { type: 'usage' }>, 'type'>;

/** One attempt's outcome, as the gateway core saw it. */
export interface MeterInput {
  requestId: string;
  purpose: GatewayPurpose;
  scope: GatewayScope;
  /** The model actually billed (the routed one for the router); null when unknown. */
  model: string | null;
  pricing: LlmPricing | null;
  discount: number | null;
  estimate: GatewayEstimate;
  /** Measured usage from the stream, or null. */
  usage: TokenUsage | null;
  cacheWriteTokens: number | null;
  /** GMI answered 2xx (headers): the prompt is charged even without a token (§4.3). */
  responded: boolean;
  /** 500/502/504/524, first-byte timeout, reset after the body was sent (§4.6): estimated prompt charge. */
  maybeBilled: boolean;
  /** What streamed, for the estimate when `usage` is null. */
  output: { text: string; reasoning: string; toolArguments: string };
}

export interface Meter {
  /** The §4.3 formula with tier selection by prompt tokens (cached included), discount applied; null when unpriced. */
  price(usage: TokenUsage, cacheWriteTokens: number | null, pricing: LlmPricing | null, discount: number | null): number | null;
  /**
   * Computes the attempt's usage and cost and records the spend: purposes in AGENT_PURPOSES → ThreadLedger.add
   * (a null threadId → BudgetGuard.record kind 'agent'); `probe`/`eval` → BudgetGuard.record kind 'agent'
   * (ref `probe:<requestId>`); `chat` → nothing (the chat slice writes its one ledger row per reply from the
   * `usage` event, as today). Returns null when nothing is billable (no 2xx and not maybe-billed).
   */
  charge(input: MeterInput): MeteredUsage | null;
  /** Cached / prompt tokens over measured requests of the last 24 h; null without data. */
  cacheHitRatio24h(): number | null;
}

// ─── Reservations (H1-B: reservations.ts) ─────────────────────────────────────────────────────────────────────

export interface ReservationRequest {
  requestId: string;
  purpose: GatewayPurpose;
  threadId: string | null;
  turnId: string | null;
  /** GatewayEstimate.reserveUsd. Null (unpriced): `chat` passes; for other purposes see the implementation's rule. */
  reserveUsd: number | null;
  /**
   * App-budget headroom to leave free for an older request that is waiting for budget (head-of-line, §4.4): the
   * request is reserved only if it fits with this amount kept back. Thread and turn caps ignore it.
   */
  holdUsd?: number;
}

/** Held from admission until settle; no time-based expiry (§4.4). */
export interface Reservation {
  readonly requestId: string;
  readonly usd: number;
  /** Idempotent. Charge first (Meter.charge), then release: both synchronous, so the spend is never uncounted. */
  release(): void;
}

export type ReserveAttempt =
  | { status: 'reserved'; reservation: Reservation }
  /** Fits only once others' outstanding reservations settle → queued(budget). */
  | {
      status: 'wait';
      /** The amount it waits to reserve; with `appBudget`, the scheduler holds it back for later tickets. */
      usd?: number;
      /** True when the app budget (not a thread / turn cap) is what it waits for. */
      appBudget?: boolean;
    }
  /** Does not fit even with nothing outstanding: limit_reached (thread/turn) or budget_exceeded (app). */
  | { status: 'refused'; error: GmiErrorShape };

export type PrecheckResult = { ok: true; warning: string | null } | { ok: false; error: GmiErrorShape };

export interface Reservations {
  /**
   * Before queueing, against ACTUAL spend only (spent + unflushed; no reservations): refused only when a limit is
   * already reached. Purpose `chat` keeps BudgetGuard.check(null, 'chat') semantics (`warning` when not enforced).
   */
  precheck(req: Pick<ReservationRequest, 'purpose' | 'threadId' | 'turnId'>): Promise<PrecheckResult>;
  /**
   * At admission, synchronously (BudgetGuard.statusSnapshot(), ThreadLedger.spend, outstanding): check and insert
   * with no await in between (§4.4).
   */
  tryReserve(req: ReservationRequest): ReserveAttempt;
  /** Sum of outstanding reservations (all, or one thread / one turn). */
  outstandingUsd(filter?: { threadId?: string; turnId?: string }): number;
  /** Number of outstanding reservations. */
  count(): number;
  /** Called after every release (the scheduler re-evaluates queued(budget) requests). */
  onRelease(listener: () => void): () => void;
}

// ─── Persisted thread ledger (H1-B: threads.ts, data/gateway-threads.json) ────────────────────────────────────

export interface ThreadCapsRecord extends ThreadCaps {
  /** ISO time of the last approveCaps() (the native loosening dialog); null when never loosened. */
  approvedAt: string | null;
}

export interface ThreadSpendCharge {
  threadId: string;
  turnId: string | null;
  modelId: string;
  usd: number;
  /** ms since the epoch. */
  at: number;
}

export interface ThreadLedger {
  /** Reads the file; must resolve before the first agent request is admitted. */
  load(): Promise<void>;
  /** Persisted plus unflushed spend (GmiGateway.threadSpend). Unknown thread/turn → 0. */
  spend(threadId: string, turnId?: string | null): { turnUsd: number; threadUsd: number };
  /** Stored caps; CODE_DEFAULTS (perTurnUsd, perThreadUsd) for a thread never seen. */
  caps(threadId: string): ThreadCapsRecord;
  /**
   * Host caps: each field is applied only when it tightens the stored one (a number below the stored number, or a
   * number where none was set); loosening fields are ignored. Returns the caps now in force.
   */
  setCaps(threadId: string, caps: ThreadCaps): ThreadCapsRecord;
  /** After the code slice's native dialog: stored as given, approvedAt = now. */
  approveCaps(threadId: string, caps: ThreadCaps): ThreadCapsRecord;
  /** Synchronous: counted at once (spend + `source`); persisted and flushed to the ledger on the §4.3 schedule. */
  add(charge: ThreadSpendCharge): void;
  /** The turn settled (its run closed): one `agent` ledger row per model for its unflushed spend, ref `thr:<id>/turn:<n>`. */
  settleTurn(threadId: string, turnId: string): void;
  /** Kind 'agent'; reports only spend not yet in the ledger (never counted twice). Registered with BudgetSources. */
  readonly source: SpendSource;
  /** Durable write (durableWriteFile) and ledger rows for everything unflushed (quit). */
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

// ─── Runs main tracks (H1-A: in gateway.ts) ───────────────────────────────────────────────────────────────────

export interface TrackedRun {
  threadId: string;
  turnId: string;
  runId: string;
  openedAt: number;
}

export interface RunRegistry {
  open(scope: { threadId: string; turnId: string; runId: string }): void;
  /** Closes a run (interrupt, run.ended); its turn then settles (ThreadLedger.settleTurn). Null when unknown. */
  close(runId: string): TrackedRun | null;
  get(runId: string): TrackedRun | null;
  list(): TrackedRun[];
  /**
   * §4.4: with an `owner` (a host request) the purpose must be in HOST_PURPOSES and the priority at most
   * MAX_HOST_PRIORITY; any purpose in AGENT_PURPOSES needs a scope whose thread, turn and run match an open run;
   * MAIN_PURPOSES are refused with an owner. Returns the refusal (invalid_input) or null.
   */
  validateRequest(req: Pick<GatewayRequest, 'purpose' | 'priority' | 'scope'>, owner: { hostId: string } | null): GmiErrorShape | null;
  onClose(listener: (run: TrackedRun) => void): () => void;
}

// ─── Scheduler (H1-B: scheduler.ts) ───────────────────────────────────────────────────────────────────────────

/** One request waiting for admission. */
export interface SchedulerTicket {
  requestId: string;
  purpose: GatewayPurpose;
  priority: GatewayPriority;
  threadId: string | null;
  /** ResolvedModel.modelKey: head-of-line, per-model concurrency and the breaker. */
  modelKey: string;
  /** GatewayEstimate.tpmTokens, debited at admission. */
  tpmTokens: number;
  /** Bypass an open breaker with one half-open probe ("Try anyway"). */
  forceProbe?: boolean;
  /**
   * Called by the scheduler when everything else allows admission, synchronously in the same tick as the
   * admission (Reservations.tryReserve). `wait` → the ticket stays queued(budget); `refused` ends it.
   */
  reserve(holdUsd?: number): ReserveAttempt;
}

export interface QueuedInfo {
  position: number;
  etaMs: number | null;
  reason: QueueReason;
}

/** An admitted request: holds a concurrency slot, a TPM debit and the reservation. */
export interface SchedulerSlot {
  readonly requestId: string;
  readonly reservation: Reservation;
  /** Time spent queued, all requeues included. */
  readonly queuedMs: number;
  /**
   * Settle: corrects the TPM debit to `actualTokens` (prompt + completion; null keeps the debit), frees the slot
   * and releases the reservation (after the caller's Meter.charge). Idempotent.
   */
  release(actualTokens: number | null): void;
  /**
   * Not-billed failure or a retry: frees the slot, releases the reservation (nothing charged here) and queues the
   * ticket again at its ORIGINAL position, eligible after `delayMs`. The ticket's reserve() runs again on re-admission.
   */
  requeue(opts: { delayMs: number; reason: QueueReason }): SchedulerHandle;
}

export type AdmitResult =
  | { status: 'admitted'; slot: SchedulerSlot }
  | { status: 'refused'; error: GmiErrorShape }
  | { status: 'cancelled' };

export interface SchedulerHandle {
  /** Never rejects. */
  readonly result: Promise<AdmitResult>;
  /** Called on every change of queue position / reason while queued (→ the `queued` GatewayEvent). */
  onQueued(listener: (info: QueuedInfo) => void): () => void;
  /** Leaves the queue (result → cancelled); no effect once admitted. */
  cancel(): void;
}

export interface SchedulerStats {
  tpmLimit: number;
  tpmEffective: number;
  tpmUsedLastMinute: number;
  queued: number;
  inFlight: number;
  inFlightByModel: Readonly<Record<string, number>>;
  /** ms since the epoch, or null. */
  last429At: number | null;
}

/**
 * Admission order per ticket: connectivity gate → TPM / concurrency / head-of-line → Breaker.tryAcquire →
 * ticket.reserve(). When reserve() answers `wait` or `refused` after a successful tryAcquire, the scheduler itself
 * records `neutral` (the probe slot is given back). For an admitted request the gateway core records the outcome.
 */
export interface Scheduler {
  enqueue(ticket: SchedulerTicket): SchedulerHandle;
  /** AIMD decrease (§4.5); `retryAfterSec` delays every request for that model at least that long. */
  report429(modelKey: string, retryAfterSec: number | null): void;
  setTpmLimit(limit: number): void;
  /** Re-evaluates the queue (also triggered by reservation releases, breaker and connectivity changes). */
  wake(): void;
  stats(): SchedulerStats;
  dispose(): void;
}

// ─── Retry policy and watchdogs (H1-B: retry.ts) ──────────────────────────────────────────────────────────────

/** Why one upstream attempt failed, as observed by the gateway core. */
export type AttemptFailure =
  /** No HTTP response. `errno`: ENOTFOUND, EAI_AGAIN, ECONNREFUSED, ECONNRESET, ETIMEDOUT… */
  | { kind: 'network'; errno: string | null; bodySent: boolean; message: string }
  /** A non-2xx response. `code`: GMI's error code/type when the body had one. */
  | { kind: 'http'; status: number; retryAfterSec: number | null; code: string | null; message: string; /** The parameter GMI named (`param`), when it did. */ param?: string | null }
  /** 2xx headers but no first byte within RetryPolicy.watchdogs().firstByteMs. */
  | { kind: 'first_byte_timeout' }
  /** After the first byte: connection cut, idle or total watchdog, or an unparseable stream. Never retried. */
  | { kind: 'stream'; reason: 'cut' | 'idle_timeout' | 'total_timeout' | 'parse'; message: string };

/** What the gateway core knows about the request when it asks. */
export interface RetryContext {
  purpose: GatewayPurpose;
  priority: GatewayPriority;
  /** GatewayEstimate.promptTokens (no maybe-billed retry above GATEWAY_LIMITS.retry.maybeBilledMaxPromptTokens). */
  promptTokens: number;
  /** 1 for the first attempt. */
  attempt: number;
  maybeBilledRetries: number;
  notBilledRequeues: number;
  /** Start of the current run of continuous 429s (ms), or null. */
  rateLimitedSince: number | null;
  /** Whether a usage-bearing byte (text, reasoning, tool call) was already streamed. */
  afterOutput: boolean;
  now: number;
}

export type RetryDecision =
  /** Not billed: back into the scheduler at the same position (429, 503 + Retry-After, connect failure). */
  | { action: 'requeue'; delayMs: number; reason: QueueReason; rateLimited: boolean; countsForBreaker: false }
  /** The network looks down: close the connectivity gate and requeue once it reopens (no retry budget used). */
  | { action: 'offline'; countsForBreaker: false }
  /** Maybe billed: charge an estimated prompt first (Meter.charge with maybeBilled), then requeue after delayMs. */
  | { action: 'retry'; delayMs: number; maybeBilled: true; countsForBreaker: boolean }
  /** Terminal: the stream ends with `error`. */
  | {
      action: 'fail';
      error: GmiErrorShape;
      maybeBilled: boolean;
      countsForBreaker: boolean;
      /** 401 or credentialRefused → KeyProvider.reportInvalidKey (D15 semantics). */
      reportInvalidKey: boolean;
    };

export interface Watchdogs {
  firstByteMs: number;
  idleMs: number;
  totalMs: number;
}

export interface RetryPolicy {
  /** The §4.6 matrix (context overflow detection included: `error.code === 'context_overflow'`). */
  decide(failure: AttemptFailure, ctx: RetryContext): RetryDecision;
  watchdogs(promptTokens: number): Watchdogs;
  /** Full-jitter backoff for the n-th (0-based) retry. */
  backoffMs(n: number): number;
}

// ─── Circuit breaker (H1-B: breaker.ts) ───────────────────────────────────────────────────────────────────────

export type BreakerState = 'closed' | 'open' | 'half_open';
export type BreakerOutcome =
  /** Any 2xx response (closes a half-open breaker). */
  | 'success'
  /** A 5xx or first-byte timeout from a reachable server (RetryDecision.countsForBreaker). */
  | 'failure'
  /** Everything else (4xx, network-level, cancelled): only frees a half-open probe slot. */
  | 'neutral';

export interface Breaker {
  state(modelKey: string): BreakerState;
  /**
   * May a request for `modelKey` be admitted now? Closed → true. Half-open → true for exactly one probe at a time.
   * Open → false, unless `force` ("Try anyway"), which moves it to half-open for this probe.
   * Every `true` must be followed by exactly one record().
   */
  tryAcquire(modelKey: string, opts?: { force?: boolean; owner?: string }): boolean;
  /**
   * `owner`: the request id passed to tryAcquire. While half-open, only the probe's owner moves the breaker (an
   * acquire without an owner lets any outcome decide, as before); other outcomes stay neutral.
   */
  record(modelKey: string, outcome: BreakerOutcome, owner?: string): void;
  /** Breakers not closed (and recently changed ones), for GatewayStatus.models. `reopenAt` ISO or null. */
  snapshot(): Array<{ modelKey: string; breaker: BreakerState; reopenAt: string | null }>;
  onChange(listener: () => void): () => void;
  dispose(): void;
}

// ─── Connectivity gate (H1-B: connectivity.ts) ────────────────────────────────────────────────────────────────

/** OS signals; in Electron `net.isOnline()` and `powerMonitor` 'resume' (passed in by the composition root). */
export interface ConnectivitySignals {
  isOnline(): boolean;
  onResume(listener: () => void): () => void;
}

export interface ConnectivityGate {
  /** False while closed: nothing is admitted (queued(offline)), no breaker counts, no retry budget is used. */
  online(): boolean;
  /** No HTTP response (DNS, ECONNREFUSED, ECONNRESET before a response): may close the gate. */
  reportNetworkFailure(errno: string | null): void;
  /** Any HTTP response proves connectivity. */
  reportResponse(): void;
  onChange(listener: (online: boolean) => void): () => void;
  dispose(): void;
}

export interface ConnectivityDeps {
  signals: ConnectivitySignals;
  /** One free request (HEAD of the API host); true when the server answered. Reopens a closed gate. */
  probe(): Promise<boolean>;
  clock: GatewayClock;
}

// ─── Trace and status (H1-B: trace.ts, status.ts) ─────────────────────────────────────────────────────────────

/** One settled request (§4.3, §21). Never bodies, prompts, outputs or keys. */
export interface GatewayTraceRecord {
  requestId: string;
  purpose: GatewayPurpose;
  priority: GatewayPriority;
  threadId: string | null;
  runId: string | null;
  step: number | null;
  model: string | null;
  api: 'chat' | 'responses' | 'router';
  attempts: number;
  queueMs: number;
  ttfbMs: number | null;
  totalMs: number;
  promptTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  estimated: boolean;
  maybeBilled: boolean;
  status: 'ok' | 'error' | 'cancelled';
  /** GmiErrorCode on error, else null. */
  code: string | null;
  /** First 8 characters of the request's prefixHash, or null. */
  prefixHash8: string | null;
  /** ISO. */
  at: string;
}

export interface GatewayTrace {
  /** Ring of GATEWAY_LIMITS.traceRing, and one `gateway.request` info log line. */
  record(record: GatewayTraceRecord): void;
  /** Newest first. */
  recent(limit?: number): GatewayTraceRecord[];
}

export interface GatewayStatusDeps {
  scheduler: Pick<Scheduler, 'stats'>;
  breaker: Pick<Breaker, 'snapshot'>;
  connectivity: Pick<ConnectivityGate, 'online'>;
  meter: Pick<Meter, 'cacheHitRatio24h'>;
  clock: GatewayClock;
}

export interface GatewayStatusTracker {
  snapshot(): GatewayStatus;
  /** Marks the status dirty; listeners get at most one snapshot per GATEWAY_LIMITS.statusMinIntervalMs (trailing). */
  changed(): void;
  onChange(listener: (status: GatewayStatus) => void): () => void;
  dispose(): void;
}

// ─── Composition (H1-A: index.ts exports a GatewayFactory; slices/gateway.ts calls it) ─────────────────────────

/** Everything the gateway needs from the rest of main. */
export interface GatewayFactoryDeps {
  ctx: AppContext;
  keys: KeyProvider;
  catalog: CatalogService;
  budget: BudgetGuard;
  signals: ConnectivitySignals;
  /** The org's TPM limit (Settings › Code › rate-limit tier; GATEWAY_TPM_TIERS.t1 until that setting exists). */
  tpmLimit(): number;
  clock: GatewayClock;
}

/** What the factory hands the registration (slices/gateway.ts). */
export interface GatewayRuntime {
  gateway: GmiGateway;
  /** Unflushed agent spend (ThreadLedger.source); the slice registers it with BudgetSources. */
  spendSource: SpendSource | null;
  /** Status changes, already throttled (GatewayStatusTracker.onChange); the slice emits `code:gateway`. */
  onStatus(listener: (status: GatewayStatus) => void): () => void;
  /** Settings changed: re-read tpmLimit(). */
  reloadSettings(): void;
  /** Quit: abort in-flight requests (settled, estimated), flush the thread ledger. */
  dispose(): Promise<void>;
}

export type GatewayFactory = (deps: GatewayFactoryDeps) => Promise<GatewayRuntime>;

/** The pieces H1-B delivers, as the gateway core (H1-A) receives them; tests pass fakes. */
export interface GatewayParts {
  resolver: ModelResolver;
  estimator: Estimator;
  meter: Meter;
  reservations: Reservations;
  threads: ThreadLedger;
  runs: RunRegistry;
  scheduler: Scheduler;
  retry: RetryPolicy;
  breaker: Breaker;
  connectivity: ConnectivityGate;
  trace: GatewayTrace;
  status: GatewayStatusTracker;
  clock: GatewayClock;
}

/** Real-time clock for production. */
export const systemClock: GatewayClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};
