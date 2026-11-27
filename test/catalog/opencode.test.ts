import { describe, expect, it } from 'vitest';
import { buildOpenCodeConfig, openCodeInstructions, outputLimit, usesReasoningContent } from '@main/services/catalog/opencode';
import type { CatalogModel } from '@shared/contracts/catalog';

function llm(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id.split('/').pop() ?? id,
    kind: 'llm',
    provider: null,
    description: null,
    iconUrl: null,
    tags: [],
    api: 'chat',
    contextLength: 262_144,
    quantization: 'fp8',
    llmPricing: { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26, cacheWritePerMTok: null },
    mediaPricing: null,
    discount: null,
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

describe('OpenCode export', () => {
  it('builds an openai-compatible provider with discounted per-1M costs', () => {
    const { config, count } = buildOpenCodeConfig([
      llm('zai-org/GLM-5.3', { discount: 0.5, name: 'GLM-5.3', contextLength: 1_048_576 }),
      llm('openai/gpt-5.5', {
        llmPricing: {
          inputPerMTok: 5,
          outputPerMTok: 30,
          cacheReadPerMTok: 0.5,
          cacheWritePerMTok: 1.25,
          tiers: [{ minPromptTokens: 200_000, inputPerMTok: 10, outputPerMTok: 45, cacheReadPerMTok: 1, cacheWritePerMTok: null }],
        },
      }),
      llm('openai/gpt-5.3-codex', { api: 'responses' }),
      llm('seedance', { kind: 'video', api: 'queue' }),
      llm('gone/model', { available: false }),
      llm('mystery/model', { llmPricing: null, contextLength: null }),
    ]);
    expect(count).toBe(3);
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    const gmi = config.provider.gmi;
    expect(gmi).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'GMI Cloud',
      options: { baseURL: 'https://api.gmi-serving.com/v1', apiKey: '{env:GMI_API_KEY}' },
    });
    expect(Object.keys(gmi!.models)).toEqual(['mystery/model', 'openai/gpt-5.5', 'zai-org/GLM-5.3']);
    expect(gmi!.models['zai-org/GLM-5.3']).toEqual({
      name: 'GLM-5.3',
      limit: { context: 1_048_576, output: 32_768 },
      cost: { input: 0.7, output: 2.2, cache_read: 0.13 },
      interleaved: { field: 'reasoning_content' },
    });
    expect(gmi!.models['openai/gpt-5.5']).toEqual({
      name: 'gpt-5.5',
      limit: { context: 262_144, output: 32_768 },
      cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 1.25, context_over_200k: { input: 10, output: 45, cache_read: 1 } },
    });
    // Unknown context and prices: safe defaults, no cost block.
    expect(gmi!.models['mystery/model']).toEqual({ name: 'model', limit: { context: 128_000, output: 8_192 } });
    // The key never ends up in the file.
    expect(JSON.stringify(config)).not.toMatch(/sk-|Bearer/);
  });

  it('never declares more context than a model without a published window may have', () => {
    const nemotron = 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16';
    const signedOut = [llm(nemotron, { contextLength: null }), llm('deepseek-ai/DeepSeek-V3-0324', { contextLength: null }), llm('zai-org/GLM-5.3')];
    const unknown = buildOpenCodeConfig(signedOut);
    expect(unknown.estimated).toBe(2);
    expect(unknown.config.provider.gmi!.models['deepseek-ai/DeepSeek-V3-0324']!.limit.context).toBeLessThanOrEqual(128_000);
    // Windows remembered from an earlier sign-in (keys are lower-case ids) are used instead of the estimate.
    const remembered = buildOpenCodeConfig(signedOut, { knownContext: new Map([[nemotron.toLowerCase(), 32_768]]) });
    expect(remembered.config.provider.gmi!.models[nemotron]!.limit).toEqual({ context: 32_768, output: 8_192 });
    expect(remembered.estimated).toBe(1);
    // The catalog's own value wins over a remembered one.
    expect(buildOpenCodeConfig([llm('zai-org/GLM-5.3')], { knownContext: new Map([['zai-org/glm-5.3', 1]]) }).config.provider.gmi!.models['zai-org/GLM-5.3']!.limit.context).toBe(262_144);
  });

  it('says when context limits are estimates', () => {
    const base = { configPath: '/x.json', count: 3, exampleModel: null, platform: 'linux', now: new Date('2026-10-31T00:00:00Z') };
    expect(openCodeInstructions({ ...base, orgPrices: false, estimatedLimits: 2 })).toMatch(/Context limits for 2 of these models are estimates \(128,000 tokens\).*sign in and export again/);
    expect(openCodeInstructions({ ...base, orgPrices: true, estimatedLimits: 3 })).toContain('Context limits for these models are estimates');
    expect(openCodeInstructions({ ...base, orgPrices: true, estimatedLimits: 0 })).not.toContain('estimates');
  });

  it('keeps output limits inside the context window', () => {
    expect(outputLimit(32_768)).toBe(8_192);
    expect(outputLimit(8_000)).toBe(4_096);
    expect(outputLimit(1_048_576)).toBe(32_768);
    expect(usesReasoningContent('deepseek-ai/DeepSeek-V4-Pro')).toBe(true);
    expect(usesReasoningContent('moonshotai/kimi-k3')).toBe(true);
    expect(usesReasoningContent('openai/gpt-5.5')).toBe(false);
  });

  it('explains how to use the file in OpenCode and T3 Code', () => {
    const text = openCodeInstructions({ configPath: '/x/opencode-gmi.json', count: 3, exampleModel: 'zai-org/GLM-5.3', platform: 'linux', now: new Date('2026-10-31T00:00:00Z') });
    expect(text).toContain('export OPENCODE_CONFIG="/x/opencode-gmi.json"');
    expect(text).toContain('export GMI_API_KEY=');
    expect(text).toContain('opencode -m gmi/zai-org/GLM-5.3');
    expect(text).toContain('T3 Code');
    expect(text).toContain('your prices as of');
    const signedOut = openCodeInstructions({ configPath: '/x.json', count: 1, exampleModel: null, platform: 'linux', now: new Date(), orgPrices: false });
    expect(signedOut).toContain('public list prices');
    const win = openCodeInstructions({ configPath: 'C:\\x.json', count: 1, exampleModel: null, platform: 'win32', now: new Date() });
    expect(win).toContain('$env:OPENCODE_CONFIG');
  });
});
