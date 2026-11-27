/**
 * Pure catalog filtering, faceting and sorting for the Models page (no DOM, no React: unit-tested in
 * test/catalog/page-filter.test.ts).
 */
import type { CatalogModel, LeaderboardEntry, ModelApi, ModelKind } from '@shared/contracts/catalog';
import { applyDiscount } from '@shared/lib/money';

export type KindFilter = 'all' | 'llm' | 'image' | 'video' | 'audio' | 'workflow';
/** The kind tabs plus the leaderboard view. */
export type ModelsTab = KindFilter | 'leaderboard';
export type SortKey = 'recommended' | 'newest' | 'name' | 'price' | 'context';

export interface CatalogFilters {
  query: string;
  kind: KindFilter;
  provider: string | null;
  onlyNew: boolean;
  onlyFeatured: boolean;
  onlyDiscounted: boolean;
  sort: SortKey;
}

export const DEFAULT_FILTERS: CatalogFilters = {
  query: '',
  kind: 'all',
  provider: null,
  onlyNew: false,
  onlyFeatured: false,
  onlyDiscounted: false,
  sort: 'recommended',
};

export const KIND_TABS: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'llm', label: 'LLMs' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
  { value: 'workflow', label: 'Workflows' },
];

export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'recommended', label: 'Recommended' },
  { value: 'newest', label: 'Newest' },
  { value: 'name', label: 'Name' },
  { value: 'price', label: 'Lowest price' },
  { value: 'context', label: 'Largest context' },
];

const KIND_ORDER: ModelKind[] = ['llm', 'image', 'video', 'audio', 'workflow', 'other'];

export function kindLabel(kind: ModelKind): string {
  switch (kind) {
    case 'llm':
      return 'LLM';
    case 'image':
      return 'Image';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'workflow':
      return 'Workflow';
    default:
      return 'Other';
  }
}

export function apiLabel(api: ModelApi): string {
  switch (api) {
    case 'chat':
      return 'Chat Completions';
    case 'responses':
      return 'Responses API';
    case 'messages':
      return 'Messages API';
    default:
      return 'Request queue';
  }
}

export function isTabValue(value: unknown): value is ModelsTab {
  return value === 'leaderboard' || KIND_TABS.some((t) => t.value === value);
}

export function isSortKey(value: unknown): value is SortKey {
  return SORT_OPTIONS.some((o) => o.value === value);
}

export function isDiscounted(model: CatalogModel): boolean {
  return (model.discount ?? 0) > 0;
}

/** Charged LLM prices (USD per 1M tokens) after the discount; null parts when GMI publishes none. */
export function chargedLlm(model: CatalogModel): { input: number | null; output: number | null } {
  const p = model.llmPricing;
  return { input: applyDiscount(p?.inputPerMTok, model.discount), output: applyDiscount(p?.outputPerMTok, model.discount) };
}

/** Charged media price per unit after the discount. */
export function chargedMedia(model: CatalogModel): number | null {
  return applyDiscount(model.mediaPricing?.usdPerUnit, model.discount);
}

/**
 * Comparable price: LLMs use a 3:1 input/output blend per 1M tokens (the usual chat mix), media the
 * charged price per unit. Only meaningful within one kind; sorting groups by kind first.
 */
export function priceKey(model: CatalogModel): number | null {
  if (model.kind === 'llm') {
    const { input, output } = chargedLlm(model);
    if (input === null && output === null) return null;
    if (input === null) return output;
    if (output === null) return input;
    return (3 * input + output) / 4;
  }
  return chargedMedia(model);
}

function time(iso: string | null | undefined): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** When the model arrived: GMI's creation date, or when this app first saw it if that is later. */
export function arrivedAt(model: CatalogModel): number {
  return Math.max(time(model.createdAt), time(model.firstSeenAt));
}

export function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Every token must appear in the id, name, provider, kind or tags. */
export function matchesQuery(model: CatalogModel, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [model.id, model.name, model.provider ?? '', kindLabel(model.kind), model.kind === 'llm' ? 'llm' : '', ...model.tags]
    .join(' ')
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

const byName = (a: CatalogModel, b: CatalogModel) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id);
const byKind = (a: CatalogModel, b: CatalogModel) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
/** Nulls last, ascending. */
const ascNullsLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);
/** Nulls last, descending. */
const descNullsLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a);

/** Featured (GMI's order) → new (newest first) → on the leaderboard (best first) → the rest by kind and name. */
function recommendedTier(model: CatalogModel): number {
  if (model.featured) return 0;
  if (model.isNew) return 1;
  if (model.leaderboard?.overall !== null && model.leaderboard?.overall !== undefined) return 2;
  return 3;
}

export function compareModels(sort: SortKey): (a: CatalogModel, b: CatalogModel) => number {
  switch (sort) {
    case 'name':
      return byName;
    case 'newest':
      return (a, b) => arrivedAt(b) - arrivedAt(a) || byName(a, b);
    case 'price':
      return (a, b) => byKind(a, b) || ascNullsLast(priceKey(a), priceKey(b)) || byName(a, b);
    case 'context':
      return (a, b) => descNullsLast(a.contextLength, b.contextLength) || byKind(a, b) || byName(a, b);
    default:
      return (a, b) => {
        const ta = recommendedTier(a);
        const tb = recommendedTier(b);
        if (ta !== tb) return ta - tb;
        if (ta === 0) return ascNullsLast(a.featuredOrder ?? null, b.featuredOrder ?? null) || byKind(a, b) || byName(a, b);
        if (ta === 1) return arrivedAt(b) - arrivedAt(a) || byName(a, b);
        if (ta === 2) return (b.leaderboard?.overall ?? 0) - (a.leaderboard?.overall ?? 0) || byName(a, b);
        return byKind(a, b) || byName(a, b);
      };
  }
}

export function sortModels(models: CatalogModel[], sort: SortKey): CatalogModel[] {
  return [...models].sort(compareModels(sort));
}

const kindMatches = (model: CatalogModel, kind: KindFilter) => kind === 'all' || model.kind === kind;
const providerMatches = (model: CatalogModel, provider: string | null) => provider === null || model.provider === provider;

function chipsMatch(model: CatalogModel, f: Pick<CatalogFilters, 'onlyNew' | 'onlyFeatured' | 'onlyDiscounted'>): boolean {
  return (!f.onlyNew || model.isNew) && (!f.onlyFeatured || model.featured) && (!f.onlyDiscounted || isDiscounted(model));
}

export interface CatalogView {
  /** Models to list, filtered and sorted. */
  rows: CatalogModel[];
  /** Per kind tab, with every other filter applied. */
  kindCounts: Record<KindFilter, number>;
  /** Providers available under the current kind/search/toggles, by name. */
  providers: Array<{ name: string; count: number }>;
  /** What each toggle would show, with every other filter applied. */
  toggleCounts: { new: number; featured: number; discounted: number };
  /** True when any filter beyond the kind tab and sort is narrowing the list. */
  narrowed: boolean;
}

/** Faceted filtering: each facet's counts ignore that facet's own selection. */
export function buildCatalogView(models: CatalogModel[], filters: CatalogFilters): CatalogView {
  const tokens = searchTokens(filters.query);
  const searched = tokens.length ? models.filter((m) => matchesQuery(m, tokens)) : models;
  const base = searched.filter((m) => chipsMatch(m, filters));

  const kindCounts: Record<KindFilter, number> = { all: 0, llm: 0, image: 0, video: 0, audio: 0, workflow: 0 };
  for (const m of base) {
    if (!providerMatches(m, filters.provider)) continue;
    kindCounts.all += 1;
    if (m.kind in kindCounts) kindCounts[m.kind as KindFilter] += 1;
  }

  const providerCounts = new Map<string, number>();
  for (const m of base) {
    if (!kindMatches(m, filters.kind) || !m.provider) continue;
    providerCounts.set(m.provider, (providerCounts.get(m.provider) ?? 0) + 1);
  }
  const providers = [...providerCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  const scoped = searched.filter((m) => kindMatches(m, filters.kind) && providerMatches(m, filters.provider));
  const toggleCounts = {
    new: scoped.filter((m) => m.isNew && chipsMatch(m, { ...filters, onlyNew: false })).length,
    featured: scoped.filter((m) => m.featured && chipsMatch(m, { ...filters, onlyFeatured: false })).length,
    discounted: scoped.filter((m) => isDiscounted(m) && chipsMatch(m, { ...filters, onlyDiscounted: false })).length,
  };

  const rows = sortModels(
    base.filter((m) => kindMatches(m, filters.kind) && providerMatches(m, filters.provider)),
    filters.sort,
  );
  const narrowed = tokens.length > 0 || filters.provider !== null || filters.onlyNew || filters.onlyFeatured || filters.onlyDiscounted;
  return { rows, kindCounts, providers, toggleCounts, narrowed };
}

/** The smallest change to `filters` that makes `model` visible (used when a model is opened by id). */
export function revealModel(filters: CatalogFilters, model: CatalogModel): CatalogFilters {
  const next = { ...filters };
  if (!kindMatches(model, next.kind)) next.kind = KIND_TABS.some((t) => t.value === model.kind) ? (model.kind as KindFilter) : 'all';
  if (!providerMatches(model, next.provider)) next.provider = null;
  if (next.onlyNew && !model.isNew) next.onlyNew = false;
  if (next.onlyFeatured && !model.featured) next.onlyFeatured = false;
  if (next.onlyDiscounted && !isDiscounted(model)) next.onlyDiscounted = false;
  if (!matchesQuery(model, searchTokens(next.query))) next.query = '';
  return next;
}

/** Case-insensitive id lookup (GMI ids differ in case across feeds). */
export function findById(models: CatalogModel[], id: string | null | undefined): CatalogModel | null {
  if (!id) return null;
  const key = id.trim().toLowerCase();
  return models.find((m) => m.id.toLowerCase() === key) ?? null;
}

export type LeaderboardSort = string;

/** Leaderboard rows matching the search, sorted by a quality key (descending, missing scores last). */
export function sortLeaderboard(entries: LeaderboardEntry[], key: LeaderboardSort, query = ''): LeaderboardEntry[] {
  const tokens = searchTokens(query);
  const filtered = tokens.length
    ? entries.filter((e) => {
        const hay = `${e.modelId} ${e.name} ${e.provider ?? ''}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
    : entries;
  return [...filtered].sort((a, b) => {
    const va = a.quality[key];
    const vb = b.quality[key];
    if (va === undefined && vb === undefined) return a.name.localeCompare(b.name);
    if (va === undefined) return 1;
    if (vb === undefined) return -1;
    return vb - va || a.name.localeCompare(b.name);
  });
}

/** Best score per quality key, for highlighting. */
export function leaderboardBest(entries: LeaderboardEntry[]): Record<string, number> {
  const best: Record<string, number> = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.quality)) if (best[k] === undefined || v > (best[k] ?? Number.NEGATIVE_INFINITY)) best[k] = v;
  }
  return best;
}
