import { describe, expect, it } from 'vitest';
import featured from '@main/mock/fixtures/catalog/public-featured.json';
import leaderboard from '@main/mock/fixtures/catalog/public-leaderboard.json';
import llm from '@main/mock/fixtures/catalog/mcp-search-llm.json';
import mm from '@main/mock/fixtures/catalog/mcp-search-multimodal.json';
import prices from '@main/mock/fixtures/catalog/public-model-prices.json';
import media from '@main/mock/fixtures/catalog/public-requestqueue-models.json';
import { mergeSources } from '@main/services/catalog/merge';
import {
  normalizeFeatured,
  normalizeLeaderboard,
  normalizeMcpSearch,
  normalizePublicMedia,
  normalizePublicPrices,
} from '@main/services/catalog/normalize';
import type { CatalogModel, LeaderboardEntry } from '@shared/contracts/catalog';
import {
  arrivedAt,
  buildCatalogView,
  DEFAULT_FILTERS,
  findById,
  leaderboardBest,
  matchesQuery,
  priceKey,
  revealModel,
  searchTokens,
  sortLeaderboard,
  sortModels,
  type CatalogFilters,
} from '../../src/renderer/pages/models/filter';

function model(over: Partial<CatalogModel> & { id: string }): CatalogModel {
  return {
    name: over.id,
    kind: 'llm',
    provider: null,
    description: null,
    iconUrl: null,
    tags: [],
    api: 'chat',
    contextLength: null,
    quantization: null,
    llmPricing: null,
    mediaPricing: null,
    discount: null,
    inputs: [],
    outputs: [],
    available: true,
    featured: false,
    createdAt: null,
    firstSeenAt: '2000-01-01T00:00:00.000Z',
    isNew: false,
    leaderboard: null,
    sources: ['mcp'],
    ...over,
  };
}

const llmPrice = (input: number, output: number) => ({ inputPerMTok: input, outputPerMTok: output, cacheReadPerMTok: null, cacheWritePerMTok: null });
const mediaPrice = (usd: number) => ({ usdPerUnit: usd, unit: 'second', pricingType: null, details: null });
const scores = (overall: number) => ({ overall, coding: null, agentic: null, reasoning: null });

const MODELS: CatalogModel[] = [
  model({ id: 'zai-org/GLM-5.3', name: 'GLM-5.3', provider: 'Z.ai', featured: true, featuredOrder: 3, llmPricing: llmPrice(1.4, 4.4), discount: 0.5, contextLength: 1_048_576 }),
  model({ id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax-M3', provider: 'MiniMax', featured: true, featuredOrder: 1, llmPricing: llmPrice(0.3, 1.2), contextLength: 1_000_000 }),
  model({ id: 'openai/gpt-5.5', name: 'GPT-5.5', provider: 'OpenAI', leaderboard: scores(81.6), llmPricing: llmPrice(5, 30), contextLength: 400_000 }),
  model({ id: 'qwen/qwen3.7-max', name: 'Qwen3.7-Max', provider: 'Qwen', leaderboard: scores(73.7), llmPricing: llmPrice(2.5, 7.5) }),
  model({ id: 'deepseek-ai/new-one', name: 'New One', provider: 'DeepSeek', isNew: true, firstSeenAt: '2026-10-30T00:00:00.000Z', llmPricing: llmPrice(0.1, 0.4), contextLength: 128_000 }),
  model({ id: 'seedance-2-5', name: 'seedance-2-5', kind: 'video', api: 'queue', provider: 'ByteDance', featured: true, featuredOrder: 2, mediaPricing: mediaPrice(0.231), tags: ['Text-to-Video'], createdAt: '2026-08-07T00:00:00.000Z' }),
  model({ id: 'kling-3', name: 'kling-3', kind: 'video', api: 'queue', provider: 'Kling', mediaPricing: mediaPrice(0.112), discount: 0.2, createdAt: '2026-09-01T00:00:00.000Z' }),
  model({ id: 'tts-hd', name: 'tts-hd', kind: 'audio', api: 'queue', provider: 'MiniMax', mediaPricing: null, isNew: true, firstSeenAt: '2026-10-31T00:00:00.000Z' }),
  model({ id: 'b8028c17-3215-4775-9b58-ae3012e20b08', name: 'Kiss', kind: 'workflow', api: 'queue', provider: 'GMI Studio', mediaPricing: mediaPrice(0.15) }),
];

const filters = (over: Partial<CatalogFilters> = {}): CatalogFilters => ({ ...DEFAULT_FILTERS, ...over });
const ids = (list: CatalogModel[]) => list.map((m) => m.id);

describe('Models page: search', () => {
  it('matches every token against id, name, provider, kind and tags', () => {
    const glm = MODELS[0]!;
    expect(matchesQuery(glm, searchTokens('glm'))).toBe(true);
    expect(matchesQuery(glm, searchTokens('zai-org z.ai'))).toBe(true);
    expect(matchesQuery(glm, searchTokens('glm openai'))).toBe(false);
    expect(matchesQuery(MODELS[5]!, searchTokens('text-to-video'))).toBe(true);
    expect(matchesQuery(MODELS[5]!, searchTokens('VIDEO bytedance'))).toBe(true);
    expect(matchesQuery(glm, searchTokens('  '))).toBe(true);
  });

  it('finds models by id case-insensitively', () => {
    expect(findById(MODELS, 'ZAI-ORG/glm-5.3')?.id).toBe('zai-org/GLM-5.3');
    expect(findById(MODELS, 'nope')).toBeNull();
    expect(findById(MODELS, undefined)).toBeNull();
  });
});

describe('Models page: faceted view', () => {
  it('counts kinds with the other filters applied, but not the kind itself', () => {
    const view = buildCatalogView(MODELS, filters({ kind: 'video', onlyFeatured: true }));
    expect(ids(view.rows)).toEqual(['seedance-2-5']);
    expect(view.kindCounts).toEqual({ all: 3, llm: 2, image: 0, video: 1, audio: 0, workflow: 0 });
    expect(view.narrowed).toBe(true);
  });

  it('lists providers for the current kind and counts each toggle as if it were flipped', () => {
    const view = buildCatalogView(MODELS, filters({ kind: 'llm' }));
    expect(view.providers.map((p) => p.name)).toEqual(['DeepSeek', 'MiniMax', 'OpenAI', 'Qwen', 'Z.ai']);
    expect(view.toggleCounts).toEqual({ new: 1, featured: 2, discounted: 1 });
    expect(view.narrowed).toBe(false);

    const byProvider = buildCatalogView(MODELS, filters({ provider: 'MiniMax' }));
    expect(ids(byProvider.rows).sort()).toEqual(['MiniMaxAI/MiniMax-M3', 'tts-hd']);
    expect(byProvider.kindCounts.all).toBe(2);
    expect(byProvider.kindCounts.audio).toBe(1);
  });

  it('combines search with toggles', () => {
    const view = buildCatalogView(MODELS, filters({ query: 'minimax', onlyNew: true }));
    expect(ids(view.rows)).toEqual(['tts-hd']);
    expect(view.toggleCounts.featured).toBe(0);
  });
});

describe('Models page: sorting', () => {
  it('recommends featured (GMI order), then new, then leaderboard, then the rest by kind', () => {
    const sorted = ids(sortModels(MODELS, 'recommended'));
    expect(sorted.slice(0, 3)).toEqual(['MiniMaxAI/MiniMax-M3', 'seedance-2-5', 'zai-org/GLM-5.3']);
    expect(sorted.slice(3, 5)).toEqual(['tts-hd', 'deepseek-ai/new-one']);
    expect(sorted.slice(5, 7)).toEqual(['openai/gpt-5.5', 'qwen/qwen3.7-max']);
    expect(sorted.slice(7)).toEqual(['kling-3', 'b8028c17-3215-4775-9b58-ae3012e20b08']);
  });

  it('sorts by charged price within each kind, unknown prices last', () => {
    const sorted = ids(sortModels(MODELS, 'price'));
    // LLM blend (3 in + 1 out) / 4 after discounts: new-one 0.175, GLM 1.075 (50% off), MiniMax 0.525...
    expect(sorted.slice(0, 5)).toEqual(['deepseek-ai/new-one', 'MiniMaxAI/MiniMax-M3', 'zai-org/GLM-5.3', 'qwen/qwen3.7-max', 'openai/gpt-5.5']);
    expect(sorted.slice(5, 7)).toEqual(['kling-3', 'seedance-2-5']);
    expect(sorted.at(-1)).toBe('b8028c17-3215-4775-9b58-ae3012e20b08');
    expect(sorted.indexOf('tts-hd')).toBe(7);
    expect(priceKey(MODELS[0]!)).toBeCloseTo((3 * 0.7 + 2.2) / 4);
    expect(priceKey(MODELS[6]!)).toBeCloseTo(0.0896);
    expect(priceKey(MODELS[7]!)).toBeNull();
  });

  it('sorts by context (largest first, unknown last), newest and name', () => {
    expect(ids(sortModels(MODELS, 'context')).slice(0, 4)).toEqual(['zai-org/GLM-5.3', 'MiniMaxAI/MiniMax-M3', 'openai/gpt-5.5', 'deepseek-ai/new-one']);
    const newest = ids(sortModels(MODELS, 'newest'));
    expect(newest.slice(0, 4)).toEqual(['tts-hd', 'deepseek-ai/new-one', 'kling-3', 'seedance-2-5']);
    expect(arrivedAt(MODELS[5]!)).toBe(Date.parse('2026-08-07T00:00:00.000Z'));
    // Case-insensitive by display name: GLM-5.3, GPT-5.5, Kiss, kling-3, MiniMax-M3, ...
    expect(ids(sortModels(MODELS, 'name')).slice(0, 4)).toEqual(['zai-org/GLM-5.3', 'openai/gpt-5.5', 'b8028c17-3215-4775-9b58-ae3012e20b08', 'kling-3']);
  });
});

describe('Models page: revealing a model opened by id', () => {
  it('only clears the filters that hide it', () => {
    const glm = MODELS[0]!;
    const next = revealModel(filters({ kind: 'video', provider: 'Kling', onlyNew: true, onlyFeatured: true, query: 'glm', sort: 'price' }), glm);
    expect(next).toEqual(filters({ kind: 'llm', provider: null, onlyNew: false, onlyFeatured: true, query: 'glm', sort: 'price' }));
    const other = revealModel(filters({ kind: 'all', query: 'video' }), MODELS[7]!);
    expect(other.query).toBe('');
    expect(other.kind).toBe('all');
  });
});

describe('Models page: leaderboard', () => {
  const entry = (modelId: string, quality: Record<string, number>): LeaderboardEntry => ({
    modelId,
    name: modelId.split('/').pop() ?? modelId,
    provider: null,
    openSource: false,
    publishedAt: null,
    quality,
    cost: {},
  });
  const entries = [entry('a/one', { overall: 70, coding: 90 }), entry('b/two', { overall: 80 }), entry('c/three', { overall: 75, coding: 60 })];

  it('sorts by a category with missing scores last and filters by search', () => {
    expect(sortLeaderboard(entries, 'overall').map((e) => e.modelId)).toEqual(['b/two', 'c/three', 'a/one']);
    expect(sortLeaderboard(entries, 'coding').map((e) => e.modelId)).toEqual(['a/one', 'c/three', 'b/two']);
    expect(sortLeaderboard(entries, 'overall', 'three').map((e) => e.modelId)).toEqual(['c/three']);
  });

  it('finds the best score per category', () => {
    expect(leaderboardBest(entries)).toEqual({ overall: 80, coding: 90 });
  });
});

describe('Models page over the recorded catalog', () => {
  const now = new Date().toISOString();
  const merged = mergeSources({
    public_prices: normalizePublicPrices(prices),
    public_media: normalizePublicMedia(media),
    featured: normalizeFeatured(featured),
    leaderboard: normalizeLeaderboard(leaderboard, now),
    mcp: normalizeMcpSearch({ llm, multimodal: [mm] }),
  });

  it('keeps kind counts consistent with the list', () => {
    const all = buildCatalogView(merged.models, filters());
    const { all: total, ...perKind } = all.kindCounts;
    const other = merged.models.filter((m) => m.kind === 'other').length;
    expect(Object.values(perKind).reduce((a, b) => a + b, 0) + other).toBe(total);
    expect(all.rows).toHaveLength(total);
    for (const kind of ['llm', 'image', 'video', 'audio', 'workflow'] as const) {
      expect(buildCatalogView(merged.models, filters({ kind })).rows).toHaveLength(all.kindCounts[kind]);
    }
  });

  it('puts GMI’s featured models first in their published order', () => {
    const rows = buildCatalogView(merged.models, filters()).rows;
    const featuredRows = rows.filter((m) => m.featured);
    expect(rows.slice(0, featuredRows.length).every((m) => m.featured)).toBe(true);
    const orders = featuredRows.map((m) => m.featuredOrder).filter((o): o is number => typeof o === 'number');
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});
