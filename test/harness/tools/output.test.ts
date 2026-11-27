// H2-D: output truncation and spill (harness.md §7.3, §8.7): head / head+tail markers, spill files named by the
// internal tool-call id (repeated provider ids cannot collide), thread-scoped spill reads, retention.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@harness/types';
import { createReadTool } from '@harness/tools/fs';
import { deleteThreadSpills, parseSpillRef, readSpillFile, spilledResult, spillPath, sweepSpills, truncateOutput, writeSpill } from '@harness/tools/output';
import { call, makeEnv, T1, T2, type ToolEnv } from './env';

let env: ToolEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

const lines = (n: number) => Array.from({ length: n }, (_, i) => `out ${i + 1}`).join('\n');

describe('truncateOutput', () => {
  it('passes small outputs through', () => {
    expect(truncateOutput('a\nb\n', 'head', 'spill:x')).toEqual({ text: 'a\nb', truncated: false, totalLines: 2, shown: [[1, 2]] });
  });
  it('head mode keeps 2,000 lines with a marker', () => {
    const t = truncateOutput(lines(9_120), 'head', 'spill:tc_X');
    expect(t.truncated).toBe(true);
    expect(t.shown).toEqual([[1, 2_000]]);
    expect(t.text.endsWith('[showing lines 1-2,000 of 9,120; full output: spill:tc_X (use read on it)]')).toBe(true);
  });
  it('shell mode keeps head 200 + tail 800 lines (errors come last)', () => {
    const t = truncateOutput(lines(9_120), 'head_tail', 'spill:tc_X');
    expect(t.shown).toEqual([[1, 200], [8_321, 9_120]]);
    expect(t.text).toContain('out 200\n[… 8,120 lines omitted …]\nout 8321');
    expect(t.text.endsWith('[showing lines 1-200 and 8,321-9,120 of 9,120; full output: spill:tc_X (use read on it)]')).toBe(true);
  });
  it('caps bytes at 50 KiB and lines at 2,000 characters', () => {
    const wide = Array.from({ length: 1_000 }, () => 'w'.repeat(200)).join('\n');
    const t = truncateOutput(wide, 'head', null);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.text)).toBeLessThanOrEqual(51 * 1024);
    const long = truncateOutput(`${'z'.repeat(3_000)}\nok`, 'head', 'spill:s');
    expect(long.text).toContain('… [line truncated]');
    expect(long.text).toContain('[long lines were cut at 2,000 characters; full output: spill:s (use read on it)]');
  });
});

describe('spill files', () => {
  it('are named by the internal id: two calls with the same provider id get two files', async () => {
    const a = env.ctx();
    const b = env.ctx();
    a.call.wireId = 'call_0';
    b.call.wireId = 'call_0';
    const ra = await spilledResult(a, lines(3_000), 'head_tail');
    const rb = await spilledResult(b, `${lines(2_999)}\nother`, 'head_tail');
    expect(ra.spillId).toBe(a.call.id);
    expect(rb.spillId).toBe(b.call.id);
    expect(ra.spillId).not.toBe(rb.spillId);
    expect(ra.content).toContain(`spill:${a.call.id}`);
    expect((await readSpillFile(env.dataDir, T1, a.call.id))?.toString()).toBe(lines(3_000));
    expect((await readSpillFile(env.dataDir, T1, b.call.id))?.toString()).toContain('other');
    expect(ra.preview).toMatchObject({ truncated: true, spillId: a.call.id, totalBytes: Buffer.byteLength(lines(3_000)) });
    expect(ra.preview.text.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('are 0600 in 0700 directories', async () => {
    const id = newId('tc');
    await writeSpill(env.dataDir, T1, id, 'x');
    const file = spillPath(env.dataDir, T1, id) as string;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('no spill when nothing was cut', async () => {
    const r = await spilledResult(env.ctx(), 'short', 'head');
    expect(r).toMatchObject({ ok: true, content: 'short', spillId: null });
  });

  it('read maps spill:<id> within this thread only; malformed ids are refused', async () => {
    const ctx = env.ctx();
    await spilledResult(ctx, lines(5_000), 'head_tail');
    const read = createReadTool({ home: env.home });
    const page = await call(read, { path: `spill:${ctx.call.id}`, offset: 4_999 }, env.ctx());
    expect(page.content).toBe('  4999\tout 4999\n  5000\tout 5000');
    const other = await call(read, { path: `spill:${ctx.call.id}` }, env.ctx({ threadId: T2 }));
    expect(other).toMatchObject({ ok: false, errorKind: 'execution' });
    expect(other.content).toMatch(/No spill file/);
    expect(await call(read, { path: 'spill:../../harness.sqlite' }, env.ctx())).toMatchObject({ ok: false, errorKind: 'invalid_args' });
    expect(parseSpillRef('spill:tc_../../x')).toBe('');
    expect(parseSpillRef('src/a.ts')).toBeNull();
    expect(spillPath(env.dataDir, '../x', ctx.call.id)).toBeNull();
    // The spill directory is not reachable as a normal path either (userData is denied).
    expect(await call(read, { path: spillPath(env.dataDir, T1, ctx.call.id) as string }, env.ctx())).toMatchObject({ ok: false, errorKind: 'denied' });
  });

  it('sweepSpills deletes files older than 7 days; deleteThreadSpills removes a thread', async () => {
    const oldId = newId('tc');
    const newIdv = newId('tc');
    await writeSpill(env.dataDir, T1, oldId, 'old');
    await writeSpill(env.dataDir, T1, newIdv, 'new');
    const old = spillPath(env.dataDir, T1, oldId) as string;
    const tenDaysAgo = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(old, tenDaysAgo, tenDaysAgo);
    expect(await sweepSpills(env.dataDir, Date.now())).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(spillPath(env.dataDir, T1, newIdv) as string)).toBe(true);
    await deleteThreadSpills(env.dataDir, T1);
    expect(fs.existsSync(path.join(env.dataDir, 'spill', T1))).toBe(false);
  });
});
