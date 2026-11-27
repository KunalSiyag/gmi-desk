import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { isPublicHttpsUrl } from '@shared/contracts/media';
import { isInsideDir } from '@main/core/media-paths';
import {
  downloadToFile,
  extractOutputs,
  jobFolderName,
  MAX_DOWNLOAD_REDIRECTS,
  outputFilePath,
  sameOutputUrl,
  STALE_TEMP_MS,
  sweepStaleTempFiles,
} from '@main/services/media/outputs';
import {
  mapJobStatus,
  parseDiscount,
  parseEstimate,
  parseGeneration,
  parseGenerationList,
  parseModel,
  parseUploadSlot,
  unwrapToolResult,
} from '@main/services/media/parse';
import estimates from '../../src/main/mock/fixtures/media/estimates.json';
import generations from '../../src/main/mock/fixtures/media/generations.json';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch } from '../helpers/fetch';
import { FIXTURE_MODELS } from './fakes';

const g = generations.getGeneration;

describe('parseEstimate', () => {
  it('reads every recorded estimate as a list price in USD', () => {
    const parsed = estimates.calls.map((c) => parseEstimate(c.result));
    expect(parsed.map((p) => p.listUsd)).toEqual([0.024, 0.56, 0.0116, 1, 0.085, 0.8, 0.15]);
    expect(parsed[1]).toMatchObject({ unit: 'second', note: expect.stringContaining('priced per second') });
    expect(parsed[2]?.unit).toBe('1k character');
  });

  it('tolerates other shapes', () => {
    expect(parseEstimate({ price_usd: '0.5' }).listUsd).toBe(0.5);
    expect(parseEstimate({ currency: 'micro_usd', price: 70000 }).listUsd).toBe(0.07);
    expect(parseEstimate(JSON.stringify({ price_micro_usd: 1000 })).listUsd).toBe(0.001);
    expect(parseEstimate({ content: [{ type: 'text', text: '{"price_micro_usd": 2000000}' }] }).listUsd).toBe(2);
    expect(parseEstimate('Estimated cost: $0.25 per image').listUsd).toBe(0.25);
    expect(parseEstimate(null)).toEqual({ listUsd: null, unit: null, note: null });
    expect(parseEstimate({ price_micro_usd: -5 }).listUsd).toBeNull();
  });
});

describe('parseModel', () => {
  it('reads modality, schema, unit price and discount', () => {
    const m = parseModel(FIXTURE_MODELS['kling-3.0-turbo-t2v'], 'x');
    expect(m).toMatchObject({ id: 'kling-3.0-turbo-t2v', modality: 'video', unitPriceUsd: 0.112, unit: 'second', discount: null, available: true });
    expect(m.parameters?.map((p) => p.name)).toEqual(['prompt', 'resolution', 'aspect_ratio', 'duration']);
    const wf = parseModel(FIXTURE_MODELS['80ce8515-e387-4050-883c-7a34e127fba8'], 'x');
    expect(wf).toMatchObject({ modality: 'workflow', parameters: null, unitPriceUsd: 1 });
    const discounted = parseModel({ ...FIXTURE_MODELS['seedream-5.0-pro'], discount_to_user: 0.4 }, 'x');
    expect(discounted.discount).toBe(0.4);
    const nested = parseModel({ model_id: 'm', multimodal: { model_type: 'image', pricing: { price: 1000, discount_to_user: 0.25 } } }, 'x');
    expect(nested.discount).toBe(0.25);
  });

  it('normalises discount units', () => {
    expect(parseDiscount(0.5)).toBe(0.5);
    expect(parseDiscount('20')).toBe(0.2);
    expect(parseDiscount(2000)).toBe(0.2);
    expect(parseDiscount(null)).toBeNull();
    expect(parseDiscount(-1)).toBeNull();
  });
});

describe('parseGeneration', () => {
  it('reads recorded success and failure results', () => {
    const image = parseGeneration(g.imageSuccess);
    expect(image).toMatchObject({ requestId: '0a000000-0000-4000-8000-000000000001', status: 'success', modelId: 'hy-image-v3.5-preview', error: null });
    expect(image.outputs).toEqual([{ url: g.imageSuccess.media[0]!.url, kind: 'image', mimeType: 'image/png' }]);
    expect(image.posterUrl).toBe(g.imageSuccess.poster);

    const music = parseGeneration(g.musicSuccess);
    expect(music.outputs).toEqual([{ url: g.musicSuccess.media[0]!.url, kind: 'audio', mimeType: 'audio/mpeg' }]);

    const failed = parseGeneration(g.imageFailed);
    expect(failed).toMatchObject({ status: 'failed', error: 'Backend error (403). Please try again.', outputs: [] });
  });

  it('reads the request-queue shape without mistaking inputs or thumbnails for outputs', () => {
    const parsed = parseGeneration(generations.queueDocsResponse);
    expect(parsed.outputs).toEqual([{ url: 'https://storage.googleapis.com/bucket/generated-video.mp4', kind: 'video', mimeType: 'video/mp4' }]);
    expect(parsed.posterUrl).toBe('https://storage.googleapis.com/bucket/thumbnail.jpg');
    expect(parsed.createdAt).toBe(new Date(1786561117 * 1000).toISOString());
  });

  it('reads the text a video submission answers with', () => {
    const text = 'Still running. This generation was accepted and is being charged; it did not fail.\nCall get_generation with request_id "req_7f3a9c2e" to get the result.';
    expect(parseGeneration(text)).toMatchObject({ requestId: 'req_7f3a9c2e', status: 'processing', outputs: [] });
    expect(parseGeneration({ request_id: 'abc-123', status: 'queued' })).toMatchObject({ requestId: 'abc-123', status: 'queued' });
    expect(parseGeneration({ request_id: 'abc', media: ['https://cdn.example/x.webp'] })).toMatchObject({ status: 'success' });
  });

  it('never finishes a job, or finds outputs, from links in a text answer (only the JSON result completes it)', () => {
    const running = 'Still running. This generation was accepted and is being charged; it did not fail. See https://docs.gmicloud.ai/status for details. request_id "vid-1"';
    expect(parseGeneration(running, 'video')).toMatchObject({ requestId: 'vid-1', status: 'processing', outputs: [] });
    const prose = 'Generation finished. Your prompt referenced https://intranet.corp.example/admin/reset?all=1 and request_id "req_123456"';
    expect(parseGeneration(prose)).toMatchObject({ requestId: 'req_123456', status: 'unknown', outputs: [] });
    expect(parseGeneration('This generation was refused as submitted. See https://docs.gmicloud.ai/x')).toMatchObject({ status: 'failed', outputs: [] });
  });

  it('maps status words', () => {
    expect(['created', 'queued', 'dispatched', 'processing', 'success', 'failed', 'cancelled'].map(mapJobStatus)).toEqual([
      'created',
      'queued',
      'dispatched',
      'processing',
      'success',
      'failed',
      'cancelled',
    ]);
    expect(mapJobStatus('Completed')).toBe('success');
    expect(mapJobStatus('in-progress')).toBe('processing');
    expect(mapJobStatus('canceled')).toBe('cancelled');
    expect(mapJobStatus('weird')).toBe('unknown');
    expect(mapJobStatus(undefined)).toBe('unknown');
  });
});

describe('extractOutputs', () => {
  it('handles the shapes GMI and its providers use', () => {
    const music = {
      outcome: {
        audio_url: 'https://cdn.example/song.mp3',
        medias: [{ url: 'https://cdn.example/song.mp3', type: 'audio', format: 'mp3' }],
        media_urls: [{ id: '0', url: 'https://cdn.example/song.mp3' }],
      },
    };
    expect(extractOutputs(music)).toEqual([{ url: 'https://cdn.example/song.mp3', kind: 'audio', mimeType: 'audio/mpeg' }]);

    const luma = { outcome: { video_url: 'https://cdn.example/out', generation_id: 'g1', thumbnail_image_url: 'https://cdn.example/t.jpg' } };
    expect(extractOutputs(luma)).toEqual([{ url: 'https://cdn.example/out', kind: 'video', mimeType: null }]);

    const list = { images: ['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/1.png'] };
    expect(extractOutputs(list).map((o) => o.url)).toEqual(['https://cdn.example/1.png', 'https://cdn.example/2.png']);

    expect(extractOutputs(['https://cdn.example/a.wav'])).toEqual([{ url: 'https://cdn.example/a.wav', kind: 'audio', mimeType: 'audio/wav' }]);
    expect(extractOutputs('Done: https://cdn.example/a.jpg.')).toEqual([{ url: 'https://cdn.example/a.jpg', kind: 'image', mimeType: 'image/jpeg' }]);
    expect(extractOutputs({ result: { output: 'https://cdn.example/blob' } }, 'video')).toEqual([{ url: 'https://cdn.example/blob', kind: 'video', mimeType: null }]);
  });

  it('ignores non-https URLs, echoed inputs and URLs in prose', () => {
    const raw = {
      media: [{ url: 'http://insecure.example/a.png' }, { url: 'javascript:alert(1)' }, { url: 'https://user:pw@cdn.example/a.png' }],
      payload: { first_frame: 'https://inputs.example/frame.png' },
      note: 'See https://docs.example/page for details',
      parameters: { image: ['https://inputs.example/ref.png'] },
    };
    expect(extractOutputs(raw)).toEqual([]);
  });

  it('ignores outputs and posters on IP literals, localhost and private-network names', () => {
    const raw = {
      request_id: 'r1',
      status: 'success',
      poster: 'https://10.0.0.5/poster.jpg',
      media: [
        { url: 'https://10.0.0.5/a.png' },
        { url: 'https://2130706433/b.png' }, // 127.0.0.1 spelled as one number
        { url: 'https://[::1]/c.png' },
        { url: 'https://localhost/d.png' },
        { url: 'https://printer.local/e.png' },
        { url: 'https://intranet/f.png' },
        { url: 'https://wiki.corp/g.png' },
        { url: 'https://storage.googleapis.com/gmi-generated-assets/ok.png' },
      ],
    };
    const parsed = parseGeneration(raw);
    expect(parsed.outputs.map((o) => o.url)).toEqual(['https://storage.googleapis.com/gmi-generated-assets/ok.png']);
    expect(parsed.posterUrl).toBeNull();
    expect(isPublicHttpsUrl('https://cdn.example/a.png')).toBe(true);
    expect(isPublicHttpsUrl('https://media.mock.gmicloud.invalid/g/x/0.svg')).toBe(true);
    expect(isPublicHttpsUrl('https://localhost./a.png')).toBe(false);
    expect(isPublicHttpsUrl('https://0x7f.1/a.png')).toBe(false);
    expect(isPublicHttpsUrl('https://[::ffff:127.0.0.1]/a.png')).toBe(false);
    expect(isPublicHttpsUrl('https://user:pw@cdn.example/a.png')).toBe(false);
  });

  it('recognises re-signed URLs as the same output', () => {
    expect(sameOutputUrl('https://cdn.example/a.mp4?sig=1', 'https://cdn.example/a.mp4?sig=2')).toBe(true);
    expect(sameOutputUrl('https://cdn.example/a.mp4', 'https://cdn.example/b.mp4')).toBe(false);
  });
});

describe('list and upload slot parsing', () => {
  it('parses list_generations', () => {
    const list = parseGenerationList(generations.listGenerations);
    expect(list.total).toBe(675);
    expect(list.items[0]).toEqual({
      requestId: '0a000000-0000-4000-8000-000000000003',
      modelId: 'minimax-music-3.0',
      modality: 'audio',
      status: 'success',
      createdAt: '2026-10-30T10:14:37.000Z',
    });
    expect(parseGenerationList(generations.listGenerationsEmpty)).toEqual({ items: [], total: 0, offset: 0 });
    expect(parseGenerationList('nonsense').items).toEqual([]);
  });

  it('parses upload slots and refuses unusable ones', () => {
    const slot = {
      upload_url: 'https://storage.googleapis.com/b/u.png?X-Goog-Signature=abc',
      public_url: 'https://storage.googleapis.com/b/u.png',
      content_type: 'image/png',
      expires_in_seconds: 900,
    };
    expect(parseUploadSlot(slot)).toEqual({ uploadUrl: slot.upload_url, publicUrl: slot.public_url, contentType: 'image/png', expiresInSeconds: 900 });
    expect(parseUploadSlot({ upload: { uploadUrl: slot.upload_url, publicUrl: slot.public_url } })?.contentType).toBeNull();
    expect(parseUploadSlot({ upload_url: 'http://x.example/u', public_url: slot.public_url })).toBeNull();
    expect(parseUploadSlot({ public_url: slot.public_url })).toBeNull();
    // Never a PUT target on an IP literal (cloud metadata), localhost or an intranet name.
    expect(parseUploadSlot({ upload_url: 'https://169.254.169.254/latest/meta-data', public_url: slot.public_url })).toBeNull();
    expect(parseUploadSlot({ upload_url: 'https://localhost:8443/put', public_url: slot.public_url })).toBeNull();
    expect(parseUploadSlot({ upload_url: slot.upload_url, public_url: 'https://intranet/u.png' })).toBeNull();
  });

  it('unwraps MCP CallToolResult objects but leaves results alone', () => {
    expect(unwrapToolResult({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapToolResult({ request_id: 'x', content: [] })).toEqual({ request_id: 'x', content: [] });
  });
});

describe('output paths and downloads', () => {
  let t: TestContext | null = null;
  afterEach(async () => {
    await t?.cleanup();
    t = null;
  });

  it('keeps every output path inside the media folder', () => {
    const media = '/data/media';
    const out = { url: 'https://cdn.example/x/../../evil.png', mimeType: null, kind: 'image' as const };
    for (const id of ['../../etc', '..', '/abs/path', 'a/b\\c', 'nul\0byte', 'ok-123']) {
      const path = outputFilePath(media, id, 0, out);
      expect(isInsideDir(media, path)).toBe(true);
      expect(path.startsWith(`${media}/`)).toBe(true);
    }
    expect(jobFolderName('ok-123')).toBe('ok-123');
    expect(jobFolderName('a/b')).not.toBe(jobFolderName('a_b'));
    expect(outputFilePath(media, 'job', 2, { url: 'https://cdn.example/v', mimeType: 'video/mp4', kind: 'video' })).toBe('/data/media/job/2.mp4');
    expect(outputFilePath(media, 'job', 0, { url: 'https://cdn.example/a.exe', mimeType: null, kind: 'image' })).toBe('/data/media/job/0.png');
    expect(() => outputFilePath(media, 'job', -1, out)).toThrow(GmiError);
  });

  it('streams a download to disk, without credentials', async () => {
    const fake = createFakeFetch([
      { match: 'cdn.example/a.png', respond: () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/png' } }) },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    const dest = join(t.ctx.paths.media, 'job', '0.png');
    const res = await downloadToFile(t.ctx.http, 'https://cdn.example/a.png', dest);
    expect(res).toEqual({ bytes: 4, contentType: 'image/png' });
    expect([...(await readFile(dest))]).toEqual([1, 2, 3, 4]);
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
    expect(await readdir(join(t.ctx.paths.media, 'job'))).toEqual(['0.png']);
  });

  it('refuses http URLs and files over the size cap', async () => {
    const fake = createFakeFetch([
      { match: 'big.example/declared', respond: () => new Response('x', { headers: { 'content-length': '5000' } }) },
      { match: 'big.example/stream', respond: () => new Response(new Uint8Array(3000)) },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    const dest = join(t.ctx.paths.media, 'job', '0.bin');
    await expect(downloadToFile(t.ctx.http, 'http://big.example/a.png', dest)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(downloadToFile(t.ctx.http, 'https://big.example/declared', dest, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(downloadToFile(t.ctx.http, 'https://big.example/stream', dest, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'invalid_input' });
    // No partial files are left behind.
    expect(await readdir(join(t.ctx.paths.media, 'job')).catch(() => [])).toEqual([]);
  });

  const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });
  const png = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

  it('checks a redirect target before following it: http or loopback is refused without being requested', async () => {
    const fake = createFakeFetch([{ match: 'cdn.example/moved.png', respond: redirect('http://127.0.0.1/x') }]);
    t = await createTestContext({ fetch: fake.fetch });
    const dest = join(t.ctx.paths.media, 'job', '0.png');
    await expect(downloadToFile(t.ctx.http, 'https://cdn.example/moved.png', dest)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fake.requests.map((r) => r.url)).toEqual(['https://cdn.example/moved.png']);

    for (const target of ['https://localhost/x', 'https://10.1.2.3/x', 'https://[fe80::1]/x', 'https://intranet/x', 'https://router.lan/x']) {
      fake.requests.length = 0;
      fake.route({ match: `cdn.example/to-${encodeURIComponent(target)}`, respond: redirect(target, 307) });
      await expect(downloadToFile(t.ctx.http, `https://cdn.example/to-${encodeURIComponent(target)}`, dest)).rejects.toMatchObject({ code: 'invalid_input' });
      expect(fake.requests).toHaveLength(1);
    }
    expect(await readdir(join(t.ctx.paths.media, 'job')).catch(() => [])).toEqual([]);
  });

  it('refuses IP-literal and private-network URLs before any request', async () => {
    const fake = createFakeFetch([{ match: () => true, respond: png }]);
    t = await createTestContext({ fetch: fake.fetch });
    const dest = join(t.ctx.paths.media, 'job', '0.png');
    for (const url of ['https://10.0.0.5/a.png', 'https://169.254.169.254/latest', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://nas.local/a.png']) {
      await expect(downloadToFile(t.ctx.http, url, dest)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(fake.requests).toEqual([]);
  });

  it(`follows up to ${MAX_DOWNLOAD_REDIRECTS} redirects between public https hosts, relative ones included`, async () => {
    const fake = createFakeFetch([
      { match: 'gmi.example/out/a.png', respond: redirect('https://cdn-2.example/signed/a.png?sig=1') },
      { match: 'cdn-2.example/signed/a.png', respond: redirect('/final/a.png', 301) },
      { match: 'cdn-2.example/final/a.png', respond: png },
      { match: /loop\.example\/(\d+)/, respond: (req) => redirect(`https://loop.example/${Number(/\/(\d+)$/.exec(req.url)?.[1]) + 1}`)() },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    const dest = join(t.ctx.paths.media, 'job', '0.png');
    await expect(downloadToFile(t.ctx.http, 'https://gmi.example/out/a.png', dest)).resolves.toEqual({ bytes: 3, contentType: 'image/png' });
    expect(fake.requests.map((r) => r.url)).toEqual([
      'https://gmi.example/out/a.png',
      'https://cdn-2.example/signed/a.png?sig=1',
      'https://cdn-2.example/final/a.png',
    ]);
    expect([...(await readFile(dest))]).toEqual([1, 2, 3]);

    fake.requests.length = 0;
    await expect(downloadToFile(t.ctx.http, 'https://loop.example/0', join(t.ctx.paths.media, 'job', '1.png'))).rejects.toMatchObject({ code: 'upstream' });
    expect(fake.requests).toHaveLength(MAX_DOWNLOAD_REDIRECTS + 1);
  });

  it('removes the partial file when a download is aborted mid-stream', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const fake = createFakeFetch([
      {
        match: 'cdn.example/big.mp4',
        respond: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new Uint8Array(32 * 1024));
                setTimeout(() => controller.abort(), 20);
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    const dest = join(t.ctx.paths.media, 'job', '0.mp4');
    await expect(downloadToFile(t.ctx.http, 'https://cdn.example/big.mp4', dest, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancelled).toBe(true);
    expect(await readdir(join(t.ctx.paths.media, 'job'))).toEqual([]);
  });

  it('sweeps temp files older than the threshold from the media folder and its job folders only', async () => {
    t = await createTestContext();
    const media = t.ctx.paths.media;
    const now = Date.now();
    const old = new Date(now - STALE_TEMP_MS - 60_000);
    const put = async (rel: string, mtime: Date | null) => {
      const path = join(media, rel);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'x');
      if (mtime) await utimes(path, mtime, mtime);
    };
    await put('job-1/0.mp4.part-1234-1', old);
    await put('job-1/1.png.part-1234-2', old);
    await put('uploads/cat.png.tmp-77-3', old);
    await put('stray.part-5-6', old);
    await put('job-2/0.png.part-999-1', null); // recent: possibly being written
    await put('job-1/0.png', old); // a saved output
    await put('job-1/deep/0.png.part-1-1', old); // job folders have no subfolders: not ours
    expect(await sweepStaleTempFiles(media, { now })).toBe(4);
    expect((await readdir(join(media, 'job-1'))).sort()).toEqual(['0.png', 'deep']);
    expect(await readdir(join(media, 'uploads'))).toEqual([]);
    expect(await readdir(join(media, 'job-2'))).toEqual(['0.png.part-999-1']);
    expect(await readdir(join(media, 'job-1', 'deep'))).toEqual(['0.png.part-1-1']);
    // A missing folder is not an error.
    await expect(sweepStaleTempFiles(join(media, 'nope'))).resolves.toBe(0);
  });
});
