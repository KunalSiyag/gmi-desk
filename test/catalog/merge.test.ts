import { describe, expect, it } from 'vitest';
import featuredFixture from '@main/mock/fixtures/catalog/public-featured.json';
import leaderboardFixture from '@main/mock/fixtures/catalog/public-leaderboard.json';
import pricesFixture from '@main/mock/fixtures/catalog/public-model-prices.json';
import mediaFixture from '@main/mock/fixtures/catalog/public-requestqueue-models.json';
import mcpLlmFixture from '@main/mock/fixtures/catalog/mcp-search-llm.json';
import mcpMultimodalFixture from '@main/mock/fixtures/catalog/mcp-search-multimodal.json';
import { dedupeWorkflows, mergeSources, workflowTitleKey } from '@main/services/catalog/merge';
import {
  normalizeFeatured,
  normalizeLeaderboard,
  normalizeMcpSearch,
  normalizeModelsApi,
  normalizePublicMedia,
  normalizePublicPrices,
} from '@main/services/catalog/normalize';
import { buildOpenCodeConfig } from '@main/services/catalog/opencode';
import type { ModelPatch, SourceResult } from '@main/services/catalog/types';
import type { CatalogModel } from '@shared/contracts/catalog';
import { applyDiscount } from '@shared/lib/money';

const publicSources = () => ({
  public_prices: normalizePublicPrices(pricesFixture),
  public_media: normalizePublicMedia(mediaFixture),
  featured: normalizeFeatured(featuredFixture),
  leaderboard: normalizeLeaderboard(leaderboardFixture, '2026-10-31T00:00:00.000Z'),
});
const mcp = () => normalizeMcpSearch({ llm: mcpLlmFixture, multimodal: [mcpMultimodalFixture] });
const find = (models: CatalogModel[], id: string) => models.find((m) => m.id === id);
const result = (patches: ModelPatch[], extra: Partial<SourceResult> = {}): SourceResult => ({ patches, hidden: [], count: patches.length, ...extra });

describe('mergeSources', () => {
  it('merges every source by id with per-field precedence', () => {
    const merged = mergeSources({ ...publicSources(), mcp: mcp() });
    expect(merged.llmListSource).toBe('mcp');
    const glm = find(merged.models, 'zai-org/GLM-5.3');
    expect(glm).toMatchObject({
      kind: 'llm',
      name: 'GLM-5.3',
      provider: 'Z.ai',
      api: 'chat',
      contextLength: 1_048_576,
      discount: 0.5,
      featured: true,
      openSource: true,
      available: true,
    });
    expect(glm?.llmPricing).toMatchObject({ inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26 });
    expect(glm?.sources).toEqual(['mcp', 'featured', 'public_prices']);
    // GMI's featured feed gives GLM-5.3 the Kimi logo; it is replaced by a Z.ai one.
    expect(glm?.iconUrl ?? '').not.toContain('kimi');

    // Leaderboard names win; scores attach by id.
    const kimi = find(merged.models, 'moonshotai/kimi-k3');
    expect(kimi?.name).toBe('Kimi K3');
    expect(kimi?.leaderboard?.overall).toBe(84.81);
    expect(kimi?.iconUrl).toContain('kimi');

    // Media: MCP pricing first, unit/details filled from the public catalog.
    const heygen = find(merged.models, 'heygen-avatar-4');
    expect(heygen).toMatchObject({ kind: 'video', provider: 'HeyGen', api: 'queue', featured: true });
    expect(heygen?.mediaPricing).toMatchObject({ usdPerUnit: 0.0667, unit: 'second' });
    expect(heygen?.mediaPricing?.details).toContain('Digital Twin');
    expect(heygen?.createdAt).toMatch(/^2026-04-21/);
  });

  it('prefers the MCP discount and falls back to public discounts', () => {
    const merged = mergeSources({ ...publicSources(), mcp: mcp() });
    // MCP search results carry no media discount; the public 20% applies.
    expect(find(merged.models, 'gpt-image-2-generate')?.discount).toBe(0.2);
    // MCP and public agree for LLMs.
    expect(find(merged.models, 'deepseek-ai/DeepSeek-V4-Pro')?.discount).toBe(0.45);
    // The org's MCP discount wins over a public promotion.
    const patched = mergeSources({
      mcp: result([{ id: 'a/b', source: 'mcp', kind: 'llm', name: 'B', discount: 0.3 }], { llmIds: ['a/b'] }),
      public_prices: result([{ id: 'a/b', source: 'public_prices', kind: 'llm', name: 'b', discount: 0.9 }]),
    });
    expect(patched.models[0]?.discount).toBe(0.3);
    // The org's MCP price without a discount wins over a public 100%-off row (Ling-3.0-flash-fin in the fixture).
    expect(find(merged.models, 'inclusionAI/Ling-3.0-flash-fin')?.discount).toBe(0);
    // ...and signed out, the public promotion is all there is.
    const publicOnly = mergeSources({ ...publicSources() });
    expect(find(publicOnly.models, 'MiniMaxAI/MiniMax-M3')?.discount).toBe(0.2);
  });

  it('keeps key-only models priced when the public price list claims 100% off', () => {
    // An inference key without a sign-in: the documented /v1/models rows carry no prices or discounts.
    const rows = (pricesFixture.modelPrices as Array<Record<string, unknown>>).filter((r) =>
      ['inclusionAI/Ling-3.0-flash-fin', 'zai-org/GLM-5.3'].includes(r.modelName as string),
    );
    const api = normalizeModelsApi({
      object: 'list',
      data: [
        { id: 'inclusionAI/Ling-3.0-flash-fin', object: 'model', created: 1, owned_by: 'gmi' },
        { id: 'zai-org/GLM-5.3', object: 'model', created: 1, owned_by: 'gmi' },
      ],
    });
    const merged = mergeSources({ public_prices: normalizePublicPrices({ modelPrices: rows }), models_api: api });
    const ling = find(merged.models, 'inclusionAI/Ling-3.0-flash-fin');
    expect(ling?.discount).not.toBe(1);
    expect(applyDiscount(ling?.llmPricing?.inputPerMTok, ling?.discount)).toBe(0.06);
    expect(applyDiscount(ling?.llmPricing?.outputPerMTok, ling?.discount)).toBe(0.18);
    // Real public promotions still apply.
    expect(find(merged.models, 'zai-org/GLM-5.3')?.discount).toBe(0.5);
  });

  it('drops hidden ids whatever the other sources say', () => {
    const merged = mergeSources({ ...publicSources(), mcp: mcp() });
    // Invisible in the queue catalog but listed (available) by MCP.
    expect(find(merged.models, 'gemini-3-pro-image-preview')).toBeUndefined();
    expect(find(merged.models, 'wan2.6-t2i')).toBeUndefined();
    // Internal EA rows.
    expect(find(merged.models, 'ndwadhalerwal')).toBeUndefined();
    expect(merged.models.some((m) => /test|probe|capture|ssrf/i.test(m.id))).toBe(false);
  });

  it('never creates models from price rows alone', () => {
    const merged = mergeSources(publicSources());
    // Retired / unlisted LLMs that only the price list knows.
    expect(find(merged.models, 'deepseek-ai/DeepSeek-R1')).toBeUndefined();
    expect(find(merged.models, 'openai/gpt-4o')).toBeUndefined();
    expect(merged.models.some((m) => m.sources.length === 1 && m.sources[0] === 'public_prices')).toBe(false);
  });

  it('picks the LLM list from the models API, then MCP, then public feeds', () => {
    const pub = publicSources();
    const signedOut = mergeSources(pub);
    expect(signedOut.llmListSource).toBe('public');
    const publicLlms = signedOut.models.filter((m) => m.kind === 'llm');
    expect(publicLlms.length).toBeGreaterThan(10);
    expect(publicLlms.every((m) => m.sources.includes('featured') || m.sources.includes('leaderboard'))).toBe(true);

    const withMcp = mergeSources({ ...pub, mcp: mcp() });
    expect(withMcp.models.filter((m) => m.kind === 'llm')).toHaveLength(mcpLlmFixture.models.length);
    // Leaderboard-only models (not live for this org) disappear once MCP is authoritative.
    expect(find(withMcp.models, 'anthropic/claude-opus-5')).toBeUndefined();
    expect(find(signedOut.models, 'anthropic/claude-opus-5')).toBeDefined();

    const api = normalizeModelsApi({ data: [{ id: 'ZAI-ORG/GLM-5.3' }, { id: 'openai/gpt-5.5' }] });
    const withKey = mergeSources({ ...pub, mcp: mcp(), models_api: api });
    expect(withKey.llmListSource).toBe('models_api');
    const llms = withKey.models.filter((m) => m.kind === 'llm');
    expect(llms.map((m) => m.id).sort()).toEqual(['openai/gpt-5.5', 'ZAI-ORG/GLM-5.3'].sort());
    // Case-insensitive merge keeps the inference API's spelling and MCP's data.
    expect(find(llms, 'ZAI-ORG/GLM-5.3')?.contextLength).toBe(1_048_576);
    // Media is unaffected by the LLM authority.
    expect(withKey.models.filter((m) => m.kind !== 'llm').length).toBe(withMcp.models.filter((m) => m.kind !== 'llm').length);
  });

  it('treats an empty LLM list as no authority', () => {
    const pub = publicSources();
    const publicLlms = mergeSources(pub).models.filter((m) => m.kind === 'llm').length;
    const empty = (extra: Partial<SourceResult> = {}): SourceResult => ({ patches: [], hidden: [], llmIds: [], count: 0, ...extra });
    // /v1/models answered 200 but listed nothing readable.
    const withEmptyApi = mergeSources({ ...pub, models_api: empty() });
    expect(withEmptyApi.llmListSource).toBe('public');
    expect(withEmptyApi.models.filter((m) => m.kind === 'llm')).toHaveLength(publicLlms);
    // ...falls back to MCP when that has a list.
    const withMcp = mergeSources({ ...pub, mcp: mcp(), models_api: empty() });
    expect(withMcp.llmListSource).toBe('mcp');
    expect(withMcp.models.filter((m) => m.kind === 'llm')).toHaveLength(mcpLlmFixture.models.length);
    // search_models kind=llm answered with plain text: media from MCP stays, LLMs come from the public feeds.
    const textLlm = normalizeMcpSearch({ llm: 'Service temporarily unavailable', multimodal: [mcpMultimodalFixture] });
    expect(textLlm.llmIds).toEqual([]);
    const withTextLlm = mergeSources({ ...pub, mcp: textLlm });
    expect(withTextLlm.llmListSource).toBe('public');
    expect(withTextLlm.models.filter((m) => m.kind === 'llm')).toHaveLength(publicLlms);
  });

  it('drops leaderboard-only LLMs the last authoritative list did not include (signed out)', () => {
    const pub = publicSources();
    const knownLlmIds = mcp().llmIds;
    const bestEffort = mergeSources(pub);
    expect(bestEffort.models.some((m) => m.id.startsWith('anthropic/'))).toBe(true);

    const remembered = mergeSources(pub, { knownLlmIds });
    expect(remembered.llmListSource).toBe('public');
    const llms = remembered.models.filter((m) => m.kind === 'llm');
    expect(llms.some((m) => m.id.startsWith('anthropic/'))).toBe(false);
    // Featured LLMs stay (GMI promotes them publicly); leaderboard models GMI serves stay too.
    expect(find(llms, 'MiniMaxAI/MiniMax-M3')).toBeDefined();
    expect(find(llms, 'moonshotai/kimi-k3')).toBeDefined();
    const known = new Set((knownLlmIds ?? []).map((id) => id.toLowerCase()));
    expect(llms.every((m) => m.sources.includes('featured') || known.has(m.id.toLowerCase()))).toBe(true);
    // Media is unaffected, and so is a refresh that has its own authority.
    expect(remembered.models.length - llms.length).toBe(bestEffort.models.filter((m) => m.kind !== 'llm').length);
    expect(mergeSources({ ...pub, mcp: mcp() }, { knownLlmIds: ['x/y'] }).models.filter((m) => m.kind === 'llm')).toHaveLength(mcpLlmFixture.models.length);
    // The signed-out OpenCode export follows the list.
    const exported = Object.keys(buildOpenCodeConfig(remembered.models).config.provider.gmi?.models ?? {});
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.some((id) => id.startsWith('anthropic/'))).toBe(false);
  });

  it('tags workflows with their title key so republished copies can be recognised', () => {
    const merged = mergeSources({ ...publicSources(), mcp: mcp() });
    const all = [...merged.models, ...merged.duplicates].filter((m) => m.kind === 'workflow');
    for (const m of all) expect(merged.observed.get(m.id.toLowerCase())?.title, m.id).toBe(workflowTitleKey(m.name));
    const dup = merged.duplicates[0];
    expect(dup && merged.models.some((m) => m.kind === 'workflow' && workflowTitleKey(m.name) === workflowTitleKey(dup.name))).toBe(true);
    expect(merged.observed.get('zai-org/glm-5.3')?.title).toBeUndefined();
  });

  it('reports observed ids for first-seen tracking, excluding price-only rows and hidden ids', () => {
    const merged = mergeSources({ ...publicSources(), mcp: mcp() });
    expect(merged.observed.get('zai-org/glm-5.3')?.sources).toEqual(new Set(['mcp', 'featured']));
    expect(merged.observed.has('openai/gpt-4o')).toBe(false);
    expect(merged.observed.has('ndwadhalerwal')).toBe(false);
    expect(merged.observed.get('heygen-avatar-4')?.createdAt).toMatch(/^2026-04-21/);
  });

  it('defaults LLM modalities to text and sorts by kind then name', () => {
    const merged = mergeSources({ ...publicSources(), mcp: mcp() });
    expect(find(merged.models, 'openai/gpt-5.5')?.inputs).toEqual([{ type: 'text', required: true }]);
    const kinds = merged.models.map((m) => m.kind);
    expect(kinds.indexOf('image')).toBeGreaterThan(kinds.lastIndexOf('llm'));
    expect(kinds.indexOf('workflow')).toBeGreaterThan(kinds.lastIndexOf('audio'));
  });
});

describe('dedupeWorkflows', () => {
  const wf = (id: string, name: string, createdAt: string | null) =>
    ({ id, name, kind: 'workflow', createdAt }) as unknown as CatalogModel;

  it('keeps the newest workflow per title', () => {
    const { kept, duplicates } = dedupeWorkflows([
      wf('a', 'Kiss', '2026-01-01T00:00:00Z'),
      wf('b', 'kiss', '2026-03-01T00:00:00Z'),
      wf('c', 'Other', null),
      { id: 'm', name: 'Kiss', kind: 'video', createdAt: null } as unknown as CatalogModel,
    ]);
    expect(kept.map((m) => m.id)).toEqual(['b', 'c', 'm']);
    expect(duplicates.map((m) => m.id)).toEqual(['a']);
  });

  it('dedupes the recorded fixture (published copies of the same workflow)', () => {
    const merged = mergeSources({ ...publicSources(), mcp: mcp() });
    const names = merged.models.filter((m) => m.kind === 'workflow').map((m) => m.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(merged.duplicates.length).toBeGreaterThan(0);
  });
});
