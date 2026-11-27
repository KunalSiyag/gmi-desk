// Prices and the budget gate before create, resume and extend (compute.md §9.1, §9.3, §6.2, §9.8). The list price
// comes from C1-B's PriceBook (the public billing feed); org discounts for compute are not readable, so every figure is
// a list-price estimate. Pure functions except `assessQuote`, which awaits BudgetGuard.check.
import type { ComputeKind, CostLine, LeasePolicy } from '@shared/contracts/compute';
import type { GmiErrorShape } from '@shared/contracts/errors';
import type { BudgetGuard } from '../../core/services';
import { formatUsd } from '@shared/lib/money';
import { eipUsdPerHour, isBilling, recordUsdPerHour, remainingLeaseHours } from './accrual';
import type { ComputeRecord, PriceBook, QuoteAssessment, QuoteAssessmentInput } from './types';

/** A feed price older than this makes the quote warn "price from <date>" (§9.1). */
export const PRICE_FRESH_MS = 24 * 3_600_000;
/** Above this projection the native dialog adds a "more than $100" line (§9.8). */
export const HIGH_PROJECTION_USD = 100;
/** Shown with every compute price: CE discounts are readable only with a console session (§9.1). */
export const LIST_PRICE_NOTE = 'List price; your organization may pay less.';
export const UNKNOWN_PRICE_MESSAGE = 'GMI Desk cannot verify the price of this size right now.';
export const DAILY_BUDGET_REQUIRED_MESSAGE = 'Set a daily budget first.';

export interface PricedLines {
  lines: CostLine[];
  /** Σ line prices; null when any line's price is unknown. */
  usdPerHour: number | null;
  priceSource: 'public_feed' | 'cached';
  /** Age of the oldest price used (seconds); null when no line had a fetch time. */
  priceAgeSec: number | null;
  /** Fetch time of the oldest price used. */
  oldestFetchedAt: string | null;
  /** Labels of the lines without a price. */
  unknown: string[];
}

/** Looks up every line in the PriceBook. One cached or unknown line makes the whole quote cached / unknown. */
export function priceLines(prices: PriceBook, lines: QuoteAssessmentInput['lines'], now: Date): PricedLines {
  const out: CostLine[] = [];
  const unknown: string[] = [];
  let total = 0;
  let source: PricedLines['priceSource'] = 'public_feed';
  let oldest: number | null = null;
  for (const line of lines) {
    let info: ReturnType<PriceBook['price']>;
    try {
      info = prices.price(line.sku, line.idc);
    } catch {
      info = { usdPerHour: null, fetchedAt: null, source: 'cached' };
    }
    const usd = typeof info.usdPerHour === 'number' && Number.isFinite(info.usdPerHour) && info.usdPerHour >= 0 ? info.usdPerHour : null;
    if (usd === null) unknown.push(line.label);
    else total += usd;
    if (info.source === 'cached') source = 'cached';
    const fetched = info.fetchedAt ? Date.parse(info.fetchedAt) : NaN;
    if (Number.isFinite(fetched) && (oldest === null || fetched < oldest)) oldest = fetched;
    out.push({ label: line.label, usdPerHour: usd, note: usd === null ? 'Price unknown' : LIST_PRICE_NOTE });
  }
  return {
    lines: out,
    usdPerHour: unknown.length > 0 ? null : total,
    priceSource: source,
    priceAgeSec: oldest === null ? null : Math.max(0, Math.round((now.getTime() - oldest) / 1000)),
    oldestFetchedAt: oldest === null ? null : new Date(oldest).toISOString(),
    unknown,
  };
}

/**
 * Committed burn (§9.3): Σ usdPerHour × remaining lease of the managed resources billing now, a resource without a
 * lease limit counting 24 h. The resource being resumed or extended is left out (its own hours are in the quote).
 */
export function committedUsd(records: ReadonlyArray<Readonly<ComputeRecord>>, now: Date, excludeId: string | null = null): number {
  let usd = 0;
  for (const r of records) {
    if (!r.managed || r.id === excludeId) continue;
    // A managed EIP bills until released: with its container's lease, or 24 h once kept after a delete.
    const eip = eipUsdPerHour(r);
    if (eip > 0) usd += eip * (isBilling(r) ? remainingLeaseHours(r, now.getTime()) : 24);
    if (!isBilling(r)) continue;
    const price = recordUsdPerHour(r);
    if (price === null || !(price > 0)) continue;
    usd += price * remainingLeaseHours(r, now.getTime());
  }
  return usd;
}

/** "4 h", "90 min", "1 day". */
export function formatDuration(minutes: number): string {
  if (minutes >= 24 * 60 && minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  if (minutes > 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${Math.round(minutes)} min`;
}

/**
 * Sentences about the lease for the review step and the native create dialog (§6.2, §9.3, §9.4). C1-C adds them to
 * the quote's warnings (QuoteAssessmentInput carries no lease, so the gate cannot).
 */
export function leaseWarnings(kind: ComputeKind, lease: LeasePolicy, usdPerHour: number | null): string[] {
  const out: string[] = [];
  const rate = usdPerHour === null ? 'an unknown price' : `${formatUsd(usdPerHour)}/h (list)`;
  if (lease.maxLifetimeMin === null) {
    out.push(`No automatic limit: this keeps billing ${rate} until you delete it.`);
  } else {
    const what = effectiveAction(kind, lease.onExpiry);
    const verb = what === 'delete' ? 'Deleted' : what === 'pause' ? 'Paused' : 'You are notified';
    out.push(`${verb} after ${formatDuration(lease.maxLifetimeMin)} running${what === 'notify' ? ', but it keeps billing' : ''}.`);
  }
  const onBudget = effectiveAction(kind, lease.onBudget);
  if (onBudget === 'notify') {
    out.push(kind === 'container' ? 'Your budget will not stop this container.' : 'Your budget will not stop this sandbox.');
  } else {
    out.push(onBudget === 'delete' ? 'If your budget runs out, it is deleted.' : 'If your budget runs out, it is paused.');
  }
  return out;
}

/** Containers have no pause (CE): a `pause` choice acts as `notify` there. */
export function effectiveAction(kind: ComputeKind, action: LeasePolicy['onExpiry']): LeasePolicy['onExpiry'] {
  return kind === 'container' && action === 'pause' ? 'notify' : action;
}

export interface AssessQuoteDeps {
  prices: PriceBook;
  budget: BudgetGuard;
  /** Every registry record (tombstones are ignored here). */
  records: ReadonlyArray<Readonly<ComputeRecord>>;
  now: Date;
}

/** The date part of an ISO time, for "price from <date>". */
const day = (iso: string) => iso.slice(0, 10);

/**
 * The budget gate (§9.1, §9.3): prices every line, adds the committed burn of the running managed resources, asks
 * `BudgetGuard.check(projected, 'compute')` and decides whether main must refuse:
 * - no daily budget before a container create or a GPU sandbox create → `invalid_input` "Set a daily budget first";
 * - unknown price with `enforce` on → `invalid_input` (off: a "price unknown" warning);
 * - over budget with `enforce` on → `budget_exceeded` (off: the reason as a warning).
 */
export async function assessQuote(input: QuoteAssessmentInput, deps: AssessQuoteDeps): Promise<QuoteAssessment> {
  const priced = priceLines(deps.prices, input.lines, deps.now);
  const hours = Number.isFinite(input.hours) && input.hours > 0 ? input.hours : 24;
  const maxUsd = priced.usdPerHour === null ? null : priced.usdPerHour * hours;
  const committed = committedUsd(deps.records, deps.now, input.resourceId ?? null);
  const projected = maxUsd === null ? null : maxUsd + committed;
  const budget = await deps.budget.check(projected, 'compute');
  const status = deps.budget.statusSnapshot();
  const enforce = status.budget.enforce;
  const dailyBudgetSet = status.budget.dailyUsd !== null;

  const warnings: string[] = [];
  let refusal: GmiErrorShape | null = null;
  const refuse = (code: GmiErrorShape['code'], message: string) => {
    refusal ??= { code, message, detail: null, status: null, retryAfterSec: null };
  };

  const needsDailyBudget = input.action === 'create' && (input.kind === 'container' || input.gpu);
  if (needsDailyBudget && !dailyBudgetSet) refuse('invalid_input', DAILY_BUDGET_REQUIRED_MESSAGE);

  if (priced.usdPerHour === null) {
    if (enforce) refuse('invalid_input', UNKNOWN_PRICE_MESSAGE);
    else warnings.push(`Price unknown (${priced.unknown.join(', ')}): GMI Desk cannot estimate what this costs.`);
  }
  if (!budget.allowed) refuse('budget_exceeded', budget.reason ?? 'This would go over the budget you set in Usage.');
  else if (budget.reason) warnings.push(budget.reason);

  if (priced.oldestFetchedAt && priced.priceAgeSec !== null && priced.priceAgeSec * 1000 > PRICE_FRESH_MS) {
    warnings.push(`Price from ${day(priced.oldestFetchedAt)}; it may have changed since.`);
  }
  if (committed > 0) warnings.push(`Includes ${formatUsd(committed)} already committed by your running resources.`);
  if (maxUsd !== null && maxUsd > HIGH_PROJECTION_USD) {
    warnings.push(`This could cost more than ${formatUsd(HIGH_PROJECTION_USD)}: up to ${formatUsd(maxUsd)} at list price.`);
  }

  return {
    lines: priced.lines,
    usdPerHour: priced.usdPerHour,
    maxUsd,
    committedUsd: committed,
    priceSource: priced.priceSource,
    priceAgeSec: priced.priceAgeSec,
    budget,
    dailyBudgetSet,
    warnings,
    refusal,
  };
}
