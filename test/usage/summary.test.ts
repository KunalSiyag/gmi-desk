import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { createSummaryService, normalizeAccountSummary, SUMMARY_TTL_MS } from '@main/services/usage/summary';
import { createUsageSlice } from '@main/services/usage';
import { createTestContext, type TestContext } from '../helpers/context';
import { clock, fakeAuth, fakeMcp } from './fakes';

/** Shape recorded from MCP get_account_summary {days: 7}; every figure is made up. */
const RAW = {
  balance_unlimited: false,
  balance_usd: '-3.25',
  llm_requests: 1642,
  llm_token_cost_micro_usd: 31402215,
  llm_token_cost_usd: '31.402215',
  llm_tokens: 29873310,
  org_id: '00000000-0000-0000-0000-000000000000',
  period_end: 1793461681,
  period_start: 1792856881,
  promotion_credit_usd: '212.50',
  top_models: [
    { llm_token_cost_micro_usd: 1048120, llm_token_cost_usd: '1.04812', model: 'Qwen/Qwen3.8-Max', requests: 31, tokens: 240118 },
    { llm_token_cost_micro_usd: 8820417, llm_token_cost_usd: '8.820417', model: 'openai/gpt-6-astra', requests: 12, tokens: 187455 },
  ],
};

describe('normalizeAccountSummary', () => {
  it('maps decimal strings to numbers and unix seconds to ISO', () => {
    const s = normalizeAccountSummary(RAW, 7, '2026-10-31T12:00:00.000Z');
    expect(s).toMatchObject({
      days: 7,
      balanceUsd: -3.25,
      balanceUnlimited: false,
      promotionCreditUsd: 212.5,
      llmRequests: 1642,
      llmTokens: 29873310,
      llmTokenCostUsd: 31.402215,
      periodStart: new Date(1792856881 * 1000).toISOString(),
      periodEnd: new Date(1793461681 * 1000).toISOString(),
      orgId: '00000000-0000-0000-0000-000000000000',
      usageNote: null,
      fetchedAt: '2026-10-31T12:00:00.000Z',
    });
    // Sorted by cost, strings converted.
    expect(s.topModels).toEqual([
      { model: 'openai/gpt-6-astra', requests: 12, tokens: 187455, costUsd: 8.820417 },
      { model: 'Qwen/Qwen3.8-Max', requests: 31, tokens: 240118, costUsd: 1.04812 },
    ]);
  });

  it('keeps an absent promotion credit unknown (null), but a known zero as 0', () => {
    const { promotion_credit_usd: _omit, ...withoutPromo } = RAW;
    expect(normalizeAccountSummary(withoutPromo, 7, 'x').promotionCreditUsd).toBeNull();
    expect(normalizeAccountSummary({ ...RAW, promotion_credit_usd: '0.00' }, 7, 'x').promotionCreditUsd).toBe(0);
    expect(normalizeAccountSummary({ ...RAW, promotion_credit_usd: '' }, 7, 'x').promotionCreditUsd).toBeNull();
  });

  it('never turns unmeasured usage into zeros when usage_note is present', () => {
    const raw = {
      balance_unlimited: false,
      balance_usd: '12.00',
      org_id: 'org',
      period_start: 1792856881,
      period_end: 1793461681,
      usage_note: 'Usage could not be measured right now.',
    };
    const s = normalizeAccountSummary(raw, 7, 'x');
    expect(s.usageNote).toBe('Usage could not be measured right now.');
    expect(s.llmRequests).toBeNull();
    expect(s.llmTokens).toBeNull();
    expect(s.llmTokenCostUsd).toBeNull();
    expect(s.topModels).toEqual([]);
    expect(s.balanceUsd).toBe(12);
    // A measured zero stays zero.
    expect(normalizeAccountSummary({ ...raw, usage_note: undefined, llm_requests: 0, llm_token_cost_usd: '0' }, 7, 'x')).toMatchObject({
      llmRequests: 0,
      llmTokenCostUsd: 0,
      usageNote: null,
    });
  });

  it('falls back to *_micro_usd when the decimal string is missing; never sums balance and promotion credit', () => {
    const s = normalizeAccountSummary({ balance_micro_usd: 1_500_000, promotion_credit_usd: '2.00', llm_token_cost_micro_usd: 250_000 }, 1, 'x');
    expect(s.balanceUsd).toBe(1.5);
    expect(s.llmTokenCostUsd).toBe(0.25);
    expect(s.promotionCreditUsd).toBe(2);
  });

  it('reports unlimited balances and rejects non-objects', () => {
    expect(normalizeAccountSummary({ balance_unlimited: true }, 1, 'x')).toMatchObject({ balanceUnlimited: true, balanceUsd: null });
    expect(() => normalizeAccountSummary('nope', 1, 'x')).toThrowError(GmiError);
  });
});

describe('summary service', () => {
  it.each([0, 91, 1.5, -7, Number.NaN, '7', null])('refuses days=%s before calling GMI', async (days) => {
    const { mcp, calls } = fakeMcp({ get_account_summary: () => RAW });
    const service = createSummaryService(mcp, () => new Date());
    await expect(service.get(days as number)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('passes days through, caches per period for ~60s and de-duplicates concurrent loads', async () => {
    const c = clock(new Date('2026-10-31T12:00:00Z'));
    const { mcp, calls } = fakeMcp({ get_account_summary: () => RAW });
    const service = createSummaryService(mcp, c.now);
    const [a, b] = await Promise.all([service.get(7), service.get(7)]);
    expect(a).toBe(b);
    expect(calls).toEqual([{ name: 'get_account_summary', args: { days: 7 }, opts: undefined }]);
    await service.get(30);
    expect(calls.map((x) => x.args.days)).toEqual([7, 30]);
    c.advance(SUMMARY_TTL_MS - 1);
    await service.get(7);
    expect(calls).toHaveLength(2);
    c.advance(2);
    await service.get(7);
    expect(calls).toHaveLength(3);
    service.clear();
    await service.get(7);
    expect(calls).toHaveLength(4);
  });

  it('does not cache failures', async () => {
    let fail = true;
    const { mcp, calls } = fakeMcp({
      get_account_summary: () => {
        if (fail) throw new GmiError('not_signed_in', 'Sign in');
        return RAW;
      },
    });
    const service = createSummaryService(mcp, () => new Date());
    await expect(service.get(1)).rejects.toMatchObject({ code: 'not_signed_in' });
    fail = false;
    await expect(service.get(1)).resolves.toMatchObject({ days: 1 });
    expect(calls).toHaveLength(2);
  });
});

describe('usage slice wiring', () => {
  let t: TestContext;
  afterEach(async () => t?.cleanup());

  it('drops cached figures on refresh() and when the sign-in changes', async () => {
    t = await createTestContext();
    const { mcp, count } = fakeMcp({ get_account_summary: () => RAW });
    const auth = fakeAuth();
    const slice = await createUsageSlice(t.ctx, { auth: auth.auth, mcp });
    await slice.usage.getAccountSummary(7);
    await slice.usage.getAccountSummary(7);
    expect(count('get_account_summary')).toBe(1);
    await slice.usage.refresh();
    await slice.usage.getAccountSummary(7);
    expect(count('get_account_summary')).toBe(2);
    auth.fire({ status: 'signed_out' });
    await slice.usage.getAccountSummary(7);
    expect(count('get_account_summary')).toBe(3);
    await slice.dispose();
    expect(auth.listenerCount()).toBe(0);
  });

  it('exposes only IPC methods on the API objects', async () => {
    t = await createTestContext();
    const slice = await createUsageSlice(t.ctx, { auth: fakeAuth().auth, mcp: fakeMcp().mcp });
    expect(Object.keys(slice.usage).sort()).toEqual(['getAccountSummary', 'getBudget', 'getLocalSpend', 'getMediaActivity', 'refresh', 'setBudget']);
    expect(Object.keys(slice.docs)).toEqual(['search']);
    expect(Object.keys(slice.support)).toEqual(['createRequest']);
    await slice.dispose();
  });
});
