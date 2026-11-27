// C1-D accrual (compute.md §9.2): billed phases, intervals from transitions (CE backdated, sandboxes at running_at,
// closed at paused_at / deletion.requested_at), pause/resume/app-closed gaps on a fake clock, local day/month windows,
// the compute SpendSource in the usage slice's budget status, and lease timing.
import { afterEach, describe, expect, it } from 'vitest';
import type { ComputePhase } from '@shared/contracts/compute';
import {
  accruedBetween,
  applyTransition,
  burnUsdPerHour,
  createComputeSpendSource,
  effectiveLeaseEndMs,
  isBilledPhase,
  leaseEndMs,
  recordAccrual,
  remainingLeaseHours,
  spendSince,
} from '@main/services/compute/accrual';
import type { ComputeRecord } from '@main/services/compute/types';
import { CONTAINER_LEASE, guardHarness, HOUR, MIN, record, SANDBOX_LEASE, transition, type GuardHarness } from './guard-harness';

const at = (h: number, m = 0, day = 15) => new Date(2026, 10, day, h, m).toISOString();

describe('billed phases (§6.5, §7.4)', () => {
  const phases: ComputePhase[] = ['creating', 'running', 'busy', 'pausing', 'paused', 'resuming', 'deleting', 'deleted', 'failed', 'unknown'];
  it('CE bills every phase until the container is gone', () => {
    for (const p of phases) expect(isBilledPhase('ce', p), p).toBe(p !== 'deleted');
  });
  it('sandboxes do not bill while paused, failed or deleted; unknown counts as billed', () => {
    const unbilled = new Set(['paused', 'failed', 'deleted']);
    for (const p of phases) expect(isBilledPhase('sandbox_v2', p), p).toBe(!unbilled.has(p));
  });
});

describe('intervals from transitions (§9.2)', () => {
  it('backdates the first CE interval to the create request and starts the lease at the first running', () => {
    const r = record({ id: 'c1', kind: 'container', phase: 'creating', requestedAt: at(10, 0), listUsdPerHour: 3.35 });
    const opened = applyTransition(r, transition({ resourceId: 'c1', kind: 'container', backend: 'ce', to: 'creating', at: at(10, 1) }))!;
    expect(opened.intervals).toEqual([{ from: at(10, 0), to: null, usdPerHour: 3.35 }]);
    expect(opened.runningSince).toBeNull();
    const running = applyTransition(opened, transition({ resourceId: 'c1', kind: 'container', backend: 'ce', to: 'running', at: at(10, 4) }))!;
    expect(running.intervals).toHaveLength(1);
    expect(running.runningSince).toBe(at(10, 4));
  });

  it("starts a sandbox interval at GMI's running_at and closes it at paused_at", () => {
    const r = record({ id: 's1', phase: 'creating', listUsdPerHour: 0.0911 });
    const opened = applyTransition(
      r,
      transition({ resourceId: 's1', to: 'running', at: at(10, 2), remote: { createdAt: null, runningAt: at(10, 1), pausedAt: null, endAt: null, deletionRequestedAt: null } }),
    )!;
    expect(opened.intervals[0]).toEqual({ from: at(10, 1), to: null, usdPerHour: 0.0911 });
    expect(opened.runningSince).toBe(at(10, 1));
    const paused = applyTransition(
      opened,
      transition({ resourceId: 's1', to: 'paused', at: at(11, 5), remote: { createdAt: null, runningAt: null, pausedAt: at(11, 0), endAt: null, deletionRequestedAt: null } }),
    )!;
    expect(paused.intervals[0]?.to).toBe(at(11, 0));
  });

  it('is idempotent: a repeated billed transition keeps one open interval; an unbilled one without an open interval changes nothing', () => {
    const r = record({ id: 's1', phase: 'running', intervals: [{ from: at(10), to: null, usdPerHour: 1 }], runningSince: at(10) });
    expect(applyTransition(r, transition({ resourceId: 's1', to: 'running', at: at(11) }))).toBeNull();
    const closed = record({ id: 's2', phase: 'paused', intervals: [{ from: at(10), to: at(11), usdPerHour: 1 }] });
    expect(applyTransition(closed, transition({ resourceId: 's2', to: 'paused', at: at(12) }))).toBeNull();
  });

  it('closes a deleting sandbox at deletion.requested_at, and a missing price comes from the price book', () => {
    const r = record({ id: 's1', listUsdPerHour: null, intervals: [] });
    const opened = applyTransition(r, transition({ resourceId: 's1', to: 'running', at: at(10) }), () => 0.5)!;
    expect(opened.intervals[0]?.usdPerHour).toBe(0.5);
    const deleting = applyTransition(
      opened,
      transition({ resourceId: 's1', to: 'deleting', at: at(12), remote: { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: at(11, 30) } }),
    )!;
    expect(deleting.intervals[0]?.to).toBe(at(11, 30));
  });

  it('never starts a new interval before the previous one ended (resume after pause)', () => {
    const r = record({ id: 's1', phase: 'paused', intervals: [{ from: at(10), to: at(11), usdPerHour: 1 }], runningSince: at(10) });
    // GMI reports the first running_at again: the new interval starts at the old end, not before it.
    const resumed = applyTransition(
      r,
      transition({ resourceId: 's1', to: 'resuming', at: at(13), remote: { createdAt: null, runningAt: at(10), pausedAt: null, endAt: null, deletionRequestedAt: null } }),
    )!;
    expect(resumed.intervals[1]?.from).toBe(at(11));
    expect(resumed.runningSince).toBe(at(10));
  });
});

describe('accrual across pause / resume / app-closed gaps (fake clock)', () => {
  it('assumes a still-billed sandbox ran the whole time the app was closed, then the reconcile trims to paused_at', () => {
    // 10:00–11:00 running, paused until 13:00, resumed at 13:00, app closed 13:30, reopened 16:00.
    let r = record({ id: 's1', listUsdPerHour: 1 });
    r = applyTransition(r, transition({ resourceId: 's1', to: 'running', at: at(10) }))!;
    r = applyTransition(r, transition({ resourceId: 's1', to: 'paused', at: at(11) }))!;
    r = applyTransition(r, transition({ resourceId: 's1', to: 'running', at: at(13) }))!;
    const startup = new Date(2026, 10, 15, 16, 0);
    expect(recordAccrual(r, startup).accruedUsd).toBeCloseTo(1 + 3, 6);
    // The startup reconcile sees GMI paused it at 14:00 (server timeout): accrual trimmed to 1 + 1 h.
    r = applyTransition(
      r,
      transition({ resourceId: 's1', to: 'paused', at: startup.toISOString(), source: 'reconcile', remote: { createdAt: null, runningAt: null, pausedAt: at(14), endAt: null, deletionRequestedAt: null } }),
    )!;
    expect(recordAccrual(r, startup).accruedUsd).toBeCloseTo(2, 6);
    expect(recordAccrual(r, new Date(2026, 10, 15, 20, 0)).accruedUsd).toBeCloseTo(2, 6);
  });

  it('a container keeps accruing while the app is closed (it cannot stop)', () => {
    const r = record({ id: 'c1', kind: 'container', listUsdPerHour: 3.35, intervals: [{ from: at(8), to: null, usdPerHour: 3.35 }] });
    expect(recordAccrual(r, new Date(2026, 10, 15, 12, 0)).accruedUsd).toBeCloseTo(13.4, 6);
  });

  it('an unknown price accrues nothing (the price_unknown alarm says so)', () => {
    const r = record({ id: 's1', intervals: [{ from: at(8), to: null, usdPerHour: null }] });
    expect(recordAccrual(r, new Date(2026, 10, 15, 12, 0)).accruedUsd).toBe(0);
  });
});

describe('today / month in local time', () => {
  it('splits an interval across local midnight', () => {
    const r = record({ id: 's1', intervals: [{ from: at(23, 0, 14), to: null, usdPerHour: 2 }] });
    const now = new Date(2026, 10, 15, 1, 0);
    const a = recordAccrual(r, now);
    expect(a.accruedUsd).toBeCloseTo(4, 6);
    expect(a.accruedTodayUsd).toBeCloseTo(2, 6);
  });

  it('month windows start on the local 1st; tombstones and unmanaged records are handled', () => {
    const records: ComputeRecord[] = [
      record({ id: 'a', intervals: [{ from: new Date(2026, 9, 31, 22).toISOString(), to: new Date(2026, 10, 1, 2).toISOString(), usdPerHour: 1 }] }),
      record({ id: 'b', tombstone: { at: at(9), reason: 'deleted' }, phase: 'deleted', intervals: [{ from: at(8), to: at(9), usdPerHour: 1 }] }),
      record({ id: 'c', managed: false, intervals: [{ from: at(8), to: null, usdPerHour: 100 }] }),
    ];
    const now = new Date(2026, 10, 15, 12, 0);
    expect(spendSince(records, new Date(2026, 10, 1), now)).toBeCloseTo(2 + 1, 6);
    expect(spendSince(records, new Date(2026, 10, 15), now)).toBeCloseTo(1, 6);
    expect(accruedBetween(records[0]!, new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime(), now.getTime())).toBeCloseTo(2, 6);
  });

  it('burn counts only managed resources billing now', () => {
    const records = [
      record({ id: 'a', listUsdPerHour: 1, intervals: [{ from: at(8), to: null, usdPerHour: 1 }] }),
      record({ id: 'b', phase: 'paused', intervals: [{ from: at(8), to: at(9), usdPerHour: 5 }] }),
      record({ id: 'c', managed: false, intervals: [{ from: at(8), to: null, usdPerHour: 100 }] }),
      record({ id: 'd', kind: 'container', listUsdPerHour: 3.35, intervals: [{ from: at(8), to: null, usdPerHour: 3.35 }] }),
    ];
    expect(burnUsdPerHour(records)).toBeCloseTo(4.35, 6);
  });
});

describe('lease timing (§9.3–9.4)', () => {
  it('lease starts at the first running; a delete never lands within 15 min of a lease change', () => {
    const r = record({ id: 'c1', kind: 'container', lease: CONTAINER_LEASE, runningSince: at(8) });
    expect(leaseEndMs(r)).toBe(Date.parse(at(12)));
    const changed = { ...r, leaseChangedAt: at(11, 55) };
    expect(effectiveLeaseEndMs(changed)).toBe(Date.parse(at(12, 10)));
    const pause = record({ id: 's1', lease: SANDBOX_LEASE, runningSince: at(8), leaseChangedAt: at(15, 55) });
    expect(effectiveLeaseEndMs(pause)).toBe(Date.parse(at(16)));
  });

  it('remaining lease hours: 24 h without a limit, the whole lifetime before running, never negative', () => {
    const now = Date.parse(at(12));
    expect(remainingLeaseHours(record({ id: 'a', lease: null }), now)).toBe(24);
    expect(remainingLeaseHours(record({ id: 'b', lease: { ...CONTAINER_LEASE, maxLifetimeMin: null } }), now)).toBe(24);
    expect(remainingLeaseHours(record({ id: 'c', lease: CONTAINER_LEASE }), now)).toBe(4);
    expect(remainingLeaseHours(record({ id: 'd', lease: CONTAINER_LEASE, runningSince: at(10) }), now)).toBeCloseTo(2, 6);
    expect(remainingLeaseHours(record({ id: 'e', lease: CONTAINER_LEASE, runningSince: at(2) }), now)).toBe(0);
  });
});

describe('the compute SpendSource in the budget (§9.3)', () => {
  let h: GuardHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('registers on start: budget status, chat checks and the daily limit see compute spend', async () => {
    const now = new Date(2026, 10, 15, 12, 0);
    h = await guardHarness({
      now,
      budget: { dailyUsd: 10 },
      records: [record({ id: 'c1', kind: 'container', listUsdPerHour: 3.35, intervals: [{ from: at(10), to: null, usdPerHour: 3.35 }] })],
    });
    expect(h.budget.status().spentTodayUsd).toBe(0);
    h.guard.start();
    await h.guard.tick();
    expect(h.budget.status().spentTodayUsd).toBeCloseTo(6.7, 2);
    expect(h.budget.status().remainingTodayUsd).toBeCloseTo(3.3, 2);
    h.clock.advance(1 * HOUR);
    expect(h.budget.guard.statusSnapshot().spentTodayUsd).toBeCloseTo(10.05, 2);
    expect((await h.budget.guard.check(null, 'chat')).allowed).toBe(false);
    await h.guard.stop();
    expect(h.budget.status().spentTodayUsd).toBe(0);
  });

  it('the source reports burn for projections', () => {
    const src = createComputeSpendSource(
      () => [record({ id: 'a', listUsdPerHour: 0.5, intervals: [{ from: at(10), to: null, usdPerHour: 0.5 }] })],
      () => new Date(2026, 10, 15, 12, 0),
    );
    expect(src.kind).toBe('compute');
    expect(src.burnUsdPerHour()).toBe(0.5);
    expect(src.totalSince(new Date(2026, 10, 15))).toBeCloseTo(1, 6);
  });

  it('transitions from the supervisor open and close intervals in the registry', async () => {
    const now = new Date(2026, 10, 15, 10, 0);
    h = await guardHarness({ now, records: [record({ id: 's1', phase: 'creating', listUsdPerHour: 0.0911 })] });
    h.guard.start();
    h.sup.emit(transition({ resourceId: 's1', to: 'running', at: now.toISOString() }));
    h.clock.advance(30 * MIN);
    await h.guard.handleTransition(transition({ resourceId: 's1', to: 'paused', at: new Date(now.getTime() + 30 * MIN).toISOString() }));
    const r = h.reg.registry.get('s1')!;
    expect(r.intervals).toEqual([{ from: now.toISOString(), to: new Date(now.getTime() + 30 * MIN).toISOString(), usdPerHour: 0.0911 }]);
    expect(h.guard.cost('s1').accruedUsd).toBeCloseTo(0.04555, 5);
  });
});
