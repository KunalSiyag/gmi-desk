/**
 * Live bubblewrap tests (harness.md §16 Sandbox, H-T3/T5/T9/T14, SC-1/2/3/5/8/9/27). Every command runs through the
 * PRODUCTION runner and argv builder (createSandboxRunner → buildBwrapArgv), on throwaway repos under os.tmpdir().
 * Skipped where bwrap or unprivileged user namespaces are unavailable.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSandboxEnv } from '@harness/sandbox/env';
import { blockedAddressReason, type Resolver } from '@harness/sandbox/netproxy';
import { findMaskedFiles, findSensitivePaths } from '@harness/sandbox/profiles';
import { createSandboxRunner, type HarnessSandboxRunner } from '@harness/sandbox/runner';
import { homeMountPoints, hostUnixSockets } from '@harness/sandbox/selftest';
import { classifyCommand } from '@harness/perm/command';
import type { SandboxRunResult, SandboxSpec } from '@harness/types';
import { memoryLog } from '../fakes';
import { git, HAS_BWRAP, makeRepo, type RepoFixture, type ThreadFixture } from './live-helpers';

const HOST_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME ?? homedir(),
  USER: process.env.USER,
  LANG: 'C.UTF-8',
  FAKE_API_KEY: 'must-not-leak',
  GITHUB_TOKEN: 'ghp_must_not_leak',
  GMI_API_KEY: 'eyJ.must.not.leak',
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? 'unix:path=/run/user/1000/bus',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
};

const resolver: Resolver = async (h) => {
  const map: Record<string, string[]> = { 'public.test': ['127.0.0.2'], 'lan.test': ['192.168.1.1'], 'meta.test': ['169.254.169.254'], 'ula.test': ['fd00::1'] };
  const a = map[h.toLowerCase()];
  if (!a) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe.skipIf(!HAS_BWRAP)('live bwrap sandbox (production argv)', () => {
  let fx: RepoFixture;
  let A: ThreadFixture;
  let B: ThreadFixture;
  let runner: HarnessSandboxRunner;
  let upstream: Server;
  let port = 0;
  const marker = randomBytes(4).toString('hex');

  function spec(t: ThreadFixture, command: string, over: Partial<SandboxSpec> = {}): SandboxSpec {
    const network = over.network ?? 'off';
    const profile = over.profile ?? 'exec';
    const cacheDir = profile === 'exec' ? join(fx.dataDir, 'cache', t.id6) : null;
    return {
      profile,
      threadId: t.id6,
      command,
      cwd: t.worktree,
      worktree: t.worktree,
      git: t.mounts,
      sensitivePaths: findSensitivePaths(t.worktree),
      sensitiveWrites: false,
      maskedFiles: findMaskedFiles(t.worktree),
      network,
      cacheDir,
      env: buildSandboxEnv({ hostEnv: HOST_ENV, home: HOST_ENV.HOME, cacheDir, gitEnv: t.mounts.env, gitAuthor: { name: 'Agent', email: 'agent@example.com' }, network: profile === 'readonly' ? 'off' : network }),
      timeoutMs: 30_000,
      ...over,
    };
  }

  async function run(t: ThreadFixture, command: string, over: Partial<SandboxSpec> = {}, signal?: AbortSignal): Promise<SandboxRunResult> {
    return runner.run(spec(t, command, over), { signal: signal ?? new AbortController().signal });
  }

  beforeAll(async () => {
    fx = makeRepo();
    A = fx.addThread('aaaaaa');
    B = fx.addThread('bbbbbb', { lock: false });
    upstream = createServer((c) => {
      c.once('data', (d) => {
        const line = d.toString('latin1').split('\r\n')[0] ?? '';
        const body = `public-ok ${line}`;
        c.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.2', r));
    port = (upstream.address() as { port: number }).port;
    runner = createSandboxRunner({
      platform: 'linux',
      dataDir: fx.dataDir,
      log: memoryLog(),
      hostEnv: HOST_ENV,
      // Test hook: 127.0.0.2 stands in for a public address; every other address goes through the real table.
      proxy: { resolver, addressCheck: (ip) => (ip === '127.0.0.2' ? null : blockedAddressReason(ip)) },
    });
  });

  afterAll(async () => {
    await runner?.close();
    upstream?.close();
    if (fx) {
      try {
        git(fx.repo, ['worktree', 'unlock', A.worktree]);
      } catch {
        /* ignore */
      }
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('the self-test (production argv) passes, with the proxy', async () => {
    const st = await runner.selftest();
    expect(st).toEqual({ kind: 'bwrap', ok: true, detail: null, network: 'proxy' });
  });

  it('writes outside the worktree never reach the host', async () => {
    const probe = `gmid-live-${marker}`;
    const targets = ['/usr/x', '/etc/x', join(fx.repo, probe), join(fx.root, probe), join(HOST_ENV.HOME, probe), `/tmp/${probe}`, join(B.worktree, probe)];
    const r = await run(A, `${targets.map((p) => `(echo x > '${p}') 2>/dev/null && echo "WROTE ${p}"`).join('; ')}; echo inside > ok.txt; echo done`);
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain('WROTE /usr/x');
    expect(r.output).not.toContain('WROTE /etc/x');
    for (const p of targets) expect(existsSync(p), p).toBe(false);
    expect(readFileSync(join(A.worktree, 'ok.txt'), 'utf8')).toBe('inside\n');
  });

  it('$HOME is empty except toolchain mount points and the thread caches; no dotfiles of the user', async () => {
    const r = await run(A, 'ls -A "$HOME"; echo ---; ls "$HOME/.ssh" 2>&1; test -e "$HOME/.gitconfig" && echo HAS_GITCONFIG; test -e "$HOME/.config" && echo HAS_CONFIG; true');
    const [listing = ''] = r.output.split('---');
    const entries = listing.split('\n').filter(Boolean).sort();
    const allowed = new Set([...homeMountPoints(HOST_ENV.HOME, [...runner.hostLayout().toolchains, runner.hostLayout().execDir]), '.cache', '.npm']);
    for (const e of entries) expect(allowed.has(e), e).toBe(true);
    expect(r.output).toMatch(/No such file or directory/);
    expect(r.output).not.toContain('HAS_GITCONFIG');
    expect(r.output).not.toContain('HAS_CONFIG');
  });

  it('cat .env reads /dev/null and .env cannot be written', async () => {
    const r = await run(A, 'cat .env; echo "[$(wc -c < .env)]"; (echo leak >> .env) 2>/dev/null && echo WROTE; true');
    expect(r.output).not.toContain('hunter2');
    expect(r.output).toContain('[0]');
    expect(r.output).not.toContain('WROTE');
    expect(readFileSync(join(A.worktree, '.env'), 'utf8')).toBe('SECRET_VALUE=hunter2\n');
  });

  it('no host Unix socket is connectable (every path and abstract name in /proc/net/unix), and docker fails (SC-2)', async () => {
    const sockets = hostUnixSockets();
    expect(sockets.length).toBeGreaterThan(0);
    const cfg = join(A.worktree, `.sockets-${marker}.json`);
    writeFileSync(cfg, JSON.stringify(sockets));
    const script = join(A.worktree, `.probe-${marker}.cjs`);
    writeFileSync(
      script,
      `const net=require('net');const list=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));let ok=[];let n=0;
       const next=()=>{if(n>=list.length){console.log('CONNECTED:'+JSON.stringify(ok));return;}const p=list[n++];const path=p.startsWith('@')?'\\0'+p.slice(1):p;
       const s=net.connect({path});const t=setTimeout(()=>{s.destroy();next();},300);s.on('connect',()=>{ok.push(p);clearTimeout(t);s.destroy();next();});s.on('error',()=>{clearTimeout(t);next();});};next();`,
    );
    const r = await run(A, `'${process.execPath}' '${script}' '${cfg}'; docker version >/dev/null 2>&1 && echo DOCKER_OK; for s in /var/run/docker.sock /run/docker.sock /run/dbus/system_bus_socket /run/user/$(id -u)/bus /tmp/.X11-unix; do test -e "$s" && echo "EXISTS $s"; done; true`);
    expect(r.output).toContain('CONNECTED:[]');
    expect(r.output).not.toContain('DOCKER_OK');
    expect(r.output).not.toContain('EXISTS');
    // The Docker socket was among the probed paths (when the host has one).
    if (existsSync('/var/run/docker.sock')) expect(sockets.some((s) => s.endsWith('docker.sock'))).toBe(true);
  });

  it('without network approval nothing reaches the network or host loopback services', async () => {
    const r = await run(A, `curl -sS --max-time 5 http://93.184.216.34/ >/dev/null 2>&1 && echo NET_OK; curl -sS --max-time 5 http://127.0.0.2:${port}/ 2>&1 && echo LOOP_OK; echo "proxy=[$HTTP_PROXY]"; true`);
    expect(r.output).not.toContain('NET_OK');
    expect(r.output).not.toContain('LOOP_OK');
    expect(r.output).toContain('proxy=[]');
  });

  it('with network approved the proxy reaches an allowed host (HTTP and CONNECT) but refuses loopback, RFC 1918, metadata and ULA (SC-8)', async () => {
    const cmd = [
      `curl -sS --max-time 10 http://public.test:${port}/hello; echo`,
      `curl -sS --max-time 10 -p http://public.test:${port}/tunnel; echo`,
      `for u in http://127.0.0.1:${port}/ http://10.0.0.1/ http://169.254.169.254/latest/meta-data/ 'http://[fd00::1]/' http://lan.test/ http://meta.test/ http://ula.test/ http://localhost:5199/; do code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u"); echo "CODE $u $code"; done`,
      `curl -sS --max-time 10 https://127.0.0.1/ 2>&1 | head -c 200; echo`,
      // A tool that ignores the proxy variables gets no network at all.
      `curl -sS --noproxy '*' --max-time 5 http://public.test:${port}/ >/dev/null 2>&1 && echo BYPASS_OK; true`,
    ].join('; ');
    const r = await run(A, cmd, { network: 'proxy' });
    expect(r.output).toContain('public-ok GET /hello HTTP/1.1');
    expect(r.output).toContain('public-ok GET /tunnel HTTP/1.1');
    for (const line of r.output.split('\n').filter((l) => l.startsWith('CODE '))) expect(line, line).toMatch(/ 403$/);
    expect(r.output.split('\n').filter((l) => l.startsWith('CODE '))).toHaveLength(8);
    expect(r.output).toMatch(/403/);
    expect(r.output).not.toContain('BYPASS_OK');
  });

  it('git: the .git pointer, gitdir, commondir, config, hooks, objects and other refs are read-only (SC-1, SC-5)', async () => {
    const C = fx.common;
    const pointerBefore = readFileSync(join(A.worktree, '.git'), 'utf8');
    const mainBefore = git(fx.repo, ['rev-parse', 'main']);
    const cmd = [
      `(printf 'gitdir: /tmp/evil\\n' > .git) 2>/dev/null && echo W_POINTER`,
      `rm -f .git 2>/dev/null && echo RM_POINTER`,
      `(echo /tmp/evil > '${A.gitDir}/gitdir') 2>/dev/null && echo W_GITDIR`,
      `(echo /tmp/evil > '${A.gitDir}/commondir') 2>/dev/null && echo W_COMMONDIR`,
      `(echo '[core] fsmonitor = x' >> '${A.gitDir}/config.worktree') 2>/dev/null && echo W_CONFIGWT`,
      `(echo '[core] hooksPath = /tmp' >> '${C}/config') 2>/dev/null && echo W_CONFIG`,
      `git config core.hooksPath /tmp/evil 2>/dev/null && echo GIT_CONFIG`,
      `(echo 'touch /tmp/pwn' > '${C}/hooks/post-checkout') 2>/dev/null && echo W_HOOK`,
      `rm -rf '${C}/objects' 2>/dev/null && echo RM_OBJECTS`,
      `git branch -f main HEAD 2>/dev/null && echo BRANCH_F`,
      `git update-ref refs/heads/main HEAD 2>/dev/null && echo UPDATE_REF`,
      `(echo x > '${C}/packed-refs') 2>/dev/null && echo W_PACKED`,
      `(echo 0000 > '${C}/worktrees/${B.name}/HEAD') 2>/dev/null && echo W_OTHER_HEAD`,
      `git worktree prune 2>/dev/null; echo PRUNE_RAN`,
      `git reflog expire --expire=now --all 2>/dev/null; git gc --prune=now -q 2>/dev/null; echo GC_RAN`,
      `echo dirty >> README.md; git stash 2>/dev/null && echo STASH_OK; git checkout -q -- README.md 2>/dev/null`,
      `(echo x >> AGENTS.md) 2>/dev/null && echo W_AGENTS`,
      `(echo x >> .husky/pre-commit) 2>/dev/null && echo W_HUSKY`,
      'true',
    ].join('; ');
    const r = await run(A, cmd);
    for (const bad of ['W_POINTER', 'RM_POINTER', 'W_GITDIR', 'W_COMMONDIR', 'W_CONFIGWT', 'W_CONFIG', 'GIT_CONFIG', 'W_HOOK', 'RM_OBJECTS', 'BRANCH_F', 'UPDATE_REF', 'W_PACKED', 'W_OTHER_HEAD', 'STASH_OK', 'W_AGENTS', 'W_HUSKY']) expect(r.output, bad).not.toContain(bad);
    expect(r.output).toContain('PRUNE_RAN');
    // Host state unchanged.
    expect(readFileSync(join(A.worktree, '.git'), 'utf8')).toBe(pointerBefore);
    expect(readFileSync(join(A.gitDir, 'gitdir'), 'utf8')).toContain(A.worktree);
    expect(git(fx.repo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(existsSync(join(C, 'objects'))).toBe(true);
    expect(git(fx.repo, ['cat-file', '-t', mainBefore])).toBe('commit');
    expect(readFileSync(join(C, 'config'), 'utf8')).not.toContain('hooksPath');
    expect(readFileSync(join(A.worktree, 'AGENTS.md'), 'utf8')).toBe('be nice\n');
    // `git worktree prune` in thread A left thread B (unlocked, invisible to A) working.
    expect(existsSync(join(C, 'worktrees', B.name))).toBe(true);
    expect(git(B.worktree, ['status', '--short'])).toBeDefined();
    expect(git(B.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(B.branch);
  });

  it('git: a commit on the thread’s own branch works; its objects go to the thread object dir and import verified', async () => {
    const before = git(fx.repo, ['rev-parse', A.branch]);
    const r = await run(A, 'echo change > feature.txt && git add feature.txt && git commit -q -m "agent change" && git rev-parse HEAD');
    expect(r.exitCode, r.output).toBe(0);
    const sha = r.output.trim().split('\n').pop() ?? '';
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(fx.repo, ['rev-parse', A.branch])).toBe(sha);
    expect(sha).not.toBe(before);
    // Not in the shared store yet: only in the thread object dir.
    expect(() => git(fx.repo, ['cat-file', '-e', sha])).toThrow();
    expect(git(fx.repo, ['cat-file', '-t', sha], { GIT_ALTERNATE_OBJECT_DIRECTORIES: A.objectDir })).toBe('commit');
    // Import (what GitService.importObjects does, §8.3): git re-hashes every object on unpack.
    const alt = { GIT_ALTERNATE_OBJECT_DIRECTORIES: A.objectDir };
    const pack = execFileSync('sh', ['-c', `git rev-list --objects ${A.branch} --not main | git pack-objects --stdout`], { cwd: fx.repo, env: { ...process.env, ...alt, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    execFileSync('git', ['unpack-objects', '-q'], { cwd: fx.repo, input: pack, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(git(fx.repo, ['cat-file', '-t', sha])).toBe('commit');
    expect(git(fx.repo, ['show', `${sha}:feature.txt`])).toBe('change');
  });

  it('a planted ~/.bash_profile or ~/.bashrc is never sourced; only caches persist between commands (SC-27)', async () => {
    const pwned = join(A.worktree, `pwned-${marker}`);
    const plant = `for f in .bash_profile .bashrc .profile .bash_login; do echo "touch '${pwned}'" > "$HOME/$f"; done; echo cached > "$HOME/.cache/keep-${marker}"; echo planted`;
    expect((await run(A, plant)).output).toContain('planted');
    const r = await run(A, `ls -A "$HOME" | grep -c bash; cat "$HOME/.cache/keep-${marker}"; bash -c true; true`);
    expect(existsSync(pwned)).toBe(false);
    expect(r.output.split('\n')[0]).toBe('0');
    expect(r.output).toContain('cached');
  });

  it('the readonly profile cannot write the worktree, git metadata, object dir, HOME or caches; rg --pre runs nothing that persists (SC-3)', async () => {
    const pre = join(A.worktree, `evil-${marker}.sh`);
    writeFileSync(pre, `#!/bin/sh\necho pwned > '${join(A.worktree, `pre-pwned-${marker}`)}'\ncat "$1"\n`, { mode: 0o755 });
    expect(classifyCommand(`rg --pre ${pre} x README.md`).readOnly).toBe(false);
    const cmd = [
      `(echo x > ro-${marker}) 2>/dev/null && echo W_WT`,
      `(echo x > '${fx.common}/ro-${marker}') 2>/dev/null && echo W_COMMON`,
      `(echo x > '${A.gitDir}/ro-${marker}') 2>/dev/null && echo W_GITDIR`,
      `(echo x > '${A.objectDir}/ro-${marker}') 2>/dev/null && echo W_OBJ`,
      `(echo x > "$HOME/ro-${marker}") 2>/dev/null && echo W_HOME`,
      `rg --pre '${pre}' hello README.md; echo RG_DONE`,
      `echo "proxy=[$HTTP_PROXY]"`,
      'true',
    ].join('; ');
    const r = await run(A, cmd, { profile: 'readonly', network: 'proxy' });
    for (const bad of ['W_WT', 'W_COMMON', 'W_GITDIR', 'W_OBJ', 'W_HOME']) expect(r.output, bad).not.toContain(bad);
    expect(r.output).toContain('RG_DONE');
    expect(r.output).toContain('proxy=[]');
    expect(existsSync(join(A.worktree, `pre-pwned-${marker}`))).toBe(false);
    expect(existsSync(join(A.worktree, `ro-${marker}`))).toBe(false);
    expect(existsSync(join(fx.common, `ro-${marker}`))).toBe(false);
  });

  it('the env has no *_KEY, *_TOKEN or socket addresses', async () => {
    const r = await run(A, 'env');
    const names = r.output.split('\n').map((l) => l.split('=')[0] ?? '');
    expect(names.filter((n) => /KEY|TOKEN|SECRET|DBUS|DOCKER|SSH_AUTH/.test(n) && !/^GIT_CONFIG_KEY_\d+$/.test(n))).toEqual([]);
    expect(r.output).not.toContain('must-not-leak');
    expect(r.output).not.toContain('must_not_leak');
    expect(r.output).not.toContain('eyJ.must');
  });

  it('abort kills the whole sandbox (process group) quickly', async () => {
    const tag = `${Date.now() % 100000}.${marker.length}${randomBytes(2).readUInt16BE(0)}`;
    const ac = new AbortController();
    const p = run(A, `sleep ${tag} & sleep ${tag}; wait`, {}, ac.signal);
    await new Promise((r) => setTimeout(r, 400));
    expect(pgrep(`sleep ${tag}`)).toBeGreaterThan(0);
    ac.abort();
    const res = await p;
    expect(res.cancelled).toBe(true);
    await waitFor(() => pgrep(`sleep ${tag}`) === 0, 6_000);
  });

  it('a timeout kills the command and reports it', async () => {
    const res = await run(A, 'sleep 30', { timeoutMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(res.durationMs).toBeLessThan(8_000);
  });

  it('killing the parent kills the children (--die-with-parent)', async () => {
    const tag = `${(Date.now() % 100000) + 7}.${randomBytes(2).readUInt16BE(0)}`;
    const argv = runner.buildArgv(spec(A, `sleep ${tag}`));
    const parentScript = `const {spawn}=require('child_process');const a=JSON.parse(process.argv[1]);spawn(a[0],a.slice(1),{stdio:'inherit',env:{}});setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ['-e', parentScript, JSON.stringify(argv)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let parentOut = '';
    parent.stdout.on('data', (d) => (parentOut += d));
    parent.stderr.on('data', (d) => (parentOut += d));
    await new Promise((r) => setTimeout(r, 300));
    if (pgrep(`sleep ${tag}`) === 0) console.log('parent output:', parentOut);
    await waitFor(() => pgrep(`sleep ${tag}`) > 0, 5_000);
    parent.kill('SIGKILL');
    await waitFor(() => pgrep(`sleep ${tag}`) === 0, 6_000);
  });

  it('long output keeps head and tail and spills everything (0600)', async () => {
    const spill = join(fx.dataDir, 'spill', A.id6, 'tc_test.txt');
    const res = await runner.run(spec(A, 'seq 1 300000'), { signal: new AbortController().signal, spillFile: spill, maxCaptureBytes: 64 * 1024 });
    expect(res.exitCode).toBe(0);
    expect(res.outputTruncated).toBe(true);
    expect(res.output.startsWith('1\n2\n3\n')).toBe(true);
    expect(res.output.trimEnd().endsWith('300000')).toBe(true);
    expect(readFileSync(spill, 'utf8').split('\n').length).toBe(300001);
    expect(execFileSync('stat', ['-c', '%a', spill], { encoding: 'utf8' }).trim()).toBe('600');
  });
});

function pgrep(pattern: string): number {
  try {
    return execFileSync('pgrep', ['-f', '-c', pattern], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(Number)[0] as number;
  } catch {
    return 0;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(cond()).toBe(true);
}
