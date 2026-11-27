// media-30: the poller and the job dialog (getJob) refreshing the same job at the same time.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaJob } from '@shared/contracts/media';
import { createMediaSlice, type MediaSlice } from '@main/services/media';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch } from '../helpers/fetch';
import { createFakeAuth, createFakeBudget, createFakeCatalog, createFakeMcp } from './fakes';

const OUT = 'https://cdn.example/out/video-1.mp4';
const SUCCESS = { request_id: 'req-1', status: 'success', model_id: 'kling-3.0-turbo-t2v', media: [{ url: OUT, type: 'video', mime_type: 'video/mp4' }] };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

let t: TestContext | null = null;
let slice: MediaSlice | null = null;

afterEach(async () => {
  await slice?.dispose();
  await t?.cleanup();
  slice = null;
  t = null;
});

/** A video job still processing on this device; GMI answers get_generation with `answer()`. */
async function setup(job: Partial<MediaJob>, answer: () => Promise<unknown>) {
  const fake = createFakeFetch();
  let downloads = 0;
  fake.route({
    match: OUT,
    respond: () => {
      downloads += 1;
      return new Response(new Uint8Array(1024), { headers: { 'content-type': 'video/mp4' } });
    },
  });
  t = await createTestContext({ fetch: fake.fetch });
  const now = new Date().toISOString();
  const stored: MediaJob = {
    id: 'req-1',
    modelId: 'kling-3.0-turbo-t2v',
    modality: 'video',
    status: 'processing',
    prompt: 'a cat',
    parameters: {},
    estimateUsd: 0.5,
    createdAt: now,
    updatedAt: now,
    outputs: [],
    error: null,
    fromThisDevice: true,
    ...job,
  };
  await writeFile(join(t.ctx.paths.data, 'media-jobs.json'), JSON.stringify({ version: 1, jobs: [stored] }));
  const mcp = createFakeMcp({ get_generation: () => answer() });
  slice = await createMediaSlice(t.ctx, { auth: createFakeAuth(true), mcp, catalog: createFakeCatalog(), budget: createFakeBudget() }, {
    resumeDelayMs: 0,
    pollIntervalMs: { video: 0 },
    seedDemo: false,
  });
  return { mcp, t, slice, downloads: () => downloads };
}

const jobEvents = () => (t?.emitted ?? []).filter((e) => e.name === 'media:job').map((e) => e.payload as MediaJob);

/** Once an event carries the local copy, no later event may drop it. */
function expectLocalCopyNeverDropped() {
  const events = jobEvents();
  const firstSaved = events.findIndex((j) => j.outputs[0]?.localPath);
  expect(firstSaved).toBeGreaterThanOrEqual(0);
  expect(events.slice(firstSaved).every((j) => Boolean(j.outputs[0]?.localPath))).toBe(true);
}

describe('one job refreshed from two places at once', () => {
  it('shares one get_generation between the poller and the job dialog: one notification, one download', async () => {
    const gmi = gate();
    const { mcp, t, slice, downloads } = await setup({}, async () => {
      await gmi.opened;
      return SUCCESS;
    });
    // The poller's tick is waiting for GMI...
    await vi.waitFor(() => expect(mcp.callsTo('get_generation')).toHaveLength(1));
    // ...when the job dialog opens and asks as well.
    const fromDialog = slice.api.getJob('req-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    gmi.open();
    await expect(fromDialog).resolves.toMatchObject({ id: 'req-1', status: 'success' });
    await vi.waitFor(async () => expect((await slice.api.getJob('req-1')).outputs[0]?.localPath).toBeTruthy());

    expect(mcp.callsTo('get_generation')).toHaveLength(1);
    expect(t.platform.notifications.map((n) => n.title)).toEqual(['Video ready']);
    expect(downloads()).toBe(1);
    expectLocalCopyNeverDropped();
  });

  it("applies GMI's answer to the job as it is when the answer arrives: a copy saved meanwhile is kept, not fetched again", async () => {
    const gmi = gate();
    const { mcp, t, slice, downloads } = await setup({ outputs: [{ url: OUT, kind: 'video', localPath: null, localUrl: null, mimeType: 'video/mp4' }] }, async () => {
      await gmi.opened;
      return SUCCESS;
    });
    await vi.waitFor(() => expect(mcp.callsTo('get_generation')).toHaveLength(1));
    // While that poll is in flight, the user saves the output GMI already listed.
    const saved = await slice.api.saveOutput('req-1', 0);
    const localPath = saved.outputs[0]?.localPath;
    expect(localPath).toBeTruthy();

    gmi.open();
    await vi.waitFor(async () => expect((await slice.api.getJob('req-1')).status).toBe('success'));
    await new Promise((resolve) => setTimeout(resolve, 50)); // room for a (wrong) second download
    expect((await slice.api.getJob('req-1')).outputs[0]?.localPath).toBe(localPath);
    expect(downloads()).toBe(1);
    expect(t.platform.notifications.map((n) => n.title)).toEqual(['Video ready']);
    expectLocalCopyNeverDropped();
  });
});
