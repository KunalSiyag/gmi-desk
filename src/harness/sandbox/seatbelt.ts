/**
 * macOS sandbox (harness.md §8.3): `sandbox-exec -p <profile>`, deny by default (the model Codex uses). Allows process
 * exec/fork and sysctl reads; reads of `/` except the denied secret paths and other users' homes; writes to the
 * worktree, this thread's writable git paths, the thread caches and the private temp dir; network only to the
 * proxy's Unix socket; no other Unix socket. Built from the same plan inputs as bwrap. Not exercised on Linux CI:
 * snapshot-tested only (the live tests run where bwrap is available).
 */
import { join } from 'node:path';
import type { SandboxSpec } from '../types';
import { commandArgv, FORWARDER_NAME, PROXY_SOCKET_NAME } from './profiles';

/** SBPL string literal. */
function lit(s: string): string {
  if (s.includes('\0')) throw new Error('sandbox: NUL in path');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface SeatbeltOptions {
  home: string;
  /** Host dir with proxy.sock and forwarder.cjs (network `proxy`). */
  proxyDir: string | null;
  /** Private per-command temp dir (TMPDIR). */
  tmpDir: string;
  execPath: string;
  /**
   * The app's userData (every thread's transcript, spill files, auth state): never readable (§8.2.5; review H2). The
   * thread's own cache, object and proxy dirs below it are allowed again explicitly.
   */
  userData?: string | null;
}

const DENIED_HOME = ['.ssh', '.gnupg', '.aws', '.config/gh', '.factory', '.claude.json', '.docker', '.kube', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'Library/Keychains'];

export function buildSeatbeltProfile(spec: SandboxSpec, opts: SeatbeltOptions): string {
  const readonly = spec.profile === 'readonly';
  const writable: string[] = [];
  if (!readonly) {
    writable.push(spec.worktree, ...(spec.git?.writable ?? []));
    if (spec.cacheDir) writable.push(spec.cacheDir);
  }
  writable.push(opts.tmpDir);
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow file-read*)',
    // Other users' homes and the secret paths of this one.
    `(deny file-read* (require-all (subpath "/Users") (require-not (subpath ${lit(opts.home)}))))`,
    ...DENIED_HOME.map((d) => `(deny file-read* (subpath ${lit(join(opts.home, d))}))`),
    ...(opts.userData ? [`(deny file-read* file-write* (subpath ${lit(opts.userData)}))`] : []),
    // Re-allowed after the userData deny (later rules win): this command's own writable roots and the proxy socket dir.
    ...(opts.userData ? [...writable, ...(opts.proxyDir && spec.network === 'proxy' && !readonly ? [opts.proxyDir] : [])].map((w) => `(allow file-read* (subpath ${lit(w)}))`) : []),
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))',
    ...writable.map((w) => `(allow file-write* (subpath ${lit(w)}))`),
  ];
  // Read-only inside writable roots: git metadata, execution-sensitive files, masked secrets (deny wins when later).
  for (const p of spec.git?.readOnly ?? []) lines.push(`(deny file-write* (subpath ${lit(p)}))`);
  if (!spec.sensitiveWrites) for (const p of spec.sensitivePaths) lines.push(`(deny file-write* (subpath ${lit(p)}))`);
  for (const p of spec.maskedFiles) lines.push(`(deny file-read* file-write* (literal ${lit(p)}))`);
  if (!readonly && spec.network === 'proxy' && opts.proxyDir) {
    lines.push(`(allow network-outbound (remote unix-socket (path-literal ${lit(join(opts.proxyDir, PROXY_SOCKET_NAME))})))`);
    lines.push('(allow network-bind network-inbound (local ip "localhost:3128"))');
    lines.push('(allow network-outbound (remote ip "localhost:3128"))');
  } else if (!readonly && spec.network === 'shared') {
    lines.push('(allow network*)');
  }
  return `${lines.join('\n')}\n`;
}

/** `sandbox-exec -p <profile> -- <argv>` (with the forwarder in front when the proxy is used). */
export function buildSeatbeltArgv(spec: SandboxSpec, opts: SeatbeltOptions): string[] {
  let argv = commandArgv(spec);
  if (spec.profile !== 'readonly' && spec.network === 'proxy' && opts.proxyDir) argv = [opts.execPath, join(opts.proxyDir, FORWARDER_NAME), '--', ...argv];
  return ['/usr/bin/sandbox-exec', '-p', buildSeatbeltProfile(spec, opts), '--', ...argv];
}
