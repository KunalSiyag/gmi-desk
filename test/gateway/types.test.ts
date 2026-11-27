// H1-0: the gateway's internal interfaces (src/main/services/gateway/types.ts), the conforming fakes H1-A/B/C test
// with (test/gateway/fakes.ts), the shared contract checks (test/gateway/contracts.ts) and the registration
// (src/main/slices/gateway.ts).
import { describe, expect, it } from 'vitest';
import { GATEWAY_TPM_TIERS, type GatewayRequest, type GatewayStatus } from '@shared/contracts/gateway';
import type { BudgetGuard, BudgetSources, CatalogService, GmiGateway, KeyProvider, SliceHost, SpendSource } from '@main/core/services';
import {
  AGENT_PURPOSES,
  BREAKER_OPEN_DETAIL,
  GATEWAY_LIMITS,
  HOST_PURPOSES,
  MAIN_PURPOSES,
  MAX_HOST_PRIORITY,
  PRIORITY_RANK,
  routerModelKey,
  systemClock,
  type Breaker,
  type ConnectivityGate,
  type Estimator,
  type GatewayFactory,
  type GatewayFactoryDeps,
  type GatewayParts,
  type GatewayRuntime,
  type GatewayStatusTracker,
  type GatewayTrace,
  type Meter,
  type ModelResolver,
  type Reservations,
  type RetryPolicy,
  type RunRegistry,
  type Scheduler,
  type ThreadLedger,
  type ThreadSpendCharge,
} from '@main/services/gateway/types';
import { alwaysOnlineSignals, gatewayTpmLimit, notImplementedGateway, notImplementedGatewayFactory, setupGatewaySlice } from '@main/slices/gateway';
import { createTestContext } from '../helpers/context';
import {
  describeBreakerContract,
  describeEstimatorContract,
  describeMeterContract,
  describeReservationsContract,
  describeRunRegistryContract,
  describeSchedulerContract,
  describeThreadLedgerContract,
} from './contracts';
import {
  fakeBreaker,
  fakeClock,
  fakeConnectivity,
  fakeEstimator,
  fakeMeter,
  fakeParts,
  fakeReservations,
  fakeResolver,
  fakeRetryPolicy,
  fakeRunRegistry,
  fakeScheduler,
  fakeStatus,
  fakeStatusSnapshot,
  fakeThreadLedger,
  fakeTrace,
  replyEvents,
  scriptedGateway,
} from './fakes';

describe('gateway constants (harness.md §4.4–4.6)', () => {
  it('purposes: the host may send only agent purposes; chat / probe / eval are main\'s', () => {
    expect([...HOST_PURPOSES].sort()).toEqual(['agent', 'commit_message', 'compaction', 'subagent', 'title']);
    expect([...AGENT_PURPOSES]).toEqual([...HOST_PURPOSES]);
    expect([...MAIN_PURPOSES].sort()).toEqual(['chat', 'eval', 'probe']);
    expect(HOST_PURPOSES.some((p) => (MAIN_PURPOSES as readonly string[]).includes(p))).toBe(false);
  });

  it('priorities: interactive > foreground > background > idle; a host request is at most foreground', () => {
    expect(PRIORITY_RANK.interactive).toBeGreaterThan(PRIORITY_RANK.foreground);
    expect(PRIORITY_RANK.foreground).toBeGreaterThan(PRIORITY_RANK.background);
    expect(PRIORITY_RANK.background).toBeGreaterThan(PRIORITY_RANK.idle);
    expect(MAX_HOST_PRIORITY).toBe('foreground');
  });

  it('the limits are the design\'s numbers', () => {
    expect(GATEWAY_LIMITS).toMatchObject({
      maxMessages: 2_048,
      maxBodyBytes: 4 * 1024 * 1024,
      maxTools: 128,
      unknownMaxOutputTokens: 32_768,
      concurrency: { global: 16, perModel: 6, perThread: { agent: 1, subagent: 2, compaction: 1 } },
      tpm: { windowMs: 60_000, aimdFloor: 0.25, aimdDecrease: 0.7, aimdIncrease: 0.05, aimdQuietMs: 60_000 },
      agingStepMs: 30_000,
      headOfLineMaxWaitMs: 120_000,
      retry: { backoffBaseMs: 1_000, backoffFactor: 2, backoffCapMs: 20_000, maybeBilledRetries: 1, maybeBilledMaxPromptTokens: 32_000, rateLimitGiveUpMs: 600_000, rateLimitGiveUpInteractiveMs: 60_000 },
      watchdog: { firstByteBaseMs: 90_000, firstBytePerTenKPromptMs: 1_000, idleMs: 120_000, totalMs: 900_000 },
      breaker: { failures: 5, windowMs: 60_000, openMs: 30_000, maxOpenMs: 300_000 },
      agentFlushUsd: 0.1,
      agentFlushMs: 60_000,
      cacheTtlMs: 300_000,
      calibrationAlpha: 0.3,
      calibrationMin: 0.5,
      calibrationMax: 2.5,
      probeReserveCapUsd: 0.05,
      traceRing: 1_000,
    });
    expect(GATEWAY_LIMITS.eventBatchMinMs).toBeLessThanOrEqual(GATEWAY_LIMITS.eventBatchMaxMs);
    expect(BREAKER_OPEN_DETAIL).toBe('breaker_open');
    expect(routerModelKey('balanced')).toBe('router:balanced');
  });

  it('systemClock tells real time and its timers fire and clear', async () => {
    const before = Date.now();
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
    const r = systemClock.random();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    let fired = 0;
    const cleared = systemClock.setTimeout(() => (fired += 10), 1);
    systemClock.clearTimeout(cleared);
    await new Promise<void>((resolve) => systemClock.setTimeout(() => resolve(), 5));
    expect(fired).toBe(0);
  });
});

describe('fakes conform to the interfaces', () => {
  it('every fake is assignable to its interface, and fakeParts() is a GatewayParts', () => {
    const clock = fakeClock();
    // Compile-time conformance: these assignments fail `npm run typecheck` when an interface changes.
    const parts: GatewayParts = fakeParts({ clock });
    const resolver: ModelResolver = fakeResolver();
    const estimator: Estimator = fakeEstimator();
    const meter: Meter = fakeMeter();
    const reservations: Reservations = fakeReservations();
    const threads: ThreadLedger = fakeThreadLedger(clock);
    const runs: RunRegistry = fakeRunRegistry(clock);
    const scheduler: Scheduler = fakeScheduler();
    const retry: RetryPolicy = fakeRetryPolicy();
    const breaker: Breaker = fakeBreaker(clock);
    const connectivity: ConnectivityGate = fakeConnectivity();
    const trace: GatewayTrace = fakeTrace();
    const status: GatewayStatusTracker = fakeStatus();
    const gateway: GmiGateway = scriptedGateway();
    for (const part of [parts, resolver, estimator, meter, reservations, threads, runs, scheduler, retry, breaker, connectivity, trace, status, gateway]) {
      expect(part).toBeTruthy();
    }
    expect(Object.keys(parts).sort()).toEqual(
      ['breaker', 'clock', 'connectivity', 'estimator', 'meter', 'reservations', 'resolver', 'retry', 'runs', 'scheduler', 'status', 'threads', 'trace'].sort(),
    );
  });

  it('fakeClock fires timers in order, including ones scheduled while firing', () => {
    const clock = fakeClock(0);
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 20);
    clock.setTimeout(() => {
      fired.push('a');
      clock.setTimeout(() => fired.push('c'), 15);
    }, 10);
    const gone = clock.setTimeout(() => fired.push('x'), 5);
    clock.clearTimeout(gone);
    clock.advance(30);
    expect(fired).toEqual(['a', 'b', 'c']);
    expect(clock.now()).toBe(30);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('fakeResolver: listed models resolve with the capability clamp; the router is unpriced; unknown → null', () => {
    const r = fakeResolver({ 'zai-org/GLM-5.3': { capabilities: { maxOutputTokens: 8_192 } } });
    expect(r.resolve({ model: 'zai-org/GLM-5.3' }, 16_384)).toMatchObject({ model: 'zai-org/GLM-5.3', api: 'chat', modelKey: 'zai-org/GLM-5.3', maxOutputTokens: 8_192 });
    expect(r.resolve({ router: 'cost' }, 500)).toMatchObject({ model: null, api: 'router', modelKey: 'router:cost', pricing: null, maxOutputTokens: 500 });
    expect(r.resolve({ model: 'nope' }, 100)).toBeNull();
  });

  it('fakeRetryPolicy: watchdog scaling and capped backoff', () => {
    const p = fakeRetryPolicy();
    expect(p.watchdogs(0).firstByteMs).toBe(90_000);
    expect(p.watchdogs(120_000).firstByteMs).toBe(102_000);
    expect(p.backoffMs(10)).toBe(20_000);
    expect(p.decide({ kind: 'http', status: 401, retryAfterSec: null, code: null, message: 'no' }, { purpose: 'chat', priority: 'interactive', promptTokens: 1, attempt: 1, maybeBilledRetries: 0, notBilledRequeues: 0, rateLimitedSince: null, afterOutput: false, now: 0 })).toMatchObject({ action: 'fail', reportInvalidKey: true });
  });
});

// Shared contract checks on the fakes (H1-A / H1-B run the same ones on their implementations).
describeRunRegistryContract('fakeRunRegistry', () => fakeRunRegistry());
describeBreakerContract('fakeBreaker', (clock) => fakeBreaker(clock));
describeThreadLedgerContract('fakeThreadLedger', async () => {
  const ledger = fakeThreadLedger();
  return { ledger, rows: () => ledger.rows };
});
describeReservationsContract('fakeReservations', ({ remainingUsd }) => fakeReservations({ remainingUsd }));
describeEstimatorContract('fakeEstimator', () => fakeEstimator());
describeMeterContract('fakeMeter', () => {
  const charges: ThreadSpendCharge[] = [];
  return { meter: fakeMeter({ add: (c) => charges.push(c) }), threadCharges: () => charges };
});
describeSchedulerContract('fakeScheduler', ({ breaker, connectivity, clock }) => fakeScheduler({ breaker, connectivity, clock }), (clock) => fakeBreaker(clock));

describe('scriptedGateway (the fake GmiGateway for chat and harness tests)', () => {
  const req = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
    requestId: 'q1',
    purpose: 'chat',
    priority: 'interactive',
    scope: { threadId: null, turnId: null, runId: null, step: null },
    target: { model: 'zai-org/GLM-5.3' },
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 100,
    prefixHash: null,
    ...over,
  });
  const collect = async (it: AsyncIterable<unknown>) => {
    const out: unknown[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it('plays the script, ending with usage then finish', async () => {
    const gw = scriptedGateway();
    gw.script.push(replyEvents('Hello there', { chunk: 5 }));
    const events = (await collect(gw.stream(req(), new AbortController().signal))) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toEqual(['started', 'text', 'text', 'text', 'usage', 'finish']);
    expect(gw.requests).toHaveLength(1);
  });

  it('an abort (signal or abortOwner) ends with a cancelled error instead of throwing', async () => {
    const gw = scriptedGateway(() => replyEvents('x'.repeat(200), { chunk: 1 }));
    const ctl = new AbortController();
    const seen: Array<{ type: string }> = [];
    for await (const e of gw.stream(req(), ctl.signal)) {
      seen.push(e);
      if (seen.length === 3) ctl.abort();
    }
    expect(seen.at(-1)).toMatchObject({ type: 'error', error: { code: 'cancelled' } });

    const owned: Array<{ type: string }> = [];
    for await (const e of gw.stream(req({ requestId: 'q2', purpose: 'agent' }), new AbortController().signal, { hostId: 'h1' })) {
      owned.push(e);
      if (owned.length === 2) gw.abortOwner('h1');
    }
    expect(owned.at(-1)).toMatchObject({ type: 'error', error: { code: 'cancelled' } });
    expect(gw.aborted).toEqual(['q1', 'q2']);
  });

  it('throws only invalid_input; caps only tighten through setThreadCaps', async () => {
    const gw = scriptedGateway();
    await expect(collect(gw.stream({} as GatewayRequest, new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
    gw.setThreadCaps('t', { perTurnUsd: 9, perThreadUsd: 2 });
    expect(gw.caps.get('t')).toEqual({ perTurnUsd: 1, perThreadUsd: 2 });
    gw.approveThreadCaps('t', { perTurnUsd: 9, perThreadUsd: null });
    expect(gw.caps.get('t')).toEqual({ perTurnUsd: 9, perThreadUsd: null });
  });
});

describe('gateway registration (slices/gateway.ts)', () => {
  const keys: KeyProvider = { getInferenceKey: async () => null, requireInferenceKey: async () => '', reportInvalidKey: async () => undefined };
  const catalog = { getSnapshot: async () => ({}) as never, findModel: async () => null } as CatalogService;
  const budget = {} as BudgetGuard;

  function harness() {
    const registered: SpendSource[] = [];
    const unregistered: SpendSource[] = [];
    const budgetSources: BudgetSources = {
      register(source) {
        registered.push(source);
        return () => unregistered.push(source);
      },
    };
    const disposers: Array<() => void | Promise<void>> = [];
    const host: SliceHost = { registerApi: () => undefined, onDispose: (d) => disposers.push(d) };
    const dispose = async () => {
      for (const d of disposers) await d();
    };
    return { registered, unregistered, budgetSources, host, dispose };
  }

  function fakeRuntime(order: string[]) {
    const statusListeners = new Set<(s: GatewayStatus) => void>();
    const source: SpendSource = { kind: 'agent', totalSince: () => 0.25, burnUsdPerHour: () => 0 };
    let reloads = 0;
    const runtime: GatewayRuntime = {
      gateway: scriptedGateway(),
      spendSource: source,
      onStatus(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      reloadSettings: () => {
        reloads += 1;
      },
      dispose: async () => {
        order.push('dispose');
      },
    };
    return { runtime, source, push: (s: GatewayStatus) => statusListeners.forEach((l) => l(s)), reloads: () => reloads, listeners: () => statusListeners.size };
  }

  it('with the refusal factory: the F0 refusal gateway, no spend source, nothing emitted', async () => {
    const t = await createTestContext();
    try {
      const h = harness();
      const slice = await setupGatewaySlice(t.ctx, { keys, catalog, budget, budgetSources: h.budgetSources }, h.host, { factory: notImplementedGatewayFactory });
      expect(() => slice.gateway.status()).toThrow(/not available/);
      expect(h.registered).toEqual([]);
      await h.dispose();
      expect(t.emitted.filter((e) => e.name === 'code:gateway')).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  it('with a factory: passes the deps, registers the spend source, emits code:gateway, reloads settings, disposes in order', async () => {
    const t = await createTestContext();
    try {
      const h = harness();
      const order: string[] = [];
      const rt = fakeRuntime(order);
      let got: GatewayFactoryDeps | null = null;
      const factory: GatewayFactory = async (deps) => {
        got = deps;
        return rt.runtime;
      };
      const clock = fakeClock();
      const slice = await setupGatewaySlice(t.ctx, { keys, catalog, budget, budgetSources: h.budgetSources }, h.host, { factory, clock });
      expect(slice.gateway).toBe(rt.runtime.gateway);
      expect(got).not.toBeNull();
      const deps = got! as GatewayFactoryDeps;
      expect(deps.ctx).toBe(t.ctx);
      expect(deps.keys).toBe(keys);
      expect(deps.catalog).toBe(catalog);
      expect(deps.budget).toBe(budget);
      expect(deps.clock).toBe(clock);
      expect(deps.signals).toBe(alwaysOnlineSignals);
      expect(deps.tpmLimit()).toBe(GATEWAY_TPM_TIERS.t1);
      expect(h.registered).toEqual([rt.source]);

      rt.push(fakeStatusSnapshot({ queued: 3 }));
      expect(t.emitted.filter((e) => e.name === 'code:gateway').map((e) => (e.payload as GatewayStatus).queued)).toEqual([3]);

      await t.ctx.settings.update({ chatMaxTokens: 4_096 });
      expect(rt.reloads()).toBe(1);

      h.unregistered.length = 0;
      const orig = rt.runtime.dispose;
      rt.runtime.dispose = async () => {
        await orig();
        order.push(`unregistered:${h.unregistered.length}`);
      };
      await h.dispose();
      order.push(`unregistered:${h.unregistered.length}`);
      // The spend source stays registered until the runtime flushed (dispose), then goes.
      expect(order).toEqual(['dispose', 'unregistered:0', 'unregistered:1']);
      expect(rt.listeners()).toBe(0);
      rt.push(fakeStatusSnapshot({ queued: 9 }));
      expect(t.emitted.filter((e) => e.name === 'code:gateway')).toHaveLength(1);
      await t.ctx.settings.update({ chatMaxTokens: 2_048 });
      expect(rt.reloads()).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it('a factory that throws leaves the app starting with the refusal gateway', async () => {
    const t = await createTestContext();
    try {
      const h = harness();
      const slice = await setupGatewaySlice(t.ctx, { keys, catalog, budget, budgetSources: h.budgetSources }, h.host, {
        factory: async () => {
          throw new Error('corrupt gateway-threads.json');
        },
      });
      await expect(slice.gateway.stream({} as GatewayRequest, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'not_implemented' });
      expect(h.registered).toEqual([]);
      await h.dispose();
    } finally {
      await t.cleanup();
    }
  });

  it('signals given to the slice reach the factory; a failing dispose is logged, the source still goes', async () => {
    const t = await createTestContext();
    try {
      const h = harness();
      const rt = fakeRuntime([]);
      rt.runtime.dispose = async () => {
        throw new Error('flush failed');
      };
      const signals = { isOnline: () => false, onResume: () => () => undefined };
      let seen: unknown = null;
      await setupGatewaySlice(t.ctx, { keys, catalog, budget, budgetSources: h.budgetSources, signals }, h.host, {
        factory: async (deps) => {
          seen = deps.signals;
          return rt.runtime;
        },
      });
      expect(seen).toBe(signals);
      await h.dispose();
      expect(h.unregistered).toEqual([rt.source]);
    } finally {
      await t.cleanup();
    }
  });

  it('gatewayTpmLimit defaults to tier T1; notImplementedGateway still refuses', async () => {
    const t = await createTestContext();
    try {
      expect(gatewayTpmLimit(t.ctx)).toBe(1_000_000);
      expect(() => notImplementedGateway().threadSpend('t')).toThrow();
    } finally {
      await t.cleanup();
    }
  });
});
