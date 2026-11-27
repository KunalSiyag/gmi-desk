/**
 * Conforming fakes of the gateway's internal interfaces (src/main/services/gateway/types.ts, H1-0), for H1-A
 * (gateway core tests without the money/flow modules), H1-B (tests of one module with fakes of the others) and
 * H1-C (chat tests against `scriptedGateway`). Each fake is typed against its interface, and
 * test/gateway/types.test.ts runs the shared contract checks (test/gateway/contracts.ts) on them.
 */
import { CODE_DEFAULTS } from '@shared/contracts/code';
import type { GmiErrorShape } from '@shared/contracts/errors';
import { GATEWAY_TPM_TIERS, type GatewayEvent, type GatewayRequest, type GatewayScope, type GatewayStatus } from '@shared/contracts/gateway';
import type { TokenUsage } from '@shared/contracts/chat';
import { GmiError } from '@shared/contracts/errors';
import type { GmiGateway, SpendSource, ThreadCaps } from '@main/core/services';
import {
  GATEWAY_LIMITS,
  HOST_PURPOSES,
  MAIN_PURPOSES,
  PRIORITY_RANK,
  MAX_HOST_PRIORITY,
  AGENT_PURPOSES,
  routerModelKey,
  type AdmitResult,
  type AttemptFailure,
  type Breaker,
  type BreakerOutcome,
  type BreakerState,
  type ConnectivityGate,
  type EstimateInput,
  type Estimator,
  type GatewayClock,
  type GatewayEstimate,
  type GatewayParts,
  type GatewayStatusTracker,
  type GatewayTrace,
  type GatewayTraceRecord,
  type Meter,
  type MeterInput,
  type MeteredUsage,
  type ModelCapabilities,
  type ModelResolver,
  type PrecheckResult,
  type QueuedInfo,
  type Reservation,
  type ReservationRequest,
  type Reservations,
  type ReserveAttempt,
  type ResolvedModel,
  type RetryContext,
  type RetryDecision,
  type RetryPolicy,
  type RunRegistry,
  type Scheduler,
  type SchedulerHandle,
  type SchedulerSlot,
  type SchedulerTicket,
  type ThreadCapsRecord,
  type ThreadLedger,
  type ThreadSpendCharge,
  type TrackedRun,
} from '@main/services/gateway/types';
import type { LlmPricing } from '@shared/contracts/catalog';

// ─── Clock ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeClock extends GatewayClock {
  /** Moves time forward, firing due timers in order (timers scheduled while firing fire too when due). */
  advance(ms: number): void;
  pendingTimers(): number;
}

export function fakeClock(start = Date.parse('2026-11-02T10:00:00.000Z'), random = 0.5): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    random: () => random,
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(timer) {
      if (typeof timer === 'number') timers.delete(timer);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers) if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
    pendingTimers: () => timers.size,
  };
}

// ─── Model resolution ─────────────────────────────────────────────────────────────────────────────────────────

export const FAKE_PRICING: LlmPricing = { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26, cacheWritePerMTok: null };

export function fakeCapabilities(over: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    api: 'chat',
    maxTokensField: 'max_tokens',
    maxOutputTokens: GATEWAY_LIMITS.unknownMaxOutputTokens,
    tools: true,
    parallelToolCalls: true,
    toolChoiceRequired: false,
    strictTools: false,
    reasoningReplay: 'never',
    ctxExceededParam: true,
    includeUsage: true,
    cacheKeyParam: null,
    developerRole: false,
    temperature: true,
    reasoningEffort: false,
    ...over,
  };
}

/** Every listed model resolves (chat API, FAKE_PRICING, discount 0.5); the router resolves unpriced. */
export function fakeResolver(models: Record<string, { pricing?: LlmPricing | null; discount?: number | null; capabilities?: Partial<ModelCapabilities> }> = {}): ModelResolver {
  return {
    resolve(target, maxOutputTokens): ResolvedModel | null {
      if ('router' in target) {
        return {
          model: null,
          router: target.router,
          api: 'router',
          modelKey: routerModelKey(target.router),
          pricing: null,
          discount: null,
          contextLength: null,
          capabilities: null,
          maxOutputTokens,
          truncationRisk: false,
        };
      }
      const m = models[target.model];
      if (!m) return null;
      const capabilities = fakeCapabilities(m.capabilities);
      return {
        model: target.model,
        router: null,
        api: capabilities.api,
        modelKey: target.model,
        pricing: m.pricing === undefined ? FAKE_PRICING : m.pricing,
        discount: m.discount === undefined ? 0.5 : m.discount,
        contextLength: 1_048_576,
        capabilities,
        maxOutputTokens: Math.min(maxOutputTokens, capabilities.maxOutputTokens),
        truncationRisk: !capabilities.ctxExceededParam,
      };
    },
    resolveRouted: (id) => (models[id] ? { pricing: models[id].pricing ?? FAKE_PRICING, discount: models[id].discount ?? 0.5 } : null),
    refresh: async () => undefined,
  };
}

// ─── Estimator and meter ──────────────────────────────────────────────────────────────────────────────────────

const textTokens = (text: string) => Math.ceil(text.length / 4);

/** Uncalibrated, prefix-free: P = Σ ⌈chars/4⌉ (+4 per message), C = 0, worst-case reserve from the base prices. */
export function fakeEstimator(): Estimator & { commits: number; observations: Array<{ estimated: number; measured: number }> } {
  const est = {
    commits: 0,
    observations: [] as Array<{ estimated: number; measured: number }>,
    estimate(input: EstimateInput): GatewayEstimate {
      const tokens = [
        ...(input.tools ?? []).map((t) => textTokens(JSON.stringify(t))),
        ...input.messages.map((m) => 4 + textTokens(typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join(''))),
      ];
      const P = tokens.reduce((a, b) => a + b, 0);
      const { pricing, discount, maxOutputTokens } = input.resolved;
      const priced = pricing && pricing.inputPerMTok !== null && pricing.outputPerMTok !== null;
      let reserveUsd = priced ? ((P * pricing.inputPerMTok! + maxOutputTokens * pricing.outputPerMTok!) / 1e6) * (1 - (discount ?? 0)) : null;
      if (reserveUsd !== null && input.purpose === 'probe') reserveUsd = Math.min(reserveUsd, GATEWAY_LIMITS.probeReserveCapUsd);
      let acc = 0;
      return {
        promptTokens: P,
        maxOutputTokens,
        expectedCachedTokens: 0,
        reserveUsd,
        expectedUsd: reserveUsd,
        tpmTokens: P + maxOutputTokens,
        prefix: { hashes: tokens.map((_, i) => `h${i}`), tokens: tokens.map((t) => (acc += t)) },
      };
    },
    textTokens,
    commit() {
      est.commits += 1;
    },
    observe(_scope: GatewayScope, _key: string, estimated: number, measured: number) {
      est.observations.push({ estimated, measured });
    },
  };
  return est;
}

/** Prices with the base rates (no tiers); records every charge; agent purposes go to `threads` when given. */
export function fakeMeter(threads?: Pick<ThreadLedger, 'add'>): Meter & { charges: Array<MeterInput & { result: MeteredUsage | null }> } {
  const price = (usage: TokenUsage, cacheWrite: number | null, pricing: LlmPricing | null, discount: number | null): number | null => {
    if (!pricing || pricing.inputPerMTok === null || pricing.outputPerMTok === null) return null;
    const cached = usage.cachedTokens ?? 0;
    const write = cacheWrite ?? 0;
    const list =
      ((usage.promptTokens - cached - write) * pricing.inputPerMTok +
        cached * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) +
        write * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) +
        usage.completionTokens * pricing.outputPerMTok) /
      1e6;
    return list * (1 - (discount ?? 0));
  };
  const meter = {
    charges: [] as Array<MeterInput & { result: MeteredUsage | null }>,
    price,
    charge(input: MeterInput): MeteredUsage | null {
      let result: MeteredUsage | null = null;
      if (input.usage) {
        result = { usage: input.usage, cacheWriteTokens: input.cacheWriteTokens, costUsd: price(input.usage, input.cacheWriteTokens, input.pricing, input.discount), estimated: false, maybeBilled: input.maybeBilled };
      } else if (input.responded || input.maybeBilled) {
        const completion = input.maybeBilled && !input.responded ? 0 : textTokens(input.output.text + input.output.reasoning + input.output.toolArguments);
        const usage: TokenUsage = { promptTokens: input.estimate.promptTokens, completionTokens: completion, totalTokens: input.estimate.promptTokens + completion, reasoningTokens: null, cachedTokens: null };
        result = { usage, cacheWriteTokens: null, costUsd: price(usage, null, input.pricing, input.discount), estimated: true, maybeBilled: input.maybeBilled };
      }
      if (result && threads && input.scope.threadId && AGENT_PURPOSES.includes(input.purpose)) {
        threads.add({ threadId: input.scope.threadId, turnId: input.scope.turnId, modelId: input.model ?? 'unknown', usd: result.costUsd ?? 0, at: 0 });
      }
      meter.charges.push({ ...input, result });
      return result;
    },
    cacheHitRatio24h: () => null,
  };
  return meter;
}

// ─── Reservations ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * In-memory reservations against a fixed `remainingUsd` (null = no limit): the §4.4 three-way rule (fits →
 * reserved; fits without others' outstanding → wait; else refused budget_exceeded). Chat is never reserved.
 */
export function fakeReservations(opts: { remainingUsd?: number | null; spentUsd?: () => number } = {}): Reservations & { setRemaining(usd: number | null): void } {
  let remaining = opts.remainingUsd ?? null;
  const spent = opts.spentUsd ?? (() => 0);
  const outstanding = new Map<string, ReservationRequest & { usd: number }>();
  const listeners = new Set<() => void>();
  const make = (req: ReservationRequest, usd: number): Reservation => {
    let released = false;
    outstanding.set(req.requestId, { ...req, usd });
    return {
      requestId: req.requestId,
      usd,
      release() {
        if (released) return;
        released = true;
        outstanding.delete(req.requestId);
        for (const l of [...listeners]) l();
      },
    };
  };
  const sum = (filter?: { threadId?: string; turnId?: string }) =>
    [...outstanding.values()]
      .filter((r) => (!filter?.threadId || r.threadId === filter.threadId) && (!filter?.turnId || r.turnId === filter.turnId))
      .reduce((a, r) => a + r.usd, 0);
  const exceeded: GmiErrorShape = { code: 'budget_exceeded', message: 'This would exceed your budget.' };
  return {
    setRemaining(usd) {
      remaining = usd;
    },
    async precheck(): Promise<PrecheckResult> {
      return remaining !== null && spent() >= remaining ? { ok: false, error: exceeded } : { ok: true, warning: null };
    },
    tryReserve(req): ReserveAttempt {
      if (req.purpose === 'chat' || req.reserveUsd === null) return { status: 'reserved', reservation: make(req, 0) };
      if (remaining === null) return { status: 'reserved', reservation: make(req, req.reserveUsd) };
      const free = remaining - spent();
      if (req.reserveUsd + sum() <= free) return { status: 'reserved', reservation: make(req, req.reserveUsd) };
      if (req.reserveUsd <= free) return { status: 'wait' };
      return { status: 'refused', error: exceeded };
    },
    outstandingUsd: sum,
    count: () => outstanding.size,
    onRelease(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ─── Thread ledger ────────────────────────────────────────────────────────────────────────────────────────────

export interface FakeLedgerRow {
  kind: 'agent';
  modelId: string;
  usd: number;
  ref: string;
}

/** In-memory ledger (no file); settled turns become `rows` (one per model), like the real ledger's agent rows. */
export function fakeThreadLedger(clock: Pick<GatewayClock, 'now'> = { now: () => Date.now() }): ThreadLedger & { rows: FakeLedgerRow[] } {
  const threads = new Map<string, { caps: ThreadCapsRecord; spent: number; turns: Map<string, number>; unflushed: Map<string, Map<string, number>> }>();
  const rows: FakeLedgerRow[] = [];
  const thread = (id: string) => {
    let t = threads.get(id);
    if (!t) {
      t = { caps: { perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: CODE_DEFAULTS.perThreadUsd, approvedAt: null }, spent: 0, turns: new Map(), unflushed: new Map() };
      threads.set(id, t);
    }
    return t;
  };
  const tighter = (stored: number | null, proposed: number | null) => (proposed !== null && (stored === null || proposed < stored) ? proposed : stored);
  const unflushedTotal = () => {
    let sum = 0;
    for (const t of threads.values()) for (const byModel of t.unflushed.values()) for (const usd of byModel.values()) sum += usd;
    return sum;
  };
  const source: SpendSource = { kind: 'agent', totalSince: () => unflushedTotal(), burnUsdPerHour: () => 0 };
  const flushTurn = (threadId: string, turnKey: string) => {
    const t = threads.get(threadId);
    const byModel = t?.unflushed.get(turnKey);
    if (!t || !byModel) return;
    for (const [modelId, usd] of byModel) rows.push({ kind: 'agent', modelId, usd, ref: `thr:${threadId}/turn:${turnKey}` });
    t.unflushed.delete(turnKey);
  };
  return {
    rows,
    source,
    load: async () => undefined,
    spend(threadId, turnId) {
      const t = threads.get(threadId);
      return { threadUsd: t?.spent ?? 0, turnUsd: (turnId ? t?.turns.get(turnId) : 0) ?? 0 };
    },
    caps: (threadId) => ({ ...thread(threadId).caps }),
    setCaps(threadId, caps: ThreadCaps) {
      const t = thread(threadId);
      t.caps = { ...t.caps, perTurnUsd: tighter(t.caps.perTurnUsd, caps.perTurnUsd), perThreadUsd: tighter(t.caps.perThreadUsd, caps.perThreadUsd) };
      return { ...t.caps };
    },
    approveCaps(threadId, caps) {
      const t = thread(threadId);
      t.caps = { perTurnUsd: caps.perTurnUsd, perThreadUsd: caps.perThreadUsd, approvedAt: new Date(clock.now()).toISOString() };
      return { ...t.caps };
    },
    add(charge: ThreadSpendCharge) {
      const t = thread(charge.threadId);
      const usd = Math.max(0, charge.usd);
      t.spent += usd;
      const turnKey = charge.turnId ?? '-';
      t.turns.set(turnKey, (t.turns.get(turnKey) ?? 0) + usd);
      const byModel = t.unflushed.get(turnKey) ?? new Map<string, number>();
      byModel.set(charge.modelId, (byModel.get(charge.modelId) ?? 0) + usd);
      t.unflushed.set(turnKey, byModel);
    },
    settleTurn: flushTurn,
    async flush() {
      for (const [id, t] of threads) for (const turn of [...t.unflushed.keys()]) flushTurn(id, turn);
    },
    dispose: async () => undefined,
  };
}

// ─── Runs ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The §4.4 validation rules over an in-memory run table. */
export function fakeRunRegistry(clock: Pick<GatewayClock, 'now'> = { now: () => Date.now() }): RunRegistry {
  const runs = new Map<string, TrackedRun>();
  const listeners = new Set<(run: TrackedRun) => void>();
  const refuse = (message: string): GmiErrorShape => ({ code: 'invalid_input', message });
  return {
    open(scope) {
      runs.set(scope.runId, { ...scope, openedAt: clock.now() });
    },
    close(runId) {
      const run = runs.get(runId) ?? null;
      if (run) {
        runs.delete(runId);
        for (const l of [...listeners]) l(run);
      }
      return run;
    },
    get: (runId) => runs.get(runId) ?? null,
    list: () => [...runs.values()],
    validateRequest(req, owner) {
      if (owner) {
        if (!(HOST_PURPOSES as readonly string[]).includes(req.purpose)) return refuse(`Purpose ${req.purpose} is not allowed from the harness.`);
        if (PRIORITY_RANK[req.priority] > PRIORITY_RANK[MAX_HOST_PRIORITY]) return refuse(`Priority ${req.priority} is not allowed from the harness.`);
      }
      if ((MAIN_PURPOSES as readonly string[]).includes(req.purpose)) return owner ? refuse(`Purpose ${req.purpose} is main's own.`) : null;
      const { threadId, turnId, runId } = req.scope;
      const run = runId ? runs.get(runId) : undefined;
      if (!run || run.threadId !== threadId || run.turnId !== turnId) return refuse('The run is not running.');
      return null;
    },
    onClose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * No TPM, concurrency or priorities: admits in FIFO order whenever the breaker and the gate allow it and the
 * ticket's reserve() says so; `wait` keeps it queued(budget) until wake(). Requeue keeps the original position.
 */
export function fakeScheduler(deps: { breaker?: Pick<Breaker, 'tryAcquire' | 'record'>; connectivity?: Pick<ConnectivityGate, 'online'>; clock?: Pick<GatewayClock, 'now'> } = {}): Scheduler & { enqueued: SchedulerTicket[]; rateLimits: Array<{ modelKey: string; retryAfterSec: number | null }> } {
  const clock = deps.clock ?? { now: () => Date.now() };
  interface Entry {
    seq: number;
    ticket: SchedulerTicket;
    queuedAt: number;
    queuedMs: number;
    eligibleAt: number;
    resolve: (r: AdmitResult) => void;
    listeners: Set<(q: QueuedInfo) => void>;
    lastReason: QueuedInfo['reason'] | null;
    done: boolean;
  }
  let seq = 0;
  let tpmLimit: number = GATEWAY_TPM_TIERS.t1;
  let inFlight = 0;
  const queue: Entry[] = [];
  const inFlightByModel: Record<string, number> = {};
  const sched = {
    enqueued: [] as SchedulerTicket[],
    rateLimits: [] as Array<{ modelKey: string; retryAfterSec: number | null }>,
  };
  const handleFor = (entry: Entry): SchedulerHandle => ({
    result: new Promise<AdmitResult>((resolve) => {
      entry.resolve = resolve;
    }),
    onQueued(listener) {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    cancel() {
      if (entry.done) return;
      entry.done = true;
      queue.splice(queue.indexOf(entry), 1);
      entry.resolve({ status: 'cancelled' });
    },
  });
  const notify = (entry: Entry, reason: QueuedInfo['reason']) => {
    if (entry.lastReason === reason) return;
    entry.lastReason = reason;
    const info: QueuedInfo = { position: queue.indexOf(entry), etaMs: null, reason };
    for (const l of [...entry.listeners]) l(info);
  };
  const admit = (entry: Entry) => {
    const now = clock.now();
    if (now < entry.eligibleAt) return;
    if (deps.connectivity && !deps.connectivity.online()) return notify(entry, 'offline');
    if (deps.breaker && !deps.breaker.tryAcquire(entry.ticket.modelKey, { force: entry.ticket.forceProbe })) return notify(entry, 'breaker');
    const attempt = entry.ticket.reserve();
    // Not admitted after all: give the breaker its acquisition back (a half-open probe slot).
    if (attempt.status !== 'reserved') deps.breaker?.record(entry.ticket.modelKey, 'neutral');
    if (attempt.status === 'wait') return notify(entry, 'budget');
    entry.done = true;
    queue.splice(queue.indexOf(entry), 1);
    if (attempt.status === 'refused') return entry.resolve({ status: 'refused', error: attempt.error });
    const key = entry.ticket.modelKey;
    inFlight += 1;
    inFlightByModel[key] = (inFlightByModel[key] ?? 0) + 1;
    let released = false;
    const free = () => {
      if (released) return false;
      released = true;
      inFlight -= 1;
      inFlightByModel[key] = (inFlightByModel[key] ?? 1) - 1;
      attempt.reservation.release();
      return true;
    };
    const slot: SchedulerSlot = {
      requestId: entry.ticket.requestId,
      reservation: attempt.reservation,
      queuedMs: entry.queuedMs + (now - entry.queuedAt),
      release: () => {
        free();
      },
      requeue({ delayMs }) {
        free();
        const again: Entry = { ...entry, queuedAt: clock.now(), queuedMs: slot.queuedMs, eligibleAt: clock.now() + delayMs, listeners: new Set(), lastReason: null, done: false, resolve: () => undefined };
        const handle = handleFor(again);
        const at = queue.findIndex((e) => e.seq > again.seq);
        queue.splice(at === -1 ? queue.length : at, 0, again);
        queueMicrotask(() => wake());
        return handle;
      },
    };
    entry.resolve({ status: 'admitted', slot });
  };
  const wake = () => {
    for (const entry of [...queue]) if (!entry.done) admit(entry);
  };
  return Object.assign(sched, {
    enqueue(ticket: SchedulerTicket): SchedulerHandle {
      sched.enqueued.push(ticket);
      seq += 1;
      const entry: Entry = { seq, ticket, queuedAt: clock.now(), queuedMs: 0, eligibleAt: 0, resolve: () => undefined, listeners: new Set(), lastReason: null, done: false };
      const handle = handleFor(entry);
      queue.push(entry);
      queueMicrotask(() => {
        if (!entry.done) admit(entry);
      });
      return handle;
    },
    report429(modelKey: string, retryAfterSec: number | null) {
      sched.rateLimits.push({ modelKey, retryAfterSec });
    },
    setTpmLimit(limit: number) {
      tpmLimit = limit;
    },
    wake,
    stats: () => ({ tpmLimit, tpmEffective: tpmLimit, tpmUsedLastMinute: 0, queued: queue.length, inFlight, inFlightByModel: { ...inFlightByModel }, last429At: null }),
    dispose: () => undefined,
  });
}

// ─── Retry, breaker, connectivity ─────────────────────────────────────────────────────────────────────────────

/** Fails everything (no retries) unless `decide` is given; watchdogs per GATEWAY_LIMITS. */
export function fakeRetryPolicy(decide?: (failure: AttemptFailure, ctx: RetryContext) => RetryDecision): RetryPolicy & { asked: Array<{ failure: AttemptFailure; ctx: RetryContext }> } {
  const w = GATEWAY_LIMITS.watchdog;
  const policy = {
    asked: [] as Array<{ failure: AttemptFailure; ctx: RetryContext }>,
    decide(failure: AttemptFailure, ctx: RetryContext): RetryDecision {
      policy.asked.push({ failure, ctx });
      if (decide) return decide(failure, ctx);
      const status = failure.kind === 'http' ? failure.status : null;
      const code = failure.kind === 'network' ? 'network' : failure.kind === 'http' ? (status === 429 ? 'rate_limited' : status !== null && status >= 500 ? 'upstream' : 'invalid_input') : 'timeout';
      return { action: 'fail', error: { code, message: 'fake failure', status }, maybeBilled: false, countsForBreaker: false, reportInvalidKey: status === 401 };
    },
    watchdogs: (promptTokens: number) => ({ firstByteMs: w.firstByteBaseMs + Math.floor(promptTokens / 10_000) * w.firstBytePerTenKPromptMs, idleMs: w.idleMs, totalMs: w.totalMs }),
    backoffMs: (n: number) => Math.min(GATEWAY_LIMITS.retry.backoffCapMs, GATEWAY_LIMITS.retry.backoffBaseMs * GATEWAY_LIMITS.retry.backoffFactor ** n),
  };
  return policy;
}

/** The §4.6 breaker on a (fake) clock: 5 failures in 60 s → open 30 s → half-open probe → closed / open ×2 (≤ 5 min). */
export function fakeBreaker(clock: GatewayClock): Breaker & { recorded: Array<{ modelKey: string; outcome: BreakerOutcome }> } {
  const b = GATEWAY_LIMITS.breaker;
  const models = new Map<string, { failures: number[]; state: BreakerState; reopenAt: number; openMs: number; probe: boolean }>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const l of [...listeners]) l();
  };
  const get = (key: string) => {
    let m = models.get(key);
    if (!m) {
      m = { failures: [], state: 'closed', reopenAt: 0, openMs: b.openMs, probe: false };
      models.set(key, m);
    }
    if (m.state === 'open' && clock.now() >= m.reopenAt) m.state = 'half_open';
    return m;
  };
  const open = (m: ReturnType<typeof get>, openMs: number) => {
    m.state = 'open';
    m.openMs = openMs;
    m.reopenAt = clock.now() + openMs;
    m.failures = [];
    changed();
  };
  const breaker = {
    recorded: [] as Array<{ modelKey: string; outcome: BreakerOutcome }>,
    state: (key: string) => get(key).state,
    tryAcquire(key: string, opts?: { force?: boolean }) {
      const m = get(key);
      if (m.state === 'open' && opts?.force) m.state = 'half_open';
      if (m.state === 'closed') return true;
      if (m.state === 'half_open' && !m.probe) {
        m.probe = true;
        return true;
      }
      return false;
    },
    record(key: string, outcome: BreakerOutcome) {
      breaker.recorded.push({ modelKey: key, outcome });
      const m = get(key);
      const wasProbe = m.state === 'half_open' && m.probe;
      if (wasProbe) m.probe = false;
      if (outcome === 'neutral') return;
      if (outcome === 'success') {
        if (wasProbe) {
          m.state = 'closed';
          m.openMs = b.openMs;
          changed();
        }
        return;
      }
      if (wasProbe) return open(m, Math.min(b.maxOpenMs, m.openMs * 2));
      const now = clock.now();
      m.failures = [...m.failures.filter((t) => now - t < b.windowMs), now];
      if (m.failures.length >= b.failures) open(m, b.openMs);
    },
    snapshot() {
      return [...models.keys()]
        .map((key) => ({ key, m: get(key) }))
        .filter(({ m }) => m.state !== 'closed')
        .map(({ key, m }) => ({ modelKey: key, breaker: m.state, reopenAt: m.state === 'open' ? new Date(m.reopenAt).toISOString() : null }));
    },
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => listeners.clear(),
  };
  return breaker;
}

/** A gate the test opens and closes by hand (setOnline), plus the report calls it received. */
export function fakeConnectivity(initial = true): ConnectivityGate & { setOnline(online: boolean): void; failures: Array<string | null>; responses: number } {
  let online = initial;
  const listeners = new Set<(online: boolean) => void>();
  const gate = {
    failures: [] as Array<string | null>,
    responses: 0,
    setOnline(value: boolean) {
      if (value === online) return;
      online = value;
      for (const l of [...listeners]) l(online);
    },
    online: () => online,
    reportNetworkFailure(errno: string | null) {
      gate.failures.push(errno);
    },
    reportResponse() {
      gate.responses += 1;
    },
    onChange(listener: (online: boolean) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => listeners.clear(),
  };
  return gate;
}

// ─── Trace and status ─────────────────────────────────────────────────────────────────────────────────────────

export function fakeTrace(): GatewayTrace & { records: GatewayTraceRecord[] } {
  const records: GatewayTraceRecord[] = [];
  return {
    records,
    record(r) {
      records.unshift(r);
      records.length = Math.min(records.length, GATEWAY_LIMITS.traceRing);
    },
    recent: (limit = records.length) => records.slice(0, limit),
  };
}

export function fakeStatusSnapshot(over: Partial<GatewayStatus> = {}): GatewayStatus {
  return {
    online: true,
    tpmLimit: GATEWAY_TPM_TIERS.t1,
    tpmEffective: GATEWAY_TPM_TIERS.t1,
    tpmUsedLastMinute: 0,
    queued: 0,
    inFlight: 0,
    models: [],
    cacheHitRatio24h: null,
    last429At: null,
    updatedAt: '2026-11-02T10:00:00.000Z',
    ...over,
  };
}

/** Unthrottled: every changed() calls the listeners with the current snapshot (`set` replaces it). */
export function fakeStatus(initial: GatewayStatus = fakeStatusSnapshot()): GatewayStatusTracker & { set(status: Partial<GatewayStatus>): void; changes: number } {
  let current = initial;
  const listeners = new Set<(s: GatewayStatus) => void>();
  const tracker = {
    changes: 0,
    set(status: Partial<GatewayStatus>) {
      current = { ...current, ...status };
    },
    snapshot: () => current,
    changed() {
      tracker.changes += 1;
      for (const l of [...listeners]) l(current);
    },
    onChange(listener: (s: GatewayStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => listeners.clear(),
  };
  return tracker;
}

/** Every part as a fake, wired to one fake clock (the meter charges the fake thread ledger). */
export function fakeParts(opts: { clock?: FakeClock; models?: Parameters<typeof fakeResolver>[0]; remainingUsd?: number | null } = {}) {
  const clock = opts.clock ?? fakeClock();
  const threads = fakeThreadLedger(clock);
  const breaker = fakeBreaker(clock);
  const connectivity = fakeConnectivity();
  const parts = {
    resolver: fakeResolver(opts.models ?? { 'zai-org/GLM-5.3': {}, 'deepseek-ai/DeepSeek-V4-Flash': { pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28, cacheReadPerMTok: 0.028, cacheWritePerMTok: null } } }),
    estimator: fakeEstimator(),
    meter: fakeMeter(threads),
    reservations: fakeReservations({ remainingUsd: opts.remainingUsd ?? null }),
    threads,
    runs: fakeRunRegistry(clock),
    scheduler: fakeScheduler({ breaker, connectivity, clock }),
    retry: fakeRetryPolicy(),
    breaker,
    connectivity,
    trace: fakeTrace(),
    status: fakeStatus(),
    clock,
  } satisfies GatewayParts;
  return parts;
}

// ─── A scripted GmiGateway (for chat / harness tests) ─────────────────────────────────────────────────────────

export interface ScriptedGateway extends GmiGateway {
  /** Every stream() call: the request and its owner. */
  requests: Array<{ req: GatewayRequest; owner: { hostId: string } | null }>;
  /** Events for the next stream() calls, in order; when empty, `fallback(req)` is used. */
  script: GatewayEvent[][];
  aborted: string[];
  runs: Map<string, { threadId: string; turnId: string; runId: string }>;
  caps: Map<string, ThreadCaps>;
  status(): GatewayStatus;
}

export function usageEvent(usage: Partial<TokenUsage> = {}, over: Partial<MeteredUsage> = {}): GatewayEvent {
  const promptTokens = usage.promptTokens ?? 100;
  const completionTokens = usage.completionTokens ?? 20;
  return {
    type: 'usage',
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens: usage.reasoningTokens ?? null, cachedTokens: usage.cachedTokens ?? null },
    cacheWriteTokens: null,
    costUsd: 0.0001,
    estimated: false,
    maybeBilled: false,
    ...over,
  };
}

/** A reply: started, the text in chunks, usage, finish (stop). */
export function replyEvents(text: string, opts: { model?: string; chunk?: number } = {}): GatewayEvent[] {
  const chunk = opts.chunk ?? 8;
  const out: GatewayEvent[] = [{ type: 'started', attempt: 1, model: opts.model ?? null, api: 'chat' }];
  for (let i = 0; i < text.length; i += chunk) out.push({ type: 'text', text: text.slice(i, i + chunk) });
  out.push(usageEvent(), { type: 'finish', reason: 'stop', raw: 'stop' });
  return out;
}

/**
 * Plays `script` (or `fallback`) per request. Honours the GmiGateway contract: never throws for upstream
 * failures (only invalid_input), stops at an abort (signal or abortOwner) with a `cancelled` error event.
 */
export function scriptedGateway(fallback: (req: GatewayRequest) => GatewayEvent[] = () => replyEvents('Hello from the fake gateway.')): ScriptedGateway {
  const owners = new Map<string, Set<AbortController>>();
  const gw: ScriptedGateway = {
    requests: [],
    script: [],
    aborted: [],
    runs: new Map(),
    caps: new Map(),
    async *stream(req, signal, owner = null) {
      if (!req || typeof req.requestId !== 'string' || !Array.isArray(req.messages)) throw new GmiError('invalid_input', 'Invalid gateway request.');
      gw.requests.push({ req, owner });
      const events = gw.script.shift() ?? fallback(req);
      const local = new AbortController();
      const onAbort = () => local.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      if (owner) {
        const set = owners.get(owner.hostId) ?? new Set();
        set.add(local);
        owners.set(owner.hostId, set);
      }
      try {
        for (const event of events) {
          await Promise.resolve();
          if (local.signal.aborted || signal.aborted) {
            gw.aborted.push(req.requestId);
            yield { type: 'error', error: { code: 'cancelled', message: 'Cancelled.' }, afterOutput: false };
            return;
          }
          yield event;
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (owner) owners.get(owner.hostId)?.delete(local);
      }
    },
    estimate: (req) => ({ promptTokens: req.messages.length * 10, expectedCachedTokens: 0, reserveUsd: 0.001, expectedUsd: 0.001 }),
    status: () => fakeStatusSnapshot(),
    abortOwner(hostId) {
      for (const c of owners.get(hostId) ?? []) c.abort();
    },
    openRun(scope) {
      gw.runs.set(scope.runId, scope);
    },
    closeRun(runId) {
      gw.runs.delete(runId);
    },
    setThreadCaps(threadId, caps) {
      const cur = gw.caps.get(threadId) ?? { perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: CODE_DEFAULTS.perThreadUsd };
      const tighter = (a: number | null, b: number | null) => (b !== null && (a === null || b < a) ? b : a);
      gw.caps.set(threadId, { perTurnUsd: tighter(cur.perTurnUsd, caps.perTurnUsd), perThreadUsd: tighter(cur.perThreadUsd, caps.perThreadUsd) });
    },
    approveThreadCaps(threadId, caps) {
      gw.caps.set(threadId, { ...caps });
    },
    threadSpend: () => ({ turnUsd: 0, threadUsd: 0 }),
  };
  return gw;
}
