// Internal interfaces of the compute slice (compute.md §14 `types.ts`), frozen by C1-0 so C1-A…E, C2 and H4 build
// against them in parallel. Main process only: nothing here crosses IPC (the renderer sees src/shared/contracts).
//
// Who implements what:
//   Registry, Supervisor, ResourceActions, SecretScreen → C1-C (registry.ts, supervisor.ts, service.ts)
//   Guard (+ AlarmCenter, ActivitySink, SpendSource)   → C1-D (guard.ts, accrual.ts, pricing.ts, alarms.ts)
//   PriceBook                                          → C1-B (catalog.ts; the public billing feed)
//   ExecPort                                           → C2-A (computer/session.ts); used by C2-B and the H4 broker
// A change here is a contract change for every slice above: additive only, agreed through the integrator.
import type {
  ComputeAction,
  ComputeAlarm,
  ComputeAlarmKind,
  ComputeApiHealth,
  ComputeBackend,
  ComputeKind,
  ComputeNetwork,
  ComputePhase,
  ComputeResource,
  ComputerService,
  CostLine,
  LeasePolicy,
} from '@shared/contracts/compute';
import type { GmiErrorShape } from '@shared/contracts/errors';
import type { BudgetCheck } from '@shared/contracts/usage';
import type { SpendSource } from '../../core/services';
import { V2_EXEC_CONCURRENCY_LIMIT, V2_EXEC_WAIT_TIMEOUT_MAX_SEC, type V2ExecTerminalStatus } from './sandbox/dto';

// DTO re-exports (§14): the wire types of both GMI APIs, for every compute module.
export type * from './ce/dto';
export type * from './sandbox/dto';

// ─── Constants shared across slices (values from compute.md; tests in several slices rely on them) ────────────────

/** Files under `<userData>/data/` (registry and journal are written with `durableWriteFile`, §13.2). */
export const COMPUTE_DATA_FILES = {
  registry: 'compute-resources.json',
  journal: 'compute-journal.json',
  catalog: 'compute-catalog.json',
} as const;

/** Exec slots per sandbox: v2 allows at most 10 non-terminal executions [V] (§8.1). */
export const EXEC_SLOTS_PER_SANDBOX = V2_EXEC_CONCURRENCY_LIMIT;
/** The agent (H4 broker) never holds more than 6 of them, so the user always has at least 4 (§8.1). */
export const AGENT_EXEC_SLOTS_MAX = 6;
/** `wait_timeout_seconds` of every exec POST: a wait that times out leaves the execution running [V]. */
export const EXEC_WAIT_TIMEOUT_SEC = V2_EXEC_WAIT_TIMEOUT_MAX_SEC;

/** Timers of §6.6, §7.5, §9.3–9.4 and §8.1, in milliseconds unless the name says otherwise. */
export const COMPUTE_TIMING = {
  pollTransitionalMs: 5_000,
  pollComputerOpenMs: 30_000,
  pollSteadyMs: 60_000,
  pollHiddenMs: 120_000,
  pollBackoffMinMs: 2_000,
  pollBackoffMaxMs: 5 * 60_000,
  /** Consecutive failures before apiHealth is `degraded`; minutes of failures before `down`. */
  healthDegradedAfterFailures: 5,
  healthDownAfterMs: 30 * 60_000,
  /** Leases use server time when the skew is larger. */
  clockSkewMaxMs: 2 * 60_000,
  guardTickMs: 60_000,
  sweepMs: 10 * 60_000,
  quoteTtlMs: 5 * 60_000,
  /** Desktop warnings before a lease ends, in minutes. */
  leaseWarningsMin: [15, 5, 1] as const,
  /** A lease-triggered delete never happens within this long after a lease change without the warnings (§9.3). */
  leaseChangeGraceMs: 15 * 60_000,
  /** Retry back-off of a pending lease/budget action (§9.4), then every 10 min; alarm after 3 failures. */
  actionRetryMs: [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const,
  actionFailuresBeforeAlarm: 3,
  /** Auto-extend (§7.3): when user activity in the last 10 min and less than 10 min remain, add 30 min. */
  autoExtendActivityWindowMs: 10 * 60_000,
  autoExtendWhenRemainingMs: 10 * 60_000,
  autoExtendByMs: 30 * 60_000,
  /** Sessions close this long after the last view unmounts (warm reattach, §8.1). */
  sessionWarmMs: 5 * 60_000,
  /** Tombstones keep accrual for this long (registry). */
  tombstoneKeepMs: 90 * 24 * 60 * 60_000,
} as const;

// ─── Registry records (data/compute-resources.json) ────────────────────────────────────────────────────────────────

/** A lease or budget action that has not succeeded yet (§9.4); the same shape the contract shows. */
export type ActionPending = NonNullable<ComputeResource['actionPending']>;

/** One billed stretch of a resource (§9.2). Accrual = Σ intervals × usdPerHour, cut to local day / month windows. */
export interface BillingInterval {
  /** Server-corrected start. CE: backdated to the create request; sandboxes: `running_at` / `started_at`. */
  from: string;
  /** End (GMI's `paused_at` / `deletion.requested_at` when known, else the last poll); null while billing. */
  to: string | null;
  /** List price per hour when the interval opened; null: unknown (shown as price unknown). */
  usdPerHour: number | null;
}

/** Who started an execution. `app` execs (port scan, usage snapshot, listings) are never activity (§9.5). */
export type ExecOrigin = 'user' | 'app' | 'agent';

/** An execution that has not reached a terminal state yet, persisted so a restart can poll or cancel it (§8.1). */
export interface InflightExec {
  /** v2 `execution_id`. */
  eid: string;
  resourceId: string;
  origin: ExecOrigin;
  /** H4 broker grant, for cancel on interrupt / revoke / run end. */
  grantId: string | null;
  /** The `execution_timeout_seconds` sent (always explicit). */
  timeoutSec: number;
  startedAt: string;
}

/**
 * One resource as the registry stores it: the source of `ComputeResource` / `ComputeResourceDetail` (which add the
 * guard's live figures: accrual, `leaseEndsAt`, `idlePauseAt`, `pendingAction`). Never holds a secret: env values,
 * tokens, the CE shell `urlPath` and registry credentials are not part of it (§5.2, §6.1).
 */
export interface ComputeRecord {
  /** `cr_<uuid>`; also the v2 Idempotency-Key and the `rid` label. */
  id: string;
  kind: ComputeKind;
  backend: ComputeBackend;
  /** CE container id / v2 sandbox id; null while the create is unresolved. */
  remoteId: string | null;
  /** Remote name (`gmid-<inst6>-<slug>-<nonce6>` for containers). */
  name: string;
  displayName: string;
  /** Created or adopted by this install; false: read-only (another install's or unmanaged). */
  managed: boolean;
  /** `inst6` of the remote name (containers) or the `inst` label prefix (sandboxes); null: untagged. */
  installTag: string | null;
  purpose: 'computer' | 'agent' | null;
  threadId: string | null;
  idc: string | null;
  sku: string | null;
  templateId: string | null;
  templateName: string | null;
  snapshotId: string | null;
  /** List price of `sku` at create (EIP lines are separate network costs). */
  listUsdPerHour: number | null;

  phase: ComputePhase;
  rawState: string | null;
  /** User-safe reason (failure, pause, deletion). */
  reason: string | null;
  /** When the create request was sent (CE accrual is backdated to it, §9.2). */
  requestedAt: string | null;
  createdAt: string | null;
  /** First observed `running`: the lease starts here (§9.4). */
  runningSince: string | null;
  serverEndsAt: string | null;
  pausedAt: string | null;
  pausedExpiresAt: string | null;
  /** Last successful remote observation (server-corrected). */
  lastSeenAt: string | null;

  lease: LeasePolicy | null;
  /** The longest lifetime the user approved natively (extending within it needs no dialog, §7.3). Null: no limit approved. */
  approvedMaxLifetimeMin: number | null;
  /** Last `setLease` (§9.3: no lease-triggered delete within 15 min of a change without the warnings). */
  leaseChangedAt: string | null;
  intervals: BillingInterval[];
  /**
   * The managed EIP's own billing (§6.3: it bills from allocation until released, also after the container is
   * deleted when the user keeps it). Opened by the network saga, closed when GMI Desk releases it. Optional on disk.
   */
  eipIntervals: BillingInterval[];
  actionPending: ActionPending | null;
  inflightExecs: InflightExec[];
  /** Services the user (or agent) started, restarted after a cold resume (§8.3). */
  services: ComputerService[];

  /** Containers only (managed EIP and firewall ids live here, never credentials). */
  network: ComputeNetwork | null;
  /** CE logs: whether `Range` worked when probed once (§6.4); null until probed. */
  logsRangeSupported: boolean | null;
  envNames: string[];
  command: string | null;
  args: string[];
  sshKeyNames: string[];
  secure: boolean | null;
  egressLocked: boolean | null;
  lastError: GmiErrorShape | null;
  /** Newest first, at most 50. */
  history: Array<{ at: string; phase: ComputePhase; note: string | null }>;
  /** Set when deleted remotely (or adopted away): kept 90 days so accrual stays right. */
  tombstone: { at: string; reason: string } | null;
  updatedAt: string;
}

/** The registry store (C1-C `registry.ts`). Every write is persisted with `durableWriteFile` before it resolves. */
export interface Registry {
  /** Reads the file (missing → empty). Called once at startup before anything else touches the registry. */
  load(): Promise<void>;
  /** Live records (tombstones only when asked). Returned objects are snapshots: mutate through `update`. */
  list(opts?: { includeTombstones?: boolean }): ComputeRecord[];
  get(id: string): ComputeRecord | null;
  findByRemote(backend: ComputeBackend, remoteId: string): ComputeRecord | null;
  findByName(name: string): ComputeRecord | null;
  /** Adds a new record (unique id). */
  add(record: ComputeRecord): Promise<ComputeRecord>;
  /** Atomic read-modify-write of one record; rejects with GmiError('not_found') for an unknown id. */
  update(id: string, mutate: (current: Readonly<ComputeRecord>) => ComputeRecord): Promise<ComputeRecord>;
  /** Marks a record deleted at `at`: open intervals are closed there and the record is kept as a tombstone. */
  tombstone(id: string, at: string, reason: string): Promise<ComputeRecord>;
  /** Sets or clears the retried lease/budget action (§9.4). */
  setActionPending(id: string, pending: ActionPending | null): Promise<ComputeRecord>;
  /** Persisted in-flight executions, of one resource or all. */
  inflightExecs(resourceId?: string): InflightExec[];
  /** Persists an execution id as soon as POST /executions answered (before its slot may be released). */
  addInflightExec(exec: InflightExec): Promise<void>;
  /** Forgets an execution once it is terminal; an unknown eid is a no-op. */
  removeInflightExec(eid: string): Promise<void>;
  /** After every persisted change, with the ids that changed. */
  onChange(listener: (ids: string[]) => void): () => void;
  /** Resolves when every pending write is on disk (dispose). */
  flush(): Promise<void>;
}

// ─── Supervisor (polling, state mapping, per-resource mutex, GMI's clock) ──────────────────────────────────────────

/** A normalised phase change seen by the supervisor (poll, action result, reconcile or sweep). */
export interface PhaseTransition {
  resourceId: string;
  kind: ComputeKind;
  backend: ComputeBackend;
  /** Null: first observation since startup. */
  from: ComputePhase | null;
  to: ComputePhase;
  rawState: string | null;
  /** Server-corrected observation time. */
  at: string;
  /** GMI's own timestamps when it reports them; accrual prefers these to `at` (§9.2). */
  remote: {
    createdAt: string | null;
    runningAt: string | null;
    pausedAt: string | null;
    endAt: string | null;
    deletionRequestedAt: string | null;
  };
  source: 'poll' | 'action' | 'reconcile' | 'sweep';
}

/** GMI's clock from the HTTP `Date` header of its responses (§6.6). */
export interface ServerClock {
  /** Local time corrected by the observed offset (plain local time while none was observed). */
  now(): Date;
  /** Server minus local, ms; null before the first GMI response. */
  skewMs(): number | null;
  /** True once a GMI `Date` was seen in this run: destructive catch-up waits for it (§9.4). */
  verified(): boolean;
}

/** Adaptive polling of both backends (C1-C `supervisor.ts`). */
export interface Supervisor {
  start(): void;
  stop(): Promise<void>;
  /** Polls both backends now and resolves once the registry reflects the result (`ComputeApi.refresh`). */
  pollNow(): Promise<void>;
  /** Fast polling (5 s) for this resource until it leaves a transitional phase. */
  watch(resourceId: string): void;
  /** Cadence inputs (§6.6): hidden window 120 s, open computer 30 s, suspended: none, resumed: poll at once. */
  setHints(hints: Partial<{ windowHidden: boolean; computerOpen: boolean; suspended: boolean }>): void;
  /**
   * The per-resource mutex: one mutation at a time per resource (later callers wait their turn). `pendingAction` is
   * `action` while `fn` runs; a fast poll follows. User actions and guard actions share it.
   */
  withResourceLock<T>(resourceId: string, action: ComputeAction, fn: () => Promise<T>): Promise<T>;
  pendingAction(resourceId: string): ComputeAction | null;
  /** When a successful poll last confirmed this resource's remote state (server time); null: not since startup. */
  freshSince(resourceId: string): string | null;
  readonly clock: ServerClock;
  health(): { ce: ComputeApiHealth; sandbox: ComputeApiHealth };
  onTransition(listener: (transition: PhaseTransition) => void): () => void;
}

/** Why the guard (not the user) acts on a resource. */
export type GuardCause = 'lease' | 'budget' | 'idle' | 'quit' | 'catch_up';

/**
 * Remote actions the guard applies without a new dialog, because the user already approved them (the lease and
 * `onBudget` choices in the native create dialog, the quit dialog). Implemented by C1-C on top of its lifecycle code;
 * each call takes the resource's mutex. A rejection is the mapped GmiError: the guard records it in `actionPending`
 * and retries (§9.4).
 */
export interface ResourceActions {
  pause(resourceId: string, cause: GuardCause): Promise<void>;
  delete(resourceId: string, cause: GuardCause): Promise<void>;
  /** POST /sandboxes/{id}/timeout inside the approved lifetime (auto-extend, §7.3). Resolves with GMI's new end. */
  extendServerTimeout(resourceId: string, seconds: number, cause: 'activity'): Promise<string>;
}

/** The secret-substring check (§6.1): stored secrets (inference key, OAuth tokens, compute key) never reach a resource. */
export interface SecretScreen {
  /**
   * Rejects with GmiError('invalid_input') when a value, after trimming, contains any stored secret as a substring.
   * The error names the field (`label`), never the value. Used by create (env, command, args), `startService` (C2-B)
   * and the H4 broker (`sandbox_exec`, `sandbox_write`, `sandbox_start_service`).
   */
  assertNoSecrets(values: ReadonlyArray<{ label: string; value: string }>): Promise<void>;
}

// ─── Prices (C1-B serves them from the public billing feed; C1-D's pricing uses them) ──────────────────────────────

export interface PriceInfo {
  /** List USD per hour; null: unknown (refused under `enforce`, §9.1). */
  usdPerHour: number | null;
  /** When the feed row was fetched; null when unknown. */
  fetchedAt: string | null;
  source: 'public_feed' | 'cached';
}

export interface PriceBook {
  /** The list price of a SKU (container, sandbox or EIP), optionally in one IDC. */
  price(sku: string, idc?: string | null): PriceInfo;
}

// ─── Guard (C1-D): prices × time, leases, idle, budgets, alarms, quit check ────────────────────────────────────────

/** Input of the budget gate before create, resume and extend (§9.3). */
export interface QuoteAssessmentInput {
  action: 'create' | 'resume' | 'extend';
  kind: ComputeKind;
  /** Every billed line: the resource SKU and, with public access, the EIP SKU. */
  lines: Array<{ sku: string; label: string; idc: string | null }>;
  /** Hours the projection covers: lease remaining or timeout; 24 with no limit (§6.2, §9.3). */
  hours: number;
  /** The resource being resumed or extended (left out of the committed burn). */
  resourceId?: string | null;
  /** A GPU SKU: sandboxes need a daily budget only then; containers always do (§9.3). */
  gpu: boolean;
}

/** The budget gate's verdict, from which C1-C builds `CreateQuote` and the native dialog text. */
export interface QuoteAssessment {
  lines: CostLine[];
  /** List total per hour; null when any line's price is unknown. */
  usdPerHour: number | null;
  /** `usdPerHour × hours`; null when unknown. */
  maxUsd: number | null;
  /** Σ usdPerHour × remaining lease of the running managed resources (no lease: 24 h). */
  committedUsd: number;
  priceSource: 'public_feed' | 'cached';
  priceAgeSec: number | null;
  /** `BudgetGuard.check(maxUsd + committedUsd, 'compute')`. */
  budget: BudgetCheck;
  dailyBudgetSet: boolean;
  /** Sentences for the review step and the native dialog ("Your budget will not stop this container", …). */
  warnings: string[];
  /** Non-null: main must refuse (no daily budget, unknown price under enforce, budget exceeded). */
  refusal: GmiErrorShape | null;
}

/** Which native dialog a `setLease` patch needs (§9.3). Neither: the change only tightens and applies directly. */
export interface LeaseChangeAssessment {
  loosens: boolean;
  deletesSooner: boolean;
  /** Plain sentences for the dialog (what is deleted and when, what gets looser). */
  reasons: string[];
}

/** User activity and active-agent activity only (§9.5): output, preview traffic and app execs are not activity. */
export const USER_ACTIVITY_KINDS = ['terminal_input', 'file_op', 'transfer', 'preview_input', 'user_exec', 'service_start'] as const;
export type UserActivityKind = (typeof USER_ACTIVITY_KINDS)[number];

/** An agent tool call counts only during an active run, so it carries the run id (H4). */
export type ComputeActivity = { kind: UserActivityKind } | { kind: 'agent_tool'; runId: string };

/** Where the computer (C2) and the broker (H4) report activity; the guard's idle clock reads it. */
export interface ActivitySink {
  record(resourceId: string, activity: ComputeActivity): void;
}

/** What raising an alarm takes; `id` and `createdAt` are the alarm center's. */
export type AlarmInput = Omit<ComputeAlarm, 'id' | 'createdAt'>;

/** Alarm store and notification throttle (C1-D `alarms.ts`); C1-C's sweep and create raise alarms through it. */
export interface AlarmCenter {
  /** Raises or refreshes an alarm, deduplicated by (kind, resourceId); notifications are throttled (§9.6). */
  raise(input: AlarmInput): ComputeAlarm;
  /** Clears an alarm whose cause is gone (no-op when absent). */
  resolve(kind: ComputeAlarmKind, resourceId: string | null): void;
  dismiss(alarmId: string): void;
  list(): ComputeAlarm[];
  onChange(listener: () => void): () => void;
}

/** The guard's live figures for one resource. */
export interface ResourceCost {
  accruedUsd: number;
  accruedTodayUsd: number;
  leaseEndsAt: string | null;
  idlePauseAt: string | null;
}

export interface Guard {
  /** Starts the 60 s tick (and power resume ticks); registers `spend` with BudgetSources. */
  start(): void;
  stop(): Promise<void>;
  /** One pass now: accrual, leases, idle, budgets, retries of `actionPending` (§9.3–9.5). */
  tick(): Promise<void>;
  assessQuote(input: QuoteAssessmentInput): Promise<QuoteAssessment>;
  assessLeaseChange(record: Readonly<ComputeRecord>, patch: Partial<LeasePolicy>): LeaseChangeAssessment;
  /** True when a daily budget exists (`ComputeState.dailyBudgetSet`). */
  dailyBudgetSet(): boolean;
  /** Compute spend for the usage slice (kind `compute`). */
  readonly spend: SpendSource;
  cost(resourceId: string): ResourceCost;
  totals(): { todayUsd: number; monthUsd: number; running: { count: number; usdPerHour: number } };
  readonly alarms: AlarmCenter;
  readonly activity: ActivitySink;
  lastActivityAt(resourceId: string): string | null;
  /** The quit check of §9.7 (registered through `core/shutdown.ts` by the slice). */
  quitCheck(): Promise<'quit' | 'cancel'>;
  onChange(listener: () => void): () => void;
}

// ─── ExecPort (C2-A): the per-sandbox exec semaphore shared by the user's computer and the agent broker ───────────

export type ExecPriority = 'user' | 'agent';

/** Allowed outcomes when a slot is released: a terminal execution status, or an execution that never started. */
export type ExecReleaseOutcome = V2ExecTerminalStatus | 'not_started';

/** One held exec slot. It stays taken until the execution is terminal, not until the HTTP call returns (§8.1). */
export interface ExecSlot {
  readonly slotId: string;
  readonly resourceId: string;
  readonly priority: ExecPriority;
  /** Records the execution id once POST /executions answered (persisted as an InflightExec). Once per slot. */
  bind(exec: { eid: string; origin: ExecOrigin; grantId?: string | null; timeoutSec: number }): Promise<void>;
  /** Frees the slot. Only for a terminal status (polled) or an execution that was never started. Idempotent. */
  release(outcome: ExecReleaseOutcome): Promise<void>;
}

export interface ExecPort {
  /**
   * Waits for a slot of `resourceId`: 10 per sandbox, `agent` holders at most 6, waiting `user` requests served
   * first. Before the first slot of a session, persisted in-flight executions are polled or cancelled. Rejects
   * with GmiError('cancelled') when `signal` aborts while waiting.
   */
  acquire(resourceId: string, opts: { priority: ExecPriority; signal?: AbortSignal }): Promise<ExecSlot>;
  /** POST /executions/{eid}/cancel for an abandoned execution; its slot is released once it is terminal. */
  cancel(eid: string): Promise<void>;
  /** After a 429 `Execution.ConcurrencyLimitExceeded`: lowers the local capacity to what GMI allows, then backs off. */
  lowerCapacity(resourceId: string, observed: number): void;
  usage(resourceId: string): { capacity: number; inUse: number; agentInUse: number; waiting: number };
}

// ─── What the compute slice hands to the computer (C2) and harness (H4) registrations ─────────────────────────────

export interface ComputeInternals {
  registry: Registry;
  supervisor: Supervisor;
  guard: Guard;
  actions: ResourceActions;
  secrets: SecretScreen;
  prices: PriceBook;
  /**
   * H4 binds the harness's run state here: an `agent_tool` activity counts toward idle only while its run is active
   * (§9.5). Until it is bound, agent tool calls never count (fail closed).
   */
  setRunActive?(isRunActive: ((runId: string) => boolean) | null): void;
}
