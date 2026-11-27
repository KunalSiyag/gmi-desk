/**
 * Catalog slice: the live GMI model catalog merged from public console feeds, the org's MCP catalog
 * (signed in) and the inference models API (key). Cached on disk for instant/offline startup,
 * refreshed in the background, with "New" badges from a first-seen diff and an OpenCode export.
 */
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthState } from '@shared/contracts/auth';
import type {
  CatalogApi,
  CatalogModel,
  CatalogSnapshot,
  CatalogSource,
  Leaderboard,
  LlmListSource,
  ModelDetail,
  OpenCodeExport,
  SourceStatus,
} from '@shared/contracts/catalog';
import { GmiError, toGmiError, type GmiErrorCode } from '@shared/contracts/errors';
import { normalizeParameters } from '@shared/lib/parameters';
import type { AppContext } from '../../core/context';
import { credentialRefused, type AuthService, type CatalogService, type KeyProvider, type McpGateway } from '../../core/services';
import { atomicWriteFile, openJsonStore, readJsonFile } from '../../core/store';
import { MOCK_NEW_MODEL_IDS } from '../../mock/catalog';
import { CACHE_VERSION, reviveCache, type CacheFile } from './cache';
import { mergeSources } from './merge';
import {
  normalizeFeatured,
  normalizeLeaderboard,
  normalizeMcpModel,
  normalizeMcpSearch,
  normalizeModelsApi,
  normalizePublicMedia,
  normalizePublicPrices,
} from './normalize';
import { buildOpenCodeConfig, OPENCODE_ENV_VAR, OPENCODE_FILE_NAME, openCodeEligible, openCodeInstructions } from './opencode';
import { acknowledge, applySeen, EMPTY_SEEN, normalizeSeen, recordObserved, type SeenState } from './seen';
import { nextRefreshDelayMs } from './schedule';
import { createHttpFetchers, createMockFetchers, type CatalogFetchers } from './sources';
import { idKey } from './text';
import type { PublicDetail, RawMcpModel, SourceResult } from './types';

export interface CatalogSlice {
  service: CatalogService;
  api: CatalogApi;
  /** Starts background refresh (called after the window exists). */
  start(): void;
  /**
   * Re-checks the refresh schedule against the wall clock. Call it when the computer resumes from sleep or the
   * screen unlocks (Electron powerMonitor 'resume' / 'unlock-screen'): Node timers do not advance while asleep.
   */
  wake(): void;
  dispose(): void | Promise<void>;
}

export interface CatalogDeps {
  auth: AuthService;
  mcp: McpGateway;
  keys: KeyProvider;
}

const DETAIL_TTL_MS = 10 * 60_000;
const MCP_TIMEOUT_MS = 30_000;
const AUTH_REFRESH_DEBOUNCE_MS = 400;
const DAY_MS = 86_400_000;
/**
 * Longest single timer wait. Timers stop while the computer sleeps, so a long wait is split into short ones
 * that re-check the wall clock: a refresh that came due during sleep runs within this long after waking.
 */
export const SCHEDULE_CHECK_MS = 5 * 60_000;
/** Context windows remembered for the OpenCode export (a bound, far above GMI's catalog size). */
const MAX_REMEMBERED_CONTEXTS = 2_000;

/** Errors that mean "this credential's data must not be used" (as opposed to a transient failure). */
const CREDENTIAL_ERRORS: ReadonlySet<GmiErrorCode> = new Set([
  'not_signed_in',
  'reauth_required',
  'insufficient_scope',
  'invalid_api_key',
  'unauthorized',
]);
const CREDENTIAL_SOURCES: ReadonlySet<CatalogSource> = new Set(['mcp', 'models_api']);

function keyFingerprint(state: AuthState): string | null {
  const k = state.inferenceKey;
  if (!k || k.status === 'missing') return null;
  return `${k.source ?? ''}:${k.keyId ?? ''}:${k.last4 ?? ''}`;
}

/**
 * Why a source answered but its result must not replace the previous one, or null when it can. A feed that
 * suddenly lists nothing (an error envelope served with 200, a changed response shape) is treated as a failure.
 */
function unusableResult(result: SourceResult, previous: SourceResult | undefined): string | null {
  if (!previous) return null;
  if (result.patches.length === 0 && previous.patches.length > 0) return 'GMI returned an unrecognised response with no models';
  if (result.llmIds !== undefined && result.llmIds.length === 0 && (previous.llmIds?.length ?? 0) > 0) return 'GMI returned an empty LLM list';
  return null;
}

export async function createCatalogSlice(ctx: AppContext, deps: CatalogDeps): Promise<CatalogSlice> {
  const log = ctx.log.child('catalog');
  const fetchers: CatalogFetchers = ctx.mock ? createMockFetchers() : createHttpFetchers(ctx.http);
  const cachePath = join(ctx.paths.data, 'catalog-cache.json');
  const detailsPath = join(ctx.paths.data, 'catalog-details.json');
  const seenStore = await openJsonStore<SeenState>(join(ctx.paths.data, 'catalog-seen.json'), EMPTY_SEEN, {
    log,
    normalize: (raw) => normalizeSeen(raw),
  });

  const windowDays = () => ctx.settings.get().newModelWindowDays;

  let models: CatalogModel[] = [];
  let duplicates: CatalogModel[] = [];
  let updatedAt: string | null = null;
  let sources: Partial<Record<CatalogSource, SourceStatus>> = {};
  let llmListSource: LlmListSource | null = null;
  let leaderboard: Leaderboard | null = null;
  let lastGood: CacheFile['lastGood'] = {};
  /** The last LLM list an authoritative source vouched for; survives sign-out (filters the public fallback). */
  let knownLlmIds: string[] = [];
  /** Lower-case LLM id → context window from MCP / the models API; survives sign-out (OpenCode export). */
  const contextLengths = new Map<string, number>();

  // A cache that cannot be read never stops the app from starting: it is moved aside and the catalog starts empty.
  try {
    const raw = await readJsonFile<unknown>(cachePath);
    const revived = raw === null ? null : reviveCache(raw);
    if (raw !== null && !revived) log.info('ignoring catalog cache from another version');
    if (revived) {
      const { cache, dropped } = revived;
      if (dropped > 0) log.warn(`ignored ${dropped} unusable entries in the catalog cache`);
      const seen = seenStore.get();
      const now = ctx.now();
      models = applySeen(cache.snapshot.models, seen, now, windowDays());
      duplicates = applySeen(cache.duplicates, seen, now, windowDays());
      updatedAt = cache.snapshot.updatedAt;
      sources = cache.snapshot.sources;
      llmListSource = cache.snapshot.llmListSource ?? null;
      leaderboard = cache.leaderboard;
      lastGood = cache.lastGood;
      knownLlmIds = cache.knownLlmIds ?? [];
      for (const [id, n] of Object.entries(cache.contextLengths ?? {})) contextLengths.set(id, n);
    }
  } catch (error) {
    models = [];
    duplicates = [];
    updatedAt = null;
    sources = {};
    llmListSource = null;
    leaderboard = null;
    lastGood = {};
    knownLlmIds = [];
    contextLengths.clear();
    const aside = `${cachePath}.corrupt-${ctx.now().getTime()}`;
    log.warn(`catalog cache unreadable; moved to ${aside}, starting empty`, error);
    await rename(cachePath, aside).catch(() => undefined);
  }

  let refreshing = false;
  let inflight: Promise<CatalogSnapshot> | null = null;
  let rerunRequested = false;
  let failureStreak = 0;
  let started = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Wall-clock time (ms) the next scheduled refresh is due. */
  let dueAt: number | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribers: Array<() => void> = [];
  let publicDetails: Map<string, PublicDetail> | null = null;
  const detailCache = new Map<string, { at: number; detail: ModelDetail }>();

  function applySeenNow(): void {
    const state = seenStore.get();
    const now = ctx.now();
    models = applySeen(models, state, now, windowDays());
    duplicates = applySeen(duplicates, state, now, windowDays());
  }

  const snapshot = (): CatalogSnapshot => ({ models, updatedAt, sources, refreshing, llmListSource });

  function emitUpdate(newModelIds: string[] = []): void {
    ctx.events.emit('catalog:updated', {
      updatedAt: updatedAt ?? ctx.now().toISOString(),
      total: models.length,
      newModelIds,
    });
  }

  function findModel(id: string): CatalogModel | null {
    const key = idKey(id);
    return models.find((m) => idKey(m.id) === key) ?? duplicates.find((m) => idKey(m.id) === key) ?? null;
  }

  async function writeCache(): Promise<void> {
    const file: CacheFile = {
      version: CACHE_VERSION,
      snapshot: { models, updatedAt, sources, refreshing: false, llmListSource },
      duplicates,
      leaderboard,
      lastGood,
      knownLlmIds,
      contextLengths: Object.fromEntries(contextLengths),
    };
    try {
      await atomicWriteFile(cachePath, JSON.stringify(file));
    } catch (error) {
      log.warn('could not write the catalog cache', error);
    }
  }

  async function loadPublicDetails(): Promise<Map<string, PublicDetail>> {
    if (publicDetails) return publicDetails;
    const map = new Map<string, PublicDetail>();
    try {
      const raw = await readJsonFile<Record<string, unknown>>(detailsPath);
      if (raw && typeof raw === 'object') {
        for (const [id, d] of Object.entries(raw)) {
          if (!d || typeof d !== 'object') continue;
          const { parameters, longDescription } = d as Partial<PublicDetail>;
          map.set(idKey(id), { parameters: parameters ?? null, longDescription: typeof longDescription === 'string' ? longDescription : null });
        }
      }
    } catch (error) {
      log.warn('catalog details unreadable', error);
    }
    publicDetails = map;
    return map;
  }

  async function saveDetails(details: Record<string, PublicDetail>): Promise<void> {
    publicDetails = new Map(Object.entries(details).map(([id, d]) => [idKey(id), d]));
    try {
      await atomicWriteFile(detailsPath, JSON.stringify(details));
    } catch (error) {
      log.warn('could not write catalog details', error);
    }
  }

  async function fetchMcp(): Promise<SourceResult> {
    const opts = { timeoutMs: MCP_TIMEOUT_MS };
    const queries: Array<Record<string, unknown>> = [
      { kind: 'llm', limit: 100 },
      { kind: 'multimodal', modality: 'image', limit: 100 },
      { kind: 'multimodal', modality: 'video', limit: 100 },
      { kind: 'multimodal', modality: 'audio', limit: 100 },
      { kind: 'multimodal', limit: 100 },
    ];
    const settled = await Promise.allSettled(queries.map((args) => deps.mcp.callTool('search_models', args, opts)));
    const [llm, ...multimodal] = settled;
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failures.length === settled.length) throw failures[0]?.reason ?? new GmiError('upstream', 'MCP search_models failed.');
    const result = normalizeMcpSearch({
      llm: llm?.status === 'fulfilled' ? llm.value : undefined,
      multimodal: multimodal.filter((s): s is PromiseFulfilledResult<unknown> => s.status === 'fulfilled').map((s) => s.value),
    });
    if (failures.length === 0) return result;
    log.warn(`${failures.length} of ${settled.length} MCP catalog queries failed`, toGmiError(failures[0]?.reason).message);
    // Fill the parts that failed from the last good MCP result, so a partial outage does not drop the org's
    // LLM list (or a modality) from the catalog.
    const previous = lastGood.mcp?.result;
    if (!previous) return result;
    const llmFailed = llm?.status !== 'fulfilled';
    const mediaFailed = multimodal.some((s) => s.status === 'rejected');
    const have = new Set(result.patches.map((p) => idKey(p.id)));
    const carried = previous.patches.filter((p) => !have.has(idKey(p.id)) && (p.kind === 'llm' ? llmFailed : mediaFailed));
    return {
      ...result,
      patches: [...result.patches, ...carried],
      ...(llmFailed && previous.llmIds ? { llmIds: previous.llmIds } : {}),
    };
  }

  /** Context windows are not org data: remember them for exports made after signing out. */
  function rememberContext(used: Partial<Record<CatalogSource, SourceResult>>): void {
    for (const source of ['models_api', 'mcp'] as const) {
      for (const p of used[source]?.patches ?? []) {
        if (p.kind !== 'llm' || !p.contextLength || p.contextLength <= 0) continue;
        const key = idKey(p.id);
        contextLengths.delete(key);
        contextLengths.set(key, p.contextLength);
      }
    }
    for (const key of contextLengths.keys()) {
      if (contextLengths.size <= MAX_REMEMBERED_CONTEXTS) break;
      contextLengths.delete(key);
    }
  }

  /**
   * One refresh pass. `newIds`: visible models that are new since the last refresh. `succeeded`: a source was
   * fetched now and the catalog was rebuilt (false offline, or when nothing usable came back).
   */
  async function runRefresh(): Promise<{ newIds: string[]; succeeded: boolean }> {
    const now = ctx.now();
    const nowIso = now.toISOString();
    const authState = deps.auth.getState();
    const signedIn = deps.auth.isSignedIn();
    let key: string | null = null;
    try {
      key = await deps.keys.getInferenceKey();
    } catch (error) {
      log.warn('could not read the inference key', toGmiError(error).message);
    }
    const keyRejected = authState.inferenceKey?.status === 'invalid';

    // Side outputs of the public jobs (kept in an object: TS does not track assignments made in closures).
    const extra: { details: Record<string, PublicDetail> | null; leaderboard: Leaderboard | null } = { details: null, leaderboard: null };
    const jobs: Array<{ source: CatalogSource; run: () => Promise<SourceResult> }> = [
      { source: 'public_prices', run: async () => normalizePublicPrices(await fetchers.publicPrices()) },
      {
        source: 'public_media',
        run: async () => {
          const result = normalizePublicMedia(await fetchers.publicMedia());
          extra.details = result.details;
          return { patches: result.patches, hidden: result.hidden, count: result.count };
        },
      },
      { source: 'featured', run: async () => normalizeFeatured(await fetchers.featured()) },
      {
        source: 'leaderboard',
        run: async () => {
          const result = normalizeLeaderboard(await fetchers.leaderboard(), nowIso);
          extra.leaderboard = result.leaderboard;
          return { patches: result.patches, hidden: result.hidden, count: result.count };
        },
      },
    ];
    if (signedIn) jobs.push({ source: 'mcp', run: fetchMcp });
    if (key && !keyRejected) {
      const k = key;
      jobs.push({ source: 'models_api', run: async () => normalizeModelsApi(await fetchers.modelsApi(k)) });
    }

    const settled = await Promise.allSettled(jobs.map((job) => job.run()));
    const used: Partial<Record<CatalogSource, SourceResult>> = {};
    const nextSources: Partial<Record<CatalogSource, SourceStatus>> = {};
    const fresh: CatalogSource[] = [];

    jobs.forEach((job, i) => {
      const outcome = settled[i];
      if (!outcome) return;
      if (outcome.status === 'fulfilled') {
        const previous = lastGood[job.source];
        const unusable = unusableResult(outcome.value, previous?.result);
        if (!unusable || !previous) {
          used[job.source] = outcome.value;
          lastGood[job.source] = { fetchedAt: nowIso, result: outcome.value };
          fresh.push(job.source);
          nextSources[job.source] = { ok: true, fetchedAt: nowIso, count: outcome.value.patches.length, error: null, state: 'ok' };
          return;
        }
        log.warn(`catalog source ${job.source}: ${unusable}; keeping the previous result`);
        used[job.source] = previous.result;
        nextSources[job.source] = { ok: false, fetchedAt: previous.fetchedAt, count: previous.result.patches.length, error: unusable, state: 'stale' };
        return;
      }
      const error = toGmiError(outcome.reason);
      log.warn(`catalog source ${job.source} failed: ${error.code} ${error.message}`);
      if (job.source === 'models_api' && credentialRefused(error)) {
        void deps.keys.reportInvalidKey(error.message, key, error.status).catch(() => undefined);
      }
      const credentialProblem = CREDENTIAL_SOURCES.has(job.source) && CREDENTIAL_ERRORS.has(error.code);
      if (credentialProblem) delete lastGood[job.source];
      const previous = lastGood[job.source];
      if (previous && !credentialProblem) {
        used[job.source] = previous.result;
        nextSources[job.source] = {
          ok: false,
          fetchedAt: previous.fetchedAt,
          count: previous.result.patches.length,
          error: error.message,
          state: 'stale',
        };
      } else {
        nextSources[job.source] = { ok: false, fetchedAt: null, count: 0, error: error.message, state: 'error' };
      }
    });
    if (!signedIn) {
      nextSources.mcp = { ok: false, fetchedAt: null, count: 0, error: 'Not signed in', state: 'skipped' };
      // Org-specific data (discounts, availability) is dropped when the user signs out.
      if (authState.status === 'signed_out') delete lastGood.mcp;
    }
    if (!key || keyRejected) {
      nextSources.models_api = {
        ok: false,
        fetchedAt: null,
        count: 0,
        error: keyRejected ? 'API key rejected' : 'No inference API key',
        state: keyRejected ? 'error' : 'skipped',
      };
      delete lastGood.models_api;
    }

    sources = nextSources;
    // Side outputs only from sources whose new result was accepted (an unrecognised feed must not wipe them).
    if (extra.leaderboard && fresh.includes('leaderboard')) leaderboard = extra.leaderboard;
    if (extra.details && fresh.includes('public_media')) await saveDetails(extra.details);

    if (Object.keys(used).length === 0) {
      // Nothing to merge (offline on first launch, or every source failed with nothing cached).
      await writeCache();
      return { newIds: [], succeeded: false };
    }
    const merged = mergeSources(used, { knownLlmIds });
    if (merged.models.length === 0) {
      // Never replace the catalog (or initialise first-seen tracking) with nothing.
      log.warn(models.length > 0 ? 'catalog refresh produced no models; keeping the previous catalog' : 'catalog refresh produced no models');
      await writeCache();
      return { newIds: [], succeeded: false };
    }

    const before = seenStore.get();
    const recorded = recordObserved(before, merged.observed, fresh, now);
    const nextSeen = recorded.state;
    const newKeys = new Set(recorded.newKeys);
    if (ctx.mock && !before.initialized) {
      // Demo data: make a few models look recently added.
      MOCK_NEW_MODEL_IDS.forEach((id, i) => {
        const k = idKey(id);
        if (!merged.observed.has(k)) return;
        nextSeen.seen[k] = new Date(now.getTime() - (i + 1) * DAY_MS).toISOString();
        newKeys.add(k);
      });
    }
    void seenStore.set(nextSeen);

    models = applySeen(merged.models, nextSeen, now, windowDays());
    duplicates = applySeen(merged.duplicates, nextSeen, now, windowDays());
    llmListSource = merged.llmListSource;
    if (merged.llmListSource !== 'public') {
      const authority = merged.llmListSource === 'models_api' ? used.models_api?.llmIds : used.mcp?.llmIds;
      if (authority?.length) knownLlmIds = [...authority];
    }
    rememberContext(used);
    // Only a refresh that fetched something is an update: rebuilding from cached copies while offline must not
    // make the catalog look fresh (start() would then skip the refresh on the next launch).
    if (fresh.length > 0) updatedAt = nowIso;
    detailCache.clear();
    await writeCache();

    const fresher = models.filter((m) => newKeys.has(idKey(m.id)) && m.isNew);
    notifyNew(fresher);
    return { newIds: fresher.map((m) => m.id), succeeded: fresh.length > 0 };
  }

  function notifyNew(newModels: CatalogModel[]): void {
    const first = newModels[0];
    if (!first || !ctx.settings.get().notifyNewModels) return;
    const more = newModels.length - 1;
    ctx.platform.notify({
      title: 'New on GMI',
      body: more > 0 ? `${first.name} and ${more} more` : `${first.name} is now available`,
      onClick: () => ctx.events.emit('app:navigate', { page: 'models', params: { filter: 'new' } }),
    });
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** Next scheduled refresh: the configured interval after the last update, or a backoff while refreshes fail. */
  function scheduleNext(): void {
    clearTimer();
    dueAt = null;
    if (!started || disposed) return;
    const now = ctx.now();
    const delay = nextRefreshDelayMs({ intervalHours: ctx.settings.get().catalogRefreshHours, updatedAt, failureStreak, now });
    dueAt = now.getTime() + delay;
    armTimer();
  }

  /** Waits for `dueAt` in steps of at most SCHEDULE_CHECK_MS, comparing against the wall clock each time. */
  function armTimer(): void {
    clearTimer();
    if (dueAt === null || !started || disposed) return;
    const remaining = dueAt - ctx.now().getTime();
    if (remaining <= 0) {
      dueAt = null;
      void refresh();
      return;
    }
    timer = setTimeout(armTimer, Math.min(remaining, SCHEDULE_CHECK_MS));
    timer.unref?.();
  }

  function refresh(): Promise<CatalogSnapshot> {
    if (inflight) return inflight;
    const run = (async () => {
      refreshing = true;
      emitUpdate();
      let newIds: string[] = [];
      let succeeded = false;
      try {
        ({ newIds, succeeded } = await runRefresh());
      } catch (error) {
        log.error('catalog refresh failed', error);
      } finally {
        refreshing = false;
      }
      // Offline, or nothing usable came back: retry with backoff instead of waiting a full interval or hammering GMI.
      failureStreak = succeeded ? 0 : failureStreak + 1;
      emitUpdate(newIds);
      return snapshot();
    })();
    inflight = run;
    void run.finally(() => {
      if (inflight === run) inflight = null;
      if (disposed) return;
      scheduleNext();
      if (rerunRequested) {
        rerunRequested = false;
        void refresh();
      }
    });
    return run;
  }

  /** Refresh soon; coalesces bursts (auth state changes arrive in quick succession). */
  function requestRefresh(): void {
    if (disposed) return;
    if (authTimer) clearTimeout(authTimer);
    authTimer = setTimeout(() => {
      authTimer = null;
      if (inflight) rerunRequested = true;
      else void refresh();
    }, AUTH_REFRESH_DEBOUNCE_MS);
    authTimer.unref?.();
  }

  async function getModel(id: unknown): Promise<ModelDetail> {
    if (typeof id !== 'string' || !id.trim() || id.length > 300) throw new GmiError('invalid_input', 'A model id is required.');
    const key = idKey(id);
    const cached = detailCache.get(key);
    if (cached && ctx.now().getTime() - cached.at < DETAIL_TTL_MS) return cached.detail;

    const base = findModel(id);
    let entry: RawMcpModel | null = null;
    // LLM entries from get_model carry nothing search_models did not (GMI publishes no LLM parameters).
    if (deps.auth.isSignedIn() && base?.kind !== 'llm') {
      try {
        entry = await deps.mcp.callTool<RawMcpModel>('get_model', { model_id: base?.id ?? id.trim() }, { timeoutMs: MCP_TIMEOUT_MS });
      } catch (error) {
        const e = toGmiError(error);
        log.debug(`get_model ${id} failed: ${e.code} ${e.message}`);
        if (!base && e.code !== 'not_found' && e.code !== 'invalid_input') throw e;
      }
    }
    const patch = entry ? normalizeMcpModel(entry) : null;
    let model = base;
    if (!model && patch) {
      const merged = mergeSources({ mcp: { patches: [patch], hidden: [], count: 1, ...(patch.kind === 'llm' ? { llmIds: [patch.id] } : {}) } });
      model = applySeen(merged.models, seenStore.get(), ctx.now(), windowDays())[0] ?? null;
    }
    if (!model) throw new GmiError('not_found', `${id} is not in the GMI catalog.`);
    // get_model can carry the org's discount for media models (search results do not).
    if (patch?.discount && patch.discount !== model.discount) model = { ...model, discount: patch.discount };

    const details = await loadPublicDetails();
    const pub = details.get(key) ?? null;
    const parameters = model.kind === 'llm' ? null : (normalizeParameters(entry?.parameters) ?? normalizeParameters(pub?.parameters) ?? null);
    const detail: ModelDetail = { ...model, parameters, longDescription: pub?.longDescription ?? null };
    detailCache.set(key, { at: ctx.now().getTime(), detail });
    return detail;
  }

  async function getLeaderboard(): Promise<Leaderboard> {
    if (leaderboard) return leaderboard;
    const result = normalizeLeaderboard(await fetchers.leaderboard(), ctx.now().toISOString());
    leaderboard = result.leaderboard;
    return leaderboard;
  }

  async function acknowledgeNew(ids?: unknown): Promise<void> {
    let keys: string[];
    if (ids === undefined || ids === null) keys = models.filter((m) => m.isNew).map((m) => idKey(m.id));
    else if (Array.isArray(ids) && ids.length <= 10_000 && ids.every((i) => typeof i === 'string' && i.length <= 300)) {
      keys = (ids as string[]).map(idKey);
    } else throw new GmiError('invalid_input', 'Expected a list of model ids.');
    if (keys.length === 0) return;
    await seenStore.set(acknowledge(seenStore.get(), keys));
    applySeenNow();
    detailCache.clear();
    emitUpdate([]);
  }

  async function exportOpenCode(): Promise<OpenCodeExport> {
    const { config, count, estimated } = buildOpenCodeConfig(models, { knownContext: contextLengths });
    if (count === 0) {
      throw new GmiError('not_found', 'There are no chat models in the catalog yet. Refresh the catalog and try again.');
    }
    const configPath = join(ctx.paths.exports, OPENCODE_FILE_NAME);
    await atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const eligible = openCodeEligible(models);
    const example = eligible.find((m) => m.featured) ?? eligible[0] ?? null;
    return {
      configPath,
      modelCount: count,
      envVar: OPENCODE_ENV_VAR,
      instructions: openCodeInstructions({
        configPath,
        count,
        exampleModel: example?.id ?? null,
        platform: process.platform,
        now: ctx.now(),
        orgPrices: deps.auth.isSignedIn(),
        estimatedLimits: estimated,
      }),
    };
  }

  const service: CatalogService = {
    getSnapshot: async () => snapshot(),
    findModel: async (id: string) => (typeof id === 'string' ? findModel(id) : null),
  };

  const api: CatalogApi = {
    getSnapshot: async () => snapshot(),
    refresh: () => refresh(),
    getModel: (id: string) => getModel(id),
    getLeaderboard: () => getLeaderboard(),
    acknowledgeNew: (ids?: string[]) => acknowledgeNew(ids),
    exportOpenCode: () => exportOpenCode(),
  };

  return {
    service,
    api,
    start() {
      if (started || disposed) return;
      started = true;
      let prevSignedIn = deps.auth.isSignedIn();
      let prevKey = keyFingerprint(deps.auth.getState());
      unsubscribers.push(
        deps.auth.onChange((state) => {
          const signedIn = state.status === 'signed_in';
          const fingerprint = keyFingerprint(state);
          const changed = signedIn !== prevSignedIn || fingerprint !== prevKey;
          prevSignedIn = signedIn;
          prevKey = fingerprint;
          if (changed) requestRefresh();
        }),
        ctx.settings.onChange((next, previous) => {
          if (next.catalogRefreshHours !== previous.catalogRefreshHours) scheduleNext();
          if (next.newModelWindowDays !== previous.newModelWindowDays) {
            applySeenNow();
            detailCache.clear();
            emitUpdate([]);
          }
        }),
      );
      const hours = ctx.settings.get().catalogRefreshHours;
      const age = updatedAt ? ctx.now().getTime() - Date.parse(updatedAt) : Number.POSITIVE_INFINITY;
      // A credential gained since the cache was written also warrants an immediate refresh.
      const gainedSignIn = prevSignedIn && sources.mcp?.state === 'skipped';
      const gainedKey = prevKey !== null && sources.models_api?.state === 'skipped';
      if (models.length === 0 || !(age < hours * 3_600_000) || gainedSignIn || gainedKey) void refresh();
      else scheduleNext();
    },
    wake() {
      // A refresh in flight reschedules itself when it ends.
      if (!started || disposed || inflight) return;
      scheduleNext();
    },
    async dispose() {
      disposed = true;
      clearTimer();
      dueAt = null;
      if (authTimer) clearTimeout(authTimer);
      authTimer = null;
      for (const off of unsubscribers.splice(0)) off();
      await seenStore.flush();
    },
  };
}
