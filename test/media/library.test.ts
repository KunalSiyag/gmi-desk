import { existsSync } from 'node:fs';
import { mkdir, readdir, truncate as truncateFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { MediaJob } from '@shared/contracts/media';
import { isInsideDir } from '@main/core/media-paths';
import { createMediaSlice, type MediaSlice } from '@main/services/media';
import { openJobsStore } from '@main/services/media/jobs-store';
import generations from '../../src/main/mock/fixtures/media/generations.json';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch, type RecordedRequest } from '../helpers/fetch';
import { createFakeAuth, createFakeBudget, createFakeCatalog, createFakeMcp, type FakeMcp, type ToolHandler } from './fakes';

let t: TestContext | null = null;
let slice: MediaSlice | null = null;

afterEach(async () => {
  await slice?.dispose();
  await t?.cleanup();
  slice = null;
  t = null;
});

function cdnFetch() {
  return createFakeFetch([
    { match: 'cdn.example', respond: () => new Response(new Uint8Array([137, 80, 78, 71, 1, 2]), { headers: { 'content-type': 'image/png' } }) },
    { match: 'storage.googleapis.com/gmi-placeholder-bucket', respond: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }) },
    { match: 'storage.googleapis.com/gmi-uploads/', method: 'PUT', respond: () => new Response(null, { status: 200 }) },
  ]);
}

async function setup(
  tools: Record<string, ToolHandler>,
  opts: { signedIn?: boolean; seed?: (dir: string) => Promise<void>; before?: (t: TestContext) => Promise<void> } = {},
) {
  const fake = cdnFetch();
  t = await createTestContext({ fetch: fake.fetch });
  await opts.seed?.(t.ctx.paths.data);
  await opts.before?.(t);
  const mcp: FakeMcp = createFakeMcp(tools);
  const auth = createFakeAuth(opts.signedIn ?? true);
  slice = await createMediaSlice(t.ctx, { auth, mcp, catalog: createFakeCatalog(), budget: createFakeBudget() }, { resumeDelayMs: 60_000 });
  return { t, slice, mcp, fake, auth };
}

const localJob = (id: string, createdAt: string, extra: Partial<MediaJob> = {}): MediaJob => ({
  id,
  modelId: 'seedream-5.0-pro',
  modality: 'image',
  status: 'success',
  prompt: 'local prompt',
  parameters: { size: '2K' },
  estimateUsd: 0.068,
  createdAt,
  updatedAt: createdAt,
  outputs: [{ url: `https://cdn.example/${id}.png`, kind: 'image', localPath: null, localUrl: null, mimeType: 'image/png' }],
  error: null,
  fromThisDevice: true,
  ...extra,
});

async function seedStore(dir: string, jobs: MediaJob[]) {
  const store = await openJobsStore(join(dir, 'media-jobs.json'));
  for (const job of jobs) store.upsert(job);
  await store.flush();
}

describe('listJobs', () => {
  it('merges local jobs with GMI history, newest first', async () => {
    const { slice, mcp } = await setup(
      { list_generations: () => generations.listGenerations },
      {
        seed: (dir) =>
          seedStore(dir, [
            localJob('local-new', '2026-10-31T09:00:00Z'),
            // Also listed by GMI: the local copy (with prompt and cost) wins.
            localJob('0a000000-0000-4000-8000-000000000002', '2026-10-30T10:10:20Z', { modelId: 'minimax-tts-speech-2.8-hd', modality: 'audio' }),
          ]),
      },
    );
    const res = await slice.api.listJobs({ limit: 10 });
    expect(res.jobs.map((j) => [j.id, j.fromThisDevice])).toEqual([
      ['local-new', true],
      ['0a000000-0000-4000-8000-000000000003', false],
      ['0a000000-0000-4000-8000-000000000002', true],
      ['0a000000-0000-4000-8000-000000000005', false],
      ['0a000000-0000-4000-8000-000000000001', false],
      ['0a000000-0000-4000-8000-000000000004', false],
    ]);
    expect(res.jobs[1]).toMatchObject({ modelId: 'minimax-music-3.0', modality: 'audio', status: 'success', prompt: null, outputs: [], estimateUsd: null });
    expect(res.jobs[2]?.prompt).toBe('local prompt');
    expect(res.total).toBe(676); // 675 remote + 1 local-only newer job
    expect(res.remoteError).toBeNull();
    expect(mcp.callsTo('list_generations')[0]).toEqual({ limit: 10, offset: 0 });
  });

  it('pages through history and passes the modality filter', async () => {
    const page = (offset: number, limit: number) => ({
      generations: Array.from({ length: limit }, (_, i) => ({
        request_id: `r${offset + i}`,
        model_id: 'm',
        modality: 'video',
        status: 'success',
        created_at: new Date(Date.UTC(2026, 9, 1) - (offset + i) * 60_000).toISOString(),
      })),
      offset,
      total: 250,
    });
    const { slice, mcp } = await setup({ list_generations: (a) => page(Number(a.offset), Number(a.limit)) });
    const res = await slice.api.listJobs({ limit: 30, offset: 120, modality: 'video' });
    expect(mcp.callsTo('list_generations')).toEqual([
      { limit: 100, offset: 0, modality: 'video' },
      { limit: 50, offset: 100, modality: 'video' },
    ]);
    expect(res.jobs.map((j) => j.id)).toEqual(Array.from({ length: 30 }, (_, i) => `r${120 + i}`));
    expect(res.total).toBe(250);
  });

  it('falls back to local jobs when GMI history is unavailable', async () => {
    const { slice } = await setup(
      {
        list_generations: () => {
          throw new GmiError('upstream', 'The generation service is currently unavailable');
        },
      },
      { seed: (dir) => seedStore(dir, [localJob('only-local', '2026-10-31T09:00:00Z')]) },
    );
    const res = await slice.api.listJobs();
    expect(res).toMatchObject({ total: 1, remoteError: 'The generation service is currently unavailable' });
    expect(res.jobs.map((j) => j.id)).toEqual(['only-local']);
  });

  it('shows local jobs without asking GMI when signed out', async () => {
    const { slice, mcp } = await setup({}, { signedIn: false, seed: (dir) => seedStore(dir, [localJob('a', '2026-10-31T09:00:00Z')]) });
    const res = await slice.api.listJobs();
    expect(res).toMatchObject({ total: 1, remoteError: null });
    expect(mcp.callsTo('list_generations')).toHaveLength(0);
  });
});

describe('getJob', () => {
  it('loads a history-only job from GMI and keeps it locally (not from this device)', async () => {
    const { slice, mcp } = await setup({
      list_generations: () => generations.listGenerations,
      get_generation: () => generations.getGeneration.musicSuccess,
    });
    await slice.api.listJobs();
    const job = await slice.api.getJob('0a000000-0000-4000-8000-000000000003');
    expect(job).toMatchObject({ fromThisDevice: false, status: 'success', modelId: 'minimax-music-3.0', modality: 'audio', createdAt: '2026-10-30T10:14:37.000Z' });
    expect(job.outputs).toEqual([
      { url: generations.getGeneration.musicSuccess.media[0]!.url, kind: 'audio', mimeType: 'audio/mpeg', localPath: null, localUrl: null, bytes: null },
    ]);
    // Finished and stored: no second round-trip.
    await slice.api.getJob(job.id);
    expect(mcp.callsTo('get_generation')).toHaveLength(1);
    // Jobs from other devices are not downloaded automatically.
    expect(existsSync(join(t!.ctx.paths.media, job.id))).toBe(false);
  });

  it('explains when GMI no longer has an old request', async () => {
    const { slice } = await setup({
      get_generation: () => {
        throw new GmiError('upstream', generations.getGeneration.notFoundError);
      },
    });
    await expect(slice.api.getJob('0a000000-0000-4000-8000-000000000004')).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('older requests expire'),
    });
    await expect(slice.api.getJob('../etc/passwd')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('serves the local copy when GMI cannot be reached', async () => {
    const { slice } = await setup(
      {
        get_generation: () => {
          throw new GmiError('network', 'offline');
        },
      },
      { seed: (dir) => seedStore(dir, [localJob('p1', new Date().toISOString(), { status: 'processing', outputs: [] })]) },
    );
    await expect(slice.api.getJob('p1')).resolves.toMatchObject({ id: 'p1', status: 'processing' });
  });
});

describe('saveOutput / revealOutput', () => {
  it('downloads into the media folder and reveals the file', async () => {
    const { slice, t, fake } = await setup({}, { seed: (dir) => seedStore(dir, [localJob('job-1', '2026-10-31T09:00:00Z')]) });
    const saved = await slice.api.saveOutput('job-1', 0);
    const out = saved.outputs[0]!;
    expect(out).toMatchObject({ localUrl: 'gmi-media://local/job-1/0.png', bytes: 6, mimeType: 'image/png' });
    expect(isInsideDir(t.ctx.paths.media, out.localPath!)).toBe(true);
    expect(existsSync(out.localPath!)).toBe(true);
    expect(t.emitted.some((e) => e.name === 'media:job' && (e.payload as MediaJob).outputs[0]?.localPath)).toBe(true);

    await slice.api.revealOutput('job-1', 0);
    expect(t.platform.revealed).toEqual([out.localPath]);
    // Already saved: no second download.
    await slice.api.saveOutput('job-1', 0);
    expect(fake.requests.filter((r: RecordedRequest) => r.url.includes('cdn.example'))).toHaveLength(1);

    await expect(slice.api.saveOutput('job-1', 5)).rejects.toMatchObject({ code: 'not_found' });
    await expect(slice.api.saveOutput('job-1', -1)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('auto-saves finished jobs only when the setting is on', async () => {
    const finished: ToolHandler = (args) => ({
      request_id: `r-${String(args.idempotency_nonce)}`,
      status: 'success',
      media: [{ type: 'image', url: `https://cdn.example/r-${String(args.idempotency_nonce)}.png` }],
    });
    const { slice, t } = await setup({ estimate_generation: () => ({ price_micro_usd: 1000 }), submit_generation: finished });
    const req = { modelId: 'seedream-5.0-pro', prompt: 'x', approvedUsd: 1 };
    await slice.api.submit({ ...req, nonce: 'on' });
    await expect.poll(() => existsSync(join(t.ctx.paths.media, 'r-on', '0.png'))).toBe(true);

    await t.ctx.settings.update({ saveMediaLocally: false });
    await slice.api.submit({ ...req, nonce: 'off' });
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(t.ctx.paths.media, 'r-off'))).toBe(false);
  });
});

describe('pickAndUpload', () => {
  // GMI signs upload slots for its Google Cloud Storage bucket (docs.gmicloud.ai: upload_url on storage.googleapis.com).
  const slot: ToolHandler = (args) => ({
    upload_url: `https://storage.googleapis.com/gmi-uploads/slot/abc.${String(args.file_type)}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=sig`,
    public_url: `https://storage.googleapis.com/gmi-uploads/slot/abc.${String(args.file_type)}`,
    content_type: args.file_type === 'png' ? 'image/png' : undefined,
    expires_in_seconds: 900,
  });

  it('uploads the picked file to the slot with the exact content type and no credentials', async () => {
    const { slice, t, fake, mcp } = await setup({ upload_media: slot });
    const file = join(t.dir, 'cat.png');
    await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    t.platform.nextPickedFile = file;
    const res = await slice.api.pickAndUpload('image');
    expect(res).toMatchObject({ publicUrl: 'https://storage.googleapis.com/gmi-uploads/slot/abc.png', fileName: 'cat.png', contentType: 'image/png', bytes: 8 });
    expect(res?.previewUrl).toMatch(/^gmi-media:\/\/local\/uploads\//);
    expect(mcp.callsTo('upload_media')).toEqual([{ file_type: 'png' }]);
    const put = fake.requests.find((r) => r.method === 'PUT')!;
    expect(put.url).toBe('https://storage.googleapis.com/gmi-uploads/slot/abc.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=sig');
    expect(put.headers['content-type']).toBe('image/png');
    expect(put.headers.authorization).toBeUndefined();
    expect(put.body).toBe('[binary]');
  });

  it('only PUTs the file to GMI storage: other hosts, intranet addresses and IP literals are refused before sending', async () => {
    const hostile = [
      'https://attacker.example/put/abc.png',
      'https://intranet.corp.example/upload',
      'https://10.0.0.5/put',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/put',
      'https://storage.googleapis.com.attacker.example/put',
    ];
    let next = 0;
    const { slice, t, fake } = await setup({
      upload_media: () => ({ upload_url: hostile[next++], public_url: 'https://storage.googleapis.com/gmi-uploads/x.png', content_type: 'image/png' }),
    });
    const file = join(t.dir, 'cat.png');
    await writeFile(file, Buffer.from([137, 80, 78, 71]));
    for (let i = 0; i < hostile.length; i += 1) {
      t.platform.nextPickedFile = file;
      await expect(slice.api.pickAndUpload('image')).rejects.toMatchObject({ code: 'upstream' });
    }
    expect(fake.requests.filter((r) => r.method === 'PUT')).toEqual([]);
  });

  it('falls back to the extension when the slot has no content type', async () => {
    const { slice, t, fake } = await setup({ upload_media: slot });
    const file = join(t.dir, 'voice.wav');
    await writeFile(file, Buffer.from('RIFF0000WAVE'));
    t.platform.nextPickedFile = file;
    const res = await slice.api.pickAndUpload('audio');
    expect(res).toMatchObject({ contentType: 'audio/wav', previewUrl: null });
    expect(fake.requests.find((r) => r.method === 'PUT')?.headers['content-type']).toBe('audio/wav');
  });

  it('returns null when the picker is cancelled', async () => {
    const { slice, mcp } = await setup({ upload_media: slot });
    await expect(slice.api.pickAndUpload('video')).resolves.toBeNull();
    expect(mcp.callsTo('upload_media')).toHaveLength(0);
  });

  it('refuses wrong types, oversized files, unknown kinds and signed-out users', async () => {
    const { slice, t, mcp, auth } = await setup({ upload_media: slot });
    const gif = join(t.dir, 'anim.gif');
    await writeFile(gif, 'GIF89a');
    t.platform.nextPickedFile = gif;
    await expect(slice.api.pickAndUpload('image')).rejects.toMatchObject({ code: 'invalid_input' });

    const huge = join(t.dir, 'huge.mp4');
    await writeFile(huge, '');
    await truncateFile(huge, 201 * 1024 * 1024); // sparse: no real disk use
    t.platform.nextPickedFile = huge;
    await expect(slice.api.pickAndUpload('video')).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('200.0 MB') });

    await expect(slice.api.pickAndUpload('pdf' as never)).rejects.toMatchObject({ code: 'invalid_input' });
    auth.setSignedIn(false);
    await expect(slice.api.pickAndUpload('image')).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(mcp.callsTo('upload_media')).toHaveLength(0);
  });
});

describe('temp files and quitting (partial downloads)', () => {
  it('sweeps partial downloads and temp files left by a crash when the slice starts (recent ones may be in use)', async () => {
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const files: Record<string, string> = {};
    await setup(
      {},
      {
        before: async (tc) => {
          const make = async (key: string, rel: string[], mtime: Date | null) => {
            const path = join(tc.ctx.paths.media, ...rel);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, 'partial bytes');
            if (mtime) await utimes(path, mtime, mtime);
            files[key] = path;
          };
          await make('stalePart', ['job-a', '0.mp4.part-1234-1'], hourAgo); // downloadToFile temp file
          await make('staleTmp', ['uploads', '2026-10-31-ab12cd34-cat.png.tmp-1234-7'], hourAgo); // atomicWriteFile temp file
          await make('recentPart', ['job-b', '0.png.part-4321-1'], null); // a download in progress elsewhere
          await make('saved', ['job-a', '0.png'], hourAgo);
          await make('lookalike', ['job-a', 'notes.part-x'], hourAgo);
        },
      },
    );
    await vi.waitFor(() => {
      expect(existsSync(files.stalePart!)).toBe(false);
      expect(existsSync(files.staleTmp!)).toBe(false);
    });
    expect(existsSync(files.recentPart!)).toBe(true);
    expect(existsSync(files.saved!)).toBe(true);
    expect(existsSync(files.lookalike!)).toBe(true);
  });

  it('aborts an in-flight download on dispose (quit) without leaving a partial file', async () => {
    let cancelled = false;
    const { slice: s, t: tc, fake } = await setup(
      {},
      {
        seed: (dir) =>
          seedStore(dir, [
            localJob('big-1', '2026-10-31T09:00:00Z', { outputs: [{ url: 'https://slow.example/v.mp4', kind: 'video', localPath: null, localUrl: null, mimeType: 'video/mp4' }] }),
          ]),
      },
    );
    // The body sends one chunk, then stalls until the download is aborted.
    fake.route({
      match: 'slow.example',
      respond: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'video/mp4' } },
        ),
    });
    const saving = s.api.saveOutput('big-1', 0).then(
      () => null,
      (error: unknown) => error,
    );
    const folder = join(tc.ctx.paths.media, 'big-1');
    await vi.waitFor(async () => expect((await readdir(folder).catch(() => [])).some((f) => /\.part-\d+-\d+$/.test(f))).toBe(true));
    slice = null;
    await s.dispose();
    expect(await saving).toMatchObject({ code: 'cancelled' });
    expect(cancelled).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  });

  it('aborts an upload PUT in flight on dispose (quit)', async () => {
    let putSignal: AbortSignal | null = null;
    const { slice: s, t: tc, fake } = await setup({
      upload_media: () => ({
        upload_url: 'https://storage.googleapis.com/gmi-slow-uploads/abc.png?X-Goog-Signature=sig',
        public_url: 'https://storage.googleapis.com/gmi-slow-uploads/abc.png',
        content_type: 'image/png',
      }),
    });
    // This PUT never answers on its own: only an abort ends it.
    fake.route({
      match: (url, init) => {
        if (!url.includes('/gmi-slow-uploads/')) return false;
        putSignal = init?.signal ?? null;
        return true;
      },
      method: 'PUT',
      respond: () =>
        new Promise<Response>((_resolve, reject) => {
          const signal = putSignal;
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail, { once: true });
        }),
    });
    const file = join(tc.dir, 'cat.png');
    await writeFile(file, Buffer.from([137, 80, 78, 71]));
    tc.platform.nextPickedFile = file;
    const uploading = s.api.pickAndUpload('image').then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(fake.requests.some((r) => r.method === 'PUT')).toBe(true));
    slice = null;
    await s.dispose();
    expect(await uploading).toMatchObject({ code: 'cancelled' });
  });
});
