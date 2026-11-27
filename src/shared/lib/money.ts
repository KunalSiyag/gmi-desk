/**
 * GMI publishes prices in three unit systems; everything in the app is normalised to USD.
 * - MCP LLM pricing: USD per token as decimal strings ("0.000001400")       → × 1e6 = USD per 1M tokens
 * - Console price feeds: micro-USD per 1M tokens (1400000 = $1.40 / 1M)    → ÷ 1e6
 * - Media pricing: micro-USD per unit (66700 per second = $0.0667 / s)     → ÷ 1e6
 * - Discounts: MCP `discount_to_user` is a fraction (0.5); console feeds use hundredths of a percent (2000 = 20%).
 */

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "0.000001400" (USD/token) → 1.4 (USD per 1M tokens). */
export function usdPerTokenToPerMTok(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n === null ? null : roundPrice(n * 1_000_000);
}

/** 1400000 (micro-USD) → 1.4 (USD). */
export function microUsdToUsd(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n === null ? null : roundPrice(n / 1_000_000);
}

/** 2000 (hundredths of a percent) → 0.2. */
export function hundredthsPercentToFraction(value: unknown): number | null {
  const n = toFiniteNumber(value);
  if (n === null) return null;
  return clampFraction(n / 10_000);
}

export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** list × (1 − discount). Null-safe. */
export function applyDiscount(listUsd: number | null | undefined, discount: number | null | undefined): number | null {
  if (listUsd === null || listUsd === undefined || !Number.isFinite(listUsd)) return null;
  const d = discount === null || discount === undefined ? 0 : clampFraction(discount);
  return roundPrice(listUsd * (1 - d));
}

/** Removes float noise (e.g. 1.4000000000000001) without losing sub-cent precision. */
export function roundPrice(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number | null;
  /** Prompt tokens written to the provider's cache (billed at the cache-write rate). Part of promptTokens. */
  cacheWriteTokens?: number | null;
}

export interface PerMTokPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cacheReadPerMTok?: number | null;
  /** Null/absent: cache writes cost the input price. */
  cacheWritePerMTok?: number | null;
}

/**
 * Estimated chat cost in USD from token usage and list prices (discount applied when given):
 * ((prompt − cached − cacheWrite) × in + cached × cacheRead + cacheWrite × cacheWrite + completion × out) / 1e6.
 */
export function estimateTokenCostUsd(
  usage: TokenCounts,
  pricing: PerMTokPricing | null | undefined,
  discount?: number | null,
): number | null {
  if (!pricing || pricing.inputPerMTok === null || pricing.outputPerMTok === null) return null;
  const cached = Math.max(0, Math.min(usage.cachedTokens ?? 0, usage.promptTokens));
  const cacheWrite = Math.max(0, Math.min(usage.cacheWriteTokens ?? 0, usage.promptTokens - cached));
  const uncachedPrompt = usage.promptTokens - cached - cacheWrite;
  const cacheRate = pricing.cacheReadPerMTok ?? pricing.inputPerMTok;
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;
  const list =
    (uncachedPrompt * pricing.inputPerMTok +
      cached * cacheRate +
      cacheWrite * cacheWriteRate +
      usage.completionTokens * pricing.outputPerMTok) /
    1_000_000;
  return applyDiscount(list, discount ?? null);
}

/** "$1.40", "$0.0042", "$12,345.67", "—". */
export function formatUsd(value: number | null | undefined, opts: { signed?: boolean; perUnit?: string } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  let digits: Intl.NumberFormatOptions;
  if (abs === 0) digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  else if (abs >= 1) digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  else if (abs >= 0.01) digits = { minimumFractionDigits: 2, maximumFractionDigits: 3 };
  else digits = { maximumSignificantDigits: 3 };
  const body = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...digits }).format(abs);
  const sign = value < 0 ? '-' : opts.signed && value > 0 ? '+' : '';
  return `${sign}${body}${opts.perUnit ? ` / ${opts.perUnit}` : ''}`;
}

/** 0.5 → "50% off". */
export function formatDiscount(discount: number | null | undefined): string | null {
  if (discount === null || discount === undefined || discount <= 0) return null;
  const pct = Math.round(clampFraction(discount) * 1000) / 10;
  return `${pct}% off`;
}
