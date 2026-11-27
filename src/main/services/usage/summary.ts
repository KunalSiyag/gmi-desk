import { GmiError } from '@shared/contracts/errors';
import type { AccountSummary } from '@shared/contracts/usage';
import { toIsoDate } from '@shared/lib/format';
import type { McpGateway } from '../../core/services';
import { assertDays, createTtlCache, isRecord, nonEmptyString, toNumberOrNull } from './util';

/** How long an account summary is reused before GMI is asked again. */
export const SUMMARY_TTL_MS = 60_000;

/**
 * Money field: GMI sends `<name>_usd` as a decimal string and usually `<name>_micro_usd` as an integer.
 * Absent means unknown (null), never zero.
 */
function usdField(raw: Record<string, unknown>, name: string): number | null {
  const usd = toNumberOrNull(raw[`${name}_usd`]);
  if (usd !== null) return usd;
  const micro = toNumberOrNull(raw[`${name}_micro_usd`]);
  return micro === null ? null : micro / 1_000_000;
}

function countField(value: unknown): number | null {
  const n = toNumberOrNull(value);
  return n === null || n < 0 ? null : Math.round(n);
}

function normalizeTopModels(raw: unknown): AccountSummary['topModels'] {
  if (!Array.isArray(raw)) return [];
  const out: AccountSummary['topModels'] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const model = nonEmptyString(item.model) ?? nonEmptyString(item.model_id);
    if (!model) continue;
    out.push({
      model,
      requests: countField(item.requests) ?? 0,
      tokens: countField(item.tokens) ?? 0,
      costUsd: usdField(item, 'llm_token_cost') ?? usdField(item, 'cost') ?? 0,
    });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

/**
 * Maps MCP get_account_summary to AccountSummary.
 * - Strings become numbers; absent figures stay null (an absent promotion credit or usage figure is unknown, not zero).
 * - Balance and promotion credit are separate pools and are never added together.
 * - LLM token cost only: media spend is not part of these figures.
 */
export function normalizeAccountSummary(raw: unknown, days: number, fetchedAt: string): AccountSummary {
  if (!isRecord(raw)) throw new GmiError('upstream', 'GMI returned an unexpected account summary.');
  return {
    days,
    balanceUsd: usdField(raw, 'balance'),
    balanceUnlimited: raw.balance_unlimited === true,
    promotionCreditUsd: usdField(raw, 'promotion_credit'),
    llmRequests: countField(raw.llm_requests),
    llmTokens: countField(raw.llm_tokens),
    llmTokenCostUsd: usdField(raw, 'llm_token_cost'),
    periodStart: toIsoDate(raw.period_start),
    periodEnd: toIsoDate(raw.period_end),
    topModels: normalizeTopModels(raw.top_models),
    orgId: nonEmptyString(raw.org_id),
    usageNote: nonEmptyString(raw.usage_note),
    fetchedAt,
  };
}

export interface SummaryService {
  get(days: number): Promise<AccountSummary>;
  clear(): void;
}

export function createSummaryService(mcp: McpGateway, now: () => Date, ttlMs = SUMMARY_TTL_MS): SummaryService {
  const cache = createTtlCache<number, AccountSummary>({ ttlMs, now: () => now().getTime(), maxEntries: 8 });
  return {
    async get(days) {
      const d = assertDays(days);
      return cache.get(d, async () => {
        const raw = await mcp.callTool('get_account_summary', { days: d });
        return normalizeAccountSummary(raw, d, now().toISOString());
      });
    },
    clear: () => cache.clear(),
  };
}
