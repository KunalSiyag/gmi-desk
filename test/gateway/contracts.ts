/**
 * Interface contract checks for the gateway's internal modules (src/main/services/gateway/types.ts, H1-0).
 * test/gateway/types.test.ts runs them against the fakes in ./fakes.ts; H1-A / H1-B call the same functions with
 * their real implementations (e.g. `describeBreakerContract('breaker.ts', (clock) => createBreaker({ clock }))`),
 * so fakes and implementations agree on the behaviour other modules rely on. Only rules the design states
 * (harness.md §4.3–4.6) are checked here; each module's own test file covers the rest.
 */
import { describe, expect, it } from 'vitest';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import type { GatewayScope, GwMessage } from '@shared/contracts/gateway';
import type { ThreadCaps } from '@main/core/services';
import {
  GATEWAY_LIMITS,
  type Breaker,
  type ConnectivityGate,
  type Estimator,
  type Meter,
  type MeterInput,
  type QueuedInfo,
  type Reservations,
  type ResolvedModel,
  type RunRegistry,
  type Scheduler,
  type SchedulerTicket,
  type ReserveAttempt,
  type ThreadLedger,
  type ThreadSpendCharge,
} from '@main/services/gateway/types';
import { FAKE_PRICING, fakeClock, fakeConnectivity, type FakeClock } from './fakes';

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const scope = (over: Partial<GatewayScope> = {}): GatewayScope => ({ threadId: 't1', turnId: 'u1', runId: 'r1', step: 1, ...over });

// ─── RunRegistry ──────────────────────────────────────────────────────────────────────────────────────────────

export function describeRunRegistryContract(name: string, make: () => RunRegistry): void {
  describe(`${name}: RunRegistry contract`, () => {
    const owner = { hostId: 'h1' };
    it('host requests: only agent purposes, at most foreground, inside an open run', () => {
      const runs = make();
      runs.open({ threadId: 't1', turnId: 'u1', runId: 'r1' });
      expect(runs.validateRequest({ purpose: 'agent', priority: 'foreground', scope: scope() }, owner)).toBeNull();
      expect(runs.validateRequest({ purpose: 'subagent', priority: 'background', scope: scope() }, owner)).toBeNull();
      for (const purpose of ['chat', 'probe', 'eval'] as const) {
        expect(runs.validateRequest({ purpose, priority: 'background', scope: scope() }, owner)).toMatchObject({ code: 'invalid_input' });
      }
      expect(runs.validateRequest({ purpose: 'agent', priority: 'interactive', scope: scope() }, owner)).toMatchObject({ code: 'invalid_input' });
      expect(runs.validateRequest({ purpose: 'agent', priority: 'foreground', scope: scope({ runId: 'nope' }) }, owner)).toMatchObject({ code: 'invalid_input' });
      expect(runs.validateRequest({ purpose: 'agent', priority: 'foreground', scope: scope({ turnId: 'other' }) }, owner)).toMatchObject({ code: 'invalid_input' });
      expect(runs.validateRequest({ purpose: 'agent', priority: 'foreground', scope: scope({ threadId: 'other' }) }, owner)).toMatchObject({ code: 'invalid_input' });
    });

    it('main requests: chat needs no run; agent purposes still need one', () => {
      const runs = make();
      expect(runs.validateRequest({ purpose: 'chat', priority: 'interactive', scope: scope({ threadId: null, turnId: null, runId: null }) }, null)).toBeNull();
      expect(runs.validateRequest({ purpose: 'agent', priority: 'foreground', scope: scope() }, null)).toMatchObject({ code: 'invalid_input' });
    });

    it('a closed (interrupted / ended) run refuses further requests and notifies once', () => {
      const runs = make();
      const closed: string[] = [];
      runs.onClose((run) => closed.push(run.runId));
      runs.open({ threadId: 't1', turnId: 'u1', runId: 'r1' });
      expect(runs.get('r1')).toMatchObject({ threadId: 't1', turnId: 'u1', runId: 'r1' });
      expect(runs.close('r1')).toMatchObject({ runId: 'r1' });
      expect(runs.close('r1')).toBeNull();
      expect(closed).toEqual(['r1']);
      expect(runs.list()).toEqual([]);
      expect(runs.validateRequest({ purpose: 'agent', priority: 'foreground', scope: scope() }, owner)).toMatchObject({ code: 'invalid_input' });
    });
  });
}

// ─── Breaker ──────────────────────────────────────────────────────────────────────────────────────────────────

export function describeBreakerContract(name: string, make: (clock: FakeClock) => Breaker): void {
  describe(`${name}: Breaker contract (§4.6)`, () => {
    const b = GATEWAY_LIMITS.breaker;
    const fail = (breaker: Breaker, key: string, n: number) => {
      for (let i = 0; i < n; i++) {
        expect(breaker.tryAcquire(key)).toBe(true);
        breaker.record(key, 'failure');
      }
    };

    it(`opens after ${b.failures} failures within ${b.windowMs / 1000} s; neutral outcomes never count`, () => {
      const clock = fakeClock();
      const breaker = make(clock);
      for (let i = 0; i < 20; i++) {
        breaker.tryAcquire('m');
        breaker.record('m', 'neutral');
      }
      fail(breaker, 'm', b.failures - 1);
      expect(breaker.state('m')).toBe('closed');
      fail(breaker, 'm', 1);
      expect(breaker.state('m')).toBe('open');
      expect(breaker.tryAcquire('m')).toBe(false);
      expect(breaker.state('other')).toBe('closed');
      expect(breaker.snapshot()).toEqual([expect.objectContaining({ modelKey: 'm', breaker: 'open', reopenAt: expect.any(String) })]);
    });

    it('failures spread beyond the window do not open it', () => {
      const clock = fakeClock();
      const breaker = make(clock);
      for (let i = 0; i < b.failures * 2; i++) {
        fail(breaker, 'm', 1);
        clock.advance(b.windowMs / (b.failures - 1) + 1);
      }
      expect(breaker.state('m')).toBe('closed');
    });

    it('half-open admits exactly one probe; success closes, failure re-opens for longer', () => {
      const clock = fakeClock();
      const breaker = make(clock);
      fail(breaker, 'm', b.failures);
      clock.advance(b.openMs);
      expect(breaker.state('m')).toBe('half_open');
      expect(breaker.tryAcquire('m')).toBe(true);
      expect(breaker.tryAcquire('m')).toBe(false);
      breaker.record('m', 'failure');
      expect(breaker.state('m')).toBe('open');
      clock.advance(b.openMs);
      expect(breaker.state('m')).toBe('open'); // doubled
      clock.advance(b.openMs);
      expect(breaker.tryAcquire('m')).toBe(true);
      breaker.record('m', 'success');
      expect(breaker.state('m')).toBe('closed');
    });

    it('force ("Try anyway") turns an open breaker into one half-open probe; a neutral outcome frees the slot', () => {
      const clock = fakeClock();
      const breaker = make(clock);
      fail(breaker, 'm', b.failures);
      expect(breaker.tryAcquire('m', { force: true })).toBe(true);
      expect(breaker.tryAcquire('m', { force: true })).toBe(false);
      breaker.record('m', 'neutral');
      expect(breaker.tryAcquire('m', { force: true })).toBe(true);
    });

    it('notifies on state changes', () => {
      const clock = fakeClock();
      const breaker = make(clock);
      let changes = 0;
      breaker.onChange(() => (changes += 1));
      fail(breaker, 'm', b.failures);
      expect(changes).toBeGreaterThan(0);
    });
  });
}

// ─── ThreadLedger ─────────────────────────────────────────────────────────────────────────────────────────────

export interface LedgerUnderTest {
  ledger: ThreadLedger;
  /** The agent rows written to the spend ledger so far. */
  rows(): Array<{ kind: string; modelId: string; usd: number; ref: string | null }>;
  /** A new ledger over the same persisted state (a restart of main), or null when the implementation has none. */
  reopen?(): Promise<ThreadLedger>;
}

export function describeThreadLedgerContract(name: string, make: () => Promise<LedgerUnderTest>): void {
  describe(`${name}: ThreadLedger contract (§4.4)`, () => {
    const charge = (over: Partial<ThreadSpendCharge> = {}): ThreadSpendCharge => ({ threadId: 't1', turnId: 'u1', modelId: 'm', usd: 0.02, at: Date.parse('2026-11-02T10:00:00Z'), ...over });

    it('a new thread has the CODE_DEFAULTS caps; host caps only tighten, field by field', async () => {
      const { ledger } = await make();
      await ledger.load();
      expect(ledger.caps('t1')).toMatchObject({ perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: CODE_DEFAULTS.perThreadUsd, approvedAt: null });
      const loosen: ThreadCaps = { perTurnUsd: 9, perThreadUsd: null };
      expect(ledger.setCaps('t1', loosen)).toMatchObject({ perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: CODE_DEFAULTS.perThreadUsd });
      expect(ledger.setCaps('t1', { perTurnUsd: 0.5, perThreadUsd: 50 })).toMatchObject({ perTurnUsd: 0.5, perThreadUsd: CODE_DEFAULTS.perThreadUsd });
      const approved = ledger.approveCaps('t1', { perTurnUsd: 3, perThreadUsd: null });
      expect(approved).toMatchObject({ perTurnUsd: 3, perThreadUsd: null });
      expect(approved.approvedAt).toEqual(expect.any(String));
      expect(ledger.setCaps('t1', { perTurnUsd: null, perThreadUsd: 10 })).toMatchObject({ perTurnUsd: 3, perThreadUsd: 10 });
    });

    it('spend counts at once, per thread and turn; the source reports only the unflushed part (never twice)', async () => {
      const under = await make();
      const { ledger } = under;
      await ledger.load();
      expect(ledger.spend('t1', 'u1')).toEqual({ turnUsd: 0, threadUsd: 0 });
      ledger.add(charge());
      ledger.add(charge({ modelId: 'm2', usd: 0.01 }));
      ledger.add(charge({ turnId: 'u2', usd: 0.03 }));
      expect(ledger.spend('t1', 'u1').turnUsd).toBeCloseTo(0.03, 9);
      expect(ledger.spend('t1', 'u2').turnUsd).toBeCloseTo(0.03, 9);
      expect(ledger.spend('t1').threadUsd).toBeCloseTo(0.06, 9);
      expect(ledger.source.kind).toBe('agent');
      const since = new Date(Date.parse('2026-11-01T00:00:00Z'));
      const before = ledger.source.totalSince(since);
      expect(before + sumRows(under.rows())).toBeCloseTo(0.06, 9);

      ledger.settleTurn('t1', 'u1');
      const rows = under.rows().filter((r) => r.ref === 'thr:t1/turn:u1');
      expect(rows.every((r) => r.kind === 'agent')).toBe(true);
      expect(sumRows(rows)).toBeCloseTo(0.03, 9);
      expect(ledger.source.totalSince(since) + sumRows(under.rows())).toBeCloseTo(0.06, 9);
      // Persisted spend is unchanged by flushing.
      expect(ledger.spend('t1').threadUsd).toBeCloseTo(0.06, 9);

      await ledger.flush();
      expect(ledger.source.totalSince(since)).toBeCloseTo(0, 9);
      expect(sumRows(under.rows())).toBeCloseTo(0.06, 9);
      await ledger.dispose();
    });

    it('a restart keeps the spend and the caps', async () => {
      const under = await make();
      if (!under.reopen) return;
      await under.ledger.load();
      under.ledger.add(charge({ usd: 0.4 }));
      under.ledger.setCaps('t1', { perTurnUsd: 0.75, perThreadUsd: null });
      await under.ledger.flush();
      await under.ledger.dispose();
      const again = await under.reopen();
      await again.load();
      expect(again.spend('t1', 'u1')).toEqual({ turnUsd: expect.closeTo(0.4, 9), threadUsd: expect.closeTo(0.4, 9) });
      expect(again.caps('t1').perTurnUsd).toBe(0.75);
      await again.dispose();
    });
  });
}

function sumRows(rows: Array<{ usd: number }>): number {
  return rows.reduce((a, r) => a + r.usd, 0);
}

// ─── Reservations ─────────────────────────────────────────────────────────────────────────────────────────────

/** `remainingUsd`: what the app budget has left (no thread caps in the way: each request uses its own thread). */
export function describeReservationsContract(name: string, make: (env: { remainingUsd: number }) => Promise<Reservations> | Reservations): void {
  describe(`${name}: Reservations contract (§4.4)`, () => {
    const req = (i: number, usd: number) => ({ requestId: `q${i}`, purpose: 'agent' as const, threadId: `t${i}`, turnId: `u${i}`, reserveUsd: usd });

    it('fits → reserved; fits only without others → wait; never fits → refused', async () => {
      const res = await make({ remainingUsd: 0.5 });
      const a = res.tryReserve(req(1, 0.3));
      expect(a.status).toBe('reserved');
      expect(res.tryReserve(req(2, 0.3)).status).toBe('wait');
      expect(res.tryReserve(req(3, 0.6))).toMatchObject({ status: 'refused', error: { code: 'budget_exceeded' } });
      expect(res.outstandingUsd()).toBeCloseTo(0.3, 9);
      let released = 0;
      res.onRelease(() => (released += 1));
      if (a.status === 'reserved') {
        a.reservation.release();
        a.reservation.release();
      }
      expect(released).toBe(1);
      expect(res.count()).toBe(0);
      expect(res.tryReserve(req(2, 0.3)).status).toBe('reserved');
    });

    it('10 parallel cache-miss requests near the limit never exceed it', async () => {
      const res = await make({ remainingUsd: 0.5 });
      const attempts: ReserveAttempt[] = [];
      for (let i = 0; i < 10; i++) attempts.push(res.tryReserve(req(i, 0.08)));
      const reserved = attempts.filter((a) => a.status === 'reserved').length;
      expect(reserved).toBe(6);
      expect(res.outstandingUsd()).toBeLessThanOrEqual(0.5);
      expect(attempts.filter((a) => a.status === 'wait')).toHaveLength(4);
    });

    it('chat is never blocked by reservations (today\'s semantics)', async () => {
      const res = await make({ remainingUsd: 0.5 });
      expect(res.tryReserve(req(1, 0.5)).status).toBe('reserved');
      const chat = res.tryReserve({ requestId: 'c', purpose: 'chat', threadId: null, turnId: null, reserveUsd: 0.2 });
      expect(chat.status).toBe('reserved');
      expect(await res.precheck({ purpose: 'chat', threadId: null, turnId: null })).toMatchObject({ ok: true });
    });
  });
}

// ─── Estimator ────────────────────────────────────────────────────────────────────────────────────────────────

export function describeEstimatorContract(name: string, make: () => Estimator): void {
  describe(`${name}: Estimator contract (§4.4)`, () => {
    const resolved: Pick<ResolvedModel, 'modelKey' | 'pricing' | 'discount' | 'maxOutputTokens'> = { modelKey: 'm', pricing: FAKE_PRICING, discount: 0.5, maxOutputTokens: 16_384 };
    const messages: GwMessage[] = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Fix the failing test in src/sum.ts, please.'.repeat(50) },
    ];

    it('pure, worst case ≥ display estimate, 0 ≤ C ≤ P, tpm = P + maxOut', () => {
      const est = make();
      const input = { scope: scope(), resolved, messages, tools: null, purpose: 'agent' as const };
      const a = est.estimate(input);
      const b = est.estimate(input);
      expect(b).toEqual(a);
      expect(a.promptTokens).toBeGreaterThan(0);
      expect(a.maxOutputTokens).toBe(16_384);
      expect(a.expectedCachedTokens).toBeGreaterThanOrEqual(0);
      expect(a.expectedCachedTokens).toBeLessThanOrEqual(a.promptTokens);
      expect(a.tpmTokens).toBe(a.promptTokens + a.maxOutputTokens);
      expect(a.reserveUsd).not.toBeNull();
      expect(a.reserveUsd!).toBeGreaterThanOrEqual(a.expectedUsd!);
      // Worst case: cached counted as 0, discount applied.
      // (An implementation may count the prompt more conservatively for the reservation, never less.)
      expect(a.reserveUsd!).toBeGreaterThanOrEqual(((a.promptTokens * 1.4 + 16_384 * 4.4) / 1e6) * 0.5 - 1e-12);
    });

    it('unpriced → null money; probe reservations are capped', () => {
      const est = make();
      const unpriced = est.estimate({ scope: scope(), resolved: { ...resolved, pricing: null }, messages, purpose: 'agent' });
      expect(unpriced.reserveUsd).toBeNull();
      expect(unpriced.expectedUsd).toBeNull();
      const probe = est.estimate({ scope: scope(), resolved: { ...resolved, maxOutputTokens: 1_000_000 }, messages, purpose: 'probe' });
      expect(probe.reserveUsd!).toBeLessThanOrEqual(GATEWAY_LIMITS.probeReserveCapUsd);
    });

    it('textTokens follows the 4-ASCII-characters rule', () => {
      expect(make().textTokens('abcdefgh')).toBe(2);
    });
  });
}

// ─── Meter ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MeterUnderTest {
  meter: Meter;
  /** Thread charges the meter made (ThreadLedger.add). */
  threadCharges(): ThreadSpendCharge[];
}

export function describeMeterContract(name: string, make: () => MeterUnderTest): void {
  describe(`${name}: Meter contract (§4.3)`, () => {
    const estimate = { promptTokens: 1_000, maxOutputTokens: 100, expectedCachedTokens: 0, reserveUsd: 0.01, expectedUsd: 0.01, tpmTokens: 1_100, prefix: { hashes: [], tokens: [] } };
    const input = (over: Partial<MeterInput> = {}): MeterInput => ({
      requestId: 'q1',
      purpose: 'agent',
      scope: scope(),
      model: 'm',
      pricing: FAKE_PRICING,
      discount: 0.5,
      estimate,
      usage: null,
      cacheWriteTokens: null,
      responded: true,
      maybeBilled: false,
      output: { text: '', reasoning: '', toolArguments: '' },
      ...over,
    });

    it('measured usage: the §4.3 formula with cache reads and the discount', () => {
      const { meter } = make();
      const usage = { promptTokens: 10_000, completionTokens: 1_000, totalTokens: 11_000, reasoningTokens: null, cachedTokens: 9_000 };
      const expected = ((1_000 * 1.4 + 9_000 * 0.26 + 1_000 * 4.4) / 1e6) * 0.5;
      expect(meter.price(usage, null, FAKE_PRICING, 0.5)).toBeCloseTo(expected, 9);
      expect(meter.charge(input({ usage }))).toMatchObject({ estimated: false, maybeBilled: false, costUsd: expect.closeTo(expected, 9) });
      expect(meter.price(usage, null, null, 0.5)).toBeNull();
    });

    it('2xx without usage → the prompt is charged (estimated); nothing billable → null', () => {
      const { meter } = make();
      const r = meter.charge(input());
      expect(r).toMatchObject({ estimated: true, maybeBilled: false });
      expect(r!.usage.promptTokens).toBeGreaterThan(0);
      expect(r!.costUsd!).toBeGreaterThan(0);
      expect(meter.charge(input({ responded: false }))).toBeNull();
      expect(meter.charge(input({ responded: false, maybeBilled: true }))).toMatchObject({ estimated: true, maybeBilled: true });
    });

    it('agent purposes charge the thread; chat does not (the chat slice writes its own row)', () => {
      const under = make();
      under.meter.charge(input({ usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, reasoningTokens: null, cachedTokens: null } }));
      expect(under.threadCharges()).toEqual([expect.objectContaining({ threadId: 't1', turnId: 'u1', modelId: 'm' })]);
      under.meter.charge(input({ purpose: 'chat', scope: scope({ threadId: null, turnId: null, runId: null }) }));
      expect(under.threadCharges()).toHaveLength(1);
    });
  });
}

// ─── Scheduler (only what the gateway core relies on; scheduler.test.ts covers TPM, classes, DRR, HOL) ─────────

export interface SchedulerEnv {
  breaker: Pick<Breaker, 'tryAcquire' | 'record' | 'onChange'>;
  connectivity: ConnectivityGate;
  clock: FakeClock;
}

export function describeSchedulerContract(name: string, make: (env: SchedulerEnv) => Scheduler, makeBreaker: (clock: FakeClock) => Breaker): void {
  describe(`${name}: Scheduler contract (§4.5)`, () => {
    const setup = () => {
      const clock = fakeClock();
      const connectivity = fakeConnectivity();
      const breaker = makeBreaker(clock);
      return { clock, connectivity, breaker, scheduler: make({ clock, connectivity, breaker }) };
    };
    let n = 0;
    const ticket = (reserve: () => ReserveAttempt, over: Partial<SchedulerTicket> = {}): SchedulerTicket => ({
      requestId: `q${++n}`,
      purpose: 'agent',
      priority: 'foreground',
      threadId: 't1',
      modelKey: 'm',
      tpmTokens: 1_000,
      reserve,
      ...over,
    });
    const reserved = (usd = 0): ReserveAttempt => ({ status: 'reserved', reservation: { requestId: 'x', usd, release: () => undefined } });

    it('admits when everything allows it; the slot releases its reservation once', async () => {
      const { scheduler } = setup();
      let releases = 0;
      const h = scheduler.enqueue(ticket(() => ({ status: 'reserved', reservation: { requestId: 'q', usd: 0.1, release: () => (releases += 1) } }), { purpose: 'chat', priority: 'interactive', threadId: null }));
      const r = await h.result;
      expect(r.status).toBe('admitted');
      if (r.status !== 'admitted') return;
      expect(scheduler.stats().inFlight).toBe(1);
      r.slot.release(500);
      r.slot.release(500);
      expect(releases).toBe(1);
      expect(scheduler.stats().inFlight).toBe(0);
      scheduler.dispose();
    });

    it('wait → queued(budget) until wake(); refused ends the ticket', async () => {
      const { scheduler } = setup();
      let answer: ReserveAttempt = { status: 'wait' };
      const queued: QueuedInfo[] = [];
      const h = scheduler.enqueue(ticket(() => answer));
      h.onQueued((q) => queued.push(q));
      await flush();
      expect(queued.at(-1)?.reason).toBe('budget');
      answer = reserved();
      scheduler.wake();
      expect((await h.result).status).toBe('admitted');

      const refused = scheduler.enqueue(ticket(() => ({ status: 'refused', error: { code: 'limit_reached', message: 'cap' } })));
      expect(await refused.result).toMatchObject({ status: 'refused', error: { code: 'limit_reached' } });
      scheduler.dispose();
    });

    it('offline → queued(offline), admitted once the gate reopens; cancel while queued → cancelled', async () => {
      const { scheduler, connectivity } = setup();
      connectivity.setOnline(false);
      const queued: QueuedInfo[] = [];
      const h = scheduler.enqueue(ticket(() => reserved()));
      h.onQueued((q) => queued.push(q));
      const c = scheduler.enqueue(ticket(() => reserved()));
      await flush();
      expect(queued.at(-1)?.reason).toBe('offline');
      c.cancel();
      expect(await c.result).toEqual({ status: 'cancelled' });
      connectivity.setOnline(true);
      scheduler.wake();
      expect((await h.result).status).toBe('admitted');
      scheduler.dispose();
    });

    it('an open breaker → queued(breaker); not admitted', async () => {
      const { scheduler, breaker } = setup();
      for (let i = 0; i < GATEWAY_LIMITS.breaker.failures; i++) {
        breaker.tryAcquire('m');
        breaker.record('m', 'failure');
      }
      const queued: QueuedInfo[] = [];
      const h = scheduler.enqueue(ticket(() => reserved()));
      h.onQueued((q) => queued.push(q));
      await flush();
      expect(queued.at(-1)?.reason).toBe('breaker');
      h.cancel();
      expect(await h.result).toEqual({ status: 'cancelled' });
      scheduler.dispose();
    });

    it('requeue keeps the original position', async () => {
      const { scheduler, clock } = setup();
      let open = true;
      const order: string[] = [];
      const gated = (id: string) => () => {
        if (!open) return { status: 'wait' } as const;
        order.push(id);
        return reserved();
      };
      const first = await scheduler.enqueue(ticket(gated('A'), { requestId: 'A' })).result;
      expect(first.status).toBe('admitted');
      open = false;
      const b = scheduler.enqueue(ticket(gated('B'), { requestId: 'B' }));
      await flush();
      if (first.status !== 'admitted') return;
      const again = first.slot.requeue({ delayMs: 0, reason: 'tpm' });
      open = true;
      clock.advance(1);
      scheduler.wake();
      await Promise.all([again.result, b.result]);
      expect(order).toEqual(['A', 'A', 'B']);
      scheduler.dispose();
    });
  });
}
