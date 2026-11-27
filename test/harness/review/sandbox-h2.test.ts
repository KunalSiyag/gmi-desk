/**
 * Regression tests for the H2 security review (sandbox lens; exploits in .review/h2/sandbox-lens/): secret masks fail
 * closed, the proxy refuses this computer's own addresses, the kernel keyring is unreachable, no host descriptor leaks
 * into the sandbox, seatbelt denies userData, FIFOs do not wedge the file tools, and the in-repo hooks dir is a
 * read-only bind. Live parts run on throwaway dirs under os.tmpdir() only.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { classifyCommand, mentionsSecretFile } from '@harness/perm/command';
import { createPermissionEngine } from '@harness/perm/engine';
import { isSecretFileName } from '@harness/perm/hard';
import { buildSandboxEnv } from '@harness/sandbox/env';
import { blockedAddressReason, createNetProxy, type NetProxy } from '@harness/sandbox/netproxy';
import { scanMaskedFiles } from '@harness/sandbox/profiles';
import { createSandboxRunner } from '@harness/sandbox/runner';
import { FD_CLOSE_LAUNCHER, seccompProgram } from '@harness/sandbox/seccomp';
import { buildSeatbeltProfile } from '@harness/sandbox/seatbelt';
import { createReadTool, createWriteTool } from '@harness/tools/fs';
import { createEditTool } from '@harness/tools/edit';
import { createShellTool, type ShellArgs } from '@harness/tools/shell';
import type { SandboxSpec, ToolRunContext } from '@harness/types';
import { fakeClock, fakeGitService, fakeSandboxRunner, memoryLog, memoryMutationLock, memoryStore } from '../fakes';
import { settings, T0, threadRow } from '../perm/helpers';
import { HAS_BWRAP } from '../sandbox/live-helpers';
import { call, makeEnv, type ToolEnv } from '../tools/env';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gmid-review-h2-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function shellCtx(worktree: string, git = fakeGitService()): ToolRunContext {
  const store = memoryStore();
  store.threads.insert(threadRow({ worktreePath: worktree, settings: settings() }));
  return {
    threadId: 'th1',
    projectId: 'p1',
    contextId: 'ctx_th1',
    runId: 'run_1',
    turn: 1,
    step: 1,
    call: { id: 'tc_01REVIEW', wireId: 'call_0', name: 'bash', rawArgs: '{}' },
    worktree,
    dataDir: join(root, 'data'),
    settings: settings(),
    signal: new AbortController().signal,
    store,
    sandbox: fakeSandboxRunner(),
    git,
    lock: memoryMutationLock(),
    perm: createPermissionEngine({ store, clock: fakeClock(Date.parse(T0)), env: { home: '/home/u', userData: null, platform: 'linux' } }),
    emitOutput: () => undefined,
    clock: fakeClock(),
    log: memoryLog(),
  };
}

const shell = createShellTool({ hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/u' } });
const args = (command: string): ShellArgs => {
  const p = shell.parse({ command, description: 'x' });
  if (!p.ok) throw new Error(p.error);
  return p.args;
};

describe('secret masks fail closed (review H2 finding 4)', () => {
  it('one case-insensitive secret-name test', () => {
    for (const n of ['PRIVATE.KEY', 'Server.PEM', '.ENV', '.Env.Local', 'ID_RSA']) expect(isSecretFileName(n)).toBe(true);
    expect(isSecretFileName('.env.example')).toBe(false);
  });

  it('a command naming a secret file is not read-only and asks (secret_path)', () => {
    const cmd = 'cat services/payments/deploy/k8s/overlays/prod/secrets/.env';
    expect(classifyCommand(cmd).readOnly).toBe(false);
    expect(mentionsSecretFile(['--file=conf/Server.PEM'])).toBe(true);
    const wt = mkdtempSync(join(root, 'wt-'));
    const ctx = shellCtx(wt);
    const subject = shell.subject(args(cmd), ctx);
    expect(subject.risk).toContain('secret_path');
    const v = ctx.perm.evaluate(subject, { threadId: 'th1', projectId: 'p1', runId: 'run_1', mode: 'approval-required', unattended: false, sandbox: { kind: 'bwrap', ok: true, detail: null, network: 'proxy' }, worktree: wt });
    expect(v.effect).toBe('ask');
    expect(shell.subject(args('cat README.md'), ctx).risk).not.toContain('secret_path');
  });

  it('the scan is deep and reports when a bound was hit', () => {
    const wt = mkdtempSync(join(root, 'wt-'));
    const deep = join(wt, 'a/b/c/d/e/f/g/h');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, '.env'), 'X=1\n');
    writeFileSync(join(wt, 'PRIVATE.KEY'), 'k');
    const full = scanMaskedFiles(wt);
    expect(full.complete).toBe(true);
    expect(full.files.sort()).toEqual([join(deep, '.env'), join(wt, 'PRIVATE.KEY')].sort());
    expect(scanMaskedFiles(wt, { maxDepth: 3 }).complete).toBe(false);
    expect(scanMaskedFiles(wt, { maxEntries: 3 }).complete).toBe(false);
  });
});

describe('the proxy refuses this computer’s own addresses (finding 5)', () => {
  const own = Object.values(networkInterfaces())
    .flatMap((l) => l ?? [])
    .map((a) => a.address);
  let server: Server | null = null;
  let proxy: NetProxy | null = null;
  afterEach(async () => {
    await proxy?.close();
    server?.close();
    proxy = null;
    server = null;
  });

  it('every interface address is blocked', () => {
    for (const a of own) expect(blockedAddressReason(a), a).not.toBeNull();
  });

  const external = own.filter((a) => !a.startsWith('127.') && a !== '::1' && !a.startsWith('fe80'));
  it.skipIf(external.length === 0)('CONNECT to an own address is refused, not relayed', async () => {
    server = createServer((c) => c.end('HOST-LOCAL-SERVICE\n'));
    await new Promise<void>((r) => server!.listen(0, '::', r));
    const port = (server.address() as { port: number }).port;
    proxy = await createNetProxy({ dir: mkdtempSync(join(root, 'px-')), log: memoryLog() });
    const target = external[0] as string;
    const host = target.includes(':') ? `[${target}]` : target;
    const reply = await new Promise<string>((resolve) => {
      const s = connect(proxy!.socketPath);
      let buf = '';
      s.on('data', (d) => (buf += d.toString('latin1')));
      s.on('end', () => resolve(buf));
      s.on('error', () => resolve(buf));
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      setTimeout(() => resolve(buf), 3000);
    });
    expect(reply).not.toContain('200 Connection Established');
    expect(reply).not.toContain('HOST-LOCAL-SERVICE');
  });
});

describe('keyring syscalls and inherited descriptors (findings 7, 10)', () => {
  it('the seccomp program blocks add_key/request_key/keyctl on x64 and arm64', () => {
    for (const arch of ['x64', 'arm64'] as const) {
      const p = seccompProgram(arch);
      expect(p).not.toBeNull();
      expect((p as Buffer).length % 8).toBe(0);
    }
    expect(seccompProgram('ia32')).toBeNull();
  });

  it('the launcher closes descriptors above 3 before exec', async () => {
    const extra = [openSync('/dev/null', 'r'), openSync('/dev/null', 'r')];
    try {
      const out = await new Promise<string>((resolve, reject) => {
        const c = spawn('/bin/bash', ['--noprofile', '--norc', '-c', FD_CLOSE_LAUNCHER, 'x', 'ls', '/proc/self/fd'], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', extra[0] as number, extra[1] as number] });
        let o = '';
        c.stdout?.on('data', (d) => (o += d));
        c.on('error', reject);
        c.on('close', () => resolve(o));
      });
      expect(out.split(/\s+/).filter(Boolean).sort()).toEqual(['0', '1', '2', '3']);
    } finally {
      for (const fd of extra) closeSync(fd);
    }
  });

  const hasPython = (() => {
    try {
      execFileSync('python3', ['-V']);
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!HAS_BWRAP || !hasPython || process.arch !== 'x64')('inside the production sandbox keyctl and add_key fail with EPERM; the self-test passes', async () => {
    const dir = mkdtempSync(join(root, 'key-'));
    const runner = createSandboxRunner({ platform: 'linux', dataDir: dir, log: memoryLog(), hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME ?? homedir() } });
    expect((await runner.selftest()).ok).toBe(true);
    const py = 'import ctypes,os;l=ctypes.CDLL(None,use_errno=True);r=l.syscall(250,0,-3,0);e=ctypes.get_errno();a=l.syscall(248,b"user",b"gmid-probe",b"x",1,-3);print("KEYCTL",r,e,"ADD",a,ctypes.get_errno())';
    const spec: SandboxSpec = {
      profile: 'readonly',
      threadId: 't',
      command: `python3 -I -c '${py}'; ls /proc/self/fd | tr '\\n' ' '`,
      cwd: dir,
      worktree: dir,
      git: null,
      sensitivePaths: [],
      sensitiveWrites: false,
      maskedFiles: [],
      network: 'off',
      cacheDir: null,
      env: buildSandboxEnv({ hostEnv: { PATH: '/usr/bin:/bin' }, home: process.env.HOME ?? homedir(), cacheDir: null, network: 'off' }),
      timeoutMs: 15_000,
    };
    const r = await runner.run(spec, { signal: new AbortController().signal });
    expect(r.output).toMatch(/KEYCTL -1 1 ADD -1 1/);
    await runner.close();
  });
});

describe('seatbelt denies the app userData (finding 8)', () => {
  it('reads of userData are denied; the thread’s own writable roots below it are allowed again', () => {
    const spec: SandboxSpec = {
      profile: 'exec',
      threadId: 't',
      command: 'true',
      cwd: '/w',
      worktree: '/w',
      git: { readOnly: [], writable: ['/Users/u/Library/Application Support/GMI Desk/data/harness/objects/t'], env: {}, perThreadRefs: true },
      sensitivePaths: [],
      sensitiveWrites: false,
      maskedFiles: [],
      network: 'off',
      cacheDir: '/Users/u/Library/Application Support/GMI Desk/data/harness/cache/t',
      env: {},
      timeoutMs: 1000,
    };
    const p = buildSeatbeltProfile(spec, { home: '/Users/u', proxyDir: null, tmpDir: '/t', execPath: '/x', userData: '/Users/u/Library/Application Support/GMI Desk' });
    const deny = p.indexOf('(deny file-read* file-write* (subpath "/Users/u/Library/Application Support/GMI Desk"))');
    const allowCache = p.indexOf('(allow file-read* (subpath "/Users/u/Library/Application Support/GMI Desk/data/harness/cache/t"))');
    expect(deny).toBeGreaterThan(0);
    expect(allowCache).toBeGreaterThan(deny);
  });
});

describe('FIFOs do not wedge the file tools (finding 9)', () => {
  let env: ToolEnv | null = null;
  afterEach(() => env?.cleanup());
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then((v) => ({ done: true as const, v })), new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), ms))]);

  it('read, write and edit of a FIFO return at once with an error', async () => {
    env = makeEnv();
    execFileSync('mkfifo', [join(env.worktree, 'notes.txt')]);
    for (const [tool, a] of [
      [createReadTool({ home: env.home }), { path: 'notes.txt' }],
      [createWriteTool({ home: env.home }), { path: 'notes.txt', content: 'x' }],
      [createEditTool({ home: env.home }), { path: 'notes.txt', old_string: 'a', new_string: 'b' }],
    ] as const) {
      const r = await within(call(tool as never, a, env.ctx()), 1500);
      expect(r.done, tool.name).toBe(true);
      if (r.done) expect((r.v as { ok: boolean }).ok).toBe(false);
    }
  });
});

describe('the in-repo hooks dir is a read-only bind (finding 6)', () => {
  it('bash passes core.hooksPath from the git service into sensitivePaths', async () => {
    const wt = mkdtempSync(join(root, 'wt-'));
    mkdirSync(join(wt, '.githooks'));
    writeFileSync(join(wt, '.githooks', 'pre-commit'), '#!/bin/sh\n');
    const git = { ...fakeGitService(), hooksPath: async () => '.githooks', listSensitivePaths: async () => [join(wt, '.githooks')] };
    const sandbox = fakeSandboxRunner({ 'npm test': { output: 'ok\n' } });
    const ctx = { ...shellCtx(wt, git), sandbox };
    ctx.store.threads.update('th1', { worktreePath: wt, gitDir: join(wt, '.git'), commonDir: join(wt, '.git') });
    await shell.run(args('npm test'), ctx);
    expect(sandbox.runs[0]?.sensitivePaths).toContain(join(wt, '.githooks'));
  });
});
