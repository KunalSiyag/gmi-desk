import { join } from 'node:path';
import { GmiError } from '@shared/contracts/errors';
import {
  BUDGET_MAX_USD,
  DEFAULT_BUDGET,
  type Budget,
  type BudgetCheck,
  type BudgetStatus,
  type SpendKind,
} from '@shared/contracts/usage';
import { formatUsd } from '@shared/lib/money';
import type { AppContext } from '../../core/context';
import type { BudgetGuard, BudgetSources, SpendSource } from '../../core/services';
import { openJsonStore } from '../../core/store';
import type { SpendLedger } from './ledger';
import { fileExists, isRecord, roundUsd } from './util';

/** Local midnight that starts the day containing `d`. */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Local midnight on the 1st of the month containing `d`. */
export function startOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function nextLocalMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= BUDGET_MAX_USD;
}

/** Budget read from disk: every invalid field falls back to its default. */
export function normalizeBudget(raw: unknown): Budget {
  const budget: Budget = { ...DEFAULT_BUDGET };
  if (!isRecord(raw)) return budget;
  if (raw.dailyUsd === null || isMoney(raw.dailyUsd)) budget.dailyUsd = raw.dailyUsd;
  if (raw.monthlyUsd === null || isMoney(raw.monthlyUsd)) budget.monthlyUsd = raw.monthlyUsd;
  if (isMoney(raw.confirmAboveUsd)) budget.confirmAboveUsd = raw.confirmAboveUsd;
  if (typeof raw.enforce === 'boolean') budget.enforce = raw.enforce;
  return budget;
}

const LIMIT_LABELS = { dailyUsd: 'The daily limit', monthlyUsd: 'The monthly limit' } as const;

/** Validates a setBudget patch (only known fields; `undefined` means "leave as is"). Throws invalid_input. */
export function validateBudgetPatch(patch: unknown): Partial<Budget> {
  if (!isRecord(patch)) throw new GmiError('invalid_input', 'Budget changes must be an object.');
  const out: Partial<Budget> = {};
  for (const key of ['dailyUsd', 'monthlyUsd'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) out[key] = null;
    else if (isMoney(value)) out[key] = roundUsd(value);
    else throw new GmiError('invalid_input', `${LIMIT_LABELS[key]} must be empty (no limit) or an amount from $0 to $1,000,000.`);
  }
  if (patch.confirmAboveUsd !== undefined) {
    if (!isMoney(patch.confirmAboveUsd)) {
      throw new GmiError('invalid_input', 'The confirmation threshold must be an amount from $0 to $1,000,000 (0 asks every time).');
    }
    out.confirmAboveUsd = roundUsd(patch.confirmAboveUsd);
  }
  if (patch.enforce !== undefined) {
    if (typeof patch.enforce !== 'boolean') throw new GmiError('invalid_input', 'Enforce must be on or off.');
    out.enforce = patch.enforce;
  }
  return out;
}

/**
 * What a validated patch would loosen, one line per change (empty when it only tightens or changes nothing):
 * blocking turned off, a daily/monthly limit removed or raised, the confirmation threshold raised.
 */
export function describeLoosening(current: Budget, patch: Partial<Budget>): string[] {
  const lines: string[] = [];
  if (current.enforce && patch.enforce === false) lines.push('Blocking turns off: jobs that would go over a limit only show a warning.');
  for (const [key, label] of [
    ['dailyUsd', 'Daily limit'],
    ['monthlyUsd', 'Monthly limit'],
  ] as const) {
    const before = current[key];
    const after = patch[key];
    if (after === undefined || before === null) continue; // unchanged, or there was no limit to loosen
    if (after === null) lines.push(`${label}: ${formatUsd(before)} → no limit`);
    else if (after > before) lines.push(`${label}: ${formatUsd(before)} → ${formatUsd(after)}`);
  }
  if (patch.confirmAboveUsd !== undefined && patch.confirmAboveUsd > current.confirmAboveUsd) {
    const before = current.confirmAboveUsd === 0 ? 'every priced job' : `jobs above ${formatUsd(current.confirmAboveUsd)}`;
    lines.push(`Cost confirmation: ${before} → only jobs above ${formatUsd(patch.confirmAboveUsd)}`);
  }
  return lines;
}

/** A source's spend since `since`; a source that throws or answers nonsense counts as 0 (never negative). */
export function sourceSpend(source: SpendSource, since: Date): number {
  try {
    const usd = source.totalSince(since);
    return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : 0;
  } catch {
    return 0;
  }
}

/**
 * Spent today / this month in LOCAL time: the ledger plus every registered SpendSource (continuous accruals that
 * are not in the ledger yet, e.g. running compute, unflushed agent spend). Remaining is clamped at zero (null when
 * there is no limit).
 */
export function computeBudgetStatus(
  budget: Budget,
  ledger: { totalsSince(since: Date): { total: number } },
  now: Date,
  sources: readonly SpendSource[] = [],
): BudgetStatus {
  const spentSince = (since: Date) => roundUsd(ledger.totalsSince(since).total + sources.reduce((sum, s) => sum + sourceSpend(s, since), 0));
  const spentTodayUsd = spentSince(startOfLocalDay(now));
  const spentMonthUsd = spentSince(startOfLocalMonth(now));
  const remaining = (limit: number | null, spent: number) => (limit === null ? null : roundUsd(Math.max(0, limit - spent)));
  return {
    budget: { ...budget },
    spentTodayUsd,
    spentMonthUsd,
    remainingTodayUsd: remaining(budget.dailyUsd, spentTodayUsd),
    remainingMonthUsd: remaining(budget.monthlyUsd, spentMonthUsd),
    updatedAt: now.toISOString(),
  };
}

/**
 * The spend decision for one job.
 * - A priced job (usd) is allowed when it fits in what is left of every set limit.
 * - An unpriced job (usd null, e.g. chat) is allowed while every set limit still has something left.
 * - With enforce off, `allowed` stays true but `reason` still explains the overrun (show it as a warning).
 * - needsConfirmation: priced jobs above confirmAboveUsd (0 = every priced job).
 */
export function evaluateBudget(status: BudgetStatus, estimatedUsd: number | null, kind: SpendKind): BudgetCheck {
  const { budget } = status;
  const usd = typeof estimatedUsd === 'number' && Number.isFinite(estimatedUsd) ? Math.max(0, estimatedUsd) : null;
  const limits = [
    { name: 'daily', limit: budget.dailyUsd, spent: status.spentTodayUsd, remaining: status.remainingTodayUsd },
    { name: 'monthly', limit: budget.monthlyUsd, spent: status.spentMonthUsd, remaining: status.remainingMonthUsd },
  ];
  const overruns: string[] = [];
  for (const l of limits) {
    if (l.limit === null || l.remaining === null) continue;
    const over = usd === null ? l.remaining <= 0 : usd > l.remaining;
    if (over) overruns.push(`your ${l.name} budget (${formatUsd(l.limit)}, ${formatUsd(l.spent)} used)`);
  }

  let reason: string | null = null;
  if (overruns.length > 0) {
    const which = overruns.join(' and ');
    reason = usd === null ? `You have reached ${which}.` : `This would exceed ${which}.`;
    if (!budget.enforce) reason += kind === 'chat' ? ' Limits are not enforced, so chat keeps working.' : ' Limits are not enforced, so it can still run.';
  }

  return {
    allowed: !budget.enforce || overruns.length === 0,
    needsConfirmation: usd !== null && usd > budget.confirmAboveUsd,
    reason,
    remainingTodayUsd: status.remainingTodayUsd,
    remainingMonthUsd: status.remainingMonthUsd,
  };
}

export interface BudgetService {
  guard: BudgetGuard;
  /** Where slices register spend that is not in the ledger (compute accrual, unflushed agent spend). */
  sources: BudgetSources;
  status(): BudgetStatus;
  setBudget(patch: unknown): Promise<BudgetStatus>;
  flush(): Promise<void>;
  dispose(): void;
}

/** Longest setTimeout delay Node accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export async function createBudgetService(opts: {
  ctx: AppContext;
  ledger: SpendLedger;
  /** Mock mode: budget written on first run so the page shows progress. */
  seed?: Budget;
}): Promise<BudgetService> {
  const { ctx, ledger } = opts;
  const path = join(ctx.paths.data, 'budget.json');
  const firstRun = !(await fileExists(path));
  const store = await openJsonStore<Budget>(path, DEFAULT_BUDGET, { log: ctx.log, normalize: (raw) => normalizeBudget(raw) });
  if (firstRun && opts.seed) await store.set(normalizeBudget(opts.seed));

  const spendSources = new Set<SpendSource>();
  const status = () => computeBudgetStatus(store.get(), ledger, ctx.now(), [...spendSources]);
  const emit = () => ctx.events.emit('usage:budget', status());

  // "Spent today" resets at local midnight without any spend happening: tell the renderer.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const scheduleRollover = () => {
    if (disposed) return;
    const now = ctx.now();
    const delay = Math.min(MAX_TIMER_MS, Math.max(60_000, nextLocalMidnight(now).getTime() - now.getTime() + 1_000));
    timer = setTimeout(() => {
      emit();
      scheduleRollover();
    }, delay);
    timer.unref?.();
  };
  scheduleRollover();

  const guard: BudgetGuard = {
    async check(estimatedUsd, kind) {
      return evaluateBudget(status(), estimatedUsd, kind);
    },
    async record(entry) {
      if (!entry || typeof entry !== 'object') return;
      const saved = await ledger.append(entry);
      if (saved) emit();
    },
    statusSnapshot: () => status(),
  };

  const sources: BudgetSources = {
    register(source) {
      spendSources.add(source);
      emit();
      return () => {
        if (spendSources.delete(source) && !disposed) emit();
      };
    },
  };

  /**
   * Loosening the budget needs a yes in a native dialog shown by this (main) process, which a script in the
   * renderer cannot answer for the user. Tightening never asks. Declined: GmiError('cancelled'), nothing changes.
   */
  async function applyBudget(patch: unknown): Promise<BudgetStatus> {
    const valid = validateBudgetPatch(patch);
    const loosened = describeLoosening(store.get(), valid);
    if (loosened.length > 0) {
      const confirmed = await ctx.platform.confirm({
        title: 'Loosen budget',
        message: 'Loosen the spending limits GMI Desk enforces?',
        detail: `${loosened.map((line) => `• ${line}`).join('\n')}\n\nGMI keeps charging even when your balance is below zero.`,
        confirmLabel: 'Loosen budget',
        cancelLabel: 'Keep current budget',
      });
      if (!confirmed) throw new GmiError('cancelled', 'The budget was not changed.');
    }
    await store.update((current) => ({ ...current, ...valid }));
    const next = status();
    ctx.events.emit('usage:budget', next);
    return next;
  }

  // One change at a time: at most one dialog open, and each change is compared with the budget it replaces.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    guard,
    sources,
    status,
    setBudget(patch) {
      const run = queue.then(() => applyBudget(patch));
      queue = run.catch(() => undefined);
      return run;
    },
    flush: () => store.flush(),
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
