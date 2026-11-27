import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { GmiToolName, McpGateway } from '@main/core/services';
import {
  mockAccountSummary,
  mockCreateSupportRequest,
  mockListGenerations,
  mockLocalSpendSeed,
  mockSearchDocs,
  mockUsageFlags,
  usageMockTools,
} from '@main/mock/usage';
import { createUsageSlice } from '@main/services/usage';
import { scanMediaActivity } from '@main/services/usage/activity';
import { normalizeAccountSummary } from '@main/services/usage/summary';
import { parseSupportResult } from '@main/services/usage/support';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeAuth } from './fakes';

const NOW = new Date('2026-10-31T12:00:00Z');

/** The usage slice's own mock tools as an McpGateway (what mock mode serves). */
const mockMcp: McpGateway = {
  async callTool<T>(name: GmiToolName, args: Record<string, unknown> = {}) {
    const handler = usageMockTools[name];
    if (!handler) throw new Error(`no mock for ${name}`);
    return (await handler(args)) as T;
  },
};

describe('mock get_account_summary', () => {
  it('serves sanitised, plausible figures in GMI\'s shape', () => {
    const week = mockAccountSummary({ days: 7 }, NOW);
    expect(week.org_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(week).toMatchObject({ balance_usd: '128.40', promotion_credit_usd: '250.00', llm_token_cost_usd: '35.873412' });
    expect(week.period_end).toBe(Math.floor(NOW.getTime() / 1000));
    expect(week.period_start).toBe(Math.floor(NOW.getTime() / 1000) - 7 * 86_400);
    expect((week.top_models as unknown[]).length).toBe(10);
  });

  it('scales with the period and refuses out-of-range days like GMI', () => {
    const day = mockAccountSummary({ days: 1 }, NOW);
    const quarter = mockAccountSummary({ days: 90 }, NOW);
    expect(Number(day.llm_token_cost_usd)).toBeLessThan(10);
    expect(Number(quarter.llm_token_cost_usd)).toBeGreaterThan(300);
    expect(mockAccountSummary({}, NOW).period_start).toBe(day.period_start);
    expect(() => mockAccountSummary({ days: 0 }, NOW)).toThrowError('days must be between 1 and 90, got 0');
    expect(() => mockAccountSummary({ days: 91 }, NOW)).toThrowError(/between 1 and 90/);
  });
});

describe('mock list_generations', () => {
  it('pages ~40 jobs from the last 30 days, newest first, with filters', () => {
    const first = mockListGenerations({ limit: 10 }, NOW);
    expect(first.total).toBe(40);
    const jobs = first.generations as Array<{ created_at: string; modality: string; status: string; request_id: string }>;
    expect(jobs).toHaveLength(10);
    expect(jobs[0]?.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect([...jobs].sort((a, b) => b.created_at.localeCompare(a.created_at))).toEqual(jobs);
    const oldest = mockListGenerations({ limit: 100, offset: 39 }, NOW).generations as typeof jobs;
    expect(NOW.getTime() - Date.parse(oldest[0]!.created_at)).toBeLessThan(30 * 86_400_000);
    const video = mockListGenerations({ limit: 100, modality: 'video' }, NOW);
    expect((video.generations as typeof jobs).every((g) => g.modality === 'video')).toBe(true);
    expect(video.total).toBe(10);
    expect(() => mockListGenerations({ limit: 101 }, NOW)).toThrowError(/between 1 and 100/);
  });
});

describe('mock search_docs and create_support_request', () => {
  it('matches topic keywords, falls back to generic pages for filler-only queries, validates like GMI', () => {
    const results = (q: string) => (mockSearchDocs({ query: q, limit: 10 }).results as Array<{ title: string; url: string; excerpt: string }>);
    expect(results('rate limits')[0]?.title).toBe('Rate limits');
    expect(results('GMI Router')[0]?.title).toBe('GMI Router Overview');
    expect(results('API keys').map((r) => r.title)).toContain('API Keys');
    expect(results('Agentbox')[0]?.url).toContain('agentbox');
    expect(results('how do I').map((r) => r.title)).toEqual(['Welcome to GMI Cloud', 'GMI Router Overview', 'Rate limits']);
    // Raw excerpts, exactly as GMI sends them.
    expect(results('api keys').some((r) => r.excerpt.includes('srcset='))).toBe(true);
    expect(() => mockSearchDocs({ query: '  ' })).toThrow();
    expect(() => mockSearchDocs({ query: 'x', limit: 11 })).toThrowError(/between 1 and 10/);
  });

  it('returns no results when the words match nothing (the Docs page shows its "no results" state)', () => {
    const results = (q: string) => mockSearchDocs({ query: q, limit: 8 }).results as unknown[];
    expect(results('zzzzqq')).toEqual([]);
    expect(results('zzzz qqqq')).toEqual([]);
    expect(results('chat completions').length).toBeGreaterThan(0);
  });

  it('returns a fake submission that the real parser understands', () => {
    const res = mockCreateSupportRequest({ subject: 'Help', description: 'Something broke.' });
    expect(parseSupportResult(res).submissionId).toMatch(/^SR-[0-9A-F]{8}$/);
    expect(() => mockCreateSupportRequest({ subject: '', description: 'x' })).toThrow();
  });
});

describe('mock account states (GMI_DESK_MOCK_USAGE)', () => {
  const summary = (flags: string) => normalizeAccountSummary(mockAccountSummary({ days: 7 }, NOW, mockUsageFlags(flags)), 7, 'x');

  it('parses the flag list', () => {
    expect([...mockUsageFlags(' negative, no_promo ,,')]).toEqual(['negative', 'no_promo']);
    expect(mockUsageFlags('').size).toBe(0);
  });

  it('serves the edge states the Usage page has to handle', () => {
    expect(summary('negative').balanceUsd).toBe(-3.25);
    expect(summary('unlimited').balanceUnlimited).toBe(true);
    expect(summary('no_promo').promotionCreditUsd).toBeNull();
    expect(summary('unmeasured')).toMatchObject({ llmRequests: null, llmTokens: null, llmTokenCostUsd: null, topModels: [], balanceUsd: 128.4 });
    expect(summary('unmeasured').usageNote).toMatch(/could not be measured/);
    expect(summary('empty')).toMatchObject({ llmRequests: 0, llmTokens: 0, llmTokenCostUsd: 0, topModels: [], usageNote: null });
    expect(mockListGenerations({ limit: 100 }, NOW, mockUsageFlags('empty'))).toMatchObject({ generations: [], total: 0 });
    expect(mockLocalSpendSeed(NOW, mockUsageFlags('empty'))).toEqual([]);
    expect(mockLocalSpendSeed(NOW, mockUsageFlags('')).length).toBeGreaterThan(10);
    expect(() => mockAccountSummary({ days: 7 }, NOW, mockUsageFlags('error'))).toThrowError(GmiError);
    expect(() => mockListGenerations({ limit: 10 }, NOW, mockUsageFlags('error'))).toThrowError(GmiError);
    expect(() => mockListGenerations({ limit: 10 }, NOW, mockUsageFlags('media_error'))).toThrowError(GmiError);
    expect(summary('media_error').balanceUsd).toBe(128.4);
  });

  it('truncated: a busy organization outgrows one media scan', async () => {
    const mcp: McpGateway = {
      async callTool<T>(_name: GmiToolName, args: Record<string, unknown> = {}) {
        return mockListGenerations(args, NOW, mockUsageFlags('truncated')) as T;
      },
    };
    const month = await scanMediaActivity(mcp, 30, NOW);
    expect(month).toMatchObject({ truncated: true, scanned: 1000, total: 1000 });
    expect(Date.parse(month.oldestAt ?? '')).toBeGreaterThan(NOW.getTime() - 30 * 86_400_000);
    const week = await scanMediaActivity(mcp, 7, NOW);
    expect(week.truncated).toBe(false);
    expect(week.total).toBeGreaterThan(250);
  });
});

describe('usage slice over the mock tools', () => {
  let t: TestContext;
  afterEach(async () => t?.cleanup());

  it('serves every Usage and Docs view end to end', async () => {
    t = await createTestContext({ mock: true });
    const slice = await createUsageSlice(t.ctx, { auth: fakeAuth().auth, mcp: mockMcp });

    const summary = await slice.usage.getAccountSummary(7);
    expect(summary).toMatchObject({ balanceUsd: 128.4, promotionCreditUsd: 250, llmTokenCostUsd: 35.873412, usageNote: null });
    expect(summary.topModels[0]).toEqual({ model: 'openai/gpt-6-astra', requests: 14, tokens: 198402, costUsd: 9.284211 });

    const activity = await slice.usage.getMediaActivity(30);
    expect(activity.total).toBe(40);
    expect(activity.byModality).toEqual({ image: 20, video: 10, audio: 10 });
    expect(activity.byModel[0]).toEqual({ modelId: 'hy-image-v3.5-preview', count: 10, succeeded: 8, failed: 2 });
    expect(activity.truncated).toBe(false);
    expect((await slice.usage.getMediaActivity(1)).total).toBeGreaterThan(0);

    const hits = await slice.docs.search('API keys');
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.excerpt).not.toMatch(/srcset|<img|\[truncated\]|theme=\{null\}/);
      expect(hit.url.startsWith('https://')).toBe(true);
    }

    const ticket = await slice.support.createRequest({ subject: 'Invoice question', description: 'Where can I download October invoices?' });
    expect(ticket.submissionId).toMatch(/^SR-/);
    await slice.dispose();
  });
});
