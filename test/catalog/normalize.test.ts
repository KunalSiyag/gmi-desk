import { describe, expect, it } from 'vitest';
import featuredFixture from '@main/mock/fixtures/catalog/public-featured.json';
import leaderboardFixture from '@main/mock/fixtures/catalog/public-leaderboard.json';
import pricesFixture from '@main/mock/fixtures/catalog/public-model-prices.json';
import mediaFixture from '@main/mock/fixtures/catalog/public-requestqueue-models.json';
import mcpLlmFixture from '@main/mock/fixtures/catalog/mcp-search-llm.json';
import mcpMultimodalFixture from '@main/mock/fixtures/catalog/mcp-search-multimodal.json';
import mcpGetModelFixture from '@main/mock/fixtures/catalog/mcp-get-model.json';
import {
  normalizeFeatured,
  normalizeLeaderboard,
  normalizeMcpModel,
  normalizeMcpSearch,
  normalizeModelsApi,
  normalizePublicMedia,
  normalizePublicPrices,
} from '@main/services/catalog/normalize';
import type { ModelPatch } from '@main/services/catalog/types';

const byId = (patches: ModelPatch[], id: string) => patches.find((p) => p.id === id);

describe('public price list', () => {
  const result = normalizePublicPrices(pricesFixture);

  it('converts micro-USD per 1M tokens and discounts in hundredths of a percent', () => {
    const v4pro = byId(result.patches, 'deepseek-ai/DeepSeek-V4-Pro');
    expect(v4pro?.kind).toBe('llm');
    expect(v4pro?.llmPricing?.inputPerMTok).toBe(1.74);
    expect(v4pro?.llmPricing?.outputPerMTok).toBe(3.48);
    expect(v4pro?.discount).toBe(0.45);
  });

  it('reads cache prices from the base tier and long-context tiers', () => {
    const mimo = byId(result.patches, 'XiaomiMiMo/MiMo-V2.6-Pro');
    expect(mimo?.llmPricing).toMatchObject({ inputPerMTok: 0.435, outputPerMTok: 0.87, cacheReadPerMTok: 0.0036 });
    // percentageDiscount is 0 but per-token-type discounts say 15%.
    expect(mimo?.discount).toBe(0.15);
    // A cache price of 0 means "not offered", not free.
    expect(byId(result.patches, 'anthropic/claude-3.7-sonnet')?.llmPricing?.cacheReadPerMTok).toBeNull();
  });

  it('drops test rows and dedicated-endpoint rows', () => {
    expect(byId(result.patches, '646d8d2d5c78/DeepSeek-V4-Pro')).toBeUndefined();
    expect(byId(result.patches, 'testmodel0423')).toBeUndefined();
    expect(byId(result.patches, 'gmi/gmi-router-test')).toBeUndefined();
    expect(result.hidden).toEqual(expect.arrayContaining(['testmodel0423', '646d8d2d5c78/DeepSeek-V4-Pro']));
  });

  it('keeps media price rows as price-only patches', () => {
    const video = result.patches.find((p) => p.mediaPricing && !p.kind);
    expect(video?.mediaPricing?.unit).toBe('second');
    expect(result.count).toBe(pricesFixture.modelPrices.length);
  });

  it('does not let a 100%-off row make a model free', () => {
    // Ling-3.0-flash-fin: percentageDiscount 10000 and charged price 0, while GMI's org catalog bills $0.06/$0.18.
    const ling = byId(result.patches, 'inclusionAI/Ling-3.0-flash-fin');
    expect(ling?.llmPricing).toMatchObject({ inputPerMTok: 0.06, outputPerMTok: 0.18 });
    expect(ling?.discount).toBeNull();
    // The same row without the percentage: the discount implied by charged 0 vs list 0.06 is ignored too.
    const row = (pricesFixture.modelPrices as Array<Record<string, unknown>>).find((r) => r.modelName === 'inclusionAI/Ling-3.0-flash-fin');
    const implied = normalizePublicPrices({ modelPrices: [{ ...row, percentageDiscount: 0 }] });
    expect(implied.patches[0]?.discount).toBeNull();
    const ttd = normalizePublicPrices({ modelPrices: [{ ...row, percentageDiscount: 0, tokenTypeDiscounts: { prompt_token: 10_000 } }] });
    expect(ttd.patches[0]?.discount).toBeNull();
    // Partial promotions are kept.
    expect(byId(result.patches, 'zai-org/GLM-5.3')?.discount).toBe(0.5);
    expect(normalizeFeatured([{ model_name: 'a/b', model_type: 'llm', status: 'active', percentage_discount: 10_000 }]).patches[0]?.discount).toBeNull();
  });
});

describe('public queue catalog', () => {
  const result = normalizePublicMedia(mediaFixture);

  it('normalises media rows', () => {
    const heygen = byId(result.patches, 'heygen-avatar-4');
    expect(heygen).toMatchObject({ kind: 'video', name: 'heygen-avatar-4', featured: true, providerHint: 'heygen' });
    expect(heygen?.mediaPricing).toMatchObject({ usdPerUnit: 0.0667, unit: 'second', pricingType: 'video length based pricing' });
    expect(heygen?.mediaPricing?.details).toContain('Digital Twin');
    expect(heygen?.createdAt).toMatch(/^2026-04-21T\d\d:\d\d:\d\d\.000Z$/);
    expect(heygen?.inputs).toEqual([{ type: 'text', required: true }]);
    expect(byId(result.patches, 'gpt-image-2-generate')?.discount).toBe(0.2);
    expect(byId(result.patches, 'minimax-tts-speech-2.8-hd')?.mediaPricing?.unit).toBe('1K characters');
  });

  it('hides inactive, invisible, test and internal rows', () => {
    for (const id of ['sora-2', 'wan2.6-t2i', 'gemini-3-pro-image-preview', 'ssrf-file-test-1009', 'capture-img-1791491850', 'zero-cost-probe-1791492966', 'ndwadhalerwal', 'qwen3-vl-plus']) {
      expect(byId(result.patches, id), id).toBeUndefined();
      expect(result.hidden, id).toContain(id);
    }
  });

  it('ignores stale LLM rows in the queue catalog', () => {
    expect(byId(result.patches, 'deepseek-ai/DeepSeek-V4-Flash-0731')).toBeUndefined();
    expect(result.hidden).not.toContain('deepseek-ai/DeepSeek-V4-Flash-0731');
  });

  it('names workflows from their title and drops unusable ones', () => {
    const workflows = result.patches.filter((p) => p.kind === 'workflow');
    const names = workflows.map((p) => p.name);
    expect(names).toContain('World Cup Goal Highlight Cartoon');
    expect(names).toContain('Kiss');
    expect(names).toContain('My Cat To Merch');
    expect(names).not.toContain('123');
    expect(names).not.toContain('XXXX');
    expect(names.every((n) => n && !/^[0-9a-f]{8}-/.test(n))).toBe(true);
    expect(byId(result.patches, 'b8028c17-3215-4775-9b58-ae3012e20b08')?.providerHint).toBeNull();
  });

  it('reads Inworld TTS prices as per 1K characters', () => {
    expect(byId(result.patches, 'inworld-tts-2')?.mediaPricing).toMatchObject({ usdPerUnit: 0.025, unit: '1K characters' });
    expect(byId(result.patches, 'inworld-tts-2-flash')?.mediaPricing).toMatchObject({ usdPerUnit: 0.015, unit: '1K characters' });
    expect(byId(result.patches, 'inworld-tts-1.5-max')?.mediaPricing).toMatchObject({ usdPerUnit: 0.01, unit: '1K characters' });
  });

  it('keeps parameters and long descriptions out of the patch', () => {
    expect(result.details['seedance-2-5-260628']?.longDescription).toContain('Seedance');
    expect(Array.isArray(result.details['seedance-2-5-260628']?.parameters)).toBe(true);
    expect(byId(result.patches, 'seedance-2-5-260628')).not.toHaveProperty('parameters');
  });
});

describe('featured feed', () => {
  const result = normalizeFeatured(featuredFixture);

  it('uses list (origin) prices and the percentage discount', () => {
    const m3 = byId(result.patches, 'MiniMaxAI/MiniMax-M3');
    expect(m3).toMatchObject({ kind: 'llm', name: 'MiniMax-M3', featured: true, featuredOrder: 1, openSource: true, discount: 0.2 });
    expect(m3?.llmPricing).toMatchObject({ inputPerMTok: 0.3, outputPerMTok: 1.2 });
    expect(byId(result.patches, 'zai-org/GLM-5.3')?.discount).toBe(0.5);
  });

  it('drops descriptions that only repeat the name', () => {
    expect(byId(result.patches, 'zai-org/GLM-5.3')?.description).toBeNull();
    expect(byId(result.patches, 'google/gemini-3.6-flash')?.description).toBeNull();
    expect(byId(result.patches, 'minimax-music-3.0')?.description).toContain('music');
  });

  it('reads media prices as per-unit list prices', () => {
    expect(byId(result.patches, 'seedance-2-5-260628')?.mediaPricing?.usdPerUnit).toBe(0.231);
  });
});

describe('leaderboard', () => {
  const result = normalizeLeaderboard(leaderboardFixture, '2026-10-31T00:00:00.000Z');

  it('builds categories and entries sorted by overall quality', () => {
    expect(result.leaderboard.categories.map((c) => c.key)).toContain('coding');
    const overall = result.leaderboard.entries.map((e) => e.quality.overall ?? 0);
    expect([...overall].sort((a, b) => b - a)).toEqual(overall);
    const kimi = result.leaderboard.entries.find((e) => e.modelId === 'moonshotai/kimi-k3');
    expect(kimi).toMatchObject({ name: 'Kimi K3', provider: 'Moonshot AI', openSource: true });
    expect(kimi?.publishedAt).toMatch(/^2026-08-18/);
  });

  it('patches LLMs with scores', () => {
    const patch = byId(result.patches, 'openai/gpt-5.5');
    expect(patch?.leaderboard).toEqual({ overall: 81.58, coding: 89.26, agentic: 66.48, reasoning: 96.06 });
    expect(patch?.kind).toBe('llm');
  });
});

describe('MCP', () => {
  const result = normalizeMcpSearch({ llm: mcpLlmFixture, multimodal: [mcpMultimodalFixture] });

  it('converts USD-per-token strings to USD per 1M tokens', () => {
    const glm = byId(result.patches, 'zai-org/GLM-5.3');
    expect(glm).toMatchObject({ kind: 'llm', name: 'GLM-5.3', contextLength: 1_048_576, quantization: 'fp8', discount: 0.5 });
    expect(glm?.llmPricing).toEqual({ inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26, cacheWritePerMTok: null });
  });

  it('keeps long-context tiers', () => {
    const coder = byId(result.patches, 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8');
    expect(coder?.llmPricing?.tiers).toEqual([
      { minPromptTokens: 32_000, inputPerMTok: 1.62, outputPerMTok: 8.1, cacheReadPerMTok: 0.324, cacheWritePerMTok: null },
      { minPromptTokens: 128_000, inputPerMTok: 2.7, outputPerMTok: 13.5, cacheReadPerMTok: 0.54, cacheWritePerMTok: null },
    ]);
  });

  it('cleans display names', () => {
    expect(byId(result.patches, 'moonshotai/kimi-k3')?.name).toBe('Kimi K3');
    expect(byId(result.patches, 'zai-org/GLM-4.7-FP8')?.name).toBe('GLM-4.7');
    expect(byId(result.patches, 'zai-org/GLM-5.3-Flash')?.name).toBe('GLM-5.3 Flash');
  });

  it('records the LLM ids it vouches for', () => {
    expect(result.llmIds).toHaveLength(mcpLlmFixture.models.length);
  });

  it('normalises multimodal entries, workflows and junk', () => {
    const wf = byId(result.patches, 'b8028c17-3215-4775-9b58-ae3012e20b08');
    expect(wf).toMatchObject({ kind: 'workflow', name: 'World Cup Goal Highlight Cartoon', description: null, available: true });
    expect(wf?.mediaPricing).toMatchObject({ usdPerUnit: 1, unit: 'request' });
    expect(byId(result.patches, 'ltx-2-pro-audio-to-video')?.available).toBe(false);
    for (const id of ['vtx-bypass-test-1009', 'capture-img-1791491850', 'ndwadhalerwal', 'gemini-omni-flash-internal', 'ssrf-internal-probe']) {
      expect(byId(result.patches, id), id).toBeUndefined();
      expect(result.hidden, id).toContain(id);
    }
    // The stale LLM row in the multimodal list does not override the LLM entry.
    expect(byId(result.patches, 'deepseek-ai/DeepSeek-V4-Flash-0731')?.kind).toBe('llm');
  });

  it('reads get_model results', () => {
    const fixtures = mcpGetModelFixture as Record<string, unknown>;
    expect(normalizeMcpModel(fixtures['seedance-2-5-260628'])).toMatchObject({ kind: 'video', mediaPricing: { usdPerUnit: 0.231, unit: 'second' } });
    expect(normalizeMcpModel(fixtures['deepseek-ai/DeepSeek-V4-Flash'])).toMatchObject({ kind: 'llm', discount: 0.35 });
    expect(normalizeMcpModel({ model_id: '' })).toBeNull();
    expect(normalizeMcpModel('nope')).toBeNull();
  });

  it('reads Inworld TTS prices as per 1K characters', () => {
    const tts = (id: string, price: number, pricingType: string) =>
      normalizeMcpModel({ model_id: id, kind: 'multimodal', multimodal: { model_type: 'audio', pricing: { price, pricing_type: pricingType, unit: 'character' } } });
    expect(tts('inworld-tts-2-flash', 15_000, 'per_unit')?.mediaPricing).toEqual({ usdPerUnit: 0.015, unit: '1K characters', pricingType: 'per_unit', details: null });
    expect(tts('inworld-tts-1.5-mini', 5_000, 'per 1000 character')?.mediaPricing).toMatchObject({ usdPerUnit: 0.005, unit: '1K characters' });
    expect(byId(result.patches, 'inworld-tts-2')?.mediaPricing).toMatchObject({ usdPerUnit: 0.025, unit: '1K characters' });
  });
});

describe('models API', () => {
  it('accepts USD-per-token and per-1M prices and records the id list', () => {
    const result = normalizeModelsApi({
      data: [
        { id: 'zai-org/GLM-5.3', created: 1_780_000_000, pricing: { prompt: '0.0000014', completion: '0.0000044' }, discount_to_user: 0.5, context_length: 1_048_576 },
        { id: 'openai/gpt-5.4', pricing: { prompt: 2.5, completion: 15 } },
        { id: 'testmodel0423' },
        { nope: true },
      ],
    });
    expect(result.llmIds).toEqual(['zai-org/GLM-5.3', 'openai/gpt-5.4']);
    expect(result.hidden).toEqual(['testmodel0423']);
    expect(byId(result.patches, 'zai-org/GLM-5.3')).toMatchObject({
      llmPricing: { inputPerMTok: 1.4, outputPerMTok: 4.4 },
      discount: 0.5,
      contextLength: 1_048_576,
      createdAt: '2026-05-28T20:26:40.000Z',
    });
    expect(byId(result.patches, 'openai/gpt-5.4')?.llmPricing).toMatchObject({ inputPerMTok: 2.5, outputPerMTok: 15 });
    expect(result.count).toBe(4);
  });

  it('reads the documented shape, including the example that puts the id under `object`', () => {
    const result = normalizeModelsApi({
      object: 'list',
      data: [
        { id: 'zai-org/GLM-5.3', object: 'model', created: 1_687_530_000, owned_by: 'public' },
        { id: '', object: 'deepseek-ai/DeepSeek-R1', created: 1_687_530_000, owned_by: 'public' },
        { id: '', object: 'model' },
      ],
    });
    expect(result.llmIds).toEqual(['zai-org/GLM-5.3', 'deepseek-ai/DeepSeek-R1']);
    // No prices in the documented shape: no price and no discount claim either way.
    expect(byId(result.patches, 'zai-org/GLM-5.3')).toMatchObject({ llmPricing: null, discount: null, contextLength: null });
  });

  it('tolerates garbage', () => {
    expect(normalizeModelsApi(null).patches).toEqual([]);
    expect(normalizeModelsApi({ data: 'x' }).llmIds).toEqual([]);
    expect(normalizePublicMedia('nope').patches).toEqual([]);
    expect(normalizeLeaderboard(42, 'x').leaderboard.entries).toEqual([]);
  });
});
