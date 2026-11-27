import { describe, expect, it } from 'vitest';
import { catalogMockTools, mockGetModel, mockModelsApiResponse, mockSearchModels } from '@main/mock/catalog';
import { createMockMcp } from '@main/mock/mcp';
import { GmiError } from '@shared/contracts/errors';

type M = { model_id: string; provider: string; display_name: string; multimodal?: { input: Array<{ type: string }>; output: Array<{ type: string }> } };
const ids = (r: { models: unknown[] }) => (r.models as M[]).map((m) => m.model_id);

describe('mock search_models', () => {
  it('filters by kind with the default limit of 20', () => {
    expect(mockSearchModels({ kind: 'llm' }).models).toHaveLength(20);
    const all = mockSearchModels({ kind: 'llm', limit: 100 });
    expect(all.models.length).toBeGreaterThan(80);
    expect((all.models as M[]).every((m) => !m.multimodal)).toBe(true);
    expect(mockSearchModels({ kind: 'multimodal', limit: 500 }).models.length).toBeLessThanOrEqual(100);
    expect(mockSearchModels({ kind: 'llm', limit: 0 }).models).toHaveLength(1);
  });

  it('filters by modality on inputs or outputs', () => {
    const audio = mockSearchModels({ kind: 'multimodal', modality: 'audio', limit: 100 }).models as M[];
    expect(audio.length).toBeGreaterThan(5);
    for (const m of audio) {
      const types = [...(m.multimodal?.input ?? []), ...(m.multimodal?.output ?? [])].map((x) => x.type);
      expect(types.some((t) => t === 'audio' || t.endsWith('_audio')), m.model_id).toBe(true);
    }
    // Video models that accept audio references are included, like on the real server.
    expect(ids({ models: audio })).toContain('wan3.0-video');
  });

  it('filters by provider (case-insensitive), query and task', () => {
    const bria = mockSearchModels({ kind: 'multimodal', provider: 'BRIA', limit: 100 }).models as M[];
    expect(bria.length).toBeGreaterThan(3);
    expect(bria.every((m) => m.provider === 'bria')).toBe(true);
    expect(ids(mockSearchModels({ kind: 'multimodal', provider: 'bria', query: 'fibo', limit: 3 }))).toEqual(['bria-fibo-generate-1.5', 'bria-fibo-edit-1.5']);
    expect(ids(mockSearchModels({ kind: 'llm', query: 'GLM-5.3', limit: 10 }))).toEqual(['zai-org/GLM-5.3-Flash', 'zai-org/GLM-5.3']);
    const i2v = mockSearchModels({ kind: 'multimodal', task: 'image-to-video', limit: 100 }).models as M[];
    expect(i2v.length).toBeGreaterThan(0);
    expect(i2v.every((m) => m.multimodal?.output.some((o) => o.type === 'video'))).toBe(true);
  });

  it('keeps the junk rows the real server returns', () => {
    expect(ids(mockSearchModels({ kind: 'multimodal', query: 'capture', limit: 100 }))).toContain('capture-img-1791491850');
  });

  it('returns copies', () => {
    const a = mockSearchModels({ kind: 'llm', limit: 1 }).models[0] as M;
    a.display_name = 'mutated';
    expect((mockSearchModels({ kind: 'llm', limit: 1 }).models[0] as M).display_name).not.toBe('mutated');
  });
});

describe('mock get_model', () => {
  it('serves recorded results', () => {
    const m = mockGetModel({ model_id: 'seedance-2-5-260628' }) as { parameters: Array<{ name: string }> };
    expect(m.parameters.map((p) => p.name)).toContain('duration');
    expect((mockGetModel({ model_id: 'zai-org/GLM-5.3' }) as { parameters: unknown }).parameters).toBeNull();
  });

  it('synthesises other ids from the search pool and public parameters', () => {
    const heygen = mockGetModel({ model_id: 'heygen-avatar-4' }) as { parameters: Array<{ name: string; enum?: unknown[] }> };
    const style = heygen.parameters.find((p) => p.name === 'avatar_style');
    expect(style?.enum).toEqual(['normal', 'circle', 'closeUp']);
    expect((mockGetModel({ model_id: 'openai/gpt-5.5' }) as { parameters: unknown }).parameters).toBeNull();
  });

  it('rejects unknown and missing ids like the real tool', () => {
    expect(() => mockGetModel({ model_id: 'nonexistent-model-xyz' })).toThrowError(/no model with id/);
    try {
      mockGetModel({});
    } catch (e) {
      expect(e).toBeInstanceOf(GmiError);
      expect((e as GmiError).code).toBe('invalid_input');
    }
  });

  it('is wired into the mock MCP gateway', async () => {
    expect(Object.keys(catalogMockTools).sort()).toEqual(['get_model', 'search_models']);
    const mcp = createMockMcp({ latencyMs: 0 });
    const res = await mcp.callTool<{ models: unknown[] }>('search_models', { kind: 'llm', limit: 5 });
    expect(res.models).toHaveLength(5);
  });
});

describe('mock models API', () => {
  it('lists the recorded LLM ids in the documented shape, without prices, context or discounts', () => {
    const res = mockModelsApiResponse();
    expect(res.object).toBe('list');
    expect(res.data.map((m) => m.id)).toEqual(mockSearchModels({ kind: 'llm', limit: 100 }).models.map((m) => (m as M).model_id));
    // GMI documents /v1/models rows as { id, object, created, owned_by }: nothing the catalog could take prices from.
    for (const row of res.data) expect(Object.keys(row).sort()).toEqual(['id', 'object', 'owned_by']);
    expect(res.data.find((m) => m.id === 'zai-org/GLM-5.3')).toEqual({ id: 'zai-org/GLM-5.3', object: 'model', owned_by: 'gmi' });
  });
});
