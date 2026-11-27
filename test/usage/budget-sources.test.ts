// F0: SpendSources (continuous accrual not in the ledger) are summed into budget status, and the synchronous
// BudgetGuard.statusSnapshot() sees them (compute.md §9.3, harness.md §4.4).
import { afterEach, describe, expect, it } from 'vitest';
import { createUsageSlice, type UsageSlice } from '@main/services/usage';
import { computeBudgetStatus, sourceSpend } from '@main/services/usage/budget';
import type { SpendSource } from '@main/core/services';
import { DEFAULT_BUDGET } from '@shared/contracts/usage';
import { createTestContext, type TestContext } from '../helpers/context';
import { clock, fakeAuth, fakeMcp } from './fakes';

const NOW = new Date(2026, 10, 15, 12, 0);

let t: TestContext | null = null;
let slice: UsageSlice | null = null;
afterEach(async () => {
  await slice?.dispose();
  await t?.cleanup();
  slice = null;
  t = null;
});

async function setup() {
  const c = clock(NOW);
  t = await createTestContext({ now: c.now });
  slice = await createUsageSlice(t.ctx, { auth: fakeAuth().auth, mcp: fakeMcp().mcp });
  return { slice, emitted: t.emitted, c };
}

/** A source that accrued `todayUsd` since local midnight and `monthUsd` since the 1st. */
function source(kind: SpendSource['kind'], todayUsd: number, monthUsd: number): SpendSource {
  return {
    kind,
    totalSince: (since) => (since.getDate() === 1 ? monthUsd : todayUsd),
    burnUsdPerHour: () => 0.5,
  };
}

describe('BudgetSources', () => {
  it('statusSnapshot() is synchronous and includes the ledger and every registered source', async () => {
    const { slice } = await setup();
    await slice.usage.setBudget({ dailyUsd: 10, monthlyUsd: 100 });
    await slice.budget.record({ kind: 'chat', modelId: 'm', usd: 1 });
    const before = slice.budget.statusSnapshot();
    expect(before).toMatchObject({ spentTodayUsd: 1, spentMonthUsd: 1, remainingTodayUsd: 9 });

    const offCompute = slice.budgetSources.register(source('compute', 2, 5));
    const offAgent = slice.budgetSources.register(source('agent', 0.25, 0.25));
    const snap = slice.budget.statusSnapshot();
    expect(snap).not.toBeInstanceOf(Promise);
    expect(snap).toMatchObject({ spentTodayUsd: 3.25, spentMonthUsd: 6.25, remainingTodayUsd: 6.75, remainingMonthUsd: 93.75 });
    // The IPC view and check() agree with the snapshot.
    expect(await slice.usage.getBudget()).toMatchObject({ spentTodayUsd: 3.25 });

    offCompute();
    offAgent();
    expect(slice.budget.statusSnapshot()).toMatchObject({ spentTodayUsd: 1, spentMonthUsd: 1 });
  });

  it('a source pushes a limit over: check() blocks unpriced spend once the daily limit is used up', async () => {
    const { slice } = await setup();
    await slice.usage.setBudget({ dailyUsd: 2, enforce: true });
    expect((await slice.budget.check(null, 'chat')).allowed).toBe(true);
    const off = slice.budgetSources.register(source('compute', 2, 2));
    const check = await slice.budget.check(null, 'chat');
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/daily budget/);
    off();
    expect((await slice.budget.check(null, 'chat')).allowed).toBe(true);
  });

  it('registering and removing a source tells the renderer (usage:budget)', async () => {
    const { slice, emitted } = await setup();
    const count = () => emitted.filter((e) => e.name === 'usage:budget').length;
    const start = count();
    const off = slice.budgetSources.register(source('compute', 1, 1));
    expect(count()).toBe(start + 1);
    off();
    off();
    expect(count()).toBe(start + 2);
  });

  it('a broken source counts as zero and never makes spend negative', () => {
    const throwing: SpendSource = { kind: 'compute', totalSince: () => { throw new Error('x'); }, burnUsdPerHour: () => 0 };
    const nan: SpendSource = { kind: 'agent', totalSince: () => Number.NaN, burnUsdPerHour: () => 0 };
    const negative: SpendSource = { kind: 'agent', totalSince: () => -5, burnUsdPerHour: () => 0 };
    for (const s of [throwing, nan, negative]) expect(sourceSpend(s, NOW)).toBe(0);
    const status = computeBudgetStatus({ ...DEFAULT_BUDGET, dailyUsd: 1 }, { totalsSince: () => ({ total: 0.5 }) }, NOW, [throwing, nan, negative]);
    expect(status).toMatchObject({ spentTodayUsd: 0.5, remainingTodayUsd: 0.5 });
  });

  it('without sources the status is exactly the ledger (unchanged behaviour)', () => {
    const status = computeBudgetStatus({ ...DEFAULT_BUDGET, monthlyUsd: 10 }, { totalsSince: () => ({ total: 4 }) }, NOW);
    expect(status).toMatchObject({ spentTodayUsd: 4, spentMonthUsd: 4, remainingMonthUsd: 6, remainingTodayUsd: null });
  });
});
