import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import featuredFixture from '@main/mock/fixtures/catalog/public-featured.json';
import leaderboardFixture from '@main/mock/fixtures/catalog/public-leaderboard.json';
import pricesFixture from '@main/mock/fixtures/catalog/public-model-prices.json';
import mediaFixture from '@main/mock/fixtures/catalog/public-requestqueue-models.json';
import { mockGetModel, mockModelsApiResponse, mockSearchModels } from '@main/mock/catalog';
import type { AuthService, GmiToolName, KeyProvider, McpGateway } from '@main/core/services';
import { createCatalogSlice, SCHEDULE_CHECK_MS, type CatalogSlice } from '@main/services/catalog';
import { MIN_DELAY_MS, RETRY_BASE_MS } from '@main/services/catalog/schedule';
import type { AuthState } from '@shared/contracts/auth';
import type { CatalogUpdate } from '@shared/contracts/catalog';
import { GmiError } from '@shared/contracts/errors';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch, jsonResponse } from '../helpers/fetch';

const URLS = {
  prices: 'console.gmicloud.ai/api/v1/billing/model_prices',
  media: 'console.gmicloud.ai/api/v1/ie/requestqueue/models',
  featured: 'console.gmicloud.ai/api/v1/ie/app/featured-models/active',
  leaderboard: 'console.gmicloud.ai/api/v1/ie/recommendation/leaderboard',
  modelsApi: 'api.gmi-serving.com/v1/models',
};

function authState(status: AuthState['status'], keyStatus: AuthState['inferenceKey']['status'] = 'missing'): AuthState {
  return {
    status,
    scopes: [],
    orgId: null,
    signedInAt: null,
    accessTokenExpiresAt: null,
    inferenceKey: {
      status: keyStatus,
      source: keyStatus === 'missing' ? null : 'keychain',
      last4: keyStatus === 'missing' ? null : 'abcd',
      keyId: null,
      scope: null,
      orgId: null,
      orgMatchesAccount: null,
      validatedAt: null,
      error: null,
    },
    secureStorage: 'os',
    lastError: null,
    mock: false,
  };
}

function fakeAuth(initial: AuthState) {
  let state = initial;
  const listeners = new Set<(s: AuthState) => void>();
  const service: AuthService = {
    getState: () => state,
    isSignedIn: () => state.status === 'signed_in',
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    service,
    set(next: AuthState) {
      state = next;
      for (const l of listeners) l(next);
    },
  };
}

function fakeKeys(key: string | null) {
  const reported: string[] = [];
  const keys: KeyProvider = {
    getInferenceKey: async () => key,
    requireInferenceKey: async () => {
      if (!key) throw new GmiError('no_api_key', 'no key');
      return key;
    },
    reportInvalidKey: async (reason) => {
      reported.push(reason);
    },
  };
  return { keys, reported };
}

function fakeMcp(handlers: Partial<Record<GmiToolName, (args: Record<string, unknown>) => unknown>> = {}) {
  const calls: Array<{ name: GmiToolName; args: Record<string, unknown> }> = [];
  const mcp: McpGateway = {
    async callTool<T>(name: GmiToolName, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const handler = handlers[name] ?? (name === 'search_models' ? mockSearchModels : name === 'get_model' ? mockGetModel : undefined);
      if (!handler) throw new GmiError('not_implemented', name);
      return (await handler(args)) as T;
    },
  };
  return { mcp, calls };
}

type Overrides = Partial<Record<keyof typeof URLS, () => Response | Promise<Response>>>;

function publicFetch(overrides: Overrides = {}) {
  const fixtures: Record<keyof typeof URLS, unknown> = {
    prices: pricesFixture,
    media: mediaFixture,
    featured: featuredFixture,
    leaderboard: leaderboardFixture,
    modelsApi: mockModelsApiResponse(),
  };
  const fake = createFakeFetch();
  for (const [name, url] of Object.entries(URLS) as Array<[keyof typeof URLS, string]>) {
    fake.route({ match: url, respond: () => (overrides[name] ? overrides[name]!() : jsonResponse(fixtures[name])) });
  }
  return fake;
}

const updates = (t: TestContext) => t.emitted.filter((e) => e.name === 'catalog:updated').map((e) => e.payload as CatalogUpdate);
const count = (fake: ReturnType<typeof createFakeFetch>, url: string) => fake.requests.filter((r) => r.url.includes(url)).length;

let t: TestContext | null = null;
let slices: CatalogSlice[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of slices) await s.dispose();
  slices = [];
  await t?.cleanup();
  t = null;
});

async function setup(opts: { overrides?: Overrides; auth?: AuthState; key?: string | null; mcp?: ReturnType<typeof fakeMcp>; now?: () => Date; mock?: boolean } = {}) {
  const fake = publicFetch(opts.overrides);
  t = await createTestContext({ fetch: fake.fetch, now: opts.now, mock: opts.mock });
  const auth = fakeAuth(opts.auth ?? authState('signed_in'));
  const keys = fakeKeys(opts.key === undefined ? null : opts.key);
  const mcp = opts.mcp ?? fakeMcp();
  const slice = await createCatalogSlice(t.ctx, { auth: auth.service, mcp: mcp.mcp, keys: keys.keys });
  slices.push(slice);
  return { t, fake, auth, keys, mcp, slice };
}

describe('catalog slice', () => {
  it('refreshes every source, merges, emits updates and persists the cache', async () => {
    const { t, fake, slice, mcp } = await setup();
    expect((await slice.api.getSnapshot()).models).toEqual([]);
    const snap = await slice.api.refresh();
    expect(snap.refreshing).toBe(false);
    expect(snap.llmListSource).toBe('mcp');
    expect(snap.models.filter((m) => m.kind === 'llm').length).toBeGreaterThan(80);
    expect(snap.models.some((m) => m.kind === 'workflow')).toBe(true);
    expect(snap.sources.mcp).toMatchObject({ ok: true, state: 'ok' });
    expect(snap.sources.public_media).toMatchObject({ ok: true, state: 'ok' });
    expect(snap.sources.models_api).toMatchObject({ ok: false, state: 'skipped' });
    // Public feeds go through ctx.http (GMI-Desk User-Agent), no key involved.
    const req = fake.requests.find((r) => r.url.includes(URLS.media));
    expect(req?.headers['user-agent']).toBe('GMI-Desk/test');
    expect(req?.headers.authorization).toBeUndefined();
    expect(mcp.calls.filter((c) => c.name === 'search_models').map((c) => c.args)).toContainEqual({ kind: 'llm', limit: 100 });

    // One update when the refresh starts, one when it ends.
    const ups = updates(t);
    expect(ups).toHaveLength(2);
    expect(ups[1]).toMatchObject({ total: snap.models.length, newModelIds: [] });

    const cache = JSON.parse(await readFile(join(t.ctx.paths.data, 'catalog-cache.json'), 'utf8'));
    expect(cache.snapshot.models).toHaveLength(snap.models.length);
    const seen = JSON.parse(await readFile(join(t.ctx.paths.data, 'catalog-seen.json'), 'utf8'));
    expect(seen.initialized).toBe(true);
    // First refresh ever: nothing is announced.
    expect(t.platform.notifications).toEqual([]);
  });

  it('is single-flight', async () => {
    const { fake, slice } = await setup();
    const [a, b] = await Promise.all([slice.api.refresh(), slice.api.refresh()]);
    expect(a).toEqual(b);
    expect(count(fake, URLS.media)).toBe(1);
    expect(count(fake, URLS.prices)).toBe(1);
  });

  it('marks the snapshot as refreshing while a refresh runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { slice } = await setup({ overrides: { media: async () => (await gate, jsonResponse(mediaFixture)) } });
    const pending = slice.api.refresh();
    await new Promise((r) => setTimeout(r, 20));
    expect((await slice.api.getSnapshot()).refreshing).toBe(true);
    release();
    expect((await pending).refreshing).toBe(false);
  });

  it('tolerates a failing source and reuses its last good result', async () => {
    let failMedia = false;
    const { slice } = await setup({ overrides: { featured: () => new Response('nope', { status: 404 }), media: () => (failMedia ? new Response('down', { status: 404 }) : jsonResponse(mediaFixture)) } });
    const first = await slice.api.refresh();
    expect(first.sources.featured).toMatchObject({ ok: false, state: 'error', count: 0 });
    expect(first.models.length).toBeGreaterThan(100);
    const mediaCount = first.models.filter((m) => m.sources.includes('public_media')).length;

    failMedia = true;
    const second = await slice.api.refresh();
    expect(second.sources.public_media).toMatchObject({ ok: false, state: 'stale' });
    expect(second.sources.public_media?.fetchedAt).toBe(first.sources.public_media?.fetchedAt);
    expect(second.models.filter((m) => m.sources.includes('public_media')).length).toBe(mediaCount);
  });

  it('keeps the previous catalog when every source fails', async () => {
    let down = false;
    const fail = () => new Response('x', { status: 404 });
    const pass = (body: unknown) => () => (down ? fail() : jsonResponse(body));
    const { slice } = await setup({
      auth: authState('signed_out'),
      overrides: { prices: pass(pricesFixture), media: pass(mediaFixture), featured: pass(featuredFixture), leaderboard: pass(leaderboardFixture) },
    });
    const first = await slice.api.refresh();
    down = true;
    // Simulate a fresh process: the slice reuses lastGood from disk too.
    const second = await slice.api.refresh();
    expect(second.models.length).toBe(first.models.length);
    expect(Object.values(second.sources).filter((s) => s?.state === 'stale').length).toBe(4);
  });

  it('uses the models API as the LLM list and reports a rejected key', async () => {
    const withKey = await setup({ key: 'k-123' });
    const snap = await withKey.slice.api.refresh();
    expect(snap.llmListSource).toBe('models_api');
    const req = withKey.fake.requests.find((r) => r.url.includes(URLS.modelsApi));
    expect(req?.headers.authorization).toBe('Bearer k-123');
    await withKey.slice.dispose();
    await withKey.t.cleanup();
    slices = [];

    const rejected = await setup({ key: 'k-bad', overrides: { modelsApi: () => new Response('{"error":"bad key"}', { status: 401 }) } });
    const snap2 = await rejected.slice.api.refresh();
    expect(snap2.sources.models_api).toMatchObject({ ok: false, state: 'error' });
    expect(snap2.llmListSource).toBe('mcp');
    expect(rejected.keys.reported).toHaveLength(1);
  });

  it('falls back to public feeds when signed out', async () => {
    const { slice, mcp } = await setup({ auth: authState('signed_out') });
    const snap = await slice.api.refresh();
    expect(mcp.calls).toEqual([]);
    expect(snap.sources.mcp).toMatchObject({ state: 'skipped', error: 'Not signed in' });
    expect(snap.llmListSource).toBe('public');
    expect(snap.models.filter((m) => m.kind === 'llm').length).toBeGreaterThan(10);
  });

  it('flags models added after the first refresh and notifies', async () => {
    let featured: unknown[] = (featuredFixture as unknown[]).slice(0, 5);
    let now = new Date('2026-10-31T12:00:00.000Z');
    const { t, slice } = await setup({ auth: authState('signed_out'), now: () => now, overrides: { featured: () => jsonResponse(featured) } });
    await slice.api.refresh();
    expect(t.platform.notifications).toEqual([]);

    now = new Date('2026-11-01T12:00:00.000Z');
    featured = featuredFixture as unknown[];
    const snap = await slice.api.refresh();
    const fresh = snap.models.filter((m) => m.isNew);
    // gpt-6.1-sol is featured-only in the public view (not on the leaderboard).
    expect(fresh.map((m) => m.id)).toContain('openai/gpt-6.1-sol');
    const last = updates(t).at(-1);
    expect(last?.newModelIds).toEqual(expect.arrayContaining(['openai/gpt-6.1-sol']));
    // Ids added since the last refresh are dated now; ids seeded on the first refresh keep GMI's creation date
    // (gemini-nano-banana-2.1 was created three weeks earlier, so it is New from the start but never announced).
    for (const id of last?.newModelIds ?? []) expect(snap.models.find((m) => m.id === id)?.firstSeenAt).toBe(now.toISOString());
    const seeded = snap.models.find((m) => m.id === 'gemini-nano-banana-2.1');
    expect(seeded).toMatchObject({ isNew: true, firstSeenAt: seeded?.createdAt });
    expect(last?.newModelIds).not.toContain('gemini-nano-banana-2.1');
    expect(t.platform.notifications).toHaveLength(1);
    expect(t.platform.notifications[0]?.title).toBe('New on GMI');

    // Acknowledge clears the badge, then a later window change cannot bring it back.
    await slice.api.acknowledgeNew(['openai/gpt-6.1-sol']);
    expect((await slice.api.getSnapshot()).models.find((m) => m.id === 'openai/gpt-6.1-sol')?.isNew).toBe(false);
    await slice.api.acknowledgeNew();
    expect((await slice.api.getSnapshot()).models.some((m) => m.isNew)).toBe(false);
    await expect(slice.api.acknowledgeNew('nope' as unknown as string[])).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('does not notify when the setting is off', async () => {
    let featured: unknown[] = (featuredFixture as unknown[]).slice(0, 5);
    const { t, slice } = await setup({ auth: authState('signed_out'), overrides: { featured: () => jsonResponse(featured) } });
    await t.ctx.settings.update({ notifyNewModels: false });
    await slice.api.refresh();
    featured = featuredFixture as unknown[];
    await slice.api.refresh();
    expect(t.platform.notifications).toEqual([]);
  });

  it('loads the cached snapshot instantly on the next start', async () => {
    const { t, slice, auth, mcp } = await setup();
    const first = await slice.api.refresh();
    const again = await createCatalogSlice(t.ctx, { auth: auth.service, mcp: mcp.mcp, keys: fakeKeys(null).keys });
    slices.push(again);
    const cached = await again.api.getSnapshot();
    expect(cached.models).toHaveLength(first.models.length);
    expect(cached.updatedAt).toBe(first.updatedAt);
    expect(await again.service.findModel('ZAI-ORG/glm-5.3')).toMatchObject({ id: 'zai-org/GLM-5.3' });
    expect(await again.service.findModel('nope')).toBeNull();
    // Fresh cache: start() schedules instead of refreshing.
    const before = t.emitted.length;
    again.start();
    expect(t.emitted.length).toBe(before);
  });

  it('refreshes when the user signs in or adds a key', async () => {
    const { auth, slice, fake } = await setup({ auth: authState('signed_out') });
    await slice.api.refresh();
    slice.start();
    const before = count(fake, URLS.media);
    auth.set(authState('signing_in'));
    auth.set(authState('signed_in'));
    await new Promise((r) => setTimeout(r, 700));
    expect(count(fake, URLS.media)).toBe(before + 1);
    auth.set(authState('signed_in', 'valid'));
    await new Promise((r) => setTimeout(r, 700));
    expect(count(fake, URLS.media)).toBe(before + 2);
  });

  it('serves model details from MCP when signed in and from the public catalog otherwise', async () => {
    const { slice, mcp } = await setup();
    await slice.api.refresh();
    const video = await slice.api.getModel('seedance-2-5-260628');
    expect(video.parameters?.map((p) => p.name)).toContain('reference_videos');
    expect(video.longDescription).toContain('Seedance');
    expect(mcp.calls.some((c) => c.name === 'get_model' && c.args.model_id === 'seedance-2-5-260628')).toBe(true);
    // Cached for a while.
    await slice.api.getModel('seedance-2-5-260628');
    expect(mcp.calls.filter((c) => c.name === 'get_model')).toHaveLength(1);

    const llm = await slice.api.getModel('zai-org/GLM-5.3');
    expect(llm.parameters).toBeNull();
    await expect(slice.api.getModel('does-not-exist')).rejects.toMatchObject({ code: 'not_found' });
    await expect(slice.api.getModel('' as string)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('falls back to public parameters when MCP is unavailable', async () => {
    const failing = fakeMcp({ get_model: () => Promise.reject(new GmiError('upstream', 'MCP down')) });
    const { slice } = await setup({ mcp: failing });
    await slice.api.refresh();
    const heygen = await slice.api.getModel('heygen-avatar-4');
    expect(heygen.parameters?.find((p) => p.name === 'avatar_style')?.enumLabels).toEqual({ normal: 'Normal', circle: 'Circle', closeUp: 'Close Up' });
  });

  it('serves the leaderboard from the last refresh', async () => {
    const { slice, fake } = await setup();
    await slice.api.refresh();
    const board = await slice.api.getLeaderboard();
    expect(board.entries.length).toBeGreaterThan(10);
    expect(board.categories.length).toBeGreaterThan(3);
    expect(count(fake, URLS.leaderboard)).toBe(1);
  });

  it('exports an OpenCode config with chat models only', async () => {
    const { t, slice } = await setup();
    await expect(slice.api.exportOpenCode()).rejects.toMatchObject({ code: 'not_found' });
    const snap = await slice.api.refresh();
    const result = await slice.api.exportOpenCode();
    expect(result.configPath).toBe(join(t.ctx.paths.exports, 'opencode-gmi.json'));
    expect(result.envVar).toBe('GMI_API_KEY');
    expect(result.instructions).toContain(result.configPath);
    const written = JSON.parse(await readFile(result.configPath, 'utf8'));
    const models = written.provider.gmi.models as Record<string, { cost?: { input: number } }>;
    const chat = snap.models.filter((m) => m.kind === 'llm' && m.api === 'chat' && m.available);
    expect(Object.keys(models)).toHaveLength(chat.length);
    expect(result.modelCount).toBe(chat.length);
    expect(models['openai/gpt-5.4-pro']).toBeUndefined();
    expect(models['zai-org/GLM-5.3']?.cost?.input).toBe(0.7);
  });

  it('runs fully offline in mock mode with a few models marked new', async () => {
    const fake = createFakeFetch();
    t = await createTestContext({ fetch: fake.fetch, mock: true });
    const { createMockMcp } = await import('@main/mock/mcp');
    const slice = await createCatalogSlice(t.ctx, { auth: fakeAuth(authState('signed_in', 'valid')).service, mcp: createMockMcp({ latencyMs: 0 }), keys: fakeKeys('mock-key').keys });
    slices.push(slice);
    const snap = await slice.api.refresh();
    expect(fake.requests).toEqual([]);
    expect(snap.llmListSource).toBe('models_api');
    const fresh = snap.models.filter((m) => m.isNew).map((m) => m.id);
    expect(fresh).toEqual(expect.arrayContaining(['deepseek-ai/deepseek-v4.1-flash-1017', 'google/gemini-3.8-flash', 'gpt-image-2.5-flare-generate']));
    expect(t.platform.notifications).toHaveLength(1);
    expect(t.platform.notifications[0]?.body).toMatch(/and \d+ more$/);
  });
});

describe('refresh schedule', () => {
  it('waits for the interval after a good refresh and backs off while offline', async () => {
    const { nextRefreshDelayMs, RETRY_BASE_MS, MIN_DELAY_MS } = await import('@main/services/catalog/schedule');
    const now = new Date('2026-11-01T12:00:00.000Z');
    const hour = 3_600_000;
    expect(nextRefreshDelayMs({ intervalHours: 6, updatedAt: '2026-11-01T11:00:00.000Z', failureStreak: 0, now })).toBe(5 * hour);
    // Overdue (or never updated): soon, but not in a tight loop.
    expect(nextRefreshDelayMs({ intervalHours: 6, updatedAt: '2026-10-30T00:00:00.000Z', failureStreak: 0, now })).toBe(MIN_DELAY_MS);
    expect(nextRefreshDelayMs({ intervalHours: 6, updatedAt: null, failureStreak: 0, now })).toBe(MIN_DELAY_MS);
    // Every source failing: 1 min, 2 min, 4 min... capped at the interval.
    expect([1, 2, 3].map((n) => nextRefreshDelayMs({ intervalHours: 6, updatedAt: null, failureStreak: n, now }))).toEqual([
      RETRY_BASE_MS,
      2 * RETRY_BASE_MS,
      4 * RETRY_BASE_MS,
    ]);
    expect(nextRefreshDelayMs({ intervalHours: 1, updatedAt: null, failureStreak: 20, now })).toBe(hour);
  });
});

describe('partial MCP outages', () => {
  it('keeps the org LLM list when only the LLM query fails', async () => {
    let failLlm = false;
    const mcp = fakeMcp({
      search_models: (args) => {
        if (failLlm && args.kind === 'llm') throw new GmiError('upstream', 'LLM catalog down');
        return mockSearchModels(args);
      },
    });
    const { slice } = await setup({ mcp });
    const first = await slice.api.refresh();
    const llms = first.models.filter((m) => m.kind === 'llm').map((m) => m.id);
    failLlm = true;
    const second = await slice.api.refresh();
    expect(second.sources.mcp).toMatchObject({ ok: true, state: 'ok' });
    expect(second.llmListSource).toBe('mcp');
    expect(second.models.filter((m) => m.kind === 'llm').map((m) => m.id)).toEqual(llms);
  });
});

/**
 * Polls until `check` passes or 5 s (real time) have gone by. setImmediate and performance.now are never faked
 * below, so this works with fake timers too and lets file I/O and HTTP retries finish in between.
 */
async function until(check: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!check() && performance.now() < deadline) await new Promise((r) => setImmediate(r));
  return check();
}

/** Records the delays the slice schedules (timers of 20 s and more; HTTP retry backoffs are shorter). */
function recordScheduledDelays(): number[] {
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    // Delays come from wall-clock arithmetic, so a loaded machine can shave a millisecond: record whole seconds.
    if ((ms ?? 0) >= 20_000) delays.push(Math.round((ms ?? 0) / 1000) * 1000);
    return real(fn, ms);
  }) as typeof setTimeout);
  return delays;
}

const llmIds = (snap: { models: Array<{ kind: string; id: string }> }) => snap.models.filter((m) => m.kind === 'llm').map((m) => m.id);

describe('republished workflows', () => {
  type Row = Record<string, unknown>;
  const rows = (mediaFixture as unknown as { models: Row[] }).models;
  const kiss = rows.find((r) => r.model === 'db433271-841d-4fab-ae5e-454fd446cfa4')!;

  it('are not announced as new models, while a new workflow still is', async () => {
    let now = new Date('2026-11-01T12:00:00.000Z');
    let media: unknown = mediaFixture;
    const { t, slice } = await setup({ auth: authState('signed_out'), now: () => now, overrides: { media: () => jsonResponse(media) } });
    await slice.api.refresh();

    // GMI Studio republishes "Kiss" (published in February) under a new id, and publishes a new workflow.
    now = new Date('2026-11-02T12:00:00.000Z');
    const created = Math.floor(now.getTime() / 1000);
    const republished = { ...kiss, model: '3db6f208-1710-4c3d-8e11-000000000002', created_at: created };
    const brandNew = { ...kiss, model: '3db6f208-1710-4c3d-8e11-000000000003', brief_description: 'Published Workflow - Neon Portrait', display_name: 'Neon Portrait', created_at: created };
    media = { ...(mediaFixture as object), models: [...rows, republished, brandNew] };
    const snap = await slice.api.refresh();

    const visible = snap.models.filter((m) => m.kind === 'workflow' && m.name === 'Kiss');
    expect(visible.map((m) => m.id)).toEqual([republished.model]);
    expect(visible[0]).toMatchObject({ isNew: false });
    expect(Date.parse(visible[0]!.firstSeenAt)).toBeLessThan(Date.parse('2026-03-01'));
    expect(snap.models.find((m) => m.id === brandNew.model)).toMatchObject({ name: 'Neon Portrait', isNew: true });
    expect(updates(t).at(-1)?.newModelIds).toEqual([brandNew.model]);
    expect(t.platform.notifications.map((n) => n.body)).toEqual(['Neon Portrait is now available']);
  });
});

describe('Inworld TTS prices', () => {
  it('are listed per 1K characters', async () => {
    const { slice } = await setup();
    const snap = await slice.api.refresh();
    expect(snap.models.find((m) => m.id === 'inworld-tts-2-flash')?.mediaPricing).toMatchObject({ usdPerUnit: 0.015, unit: '1K characters' });
    expect(snap.models.find((m) => m.id === 'inworld-tts-2')?.mediaPricing).toMatchObject({ usdPerUnit: 0.025, unit: '1K characters' });
  });
});

describe('key-only catalog (inference key, not signed in)', () => {
  it('does not make a model free from a 100%-off public row', async () => {
    const { slice } = await setup({ auth: authState('signed_out', 'valid'), key: 'k-1' });
    const snap = await slice.api.refresh();
    expect(snap.llmListSource).toBe('models_api');
    const ling = snap.models.find((m) => m.id === 'inclusionAI/Ling-3.0-flash-fin');
    expect(ling?.llmPricing).toMatchObject({ inputPerMTok: 0.06, outputPerMTok: 0.18 });
    expect(ling?.discount ?? 0).toBeLessThan(1);
    expect(snap.models.find((m) => m.id === 'zai-org/GLM-5.3')?.discount).toBe(0.5);
    // The export prices it too.
    const written = JSON.parse(await readFile((await slice.api.exportOpenCode()).configPath, 'utf8'));
    expect(written.provider.gmi.models['inclusionAI/Ling-3.0-flash-fin'].cost).toMatchObject({ input: 0.06, output: 0.18 });
  });
});

describe('what the catalog remembers after signing out', () => {
  const nemotron = 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16';

  it('keeps context windows for the OpenCode export, across restarts', async () => {
    // Fresh install with only a key: no context windows anywhere, so limits are capped estimates.
    const keyOnly = authState('signed_out', 'valid');
    const { t, slice, auth, mcp } = await setup({ auth: keyOnly, key: 'k-1' });
    await slice.api.refresh();
    let result = await slice.api.exportOpenCode();
    let written = JSON.parse(await readFile(result.configPath, 'utf8'));
    expect(written.provider.gmi.models[nemotron].limit.context).toBeLessThanOrEqual(128_000);
    expect(result.instructions).toContain('estimates');

    // Signing in once brings MCP's context windows...
    auth.set(authState('signed_in', 'valid'));
    await slice.api.refresh();
    // ...which survive signing out and a restart.
    auth.set(keyOnly);
    await slice.api.refresh();
    const again = await createCatalogSlice(t.ctx, { auth: auth.service, mcp: mcp.mcp, keys: fakeKeys('k-1').keys });
    slices.push(again);
    result = await again.api.exportOpenCode();
    written = JSON.parse(await readFile(result.configPath, 'utf8'));
    expect(written.provider.gmi.models[nemotron].limit.context).toBe(32_768);
    expect(written.provider.gmi.models['zai-org/GLM-5.3'].limit.context).toBe(1_048_576);
    expect(result.instructions).not.toContain('estimates');
  });

  it('hides leaderboard-only LLMs the org catalog did not list, and exports none of them', async () => {
    const { slice, auth } = await setup({ auth: authState('signed_out') });
    // Never signed in: best effort, the leaderboard's Claude models are listed.
    expect(llmIds(await slice.api.refresh()).some((id) => id.startsWith('anthropic/'))).toBe(true);

    auth.set(authState('signed_in'));
    const signedIn = await slice.api.refresh();
    expect(llmIds(signedIn).some((id) => id.startsWith('anthropic/'))).toBe(false);

    auth.set(authState('signed_out'));
    const signedOut = await slice.api.refresh();
    expect(signedOut.llmListSource).toBe('public');
    expect(llmIds(signedOut).length).toBeGreaterThan(5);
    expect(llmIds(signedOut).some((id) => id.startsWith('anthropic/'))).toBe(false);
    const written = JSON.parse(await readFile((await slice.api.exportOpenCode()).configPath, 'utf8'));
    expect(Object.keys(written.provider.gmi.models).some((id) => id.startsWith('anthropic/'))).toBe(false);
  });
});

describe('empty answers from GMI', () => {
  it('keep the org LLM list when search_models answers with no LLMs', async () => {
    let broken = false;
    const mcp = fakeMcp({ search_models: (args) => (broken && args.kind === 'llm' ? 'Service temporarily unavailable' : mockSearchModels(args)) });
    const { slice } = await setup({ mcp });
    const first = await slice.api.refresh();
    broken = true;
    const second = await slice.api.refresh();
    expect(llmIds(second)).toEqual(llmIds(first));
    expect(second.llmListSource).toBe('mcp');
    expect(second.sources.mcp).toMatchObject({ ok: false, state: 'stale', error: 'GMI returned an empty LLM list' });
  });

  it('keep the LLM list when the models API answers with an empty list', async () => {
    let broken = false;
    const { slice } = await setup({ key: 'k-1', overrides: { modelsApi: () => jsonResponse(broken ? { object: 'list', data: [] } : mockModelsApiResponse()) } });
    const first = await slice.api.refresh();
    broken = true;
    const second = await slice.api.refresh();
    expect(second.llmListSource).toBe('models_api');
    expect(llmIds(second)).toEqual(llmIds(first));
    expect(second.sources.models_api).toMatchObject({ state: 'stale' });
    // The empty answer did not replace the remembered good one.
    broken = false;
    expect((await slice.api.refresh()).sources.models_api).toMatchObject({ state: 'ok' });
  });

  it('back off instead of refetching every 30 s, and never count as an update', async () => {
    let broken = false;
    let now = new Date('2026-10-20T08:00:00Z');
    const envelope = { code: 503, message: 'maintenance' };
    const feed = (body: unknown) => () => jsonResponse(broken ? envelope : body);
    const overrides = { prices: feed(pricesFixture), media: feed(mediaFixture), featured: feed(featuredFixture), leaderboard: feed(leaderboardFixture) };
    const { t, slice, auth, mcp } = await setup({ auth: authState('signed_out'), now: () => now, overrides });
    const first = await slice.api.refresh();
    const board = await slice.api.getLeaderboard();
    await slice.dispose();

    // Next morning every feed answers 200 with an error envelope.
    now = new Date('2026-10-21T09:00:00Z');
    broken = true;
    const delays = recordScheduledDelays();
    const again = await createCatalogSlice(t.ctx, { auth: auth.service, mcp: mcp.mcp, keys: fakeKeys(null).keys });
    slices.push(again);
    again.start(); // the cache is 25 h old: refreshes now
    for (let i = 0; i < 3; i += 1) {
      await until(() => delays.length > i);
      await again.api.refresh();
    }
    await until(() => delays.length >= 4);
    const snap = await again.api.getSnapshot();
    expect(delays.slice(0, 4)).toEqual([RETRY_BASE_MS, 2 * RETRY_BASE_MS, 4 * RETRY_BASE_MS, Math.min(8 * RETRY_BASE_MS, SCHEDULE_CHECK_MS)]);
    expect(Math.min(...delays)).toBeGreaterThan(MIN_DELAY_MS);
    for (const s of ['public_prices', 'public_media', 'featured', 'leaderboard'] as const) {
      expect(snap.sources[s], s).toMatchObject({ ok: false, state: 'stale', error: 'GMI returned an unrecognised response with no models' });
    }
    expect(snap.updatedAt).toBe(first.updatedAt);
    expect(snap.models).toHaveLength(first.models.length);
    // The leaderboard and model details were not wiped by the unrecognised answers.
    expect((await again.api.getLeaderboard()).entries).toHaveLength(board.entries.length);
    expect((await again.api.getModel('seedance-2-5-260628')).longDescription).toContain('Seedance');
  });

  it('back off on a first launch where every feed answers but nothing merges', async () => {
    const envelope = () => jsonResponse({ code: 503, message: 'maintenance' });
    const { slice } = await setup({ auth: authState('signed_out'), overrides: { prices: envelope, media: envelope, featured: envelope, leaderboard: envelope } });
    const delays = recordScheduledDelays();
    slice.start(); // empty catalog: refreshes now
    await until(() => delays.length > 0);
    await slice.api.refresh();
    await until(() => delays.length > 1);
    const snap = await slice.api.getSnapshot();
    expect(snap.models).toEqual([]);
    expect(snap.sources.public_media).toMatchObject({ state: 'ok', count: 0 });
    expect(delays.slice(0, 2)).toEqual([RETRY_BASE_MS, 2 * RETRY_BASE_MS]);
  });

  it('never start first-seen tracking from an empty catalog (no "300 new models" later)', async () => {
    let broken = true;
    const feed = (body: unknown) => () => jsonResponse(broken ? { code: 503 } : body);
    const { t, slice } = await setup({
      auth: authState('signed_out'),
      overrides: { prices: feed(pricesFixture), media: feed(mediaFixture), featured: feed(featuredFixture), leaderboard: feed(leaderboardFixture) },
    });
    const empty = await slice.api.refresh();
    expect(empty.models).toEqual([]);
    expect(empty.updatedAt).toBeNull();
    broken = false;
    const loaded = await slice.api.refresh();
    expect(loaded.models.length).toBeGreaterThan(50);
    expect(loaded.models.some((m) => m.isNew && m.firstSeenAt === loaded.updatedAt)).toBe(false);
    expect(updates(t).at(-1)?.newModelIds).toEqual([]);
    expect(t.platform.notifications).toEqual([]);
  });
});

describe('refreshing while offline', () => {
  it('does not mark the catalog fresh, so a restart refreshes, and retries in a minute meanwhile', async () => {
    let online = true;
    let now = new Date('2026-10-20T08:00:00Z');
    const feed = (body: unknown) => () => {
      if (!online) throw new TypeError('fetch failed (offline)');
      return jsonResponse(body);
    };
    const overrides = { prices: feed(pricesFixture), media: feed(mediaFixture), featured: feed(featuredFixture), leaderboard: feed(leaderboardFixture) };
    const { t, fake, slice, auth, mcp } = await setup({ auth: authState('signed_out'), now: () => now, overrides });
    const first = await slice.api.refresh();
    await slice.dispose();

    // Two days later the app starts before the network is up.
    now = new Date('2026-10-22T08:00:00Z');
    online = false;
    const delays = recordScheduledDelays();
    const offlineSlice = await createCatalogSlice(t.ctx, { auth: auth.service, mcp: mcp.mcp, keys: fakeKeys(null).keys });
    slices.push(offlineSlice);
    offlineSlice.start();
    await until(() => delays.length > 0);
    const offline = await offlineSlice.api.getSnapshot();
    expect(offline.updatedAt).toBe(first.updatedAt);
    expect(offline.models).toHaveLength(first.models.length);
    expect(delays[0]).toBe(RETRY_BASE_MS);
    await offlineSlice.dispose();
    vi.restoreAllMocks();

    // An hour later the network is back and the app is restarted: it refreshes right away.
    now = new Date('2026-10-22T09:00:00Z');
    online = true;
    const before = fake.requests.length;
    const restarted = await createCatalogSlice(t.ctx, { auth: auth.service, mcp: mcp.mcp, keys: fakeKeys(null).keys });
    slices.push(restarted);
    restarted.start();
    expect(await until(() => fake.requests.length > before)).toBe(true);
    const snap = await restarted.api.refresh();
    expect(snap.updatedAt).toBe(now.toISOString());
  });
});

describe('a damaged catalog cache', () => {
  const write = (t: TestContext, body: string) => writeFile(join(t.ctx.paths.data, 'catalog-cache.json'), body);
  const asideFiles = async (t: TestContext) => (await readdir(t.ctx.paths.data)).filter((f) => f.startsWith('catalog-cache.json.corrupt-'));

  it('skips unusable entries instead of failing to start', async () => {
    const { t, slice, auth, mcp } = await setup();
    const good = await slice.api.refresh();
    const cachePath = join(t.ctx.paths.data, 'catalog-cache.json');
    const cache = JSON.parse(await readFile(cachePath, 'utf8'));
    cache.snapshot.models = [null, { name: 'x', kind: 'llm' }, { id: 'a/b', name: 'B', kind: 'nonsense' }, 42, ...cache.snapshot.models];
    cache.duplicates = [null, ...cache.duplicates];
    cache.lastGood.featured = { fetchedAt: 'nope', result: null };
    cache.lastGood.public_media.result.patches.unshift(null, { name: 'no id' });
    await write(t, JSON.stringify(cache));

    const again = await createCatalogSlice(t.ctx, { auth: auth.service, mcp: mcp.mcp, keys: fakeKeys(null).keys });
    slices.push(again);
    const snap = await again.api.getSnapshot();
    expect(snap.models).toEqual(good.models);
    expect(await again.service.findModel('zai-org/GLM-5.3')).toMatchObject({ id: 'zai-org/GLM-5.3' });
    // The remaining last-good copies still serve an offline refresh.
    expect((await again.api.refresh()).models.length).toBe(good.models.length);
  });

  it.each([
    ['a null entry', JSON.stringify({ version: 1, snapshot: { models: [null], updatedAt: null, sources: {}, refreshing: false }, duplicates: [], leaderboard: null, lastGood: {} })],
    ['an entry without an id', JSON.stringify({ version: 1, snapshot: { models: [{ name: 'x', kind: 'llm' }], updatedAt: null, sources: {}, refreshing: false }, duplicates: [], leaderboard: null, lastGood: {} })],
    ['wrongly typed fields', JSON.stringify({ version: 1, snapshot: { models: [{ id: 'a/b', name: 'B', kind: 'llm', tags: 'x', leaderboard: { overall: 'high' }, llmPricing: { tiers: 3 } }], updatedAt: 5, sources: [], refreshing: true }, duplicates: {}, leaderboard: { entries: 'x' }, lastGood: [] })],
  ])('starts with %s', async (_label, body) => {
    t = await createTestContext();
    await write(t, body);
    const slice = await createCatalogSlice(t.ctx, { auth: fakeAuth(authState('signed_out')).service, mcp: fakeMcp().mcp, keys: fakeKeys(null).keys });
    slices.push(slice);
    const snap = await slice.api.getSnapshot();
    for (const m of snap.models) {
      expect(Array.isArray(m.tags)).toBe(true);
      expect(m.leaderboard === null || typeof m.leaderboard.overall !== 'string').toBe(true);
    }
    expect(snap.models.every((m) => typeof m.id === 'string')).toBe(true);
    expect(snap.updatedAt).toBeNull();
  });

  it('moves a file that is not a catalog cache aside and starts empty', async () => {
    for (const body of ['{"version":1,"snapshot":"nope"}', '{ truncated']) {
      t = await createTestContext();
      await write(t, body);
      const slice = await createCatalogSlice(t.ctx, { auth: fakeAuth(authState('signed_out')).service, mcp: fakeMcp().mcp, keys: fakeKeys(null).keys });
      slices.push(slice);
      expect((await slice.api.getSnapshot()).models).toEqual([]);
      expect(await asideFiles(t)).toHaveLength(1);
      await slice.dispose();
      slices = [];
      await t.cleanup();
      t = null;
    }
  });

  it('still ignores (and later overwrites) a cache from another version', async () => {
    t = await createTestContext();
    await write(t, JSON.stringify({ version: 99, whatever: true }));
    const slice = await createCatalogSlice(t.ctx, { auth: fakeAuth(authState('signed_out')).service, mcp: fakeMcp().mcp, keys: fakeKeys(null).keys });
    slices.push(slice);
    expect((await slice.api.getSnapshot()).models).toEqual([]);
    expect(await asideFiles(t)).toEqual([]);
  });
});

describe('refresh schedule across sleep', () => {
  const T0 = new Date('2026-11-01T20:00:00.000Z');

  async function startedWithFreshCatalog() {
    // Date is faked too, so the wall clock (ctx.now) moves with the fake timers; vi.setSystemTime() then moves
    // it without running timers, which is what a suspended laptop looks like to Node.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T0 });
    const ctx = await setup({ auth: authState('signed_out') });
    await ctx.slice.api.refresh();
    ctx.slice.start(); // fresh catalog: the next refresh is due in catalogRefreshHours (6 h)
    // Waits for the refresh the schedule started (refresh() joins a running one), so no file write outlives the test.
    const settle = () => ctx.slice.api.refresh();
    return { ...ctx, settle, media: () => count(ctx.fake, URLS.media) };
  }

  it('refreshes soon after waking when the refresh came due during sleep', async () => {
    const { media, settle } = await startedWithFreshCatalog();
    const before = media();
    vi.setSystemTime(new Date(T0.getTime() + 8 * 3_600_000)); // asleep overnight
    await vi.advanceTimersByTimeAsync(SCHEDULE_CHECK_MS);
    expect(await until(() => media() > before)).toBe(true);
    await settle();
  });

  it('does not refresh before the interval is up when nothing slept', async () => {
    const { media, settle } = await startedWithFreshCatalog();
    const before = media();
    await vi.advanceTimersByTimeAsync(5 * 3_600_000);
    expect(media()).toBe(before);
    await vi.advanceTimersByTimeAsync(3_600_000 + SCHEDULE_CHECK_MS);
    expect(await until(() => media() > before)).toBe(true);
    await settle();
  });

  it('wake() re-checks the schedule right away', async () => {
    const { media, slice, settle } = await startedWithFreshCatalog();
    const before = media();
    vi.setSystemTime(new Date(T0.getTime() + 8 * 3_600_000));
    await vi.advanceTimersByTimeAsync(MIN_DELAY_MS);
    expect(media()).toBe(before);
    slice.wake();
    await vi.advanceTimersByTimeAsync(MIN_DELAY_MS);
    expect(await until(() => media() > before)).toBe(true);
    await settle();
  });
});
