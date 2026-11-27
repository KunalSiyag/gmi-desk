// Owned by the Usage slice: mock handlers for get_account_summary, list_generations (activity), search_docs,
// create_support_request, plus the mock-mode seed for this device's spend ledger and budget.
import { randomUUID } from 'node:crypto';
import { GmiError } from '@shared/contracts/errors';
import type { Budget, SpendKind } from '@shared/contracts/usage';
import type { SeedEntry } from '../services/usage/ledger';
import accountSummaryFixture from './fixtures/usage/account-summary.json';
import docsFixture from './fixtures/usage/docs.json';
import generationsFixture from './fixtures/usage/generations.json';
import localSpendFixture from './fixtures/usage/local-spend.json';
import type { MockToolTable } from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Dev/screenshot knob: GMI_DESK_MOCK_USAGE="negative,no_promo" serves other account states in mock mode.
 * Flags: negative (balance below zero), unlimited, no_promo (promotion credit unknown), unmeasured (usage_note,
 * no usage figures), empty (no LLM usage, media jobs or local spend), truncated (more media jobs than one scan
 * reads), error (GMI fails for the summary and media activity), media_error (only media activity fails).
 */
export function mockUsageFlags(raw: string | undefined = process.env.GMI_DESK_MOCK_USAGE): Set<string> {
  return new Set((raw ?? '').split(',').map((f) => f.trim()).filter(Boolean));
}

function demoFailure(): GmiError {
  return new GmiError('upstream', 'GMI did not answer (demo error).', { status: 503 });
}

function intArg(args: Record<string, unknown>, name: string, fallback: number, min: number, max: number): number {
  const value = args[name] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new GmiError('invalid_input', `${name} must be between ${min} and ${max}, got ${String(value)}`);
  }
  return value;
}

/** Deterministic 0..1 from a string (stable mock numbers per model and period). */
function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

const PERIOD_FACTOR: Record<number, number> = { 1: 0.16, 7: 1, 30: 3.92, 90: 10.7 };

/** get_account_summary: the recorded 7-day shape with fake figures, scaled to the requested period. */
export function mockAccountSummary(args: Record<string, unknown>, now: Date, flags: Set<string> = new Set()): Record<string, unknown> {
  const days = intArg(args, 'days', 1, 1, 90);
  if (flags.has('error')) throw demoFailure();
  const result = scaledAccountSummary(days, now);
  if (flags.has('negative')) result.balance_usd = '-3.25';
  if (flags.has('unlimited')) result.balance_unlimited = true;
  if (flags.has('no_promo')) delete result.promotion_credit_usd;
  if (flags.has('empty')) {
    Object.assign(result, { llm_requests: 0, llm_token_cost_micro_usd: 0, llm_token_cost_usd: '0.00', llm_tokens: 0, top_models: [] });
  }
  if (flags.has('unmeasured')) {
    for (const key of ['llm_requests', 'llm_token_cost_micro_usd', 'llm_token_cost_usd', 'llm_tokens', 'top_models']) delete result[key];
    result.usage_note = 'LLM usage could not be measured for this period. Try again later.';
  }
  return result;
}

function scaledAccountSummary(days: number, now: Date): Record<string, unknown> {
  const base = accountSummaryFixture.response;
  const factor = PERIOD_FACTOR[days] ?? (days / 7) * (days < 7 ? 1.1 : 0.94);
  const top = base.top_models
    .map((m) => {
      const k = factor * (days === 7 ? 1 : 0.7 + unit(`${m.model}:${days}`) * 0.6);
      const micro = Math.round(m.llm_token_cost_micro_usd * k);
      return {
        llm_token_cost_micro_usd: micro,
        llm_token_cost_usd: String(micro / 1e6),
        model: m.model,
        requests: Math.round(m.requests * k),
        tokens: Math.round(m.tokens * k),
      };
    })
    .filter((m) => m.requests >= 1)
    .sort((a, b) => b.llm_token_cost_micro_usd - a.llm_token_cost_micro_usd);
  const sum = (rows: Array<Record<string, number>>, key: string) => rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);
  const baseTop = base.top_models as unknown as Array<Record<string, number>>;
  const scaledTop = top as unknown as Array<Record<string, number>>;
  const others = (key: string, total: number) => Math.max(0, Math.round((total - sum(baseTop, key)) * factor));
  const costMicro = sum(scaledTop, 'llm_token_cost_micro_usd') + others('llm_token_cost_micro_usd', base.llm_token_cost_micro_usd);
  const end = Math.floor(now.getTime() / 1000);
  return {
    balance_unlimited: base.balance_unlimited,
    balance_usd: base.balance_usd,
    llm_requests: sum(scaledTop, 'requests') + others('requests', base.llm_requests),
    llm_token_cost_micro_usd: costMicro,
    llm_token_cost_usd: String(costMicro / 1e6),
    llm_tokens: sum(scaledTop, 'tokens') + others('tokens', base.llm_tokens),
    org_id: base.org_id,
    period_end: end,
    period_start: end - days * 86_400,
    promotion_credit_usd: base.promotion_credit_usd,
    top_models: top,
  };
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

type FixtureJob = (typeof generationsFixture.generations)[number];

/** `truncated` flag: a busy organization (a job every ~33 minutes for 30 days), more than one scan reads. */
function busyJobs(): FixtureJob[] {
  const base = generationsFixture.generations;
  return Array.from({ length: 1300 }, (_, i) => {
    const g = base[i % base.length] as FixtureJob;
    return { ...g, ago_hours: 0.05 + i * 0.55, request_id: `${g.request_id.slice(0, 24)}${String(i).padStart(12, '0')}` };
  });
}

/** list_generations: ~40 image/video/audio jobs over the last 30 days, newest first, with GMI's filters and paging. */
export function mockListGenerations(args: Record<string, unknown>, now: Date, flags: Set<string> = new Set()): Record<string, unknown> {
  const limit = intArg(args, 'limit', 20, 1, 100);
  const offset = intArg(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (flags.has('error') || flags.has('media_error')) throw demoFailure();
  const match =(name: string, value: string) => typeof args[name] !== 'string' || !args[name] || args[name] === value;
  const source: FixtureJob[] = flags.has('empty') ? [] : flags.has('truncated') ? busyJobs() : generationsFixture.generations;
  const all = source
    .map((g) => ({
      created_at: isoSeconds(now.getTime() - g.ago_hours * HOUR_MS),
      modality: g.modality,
      model_id: g.model_id,
      request_id: g.request_id,
      status: g.status,
    }))
    .filter((g) => match('modality', g.modality) && match('model_id', g.model_id) && match('status', g.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { generations: all.slice(offset, offset + limit), offset, total: all.length };
}

const STOPWORDS = new Set(['the', 'and', 'for', 'how', 'what', 'with', 'does', 'can', 'use', 'are', 'you', 'your', 'from', 'into', 'about', 'gmi', 'cloud', 'do', 'to', 'of', 'in', 'on', 'a', 'an', 'is', 'my', 'i']);

/**
 * search_docs: keyword match over recorded (raw, uncleaned) excerpts. A query of only filler words ("how do I")
 * gets the generic pages; words that match nothing get no results, so mock mode shows the "no results" state.
 */
export function mockSearchDocs(args: Record<string, unknown>): Record<string, unknown> {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  if (!query) throw new GmiError('invalid_input', 'query must not be empty');
  const limit = intArg(args, 'limit', 10, 1, 10);
  const tokens = query.split(/[^a-z0-9_.]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const results = docsFixture.results;
  const scored = results
    .map((r, index) => {
      let score = 0;
      for (const k of r.keywords) if (query.includes(k)) score += 4;
      for (const t of tokens) {
        if (r.keywords.some((k) => k.split(' ').includes(t))) score += 2;
        if (r.title.toLowerCase().includes(t)) score += 2;
        else if (r.excerpt.toLowerCase().includes(t)) score += 1;
      }
      return { r, score, index };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.r);
  const vague = tokens.length === 0;
  const hits = scored.length > 0 || !vague ? scored : docsFixture.generic.flatMap((url) => results.filter((r) => r.url === url));
  return { results: hits.slice(0, limit).map(({ excerpt, title, url }) => ({ excerpt, title, url })) };
}

/** create_support_request: validates like GMI and returns a fake submission (nothing is filed). */
export function mockCreateSupportRequest(args: Record<string, unknown>): Record<string, unknown> {
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const description = typeof args.description === 'string' ? args.description : '';
  if (!subject.trim() || subject.length > 200) throw new GmiError('invalid_input', 'subject must be 1 to 200 characters');
  if (!description.trim() || description.length > 5000) throw new GmiError('invalid_input', 'description must be 1 to 5000 characters');
  return {
    message: 'Your request was submitted to GMI support (demo mode: nothing was sent).',
    submission_id: `SR-${randomUUID().slice(0, 8).toUpperCase()}`,
  };
}

export const usageMockTools: MockToolTable = {
  get_account_summary: (args) => mockAccountSummary(args, new Date(), mockUsageFlags()),
  list_generations: (args) => mockListGenerations(args, new Date(), mockUsageFlags()),
  search_docs: (args) => mockSearchDocs(args),
  create_support_request: (args) => mockCreateSupportRequest(args),
};

/** Mock mode: budget written on first run so the Usage page shows progress against limits. */
export const MOCK_BUDGET: Budget = { ...localSpendFixture.budget };

/** Mock mode: this device's spend ledger on first run, placed relative to `now` (today, this month, last 90 days). */
export function mockLocalSpendSeed(now: Date, flags: Set<string> = mockUsageFlags()): SeedEntry[] {
  if (flags.has('empty')) return [];
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return localSpendFixture.entries
    .filter((e) => e.kind === 'chat' || e.kind === 'media')
    .map((e) => {
      const at =
        e.daysAgo === 0
          ? todayStart + (now.getTime() - todayStart) * e.dayFraction
          : new Date(now.getFullYear(), now.getMonth(), now.getDate() - e.daysAgo).getTime() + e.dayFraction * DAY_MS;
      return { at: new Date(at).toISOString(), kind: e.kind as SpendKind, modelId: e.modelId, usd: e.usd };
    });
}
