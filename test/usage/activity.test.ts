import { describe, expect, it } from 'vitest';
import { aggregateGenerations, createActivityService, normalizeGenerationPage, scanMediaActivity } from '@main/services/usage/activity';
import { fakeMcp } from './fakes';

const NOW = new Date('2026-10-31T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Job {
  request_id: string;
  model_id: string;
  modality: string;
  status: string;
  created_at: string;
}

/** list_generations over a fixed job list (newest first), honouring limit/offset like GMI. */
function generationsMcp(jobs: Job[], opts: { omitTotal?: boolean } = {}) {
  return fakeMcp({
    list_generations: (args) => {
      const limit = Number(args.limit ?? 20);
      const offset = Number(args.offset ?? 0);
      const page = jobs.slice(offset, offset + limit);
      return opts.omitTotal ? { generations: page, offset } : { generations: page, offset, total: jobs.length };
    },
  });
}

function jobs(count: number, spacingHours: number, make: (i: number) => Partial<Job> = () => ({})): Job[] {
  return Array.from({ length: count }, (_, i) => ({
    request_id: `r${i}`,
    model_id: 'hy-image-v3.5-preview',
    modality: 'image',
    status: 'success',
    created_at: hoursAgo(i * spacingHours + 0.5),
    ...make(i),
  }));
}

describe('normalizeGenerationPage', () => {
  it('parses the recorded shape and tolerates junk rows', () => {
    const page = normalizeGenerationPage({
      generations: [
        { created_at: '2026-10-29T08:41:12Z', modality: 'Audio', model_id: 'minimax-music-3.0', request_id: 'a', status: 'SUCCESS' },
        null,
        { created_at: 'not a date', model_id: '', status: 'failed' },
      ],
      offset: 0,
      total: 512,
    });
    expect(page.total).toBe(512);
    expect(page.generations[0]).toEqual({
      requestId: 'a',
      modelId: 'minimax-music-3.0',
      modality: 'audio',
      status: 'success',
      createdAt: Date.parse('2026-10-29T08:41:12Z'),
    });
    expect(page.generations[1]).toMatchObject({ modelId: 'unknown', modality: 'other', status: 'failed' });
    expect(Number.isNaN(page.generations[1]?.createdAt)).toBe(true);
    expect(() => normalizeGenerationPage({ nope: true })).toThrow();
  });
});

describe('aggregateGenerations', () => {
  it('counts per model (succeeded / failed) and per modality', () => {
    const page = normalizeGenerationPage({
      generations: [
        { model_id: 'wan3.0-video', modality: 'video', status: 'success', created_at: hoursAgo(1) },
        { model_id: 'wan3.0-video', modality: 'video', status: 'failed', created_at: hoursAgo(2) },
        { model_id: 'wan3.0-video', modality: 'video', status: 'processing', created_at: hoursAgo(3) },
        { model_id: 'inworld-tts-2-flash', modality: 'audio', status: 'success', created_at: hoursAgo(4) },
        { model_id: 'gemini-3-pro-image', modality: 'image', status: 'cancelled', created_at: hoursAgo(5) },
      ],
    });
    expect(aggregateGenerations(page.generations)).toEqual({
      total: 5,
      byModel: [
        { modelId: 'wan3.0-video', count: 3, succeeded: 1, failed: 1 },
        { modelId: 'gemini-3-pro-image', count: 1, succeeded: 0, failed: 0 },
        { modelId: 'inworld-tts-2-flash', count: 1, succeeded: 1, failed: 0 },
      ],
      byModality: { video: 3, audio: 1, image: 1 },
    });
  });
});

describe('scanMediaActivity', () => {
  it('stops paging at the first job older than the window and counts only the window', async () => {
    // 250 jobs, one every 2h: 7 days (168h) holds jobs 0..83.
    const all = jobs(250, 2, (i) => (i % 10 === 0 ? { status: 'failed', model_id: 'wan3.0-video', modality: 'video' } : {}));
    const { mcp, calls } = generationsMcp(all);
    const activity = await scanMediaActivity(mcp, 7, NOW);
    expect(calls.map((c) => c.args)).toEqual([{ limit: 100, offset: 0 }]);
    expect(activity.total).toBe(84);
    expect(activity.truncated).toBe(false);
    expect(activity.scanned).toBe(100);
    expect(activity.byModality).toEqual({ video: 9, image: 75 });
    expect(activity.byModel[0]).toEqual({ modelId: 'hy-image-v3.5-preview', count: 75, succeeded: 75, failed: 0 });
    expect(activity.byModel[1]).toEqual({ modelId: 'wan3.0-video', count: 9, succeeded: 0, failed: 9 });
    expect(activity.oldestAt).toBe(new Date(Date.parse(all[83]!.created_at)).toISOString());
  });

  it('pages with limit 100 / offset until GMI has no more', async () => {
    const all = jobs(230, 0.1);
    const { mcp, calls } = generationsMcp(all);
    const activity = await scanMediaActivity(mcp, 30, NOW);
    expect(calls.map((c) => c.args.offset)).toEqual([0, 100, 200]);
    expect(activity.total).toBe(230);
    expect(activity.truncated).toBe(false);
  });

  it('works without a total by stopping on a short page', async () => {
    const { mcp, calls } = generationsMcp(jobs(150, 0.1), { omitTotal: true });
    const activity = await scanMediaActivity(mcp, 30, NOW);
    expect(calls).toHaveLength(2);
    expect(activity.total).toBe(150);
  });

  it('stops after 10 pages and flags the result as truncated', async () => {
    const { mcp, calls } = generationsMcp(jobs(1500, 0.01));
    const activity = await scanMediaActivity(mcp, 90, NOW);
    expect(calls).toHaveLength(10);
    expect(activity.total).toBe(1000);
    expect(activity.scanned).toBe(1000);
    expect(activity.truncated).toBe(true);
  });

  it('is not truncated when the 10th page already reaches past the window', async () => {
    // One job every 0.17h: jobs 0..985 are inside 7 days, job 986 (on page 10) is older.
    const { mcp, calls } = generationsMcp(jobs(1500, 0.17));
    const activity = await scanMediaActivity(mcp, 7, NOW);
    expect(calls).toHaveLength(10);
    expect(activity.truncated).toBe(false);
    expect(activity.total).toBe(986);
  });

  it('caches per period in the service and validates days', async () => {
    const { mcp, calls } = generationsMcp(jobs(5, 1));
    const service = createActivityService(mcp, () => NOW);
    await service.get(7);
    await service.get(7);
    expect(calls).toHaveLength(1);
    await expect(service.get(0)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(service.get(120)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
