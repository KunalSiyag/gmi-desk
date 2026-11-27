/**
 * The on-disk catalog cache (data/catalog-cache.json): the last snapshot for instant/offline startup plus
 * each source's last good result. It is read back defensively: a hand edit or a CatalogModel change shipped
 * without a CACHE_VERSION bump must not stop the app from starting, so every entry is type-checked and
 * entries that cannot be used are dropped.
 */
import type {
  CatalogModel,
  CatalogSnapshot,
  CatalogSource,
  Leaderboard,
  LeaderboardScores,
  LlmListSource,
  LlmPricing,
  MediaPricing,
  ModalitySpec,
  ModelApi,
  ModelKind,
  SourceState,
  SourceStatus,
} from '@shared/contracts/catalog';
import { classifyApi, isHttpsUrl } from './text';
import type { ModelPatch, SourceResult } from './types';

export const CACHE_VERSION = 1;

export interface CacheFile {
  version: number;
  snapshot: CatalogSnapshot;
  duplicates: CatalogModel[];
  leaderboard: Leaderboard | null;
  /** Last successful result per source, reused when a later fetch fails. */
  lastGood: Partial<Record<CatalogSource, { fetchedAt: string; result: SourceResult }>>;
  /** The last LLM list the models API or MCP vouched for. Kept across sign-out (see MergeOptions.knownLlmIds). */
  knownLlmIds?: string[];
  /** Lower-case LLM id → context window seen from MCP or the models API. Kept across sign-out (OpenCode export). */
  contextLengths?: Record<string, number>;
}

const KINDS: ReadonlySet<string> = new Set<ModelKind>(['llm', 'image', 'video', 'audio', 'workflow', 'other']);
const APIS: ReadonlySet<string> = new Set<ModelApi>(['chat', 'responses', 'messages', 'queue']);
const SOURCES: ReadonlySet<string> = new Set<CatalogSource>(['mcp', 'models_api', 'public_prices', 'public_media', 'featured', 'leaderboard']);
const STATES: ReadonlySet<string> = new Set<SourceState>(['ok', 'stale', 'error', 'skipped']);
const LIST_SOURCES: ReadonlySet<string> = new Set<LlmListSource>(['models_api', 'mcp', 'public']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

function modalities(v: unknown): ModalitySpec[] {
  return Array.isArray(v) ? v.filter(isObj).flatMap((m) => (typeof m.type === 'string' ? [{ type: m.type, required: m.required === true }] : [])) : [];
}

function llmPricing(v: unknown): LlmPricing | null {
  if (!isObj(v)) return null;
  const tiers = Array.isArray(v.tiers)
    ? v.tiers.filter(isObj).map((t) => ({
        minPromptTokens: finite(t.minPromptTokens) ?? 0,
        inputPerMTok: finite(t.inputPerMTok),
        outputPerMTok: finite(t.outputPerMTok),
        cacheReadPerMTok: finite(t.cacheReadPerMTok),
        cacheWritePerMTok: finite(t.cacheWritePerMTok),
      }))
    : [];
  return {
    inputPerMTok: finite(v.inputPerMTok),
    outputPerMTok: finite(v.outputPerMTok),
    cacheReadPerMTok: finite(v.cacheReadPerMTok),
    cacheWritePerMTok: finite(v.cacheWritePerMTok),
    ...(tiers.length ? { tiers } : {}),
  };
}

function mediaPricing(v: unknown): MediaPricing | null {
  return isObj(v) ? { usdPerUnit: finite(v.usdPerUnit), unit: text(v.unit), pricingType: text(v.pricingType), details: text(v.details) } : null;
}

function scores(v: unknown): LeaderboardScores | null {
  return isObj(v) ? { overall: finite(v.overall), coding: finite(v.coding), agentic: finite(v.agentic), reasoning: finite(v.reasoning) } : null;
}

/** A cached model with every field type-checked, or null when it has no usable id, name or kind. */
export function reviveModel(raw: unknown): CatalogModel | null {
  if (!isObj(raw)) return null;
  const id = nonEmpty(raw.id);
  const name = nonEmpty(raw.name);
  if (!id || !name || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  const kind = raw.kind as ModelKind;
  return {
    id,
    name,
    kind,
    provider: text(raw.provider),
    description: text(raw.description),
    iconUrl: isHttpsUrl(raw.iconUrl) ? raw.iconUrl : null,
    tags: strings(raw.tags),
    api: typeof raw.api === 'string' && APIS.has(raw.api) ? (raw.api as ModelApi) : classifyApi(id, kind),
    contextLength: finite(raw.contextLength),
    quantization: text(raw.quantization),
    llmPricing: llmPricing(raw.llmPricing),
    mediaPricing: mediaPricing(raw.mediaPricing),
    discount: finite(raw.discount),
    inputs: modalities(raw.inputs),
    outputs: modalities(raw.outputs),
    available: raw.available !== false,
    featured: raw.featured === true,
    createdAt: isoOrNull(raw.createdAt),
    firstSeenAt: text(raw.firstSeenAt) ?? '',
    isNew: raw.isNew === true,
    leaderboard: scores(raw.leaderboard),
    sources: strings(raw.sources).filter((s): s is CatalogSource => SOURCES.has(s)),
    openSource: typeof raw.openSource === 'boolean' ? raw.openSource : null,
    featuredOrder: finite(raw.featuredOrder),
  };
}

/** A cached source patch with the fields mergeSources reads type-checked (wrong types are dropped). */
function revivePatch(raw: unknown, source: CatalogSource): ModelPatch | null {
  if (!isObj(raw)) return null;
  const id = nonEmpty(raw.id);
  if (!id) return null;
  const p: ModelPatch = { id, source };
  for (const key of ['name', 'providerHint', 'description', 'quantization', 'createdAt'] as const) {
    const value = raw[key];
    if (typeof value === 'string') p[key] = value;
  }
  if (typeof raw.kind === 'string' && KINDS.has(raw.kind)) p.kind = raw.kind as ModelKind;
  if (isHttpsUrl(raw.iconUrl)) p.iconUrl = raw.iconUrl;
  if (Array.isArray(raw.tags)) p.tags = strings(raw.tags);
  if (finite(raw.contextLength) !== null) p.contextLength = finite(raw.contextLength);
  if (finite(raw.discount) !== null) p.discount = finite(raw.discount);
  if (finite(raw.featuredOrder) !== null) p.featuredOrder = finite(raw.featuredOrder);
  if (isObj(raw.llmPricing)) p.llmPricing = llmPricing(raw.llmPricing);
  if (isObj(raw.mediaPricing)) p.mediaPricing = mediaPricing(raw.mediaPricing);
  if (isObj(raw.leaderboard)) p.leaderboard = scores(raw.leaderboard);
  if (Array.isArray(raw.inputs)) p.inputs = modalities(raw.inputs);
  if (Array.isArray(raw.outputs)) p.outputs = modalities(raw.outputs);
  if (typeof raw.available === 'boolean') p.available = raw.available;
  if (typeof raw.featured === 'boolean') p.featured = raw.featured;
  if (typeof raw.openSource === 'boolean') p.openSource = raw.openSource;
  return p;
}

function reviveResult(raw: unknown, source: CatalogSource): SourceResult | null {
  if (!isObj(raw) || !Array.isArray(raw.patches)) return null;
  const patches = raw.patches.map((p) => revivePatch(p, source)).filter((p): p is ModelPatch => p !== null);
  return {
    patches,
    hidden: strings(raw.hidden),
    count: finite(raw.count) ?? patches.length,
    ...(Array.isArray(raw.llmIds) ? { llmIds: strings(raw.llmIds) } : {}),
  };
}

function reviveLeaderboard(raw: unknown): Leaderboard | null {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return null;
  const numbers = (v: unknown): Record<string, number> =>
    isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => finite(e[1]) !== null)) : {};
  return {
    categories: (Array.isArray(raw.categories) ? raw.categories : [])
      .filter(isObj)
      .flatMap((c) => (nonEmpty(c.key) ? [{ key: c.key as string, label: text(c.label) ?? (c.key as string) }] : [])),
    entries: raw.entries.filter(isObj).flatMap((e) => {
      const modelId = nonEmpty(e.modelId);
      const name = nonEmpty(e.name);
      if (!modelId || !name) return [];
      return [{ modelId, name, provider: text(e.provider), openSource: e.openSource === true, publishedAt: isoOrNull(e.publishedAt), quality: numbers(e.quality), cost: numbers(e.cost) }];
    }),
    fetchedAt: isoOrNull(raw.fetchedAt) ?? new Date(0).toISOString(),
  };
}

function reviveSources(raw: unknown): Partial<Record<CatalogSource, SourceStatus>> {
  const out: Partial<Record<CatalogSource, SourceStatus>> = {};
  if (!isObj(raw)) return out;
  for (const [key, v] of Object.entries(raw)) {
    if (!SOURCES.has(key) || !isObj(v)) continue;
    out[key as CatalogSource] = {
      ok: v.ok === true,
      fetchedAt: isoOrNull(v.fetchedAt),
      count: finite(v.count) ?? 0,
      error: text(v.error),
      ...(typeof v.state === 'string' && STATES.has(v.state) ? { state: v.state as SourceState } : {}),
    };
  }
  return out;
}

export interface RevivedCache {
  cache: CacheFile;
  /** Model and duplicate entries that were dropped as unusable. */
  dropped: number;
}

/**
 * Reads a parsed catalog-cache.json. Null when it was written by another cache version (ignored, then
 * overwritten by the next refresh). Throws when it claims this version but is not a catalog cache at all.
 */
export function reviveCache(raw: unknown): RevivedCache | null {
  if (!isObj(raw) || raw.version !== CACHE_VERSION) return null;
  const snap = raw.snapshot;
  if (!isObj(snap) || !Array.isArray(snap.models)) throw new Error('catalog cache has no model list');
  const rawDuplicates = Array.isArray(raw.duplicates) ? raw.duplicates : [];
  const models = snap.models.map(reviveModel).filter((m): m is CatalogModel => m !== null);
  const duplicates = rawDuplicates.map(reviveModel).filter((m): m is CatalogModel => m !== null);

  const lastGood: CacheFile['lastGood'] = {};
  if (isObj(raw.lastGood)) {
    for (const [source, entry] of Object.entries(raw.lastGood)) {
      if (!SOURCES.has(source) || !isObj(entry)) continue;
      const fetchedAt = isoOrNull(entry.fetchedAt);
      const result = reviveResult(entry.result, source as CatalogSource);
      if (fetchedAt && result) lastGood[source as CatalogSource] = { fetchedAt, result };
    }
  }

  const contextLengths: Record<string, number> = {};
  if (isObj(raw.contextLengths)) {
    for (const [id, n] of Object.entries(raw.contextLengths)) {
      const value = finite(n);
      if (value !== null && value > 0) contextLengths[id.toLowerCase()] = Math.round(value);
    }
  }

  return {
    cache: {
      version: CACHE_VERSION,
      snapshot: {
        models,
        updatedAt: isoOrNull(snap.updatedAt),
        sources: reviveSources(snap.sources),
        refreshing: false,
        llmListSource: typeof snap.llmListSource === 'string' && LIST_SOURCES.has(snap.llmListSource) ? (snap.llmListSource as LlmListSource) : null,
      },
      duplicates,
      leaderboard: reviveLeaderboard(raw.leaderboard),
      lastGood,
      knownLlmIds: strings(raw.knownLlmIds),
      contextLengths,
    },
    dropped: snap.models.length - models.length + rawDuplicates.length - duplicates.length,
  };
}
