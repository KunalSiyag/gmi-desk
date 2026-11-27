// H1-B: the org-wide TPM scheduler (harness.md §4.5) with a fake clock: TPM window, AIMD on 429, priorities,
// fair share per thread, aging, head-of-line, concurrency caps, queued(budget), 429 requeue; and the status
// tracker built on it.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET } from '@shared/contracts/usage';
import { GATEWAY_TPM_TIERS } from '@shared/contracts/gateway';
import type { Logger } from '@main/core/logger';
import type { BudgetGuard } from '@main/core/services';
import { computeBudgetStatus, evaluateBudget } from '@main/services/usage/budget';
import { createBreaker } from '@main/services/gateway/breaker';
import { createReservations } from '@main/services/gateway/reservations';
import { createScheduler, type SchedulerLimits } from '@main/services/gateway/scheduler';
import { createStatusTracker } from '@main/services/gateway/status';
import { GATEWAY_LIMITS, type AdmitResult, type QueuedInfo, type ReserveAttempt, type SchedulerHandle, type SchedulerTicket } from '@main/services/gateway/types';
import { describeSchedulerContract } from './contracts';
import { fakeClock, fakeConnectivity, fakeThreadLedger } from './fakes';

// The contract's tickets all share thread t1 / purpose agent and expect several in flight at once, so the per-thread
// caps (tested below) are off for it.
describeSchedulerContract('scheduler.ts', ({ clock, connectivity, breaker }) => createScheduler({ clock, connectivity, breaker, limits: { perThread: {} } }), (clock) => createBreaker({ clock }));

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function setup(opts: { tpmLimit?: number; limits?: Partial<SchedulerLimits>; log?: Logger } = {}) {
  const clock = fakeClock();
  const connectivity = fakeConnectivity();
  const breaker = createBreaker({ clock });
  const scheduler = createScheduler({ clock, connectivity, breaker, tpmLimit: opts.tpmLimit, limits: opts.limits, log: opts.log });
  return { clock, connectivity, breaker, scheduler };
}

let n = 0;
const reserved = (): ReserveAttempt => ({ status: 'reserved', reservation: { requestId: 'x', usd: 0, release: () => undefined } });
const ticket = (over: Partial<SchedulerTicket> = {}): SchedulerTicket => ({
  requestId: `q${++n}`,
  purpose: 'agent',
  priority: 'foreground',
  threadId: `t${n}`,
  modelKey: 'm',
  tpmTokens: 1_000,
  reserve: reserved,
  ...over,
});

function track(h: SchedulerHandle) {
  const queued: QueuedInfo[] = [];
  h.onQueued((q) => queued.push(q));
  let result: AdmitResult | null = null;
  void h.result.then((r) => (result = r));
  return { queued, last: () => queued.at(-1), result: () => result, admitted: () => (result as AdmitResult | null)?.status === 'admitted' };
}

/** Admission order: each ticket records itself when it reserves and releases its slot as soon as it is admitted. */
function autoRelease(scheduler: ReturnType<typeof createScheduler>, order: string[], over: Partial<SchedulerTicket>): Promise<AdmitResult> {
  const id = over.requestId ?? `q${++n}`;
  const h = scheduler.enqueue(
    ticket({
      ...over,
      requestId: id,
      reserve: () => {
        order.push(id);
        return reserved();
      },
    }),
  );
  return h.result.then((r) => {
    if (r.status === 'admitted') r.slot.release(0);
    return r;
  });
}

async function holdOne(scheduler: ReturnType<typeof createScheduler>, over: Partial<SchedulerTicket> = {}) {
  const r = await scheduler.enqueue(ticket({ purpose: 'chat', priority: 'interactive', threadId: null, modelKey: 'holder', tpmTokens: 0, ...over })).result;
  if (r.status !== 'admitted') throw new Error('holder not admitted');
  return r.slot;
}

describe('order: priority classes, fair share per thread, aging', () => {
  it('interactive > foreground > background > idle', async () => {
    const { scheduler } = setup({ limits: { global: 1 } });
    const holder = await holdOne(scheduler);
    const order: string[] = [];
    const all = [
      autoRelease(scheduler, order, { requestId: 'idle', priority: 'idle', purpose: 'compaction' }),
      autoRelease(scheduler, order, { requestId: 'bg', priority: 'background' }),
      autoRelease(scheduler, order, { requestId: 'fg', priority: 'foreground' }),
      autoRelease(scheduler, order, { requestId: 'chat', priority: 'interactive', purpose: 'chat', threadId: null }),
    ];
    await flush();
    expect(order).toEqual([]);
    holder.release(0);
    await Promise.all(all);
    expect(order).toEqual(['chat', 'fg', 'bg', 'idle']);
    scheduler.dispose();
  });

  it('within a class, threads take turns by tokens admitted (a busy thread cannot starve another)', async () => {
    const { scheduler } = setup({ limits: { global: 1 } });
    const holder = await holdOne(scheduler);
    const order: string[] = [];
    const all: Array<Promise<AdmitResult>> = [];
    for (let i = 1; i <= 6; i++) all.push(autoRelease(scheduler, order, { requestId: `A${i}`, threadId: 'A' }));
    for (let i = 1; i <= 2; i++) all.push(autoRelease(scheduler, order, { requestId: `B${i}`, threadId: 'B' }));
    await flush();
    holder.release(0);
    await Promise.all(all);
    expect(order).toEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'A4', 'A5', 'A6']);
    scheduler.dispose();
  });

  it('aging: +1 class per 30 s waited, up to foreground', async () => {
    for (const [waited, expected] of [
      [GATEWAY_LIMITS.agingStepMs - 1, ['fg', 'bg']],
      [GATEWAY_LIMITS.agingStepMs, ['bg', 'fg']],
    ] as const) {
      const { scheduler, clock } = setup({ limits: { global: 1 } });
      const holder = await holdOne(scheduler);
      const order: string[] = [];
      const bg = autoRelease(scheduler, order, { requestId: 'bg', priority: 'background' });
      await flush();
      clock.advance(waited);
      const fg = autoRelease(scheduler, order, { requestId: 'fg', priority: 'foreground' });
      await flush();
      holder.release(0);
      await Promise.all([bg, fg]);
      expect(order).toEqual(expected);
      scheduler.dispose();
    }
  });
});

describe('TPM window and AIMD', () => {
  it('debits P + maxOut at admission, waits for the window with an ETA, corrects to the measured tokens at settle', async () => {
    const { scheduler, clock } = setup({ tpmLimit: 10_000 });
    const a = await scheduler.enqueue(ticket({ tpmTokens: 6_000 })).result;
    expect(scheduler.stats().tpmUsedLastMinute).toBe(6_000);
    const b = track(scheduler.enqueue(ticket({ modelKey: 'n', tpmTokens: 5_000 })));
    await flush();
    expect(b.last()).toEqual({ position: 0, etaMs: 60_000, reason: 'tpm' });
    clock.advance(20_000);
    await flush();
    expect(b.admitted()).toBe(false);
    if (a.status === 'admitted') a.slot.release(1_000);
    await flush();
    expect(b.admitted()).toBe(true);
    expect(scheduler.stats().tpmUsedLastMinute).toBe(6_000);
    clock.advance(40_000);
    expect(scheduler.stats().tpmUsedLastMinute).toBe(5_000);
    scheduler.dispose();
  });

  it('the window expires on its own (timer), admitting the waiting request', async () => {
    const { scheduler, clock } = setup({ tpmLimit: 10_000 });
    await scheduler.enqueue(ticket({ tpmTokens: 9_000 })).result;
    const b = track(scheduler.enqueue(ticket({ modelKey: 'n', tpmTokens: 2_000 })));
    await flush();
    clock.advance(GATEWAY_LIMITS.tpm.windowMs - 1);
    await flush();
    expect(b.admitted()).toBe(false);
    clock.advance(1);
    await flush();
    expect(b.admitted()).toBe(true);
    scheduler.dispose();
  });

  it('a request larger than the whole limit goes through at once when the window is empty', async () => {
    const { scheduler } = setup({ tpmLimit: 10_000 });
    expect((await scheduler.enqueue(ticket({ tpmTokens: 50_000 })).result).status).toBe('admitted');
    scheduler.dispose();
  });

  it('AIMD: ×0.7 per 429 (once per second), floor 25 %, +5 % of the limit per quiet minute', () => {
    const { scheduler, clock } = setup({ tpmLimit: 1_000_000 });
    scheduler.report429('m', null);
    scheduler.report429('m', null);
    expect(scheduler.stats()).toMatchObject({ tpmEffective: 700_000, last429At: clock.now() });
    clock.advance(1_000);
    scheduler.report429('m', null);
    expect(scheduler.stats().tpmEffective).toBe(490_000);
    for (let i = 0; i < 10; i++) {
      clock.advance(1_000);
      scheduler.report429('m', null);
    }
    expect(scheduler.stats().tpmEffective).toBe(250_000);
    clock.advance(59_999);
    expect(scheduler.stats().tpmEffective).toBe(250_000);
    clock.advance(1);
    expect(scheduler.stats().tpmEffective).toBe(300_000);
    clock.advance(60_000 * 30);
    expect(scheduler.stats().tpmEffective).toBe(1_000_000);
    scheduler.dispose();
  });

  it('setTpmLimit: a full bucket follows the new limit; a shrunk one stays at most the limit', () => {
    const { scheduler } = setup();
    expect(scheduler.stats().tpmLimit).toBe(GATEWAY_TPM_TIERS.t1);
    scheduler.setTpmLimit(GATEWAY_TPM_TIERS.t2);
    expect(scheduler.stats()).toMatchObject({ tpmLimit: 3_000_000, tpmEffective: 3_000_000 });
    scheduler.report429('m', null);
    scheduler.setTpmLimit(1_000_000);
    expect(scheduler.stats()).toMatchObject({ tpmLimit: 1_000_000, tpmEffective: 1_000_000 });
    scheduler.setTpmLimit(-5);
    expect(scheduler.stats().tpmLimit).toBe(1_000_000);
    scheduler.dispose();
  });
});

describe('head-of-line per model', () => {
  it('a large request is not starved by a stream of small ones for the same model; other models go ahead', async () => {
    const { scheduler, clock } = setup({ tpmLimit: 10_000 });
    await scheduler.enqueue(ticket({ tpmTokens: 8_000 })).result;
    const order: string[] = [];
    const big = autoRelease(scheduler, order, { requestId: 'big', tpmTokens: 5_000 });
    const smallSame = autoRelease(scheduler, order, { requestId: 'small-m', tpmTokens: 1_000 });
    const smallOther = autoRelease(scheduler, order, { requestId: 'small-n', modelKey: 'n', tpmTokens: 1_000 });
    await smallOther;
    await flush();
    expect(order).toEqual(['small-n']);
    clock.advance(GATEWAY_LIMITS.tpm.windowMs);
    await Promise.all([big, smallSame]);
    expect(order).toEqual(['small-n', 'big', 'small-m']);
    scheduler.dispose();
  });

  it('after 2 minutes at the head it is admitted anyway, with one warning', async () => {
    const warnings: string[] = [];
    const log = { debug: () => undefined, info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined, child: () => log } as Logger;
    const { scheduler, clock } = setup({ tpmLimit: 10_000, log });
    await scheduler.enqueue(ticket({ modelKey: 'n', tpmTokens: 1_000 })).result;
    const big = track(scheduler.enqueue(ticket({ tpmTokens: 20_000 })));
    for (let t = 30_000; t < GATEWAY_LIMITS.headOfLineMaxWaitMs; t += 30_000) {
      clock.advance(30_000);
      await scheduler.enqueue(ticket({ modelKey: 'n', tpmTokens: 1_000 })).result;
      await flush();
      expect(big.admitted()).toBe(false);
      expect(big.last()?.reason).toBe('tpm');
    }
    clock.advance(GATEWAY_LIMITS.headOfLineMaxWaitMs - 90_000);
    await flush();
    expect(big.admitted()).toBe(true);
    expect(warnings).toHaveLength(1);
    scheduler.dispose();
  });
});

describe('concurrency caps', () => {
  it('6 per model (the model is then blocked, others are not), 16 globally', async () => {
    const { scheduler } = setup();
    const m = Array.from({ length: 7 }, () => track(scheduler.enqueue(ticket())));
    const other = track(scheduler.enqueue(ticket({ modelKey: 'n' })));
    await flush();
    expect(m.filter((x) => x.admitted())).toHaveLength(6);
    expect(m[6]!.last()?.reason).toBe('concurrency');
    expect(other.admitted()).toBe(true);
    for (const key of ['n', 'n', 'n', 'n', 'n', 'o', 'o', 'o', 'o', 'o']) track(scheduler.enqueue(ticket({ modelKey: key })));
    await flush();
    expect(scheduler.stats().inFlight).toBe(16);
    const late = track(scheduler.enqueue(ticket({ modelKey: 'p' })));
    await flush();
    expect(late.last()?.reason).toBe('concurrency');
    scheduler.dispose();
  });

  it('per thread: 1 main-loop request, 2 subagents, 1 compaction; other threads unaffected', async () => {
    const { scheduler } = setup();
    const t = (purpose: SchedulerTicket['purpose'], threadId = 'T') => track(scheduler.enqueue(ticket({ purpose, threadId })));
    const agents = [t('agent'), t('agent')];
    const subs = [t('subagent'), t('subagent'), t('subagent')];
    const comps = [t('compaction'), t('compaction')];
    const titles = [t('title'), t('title')];
    const elsewhere = track(scheduler.enqueue(ticket({ purpose: 'agent', threadId: 'U', modelKey: 'n' })));
    await flush();
    expect(agents.map((x) => x.admitted())).toEqual([true, false]);
    expect(subs.map((x) => x.admitted())).toEqual([true, true, false]);
    expect(comps.map((x) => x.admitted())).toEqual([true, false]);
    expect(titles.map((x) => x.admitted())).toEqual([true, true]);
    expect(elsewhere.admitted()).toBe(true);
    expect(agents[1]!.last()?.reason).toBe('concurrency');
    scheduler.dispose();
  });
});

describe('budget headroom (§4.4) through real reservations', () => {
  function budget(dailyUsd: number): BudgetGuard {
    const status = () => computeBudgetStatus({ ...DEFAULT_BUDGET, dailyUsd, enforce: true }, { totalsSince: () => ({ total: 0 }) }, new Date('2026-11-02T10:00:00Z'));
    return { check: async (usd, kind) => evaluateBudget(status(), usd, kind), record: async () => undefined, statusSnapshot: status };
  }

  it('queued(budget) until another reservation is released; then admitted without a wake()', async () => {
    const clock = fakeClock();
    const reservations = createReservations({ budget: budget(0.5), threads: fakeThreadLedger(clock) });
    const breaker = createBreaker({ clock });
    const scheduler = createScheduler({ clock, breaker, connectivity: fakeConnectivity(), reservations });
    const res = (id: string, threadId: string, usd: number) => () => reservations.tryReserve({ requestId: id, purpose: 'agent', threadId, turnId: 'u', reserveUsd: usd });
    const a = await scheduler.enqueue(ticket({ requestId: 'a', reserve: res('a', 't1', 0.3) })).result;
    const b = track(scheduler.enqueue(ticket({ requestId: 'b', reserve: res('b', 't2', 0.3) })));
    const c = track(scheduler.enqueue(ticket({ requestId: 'c', reserve: res('c', 't3', 0.6) })));
    await flush();
    expect(b.last()?.reason).toBe('budget');
    expect(c.result()).toMatchObject({ status: 'refused', error: { code: 'budget_exceeded' } });
    if (a.status === 'admitted') a.slot.release(100);
    await flush();
    expect(b.admitted()).toBe(true);
    expect(reservations.outstandingUsd()).toBeCloseTo(0.3, 9);
    scheduler.dispose();
  });

  it('a reserve() that throws ends the ticket instead of the queue', async () => {
    const { scheduler } = setup();
    const r = await scheduler.enqueue(
      ticket({
        reserve: () => {
          throw new Error('boom');
        },
      }),
    ).result;
    expect(r).toMatchObject({ status: 'refused', error: { code: 'internal' } });
    expect((await scheduler.enqueue(ticket()).result).status).toBe('admitted');
    scheduler.dispose();
  });
});

describe('breaker gate', () => {
  const openBreaker = (breaker: ReturnType<typeof createBreaker>) => {
    for (let i = 0; i < GATEWAY_LIMITS.breaker.failures; i++) {
      breaker.tryAcquire('m');
      breaker.record('m', 'failure');
    }
  };

  it('open → queued(breaker); "Try anyway" admits one probe while the others keep waiting', async () => {
    const { scheduler, breaker } = setup();
    openBreaker(breaker);
    const plain = track(scheduler.enqueue(ticket()));
    const forced = track(scheduler.enqueue(ticket({ forceProbe: true })));
    await flush();
    expect(forced.admitted()).toBe(true);
    expect(plain.admitted()).toBe(false);
    expect(plain.last()?.reason).toBe('breaker');
    expect(breaker.state('m')).toBe('half_open');
    scheduler.dispose();
  });

  it('a probe that cannot reserve gives its slot back (the next request takes it)', async () => {
    const { scheduler, breaker } = setup();
    openBreaker(breaker);
    const plain = track(scheduler.enqueue(ticket()));
    const waiting = track(scheduler.enqueue(ticket({ forceProbe: true, reserve: () => ({ status: 'wait' }) })));
    await flush();
    expect(waiting.queued.map((q) => q.reason)).toContain('budget');
    expect(waiting.admitted()).toBe(false);
    expect(plain.admitted()).toBe(true);
    scheduler.dispose();
  });
});

describe('requeue after 429 / connect failure', () => {
  it('removes the TPM debit, waits out the delay with an ETA and keeps its position', async () => {
    const { scheduler, clock } = setup({ limits: { global: 1 } });
    const order: string[] = [];
    const first = await scheduler.enqueue(ticket({ requestId: 'A', tpmTokens: 4_000, reserve: () => (order.push('A'), reserved()) })).result;
    const b = autoRelease(scheduler, order, { requestId: 'B' });
    await flush();
    if (first.status !== 'admitted') throw new Error('not admitted');
    const again = track(first.slot.requeue({ delayMs: 5_000, reason: 'tpm' }));
    expect(scheduler.stats().tpmUsedLastMinute).toBe(0);
    await b;
    await flush();
    expect(again.last()).toMatchObject({ reason: 'tpm', etaMs: 5_000 });
    clock.advance(5_000);
    await flush();
    expect(again.admitted()).toBe(true);
    expect(order).toEqual(['A', 'B', 'A']);
    const r = again.result();
    if (r?.status === 'admitted') expect(r.slot.queuedMs).toBe(5_000);
    scheduler.dispose();
  });

  it('a maybe-billed retry keeps the debit; Retry-After pauses every request for that model', async () => {
    const { scheduler, clock } = setup();
    const first = await scheduler.enqueue(ticket({ tpmTokens: 3_000 })).result;
    if (first.status !== 'admitted') throw new Error('not admitted');
    first.slot.requeue({ delayMs: 0, reason: 'concurrency' });
    await flush();
    expect(scheduler.stats().tpmUsedLastMinute).toBe(6_000);
    scheduler.report429('m', 10);
    const paused = track(scheduler.enqueue(ticket()));
    const other = track(scheduler.enqueue(ticket({ modelKey: 'n' })));
    await flush();
    expect(paused.last()).toMatchObject({ reason: 'tpm', etaMs: 10_000 });
    expect(other.admitted()).toBe(true);
    clock.advance(10_000);
    await flush();
    expect(paused.admitted()).toBe(true);
    scheduler.dispose();
  });
});

describe('queue housekeeping', () => {
  it('positions update when a request ahead is cancelled; late subscribers get the current info', async () => {
    const { scheduler } = setup({ limits: { global: 1 } });
    await holdOne(scheduler);
    const a = scheduler.enqueue(ticket());
    const b = track(scheduler.enqueue(ticket()));
    await flush();
    expect(b.last()).toMatchObject({ position: 1, reason: 'concurrency' });
    const late: QueuedInfo[] = [];
    a.onQueued((q) => late.push(q));
    expect(late).toEqual([{ position: 0, etaMs: null, reason: 'concurrency' }]);
    a.cancel();
    expect(await a.result).toEqual({ status: 'cancelled' });
    await flush();
    expect(b.last()).toMatchObject({ position: 0 });
    scheduler.dispose();
  });

  it('dispose cancels queued requests and refuses new ones; slots stay releasable', async () => {
    const { scheduler } = setup({ limits: { global: 1 } });
    const slot = await holdOne(scheduler);
    const queued = scheduler.enqueue(ticket());
    scheduler.dispose();
    expect(await queued.result).toEqual({ status: 'cancelled' });
    expect(await scheduler.enqueue(ticket()).result).toEqual({ status: 'cancelled' });
    slot.release(0);
    expect(scheduler.stats().inFlight).toBe(0);
  });
});

describe('status tracker', () => {
  function statusSetup() {
    const s = setup({ tpmLimit: 1_000_000 });
    let ratio: number | null = 0.42;
    const tracker = createStatusTracker({ scheduler: s.scheduler, breaker: s.breaker, connectivity: s.connectivity, meter: { cacheHitRatio24h: () => ratio }, clock: s.clock });
    return { ...s, tracker, setRatio: (r: number | null) => (ratio = r) };
  }

  it('snapshot: TPM, queue, in-flight per model, breakers, online, cache hits, last 429', async () => {
    const { scheduler, breaker, connectivity, tracker, clock } = statusSetup();
    await scheduler.enqueue(ticket({ tpmTokens: 2_000 })).result;
    for (let i = 0; i < GATEWAY_LIMITS.breaker.failures; i++) {
      breaker.tryAcquire('broken');
      breaker.record('broken', 'failure');
    }
    scheduler.report429('m', null);
    connectivity.setOnline(false);
    expect(tracker.snapshot()).toEqual({
      online: false,
      tpmLimit: 1_000_000,
      tpmEffective: 700_000,
      tpmUsedLastMinute: 2_000,
      queued: 0,
      inFlight: 1,
      models: [
        { model: 'broken', breaker: 'open', reopenAt: new Date(clock.now() + GATEWAY_LIMITS.breaker.openMs).toISOString(), inFlight: 0 },
        { model: 'm', breaker: 'closed', reopenAt: null, inFlight: 1 },
      ],
      cacheHitRatio24h: 0.42,
      last429At: new Date(clock.now()).toISOString(),
      updatedAt: new Date(clock.now()).toISOString(),
    });
    scheduler.dispose();
  });

  it('changes are throttled to one snapshot per second, trailing', () => {
    const { tracker, clock, setRatio } = statusSetup();
    const seen: Array<number | null> = [];
    tracker.onChange((s) => seen.push(s.cacheHitRatio24h));
    tracker.changed();
    clock.advance(0);
    expect(seen).toEqual([0.42]);
    setRatio(0.5);
    tracker.changed();
    setRatio(0.6);
    tracker.changed();
    clock.advance(999);
    expect(seen).toEqual([0.42]);
    clock.advance(1);
    expect(seen).toEqual([0.42, 0.6]);
    tracker.dispose();
    tracker.changed();
    clock.advance(5_000);
    expect(seen).toHaveLength(2);
  });
});
