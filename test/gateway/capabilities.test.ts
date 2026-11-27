import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogModel } from '@shared/contracts/catalog';
import type { CatalogService } from '@main/core/services';
import {
  BASE_CAPABILITIES,
  capabilitiesFor,
  createModelResolver,
  guessApi,
  isGatewayModelId,
  loadCapabilityOverrides,
  parseCapabilityOverrides,
  reasoningFamily,
  sanitizeCapabilities,
} from '@main/services/gateway/capabilities';
import { mockPricing } from '@main/services/gateway/mock';
import { GATEWAY_LIMITS } from '@main/services/gateway/types';

function llm(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    kind: 'llm',
    provider: null,
    description: null,
    iconUrl: null,
    tags: [],
    api: 'chat',
    contextLength: 1_048_576,
    quantization: null,
    llmPricing: { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26, cacheWritePerMTok: null },
    mediaPricing: null,
    discount: 0.5,
    inputs: [],
    outputs: [],
    available: true,
    featured: false,
    createdAt: null,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    isNew: false,
    leaderboard: null,
    sources: ['mcp'],
    ...over,
  };
}

function catalog(models: CatalogModel[]): CatalogService & { calls: number } {
  const c = {
    calls: 0,
    getSnapshot: async () => {
      c.calls += 1;
      return { models, updatedAt: null, sources: {}, refreshing: false };
    },
    findModel: async (id: string) => models.find((m) => m.id === id) ?? null,
  };
  return c;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('capability table (harness.md §4.2)', () => {
  it('defaults: chat API, max_tokens, 32,768 output cap, tools on, [U] parameters off, overflow parameter on', () => {
    expect(capabilitiesFor('acme/Model-1', null)).toEqual(BASE_CAPABILITIES);
    expect(BASE_CAPABILITIES).toMatchObject({
      maxOutputTokens: GATEWAY_LIMITS.unknownMaxOutputTokens,
      tools: true,
      parallelToolCalls: false,
      toolChoiceRequired: false,
      strictTools: false,
      ctxExceededParam: true,
      includeUsage: true,
      cacheKeyParam: null,
      developerRole: false,
      reasoningReplay: 'never',
    });
  });

  it('families: GPT → max_completion_tokens; DeepSeek, Kimi, GLM → tool_loop replay', () => {
    expect(capabilitiesFor('openai/gpt-6.1-sol', null).maxTokensField).toBe('max_completion_tokens');
    expect(capabilitiesFor('openai/o4-mini', null).maxTokensField).toBe('max_completion_tokens');
    expect(capabilitiesFor('openai/gpt-oss-120b', null).maxTokensField).toBe('max_tokens');
    for (const id of ['deepseek-ai/DeepSeek-V4-Flash', 'moonshotai/Kimi-K3', 'zai-org/GLM-5.3']) expect(capabilitiesFor(id, null).reasoningReplay).toBe('tool_loop');
    expect(capabilitiesFor('Qwen/Qwen3-Coder', null).reasoningReplay).toBe('never');
  });

  it('API: the catalog decides; unknown models fall back to the Responses-only patterns', () => {
    expect(guessApi('openai/gpt-5.3-codex')).toBe('responses');
    expect(guessApi('openai/gpt-5.4-pro')).toBe('responses');
    expect(guessApi('bytedance/seed-2.0-mini')).toBe('responses');
    expect(guessApi('zai-org/GLM-5.3')).toBe('chat');
    expect(capabilitiesFor('acme/x-codex', 'chat').api).toBe('chat');
    const r = capabilitiesFor('openai/gpt-5.3-codex', null);
    expect(r).toMatchObject({ api: 'responses', temperature: false });
  });

  it('overrides win over the table, per model id (case-insensitive), and are sanitised', () => {
    const overrides = parseCapabilityOverrides({
      models: {
        'zai-org/GLM-5.3': { ctxExceededParam: false, maxOutputTokens: 131_072, parallelToolCalls: true, bogus: 1, reasoningReplay: 'sometimes' },
        'not a model id!': { tools: false },
      },
    });
    expect([...overrides.keys()]).toEqual(['zai-org/glm-5.3']);
    expect(capabilitiesFor('ZAI-ORG/glm-5.3', null, overrides)).toMatchObject({ ctxExceededParam: false, maxOutputTokens: 131_072, parallelToolCalls: true, reasoningReplay: 'tool_loop' });
    expect(sanitizeCapabilities({ maxOutputTokens: -1, cacheKeyParam: 'user', api: 'messages' })).toEqual({ cacheKeyParam: 'user' });
    expect(parseCapabilityOverrides(null).size).toBe(0);
    expect(parseCapabilityOverrides({ models: [] }).size).toBe(0);
  });

  it('loads data/gateway-capabilities.json; missing or broken files are no overrides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-caps-'));
    dirs.push(dir);
    const path = join(dir, 'gateway-capabilities.json');
    expect((await loadCapabilityOverrides(path)).size).toBe(0);
    await writeFile(path, '{broken');
    expect((await loadCapabilityOverrides(path)).size).toBe(0);
    await writeFile(path, JSON.stringify({ models: { 'deepseek-ai/DeepSeek-V4-Flash': { maxOutputTokens: 65_536 } } }));
    expect((await loadCapabilityOverrides(path)).get('deepseek-ai/deepseek-v4-flash')).toEqual({ maxOutputTokens: 65_536 });
  });

  it('reasoning family = provider prefix; model ids follow chat\'s rule', () => {
    expect(reasoningFamily('ZAI-org/GLM-5.3')).toBe('zai-org');
    expect(reasoningFamily('local-model')).toBe('local-model');
    expect(isGatewayModelId('zai-org/GLM-5.3')).toBe(true);
    expect(isGatewayModelId('../etc/passwd')).toBe(false);
    expect(isGatewayModelId('')).toBe(false);
  });
});

describe('model resolver', () => {
  it('resolves catalog models with prices, discount, context and the output clamp', async () => {
    const resolver = createModelResolver({ catalog: catalog([llm('zai-org/GLM-5.3'), llm('openai/gpt-5.3-codex', { api: 'responses' })]) });
    await resolver.refresh(true);
    expect(resolver.resolve({ model: 'zai-org/GLM-5.3' }, 100_000)).toMatchObject({
      model: 'zai-org/GLM-5.3',
      router: null,
      api: 'chat',
      modelKey: 'zai-org/GLM-5.3',
      pricing: { inputPerMTok: 1.4 },
      discount: 0.5,
      contextLength: 1_048_576,
      maxOutputTokens: GATEWAY_LIMITS.unknownMaxOutputTokens,
      truncationRisk: false,
    });
    expect(resolver.resolve({ model: 'zai-org/GLM-5.3' }, 2_000)?.maxOutputTokens).toBe(2_000);
    expect(resolver.resolve({ model: 'zai-org/glm-5.3' }, 10)?.pricing).not.toBeNull();
    expect(resolver.resolve({ model: 'openai/gpt-5.3-codex' }, 10)?.api).toBe('responses');
  });

  it('the router resolves unpriced, keyed router:<mode>, keeping the request\'s output bound', () => {
    const resolver = createModelResolver({ catalog: catalog([]) });
    expect(resolver.resolve({ router: 'cost' }, 4096)).toMatchObject({ model: null, router: 'cost', api: 'router', modelKey: 'router:cost', pricing: null, capabilities: null, maxOutputTokens: 4096 });
  });

  it('media models and invalid ids resolve to null; unknown well-formed ids resolve unpriced (chat parity)', async () => {
    const resolver = createModelResolver({ catalog: catalog([llm('black-forest-labs/FLUX', { kind: 'image', api: 'queue' }), llm('acme/workflow', { kind: 'workflow', api: 'chat' })]) });
    await resolver.refresh(true);
    expect(resolver.resolve({ model: 'black-forest-labs/FLUX' }, 10)).toBeNull();
    expect(resolver.resolve({ model: 'acme/workflow' }, 10)).toBeNull();
    expect(resolver.resolve({ model: 'bad id' }, 10)).toBeNull();
    expect(resolver.resolve({ model: 'acme/brand-new' }, 10)).toMatchObject({ model: 'acme/brand-new', api: 'chat', pricing: null });
  });

  it('routed models get the catalog price; mock mode falls back to the fixture prices', async () => {
    const resolver = createModelResolver({ catalog: catalog([llm('zai-org/GLM-5.3')]), fallbackPricing: mockPricing });
    await resolver.refresh(true);
    expect(resolver.resolveRouted('zai-org/GLM-5.3')).toMatchObject({ discount: 0.5 });
    expect(resolver.resolveRouted('deepseek-ai/DeepSeek-V4-Pro')).toMatchObject({ pricing: { inputPerMTok: 1.74 }, discount: 0.2 });
    expect(resolver.resolveRouted('nobody/knows')).toBeNull();
    expect(resolver.resolve({ model: 'deepseek-ai/DeepSeek-V4-Pro' }, 10)?.pricing?.inputPerMTok).toBe(1.74);
  });

  it('refresh is throttled unless forced, and concurrent refreshes share one load; a failing catalog keeps the old snapshot', async () => {
    let now = 0;
    const models = [llm('zai-org/GLM-5.3')];
    const cat = catalog(models);
    const resolver = createModelResolver({ catalog: cat, now: () => now, minRefreshMs: 1_000 });
    await Promise.all([resolver.refresh(), resolver.refresh()]);
    expect(cat.calls).toBe(1);
    await resolver.refresh();
    expect(cat.calls).toBe(1);
    now = 1_500;
    await resolver.refresh();
    expect(cat.calls).toBe(2);
    await resolver.refresh(true);
    expect(cat.calls).toBe(3);
    cat.getSnapshot = async () => {
      throw new Error('offline');
    };
    await resolver.refresh(true);
    expect(resolver.resolve({ model: 'zai-org/GLM-5.3' }, 1)?.pricing).not.toBeNull();
  });

  it('learn() records a capability found at run time', async () => {
    const resolver = createModelResolver({ catalog: catalog([llm('acme/m')]) });
    await resolver.refresh(true);
    expect(resolver.resolve({ model: 'acme/m' }, 10)?.capabilities?.maxTokensField).toBe('max_tokens');
    resolver.learn('acme/m', { maxTokensField: 'max_completion_tokens' });
    expect(resolver.resolve({ model: 'acme/m' }, 10)?.capabilities?.maxTokensField).toBe('max_completion_tokens');
  });

  it('a family without the overflow parameter is marked truncationRisk', () => {
    const resolver = createModelResolver({ catalog: catalog([]), overrides: parseCapabilityOverrides({ models: { 'acme/m': { ctxExceededParam: false } } }) });
    expect(resolver.resolve({ model: 'acme/m' }, 10)?.truncationRisk).toBe(true);
  });
});
