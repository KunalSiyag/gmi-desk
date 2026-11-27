import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BUDGET, type BudgetStatus } from '@shared/contracts/usage';
import {
  computeBudgetStatus,
  describeLoosening,
  evaluateBudget,
  normalizeBudget,
  startOfLocalDay,
  startOfLocalMonth,
  validateBudgetPatch,
} from '@main/services/usage/budget';
import { createUsageSlice, type UsageSlice } from '@main/services/usage';
import { createTestContext, type TestContext } from '../helpers/context';
import { clock, fakeAuth, fakeMcp } from './fakes';

// All dates are LOCAL wall-clock times (new Date(y, m, d, h, min)), so these tests hold in any time zone.
const local = (m: number, d: number, h = 12, min = 0) => new Date(2026, m - 1, d, h, min);

let t: TestContext | null = null;
let slice: UsageSlice | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await slice?.dispose();
  await t?.cleanup();
  slice = null;
  t = null;
});

async function setup(start: Date, opts: { mock?: boolean } = {}) {
  const c = clock(start);
  t = await createTestContext({ now: c.now, mock: opts.mock });
  slice = await createUsageSlice(t.ctx, { auth: fakeAuth().auth, mcp: fakeMcp().mcp });
  const record = async (at: Date, usd: number, kind: 'chat' | 'media' = 'media', modelId = 'wan3.0-video') => {
    c.set(at);
    await slice!.budget.record({ kind, modelId, usd });
  };
  return { c, ctx: t.ctx, slice, record, emitted: t.emitted };
}

const budgetEvents = () => (t?.emitted ?? []).filter((e) => e.name === 'usage:budget').map((e) => e.payload as BudgetStatus);

describe('local day and month boundaries', () => {
  it('starts days at local midnight and months on the local 1st', () => {
    expect(startOfLocalDay(local(10, 31, 0, 30))).toEqual(new Date(2026, 9, 31));
    expect(startOfLocalMonth(local(10, 31, 23, 59))).toEqual(new Date(2026, 9, 1));
    expect(startOfLocalMonth(local(1, 1, 0, 0))).toEqual(new Date(2026, 0, 1));
  });

  it('counts spend since local midnight today and since the local 1st', async () => {
    const { c, slice, record } = await setup(local(10, 30, 9));
    await record(local(9, 30, 23, 50), 7); // last month
    await record(local(10, 30, 23, 50), 2); // yesterday
    await record(local(10, 31, 0, 10), 1); // today
    c.set(local(10, 31, 0, 30));
    let status = await slice.usage.getBudget();
    expect(status.spentTodayUsd).toBe(1);
    expect(status.spentMonthUsd).toBe(3);

    // New month at local midnight.
    await record(local(10, 31, 23, 59), 0.5);
    c.set(local(11, 1, 0, 5));
    status = await slice.usage.getBudget();
    expect(status.spentTodayUsd).toBe(0);
    expect(status.spentMonthUsd).toBe(0);
  });
});

describe('BudgetGuard.check', () => {
  it('blocks priced jobs that would exceed a limit, with a human reason', async () => {
    const { c, slice, record } = await setup(local(10, 31, 8));
    await slice.usage.setBudget({ dailyUsd: 5, monthlyUsd: null, enforce: true });
    await record(local(10, 31, 9), 4.2);
    c.set(local(10, 31, 10));

    const over = await slice.budget.check(1, 'media');
    expect(over).toMatchObject({ allowed: false, remainingTodayUsd: 0.8, remainingMonthUsd: null });
    expect(over.reason).toBe('This would exceed your daily budget ($5.00, $4.20 used).');

    expect(await slice.budget.check(0.8, 'media')).toMatchObject({ allowed: true, reason: null });
    // Chat has no price up front: allowed while something is left.
    expect(await slice.budget.check(null, 'chat')).toMatchObject({ allowed: true, needsConfirmation: false, reason: null });

    await record(local(10, 31, 11), 0.9);
    c.set(local(10, 31, 12));
    const chat = await slice.budget.check(null, 'chat');
    expect(chat).toMatchObject({ allowed: false, remainingTodayUsd: 0 });
    expect(chat.reason).toBe('You have reached your daily budget ($5.00, $5.10 used).');
  });

  it('names every limit that would be exceeded, including the monthly one', async () => {
    const { c, slice, record } = await setup(local(10, 20, 8));
    await slice.usage.setBudget({ dailyUsd: 3, monthlyUsd: 10 });
    await record(local(10, 5), 8);
    await record(local(10, 20, 9), 1.5);
    c.set(local(10, 20, 10));
    const res = await slice.budget.check(2, 'media');
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('This would exceed your daily budget ($3.00, $1.50 used) and your monthly budget ($10.00, $9.50 used).');
    expect(res).toMatchObject({ remainingTodayUsd: 1.5, remainingMonthUsd: 0.5 });
  });

  it('only warns when enforce is off', async () => {
    const { c, slice, record } = await setup(local(10, 31, 8));
    await slice.usage.setBudget({ dailyUsd: 5, enforce: false });
    await record(local(10, 31, 9), 4.2);
    c.set(local(10, 31, 10));
    const res = await slice.budget.check(2, 'media');
    expect(res.allowed).toBe(true);
    expect(res.reason).toMatch(/^This would exceed your daily budget \(\$5\.00, \$4\.20 used\)\. Limits are not enforced/);
    await record(local(10, 31, 11), 1);
    expect((await slice.budget.check(null, 'chat')).allowed).toBe(true);
  });

  it('asks for confirmation above the threshold (0 = every priced job, never for unpriced chat)', async () => {
    const { slice } = await setup(local(10, 31, 8));
    expect(DEFAULT_BUDGET.confirmAboveUsd).toBe(0);
    expect((await slice.budget.check(0.01, 'media')).needsConfirmation).toBe(true);
    expect((await slice.budget.check(0, 'media')).needsConfirmation).toBe(false);
    expect((await slice.budget.check(null, 'chat')).needsConfirmation).toBe(false);
    await slice.usage.setBudget({ confirmAboveUsd: 0.5 });
    expect((await slice.budget.check(0.5, 'media')).needsConfirmation).toBe(false);
    expect((await slice.budget.check(0.51, 'media')).needsConfirmation).toBe(true);
  });

  it('allows anything when no limits are set', async () => {
    const { slice, record } = await setup(local(10, 31, 8));
    await record(local(10, 31, 9), 500);
    const res = await slice.budget.check(100_000, 'media');
    expect(res).toEqual({ allowed: true, needsConfirmation: true, reason: null, remainingTodayUsd: null, remainingMonthUsd: null });
  });

  it('treats a non-finite estimate as unpriced', () => {
    const status: BudgetStatus = {
      budget: { dailyUsd: 1, monthlyUsd: null, confirmAboveUsd: 0, enforce: true },
      spentTodayUsd: 1,
      spentMonthUsd: 1,
      remainingTodayUsd: 0,
      remainingMonthUsd: null,
      updatedAt: 'x',
    };
    expect(evaluateBudget(status, Number.NaN, 'media')).toMatchObject({ allowed: false, needsConfirmation: false });
  });
});

describe('BudgetGuard.record', () => {
  it('appends spend and emits usage:budget; ignores zero, negative and non-finite amounts', async () => {
    const { slice, c } = await setup(local(10, 31, 8));
    await slice.budget.record({ kind: 'chat', modelId: 'openai/gpt-6.1-sol', usd: 0.0412, ref: 'thread-1' });
    expect(budgetEvents()).toHaveLength(1);
    expect(budgetEvents()[0]).toMatchObject({ spentTodayUsd: 0.0412, spentMonthUsd: 0.0412 });
    for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await slice.budget.record({ kind: 'media', modelId: 'x', usd });
    }
    await slice.budget.record(undefined as never);
    expect(budgetEvents()).toHaveLength(1);
    c.advance(1000);
    const spend = await slice.usage.getLocalSpend(1);
    expect(spend.entries).toHaveLength(1);
    expect(spend.entries[0]).toMatchObject({ kind: 'chat', modelId: 'openai/gpt-6.1-sol', usd: 0.0412, ref: 'thread-1' });
  });
});

describe('setBudget', () => {
  it.each([
    [{ dailyUsd: -1 }],
    [{ dailyUsd: 'five' }],
    [{ monthlyUsd: 2_000_000 }],
    [{ monthlyUsd: Number.NaN }],
    [{ confirmAboveUsd: null }],
    [{ confirmAboveUsd: -0.01 }],
    [{ enforce: 'yes' }],
    [null],
    [[1, 2]],
  ])('rejects %j', async (patch) => {
    const { slice } = await setup(local(10, 31, 8));
    await expect(slice.usage.setBudget(patch as never)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(budgetEvents()).toHaveLength(0);
  });

  it('validates, persists, emits and keeps unspecified fields', async () => {
    const { slice: first, ctx } = await setup(local(10, 31, 8));
    const status = await first.usage.setBudget({ dailyUsd: 5, monthlyUsd: 100.004, confirmAboveUsd: 0.5 });
    expect(status.budget).toEqual({ dailyUsd: 5, monthlyUsd: 100.004, confirmAboveUsd: 0.5, enforce: true });
    expect(budgetEvents()).toEqual([status]);

    const next = await first.usage.setBudget({ dailyUsd: null, enforce: false });
    expect(next.budget).toEqual({ dailyUsd: null, monthlyUsd: 100.004, confirmAboveUsd: 0.5, enforce: false });
    expect(next.remainingTodayUsd).toBeNull();

    await first.dispose();
    expect(JSON.parse(await readFile(join(ctx.paths.data, 'budget.json'), 'utf8'))).toEqual(next.budget);
    slice = await createUsageSlice(ctx, { auth: fakeAuth().auth, mcp: fakeMcp().mcp });
    expect((await slice.usage.getBudget()).budget).toEqual(next.budget);
  });

  it('accepts undefined fields as "unchanged" and ignores unknown keys', () => {
    expect(validateBudgetPatch({ dailyUsd: undefined, extra: 1, enforce: true })).toEqual({ enforce: true });
  });

  it('falls back to defaults for a hand-edited, invalid budget file', () => {
    expect(normalizeBudget({ dailyUsd: -5, monthlyUsd: '10', confirmAboveUsd: 'x', enforce: 'no' })).toEqual(DEFAULT_BUDGET);
    expect(normalizeBudget({ dailyUsd: 2, monthlyUsd: null, confirmAboveUsd: 1, enforce: false })).toEqual({
      dailyUsd: 2,
      monthlyUsd: null,
      confirmAboveUsd: 1,
      enforce: false,
    });
  });

  it('computes remaining as limit minus spent, never below zero', () => {
    const status = computeBudgetStatus(
      { dailyUsd: 5, monthlyUsd: 4, confirmAboveUsd: 0, enforce: true },
      { totalsSince: () => ({ chat: 1, media: 3.5, total: 4.5 }) },
      local(10, 31),
    );
    expect(status).toMatchObject({ spentTodayUsd: 4.5, remainingTodayUsd: 0.5, remainingMonthUsd: 0 });
  });
});

describe('day rollover', () => {
  it('emits usage:budget after local midnight so "today" resets in the UI', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { c } = await setup(local(10, 31, 23, 59));
    expect(budgetEvents()).toHaveLength(0);
    c.set(local(11, 1, 0, 0));
    vi.advanceTimersByTime(61_000);
    expect(budgetEvents()).toHaveLength(1);
    expect(budgetEvents()[0]?.spentTodayUsd).toBe(0);
  });
});

describe('mock mode', () => {
  it('seeds a budget and this device\'s spend once so the page shows progress', async () => {
    const { slice: first, ctx } = await setup(local(10, 31, 15), { mock: true });
    const status = await first.usage.getBudget();
    // The usage fixture's daily $5 is raised to $25 by the default mock Compute scenario (mock/compute.ts), so a
    // demo GPU launch fits the required daily budget; GMI_DESK_MOCK_COMPUTE=budget_low brings back $5.
    expect(status.budget).toEqual({ dailyUsd: 25, monthlyUsd: 100, confirmAboveUsd: 0.5, enforce: true });
    expect(status.spentTodayUsd).toBeCloseTo(4.2115, 6);
    expect(status.spentMonthUsd).toBeCloseTo(38.4, 6);
    const spend = await first.usage.getLocalSpend(7);
    expect(spend.chatUsd).toBeGreaterThan(0);
    expect(spend.mediaUsd).toBeGreaterThan(spend.chatUsd);

    // Not re-seeded on the next start.
    await first.usage.setBudget({ dailyUsd: 9 });
    await first.dispose();
    slice = await createUsageSlice(ctx, { auth: fakeAuth().auth, mcp: fakeMcp().mcp });
    expect((await slice.usage.getBudget()).budget.dailyUsd).toBe(9);
    expect((await slice.usage.getLocalSpend(90)).entryCount).toBe(43);
  });
});

describe('loosening the budget needs a yes in a main-process dialog', () => {
  const STRICT = { dailyUsd: 5, monthlyUsd: 100, confirmAboveUsd: 0, enforce: true };

  it('asks before turning blocking off; "Keep current budget" throws cancelled and changes nothing', async () => {
    const { slice } = await setup(local(10, 31, 8));
    await slice.usage.setBudget({ dailyUsd: 5, monthlyUsd: 100 }); // adding limits tightens: no dialog
    expect(t!.platform.confirms).toHaveLength(0);
    const events = budgetEvents().length;

    t!.platform.confirmAnswer = false;
    await expect(slice.usage.setBudget({ enforce: false })).rejects.toMatchObject({ code: 'cancelled' });
    expect(t!.platform.confirms).toEqual([{ title: 'Loosen budget', message: 'Loosen the spending limits GMI Desk enforces?' }]);
    expect((await slice.usage.getBudget()).budget).toEqual(STRICT);
    expect(budgetEvents()).toHaveLength(events);
    expect((await slice.budget.check(10, 'media')).allowed).toBe(false); // still blocking

    t!.platform.confirmAnswer = true;
    await expect(slice.usage.setBudget({ enforce: false })).resolves.toMatchObject({ budget: { ...STRICT, enforce: false } });
    expect(t!.platform.confirms).toHaveLength(2);
  });

  it.each([
    ['removing the daily limit', { dailyUsd: null }],
    ['raising the monthly limit', { monthlyUsd: 100.01 }],
    ['raising the confirmation threshold', { confirmAboveUsd: 0.5 }],
    ['saving the whole form with one loosened field', { dailyUsd: 5, monthlyUsd: null, confirmAboveUsd: 0, enforce: true }],
  ])('asks before %s', async (_name, patch) => {
    const { slice } = await setup(local(10, 31, 8));
    await slice.usage.setBudget(STRICT);
    t!.platform.confirmAnswer = false;
    await expect(slice.usage.setBudget(patch)).rejects.toMatchObject({ code: 'cancelled' });
    expect(t!.platform.confirms).toHaveLength(1);
    expect((await slice.usage.getBudget()).budget).toEqual(STRICT);
  });

  it('never asks to tighten or to save unchanged values', async () => {
    const { slice } = await setup(local(10, 31, 8));
    await slice.usage.setBudget(STRICT); // limits added
    await slice.usage.setBudget({ dailyUsd: 4, monthlyUsd: 50 }); // lowered
    await slice.usage.setBudget({ dailyUsd: 4, monthlyUsd: 50, confirmAboveUsd: 0, enforce: true }); // the form, unchanged
    expect(t!.platform.confirms).toHaveLength(0);
    await slice.usage.setBudget({ enforce: false, confirmAboveUsd: 1 }); // loosened (answered yes)
    expect(t!.platform.confirms).toHaveLength(1);
    await slice.usage.setBudget({ enforce: true, confirmAboveUsd: 0.25 }); // tightened back
    expect(t!.platform.confirms).toHaveLength(1);
    expect((await slice.usage.getBudget()).budget).toEqual({ dailyUsd: 4, monthlyUsd: 50, confirmAboveUsd: 0.25, enforce: true });
  });

  it('shows one dialog at a time', async () => {
    const { slice } = await setup(local(10, 31, 8));
    await slice.usage.setBudget(STRICT);
    let open = 0;
    let most = 0;
    t!.platform.confirm = async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 10));
      open -= 1;
      return true;
    };
    await Promise.all([slice.usage.setBudget({ dailyUsd: null }), slice.usage.setBudget({ monthlyUsd: null })]);
    expect(most).toBe(1);
    expect((await slice.usage.getBudget()).budget).toMatchObject({ dailyUsd: null, monthlyUsd: null });
  });

  it('lists what would be loosened', () => {
    expect(describeLoosening(STRICT, { dailyUsd: null, monthlyUsd: 250, confirmAboveUsd: 1, enforce: false })).toEqual([
      'Blocking turns off: jobs that would go over a limit only show a warning.',
      'Daily limit: $5.00 → no limit',
      'Monthly limit: $100.00 → $250.00',
      'Cost confirmation: every priced job → only jobs above $1.00',
    ]);
    expect(describeLoosening(DEFAULT_BUDGET, { dailyUsd: 5, monthlyUsd: 10, confirmAboveUsd: 0, enforce: true })).toEqual([]);
    expect(describeLoosening({ ...STRICT, enforce: false }, { enforce: false, dailyUsd: 3 })).toEqual([]);
  });
});
