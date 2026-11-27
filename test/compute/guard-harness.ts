// Fakes for the C1-D cost guard tests: an in-memory Registry, a Supervisor with a controllable GMI clock, recording
// ResourceActions, a PriceBook, and the real usage BudgetService (ledger + BudgetSources) over a temp dir.
import { join } from 'node:path';
import type { ComputeApiHealth, ComputePhase, LeasePolicy } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Budget } from '@shared/contracts/usage';
import { createBudgetService, type BudgetService } from '@main/services/usage/budget';
import { openSpendLedger } from '@main/services/usage/ledger';
import { createComputeGuard, type ComputeGuard, type GuardDeps } from '@main/services/compute/guard';
import type {
  ComputeRecord,
  GuardCause,
  PhaseTransition,
  PriceBook,
  PriceInfo,
  Registry,
  ResourceActions,
  Supervisor,
} from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';

/** A mutable clock: `local` is the machine's clock, `server` GMI's (null until a GMI response was seen). */
export function testClock(start: Date) {
  const state = { local: start.getTime(), skew: null as number | null };
  return {
    state,
    now: () => new Date(state.local),
    advance(ms: number) {
      state.local += ms;
    },
    set(d: Date) {
      state.local = d.getTime();
    },
  };
}

export function record(over: Partial<ComputeRecord> & { id: string }): ComputeRecord {
  const kind = over.kind ?? 'sandbox';
  return {
    kind,
    backend: kind === 'container' ? 'ce' : 'sandbox_v2',
    remoteId: `remote-${over.id}`,
    name: `gmid-abcdef-${over.id}-x7k2p9`,
    displayName: over.id,
    managed: true,
    installTag: 'abcdef',
    purpose: kind === 'sandbox' ? 'computer' : null,
    threadId: null,
    idc: 'test-idc',
    sku: kind === 'container' ? 'gmi.container.test' : 'gmi.sandbox.small',
    templateId: null,
    templateName: null,
    snapshotId: null,
    listUsdPerHour: 1,
    phase: 'running',
    rawState: 'running',
    reason: null,
    requestedAt: null,
    createdAt: null,
    runningSince: null,
    serverEndsAt: null,
    pausedAt: null,
    pausedExpiresAt: null,
    lastSeenAt: null,
    lease: null,
    approvedMaxLifetimeMin: null,
    leaseChangedAt: null,
    intervals: [],
    eipIntervals: [],
    actionPending: null,
    inflightExecs: [],
    services: [],
    network: null,
    logsRangeSupported: null,
    envNames: [],
    command: null,
    args: [],
    sshKeyNames: [],
    secure: null,
    egressLocked: null,
    lastError: null,
    history: [],
    tombstone: null,
    updatedAt: new Date(0).toISOString(),
    ...over,
  };
}

export const SANDBOX_LEASE: LeasePolicy = { maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 20, extendOnActivity: true, onBudget: 'pause' };
export const CONTAINER_LEASE: LeasePolicy = { maxLifetimeMin: 240, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' };

export function fakeRegistry(initial: ComputeRecord[] = []) {
  const map = new Map(initial.map((r) => [r.id, structuredClone(r)]));
  const listeners = new Set<(ids: string[]) => void>();
  const writes: string[] = [];
  const touch = (id: string) => {
    writes.push(id);
    for (const l of listeners) l([id]);
  };
  const registry: Registry = {
    async load() {},
    list: (opts) => [...map.values()].filter((r) => opts?.includeTombstones || r.tombstone === null).map((r) => structuredClone(r)),
    get: (id) => (map.has(id) ? structuredClone(map.get(id)!) : null),
    findByRemote: (backend, remoteId) => [...map.values()].find((r) => r.backend === backend && r.remoteId === remoteId) ?? null,
    findByName: (name) => [...map.values()].find((r) => r.name === name) ?? null,
    async add(r) {
      map.set(r.id, structuredClone(r));
      touch(r.id);
      return r;
    },
    async update(id, mutate) {
      const cur = map.get(id);
      if (!cur) throw new GmiError('not_found', 'unknown resource');
      const next = mutate(structuredClone(cur));
      map.set(id, structuredClone(next));
      touch(id);
      return next;
    },
    async tombstone(id, at, reason) {
      return registry.update(id, (r) => ({
        ...r,
        phase: 'deleted',
        tombstone: { at, reason },
        intervals: r.intervals.map((i) => (i.to === null ? { ...i, to: at } : i)),
      }));
    },
    async setActionPending(id, pending) {
      return registry.update(id, (r) => ({ ...r, actionPending: pending }));
    },
    inflightExecs: () => [],
    async addInflightExec() {},
    async removeInflightExec() {},
    onChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async flush() {},
  };
  return { registry, map, writes, set: (r: ComputeRecord) => map.set(r.id, structuredClone(r)) };
}

export function fakeSupervisor(clock: ReturnType<typeof testClock>) {
  const transitionListeners = new Set<(t: PhaseTransition) => void>();
  const fresh = new Map<string, string>();
  const pending = new Map<string, string>();
  const health = { ce: 'ok' as ComputeApiHealth, sandbox: 'ok' as ComputeApiHealth };
  let polls = 0;
  const supervisor: Supervisor = {
    start() {},
    async stop() {},
    async pollNow() {
      polls++;
    },
    watch() {},
    setHints() {},
    async withResourceLock(_id, _action, fn) {
      return fn();
    },
    pendingAction: (id) => (pending.get(id) as ReturnType<Supervisor['pendingAction']>) ?? null,
    freshSince: (id) => fresh.get(id) ?? null,
    clock: {
      now: () => new Date(clock.state.local + (clock.state.skew ?? 0)),
      skewMs: () => clock.state.skew,
      verified: () => clock.state.skew !== null,
    },
    health: () => ({ ...health }),
    onTransition(l) {
      transitionListeners.add(l);
      return () => transitionListeners.delete(l);
    },
  };
  return {
    supervisor,
    health,
    pending,
    get polls() {
      return polls;
    },
    /** GMI's Date header was seen: server time = local + skew. */
    verify(skewMs = 0) {
      clock.state.skew = skewMs;
    },
    markFresh(id: string) {
      fresh.set(id, supervisor.clock.now().toISOString());
    },
    emit(t: PhaseTransition) {
      for (const l of transitionListeners) l(t);
    },
  };
}

export function transition(over: Partial<PhaseTransition> & { resourceId: string; to: ComputePhase; at: string }): PhaseTransition {
  return {
    kind: 'sandbox',
    backend: 'sandbox_v2',
    from: null,
    rawState: over.to,
    remote: { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: null },
    source: 'poll',
    ...over,
  };
}

export function fakeActions() {
  const calls: Array<{ action: 'pause' | 'delete' | 'extend'; id: string; cause: GuardCause | 'activity'; seconds?: number }> = [];
  const fail = { pause: null as Error | null, delete: null as Error | null, extend: null as Error | null };
  let extendResult: (seconds: number) => string = (s) => new Date(Date.now() + s * 1000).toISOString();
  const actions: ResourceActions = {
    async pause(id, cause) {
      calls.push({ action: 'pause', id, cause });
      if (fail.pause) throw fail.pause;
    },
    async delete(id, cause) {
      calls.push({ action: 'delete', id, cause });
      if (fail.delete) throw fail.delete;
    },
    async extendServerTimeout(id, seconds, cause) {
      calls.push({ action: 'extend', id, cause, seconds });
      if (fail.extend) throw fail.extend;
      return extendResult(seconds);
    },
  };
  return {
    actions,
    calls,
    fail,
    setExtendResult(fn: (seconds: number) => string) {
      extendResult = fn;
    },
  };
}

export function fakePrices(table: Record<string, number | null> = {}, fetchedAt: string | null = null): PriceBook & { calls: number } {
  const book = {
    calls: 0,
    price(sku: string): PriceInfo {
      book.calls++;
      const usd = sku in table ? (table[sku] ?? null) : null;
      return { usdPerHour: usd, fetchedAt, source: 'public_feed' };
    },
  };
  return book;
}

export interface GuardHarness {
  t: TestContext;
  clock: ReturnType<typeof testClock>;
  reg: ReturnType<typeof fakeRegistry>;
  sup: ReturnType<typeof fakeSupervisor>;
  act: ReturnType<typeof fakeActions>;
  prices: ReturnType<typeof fakePrices>;
  budget: BudgetService;
  guard: ComputeGuard;
  cleanup(): Promise<void>;
}

export async function guardHarness(opts: {
  now: Date;
  records?: ComputeRecord[];
  budget?: Partial<Budget>;
  prices?: Record<string, number | null>;
  pricesFetchedAt?: string | null;
  extra?: Partial<GuardDeps>;
}): Promise<GuardHarness> {
  const clock = testClock(opts.now);
  const t = await createTestContext({ now: clock.now });
  const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: clock.now });
  const budget = await createBudgetService({ ctx: t.ctx, ledger });
  if (opts.budget) await budget.setBudget(opts.budget);
  const reg = fakeRegistry(opts.records ?? []);
  const sup = fakeSupervisor(clock);
  const act = fakeActions();
  const prices = fakePrices(opts.prices ?? { 'gmi.sandbox.small': 0.0911, 'gmi.container.test': 3.35, 'gmi.eip.test': 0.1 }, opts.pricesFetchedAt ?? opts.now.toISOString());
  const guard = createComputeGuard({
    ctx: t.ctx,
    registry: reg.registry,
    supervisor: sup.supervisor,
    actions: act.actions,
    prices,
    budget: budget.guard,
    budgetSources: budget.sources,
    ...opts.extra,
  });
  return {
    t,
    clock,
    reg,
    sup,
    act,
    prices,
    budget,
    guard,
    async cleanup() {
      await guard.stop();
      budget.dispose();
      await t.cleanup();
    },
  };
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
