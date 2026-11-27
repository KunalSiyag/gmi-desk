// H1-B: budget reservations (harness.md §4.4): worst case from main's own estimate, synchronous check-and-insert,
// queued(budget) versus refusal, release in finally, no time expiry, tighten-only caps in force.
import { describe, expect, it, vi } from 'vitest';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import type { GwMessage } from '@shared/contracts/gateway';
import { DEFAULT_BUDGET, type Budget } from '@shared/contracts/usage';
import type { BudgetGuard, SpendSource } from '@main/core/services';
import { computeBudgetStatus, evaluateBudget } from '@main/services/usage/budget';
import { createEstimator } from '@main/services/gateway/estimate';
import { createMeter } from '@main/services/gateway/meter';
import { createReservations } from '@main/services/gateway/reservations';
import { GATEWAY_LIMITS, type ReservationRequest, type ReserveAttempt, type Reservation } from '@main/services/gateway/types';
import { describeReservationsContract } from './contracts';
import { FAKE_PRICING, fakeClock, fakeThreadLedger } from './fakes';

/** A BudgetGuard over the real status/evaluation rules, an in-memory ledger and registered sources. */
function memoryBudget(budget: Partial<Budget> = {}, now = () => new Date('2026-11-02T10:00:00Z')) {
  const rows: Array<{ kind: string; modelId: string; usd: number; ref?: string | null }> = [];
  const sources: SpendSource[] = [];
  const settings: Budget = { ...DEFAULT_BUDGET, enforce: true, ...budget };
  const ledger = { totalsSince: () => ({ total: rows.reduce((a, r) => a + r.usd, 0) }) };
  const status = () => computeBudgetStatus(settings, ledger, now(), sources);
  const guard: BudgetGuard & { rows: typeof rows; sources: SpendSource[]; settings: Budget } = {
    rows,
    sources,
    settings,
    check: vi.fn(async (usd: number | null, kind) => evaluateBudget(status(), usd, kind)),
    record: async (r) => void rows.push(r),
    statusSnapshot: vi.fn(() => status()),
  };
  return guard;
}

describeReservationsContract('reservations.ts', ({ remainingUsd }) =>
  createReservations({ budget: memoryBudget({ dailyUsd: remainingUsd }), threads: fakeThreadLedger() }),
);

const req = (over: Partial<ReservationRequest> = {}): ReservationRequest => ({ requestId: 'q1', purpose: 'agent', threadId: 't1', turnId: 'u1', reserveUsd: 0.1, ...over });

describe('tryReserve', () => {
  it('is synchronous and reads only the synchronous snapshot (no await between check and insert)', () => {
    const budget = memoryBudget({ dailyUsd: 1 });
    const res = createReservations({ budget, threads: fakeThreadLedger() });
    const a = res.tryReserve(req());
    expect(a).not.toBeInstanceOf(Promise);
    expect(a.status).toBe('reserved');
    expect(budget.statusSnapshot).toHaveBeenCalled();
    expect(budget.check).not.toHaveBeenCalled();
  });

  it('turn and thread caps: wait while others are outstanding, limit_reached when the request alone cannot fit', () => {
    const threads = fakeThreadLedger();
    const res = createReservations({ budget: memoryBudget(), threads });
    threads.add({ threadId: 't1', turnId: 'u1', modelId: 'm', usd: 0.7, at: 0 });
    expect(res.tryReserve(req({ requestId: 'a', reserveUsd: 0.2 })).status).toBe('reserved');
    expect(res.tryReserve(req({ requestId: 'b', reserveUsd: 0.2 })).status).toBe('wait');
    expect(res.tryReserve(req({ requestId: 'c', reserveUsd: 0.35 }))).toMatchObject({ status: 'refused', error: { code: 'limit_reached', detail: 'turn_cap' } });
    // Another turn of the same thread is limited by the thread cap only.
    expect(res.tryReserve(req({ requestId: 'd', turnId: 'u2', reserveUsd: 0.9 })).status).toBe('reserved');
    threads.add({ threadId: 't1', turnId: 'u3', modelId: 'm', usd: 3.5, at: 0 });
    expect(res.tryReserve(req({ requestId: 'e', turnId: 'u4', reserveUsd: 0.5 })).status).toBe('wait');
    expect(res.tryReserve(req({ requestId: 'f', turnId: 'u4', reserveUsd: 0.85 }))).toMatchObject({ status: 'refused', error: { code: 'limit_reached', detail: 'thread_cap' } });
    expect(res.outstandingUsd({ threadId: 't1' })).toBeCloseTo(1.1, 9);
    expect(res.outstandingUsd({ threadId: 't1', turnId: 'u1' })).toBeCloseTo(0.2, 9);
  });

  it('caps tightened by the host are in force at once; a null cap means no cap', () => {
    const threads = fakeThreadLedger();
    const res = createReservations({ budget: memoryBudget(), threads });
    threads.setCaps('t1', { perTurnUsd: 0.05, perThreadUsd: null });
    expect(res.tryReserve(req({ reserveUsd: 0.06 }))).toMatchObject({ status: 'refused', error: { code: 'limit_reached' } });
    threads.approveCaps('t2', { perTurnUsd: null, perThreadUsd: null });
    expect(res.tryReserve(req({ threadId: 't2', reserveUsd: 500 })).status).toBe('reserved');
  });

  it('the app budget blocks only when enforced (both daily and monthly limits count)', () => {
    const budget = memoryBudget({ dailyUsd: 10, monthlyUsd: 0.3 });
    const res = createReservations({ budget, threads: fakeThreadLedger() });
    expect(res.tryReserve(req({ reserveUsd: 0.31 }))).toMatchObject({ status: 'refused', error: { code: 'budget_exceeded' } });
    budget.settings.enforce = false;
    expect(res.tryReserve(req({ reserveUsd: 0.9 })).status).toBe('reserved');
  });

  it('unpriced requests: chat 0, probe at the probe cap, agents refused unless a fallback is configured', () => {
    const res = createReservations({ budget: memoryBudget({ dailyUsd: 1 }), threads: fakeThreadLedger() });
    expect(res.tryReserve(req({ purpose: 'chat', threadId: null, turnId: null, reserveUsd: null }))).toMatchObject({ status: 'reserved', reservation: { usd: 0 } });
    expect(res.tryReserve(req({ purpose: 'probe', threadId: null, turnId: null, reserveUsd: null }))).toMatchObject({ status: 'reserved', reservation: { usd: GATEWAY_LIMITS.probeReserveCapUsd } });
    expect(res.tryReserve(req({ reserveUsd: null }))).toMatchObject({ status: 'refused', error: { code: 'invalid_input', detail: 'unpriced_model' } });
    expect(res.tryReserve(req({ reserveUsd: Number.NaN }))).toMatchObject({ status: 'refused' });
    const withFallback = createReservations({ budget: memoryBudget({ dailyUsd: 1 }), threads: fakeThreadLedger(), unpricedReserveUsd: 0.02 });
    expect(withFallback.tryReserve(req({ purpose: 'title', reserveUsd: null }))).toMatchObject({ status: 'reserved', reservation: { usd: 0.02 } });
  });

  it('chat never waits but its reservation holds back agents', () => {
    const res = createReservations({ budget: memoryBudget({ dailyUsd: 0.5 }), threads: fakeThreadLedger() });
    expect(res.tryReserve(req({ purpose: 'chat', threadId: null, turnId: null, reserveUsd: 0.4 })).status).toBe('reserved');
    expect(res.tryReserve(req({ reserveUsd: 0.2 })).status).toBe('wait');
  });

  it('no time-based expiry: a reservation lives until its release', () => {
    const clock = fakeClock();
    const res = createReservations({ budget: memoryBudget({ dailyUsd: 1 }), threads: fakeThreadLedger(clock) });
    const a = res.tryReserve(req({ reserveUsd: 0.6 }));
    clock.advance(24 * 3_600_000);
    expect(res.count()).toBe(1);
    expect(res.tryReserve(req({ requestId: 'b', threadId: 't2', reserveUsd: 0.6 })).status).toBe('wait');
    if (a.status === 'reserved') a.reservation.release();
    expect(res.count()).toBe(0);
  });

  it('two live reservations with the same request id are independent', () => {
    const res = createReservations({ budget: memoryBudget({ dailyUsd: 1 }), threads: fakeThreadLedger() });
    const a = res.tryReserve(req({ reserveUsd: 0.1 }));
    const b = res.tryReserve(req({ reserveUsd: 0.2 }));
    if (a.status === 'reserved') a.reservation.release();
    expect(res.outstandingUsd()).toBeCloseTo(0.2, 9);
    if (b.status === 'reserved') b.reservation.release();
  });
});

describe('precheck: actual spend only (§4.4)', () => {
  it('chat keeps BudgetGuard.check(null, "chat"): blocked only at a reached limit, warning when not enforced', async () => {
    const budget = memoryBudget({ dailyUsd: 0.1 });
    const res = createReservations({ budget, threads: fakeThreadLedger() });
    expect(await res.precheck({ purpose: 'chat', threadId: null, turnId: null })).toEqual({ ok: true, warning: null });
    budget.rows.push({ kind: 'chat', modelId: 'm', usd: 0.1 });
    expect(await res.precheck({ purpose: 'chat', threadId: null, turnId: null })).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    budget.settings.enforce = false;
    expect(await res.precheck({ purpose: 'chat', threadId: null, turnId: null })).toMatchObject({ ok: true, warning: expect.stringContaining('not enforced') });
    expect(budget.check).toHaveBeenCalledWith(null, 'chat');
  });

  it('agents: outstanding reservations do not refuse; a reached cap or budget does', async () => {
    const threads = fakeThreadLedger();
    const budget = memoryBudget({ dailyUsd: 1 });
    const res = createReservations({ budget, threads });
    expect(res.tryReserve(req({ reserveUsd: 0.99 })).status).toBe('reserved');
    expect(await res.precheck({ purpose: 'agent', threadId: 't1', turnId: 'u1' })).toEqual({ ok: true, warning: null });
    threads.add({ threadId: 't1', turnId: 'u1', modelId: 'm', usd: CODE_DEFAULTS.perTurnUsd, at: 0 });
    expect(await res.precheck({ purpose: 'agent', threadId: 't1', turnId: 'u1' })).toMatchObject({ ok: false, error: { code: 'limit_reached', detail: 'turn_cap' } });
    expect(await res.precheck({ purpose: 'agent', threadId: 't1', turnId: 'u2' })).toMatchObject({ ok: true });
    budget.rows.push({ kind: 'media', modelId: 'x', usd: 5 });
    expect(await res.precheck({ purpose: 'agent', threadId: 't9', turnId: 'u1' })).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
  });
});

describe('10 parallel cache-miss requests near a cap never exceed it (worst case from main\'s estimate)', () => {
  const messages: GwMessage[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'x'.repeat(40_000) },
  ];

  it('the turn cap holds even when every request costs its full worst case', () => {
    const clock = fakeClock();
    const threads = fakeThreadLedger(clock);
    const budget = memoryBudget({ dailyUsd: 100 });
    const res = createReservations({ budget, threads });
    const estimator = createEstimator({ clock });
    const meter = createMeter({ threads, budget, estimator, clock });
    // Spend near the turn cap already.
    threads.add({ threadId: 't1', turnId: 'u1', modelId: 'm', usd: 0.9, at: 0 });
    const est = estimator.estimate({ scope: { threadId: 't1', turnId: 'u1', runId: 'r1', step: 1 }, resolved: { modelKey: 'm', pricing: FAKE_PRICING, discount: 0, maxOutputTokens: 2_000 }, messages, purpose: 'agent' });
    expect(est.reserveUsd!).toBeGreaterThan(0.02);

    const pending = Array.from({ length: 10 }, (_, i) => ({ requestId: `q${i}`, done: false }));
    let refused = 0;
    for (let round = 0; round < 20 && pending.some((p) => !p.done); round++) {
      const admitted: Array<{ id: string; reservation: Reservation }> = [];
      for (const p of pending.filter((x) => !x.done)) {
        const a: ReserveAttempt = res.tryReserve({ requestId: p.requestId, purpose: 'agent', threadId: 't1', turnId: 'u1', reserveUsd: est.reserveUsd });
        if (a.status === 'reserved') admitted.push({ id: p.requestId, reservation: a.reservation });
        else if (a.status === 'refused') {
          p.done = true;
          refused += 1;
        }
        expect(threads.spend('t1', 'u1').turnUsd + res.outstandingUsd({ threadId: 't1', turnId: 'u1' })).toBeLessThanOrEqual(CODE_DEFAULTS.perTurnUsd + 1e-9);
      }
      // Settle: a cache miss with the full output, charged (measured) before the release.
      for (const a of admitted) {
        meter.charge({
          requestId: a.id,
          purpose: 'agent',
          scope: { threadId: 't1', turnId: 'u1', runId: 'r1', step: 1 },
          model: 'm',
          pricing: FAKE_PRICING,
          discount: 0,
          estimate: est,
          usage: { promptTokens: est.promptTokens, completionTokens: 2_000, totalTokens: est.promptTokens + 2_000, reasoningTokens: null, cachedTokens: 0 },
          cacheWriteTokens: null,
          responded: true,
          maybeBilled: false,
          output: { text: '', reasoning: '', toolArguments: '' },
        });
        a.reservation.release();
        pending.find((p) => p.requestId === a.id)!.done = true;
      }
    }
    expect(threads.spend('t1', 'u1').turnUsd).toBeLessThanOrEqual(CODE_DEFAULTS.perTurnUsd + 1e-9);
    expect(refused).toBeGreaterThan(0);
    expect(res.count()).toBe(0);
  });
});
