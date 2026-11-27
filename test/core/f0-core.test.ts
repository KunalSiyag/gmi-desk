// F0 core: durableWriteFile, logger redaction of the compute/harness key names, installId, quit checks.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_ID_PATTERN, loadInstallId } from '@main/core/install-id';
import { createLogger, sanitize, silentLogger } from '@main/core/logger';
import { FALLBACK_SAVE_NAME, safeSaveName } from '@main/core/save-path';
import { createQuitGuard, registeredQuitChecks, registerQuitCheck, runQuitChecks, type QuitCheck } from '@main/core/shutdown';
import { durableWriteFile, type DurableFs } from '@main/core/store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmi-desk-f0-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Records every operation in order; `failAt` makes one operation throw. */
function fakeFs(opts: { failAt?: string; dirOpenError?: string } = {}) {
  const ops: string[] = [];
  const step = async (op: string) => {
    ops.push(op);
    if (opts.failAt && op.startsWith(opts.failAt)) throw Object.assign(new Error(`boom ${op}`), { code: 'EIO' });
  };
  const fs: DurableFs = {
    mkdir: async (path) => step(`mkdir ${path}`),
    async open(path, flags) {
      const isDir = flags === 'r';
      await step(`open ${isDir ? 'dir' : 'tmp'}`);
      if (isDir && opts.dirOpenError) {
        ops.pop();
        ops.push('open dir (refused)');
        throw Object.assign(new Error('no dir open'), { code: opts.dirOpenError });
      }
      const label = isDir ? 'dir' : 'tmp';
      return {
        writeFile: () => step(`write ${label}`),
        sync: () => step(`sync ${label}`),
        close: () => step(`close ${label}`),
      };
    },
    rename: () => step('rename'),
    rm: () => step('rm tmp'),
  };
  return { fs, ops };
}

describe('durableWriteFile', () => {
  it('writes the temp file, syncs it, renames it, then fsyncs the directory (in that order)', async () => {
    const { fs, ops } = fakeFs();
    await durableWriteFile('/data/x/ledger.json', '{}', 0o600, fs);
    expect(ops).toEqual(['mkdir /data/x', 'open tmp', 'write tmp', 'sync tmp', 'close tmp', 'rename', 'open dir', 'sync dir', 'close dir']);
  });

  it('a failed write or sync never renames and removes the temp file', async () => {
    for (const failAt of ['write tmp', 'sync tmp']) {
      const { fs, ops } = fakeFs({ failAt });
      await expect(durableWriteFile('/d/f.json', 'x', undefined, fs)).rejects.toThrow(/boom/);
      expect(ops).not.toContain('rename');
      expect(ops).toContain('close tmp');
      expect(ops.at(-1)).toBe('rm tmp');
    }
  });

  it('a failed rename removes the temp file and rejects', async () => {
    const { fs, ops } = fakeFs({ failAt: 'rename' });
    await expect(durableWriteFile('/d/f.json', 'x', undefined, fs)).rejects.toThrow(/boom/);
    expect(ops.slice(-2)).toEqual(['rename', 'rm tmp']);
  });

  it('platforms that cannot open a directory (EISDIR/EPERM) skip the directory fsync; other errors surface', async () => {
    const ok = fakeFs({ dirOpenError: 'EISDIR' });
    await durableWriteFile('/d/f.json', 'x', undefined, ok.fs);
    expect(ok.ops.slice(-2)).toEqual(['rename', 'open dir (refused)']);
    const bad = fakeFs({ failAt: 'sync dir' });
    await expect(durableWriteFile('/d/f.json', 'x', undefined, bad.fs)).rejects.toThrow(/boom/);
    expect(bad.ops.at(-1)).toBe('close dir');
  });

  it('on the real file system: content and mode land, no temp file is left', async () => {
    const file = join(dir, 'nested', 'journal.json');
    await durableWriteFile(file, '{"a":1}', 0o600);
    await durableWriteFile(file, '{"a":2}', 0o600);
    expect(await readFile(file, 'utf8')).toBe('{"a":2}');
    expect(await readdir(join(dir, 'nested'))).toEqual(['journal.json']);
  });
});

describe('logger redaction (compute/harness key names)', () => {
  const SECRET = 'not-a-real-secret-value-1234';

  it('sanitize redacts the new secret-bearing keys at any depth', () => {
    const out = sanitize({
      urlPath: SECRET,
      connect_url: SECRET,
      access_token: SECRET,
      trafficAccessToken: SECRET,
      traffic: SECRET,
      private_key: SECRET,
      privateKey: SECRET,
      sshKey: SECRET,
      ssh_key: SECRET,
      env_vars: [{ name: 'A', value: SECRET }],
      nested: { deeper: { connectUrl: SECRET, url_path: SECRET, envVars: SECRET } },
      resourceId: 'cr_123',
      phase: 'running',
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out).toMatchObject({ resourceId: 'cr_123', phase: 'running', urlPath: '[redacted]', env_vars: '[redacted]' });
  });

  it('JWT-shaped values are redacted inside strings too', () => {
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
    expect(sanitize({ note: `token=${jwt}` })).toEqual({ note: expect.not.stringContaining(jwt) });
  });

  it('the file log never contains the values', async () => {
    const file = join(dir, 'main.log');
    const log = createLogger({ file, console: false });
    log.info('sandbox connect', { sandboxId: 'sb_1', connect_url: `wss://x/${SECRET}`, data: { urlPath: SECRET } });
    await vi.waitFor(async () => expect(await readFile(file, 'utf8').catch(() => '')).toContain('sandbox connect'));
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('sb_1');
  });
});

describe('installId', () => {
  it('is 32 hex characters, persisted in data/install.json and stable across starts', async () => {
    const data = join(dir, 'data');
    const first = await loadInstallId(data);
    expect(first).toMatch(INSTALL_ID_PATTERN);
    expect(first).toHaveLength(32);
    const onDisk = JSON.parse(await readFile(join(data, 'install.json'), 'utf8')) as { installId: string; createdAt: string };
    expect(onDisk.installId).toBe(first);
    expect(Number.isNaN(Date.parse(onDisk.createdAt))).toBe(false);
    expect(await loadInstallId(data)).toBe(first);
  });

  it('differs per install', async () => {
    expect(await loadInstallId(join(dir, 'a'))).not.toBe(await loadInstallId(join(dir, 'b')));
  });

  it('replaces a malformed file but moves it aside first (its id stays recoverable for adopt)', async () => {
    const data = join(dir, 'c');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'install.json'), '{"installId":"NOT-HEX"}');
    const c = await loadInstallId(data);
    expect(c).toMatch(INSTALL_ID_PATTERN);
    await writeFile(join(data, 'install.json'), '{broken');
    const d = await loadInstallId(data);
    expect(d).toMatch(INSTALL_ID_PATTERN);
    expect(d).not.toBe(c);
    const aside = (await readdir(data)).filter((f) => f.startsWith('install.json.corrupt-'));
    const contents = await Promise.all(aside.map((f) => readFile(join(data, f), 'utf8')));
    expect(contents.sort()).toEqual(['{"installId":"NOT-HEX"}', '{broken'].sort());
    expect(await loadInstallId(data)).toBe(d);
  });

  it('a read error other than "missing" throws and never overwrites the id', async () => {
    const data = join(dir, 'd');
    // install.json is a directory: readFile fails with EISDIR (stands in for EIO / EACCES / EMFILE).
    await mkdir(join(data, 'install.json'), { recursive: true });
    await expect(loadInstallId(data)).rejects.toThrow(/Could not read the install id/);
    expect(await readdir(join(data, 'install.json'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a failed first write is logged and startup continues with the id in memory',
    async () => {
      const data = join(dir, 'ro');
      await mkdir(data, { recursive: true });
      await chmod(data, 0o500);
      const error = vi.fn();
      try {
        const id = await loadInstallId(data, { log: { ...silentLogger, error } });
        expect(id).toMatch(INSTALL_ID_PATTERN);
        expect(error).toHaveBeenCalledTimes(1);
        expect(await readdir(data)).toEqual([]);
      } finally {
        await chmod(data, 0o700);
      }
    },
  );
});

describe('safeSaveName (pickSavePath)', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['/remote/dir/out.png', 'out.png'],
    ['C:\\Users\\x\\out.png', 'out.png'],
    ['../x', 'x'],
    ['..', FALLBACK_SAVE_NAME],
    ['.', FALLBACK_SAVE_NAME],
    ['a\\..', FALLBACK_SAVE_NAME],
    ['dir/..', FALLBACK_SAVE_NAME],
    ['', FALLBACK_SAVE_NAME],
    ['   ', FALLBACK_SAVE_NAME],
    ['/', FALLBACK_SAVE_NAME],
    ['a\0b', FALLBACK_SAVE_NAME],
    ['line\nbreak.txt', FALLBACK_SAVE_NAME],
  ])('%j → %j', (input, expected) => {
    expect(safeSaveName(input)).toBe(expected);
  });
});

describe('quit checks', () => {
  const event = () => ({ preventDefault: vi.fn() });
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it('run before any disposer; all "quit" → dispose then quit', async () => {
    const order: string[] = [];
    const quit = vi.fn(() => order.push('quit'));
    const guard = createQuitGuard({
      checks: () => [
        async () => {
          order.push('check 1');
          return 'quit';
        },
        async () => {
          order.push('check 2');
          return 'quit';
        },
      ],
      disposers: () => [() => void order.push('dispose')],
      timeoutMs: 1000,
      quit,
    });
    guard(event());
    await tick();
    expect(order).toEqual(['check 1', 'check 2', 'dispose', 'quit']);
  });

  it('"cancel" keeps the app running (no disposer, no quit), calls onCancel; the next quit request asks again', async () => {
    const answers: Array<'quit' | 'cancel'> = ['cancel', 'quit'];
    const check = vi.fn<QuitCheck>(async () => answers.shift()!);
    const dispose = vi.fn();
    const quit = vi.fn();
    const onCancel = vi.fn();
    const guard = createQuitGuard({ checks: () => [check], disposers: () => [dispose], timeoutMs: 1000, quit, onCancel });
    const first = event();
    guard(first);
    expect(first.preventDefault).toHaveBeenCalled();
    await tick();
    expect(check).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    guard(event());
    await tick();
    expect(check).toHaveBeenCalledTimes(2);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('cancel after the last window closed: onCancel reopens a window (no headless app)', async () => {
    // What src/main/index.ts passes: reopen when no window is left (Linux/Windows quit on window-all-closed).
    let windows = 0;
    const openWindow = vi.fn(() => void windows++);
    const onCancel = () => {
      if (windows === 0) openWindow();
    };
    const guard = createQuitGuard({ checks: () => [async () => 'cancel'], disposers: () => [], timeoutMs: 1000, quit: vi.fn(), onCancel });
    guard(event());
    await tick();
    expect(openWindow).toHaveBeenCalledTimes(1);
    // With a window still open (Ctrl+Q), a cancel opens nothing.
    guard(event());
    await tick();
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  it('a second quit request while a check hangs quits anyway; the late answer changes nothing', async () => {
    let answer!: (v: 'quit' | 'cancel') => void;
    const check = vi.fn<QuitCheck>(() => new Promise((r) => (answer = r)));
    const dispose = vi.fn();
    const quit = vi.fn();
    const onCancel = vi.fn();
    const guard = createQuitGuard({ checks: () => [check], disposers: () => [dispose], timeoutMs: 1000, quit, onCancel });
    guard(event());
    await tick();
    expect(quit).not.toHaveBeenCalled();
    const second = event();
    guard(second);
    expect(second.preventDefault).toHaveBeenCalled();
    await tick();
    expect(check).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    answer('cancel');
    await tick();
    expect(onCancel).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('an onCancel that throws is logged and the app keeps running', async () => {
    const warn = vi.fn();
    const quit = vi.fn();
    const guard = createQuitGuard({
      checks: () => [async () => 'cancel'],
      disposers: () => [],
      timeoutMs: 1000,
      quit,
      onCancel: () => {
        throw new Error('no window');
      },
      log: { ...silentLogger, warn },
    });
    guard(event());
    await tick();
    expect(warn).toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('a check that throws counts as "quit"; a cancel stops the remaining checks', async () => {
    const later = vi.fn<QuitCheck>(async () => 'quit');
    await expect(runQuitChecks([async () => Promise.reject(new Error('x')), later])).resolves.toBe('quit');
    expect(later).toHaveBeenCalledTimes(1);
    const after = vi.fn<QuitCheck>(async () => 'quit');
    await expect(runQuitChecks([async () => 'cancel', after])).resolves.toBe('cancel');
    expect(after).not.toHaveBeenCalled();
  });

  it('registerQuitCheck keeps registration order and unregisters', () => {
    const a: QuitCheck = async () => 'quit';
    const b: QuitCheck = async () => 'quit';
    const offA = registerQuitCheck(a);
    const offB = registerQuitCheck(b);
    expect(registeredQuitChecks().slice(-2)).toEqual([a, b]);
    offA();
    offA();
    expect(registeredQuitChecks()).not.toContain(a);
    offB();
    expect(registeredQuitChecks()).not.toContain(b);
  });

  it('without checks the guard behaves as before (dispose, then quit)', async () => {
    const quit = vi.fn();
    const dispose = vi.fn();
    createQuitGuard({ disposers: () => [dispose], timeoutMs: 1000, quit })(event());
    await tick();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
