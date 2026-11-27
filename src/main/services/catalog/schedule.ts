/** When the catalog refreshes next (pure, so the policy is testable without timers). */

/** First retry after a refresh where no source answered; doubles up to the refresh interval. */
export const RETRY_BASE_MS = 60_000;
/** Never refresh more often than this from the schedule (manual refreshes are not limited). */
export const MIN_DELAY_MS = 30_000;
/** setTimeout's ceiling (~24.8 days). */
const MAX_TIMER_MS = 2_147_000_000;

export function nextRefreshDelayMs(opts: { intervalHours: number; updatedAt: string | null; failureStreak: number; now: Date }): number {
  const intervalMs = Math.max(1, opts.intervalHours) * 3_600_000;
  if (opts.failureStreak > 0) return Math.min(intervalMs, RETRY_BASE_MS * 2 ** Math.min(opts.failureStreak - 1, 12));
  const last = opts.updatedAt ? Date.parse(opts.updatedAt) : Number.NaN;
  const due = Number.isNaN(last) ? 0 : last + intervalMs;
  return Math.min(MAX_TIMER_MS, Math.max(MIN_DELAY_MS, due - opts.now.getTime()));
}
