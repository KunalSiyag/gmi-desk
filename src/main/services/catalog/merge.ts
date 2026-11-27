/**
 * Merges per-source patches into CatalogModel[] by model id (case-insensitive).
 *
 * Which models exist:
 *  - LLMs: the models API list (inference key) when available, else MCP's LLM list (signed in), else
 *    the public featured + leaderboard feeds (best effort; leaderboard-only models must also be on the
 *    last authoritative list when one is known). An empty list is not an authority. The public price
 *    list never creates a model: it keeps retired and dedicated-endpoint entries.
 *  - Media/workflows: MCP, the public queue catalog or the featured feed. Ids GMI marks inactive or
 *    invisible in the queue catalog are dropped whatever the other sources say.
 * Field values come from the most specific source that has them (see PRECEDENCE).
 */
import type {
  CatalogModel,
  CatalogSource,
  LlmListSource,
  LlmPricing,
  MediaPricing,
  ModalitySpec,
  ModelKind,
} from '@shared/contracts/catalog';
import { iconMatchesProvider, prettyProvider, providerForIcon } from './providers';
import { classifyApi, idKey } from './text';
import type { ModelPatch, SourceResult } from './types';

type Field = keyof Omit<ModelPatch, 'id' | 'source'>;

const PRECEDENCE: Partial<Record<Field, CatalogSource[]>> = {
  name: ['leaderboard', 'mcp', 'public_media', 'featured', 'models_api', 'public_prices'],
  kind: ['mcp', 'models_api', 'public_media', 'featured', 'leaderboard', 'public_prices'],
  description: ['mcp', 'public_media', 'featured'],
  iconUrl: ['public_media', 'featured', 'mcp'],
  contextLength: ['mcp', 'models_api'],
  quantization: ['mcp'],
  llmPricing: ['mcp', 'models_api', 'featured', 'public_prices'],
  mediaPricing: ['mcp', 'public_media', 'featured', 'public_prices'],
  discount: ['mcp', 'models_api', 'public_media', 'featured', 'public_prices'],
  inputs: ['mcp', 'public_media'],
  outputs: ['mcp', 'public_media'],
  createdAt: ['public_media', 'models_api'],
  openSource: ['featured', 'leaderboard'],
  leaderboard: ['leaderboard'],
  featuredOrder: ['featured'],
};

/** Which source's id spelling to keep (the inference API's own spelling first). */
const ID_PRECEDENCE: CatalogSource[] = ['models_api', 'mcp', 'public_media', 'featured', 'leaderboard', 'public_prices'];
const HINT_PRECEDENCE: CatalogSource[] = ['mcp', 'public_media', 'featured', 'leaderboard', 'models_api'];
const SOURCE_ORDER: CatalogSource[] = ['mcp', 'models_api', 'public_media', 'featured', 'leaderboard', 'public_prices'];
export const KIND_ORDER: ModelKind[] = ['llm', 'image', 'video', 'audio', 'workflow', 'other'];

const TEXT_IO: ModalitySpec[] = [{ type: 'text', required: true }];

function pick<K extends Field>(bySource: Map<CatalogSource, ModelPatch>, field: K): ModelPatch[K] | undefined {
  for (const source of PRECEDENCE[field] ?? []) {
    const value = bySource.get(source)?.[field];
    if (value !== undefined && value !== null) {
      if (Array.isArray(value) && value.length === 0) continue;
      return value;
    }
  }
  return undefined;
}

export interface MergeResult {
  /** Visible models, sorted by kind then name. `firstSeenAt`/`isNew` are filled in by seen.ts. */
  models: CatalogModel[];
  /** Workflows hidden as duplicates of a newer one with the same name (still resolvable by id). */
  duplicates: CatalogModel[];
  llmListSource: LlmListSource;
  /**
   * Every non-junk id each source returned except price-only rows (lower-case keys): drives first-seen tracking.
   * Workflows carry their title key (see workflowTitleKey), so a republished copy is not announced as new.
   */
  observed: Map<string, { sources: Set<CatalogSource>; createdAt: string | null; title?: string }>;
}

export interface MergeOptions {
  /**
   * The last LLM list a models API or MCP refresh vouched for (kept across sign-out). Without a credential in
   * this refresh, leaderboard-only LLMs must be on it: GMI benchmarks models it does not serve (anthropic/*).
   */
  knownLlmIds?: readonly string[] | null;
}

export function mergeSources(results: Partial<Record<CatalogSource, SourceResult>>, opts: MergeOptions = {}): MergeResult {
  const hidden = new Set<string>();
  const groups = new Map<string, Map<CatalogSource, ModelPatch>>();
  const observed: MergeResult['observed'] = new Map();

  for (const source of SOURCE_ORDER) {
    const result = results[source];
    if (!result) continue;
    for (const id of result.hidden) hidden.add(idKey(id));
    for (const patch of result.patches) {
      const key = idKey(patch.id);
      let group = groups.get(key);
      if (!group) {
        group = new Map();
        groups.set(key, group);
      }
      if (!group.has(source)) group.set(source, patch);
      // GMI publishes prices before a model goes live; a price row alone must not count as "seen",
      // or the model would never get its New badge on launch.
      if (source === 'public_prices') continue;
      const seen = observed.get(key) ?? { sources: new Set<CatalogSource>(), createdAt: null };
      seen.sources.add(source);
      seen.createdAt = seen.createdAt ?? patch.createdAt ?? null;
      observed.set(key, seen);
    }
  }
  for (const key of hidden) observed.delete(key);

  // An empty list (a key without model access, an unrecognised response) is no authority: it would drop every LLM.
  const apiIds = results.models_api?.llmIds?.length ? results.models_api.llmIds : null;
  const mcpIds = results.mcp?.llmIds?.length ? results.mcp.llmIds : null;
  const authority = apiIds ? new Set(apiIds.map(idKey)) : mcpIds ? new Set(mcpIds.map(idKey)) : null;
  const llmListSource: LlmListSource = apiIds ? 'models_api' : mcpIds ? 'mcp' : 'public';
  const known = !authority && opts.knownLlmIds?.length ? new Set(opts.knownLlmIds.map(idKey)) : null;

  const models: CatalogModel[] = [];
  for (const [key, bySource] of groups) {
    if (hidden.has(key)) continue;
    const kind: ModelKind = pick(bySource, 'kind') ?? 'other';
    if (kind === 'llm') {
      if (authority) {
        if (!authority.has(key)) continue;
      } else if (!bySource.has('featured') && !(bySource.has('leaderboard') && (!known || known.has(key)))) {
        continue;
      }
    } else if (!bySource.has('mcp') && !bySource.has('public_media') && !bySource.has('featured')) {
      continue;
    }
    const idSource = ID_PRECEDENCE.find((s) => bySource.has(s));
    const id = (idSource ? bySource.get(idSource)?.id : undefined) ?? key;
    const name = pick(bySource, 'name');
    if (!name) continue;

    const hints = HINT_PRECEDENCE.map((s) => bySource.get(s)?.providerHint ?? null);
    const llmPricing = kind === 'llm' ? (pick(bySource, 'llmPricing') as LlmPricing | undefined) ?? null : null;
    let mediaPricing: MediaPricing | null = null;
    if (kind !== 'llm') {
      const base = (pick(bySource, 'mediaPricing') as MediaPricing | undefined) ?? null;
      const publicPricing = bySource.get('public_media')?.mediaPricing ?? null;
      if (base) {
        mediaPricing = {
          ...base,
          unit: base.unit ?? publicPricing?.unit ?? null,
          pricingType: base.pricingType ?? publicPricing?.pricingType ?? null,
          details: base.details ?? publicPricing?.details ?? null,
        };
      }
    }
    const mcp = bySource.get('mcp');
    const available = mcp?.available ?? true;
    const featured = [...bySource.values()].some((p) => p.featured === true);
    const tags = [
      ...new Map(
        [...(bySource.get('public_media')?.tags ?? []), ...(bySource.get('featured')?.tags ?? [])].map((t) => [t.toLowerCase(), t]),
      ).values(),
    ].slice(0, 10);

    const provider = prettyProvider(id, hints, kind);
    const icon = pick(bySource, 'iconUrl') ?? null;
    models.push({
      id,
      name,
      kind,
      provider,
      description: pick(bySource, 'description') ?? null,
      iconUrl: icon && (kind !== 'llm' || iconMatchesProvider(icon, provider)) ? icon : null,
      tags,
      api: classifyApi(id, kind),
      contextLength: kind === 'llm' ? (pick(bySource, 'contextLength') ?? null) : null,
      quantization: kind === 'llm' ? (pick(bySource, 'quantization') ?? null) : null,
      llmPricing,
      mediaPricing,
      discount: pick(bySource, 'discount') ?? null,
      inputs: pick(bySource, 'inputs') ?? (kind === 'llm' ? TEXT_IO : []),
      outputs: pick(bySource, 'outputs') ?? (kind === 'llm' ? TEXT_IO : []),
      available,
      featured,
      createdAt: pick(bySource, 'createdAt') ?? null,
      firstSeenAt: '',
      isNew: false,
      leaderboard: pick(bySource, 'leaderboard') ?? null,
      sources: SOURCE_ORDER.filter((s) => bySource.has(s)),
      openSource: pick(bySource, 'openSource') ?? null,
      featuredOrder: pick(bySource, 'featuredOrder') ?? null,
    });
  }

  // LLM logos: GMI attaches icons to only a few featured LLMs (some to the wrong model). Every logo it
  // publishes is assigned to the provider its file name names, and LLMs without a verified logo use it.
  const providerIcons = new Map<string, string>();
  for (const bySource of groups.values()) {
    for (const p of bySource.values()) {
      const provider = p.iconUrl ? providerForIcon(p.iconUrl) : null;
      if (provider && p.iconUrl && !providerIcons.has(provider)) providerIcons.set(provider, p.iconUrl);
    }
  }
  for (const m of models) {
    if (m.kind === 'llm' && !m.iconUrl && m.provider) m.iconUrl = providerIcons.get(m.provider) ?? null;
  }

  for (const m of models) {
    if (m.kind !== 'workflow') continue;
    const seen = observed.get(idKey(m.id));
    if (seen) seen.title = workflowTitleKey(m.name);
  }

  const { kept, duplicates } = dedupeWorkflows(models);
  kept.sort(compareModels);
  return { models: kept, duplicates, llmListSource, observed };
}

/** Workflow copies GMI Studio publishes under new ids share this key (their normalised title). */
export function workflowTitleKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function compareModels(a: CatalogModel, b: CatalogModel): number {
  const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (k !== 0) return k;
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id);
}

/**
 * GMI Studio republishes workflows under new ids, so the gallery lists the same title several times.
 * Keep the newest per title; older copies stay resolvable by id (findModel/getModel).
 */
export function dedupeWorkflows(models: CatalogModel[]): { kept: CatalogModel[]; duplicates: CatalogModel[] } {
  const best = new Map<string, CatalogModel>();
  for (const m of models) {
    if (m.kind !== 'workflow') continue;
    const key = workflowTitleKey(m.name);
    const prev = best.get(key);
    const newer = !prev || (Date.parse(m.createdAt ?? '') || 0) > (Date.parse(prev.createdAt ?? '') || 0);
    if (newer) best.set(key, m);
  }
  const keep = new Set(best.values());
  const kept: CatalogModel[] = [];
  const duplicates: CatalogModel[] = [];
  for (const m of models) {
    if (m.kind !== 'workflow' || keep.has(m)) kept.push(m);
    else duplicates.push(m);
  }
  return { kept, duplicates };
}
