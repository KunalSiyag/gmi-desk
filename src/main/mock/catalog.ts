// Owned by the Catalog slice: mock handlers for search_models and get_model, plus the recorded public
// feeds the catalog serves in mock mode. Fixtures were recorded from GMI on 2026-10-31 and sanitised
// (no org ids, no output URLs, trimmed lists); see src/main/mock/fixtures/catalog/.
import { GmiError } from '@shared/contracts/errors';
import mcpGetModelFixture from './fixtures/catalog/mcp-get-model.json';
import mcpSearchLlmFixture from './fixtures/catalog/mcp-search-llm.json';
import mcpSearchMultimodalFixture from './fixtures/catalog/mcp-search-multimodal.json';
import publicFeaturedFixture from './fixtures/catalog/public-featured.json';
import publicLeaderboardFixture from './fixtures/catalog/public-leaderboard.json';
import publicPricesFixture from './fixtures/catalog/public-model-prices.json';
import publicMediaFixture from './fixtures/catalog/public-requestqueue-models.json';
import type { MockToolTable } from './types';

type Entry = Record<string, unknown>;

/** The four public console feeds, as recorded. Callers must clone before mutating. */
export const catalogPublicFixtures: { prices: unknown; media: unknown; featured: unknown; leaderboard: unknown } = {
  prices: publicPricesFixture as unknown,
  media: publicMediaFixture as unknown,
  featured: publicFeaturedFixture as unknown,
  leaderboard: publicLeaderboardFixture as unknown,
};

/** Shown as recently added in mock mode, so New badges and the notification are visible in demos. */
export const MOCK_NEW_MODEL_IDS: readonly string[] = [
  'deepseek-ai/deepseek-v4.1-flash-1017',
  'google/gemini-3.8-flash',
  'gpt-image-2.5-flare-generate',
];

const llmPool = (): Entry[] => (mcpSearchLlmFixture as unknown as { models: Entry[] }).models;
const multimodalPool = (): Entry[] => (mcpSearchMultimodalFixture as unknown as { models: Entry[] }).models;
const recordedGetModel = (): Record<string, Entry> => mcpGetModelFixture as unknown as Record<string, Entry>;
const publicMediaRows = (): Entry[] => (publicMediaFixture as unknown as { models: Entry[] }).models;

const text = (v: unknown) => (typeof v === 'string' ? v : '');

function modalityTypes(entry: Entry): string[] {
  const mm = entry.multimodal as { input?: Array<{ type?: string }>; output?: Array<{ type?: string }> } | undefined;
  if (!mm) return ['text'];
  return [...(mm.input ?? []), ...(mm.output ?? [])].map((m) => text(m.type).toLowerCase()).filter(Boolean);
}

function hasModality(entry: Entry, modality: string): boolean {
  return modalityTypes(entry).some((t) => t === modality || t.endsWith(`_${modality}`));
}

function matchesTask(entry: Entry, task: string): boolean {
  const mm = entry.multimodal as { input?: Array<{ type?: string }>; output?: Array<{ type?: string }> } | undefined;
  const ins = (mm?.input ?? []).map((m) => text(m.type).toLowerCase());
  const outs = (mm?.output ?? []).map((m) => text(m.type).toLowerCase());
  switch (task) {
    case 'text-to-image':
      return ins.includes('text') && outs.includes('image');
    case 'image-editing':
      return ins.includes('image') && outs.includes('image');
    case 'image-to-video':
      return ins.some((t) => t.includes('image')) && outs.includes('video');
    default:
      return true;
  }
}

/** Mirrors GMI's search_models: kind, modality (input or output), task, provider (case-insensitive), query, limit 1..100 (default 20). */
export function mockSearchModels(args: Record<string, unknown>): { models: Entry[] } {
  const kind = text(args.kind).toLowerCase();
  const modality = text(args.modality).toLowerCase();
  const task = text(args.task).toLowerCase();
  const provider = text(args.provider).toLowerCase();
  const query = text(args.query).toLowerCase();
  const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
  const limit = Math.min(100, Math.max(1, Math.round(rawLimit)));

  let pool: Entry[] = kind === 'llm' ? llmPool() : kind === 'multimodal' ? multimodalPool() : [...llmPool(), ...multimodalPool()];
  if (modality) pool = pool.filter((e) => hasModality(e, modality));
  if (task) pool = pool.filter((e) => matchesTask(e, task));
  if (provider) pool = pool.filter((e) => text(e.provider).toLowerCase() === provider);
  if (query) {
    pool = pool.filter((e) => [e.model_id, e.display_name, e.description].some((v) => text(v).toLowerCase().includes(query)));
  }
  return { models: structuredClone(pool.slice(0, limit)) };
}

/** Public queue-catalog parameter → the MCP get_model parameter shape. */
function toMcpParameter(p: Entry): Entry {
  const out: Entry = { name: p.name, description: text(p.description), type: p.type, required: p.required === true };
  if (p.default_value !== undefined) out.default = p.default_value;
  if (Array.isArray(p.options)) out.enum = p.options.map((o) => (o && typeof o === 'object' ? (o as Entry).value : o));
  if (typeof p.min_value === 'number') out.min = p.min_value;
  if (typeof p.max_value === 'number') out.max = p.max_value;
  return out;
}

/** Mirrors GMI's get_model: recorded results for a few ids, otherwise the search entry plus its parameters. */
export function mockGetModel(args: Record<string, unknown>): Entry {
  const id = text(args.model_id).trim();
  if (!id) throw new GmiError('invalid_input', 'model_id is required');
  const recorded = recordedGetModel()[id];
  if (recorded) return structuredClone(recorded);
  const llm = llmPool().find((e) => e.model_id === id);
  if (llm) return { ...structuredClone(llm), parameters: null };
  const mm = multimodalPool().find((e) => e.model_id === id && e.model_id !== '');
  if (mm) {
    const row = publicMediaRows().find((r) => r.model === id);
    const params = Array.isArray(row?.parameters) ? (row.parameters as Entry[]).map(toMcpParameter) : null;
    return { ...structuredClone(mm), parameters: params };
  }
  throw new GmiError('not_found', `no model with id "${id}"; call search_models to list available ids`);
}

/**
 * What GET /v1/models returns for the mock inference key: the recorded MCP LLM ids in GMI's documented shape
 * (id, object, owned_by; no prices, context windows or discounts), so mock mode and slice tests take the same
 * path as a real key. `created` is left out: the recordings have no creation dates and an invented one would
 * show up as "Added by GMI" on every LLM.
 */
export function mockModelsApiResponse(): { object: 'list'; data: Entry[] } {
  return {
    object: 'list',
    data: llmPool().map((e) => ({ id: e.model_id, object: 'model', owned_by: 'gmi' })),
  };
}

export const catalogMockTools: MockToolTable = {
  search_models: (args) => mockSearchModels(args),
  get_model: (args) => mockGetModel(args),
};
