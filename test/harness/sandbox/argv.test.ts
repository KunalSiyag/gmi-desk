import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BWRAP_BASE_FLAGS, buildBwrapArgv } from '@harness/sandbox/bwrap';
import { findMaskedFiles, findSensitivePaths, planMounts, toolchainDirs, type HostLayout } from '@harness/sandbox/profiles';
import { buildSeatbeltArgv, buildSeatbeltProfile } from '@harness/sandbox/seatbelt';
import { createSandboxRunner } from '@harness/sandbox/runner';
import type { SandboxSpec } from '@harness/types';
import { memoryLog } from '../fakes';

const LAYOUT: HostLayout = {
  rootLinks: [
    { path: '/bin', target: 'usr/bin' },
    { path: '/lib', target: 'usr/lib' },
    { path: '/lib64', target: 'usr/lib64' },
    { path: '/sbin', target: 'usr/sbin' },
  ],
  etcMasks: ['/etc/docker', '/etc/NetworkManager'],
  home: '/home/u',
  toolchains: ['/home/u/.nvm/versions/node/v22.22.3', '/home/u/.local/bin'],
  execDir: '/opt/GMI Desk',
  execPath: '/opt/GMI Desk/gmi-desk',
};

const COMMON = '/home/u/src/proj/.git';
function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    profile: 'exec',
    threadId: 'th1',
    command: 'npm test',
    cwd: '/home/u/.local/share/gmi-desk/wt/th1',
    worktree: '/home/u/.local/share/gmi-desk/wt/th1',
    git: {
      readOnly: [
        '/home/u/.local/share/gmi-desk/wt/th1/.git',
        COMMON,
        `${COMMON}/worktrees/th1/gitdir`,
        `${COMMON}/worktrees/th1/commondir`,
        `${COMMON}/worktrees/th1/config.worktree`,
      ],
      writable: [`${COMMON}/worktrees/th1`, `${COMMON}/refs/heads/gmi/abc123`, `${COMMON}/logs/refs/heads/gmi/abc123`, '/data/harness/objects/th1'],
      env: { GIT_OBJECT_DIRECTORY: '/data/harness/objects/th1', GIT_ALTERNATE_OBJECT_DIRECTORIES: `${COMMON}/objects`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0' },
      perThreadRefs: true,
    },
    sensitivePaths: ['/home/u/.local/share/gmi-desk/wt/th1/.husky', '/home/u/.local/share/gmi-desk/wt/th1/AGENTS.md'],
    sensitiveWrites: false,
    maskedFiles: ['/home/u/.local/share/gmi-desk/wt/th1/.env'],
    network: 'off',
    cacheDir: '/data/harness/cache/th1',
    env: { PATH: '/usr/bin:/bin', HOME: '/home/u' },
    timeoutMs: 1000,
    ...over,
  };
}

const pairs = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [[argv[i + 1], argv[i + 2]]] : []));

describe('bwrap argv (§8.3)', () => {
  it('matches the snapshot for the exec profile', () => {
    expect(buildBwrapArgv('/usr/bin/bwrap', spec(), LAYOUT, { proxyDir: null })).toMatchSnapshot();
  });

  it('matches the snapshot for the readonly profile and for the proxy', () => {
    expect(buildBwrapArgv('/usr/bin/bwrap', spec({ profile: 'readonly', command: 'git status' }), LAYOUT, { proxyDir: null })).toMatchSnapshot();
    expect(buildBwrapArgv('/usr/bin/bwrap', spec({ network: 'proxy' }), LAYOUT, { proxyDir: '/data/harness/sandbox/proxy' })).toMatchSnapshot();
  });

  it('starts with the flags bwrap 0.11 accepts together (SC-9: --disable-userns needs --unshare-user)', () => {
    const argv = buildBwrapArgv('bwrap', spec(), LAYOUT, { proxyDir: null });
    expect(argv.slice(1, 1 + BWRAP_BASE_FLAGS.length)).toEqual([...BWRAP_BASE_FLAGS]);
    expect(argv.indexOf('--unshare-user')).toBeLessThan(argv.indexOf('--disable-userns'));
    expect(argv).not.toContain('--share-net');
  });

  it('mounts an allowlisted root: never / , /home, /var/lib, /srv, /opt or /media; fresh tmpfs on /run, /tmp and $HOME', () => {
    const argv = buildBwrapArgv('bwrap', spec(), LAYOUT, { proxyDir: null });
    const binds = [...pairs(argv, '--ro-bind'), ...pairs(argv, '--bind'), ...pairs(argv, '--ro-bind-try')].map(([src]) => src);
    for (const forbidden of ['/', '/home', '/var', '/var/lib', '/srv', '/opt', '/media', '/mnt', '/run', '/var/run', '/home/u']) expect(binds).not.toContain(forbidden);
    const tmpfs = argv.flatMap((a, i) => (a === '--tmpfs' ? [argv[i + 1]] : []));
    expect(tmpfs).toEqual(expect.arrayContaining(['/tmp', '/var/tmp', '/run', '/home/u', '/etc/docker', '/etc/NetworkManager']));
    expect(argv.join(' ')).toContain('--symlink ../run /var/run');
  });

  it('mounts git metadata read-only except this thread’s dirs, parents before children', () => {
    const argv = buildBwrapArgv('bwrap', spec(), LAYOUT, { proxyDir: null });
    const idx = (flag: string, path: string) => argv.findIndex((a, i) => a === flag && argv[i + 2] === path);
    expect(idx('--ro-bind', COMMON)).toBeGreaterThan(0);
    expect(idx('--bind', `${COMMON}/worktrees/th1`)).toBeGreaterThan(idx('--ro-bind', COMMON));
    expect(idx('--ro-bind', `${COMMON}/worktrees/th1/gitdir`)).toBeGreaterThan(idx('--bind', `${COMMON}/worktrees/th1`));
    expect(idx('--ro-bind', '/home/u/.local/share/gmi-desk/wt/th1/.git')).toBeGreaterThan(idx('--bind', '/home/u/.local/share/gmi-desk/wt/th1'));
    expect(idx('--bind', '/data/harness/objects/th1')).toBeGreaterThan(0);
  });

  it('masks secrets with /dev/null and mounts sensitive files read-only unless sensitiveWrites', () => {
    const a = buildBwrapArgv('bwrap', spec(), LAYOUT, { proxyDir: null });
    expect(pairs(a, '--ro-bind')).toContainEqual(['/dev/null', '/home/u/.local/share/gmi-desk/wt/th1/.env']);
    expect(pairs(a, '--ro-bind')).toContainEqual(['/home/u/.local/share/gmi-desk/wt/th1/.husky', '/home/u/.local/share/gmi-desk/wt/th1/.husky']);
    const b = buildBwrapArgv('bwrap', spec({ sensitiveWrites: true }), LAYOUT, { proxyDir: null });
    expect(pairs(b, '--ro-bind')).not.toContainEqual(['/home/u/.local/share/gmi-desk/wt/th1/.husky', '/home/u/.local/share/gmi-desk/wt/th1/.husky']);
    expect(pairs(b, '--ro-bind')).toContainEqual(['/dev/null', '/home/u/.local/share/gmi-desk/wt/th1/.env']);
  });

  it('runs bash without profiles (SC-27), with a cleared env', () => {
    const argv = buildBwrapArgv('bwrap', spec(), LAYOUT, { proxyDir: null });
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/bin/bash', '--noprofile', '--norc', '-c', 'npm test']);
    expect(argv).toContain('--clearenv');
    expect(argv.indexOf('--clearenv')).toBeLessThan(argv.indexOf('--setenv'));
  });

  it('readonly profile: every project mount read-only, no caches, no proxy, HOME remounted read-only last', () => {
    const argv = buildBwrapArgv('bwrap', spec({ profile: 'readonly', network: 'proxy' }), LAYOUT, { proxyDir: '/p' });
    expect(pairs(argv, '--bind')).toEqual([]);
    expect(argv).not.toContain('/run/gmid-proxy');
    const rm = argv.lastIndexOf('--remount-ro');
    expect(argv[rm + 1]).toBe('/home/u');
    expect(rm).toBeGreaterThan(argv.lastIndexOf('--ro-bind'));
    expect(argv.some((a) => a.startsWith('HTTP'))).toBe(false);
  });

  it('proxy: mounts the proxy dir, runs the forwarder with Electron as Node, binds its directory read-only', () => {
    const argv = buildBwrapArgv('bwrap', spec({ network: 'proxy' }), LAYOUT, { proxyDir: '/data/harness/sandbox/proxy' });
    expect(pairs(argv, '--ro-bind')).toContainEqual(['/data/harness/sandbox/proxy', '/run/gmid-proxy']);
    expect(pairs(argv, '--ro-bind')).toContainEqual(['/opt/GMI Desk', '/opt/GMI Desk']);
    expect(argv.slice(argv.indexOf('--') + 1, argv.indexOf('--') + 4)).toEqual(['/opt/GMI Desk/gmi-desk', '/run/gmid-proxy/forwarder.cjs', '--']);
    expect(pairs(argv, '--setenv')).toContainEqual(['ELECTRON_RUN_AS_NODE', '1']);
    expect(argv).not.toContain('--share-net');
  });

  it('shared fallback: --share-net, no forwarder', () => {
    const argv = buildBwrapArgv('bwrap', spec({ network: 'shared' }), LAYOUT, { proxyDir: null });
    expect(argv).toContain('--share-net');
    expect(argv).not.toContain('/run/gmid-proxy/forwarder.cjs');
  });

  it('refuses a cwd outside the worktree and relative paths', () => {
    expect(() => planMounts(spec({ cwd: '/etc' }), LAYOUT, { proxyDir: null })).toThrow(/inside the worktree/);
    expect(() => planMounts(spec({ worktree: 'rel' }), LAYOUT, { proxyDir: null })).toThrow(/absolute/);
    expect(() => planMounts(spec({ maskedFiles: ['/x/../etc/passwd'] }), LAYOUT, { proxyDir: null })).toThrow(/absolute/);
  });

  it('the runner’s buildArgv is the same builder (the self-test argv is the production argv)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmid-argv-'));
    try {
      const r = createSandboxRunner({ platform: 'linux', dataDir: dir, log: memoryLog(), bwrapPath: '/usr/bin/bwrap', layout: LAYOUT });
      const emptyFile = join(dir, 'sandbox', 'empty');
      expect(r.buildArgv(spec())).toEqual(buildBwrapArgv('/usr/bin/bwrap', spec(), LAYOUT, { proxyDir: null, emptyFile }));
      expect(r.buildArgv(spec({ network: 'proxy' }))).toEqual(buildBwrapArgv('/usr/bin/bwrap', spec({ network: 'proxy' }), LAYOUT, { proxyDir: join(dir, 'sandbox', 'proxy'), emptyFile }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seatbelt profile (macOS, snapshot only)', () => {
  it('denies by default, writes only to the worktree and this thread’s git dirs, network only to the proxy socket', () => {
    const p = buildSeatbeltProfile(spec({ network: 'proxy' }), { home: '/Users/u', proxyDir: '/data/proxy', tmpDir: '/private/tmp/x', execPath: '/Applications/GMI Desk.app/x' });
    expect(p).toMatchSnapshot();
    expect(p).toContain('(deny default)');
    expect(p).toContain('(remote unix-socket (path-literal "/data/proxy/proxy.sock"))');
    expect(p).toContain(`(deny file-write* (subpath "${COMMON}"))`);
    expect(p).not.toContain('(allow network*)');
    const argv = buildSeatbeltArgv(spec(), { home: '/Users/u', proxyDir: null, tmpDir: '/private/tmp/x', execPath: '/x' });
    expect(argv.slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
    expect(argv.slice(3)).toEqual(['--', '/bin/bash', '--noprofile', '--norc', '-c', 'npm test']);
  });

  it('escapes quotes in paths', () => {
    const p = buildSeatbeltProfile(spec({ worktree: '/w/a"b', cwd: '/w/a"b', git: null, sensitivePaths: [], maskedFiles: [] }), { home: '/Users/u', proxyDir: null, tmpDir: '/t', execPath: '/x' });
    expect(p).toContain('(subpath "/w/a\\"b")');
  });
});

describe('worktree scans', () => {
  const root = mkdtempSync(join(tmpdir(), 'gmid-scan-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds existing sensitive paths, skipping symlinks that point outside', () => {
    const wt = join(root, 'wt');
    mkdirSync(join(wt, '.husky'), { recursive: true });
    mkdirSync(join(wt, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(wt, 'AGENTS.md'), 'x');
    symlinkSync('/etc', join(wt, '.gmi-desk'));
    const found = findSensitivePaths(wt);
    expect(found).toEqual(expect.arrayContaining([join(wt, '.husky'), join(wt, '.github', 'workflows'), join(wt, 'AGENTS.md')]));
    expect(found).not.toContain(join(wt, '.gmi-desk'));
  });

  it('finds secret files (regular files only), skipping .git and node_modules', () => {
    const wt = join(root, 'wt2');
    mkdirSync(join(wt, 'a', 'b'), { recursive: true });
    mkdirSync(join(wt, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(wt, '.git'), { recursive: true });
    for (const f of ['.env', '.env.local', 'a/b/server.pem', 'a/id_rsa', '.env.example', 'node_modules/x/.env', '.git/x.key', 'README.md']) writeFileSync(join(wt, f), 'x');
    symlinkSync('/etc/hostname', join(wt, 'a', '.npmrc'));
    const found = findMaskedFiles(wt).sort();
    expect(found).toEqual([join(wt, '.env'), join(wt, '.env.local'), join(wt, 'a', 'b', 'server.pem'), join(wt, 'a', 'id_rsa')].sort());
  });

  it('toolchainDirs keeps PATH dirs outside /usr and never $HOME, its ancestors or protected dirs', () => {
    const home = join(root, 'home');
    const nvm = join(home, '.nvm', 'versions', 'node', 'v1');
    mkdirSync(join(nvm, 'bin'), { recursive: true });
    mkdirSync(join(nvm, 'lib'), { recursive: true });
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    mkdirSync(join(home, '.ssh', 'bin'), { recursive: true });
    mkdirSync(join(home, '.config', 'x', 'bin'), { recursive: true });
    const dirs = toolchainDirs([join(nvm, 'bin'), join(home, '.local', 'bin'), home, root, '/usr/bin', '/bin', join(home, '.ssh', 'bin'), join(home, '.config', 'x', 'bin'), 'relative', '/'].join(':'), home);
    expect(dirs).toEqual([join(home, '.local', 'bin'), nvm].sort());
  });
});
