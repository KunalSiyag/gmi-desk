// C1-D pricing and the budget gate (compute.md §9.1, §9.3, §6.2, §9.8): list prices, freshness, unknown prices
// refused under enforce, the required daily budget, committed burn in projections, and the dialog sentences.
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessQuote,
  committedUsd,
  DAILY_BUDGET_REQUIRED_MESSAGE,
  effectiveAction,
  formatDuration,
  leaseWarnings,
  priceLines,
  UNKNOWN_PRICE_MESSAGE,
} from '@main/services/compute/pricing';
import type { QuoteAssessmentInput } from '@main/services/compute/types';
import { CONTAINER_LEASE, fakePrices, guardHarness, record, SANDBOX_LEASE, type GuardHarness } from './guard-harness';

const NOW = new Date(2026, 10, 15, 12, 0);
const at = (h: number, m = 0) => new Date(2026, 10, 15, h, m).toISOString();

const containerQuote = (over: Partial<QuoteAssessmentInput> = {}): QuoteAssessmentInput => ({
  action: 'create',
  kind: 'container',
  lines: [{ sku: 'gmi.container.test', label: '1×H200', idc: 'test-idc' }],
  hours: 4,
  gpu: true,
  ...over,
});

const sandboxQuote = (over: Partial<QuoteAssessmentInput> = {}): QuoteAssessmentInput => ({
  action: 'create',
  kind: 'sandbox',
  lines: [{ sku: 'gmi.sandbox.small', label: 'Sandbox SMALL', idc: null }],
  hours: 8,
  gpu: false,
  ...over,
});

let h: GuardHarness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe('priceLines (§9.1)', () => {
  it('sums known list prices and notes that the org may pay less', () => {
    const p = priceLines(fakePrices({ a: 3.35, b: 0.1 }, NOW.toISOString()), [
      { sku: 'a', label: 'GPU', idc: null },
      { sku: 'b', label: 'Public IP', idc: null },
    ], NOW);
    expect(p.usdPerHour).toBeCloseTo(3.45, 6);
    expect(p.lines.map((l) => l.note)).toEqual(['List price; your organization may pay less.', 'List price; your organization may pay less.']);
    expect(p.priceAgeSec).toBe(0);
  });

  it('one unknown line makes the total unknown; a throwing price book counts as unknown', () => {
    const p = priceLines(fakePrices({ a: 3.35 }), [
      { sku: 'a', label: 'GPU', idc: null },
      { sku: 'missing', label: 'Public IP', idc: null },
    ], NOW);
    expect(p.usdPerHour).toBeNull();
    expect(p.unknown).toEqual(['Public IP']);
    const broken = priceLines({ price: () => { throw new Error('boom'); } }, [{ sku: 'a', label: 'GPU', idc: null }], NOW);
    expect(broken.usdPerHour).toBeNull();
    expect(broken.priceSource).toBe('cached');
  });
});

describe('committed burn (§9.3)', () => {
  it('Σ usdPerHour × remaining lease of running managed resources; no lease counts 24 h; the resumed one is left out', () => {
    const records = [
      record({ id: 'c1', kind: 'container', lease: CONTAINER_LEASE, runningSince: at(10), intervals: [{ from: at(10), to: null, usdPerHour: 3 }] }),
      record({ id: 's1', lease: null, intervals: [{ from: at(10), to: null, usdPerHour: 0.1 }] }),
      record({ id: 's2', phase: 'paused', lease: SANDBOX_LEASE, intervals: [{ from: at(9), to: at(10), usdPerHour: 1 }] }),
      record({ id: 'x', managed: false, intervals: [{ from: at(10), to: null, usdPerHour: 50 }] }),
    ];
    expect(committedUsd(records, NOW)).toBeCloseTo(3 * 2 + 0.1 * 24, 6);
    expect(committedUsd(records, NOW, 'c1')).toBeCloseTo(2.4, 6);
  });
});

describe('assessQuote: the budget gate', () => {
  it('refuses the first container without a daily budget ("Set a daily budget first"); no amount is pre-filled', async () => {
    h = await guardHarness({ now: NOW });
    const q = await h.guard.assessQuote(containerQuote());
    expect(q.dailyBudgetSet).toBe(false);
    expect(q.refusal).toMatchObject({ code: 'invalid_input', message: DAILY_BUDGET_REQUIRED_MESSAGE });
    expect(h.guard.dailyBudgetSet()).toBe(false);
  });

  it('a CPU sandbox needs no daily budget; a GPU sandbox does', async () => {
    h = await guardHarness({ now: NOW });
    expect((await h.guard.assessQuote(sandboxQuote())).refusal).toBeNull();
    expect((await h.guard.assessQuote(sandboxQuote({ gpu: true }))).refusal?.message).toBe(DAILY_BUDGET_REQUIRED_MESSAGE);
    // Resume and extend of an existing resource are gated by the budget, not by the daily-budget rule.
    expect((await h.guard.assessQuote(containerQuote({ action: 'resume' }))).refusal).toBeNull();
  });

  it('unknown price: refused with enforce on, a warning with enforce off', async () => {
    h = await guardHarness({ now: NOW, budget: { dailyUsd: 100 }, prices: {} });
    const q = await h.guard.assessQuote(containerQuote());
    expect(q.usdPerHour).toBeNull();
    expect(q.maxUsd).toBeNull();
    expect(q.refusal).toMatchObject({ code: 'invalid_input', message: UNKNOWN_PRICE_MESSAGE });
    await h.budget.setBudget({ enforce: false });
    const off = await h.guard.assessQuote(containerQuote());
    expect(off.refusal).toBeNull();
    expect(off.warnings.join(' ')).toMatch(/Price unknown/);
  });

  it('projections include committed burn: a fresh create that fits alone is refused next to a running container', async () => {
    h = await guardHarness({ now: NOW, budget: { dailyUsd: 20 } });
    const alone = await h.guard.assessQuote(containerQuote());
    expect(alone.maxUsd).toBeCloseTo(13.4, 6);
    expect(alone.committedUsd).toBe(0);
    expect(alone.refusal).toBeNull();
    h.reg.set(record({ id: 'c1', kind: 'container', lease: CONTAINER_LEASE, runningSince: at(11), intervals: [{ from: at(11), to: null, usdPerHour: 3.35 }] }));
    const next = await h.guard.assessQuote(containerQuote());
    expect(next.committedUsd).toBeCloseTo(3.35 * 3, 6);
    expect(next.budget.allowed).toBe(false);
    expect(next.refusal?.code).toBe('budget_exceeded');
    expect(next.warnings.join(' ')).toMatch(/already committed/);
  });

  it('enforce off: over budget is a warning, not a refusal', async () => {
    h = await guardHarness({ now: NOW, budget: { dailyUsd: 1, enforce: false } });
    const q = await h.guard.assessQuote(containerQuote());
    expect(q.budget.allowed).toBe(true);
    expect(q.refusal).toBeNull();
    expect(q.warnings.join(' ')).toMatch(/not enforced/);
  });

  it('warns about a price older than 24 h and about more than $100', async () => {
    const old = new Date(NOW.getTime() - 26 * 3_600_000).toISOString();
    h = await guardHarness({ now: NOW, budget: { dailyUsd: 10_000 }, prices: { 'gmi.container.test': 26.8 }, pricesFetchedAt: old });
    const q = await h.guard.assessQuote(containerQuote({ hours: 24 }));
    expect(q.priceAgeSec).toBe(26 * 3600);
    expect(q.warnings.join(' ')).toContain(`Price from ${old.slice(0, 10)}`);
    expect(q.warnings.join(' ')).toMatch(/more than \$100\.00: up to \$643\.20/);
  });

  it('assessQuote works without the guard (pure inputs)', async () => {
    h = await guardHarness({ now: NOW, budget: { dailyUsd: 50 } });
    const q = await assessQuote(sandboxQuote({ hours: 0 }), { prices: h.prices, budget: h.budget.guard, records: [], now: NOW });
    // A non-positive hours value falls back to 24 h.
    expect(q.maxUsd).toBeCloseTo(0.0911 * 24, 6);
  });
});

describe('dialog sentences', () => {
  it('a container left on notify says the budget will not stop it; no limit says so with the price', () => {
    expect(leaseWarnings('container', CONTAINER_LEASE, 3.35)).toEqual(['Deleted after 4 h running.', 'Your budget will not stop this container.']);
    expect(leaseWarnings('container', { ...CONTAINER_LEASE, maxLifetimeMin: null }, 3.35)[0]).toBe(
      'No automatic limit: this keeps billing $3.35/h (list) until you delete it.',
    );
    expect(leaseWarnings('sandbox', SANDBOX_LEASE, 0.0911)).toEqual(['Paused after 8 h running.', 'If your budget runs out, it is paused.']);
  });

  it('containers cannot pause: pause acts as notify', () => {
    expect(effectiveAction('container', 'pause')).toBe('notify');
    expect(effectiveAction('sandbox', 'pause')).toBe('pause');
    expect(formatDuration(90)).toBe('1.5 h');
    expect(formatDuration(1440)).toBe('1 day');
    expect(formatDuration(20)).toBe('20 min');
  });
});
