import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { MediaJob } from '@shared/contracts/media';
import { createMediaSlice, type MediaSlice } from '@main/services/media';
import { openJobsStore } from '@main/services/media/jobs-store';
import { createPoller, type PollStopReason } from '@main/services/media/poller';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch } from '../helpers/fetch';
import { catalogModel, createFakeAuth, createFakeBudget, createFakeCatalog, createFakeMcp, estimateReturning, type FakeMcp } from './fakes';

const TIMERS = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const };

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...TIMERS.toFake] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(refresh: (id: string) => Promise<boolean>, extra: Partial<Parameters<typeof createPoller>[0]> = {}) {
    const stops: Array<[string, PollStopReason]> = [];
    const poller = createPoller({
      refresh,
      intervalMs: () => 1000,
      expired: () => false,
      onStop: (id, reason) => stops.push([id, reason]),
      maxBackoffMs: 8000,
      ...extra,
    });
    return { poller, stops };
  }

  it('polls at the interval until refresh reports a terminal state', async () => {
    let n = 0;
    const refresh = vi.fn(async () => ++n >= 3);
    const { poller, stops } = make(refresh);
    poller.start('a');
    expect(poller.isPolling('a')).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(stops).toEqual([['a', 'done']]);
    expect(poller.isPolling('a')).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially on errors (capped) and resets after a success', async () => {
    const times: number[] = [];
    let calls = 0;
    const refresh = vi.fn(async () => {
      times.push(Date.now());
      calls += 1;
      if (calls <= 4) throw new GmiError('upstream', 'boom');
      return calls >= 6;
    });
    const { poller } = make(refresh);
    const start = Date.now();
    poller.start('a');
    await vi.advanceTimersByTimeAsync(60_000);
    const gaps = times.map((t, i) => t - (i === 0 ? start : (times[i - 1] as number)));
    // 1s first poll; then 2s, 4s, 8s, 8s (cap) after failures 1-4; back to 1s after a success.
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 8000, 1000]);
  });

  it('stops when the error handler says so', async () => {
    const refresh = vi.fn(async () => {
      throw new GmiError('not_signed_in', 'sign in');
    });
    const { poller, stops } = make(refresh, { onError: () => 'stop' });
    poller.start('a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stops).toEqual([['a', 'error']]);
  });

  it('gives up on expired jobs without polling them', async () => {
    const refresh = vi.fn(async () => false);
    const { poller, stops } = make(refresh, { expired: () => true });
    poller.start('old');
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).not.toHaveBeenCalled();
    expect(stops).toEqual([['old', 'expired']]);
  });

  it('ignores duplicate starts, can poll sooner, and stops everything on dispose', async () => {
    const refresh = vi.fn(async (_id: string) => false);
    const { poller } = make(refresh);
    poller.start('a');
    poller.start('a');
    poller.start('b', { delayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh.mock.calls.map((c) => c[0])).toEqual(['b']);
    poller.start('a', { delayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(poller.active().sort()).toEqual(['a', 'b']);
    poller.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    poller.start('c');
    expect(poller.isPolling('c')).toBe(false);
  });
});

describe('media job polling (slice)', () => {
  let t: TestContext | null = null;
  let slice: MediaSlice | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...TIMERS.toFake] });
  });
  afterEach(async () => {
    await slice?.dispose();
    vi.useRealTimers();
    await t?.cleanup();
    slice = null;
    t = null;
  });

  const cdn = () =>
    createFakeFetch([{ match: 'cdn.example', respond: () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4' } }) }]);

  async function setup(mcp: FakeMcp, auth = createFakeAuth(true)) {
    t = await createTestContext({ fetch: cdn().fetch });
    const catalog = createFakeCatalog([catalogModel({ id: 'kling-3.0-turbo-t2v', kind: 'video' })]);
    slice = await createMediaSlice(t.ctx, { auth, mcp, catalog, budget: createFakeBudget({ needsConfirmation: false }) }, { resumeDelayMs: 1000 });
    return { t, slice };
  }

  const jobEvents = () => (t?.emitted ?? []).filter((e) => e.name === 'media:job').map((e) => e.payload as MediaJob);

  it('walks a video job from queued to success, then stops polling and saves the output', async () => {
    const states = [
      { request_id: 'v1', status: 'queued' },
      { request_id: 'v1', status: 'processing' },
      { request_id: 'v1', status: 'processing' },
      { request_id: 'v1', status: 'success', media: [{ type: 'video', mime_type: 'video/mp4', url: 'https://cdn.example/v1.mp4' }] },
    ];
    let i = 0;
    const mcp = createFakeMcp({
      estimate_generation: estimateReturning(560_000, 'second'),
      submit_generation: () => ({ request_id: 'v1', status: 'queued' }),
      get_generation: () => states[Math.min(i++, states.length - 1)],
    });
    const { slice } = await setup(mcp);
    const job = await slice.api.submit({ modelId: 'kling-3.0-turbo-t2v', prompt: 'fox', approvedUsd: 0.56 });
    expect(job.status).toBe('queued');
    expect(job.finishedAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(8000);
    expect(mcp.callsTo('get_generation')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8000);
    expect(jobEvents().at(-1)?.status).toBe('processing');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(mcp.callsTo('get_generation')).toHaveLength(4);

    await vi.waitFor(async () => {
      const done = await slice.api.getJob('v1');
      expect(done.status).toBe('success');
      expect(done.outputs[0]?.localUrl).toBe('gmi-media://local/v1/0.mp4');
      // The app watched it finish, so the gallery can mark it as just done.
      expect(done.finishedAt).toEqual(expect.any(String));
    });
    // One event per change: queued (submit), processing, success, saved copy.
    expect(jobEvents().map((j) => j.status)).toEqual(['queued', 'processing', 'success', 'success']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mcp.callsTo('get_generation')).toHaveLength(4);
    expect(t?.platform.notifications[0]).toMatchObject({ title: 'Video ready' });
  });

  it('backs off on errors and keeps going', async () => {
    let n = 0;
    const mcp = createFakeMcp({
      estimate_generation: estimateReturning(560_000, 'second'),
      submit_generation: () => ({ request_id: 'v2', status: 'processing' }),
      get_generation: () => {
        n += 1;
        if (n <= 2) throw new GmiError('upstream', 'GMI had a problem');
        return { request_id: 'v2', status: 'failed', failure_reason: 'Input should be 1080P, 720P or 480P' };
      },
    });
    const { slice } = await setup(mcp);
    await slice.api.submit({ modelId: 'kling-3.0-turbo-t2v', prompt: 'fox', approvedUsd: 1 });
    await vi.advanceTimersByTimeAsync(8000); // fail 1 → next in 16s
    await vi.advanceTimersByTimeAsync(16_000); // fail 2 → next in 32s
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(31_999);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(3);
    await vi.waitFor(async () => expect((await slice.api.getJob('v2')).status).toBe('failed'));
    expect((await slice.api.getJob('v2')).error).toBe('Input should be 1080P, 720P or 480P');
  });

  it('resumes unfinished jobs after a restart, and pauses while signed out', async () => {
    t = await createTestContext({ fetch: cdn().fetch });
    const store = await openJobsStore(`${t.ctx.paths.data}/media-jobs.json`);
    const now = new Date().toISOString();
    const base = { modelId: 'kling-3.0-turbo-t2v', modality: 'video' as const, prompt: 'p', parameters: {}, estimateUsd: 0.5, createdAt: now, updatedAt: now, outputs: [], error: null };
    await store.upsert({ ...base, id: 'mine', status: 'processing', fromThisDevice: true });
    await store.upsert({ ...base, id: 'theirs', status: 'processing', fromThisDevice: false });
    await store.upsert({ ...base, id: 'done', status: 'success', fromThisDevice: true });
    await store.flush();

    const auth = createFakeAuth(false);
    const mcp = createFakeMcp({ get_generation: (args) => ({ request_id: args.request_id, status: 'processing' }) });
    slice = await createMediaSlice(t.ctx, { auth, mcp, catalog: createFakeCatalog(), budget: createFakeBudget() }, { resumeDelayMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mcp.callsTo('get_generation')).toHaveLength(0); // signed out: polling paused

    auth.setSignedIn(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mcp.callsTo('get_generation').map((a) => a.request_id)).toEqual(['mine']);
    await vi.advanceTimersByTimeAsync(8000);
    expect(mcp.callsTo('get_generation').map((a) => a.request_id)).toEqual(['mine', 'mine']);
  });

  it('stops polling requests GMI no longer knows, and jobs older than two hours', async () => {
    t = await createTestContext({ fetch: cdn().fetch });
    const store = await openJobsStore(`${t.ctx.paths.data}/media-jobs.json`);
    const now = Date.now();
    const base = { modelId: 'kling-3.0-turbo-t2v', modality: 'video' as const, prompt: 'p', parameters: {}, estimateUsd: 0.5, outputs: [], error: null, fromThisDevice: true, status: 'processing' as const };
    await store.upsert({ ...base, id: 'gone', createdAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now).toISOString() });
    await store.upsert({ ...base, id: 'ancient', createdAt: new Date(now - 3 * 3600_000).toISOString(), updatedAt: new Date(now).toISOString() });
    await store.flush();
    const mcp = createFakeMcp({
      get_generation: (args) => {
        throw new GmiError('upstream', `no generation with request id "${String(args.request_id)}"`);
      },
    });
    slice = await createMediaSlice(t.ctx, { auth: createFakeAuth(true), mcp, catalog: createFakeCatalog(), budget: createFakeBudget() }, { resumeDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mcp.callsTo('get_generation').map((a) => a.request_id)).toEqual(['gone', 'gone', 'gone']);
    const jobs = (await slice.api.listJobs()).jobs;
    expect(jobs.find((j) => j.id === 'gone')).toMatchObject({ pollingStopped: true, error: 'GMI no longer has this request.' });
    expect(jobs.find((j) => j.id === 'ancient')).toMatchObject({ pollingStopped: true, status: 'processing' });
  });
});
