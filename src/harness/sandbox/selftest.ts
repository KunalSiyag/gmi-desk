/**
 * The sandbox self-test (harness.md §8.3, SC-9): it runs the PRODUCTION `exec` argv from the same builder the shell
 * uses, first with `true`, then with a probe that asserts:
 *   - no host Unix socket is connectable (every path and abstract name in the host's /proc/net/unix);
 *   - there is no network (a TCP connect to a public address fails);
 *   - `$HOME` is empty (except the mount points of PATH toolchains under it);
 *   - the git metadata (the `.git` pointer and the common dir) is read-only, while the worktree is writable.
 * With the proxy running, a second probe asserts the forwarder answers on 127.0.0.1:3128 and still no host socket
 * is reachable. Any failure → `{ok:false}`: every shell command asks and the auto modes are off.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SandboxGitMounts, SandboxSpec } from '../types';

/** First path segments under `home` of the toolchain mounts (the only entries a fresh `$HOME` may show). */
export function homeMountPoints(home: string, mounts: readonly string[]): string[] {
  const prefix = home.endsWith('/') ? home : `${home}/`;
  const out = new Set<string>();
  for (const m of mounts) if (m.startsWith(prefix)) out.add(m.slice(prefix.length).split('/')[0] ?? '');
  out.delete('');
  return [...out].sort();
}

/** Socket paths (`/…`) and abstract names (`@…`) the host has open. */
export function hostUnixSockets(procNetUnix = '/proc/net/unix'): string[] {
  let text: string;
  try {
    text = readFileSync(procNetUnix, 'utf8');
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 8) {
      const p = cols.slice(7).join(' ');
      if (p.startsWith('/') || p.startsWith('@')) out.add(p);
    }
  }
  return [...out].sort();
}

/** The probe: plain CommonJS for Node or Electron-as-Node; prints one JSON line. */
export const PROBE_SOURCE = `'use strict';
const fs = require('fs');
const net = require('net');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = { connected: [], home: null, net: null, roWritable: [], worktreeWritable: false, forwarder: null };
function tryConnect(opts, ms) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect(opts);
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.once('connect', () => fin('connected'));
    s.once('error', (e) => fin(e.code || 'error'));
    setTimeout(() => fin('timeout'), ms);
  });
}
(async () => {
  for (const p of cfg.sockets) {
    const path = p.startsWith('@') ? '\\0' + p.slice(1) : p;
    if ((await tryConnect({ path }, 300)) === 'connected') out.connected.push(p);
  }
  try { out.home = fs.readdirSync(process.env.HOME); } catch (e) { out.home = 'error:' + e.code; }
  out.net = await tryConnect({ host: '1.1.1.1', port: 443 }, 1500);
  for (const p of cfg.readOnly) {
    try { fs.appendFileSync(p, 'x'); out.roWritable.push(p); } catch (_) {}
  }
  try { fs.writeFileSync(cfg.worktreeFile, 'ok'); out.worktreeWritable = true; } catch (_) {}
  if (cfg.forwarder) out.forwarder = await tryConnect({ host: '127.0.0.1', port: 3128 }, 1500);
  process.stdout.write(JSON.stringify(out) + '\\n');
})();
`;

export interface SelfTestFixture {
  dir: string;
  worktree: string;
  common: string;
  git: SandboxGitMounts;
  probeFile: string;
  configFile: string;
}

/** A throwaway worktree + fake git layout (`.git` pointer file, common dir) under `dir`. */
export function makeSelfTestFixture(dir: string, sockets: string[], forwarder: boolean): SelfTestFixture {
  const worktree = join(dir, 'wt');
  const common = join(dir, 'common');
  mkdirSync(worktree, { recursive: true, mode: 0o700 });
  mkdirSync(join(common, 'worktrees', 'wt'), { recursive: true, mode: 0o700 });
  writeFileSync(join(common, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(common, 'worktrees', 'wt', 'gitdir'), `${worktree}/.git\n`);
  const pointer = join(worktree, '.git');
  writeFileSync(pointer, `gitdir: ${join(common, 'worktrees', 'wt')}\n`);
  const probeFile = join(worktree, '.gmid-probe.cjs');
  writeFileSync(probeFile, PROBE_SOURCE);
  const configFile = join(worktree, '.gmid-probe.json');
  const readOnly = [pointer, join(common, 'HEAD'), join(common, 'worktrees', 'wt', 'gitdir'), join(common, 'new-file')];
  writeFileSync(configFile, JSON.stringify({ sockets, readOnly, worktreeFile: join(worktree, '.gmid-probe-out'), forwarder }));
  return { dir, worktree, common, git: { readOnly: [pointer, common], writable: [], env: {}, perThreadRefs: false }, probeFile, configFile };
}

export interface ProbeOutput {
  connected: string[];
  home: string[] | string | null;
  net: string | null;
  roWritable: string[];
  worktreeWritable: boolean;
  forwarder: string | null;
}

/** Problems in the probe output (empty = pass). */
export function evaluateProbe(raw: string, expectForwarder: boolean, homeAllowed: readonly string[] = []): string[] {
  const line = raw.trim().split('\n').pop() ?? '';
  let p: ProbeOutput;
  try {
    p = JSON.parse(line) as ProbeOutput;
  } catch {
    return ['probe produced no result'];
  }
  const problems: string[] = [];
  if (p.connected.length) problems.push(`host sockets reachable: ${p.connected.slice(0, 5).join(', ')}`);
  if (!Array.isArray(p.home) || p.home.some((e) => !homeAllowed.includes(e))) problems.push('$HOME is not empty');
  if (p.net === 'connected') problems.push('network reachable without approval');
  if (p.roWritable.length) problems.push(`git metadata writable: ${p.roWritable.length} path(s)`);
  if (!p.worktreeWritable) problems.push('worktree not writable');
  if (expectForwarder && p.forwarder !== 'connected') problems.push(`proxy forwarder not reachable (${p.forwarder ?? 'none'})`);
  return problems;
}

/** The spec the self-test runs (exec profile, production builder). */
export function selfTestSpec(fx: SelfTestFixture, env: Record<string, string>, argv: string[] | null, network: SandboxSpec['network']): SandboxSpec {
  return {
    profile: 'exec',
    threadId: 'selftest',
    ...(argv ? { argv } : { command: 'true' }),
    cwd: fx.worktree,
    worktree: fx.worktree,
    git: fx.git,
    sensitivePaths: [],
    sensitiveWrites: false,
    maskedFiles: [],
    network,
    cacheDir: null,
    env,
    timeoutMs: 20_000,
  };
}
