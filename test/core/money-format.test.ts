import { describe, expect, it } from 'vitest';
import { formatRelativeTime, formatTokens, toIsoDate } from '@shared/lib/format';
import {
  applyDiscount,
  estimateTokenCostUsd,
  formatDiscount,
  formatUsd,
  hundredthsPercentToFraction,
  microUsdToUsd,
  usdPerTokenToPerMTok,
} from '@shared/lib/money';

describe('money', () => {
  it('converts GMI unit systems to USD', () => {
    expect(usdPerTokenToPerMTok('0.000001400')).toBe(1.4);
    expect(usdPerTokenToPerMTok('0')).toBe(0);
    expect(usdPerTokenToPerMTok(null)).toBeNull();
    expect(microUsdToUsd(1_400_000)).toBe(1.4);
    expect(microUsdToUsd(66_700)).toBe(0.0667);
    expect(hundredthsPercentToFraction(2000)).toBe(0.2);
    expect(hundredthsPercentToFraction(0)).toBe(0);
  });

  it('applies discounts and estimates token cost', () => {
    expect(applyDiscount(1.4, 0.5)).toBe(0.7);
    expect(applyDiscount(1.4, null)).toBe(1.4);
    expect(applyDiscount(null, 0.5)).toBeNull();
    const cost = estimateTokenCostUsd(
      { promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 200_000 },
      { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26 },
      0.5,
    );
    // (800k × 1.4 + 200k × 0.26 + 500k × 4.4) / 1M = 1.12 + 0.052 + 2.2 = 3.372 → × 0.5
    expect(cost).toBeCloseTo(1.686, 6);
    expect(estimateTokenCostUsd({ promptTokens: 1, completionTokens: 1 }, null)).toBeNull();
  });

  it('formats USD sensibly', () => {
    expect(formatUsd(1.4)).toBe('$1.40');
    expect(formatUsd(12345.678)).toBe('$12,345.68');
    expect(formatUsd(0.35)).toBe('$0.35');
    expect(formatUsd(0.00042)).toBe('$0.00042');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(-2)).toBe('-$2.00');
    expect(formatUsd(0.0667, { perUnit: 'second' })).toBe('$0.067 / second');
    expect(formatDiscount(0.5)).toBe('50% off');
    expect(formatDiscount(0)).toBeNull();
  });
});

describe('format', () => {
  it('formats token counts', () => {
    expect(formatTokens(1_048_576)).toBe('1M');
    expect(formatTokens(202_752)).toBe('203K');
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(null)).toBe('—');
  });

  it('formats relative time', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    expect(formatRelativeTime('2026-10-31T11:59:50Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-10-31T11:30:00Z', now)).toBe('30m ago');
    expect(formatRelativeTime('2026-10-31T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeTime('2026-10-29T12:00:00Z', now)).toBe('2d ago');
  });

  it('normalises dates from seconds, milliseconds and ISO', () => {
    expect(toIsoDate(1783467941)).toBe(new Date(1783467941 * 1000).toISOString());
    expect(toIsoDate(1787079600000)).toBe(new Date(1787079600000).toISOString());
    expect(toIsoDate('2026-05-12T19:05:00Z')).toBe('2026-05-12T19:05:00.000Z');
    expect(toIsoDate('garbage')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
  });
});
