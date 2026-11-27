import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaJob } from '@shared/contracts/media';
import { capJobs, MAX_STORED_JOBS, normalizeStoredJob, openJobsStore } from '@main/services/media/jobs-store';

const job = (id: string, minutesAgo: number, extra: Partial<MediaJob> = {}): MediaJob => {
  const at = new Date(Date.parse('2026-11-01T12:00:00Z') - minutesAgo * 60_000).toISOString();
  return {
    id,
    modelId: 'seedream-5.0-pro',
    modality: 'image',
    status: 'success',
    prompt: 'p',
    parameters: {},
    estimateUsd: 0.05,
    createdAt: at,
    updatedAt: at,
    outputs: [],
    error: null,
    fromThisDevice: true,
    ...extra,
  };
};

let dir: string | null = null;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe('media job ledger', () => {
  it('keeps jobs newest first and, over the cap, forgets opened GMI history before jobs made on this device', () => {
    const mine = [job('m1', 50), job('m2', 40), job('m3', 30)];
    const history = [job('h1', 5, { fromThisDevice: false }), job('h2', 10, { fromThisDevice: false }), job('h3', 45, { fromThisDevice: false })];
    const kept = capJobs([...mine, ...history], 4);
    expect(kept.map((j) => j.id)).toEqual(['h1', 'm3', 'm2', 'm1']);
    expect(capJobs([...mine], 10).map((j) => j.id)).toEqual(['m3', 'm2', 'm1']);
    // Only device jobs: the oldest go.
    expect(capJobs(mine, 2).map((j) => j.id)).toEqual(['m3', 'm2']);
    expect(MAX_STORED_JOBS).toBe(500);
  });

  it('round-trips jobs through disk, including the finish time, and ignores corrupt entries', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gmi-media-store-'));
    const path = join(dir, 'media-jobs.json');
    const store = await openJobsStore(path);
    store.upsert(job('a', 10, { finishedAt: '2026-11-01T11:51:00.000Z', pollingStopped: undefined }));
    store.upsert(job('b', 5, { status: 'processing', pollingStopped: true }));
    await store.flush();

    const raw = JSON.parse(await readFile(path, 'utf8')) as { jobs: unknown[] };
    raw.jobs.push({ id: 'broken' }, 'nonsense', { ...job('a', 1) });
    await writeFile(path, JSON.stringify(raw));

    const reopened = await openJobsStore(path);
    expect(reopened.list().map((j) => j.id)).toEqual(['b', 'a']);
    expect(reopened.get('a')?.finishedAt).toBe('2026-11-01T11:51:00.000Z');
    expect(reopened.get('b')?.pollingStopped).toBe(true);
    expect(reopened.get('b')?.finishedAt).toBeUndefined();
  });

  it('normalises untrusted stored jobs (bad statuses, outputs and dates)', () => {
    const j = normalizeStoredJob({
      id: 'x',
      modelId: 'm',
      createdAt: '2026-10-31T10:00:00Z',
      status: 'exploded',
      modality: 'hologram',
      outputs: [{ url: 'https://cdn.example/a.png', kind: 'weird' }, { kind: 'image' }, null],
      finishedAt: 'not a date',
      fromThisDevice: 'yes',
    });
    expect(j).toMatchObject({ status: 'unknown', modality: 'other', fromThisDevice: false, outputs: [{ url: 'https://cdn.example/a.png', kind: 'file' }] });
    expect(j?.finishedAt).toBeUndefined();
    expect(normalizeStoredJob({ id: 'x', modelId: 'm', createdAt: 'never' })).toBeNull();
  });
});
