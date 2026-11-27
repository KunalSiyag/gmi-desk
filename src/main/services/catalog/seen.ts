/**
 * "New" badges come from a first-seen diff, not from GMI's dates (feed timestamps are price or
 * upload times, not releases). Persisted in data/catalog-seen.json.
 *
 * Seeding rules, so a fresh install or a newly added credential does not flag the whole catalog:
 *  - The first time a source is fetched successfully, ids that only it reports are seeded with
 *    their GMI creation date when known, else an old date.
 *  - Afterwards, an id first reported by a source that has been fetched before is "new" (now).
 *  - GMI Studio republishes workflows under new ids. A workflow id whose title the app already knows
 *    takes that title's first-seen date (and its acknowledgement) instead of being announced again.
 */
import type { CatalogModel, CatalogSource } from '@shared/contracts/catalog';
import { idKey } from './text';

export interface SeenState {
  /** lower-case model id → ISO date the app first saw it. */
  seen: Record<string, string>;
  /** lower-case model id → true once the user cleared its badge. */
  acknowledged: Record<string, true>;
  initialized: boolean;
  /** Sources that have completed at least one successful fetch. */
  sources: CatalogSource[];
  /** Workflow title key (merge.ts workflowTitleKey) → earliest ISO date any id with that title was first seen. */
  titles: Record<string, string>;
}

export const OLD_DATE = '2000-01-01T00:00:00.000Z';

export const EMPTY_SEEN: SeenState = { seen: {}, acknowledged: {}, initialized: false, sources: [], titles: {} };

const SOURCES: readonly CatalogSource[] = ['mcp', 'models_api', 'public_prices', 'public_media', 'featured', 'leaderboard'];

/** Coerces the on-disk file into a valid SeenState. */
export function normalizeSeen(raw: unknown): SeenState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen: Record<string, string> = {};
  if (r.seen && typeof r.seen === 'object') {
    for (const [k, v] of Object.entries(r.seen as Record<string, unknown>)) {
      if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) seen[k.toLowerCase()] = v;
    }
  }
  const acknowledged: Record<string, true> = {};
  if (r.acknowledged && typeof r.acknowledged === 'object') {
    for (const [k, v] of Object.entries(r.acknowledged as Record<string, unknown>)) if (v === true) acknowledged[k.toLowerCase()] = true;
  }
  const sources = Array.isArray(r.sources) ? r.sources.filter((s): s is CatalogSource => SOURCES.includes(s as CatalogSource)) : [];
  const titles: Record<string, string> = {};
  if (r.titles && typeof r.titles === 'object') {
    for (const [k, v] of Object.entries(r.titles as Record<string, unknown>)) {
      if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) titles[k] = v;
    }
  }
  return { seen, acknowledged, initialized: r.initialized === true, sources: [...new Set(sources)], titles };
}

export interface ObservedId {
  sources: Set<CatalogSource>;
  createdAt: string | null;
  /** Workflow title key: copies of one workflow share it. */
  title?: string;
}

const earlier = (a: string | undefined, b: string) => (a !== undefined && Date.parse(a) <= Date.parse(b) ? a : b);

/**
 * Records ids observed in this refresh. `freshSources` are the sources fetched successfully now
 * (stale fallbacks are not observations). Returns the ids that are genuinely new.
 */
export function recordObserved(
  state: SeenState,
  observed: Map<string, ObservedId>,
  freshSources: CatalogSource[],
  now: Date,
): { state: SeenState; newKeys: string[] } {
  const known = new Set(state.sources);
  const fresh = new Set(freshSources);
  const nowIso = now.toISOString();
  const seen = { ...state.seen };
  const acknowledged = { ...state.acknowledged };
  const titles = { ...(state.titles ?? {}) };
  const newKeys: string[] = [];

  // Workflow titles known through any id seen before (this also fills in titles for states saved before
  // titles were tracked, as long as GMI still lists the older copy).
  const acknowledgedTitles = new Set<string>();
  for (const [rawKey, info] of observed) {
    if (!info.title) continue;
    const key = rawKey.toLowerCase();
    const first = state.seen[key];
    if (first) titles[info.title] = earlier(titles[info.title], first);
    if (state.acknowledged[key]) acknowledgedTitles.add(info.title);
  }

  // Unseen copies of workflow titles the app does not know yet, by title: GMI can publish several at once.
  const newTitles = new Map<string, Array<{ key: string; isNew: boolean }>>();
  for (const [rawKey, info] of observed) {
    const key = rawKey.toLowerCase();
    if (seen[key]) continue;
    const reportedNow = [...info.sources].filter((s) => fresh.has(s));
    if (reportedNow.length === 0) continue;
    const titleFirstSeen = info.title ? titles[info.title] : undefined;
    if (info.title && titleFirstSeen) {
      // A republished copy of a workflow the user already has.
      seen[key] = titleFirstSeen;
      if (acknowledgedTitles.has(info.title)) acknowledged[key] = true;
      continue;
    }
    const viaKnownSource = state.initialized && reportedNow.some((s) => known.has(s));
    if (viaKnownSource) {
      seen[key] = nowIso;
    } else {
      const created = info.createdAt ? Date.parse(info.createdAt) : Number.NaN;
      seen[key] = Number.isNaN(created) ? OLD_DATE : new Date(Math.min(created, now.getTime())).toISOString();
    }
    if (info.title) {
      const copies = newTitles.get(info.title) ?? [];
      copies.push({ key, isNew: viaKnownSource });
      newTitles.set(info.title, copies);
    } else if (viaKnownSource) {
      newKeys.push(key);
    }
  }
  // A title seen for the first time: every copy gets the earliest date, and it is new only if every copy is.
  for (const [title, copies] of newTitles) {
    const first = copies.map((c) => seen[c.key] ?? nowIso).reduce((a, b) => earlier(a, b));
    for (const c of copies) seen[c.key] = first;
    titles[title] = first;
    if (copies.every((c) => c.isNew)) newKeys.push(...copies.map((c) => c.key));
  }
  return {
    state: {
      ...state,
      seen,
      acknowledged,
      titles,
      initialized: state.initialized || freshSources.length > 0,
      sources: [...new Set([...known, ...fresh])],
    },
    newKeys,
  };
}

export function isNewKey(state: SeenState, key: string, now: Date, windowDays: number): boolean {
  if (state.acknowledged[key]) return false;
  const first = Date.parse(state.seen[key] ?? '');
  if (Number.isNaN(first)) return false;
  const age = now.getTime() - first;
  return age >= -60_000 && age < windowDays * 86_400_000;
}

/** Fills firstSeenAt / isNew from the seen state. */
export function applySeen(models: CatalogModel[], state: SeenState, now: Date, windowDays: number): CatalogModel[] {
  const nowIso = now.toISOString();
  return models.map((m) => {
    const key = idKey(m.id);
    const firstSeenAt = state.seen[key] ?? nowIso;
    const isNew = isNewKey(state, key, now, windowDays);
    return m.firstSeenAt === firstSeenAt && m.isNew === isNew ? m : { ...m, firstSeenAt, isNew };
  });
}

/** Marks ids as acknowledged (badge cleared). */
export function acknowledge(state: SeenState, keys: string[]): SeenState {
  if (keys.length === 0) return state;
  const acknowledged = { ...state.acknowledged };
  for (const k of keys) acknowledged[k.toLowerCase()] = true;
  return { ...state, acknowledged };
}
