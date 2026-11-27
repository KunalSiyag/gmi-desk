import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaJob } from '@shared/contracts/media';
import { createMediaSlice, type MediaSlice } from '@main/services/media';
import { parseEstimate, parseGeneration } from '@main/services/media/parse';
import { chimeWav, isMockMediaUrl, mediaMockTools, placeholderSvg, renderMockMedia, resetMediaMock, seedMockGenerations } from '@main/mock/media';
import { createMockMcp } from '@main/mock/mcp';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeAuth, createFakeBudget, createFakeCatalog } from './fakes';

const call = async (name: keyof typeof mediaMockTools, args: Record<string, unknown>) => {
  const handler = mediaMockTools[name];
  if (!handler) throw new Error(`missing mock ${name}`);
  return (await handler(args)) as Record<string, unknown>;
};

describe('media mock tools', () => {
  beforeEach(() => {
    resetMediaMock();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only claims the tools the media slice owns', () => {
    expect(Object.keys(mediaMockTools).sort()).toEqual(['estimate_generation', 'get_generation', 'submit_generation', 'upload_media']);
  });

  it('estimates from recorded calls and fixture prices', async () => {
    const recorded = await call('estimate_generation', { model_id: 'kling-3.0-turbo-t2v', prompt: 'x', parameters: { resolution: '720p', duration: '5', aspect_ratio: '16:9' } });
    expect(parseEstimate(recorded).listUsd).toBe(0.56);
    const longer = await call('estimate_generation', { model_id: 'kling-3.0-turbo-t2v', prompt: 'x', parameters: { duration: '10' } });
    expect(longer).toMatchObject({ price_micro_usd: 1_120_000, unit: 'second', note: expect.stringContaining('per second') });
    const speech = await call('estimate_generation', { model_id: 'minimax-tts-speech-2.8-hd', prompt: 'x', parameters: { text: 'a'.repeat(250) } });
    expect(speech).toMatchObject({ price_micro_usd: 25_000, unit: '1k character' });
    const unknown = await call('estimate_generation', { model_id: 'not-in-fixtures', prompt: 'x' });
    expect(parseEstimate(unknown).listUsd).toBe(0.05);
    await expect(call('estimate_generation', { model_id: 'seedream-5.0-pro', prompt: '  ' })).rejects.toMatchObject({ message: 'prompt is required' });
  });

  it('prices every requested output like live GMI: n, and max_images only with sequential generation', async () => {
    const price = async (args: Record<string, unknown>) => parseEstimate(await call('estimate_generation', { prompt: 'x', ...args })).listUsd;
    // Live: gpt-image-2-generate n=1 → $0.05468, n=4 → $0.21272 (4×), as a parameter or top-level.
    const one = await price({ model_id: 'gpt-image-2.5-flare-generate', parameters: { n: 1 } });
    expect(one).toBe(0.01325);
    expect(await price({ model_id: 'gpt-image-2.5-flare-generate', parameters: { n: 4 } })).toBe(0.053);
    expect(await price({ model_id: 'gpt-image-2.5-flare-generate', n: 4 })).toBe(0.053);
    // Live: seedream max_images=4 → $0.085 with sequential generation disabled (one image), $0.34 with it on.
    expect(await price({ model_id: 'seedream-5.0-pro', parameters: { max_images: 4 } })).toBe(0.085);
    expect(await price({ model_id: 'seedream-5.0-pro', parameters: { sequential_image_generation: 'auto', max_images: 4 } })).toBe(0.34);
    // A top-level n means nothing to a model without an n parameter.
    expect(await price({ model_id: 'seedream-5.0-pro', parameters: { size: '2K' }, n: 3 })).toBe(0.085);
    // And a mock job makes as many images as it was priced for.
    const submitted = await call('submit_generation', { model_id: 'gpt-image-2.5-flare-generate', prompt: 'three cats', parameters: { n: 3 } });
    expect(String(submitted.request_id)).toMatch(/^mock-image-3-/);
    const single = await call('submit_generation', { model_id: 'seedream-5.0-pro', prompt: 'one lighthouse', parameters: { max_images: 3 } });
    expect(String(single.request_id)).toMatch(/^mock-image-1-/);
  });

  it('progresses a submission queued → processing → success over a few seconds', async () => {
    const submitted = await call('submit_generation', {
      model_id: 'seedream-5.0-pro',
      prompt: 'a lighthouse',
      parameters: { sequential_image_generation: 'auto', max_images: 2 },
      wait_seconds: 8,
    });
    const id = String(submitted.request_id);
    expect(id).toMatch(/^mock-image-2-/);
    expect(submitted.status).toBe('queued');
    vi.advanceTimersByTime(1500);
    expect((await call('get_generation', { request_id: id })).status).toBe('processing');
    vi.advanceTimersByTime(2500);
    const done = parseGeneration(await call('get_generation', { request_id: id }));
    expect(done.status).toBe('success');
    expect(done.outputs.map((o) => [o.kind, o.mimeType])).toEqual([
      ['image', 'image/svg+xml'],
      ['image', 'image/svg+xml'],
    ]);
    expect(done.outputs.every((o) => isMockMediaUrl(o.url))).toBe(true);
  });

  it('fails prompts tagged #fail, and de-duplicates identical requests unless the nonce changes', async () => {
    const failed = await call('submit_generation', { model_id: 'kling-3.0-turbo-t2v', prompt: 'boom #fail' });
    vi.advanceTimersByTime(10_000);
    expect(await call('get_generation', { request_id: failed.request_id })).toMatchObject({ status: 'failed', failure_reason: expect.stringContaining('#fail') });

    const args = { model_id: 'wan3.0-video', prompt: 'forest', parameters: { duration: 5 } };
    const a = await call('submit_generation', args);
    const b = await call('submit_generation', { ...args, wait_seconds: 8 });
    const c = await call('submit_generation', { ...args, idempotency_nonce: 'retake-1' });
    expect(b.request_id).toBe(a.request_id);
    expect(c.request_id).not.toBe(a.request_id);
  });

  it('answers like GMI for unknown requests and resolves mock ids after a restart', async () => {
    await expect(call('get_generation', { request_id: 'nope' })).rejects.toMatchObject({ code: 'not_found', message: 'no generation with request id "nope"' });
    const restored = parseGeneration(await call('get_generation', { request_id: 'mock-audio-1-feedbeef' }));
    expect(restored).toMatchObject({ status: 'success' });
    expect(restored.outputs[0]?.kind).toBe('audio');
  });

  it('hands out upload slots for the accepted file types', async () => {
    const slot = await call('upload_media', { file_type: 'mp4' });
    expect(slot).toMatchObject({ content_type: 'video/mp4', expires_in_seconds: 900 });
    expect(isMockMediaUrl(String(slot.upload_url))).toBe(true);
    await expect(call('upload_media', { file_type: 'gif' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('renders playable placeholders for mock outputs', () => {
    const seeded = seedMockGenerations(Date.now());
    const image = seeded.find((j) => j.modality === 'image' && j.outputs.length);
    const video = seeded.find((j) => j.modality === 'video' && j.outputs.length);
    const svg = renderMockMedia(image!.outputs[0]!.url)!;
    expect(svg.mimeType).toBe('image/svg+xml');
    const text = new TextDecoder().decode(svg.data);
    expect(text.startsWith('<svg')).toBe(true);
    expect(text).toContain('lighthouse');

    const webm = renderMockMedia(video!.outputs[0]!.url)!;
    expect(webm.mimeType).toBe('video/webm');
    expect([...webm.data.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML magic

    const wav = chimeWav(42);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(renderMockMedia('https://cdn.example/a.png')).toBeNull();
    expect(placeholderSvg({ prompt: '<script>&', modelId: 'm', seed: 1 })).toContain('&lt;script&gt;&amp;');
  });

  it('seeds a varied demo gallery', () => {
    const jobs = seedMockGenerations(Date.now());
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
    expect(new Set(jobs.map((j) => j.modality))).toEqual(new Set(['image', 'video', 'audio']));
    expect(jobs.filter((j) => j.status === 'processing')).toHaveLength(1);
    expect(jobs.filter((j) => j.status === 'failed')).toHaveLength(1);
    expect(jobs.every((j) => j.fromThisDevice && j.estimateUsd !== null)).toBe(true);
    expect([...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))).toEqual(jobs);
  });

  it('is wired into the mock MCP server', async () => {
    const mcp = createMockMcp({ latencyMs: 0 });
    const res = await mcp.callTool('upload_media', { file_type: 'png' });
    expect(res).toMatchObject({ content_type: 'image/png' });
  });
});

describe('media slice in mock mode', () => {
  let t: TestContext | null = null;
  let slice: MediaSlice | null = null;
  afterEach(async () => {
    await slice?.dispose();
    await t?.cleanup();
    slice = null;
    t = null;
  });

  it('seeds the demo gallery once and materialises its outputs locally without network access', async () => {
    resetMediaMock();
    t = await createTestContext({
      mock: true,
      fetch: async () => {
        throw new Error('mock mode must not use the network');
      },
    });
    const deps = { auth: createFakeAuth(true), mcp: createMockMcp({ latencyMs: 0 }), catalog: createFakeCatalog(), budget: createFakeBudget() };
    slice = await createMediaSlice(t.ctx, deps, { resumeDelayMs: 60_000 });
    // GMI history comes from the Usage slice's list_generations mock; this device's demo jobs are ours.
    const { jobs } = await slice.api.listJobs({ limit: 100 });
    expect(jobs.filter((j) => j.fromThisDevice)).toHaveLength(8);
    const done = jobs.filter((j) => j.fromThisDevice && j.status === 'success');
    await vi.waitFor(async () => {
      const latest = (await slice!.api.listJobs({ limit: 100 })).jobs.filter((j) => j.fromThisDevice && j.status === 'success');
      expect(latest.every((j) => j.outputs.every((o) => o.localUrl?.startsWith('gmi-media://local/')))).toBe(true);
    });
    const latest: MediaJob[] = (await slice.api.listJobs({ limit: 100 })).jobs;
    const video = latest.find((j) => j.fromThisDevice && j.modality === 'video' && j.status === 'success')!;
    const file = video.outputs[0]!.localPath!;
    expect(existsSync(file)).toBe(true);
    expect([...(await readFile(file)).subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(done.length).toBeGreaterThan(3);

    // Second start: nothing is re-seeded.
    await slice.dispose();
    slice = await createMediaSlice(t.ctx, deps, { resumeDelayMs: 60_000 });
    expect((await slice.api.listJobs({ limit: 100 })).jobs.filter((j) => j.fromThisDevice)).toHaveLength(8);

    // A history item opened in mock mode resolves consistently with its listed status and renders locally.
    const remote = (await slice.api.listJobs({ limit: 100 })).jobs.find((j) => !j.fromThisDevice && j.status === 'success' && j.modality === 'image');
    if (remote) {
      const opened = await slice.api.getJob(remote.id);
      expect(opened.outputs[0]?.kind).toBe('image');
      await vi.waitFor(async () => expect((await slice!.api.getJob(remote.id)).outputs[0]?.localUrl).toMatch(/^gmi-media:/));
    }
  });

  it('runs a full mock generation end to end', async () => {
    resetMediaMock();
    t = await createTestContext({ mock: true });
    const deps = { auth: createFakeAuth(true), mcp: createMockMcp({ latencyMs: 0 }), catalog: createFakeCatalog(), budget: createFakeBudget() };
    slice = await createMediaSlice(t.ctx, deps, { resumeDelayMs: 60_000, seedDemo: false, pollIntervalMs: { audio: 200 } });
    const est = await slice.api.estimate({ modelId: 'minimax-tts-speech-2.8-hd', prompt: 'Hello from the demo' });
    expect(est.chargedUsd).toBe(0.0019);
    const job = await slice.api.submit({ modelId: 'minimax-tts-speech-2.8-hd', prompt: 'Hello from the demo', approvedUsd: est.chargedUsd });
    expect(job.status).toBe('queued');
    await vi.waitFor(
      async () => {
        const latest = await slice!.api.getJob(job.id);
        expect(latest.status).toBe('success');
        expect(latest.outputs[0]?.localUrl).toMatch(/\.wav$/);
      },
      { timeout: 10_000, interval: 200 },
    );
    expect(deps.budget.recorded).toEqual([{ kind: 'media', modelId: 'minimax-tts-speech-2.8-hd', usd: 0.0019, ref: job.id }]);
  });
});
