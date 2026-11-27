// C2-B: the file browser. Paths reach the sandbox only through exec envs (asserted on the real request bodies), the
// normaliser rejects `..`, NUL and relative paths, the NUL listing parser and its busybox fallback, binary detection,
// size limits, and the mock simulator's fake filesystem end to end.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILE_PREVIEW_MAX_BYTES, FILE_WRITE_MAX_BYTES } from '@shared/contracts/compute';
import { silentLogger } from '@main/core/logger';
import { createExecRunner } from '@main/services/compute/computer/exec';
import {
  LIST_COMMAND,
  LIST_FALLBACK_COMMAND,
  LIST_MAX_ENTRIES,
  createFileService,
  decodeText,
  joinRemote,
  normalizeRemotePath,
  parseListing,
  remoteBasename,
  remoteParent,
} from '@main/services/compute/computer/files';
import { createDataPlane, createTokenCache } from '@main/services/compute/sandbox/dataplane';
import type { V2ConnectResult } from '@main/services/compute/sandbox/dto';
import { fakeHttp, instantSleep, json } from '../fakes';
import { TARGET, execResult, fakeActivity, fakeExecPort, mockStack, scriptedDataPlane } from './c2b-harness';

describe('normalizeRemotePath', () => {
  it('normalises absolute POSIX paths', () => {
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('/root/app/')).toBe('/root/app');
    expect(normalizeRemotePath('//root//./app/.')).toBe('/root/app');
    expect(normalizeRemotePath('/root/my file "x"; $(id)')).toBe('/root/my file "x"; $(id)');
  });

  it.each([
    ['relative', 'root/app'],
    ['tilde', '~/app'],
    ['empty', ''],
    ['dot-dot', '/root/../etc'],
    ['trailing dot-dot', '/root/..'],
    ['NUL', '/root/a\0b'],
  ])('rejects %s paths', (_label, path) => {
    expect(() => normalizeRemotePath(path)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('rejects non-strings and paths over 4,096 bytes', () => {
    expect(() => normalizeRemotePath(42)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => normalizeRemotePath(`/${'a'.repeat(4096)}`)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(normalizeRemotePath(`/${'a'.repeat(4095)}`)).toHaveLength(4096);
  });

  it('joins single names only', () => {
    expect(joinRemote('/', 'etc')).toBe('/etc');
    expect(joinRemote('/root', '.bashrc')).toBe('/root/.bashrc');
    for (const bad of ['', '.', '..', 'a/b', 'a\0b']) expect(() => joinRemote('/root', bad)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(remoteBasename('/root/app/x.py')).toBe('x.py');
    expect(remoteParent('/root/app')).toBe('/root');
    expect(remoteParent('/root')).toBe('/');
  });
});

describe('parseListing', () => {
  const rec = (t: string, size: number, mtime: string, mode: string, name: string) => `${t}\t${size}\t${mtime}\t${mode}\t${name}\0`;

  it('parses NUL-separated records; names keep tabs, newlines and spaces; directories first', () => {
    const out =
      rec('f', 12, '1730538000.2500000000', '644', 'b file.txt') +
      rec('d', 4096, '1730538000', '755', 'src') +
      rec('l', 7, '1730538000', '777', 'link') +
      rec('f', 3, '1730538000', '600', 'tab\there\nnewline') +
      rec('p', 0, '1730538000', '644', 'fifo') +
      rec('d', 4096, '1730538000', '755', '.') +
      rec('d', 4096, '1730538000', '755', '..');
    const listing = parseListing('/root', out);
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((e) => e.name)).toEqual(['src', 'b file.txt', 'fifo', 'link', 'tab\there\nnewline']);
    expect(listing.entries[0]).toEqual({ name: 'src', path: '/root/src', type: 'dir', size: null, mtime: '2024-11-02T09:00:00.000Z', mode: '755' });
    expect(listing.entries[1]).toMatchObject({ type: 'file', size: 12, mtime: '2024-11-02T09:00:00.250Z', mode: '644', path: '/root/b file.txt' });
    expect(listing.entries.find((e) => e.name === 'fifo')?.type).toBe('other');
    expect(listing.entries.find((e) => e.name === 'link')?.type).toBe('symlink');
  });

  it('drops a cut final record when GMI truncated stdout, and marks the listing truncated', () => {
    const listing = parseListing('/', `${rec('f', 1, '1', '644', 'whole')}f\t1\t1\t64`, { outputTruncated: true });
    expect(listing.entries.map((e) => e.name)).toEqual(['whole']);
    expect(listing.truncated).toBe(true);
  });

  it('caps at 5,000 entries', () => {
    let out = '';
    for (let i = 0; i < LIST_MAX_ENTRIES + 3; i += 1) out += rec('f', 1, '1', '644', `f${i}`);
    const listing = parseListing('/tmp', out);
    expect(listing.entries).toHaveLength(LIST_MAX_ENTRIES);
    expect(listing.truncated).toBe(true);
  });

  it('tolerates the fallback format (integer mtimes, empty stat fields)', () => {
    const listing = parseListing('/srv', `d\t4096\t1730538000\t755\tsite\0o\t\t\t\tsock\0`);
    expect(listing.entries).toEqual([
      { name: 'site', path: '/srv/site', type: 'dir', size: null, mtime: '2024-11-02T09:00:00.000Z', mode: '755' },
      { name: 'sock', path: '/srv/sock', type: 'other', size: null, mtime: null, mode: null },
    ]);
  });
});

describe('paths travel only in envs (real data plane request bodies)', () => {
  const HOST = 'mk1.iowa2.sandbox.example';
  const connect = async (): Promise<V2ConnectResult> => ({
    id: 'sbx-1',
    sandbox_key: 'mk1',
    domain: 'iowa2.sandbox.example',
    sandbox_access_token: 'sat-test',
    traffic_access_token: 'tat-test',
    end_at: '2099-01-01T00:00:00Z',
  });
  const hostile = '/root/a"; rm -rf / #$(id)`x`\'b';

  function setup() {
    const fake = fakeHttp([
      { match: `${HOST}/executions`, method: 'POST', respond: () => json({ request_id: 'r', execution_id: 'exe-1', sandbox_id: 'mk1', status: 'succeeded', exit_code: 0, stdout: '', stderr: '' }) },
      { match: `${HOST}/files`, method: 'GET', respond: () => new Response('hello', { status: 200, headers: { 'content-length': '5' } }) },
      { match: `${HOST}/files`, method: 'POST', respond: () => json([{ path: hostile, name: 'x', type: 'file' }]) },
    ]);
    const tokens = createTokenCache({ connect });
    const dataPlane = createDataPlane({ http: fake.http, log: silentLogger, tokens, sleep: instantSleep().sleep });
    const runner = createExecRunner({ dataPlane, execPort: fakeExecPort(), activity: fakeActivity(), log: silentLogger });
    const files = createFileService({ runner, dataPlane, log: silentLogger });
    const target = { ...TARGET, sandboxId: 'sbx-1' };
    return { files, target, ...fake };
  }

  it('listDir, makeDir, movePath, removePath and ensureDir never put a path into the command', async () => {
    const { files, target, requests } = setup();
    await files.listDir(target, hostile);
    await files.makeDir(target, hostile);
    await files.movePath(target, hostile, '/root/new name');
    await files.removePath(target, hostile);
    await files.ensureDir(target, hostile);
    const bodies = requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body ?? '{}') as { parameters: { command: string; envs: Record<string, string>; execution_timeout_seconds: number } });
    expect(bodies).toHaveLength(5);
    for (const b of bodies) {
      expect(b.parameters.command).not.toContain('rm -rf /');
      expect(b.parameters.command).not.toContain('/root');
      expect(Object.values(b.parameters.envs)).toContain(hostile);
      expect(b.parameters.execution_timeout_seconds).toBe(30);
    }
    expect(bodies[0]?.parameters).toMatchObject({ command: LIST_COMMAND, envs: { GMID_P: hostile } });
    expect(bodies[2]?.parameters).toMatchObject({ command: 'mv "$GMID_FROM" "$GMID_TO"', envs: { GMID_FROM: hostile, GMID_TO: '/root/new name' } });
    expect(bodies[3]?.parameters.command).toBe('rm -rf "$GMID_P"');
  });

  it('readFile and writeFile pass the path as an encoded query parameter on the exact host', async () => {
    const { files, target, requests } = setup();
    const content = await files.readFile(target, hostile);
    expect(content).toEqual({ path: hostile, size: 5, text: 'hello', binary: false, truncated: false });
    await files.writeFile(target, hostile, 'saved');
    for (const r of requests) {
      const url = new URL(r.url);
      expect(url.host).toBe(HOST);
      expect(url.searchParams.get('path')).toBe(hostile);
    }
  });

  it('refuses a relative or traversing path before any request', async () => {
    const { files, target, requests } = setup();
    await expect(files.listDir(target, 'root')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(files.readFile(target, '/root/../etc/shadow')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(files.removePath(target, '/tmp/\0x')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toEqual([]);
  });
});

describe('listing with a scripted sandbox', () => {
  const runnerFor = (dp: ReturnType<typeof scriptedDataPlane>) => {
    const activity = fakeActivity();
    const runner = createExecRunner({ dataPlane: dp, execPort: fakeExecPort(), activity, log: silentLogger });
    return { files: createFileService({ runner, dataPlane: dp, log: silentLogger }), activity };
  };

  it('falls back to the stat loop when find has no -printf (busybox), with the same env', async () => {
    const dp = scriptedDataPlane((input, i) =>
      i === 0
        ? execResult({ status: 'failed', exit_code: 1, stderr: 'find: unrecognized: -printf\nBusyBox v1.36.1 multi-call binary.' })
        : execResult({ stdout: 'd\t4096\t1730538000\t755\tapp\0f\t10\t1730538000\t644\tREADME\0' }),
    );
    const { files } = runnerFor(dp);
    const listing = await files.listDir(TARGET, '/root');
    expect(listing.entries.map((e) => [e.name, e.type])).toEqual([
      ['app', 'dir'],
      ['README', 'file'],
    ]);
    expect(dp.inputs.map((i) => i.command)).toEqual([LIST_COMMAND, LIST_FALLBACK_COMMAND]);
    expect(dp.inputs[1]?.envs).toEqual({ GMID_P: '/root' });
    expect(LIST_FALLBACK_COMMAND).not.toContain('/root');
  });

  it('a missing folder is not_found; an empty folder is an empty listing; listing is never activity', async () => {
    const dp = scriptedDataPlane((_input, i) =>
      i === 0 ? execResult({ status: 'failed', exit_code: 1, stderr: "find: '/nope': No such file or directory" }) : execResult({ stdout: '' }),
    );
    const { files, activity } = runnerFor(dp);
    await expect(files.listDir(TARGET, '/nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(files.listDir(TARGET, '/empty')).resolves.toEqual({ path: '/empty', entries: [], truncated: false });
    expect(dp.inputs).toHaveLength(2);
    expect(activity.records).toEqual([]);
  });

  it('marks the listing truncated when GMI cut stdout', async () => {
    const dp = scriptedDataPlane(() => execResult({ stdout: 'f\t1\t1\t644\ta\0f\t1\t1', stdout_truncated: true }));
    const { files } = runnerFor(dp);
    const listing = await files.listDir(TARGET, '/big');
    expect(listing).toMatchObject({ truncated: true, entries: [{ name: 'a' }] });
  });
});

describe('content', () => {
  it('detects binary by a NUL in the first 8 KiB or invalid UTF-8; a cut final character is still text', () => {
    expect(decodeText(new Uint8Array([0x68, 0x00, 0x69]), false)).toEqual({ text: null, binary: true });
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]), false)).toEqual({ text: null, binary: true });
    const euro = new TextEncoder().encode('price €');
    expect(decodeText(euro.subarray(0, euro.length - 1), true)).toEqual({ text: 'price ', binary: false });
    expect(decodeText(euro.subarray(0, euro.length - 1), false).binary).toBe(true);
    const late = new Uint8Array(9000).fill(0x61);
    late[8500] = 0;
    expect(decodeText(late, false).binary).toBe(false);
  });

  it('reads at most 2 MiB, whatever the renderer asks', async () => {
    const asked: number[] = [];
    const dp = scriptedDataPlane(() => execResult(), {
      async readFile(_s, _p, opts) {
        asked.push(opts?.maxBytes ?? -1);
        return { bytes: new Uint8Array([0x61]), size: 50_000_000, truncated: true };
      },
    });
    const activity = fakeActivity();
    const files = createFileService({ runner: createExecRunner({ dataPlane: dp, execPort: fakeExecPort(), activity, log: silentLogger }), dataPlane: dp, log: silentLogger });
    const c = await files.readFile(TARGET, '/root/big.log', { maxBytes: 10 * FILE_PREVIEW_MAX_BYTES });
    expect(asked).toEqual([FILE_PREVIEW_MAX_BYTES]);
    expect(c).toMatchObject({ size: 50_000_000, truncated: true, text: 'a', binary: false });
    expect(activity.records).toEqual([{ resourceId: TARGET.resourceId, activity: { kind: 'file_op' } }]);
  });

  it('refuses to save more than 1 MiB before any request', async () => {
    const dp = scriptedDataPlane(() => execResult());
    const files = createFileService({ runner: createExecRunner({ dataPlane: dp, execPort: fakeExecPort(), activity: fakeActivity(), log: silentLogger }), dataPlane: dp, log: silentLogger });
    await expect(files.writeFile(TARGET, '/root/x', 'a'.repeat(FILE_WRITE_MAX_BYTES + 1))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('never deletes / or the home folder, never moves a folder into itself', async () => {
    const dp = scriptedDataPlane(() => execResult());
    const files = createFileService({ runner: createExecRunner({ dataPlane: dp, execPort: fakeExecPort(), activity: fakeActivity(), log: silentLogger }), dataPlane: dp, log: silentLogger });
    await expect(files.removePath(TARGET, '/')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(files.removePath(TARGET, '/root/', { home: '/root' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(files.movePath(TARGET, '/root/app', '/root/app/sub')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(files.movePath(TARGET, '/', '/x')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(dp.inputs).toEqual([]);
  });
});

describe('against the mock simulator (fake filesystem)', () => {
  it('lists, creates, writes, reads, renames and deletes', async () => {
    const { runner, dataPlane, port, activity } = mockStack();
    const files = createFileService({ runner, dataPlane, log: silentLogger });
    const app = await files.listDir(TARGET, '/root/app');
    expect(app.entries.map((e) => e.name)).toEqual(['README.md', 'index.html', 'main.py']);
    expect(app.entries[0]).toMatchObject({ type: 'file', path: '/root/app/README.md', mode: '644' });
    expect((await files.listDir(TARGET, '/root')).entries[0]).toMatchObject({ name: 'app', type: 'dir' });

    await files.makeDir(TARGET, '/root/new dir/deep');
    await files.writeFile(TARGET, '/root/new dir/deep/notes.txt', 'hello sandbox\n');
    expect(await files.readFile(TARGET, '/root/new dir/deep/notes.txt')).toMatchObject({ text: 'hello sandbox\n', binary: false, size: 14 });
    await files.movePath(TARGET, '/root/new dir/deep/notes.txt', '/root/notes.txt');
    expect((await files.listDir(TARGET, '/root')).entries.map((e) => e.name)).toEqual(['app', 'new dir', 'notes.txt']);
    await files.removePath(TARGET, '/root/new dir', { home: '/root' });
    expect((await files.listDir(TARGET, '/root')).entries.map((e) => e.name)).toEqual(['app', 'notes.txt']);
    await expect(files.listDir(TARGET, '/root/missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(files.readFile(TARGET, '/root/missing.txt')).rejects.toMatchObject({ code: 'not_found' });

    // Every slot was released; only user file operations were activity.
    expect(port.inUse).toBe(0);
    expect(activity.records.every((r) => r.activity.kind === 'file_op')).toBe(true);
    expect(activity.records).toHaveLength(6); // mkdir, write, read, mv, rm, the failed read
  });
});

describe('the listing commands in real shells (this machine)', () => {
  const shells: Array<[string, string[]]> = [['sh', ['-c']]];
  if (existsSync('/usr/bin/busybox') || existsSync('/bin/busybox')) shells.push(['busybox', ['sh', '-c']]);

  it.each(shells)('%s: find -printf (where supported) and the stat fallback give the same entries', async (shell, args) => {
    const dir = await mkdtemp(join(tmpdir(), 'gmid-list-'));
    try {
      await mkdir(join(dir, 'sub dir'));
      await writeFile(join(dir, 'a b.txt'), 'hello');
      await writeFile(join(dir, '.hidden'), '');
      await writeFile(join(dir, 'tab\tname'), 'x');
      await writeFile(join(dir, '$(id) "q"'), 'x');
      await symlink('a b.txt', join(dir, 'link'));
      const run = (command: string) => {
        const r = spawnSync(shell, [...args, command], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GMID_P: dir }, encoding: 'utf8' });
        return { stdout: r.stdout, stderr: r.stderr, status: r.status };
      };
      const fallback = parseListing(dir, run(LIST_FALLBACK_COMMAND).stdout);
      const names = ['sub dir', '$(id) "q"', '.hidden', 'a b.txt', 'link', 'tab\tname'];
      expect(fallback.entries.map((e) => e.name)).toEqual(names);
      expect(fallback.entries.find((e) => e.name === 'a b.txt')).toMatchObject({ type: 'file', size: 5, mode: expect.stringMatching(/^[0-7]{3}$/) });
      expect(fallback.entries.find((e) => e.name === 'link')?.type).toBe('symlink');
      expect(fallback.entries.find((e) => e.name === 'sub dir')?.type).toBe('dir');
      const primary = run(shell === 'busybox' ? `busybox ${LIST_COMMAND}` : LIST_COMMAND);
      if (primary.status === 0) {
        const listing = parseListing(dir, primary.stdout);
        expect(listing.entries.map((e) => [e.name, e.type, e.size])).toEqual(fallback.entries.map((e) => [e.name, e.type, e.size]));
      } else {
        // busybox find: this is exactly what makes listDir run the fallback.
        expect(primary.stderr).toMatch(/printf|unrecognized/i);
      }
      const missing = spawnSync(shell, [...args, LIST_FALLBACK_COMMAND], { env: { PATH: process.env.PATH ?? '', GMID_P: join(dir, 'nope') }, encoding: 'utf8' });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/No such file or directory/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
