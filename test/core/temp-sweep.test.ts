// Temp files from writes interrupted by a crash are removed at the next start (finding foundation-34, core part).
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepStaleTempFiles } from '@main/core/store';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmi-desk-sweep-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(path: string, ageMs: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'x');
  const t = new Date(Date.now() - ageMs);
  await utimes(path, t, t);
}

describe('sweepStaleTempFiles', () => {
  it('removes old atomicWriteFile temp files and keeps everything else', async () => {
    const hour = 60 * 60_000;
    await file(join(dir, 'data', 'settings.json.tmp-1234-1'), hour);
    await file(join(dir, 'data', 'chat', 'threads.json.tmp-999-17'), hour);
    await file(join(dir, 'secure', 'inference.key.bin.tmp-42-3'), hour);
    await file(join(dir, 'data', 'budget.json.tmp-1234-2'), 1_000); // a write in progress right now
    await file(join(dir, 'data', 'settings.json'), hour);
    await file(join(dir, 'data', 'settings.json.corrupt-1700000000000'), hour);
    await file(join(dir, 'data', 'notes.tmp'), hour);

    const removed = await sweepStaleTempFiles([join(dir, 'data'), join(dir, 'secure'), join(dir, 'missing')]);
    expect(removed.map((p) => p.slice(dir.length + 1)).sort()).toEqual([
      join('data', 'chat', 'threads.json.tmp-999-17'),
      join('data', 'settings.json.tmp-1234-1'),
      join('secure', 'inference.key.bin.tmp-42-3'),
    ]);
    expect((await readdir(join(dir, 'data'))).sort()).toEqual(['budget.json.tmp-1234-2', 'chat', 'notes.tmp', 'settings.json', 'settings.json.corrupt-1700000000000']);
    expect(await readdir(join(dir, 'secure'))).toEqual([]);
  });

  it('respects the depth limit', async () => {
    await file(join(dir, 'a', 'b', 'c', 'deep.json.tmp-1-1'), 60 * 60_000);
    expect(await sweepStaleTempFiles([dir], { maxDepth: 2 })).toEqual([]);
    expect(await sweepStaleTempFiles([dir], { maxDepth: 3 })).toHaveLength(1);
  });
});
