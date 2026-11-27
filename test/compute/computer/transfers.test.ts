// C2-B: uploads and downloads. Native picker / save dialog from FakePlatform (the renderer never names a host path),
// `mkdir -p` first, the 500 MB limit, `.part` + rename, Range resume only on 206 (a 200 restarts), never an
// executable bit, at most 2 transfers per session, cancel, and `computer:transfer` events.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPLOAD_MAX_BYTES, type TransferInfo } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createExecRunner } from '@main/services/compute/computer/exec';
import { createFileService } from '@main/services/compute/computer/files';
import { DOWNLOAD_ATTEMPTS, TRANSFERS_PER_SESSION, createTransferManager, safeLocalName } from '@main/services/compute/computer/transfers';
import type { DataPlaneApi, DownloadResult } from '@main/services/compute/sandbox/dataplane';
import { createTestContext, type TestContext } from '../../helpers/context';
import { TARGET, execResult, fakeActivity, fakeExecPort, mockStack, scriptedDataPlane } from './c2b-harness';

let tc: TestContext | null = null;
afterEach(async () => {
  await tc?.cleanup();
  tc = null;
});

async function context() {
  tc = await createTestContext();
  const local = join(tc.dir, 'local');
  await mkdir(local, { recursive: true });
  return { tc, local };
}

const bytes = (s: string) => new TextEncoder().encode(s);

/** A body that sends `chunks`, then fails with `fail` (or ends). */
function body(chunks: string[], fail?: Error): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(bytes(chunks[i++] as string));
      else if (fail) c.error(fail);
      else c.close();
    },
  });
}

function scripted(platformCtx: TestContext, download: DataPlaneApi['download'], over: Partial<DataPlaneApi> = {}) {
  const dp = scriptedDataPlane(() => execResult(), { download, ...over });
  const port = fakeExecPort();
  const activity = fakeActivity();
  const runner = createExecRunner({ dataPlane: dp, execPort: port, activity, log: silentLogger });
  const events: TransferInfo[] = [];
  const transfers = createTransferManager({
    runner,
    files: createFileService({ runner, dataPlane: dp, log: silentLogger }),
    dataPlane: dp,
    platform: platformCtx.platform,
    emit: (i) => events.push(i),
    log: silentLogger,
    sleep: async () => undefined,
  });
  return { dp, port, activity, transfers, events };
}

describe('safeLocalName', () => {
  it('keeps a plain basename and strips separators and control characters', () => {
    expect(safeLocalName('report.pdf')).toBe('report.pdf');
    expect(safeLocalName('.bashrc')).toBe('.bashrc');
    expect(safeLocalName('evil\x1b[31m\nname\\..\\x')).toBe('evil[31mname..x');
    expect(safeLocalName('a:b*c?"<>|')).toBe('abc');
    for (const bad of ['', '.', '..', '...', '\x00\x01', '  ']) expect(safeLocalName(bad)).toBe('download');
    expect(safeLocalName('x'.repeat(300))).toHaveLength(200);
  });
});

describe('upload', () => {
  it('a cancelled picker sends nothing and returns null', async () => {
    const { tc } = await context();
    const { transfers, dp } = scripted(tc, async () => Promise.reject(new Error('unused')));
    expect(await transfers.upload(TARGET, '/root')).toBeNull();
    expect(tc.platform.pickers).toEqual([{ kind: 'files', title: 'Upload to /root' }]);
    expect(dp.inputs).toEqual([]);
  });

  it('refuses a bad target folder before showing a picker', async () => {
    const { tc } = await context();
    const { transfers } = scripted(tc, async () => Promise.reject(new Error('unused')));
    await expect(transfers.upload(TARGET, '../etc')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(tc.platform.pickers).toEqual([]);
  });

  it('runs mkdir -p (path in env) first, then stores every picked file in the mock sandbox', async () => {
    const { tc, local } = await context();
    await writeFile(join(local, 'one.txt'), 'first file');
    await writeFile(join(local, 'two words.csv'), 'a,b\n1,2\n');
    tc.platform.nextPickedFiles = [join(local, 'one.txt'), join(local, 'two words.csv')];
    const { runner, dataPlane, port, activity } = mockStack();
    const files = createFileService({ runner, dataPlane, log: silentLogger });
    const events: TransferInfo[] = [];
    const transfers = createTransferManager({ runner, files, dataPlane, platform: tc.platform, emit: (i) => events.push(i), log: silentLogger });

    const infos = await transfers.upload(TARGET, '/root/uploads/new');
    expect(infos?.map((i) => [i.name, i.remotePath, i.totalBytes, i.direction])).toEqual([
      ['one.txt', '/root/uploads/new/one.txt', 10, 'upload'],
      ['two words.csv', '/root/uploads/new/two words.csv', 8, 'upload'],
    ]);
    await transfers.idle();
    expect(transfers.list(TARGET.sessionId).map((t) => t.state)).toEqual(['done', 'done']);
    // mkdir -p + one per file.
    expect(activity.records.map((r) => r.activity.kind)).toEqual(['transfer', 'transfer', 'transfer']);
    expect((await files.readFile(TARGET, '/root/uploads/new/two words.csv')).text).toBe('a,b\n1,2\n');
    expect(port.inUse).toBe(0);
    // No local path ever leaves main: names only.
    for (const e of events) expect(JSON.stringify(e)).not.toContain(local);
    expect(new Set(events.map((e) => e.state))).toEqual(new Set(['queued', 'running', 'done']));
  });

  it('the mkdir goes through env before the first POST', async () => {
    const { tc, local } = await context();
    await writeFile(join(local, 'a.bin'), 'x');
    tc.platform.nextPickedFiles = [join(local, 'a.bin')];
    const order: string[] = [];
    const { transfers, dp } = scripted(tc, async () => Promise.reject(new Error('unused')), {
      async writeFile(_s, path) {
        order.push(`write ${path}`);
        return [{ path, name: 'a.bin', type: 'file' }];
      },
    });
    const origStart = dp.startExec;
    dp.startExec = async (s, input) => (order.push(`exec ${input.command} ${JSON.stringify(input.envs)}`), origStart(s, input));
    await transfers.upload(TARGET, '/srv/my "dir"');
    await transfers.idle();
    expect(order).toEqual(['exec mkdir -p "$GMID_P" {"GMID_P":"/srv/my \\"dir\\""}', 'write /srv/my "dir"/a.bin']);
  });

  it('a file over 500 MB fails with a hint and nothing is sent', async () => {
    const { tc, local } = await context();
    const big = join(local, 'huge.iso');
    await writeFile(big, '');
    await truncate(big, UPLOAD_MAX_BYTES + 1);
    tc.platform.nextPickedFiles = [big];
    let writes = 0;
    const { transfers, dp } = scripted(tc, async () => Promise.reject(new Error('unused')), {
      async writeFile() {
        writes += 1;
        return [];
      },
    });
    const infos = await transfers.upload(TARGET, '/root');
    expect(infos?.[0]).toMatchObject({ state: 'failed', name: 'huge.iso', error: { code: 'invalid_input' } });
    expect(infos?.[0]?.error?.message).toMatch(/500 MB/);
    await transfers.idle();
    expect(writes).toBe(0);
    expect(dp.inputs).toEqual([]);
  });

  it('507 means the sandbox disk is full; 413 too large', async () => {
    const { tc, local } = await context();
    await writeFile(join(local, 'a'), 'x');
    await writeFile(join(local, 'b'), 'y');
    tc.platform.nextPickedFiles = [join(local, 'a'), join(local, 'b')];
    let n = 0;
    const { transfers } = scripted(tc, async () => Promise.reject(new Error('unused')), {
      async writeFile() {
        n += 1;
        throw new GmiError('upstream', 'x', { status: n === 1 ? 507 : 413 });
      },
    });
    await transfers.upload(TARGET, '/root');
    await transfers.idle();
    expect(transfers.list().map((t) => [t.state, t.error?.code, t.error?.message])).toEqual([
      ['failed', 'quota_exceeded', 'The sandbox disk is full.'],
      ['failed', 'invalid_input', expect.stringMatching(/500 MB/)],
    ]);
  });
});

describe('download', () => {
  it('a cancelled save dialog returns null; the default name is the sanitised basename', async () => {
    const { tc } = await context();
    const { transfers } = scripted(tc, async () => Promise.reject(new Error('unused')));
    expect(await transfers.download(TARGET, '/root/in\x07voice\\2026.pdf')).toBeNull();
    expect(tc.platform.pickers).toEqual([{ kind: 'save', title: 'Download from the sandbox' }]);
    await expect(transfers.download(TARGET, '/')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(transfers.download(TARGET, '/root/../etc/passwd')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('passes the sanitised default name to the native dialog', async () => {
    const { tc } = await context();
    const names: string[] = [];
    const platform = { ...tc.platform, pickSavePath: async (o: { title: string; defaultName: string }) => (names.push(o.defaultName), null) };
    const dp = scriptedDataPlane(() => execResult());
    const runner = createExecRunner({ dataPlane: dp, execPort: fakeExecPort(), activity: fakeActivity(), log: silentLogger });
    const transfers = createTransferManager({ runner, files: createFileService({ runner, dataPlane: dp, log: silentLogger }), dataPlane: dp, platform, emit: () => undefined, log: silentLogger });
    await transfers.download(TARGET, '/root/in\x07voice\\2026.pdf');
    await transfers.download(TARGET, '/root/..bashrc');
    expect(names).toEqual(['invoice2026.pdf', '..bashrc']);
  });

  it('from the mock sandbox: writes <dest>.part, renames it, never executable', async () => {
    const { tc, local } = await context();
    const dest = join(local, 'main.py');
    tc.platform.nextSavePath = dest;
    const { runner, dataPlane, activity } = mockStack();
    const transfers = createTransferManager({ runner, files: createFileService({ runner, dataPlane, log: silentLogger }), dataPlane, platform: tc.platform, emit: () => undefined, log: silentLogger });
    const info = await transfers.download(TARGET, '/root/app/main.py');
    expect(info).toMatchObject({ direction: 'download', name: 'main.py', remotePath: '/root/app/main.py' });
    await transfers.idle();
    expect(transfers.get(info?.transferId ?? '')).toMatchObject({ state: 'done', bytes: 46, totalBytes: 46 });
    expect(await readFile(dest, 'utf8')).toBe('print("hello from the GMI Desk demo sandbox")\n');
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect((await stat(dest)).mode & 0o111).toBe(0);
    expect(activity.records.map((r) => r.activity.kind)).toEqual(['transfer']);
  });

  it('streams into .part; the destination appears only when complete', async () => {
    const { tc, local } = await context();
    const dest = join(local, 'out.bin');
    tc.platform.nextSavePath = dest;
    const seen: Array<{ part: boolean; dest: boolean }> = [];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        seen.push({ part: existsSync(`${dest}.part`), dest: existsSync(dest) });
        if (i++ < 3) c.enqueue(bytes('abc'));
        else c.close();
      },
    });
    const { transfers } = scripted(tc, async () => ({ status: 200, body: stream, resumed: false, acceptRanges: false, totalBytes: 9 }));
    await transfers.download(TARGET, '/data/out.bin');
    await transfers.idle();
    expect(seen.slice(1).every((s) => s.part && !s.dest)).toBe(true);
    expect(await readFile(dest, 'utf8')).toBe('abcabcabc');
  });

  it('resumes with Range only on a 206 after the server advertised Accept-Ranges', async () => {
    const { tc, local } = await context();
    const dest = join(local, 'big.tar');
    tc.platform.nextSavePath = dest;
    const offsets: number[] = [];
    const { transfers } = scripted(tc, async (_s, _p, o): Promise<DownloadResult> => {
      offsets.push(o?.offset ?? 0);
      if (offsets.length === 1) return { status: 200, body: body(['01234'], new GmiError('network', 'reset')), resumed: false, acceptRanges: true, totalBytes: 10 };
      return { status: 206, body: body(['56789']), resumed: true, acceptRanges: true, totalBytes: 10 };
    });
    await transfers.download(TARGET, '/data/big.tar');
    await transfers.idle();
    expect(offsets).toEqual([0, 5]);
    expect(await readFile(dest, 'utf8')).toBe('0123456789');
  });

  it('a 200 to a Range request restarts from zero (no duplicated bytes)', async () => {
    const { tc, local } = await context();
    const dest = join(local, 'f');
    tc.platform.nextSavePath = dest;
    const offsets: number[] = [];
    const { transfers } = scripted(tc, async (_s, _p, o): Promise<DownloadResult> => {
      offsets.push(o?.offset ?? 0);
      if (offsets.length === 1) return { status: 200, body: body(['0123'], new GmiError('network', 'reset')), resumed: false, acceptRanges: true, totalBytes: 10 };
      return { status: 200, body: body(['01234', '56789']), resumed: false, acceptRanges: true, totalBytes: 10 };
    });
    await transfers.download(TARGET, '/f');
    await transfers.idle();
    expect(offsets).toEqual([0, 4]);
    expect(await readFile(dest, 'utf8')).toBe('0123456789');
  });

  it('without Accept-Ranges a retry starts from zero; gives up after the attempts and leaves no .part', async () => {
    const { tc, local } = await context();
    const dest = join(local, 'g');
    tc.platform.nextSavePath = dest;
    const offsets: number[] = [];
    const { transfers } = scripted(tc, async (_s, _p, o): Promise<DownloadResult> => {
      offsets.push(o?.offset ?? 0);
      return { status: 200, body: body(['xx'], new GmiError('network', 'reset')), resumed: false, acceptRanges: false, totalBytes: 10 };
    });
    const info = await transfers.download(TARGET, '/g');
    await transfers.idle();
    expect(offsets).toEqual(Array(DOWNLOAD_ATTEMPTS).fill(0));
    expect(transfers.get(info?.transferId ?? '')).toMatchObject({ state: 'failed', error: { code: 'network' } });
    expect(await readdir(local)).toEqual([]);
  });

  it('a 404 is not retried', async () => {
    const { tc, local } = await context();
    tc.platform.nextSavePath = join(local, 'h');
    let calls = 0;
    const { transfers } = scripted(tc, async () => {
      calls += 1;
      throw new GmiError('not_found', 'File.NotFound', { status: 404 });
    });
    const info = await transfers.download(TARGET, '/h');
    await transfers.idle();
    expect(calls).toBe(1);
    expect(transfers.get(info?.transferId ?? '')?.error?.code).toBe('not_found');
  });

  it('an earlier executable .part never makes the download executable', async () => {
    const { tc, local } = await context();
    const dest = join(local, 'run.sh');
    await writeFile(`${dest}.part`, 'old');
    await chmod(`${dest}.part`, 0o755);
    tc.platform.nextSavePath = dest;
    const { transfers } = scripted(tc, async () => ({ status: 200, body: body(['#!/bin/sh\n']), resumed: false, acceptRanges: false, totalBytes: null }));
    await transfers.download(TARGET, '/root/run.sh');
    await transfers.idle();
    expect(await readFile(dest, 'utf8')).toBe('#!/bin/sh\n');
    expect((await stat(dest)).mode & 0o111).toBe(0);
  });
});

describe('queue and cancel', () => {
  /** Downloads whose bodies stay open until aborted. */
  function hanging() {
    let started = 0;
    const download: DataPlaneApi['download'] = async (_s, _p, o) => {
      started += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes('partial'));
          o?.signal?.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        },
      });
      return { status: 200, body: stream, resumed: false, acceptRanges: false, totalBytes: 100 };
    };
    return { download, started: () => started };
  }
  const flush = () => new Promise((r) => setTimeout(r, 10));
  /** Polls instead of a fixed sleep: a loaded full run can take longer than 10 ms to start a transfer. */
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 500 && !done(); i += 1) await flush();
  };

  it('runs at most 2 transfers per session, each holding one exec slot; cancel frees the queue', async () => {
    const { tc, local } = await context();
    const h = hanging();
    const { transfers, port, events } = scripted(tc, h.download);
    const ids: string[] = [];
    for (const n of ['a', 'b', 'c']) {
      tc.platform.nextSavePath = join(local, n);
      ids.push((await transfers.download(TARGET, `/x/${n}`))?.transferId ?? '');
    }
    await settle(() => h.started() >= 2);
    await flush(); // a third start would show up now if the per-session cap leaked
    expect(TRANSFERS_PER_SESSION).toBe(2);
    expect(transfers.list().map((t) => t.state)).toEqual(['running', 'running', 'queued']);
    expect(h.started()).toBe(2);
    expect(port.inUse).toBe(2);

    // Another session is not blocked by this one's queue.
    tc.platform.nextSavePath = join(local, 'other');
    await transfers.download({ ...TARGET, sessionId: 'cs_other' }, '/x/other');
    await settle(() => h.started() >= 3);
    expect(h.started()).toBe(3);

    await transfers.cancel(ids[2] as string);
    expect(transfers.get(ids[2] as string)?.state).toBe('cancelled');
    await transfers.cancel(ids[0] as string);
    // The running download unwinds asynchronously (stream abort, .part removal): wait for it, not a fixed 10 ms,
    // which failed under a loaded full run.
    for (let i = 0; i < 200 && transfers.get(ids[0] as string)?.state !== 'cancelled'; i += 1) await flush();
    expect(transfers.get(ids[0] as string)?.state).toBe('cancelled');
    expect(existsSync(join(local, 'a'))).toBe(false);
    expect(existsSync(join(local, 'a.part'))).toBe(false);
    expect(h.started()).toBe(3);

    transfers.closeSession(TARGET.sessionId);
    transfers.closeSession('cs_other');
    await transfers.idle();
    expect(port.inUse).toBe(0);
    expect(events.filter((e) => e.state === 'cancelled').map((e) => e.remotePath).sort()).toEqual(['/x/a', '/x/b', '/x/c', '/x/other']);
    await expect(transfers.cancel('tr_unknown')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('dispose cancels everything and waits', async () => {
    const { tc, local } = await context();
    const h = hanging();
    const { transfers, port } = scripted(tc, h.download);
    tc.platform.nextSavePath = join(local, 'z');
    await transfers.download(TARGET, '/z');
    await flush();
    await transfers.dispose();
    expect(port.inUse).toBe(0);
    expect(await readdir(local)).toEqual([]);
  });
});
