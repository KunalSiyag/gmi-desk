// Accrual of compute spend at list price (compute.md §9.2): which phases bill, billing intervals opened and closed from
// the supervisor's phase transitions, today / month windows in LOCAL time (the same rules as the usage slice's
// BudgetGuard), the compute SpendSource, and lease timing (§9.4). Pure functions over registry records: no I/O.
import type { ComputeBackend, ComputePhase } from '@shared/contracts/compute';
import type { SpendSource } from '../../core/services';
import { COMPUTE_TIMING, type BillingInterval, type ComputeRecord, type PhaseTransition, type PriceBook } from './types';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// ─── Billed phases (§6.5 CE, §7.4 v2) ───────────────────────────────────────────────────────────────────────────────

/** v2 phases GMI does not bill (`paused` is free during Early Access `[U]` later; `failed` is not billed `[V]`). */
const SANDBOX_UNBILLED: ReadonlySet<ComputePhase> = new Set(['paused', 'failed', 'deleted']);

/**
 * Whether GMI bills a resource in this phase. CE bills every status until the container is gone (404), including
 * `creating`, `stopped`, `error` and unknown values (conservative, §6.5). Sandboxes bill everything except paused,
 * failed and deleted; `unknown` counts as billed (conservative).
 */
export function isBilledPhase(backend: ComputeBackend, phase: ComputePhase): boolean {
  if (phase === 'deleted') return false;
  if (backend === 'ce') return true;
  return !SANDBOX_UNBILLED.has(phase);
}

/** Whether the record bills now: a live (not tombstoned) record in a billed phase. */
export function isBilling(record: Readonly<ComputeRecord>): boolean {
  return record.tombstone === null && isBilledPhase(record.backend, record.phase);
}

// ─── Intervals ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The interval that is still billing (the last one, `to: null`), or null. */
export function openInterval(record: Readonly<ComputeRecord>): BillingInterval | null {
  const last = record.intervals[record.intervals.length - 1];
  return last && last.to === null ? last : null;
}

/** End of the latest closed interval (a new interval never starts before it). */
function lastClosedEnd(record: Readonly<ComputeRecord>): number | null {
  for (let i = record.intervals.length - 1; i >= 0; i--) {
    const end = ms(record.intervals[i]?.to);
    if (end !== null) return end;
  }
  return null;
}

/**
 * Where a new interval starts (§9.2): CE's first interval is backdated to the create request (conservative); sandboxes
 * start at GMI's `running_at` / `started_at` when reported. Never after the observation, never before the previous
 * interval ended.
 */
function intervalStart(record: Readonly<ComputeRecord>, t: PhaseTransition): number {
  const at = ms(t.at) ?? Date.now();
  let from: number;
  if (record.backend === 'ce' && record.intervals.length === 0) {
    from = ms(record.requestedAt) ?? ms(t.remote.createdAt) ?? ms(record.createdAt) ?? at;
  } else if (record.backend === 'sandbox_v2') {
    from = ms(t.remote.runningAt) ?? (record.intervals.length === 0 ? ms(t.remote.createdAt) : null) ?? at;
  } else {
    from = at;
  }
  from = Math.min(from, at);
  const floor = lastClosedEnd(record);
  return floor !== null ? Math.max(from, floor) : from;
}

/**
 * Where an open interval ends (§9.2): GMI's `paused_at` / `deletion.requested_at` when present, otherwise the
 * observation time. Never before the interval started.
 */
function intervalEnd(open: BillingInterval, t: PhaseTransition): number {
  const at = ms(t.at) ?? Date.now();
  const remote = t.to === 'paused' || t.to === 'pausing' ? ms(t.remote.pausedAt) : ms(t.remote.deletionRequestedAt) ?? ms(t.remote.endAt);
  const end = remote !== null ? Math.min(remote, at) : at;
  return Math.max(end, ms(open.from) ?? end);
}

/**
 * Applies one phase transition to a record's billing intervals and lease start. Idempotent: an interval opens only
 * when none is open and closes only when one is. Returns null when nothing changes.
 * - A billed phase opens an interval at the list price `usdPerHour` (from `priceFor` when the record has none).
 * - An unbilled phase closes it; a sandbox in `deleting` closes at `deletion.requested_at` once GMI reports it.
 * - The first `running` sets `runningSince` (the lease starts there, §9.4).
 */
export function applyTransition(
  record: Readonly<ComputeRecord>,
  t: PhaseTransition,
  priceFor: (record: Readonly<ComputeRecord>) => number | null = () => null,
): ComputeRecord | null {
  let intervals = record.intervals;
  let runningSince = record.runningSince;
  const open = openInterval(record);
  const billed = isBilledPhase(record.backend, t.to);
  const sandboxDeletionKnown = record.backend === 'sandbox_v2' && t.to === 'deleting' && ms(t.remote.deletionRequestedAt) !== null;

  if (billed && !sandboxDeletionKnown && !open) {
    const usdPerHour = record.listUsdPerHour ?? priceFor(record);
    intervals = [...intervals, { from: new Date(intervalStart(record, t)).toISOString(), to: null, usdPerHour }];
  } else if ((!billed || sandboxDeletionKnown) && open) {
    const closed = { ...open, to: new Date(intervalEnd(open, t)).toISOString() };
    intervals = [...intervals.slice(0, -1), closed];
  }
  if (t.to === 'running' && !runningSince) runningSince = t.remote.runningAt ?? t.at;

  if (intervals === record.intervals && runningSince === record.runningSince) return null;
  return { ...record, intervals, runningSince };
}

/** Hours of `interval` inside [start, end); an open interval runs until `now`. */
export function overlapHours(interval: BillingInterval, start: number, end: number, now: number): number {
  const from = ms(interval.from);
  if (from === null) return 0;
  const to = interval.to === null ? now : ms(interval.to) ?? now;
  const lo = Math.max(from, start);
  const hi = Math.min(to, end);
  return hi > lo ? (hi - lo) / HOUR_MS : 0;
}

/** USD accrued by one record in [start, end) (unknown prices count 0: the `price_unknown` alarm says so). */
export function accruedBetween(record: Readonly<ComputeRecord>, start: number, end: number, now: number): number {
  let usd = 0;
  for (const interval of [...record.intervals, ...(record.eipIntervals ?? [])]) {
    if (interval.usdPerHour === null || !(interval.usdPerHour > 0)) continue;
    usd += overlapHours(interval, start, end, now) * interval.usdPerHour;
  }
  return usd;
}

// ─── Local day / month windows (same rules as services/usage/budget.ts) ─────────────────────────────────────────────

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function startOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Accrued USD of one record: since creation and since local midnight. */
export function recordAccrual(record: Readonly<ComputeRecord>, now: Date): { accruedUsd: number; accruedTodayUsd: number } {
  const t = now.getTime();
  return {
    accruedUsd: accruedBetween(record, Number.NEGATIVE_INFINITY, t, t),
    accruedTodayUsd: accruedBetween(record, startOfLocalDay(now).getTime(), t, t),
  };
}

/** Compute spend of the managed records (tombstones included) since `since`, up to `now`. */
export function spendSince(records: ReadonlyArray<Readonly<ComputeRecord>>, since: Date, now: Date): number {
  const t = now.getTime();
  let usd = 0;
  for (const r of records) if (r.managed) usd += accruedBetween(r, since.getTime(), t, t);
  return usd;
}

/** List USD per hour of a billing record: its open interval's price, else the record's list price. */
export function recordUsdPerHour(record: Readonly<ComputeRecord>): number | null {
  const open = openInterval(record);
  return open ? open.usdPerHour : record.listUsdPerHour;
}

/** List USD per hour of a managed EIP that is still allocated (open EIP interval), or 0. */
export function eipUsdPerHour(record: Readonly<ComputeRecord>): number {
  const list = record.eipIntervals ?? [];
  const last = list[list.length - 1];
  return last && last.to === null && last.usdPerHour !== null && last.usdPerHour > 0 ? last.usdPerHour : 0;
}

/** Opens the EIP's billing interval at `at` (idempotent while one is open). */
export function openEipInterval(record: Readonly<ComputeRecord>, usdPerHour: number | null, at: string): ComputeRecord {
  const list = record.eipIntervals ?? [];
  if (list.some((i) => i.to === null)) return { ...record, eipIntervals: list };
  return { ...record, eipIntervals: [...list, { from: at, to: null, usdPerHour }] };
}

/** Closes the EIP's billing interval at `at` (released). */
export function closeEipInterval(record: Readonly<ComputeRecord>, at: string): ComputeRecord {
  const t = Date.parse(at);
  return { ...record, eipIntervals: (record.eipIntervals ?? []).map((i) => (i.to === null ? { ...i, to: new Date(Math.max(t, Date.parse(i.from))).toISOString() } : i)) };
}

/** Σ list USD per hour of the managed resources billing now, plus managed EIPs not released yet (also kept ones). */
export function burnUsdPerHour(records: ReadonlyArray<Readonly<ComputeRecord>>): number {
  let usd = 0;
  for (const r of records) {
    if (!r.managed) continue;
    usd += eipUsdPerHour(r);
    if (!isBilling(r)) continue;
    const price = recordUsdPerHour(r);
    if (price !== null && price > 0) usd += price;
  }
  return usd;
}

/**
 * The compute `SpendSource` registered with the usage slice's BudgetSources (§9.3): Usage, chat's `budget.check` and
 * every budget status then include compute spend. `records` must include tombstones (deleted resources keep accrual).
 */
export function createComputeSpendSource(records: () => ReadonlyArray<Readonly<ComputeRecord>>, now: () => Date): SpendSource {
  return {
    kind: 'compute',
    totalSince: (since) => spendSince(records(), since, now()),
    burnUsdPerHour: () => burnUsdPerHour(records()),
  };
}

// ─── Lease timing (§9.3–9.4) ────────────────────────────────────────────────────────────────────────────────────────

/** First `running` + `maxLifetimeMin` (ms); null without a lease, a limit or a first `running`. */
export function leaseEndMs(record: Readonly<ComputeRecord>): number | null {
  const start = ms(record.runningSince);
  const max = record.lease?.maxLifetimeMin;
  if (start === null || max === null || max === undefined) return null;
  return start + max * MINUTE_MS;
}

/**
 * When the lease action really happens: the lease end, except that a lease-triggered delete never happens within
 * 15 min of a lease change, so the T−15/5/1 warnings always come first (§9.3).
 */
export function effectiveLeaseEndMs(record: Readonly<ComputeRecord>): number | null {
  const end = leaseEndMs(record);
  if (end === null) return null;
  if (record.lease?.onExpiry !== 'delete') return end;
  const changed = ms(record.leaseChangedAt);
  return changed === null ? end : Math.max(end, changed + COMPUTE_TIMING.leaseChangeGraceMs);
}

/** Hours of lease left (for committed burn, §9.3): no lease or no limit counts 24 h; never negative. */
export function remainingLeaseHours(record: Readonly<ComputeRecord>, now: number): number {
  if (!record.lease || record.lease.maxLifetimeMin === null) return 24;
  // A lease that only notifies (a container's `pause` too: containers cannot pause) never stops billing: count it like
  // no limit, also past its end (adopted colleagues' containers always have one).
  const onExpiry = record.kind === 'container' && record.lease.onExpiry === 'pause' ? 'notify' : record.lease.onExpiry;
  if (onExpiry === 'notify') return 24;
  const end = effectiveLeaseEndMs(record);
  // Not running yet: the whole lifetime is still ahead.
  if (end === null) return record.lease.maxLifetimeMin / 60;
  return Math.max(0, (end - now) / HOUR_MS);
}

// ─── Late prices ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fills a record's unknown list price (created or adopted before the price feed loaded) and every billing interval
 * still priced null with it, so its spend counts toward the budget from its real start. Null when nothing changes.
 */
export function backfillPrice(record: Readonly<ComputeRecord>, prices: PriceBook): ComputeRecord | null {
  if (!record.sku) return null;
  const missing = record.listUsdPerHour === null || record.intervals.some((i) => i.usdPerHour === null);
  if (!missing) return null;
  const usd = record.listUsdPerHour ?? prices.price(record.sku, record.idc).usdPerHour;
  if (usd === null) return null;
  return { ...record, listUsdPerHour: usd, intervals: record.intervals.map((i) => (i.usdPerHour === null ? { ...i, usdPerHour: usd } : i)) };
}
