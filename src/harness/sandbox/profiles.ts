/**
 * Sandbox profiles (harness.md §8.3): what is mounted, platform-neutral. bwrap.ts turns the plan into an argv,
 * seatbelt.ts into an SBPL profile.
 *
 * The root is an **allowlist**: /usr (+ the /bin, /lib … links), /etc (with VPN/Docker/network-manager dirs masked),
 * CPU and cgroup info, fresh /dev, /proc, and fresh tmpfs on /tmp, /var/tmp, /run (/var/run → /run) and $HOME.
 * Nothing else of /home, /media, /mnt, /opt, /srv, /var/lib or /data is mounted, so no host Unix socket path exists
 * inside (SC-2: Docker → root on the host, system D-Bus). Then the PATH toolchains (read-only), the worktree, the git
 * mounts from GitService.sandboxMounts(), execution-sensitive files read-only, secret files masked with /dev/null,
 * this thread's caches and, with network approved, the proxy directory.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { SandboxSpec } from '../types';
import { isSecretFileName } from '../perm/hard';

export type Mount =
  | { op: 'ro-bind' | 'bind' | 'ro-bind-try'; src: string; dest: string }
  | { op: 'tmpfs'; dest: string }
  | { op: 'symlink'; target: string; dest: string }
  | { op: 'dev'; dest: string }
  | { op: 'proc'; dest: string }
  | { op: 'remount-ro'; dest: string };

/** Facts about the host the plan depends on (probed once; fixed in snapshot tests). */
export interface HostLayout {
  /** `/bin`, `/sbin`, `/lib`, `/lib64`, `/lib32`, `/libx32`: symlink target, `dir`, or absent (not listed). */
  rootLinks: Array<{ path: string; target: string | null }>;
  /** Existing `/etc` subdirectories masked with tmpfs. */
  etcMasks: string[];
  home: string;
  /** PATH toolchain directories outside /usr to bind read-only (already resolved and filtered). */
  toolchains: string[];
  /** Directory of the Node/Electron binary that runs the in-sandbox forwarder (`process.execPath`). */
  execDir: string;
  execPath: string;
}

/** Mount points inside the sandbox. */
export const SANDBOX_PROXY_DIR = '/run/gmid-proxy';
export const PROXY_SOCKET_NAME = 'proxy.sock';
export const FORWARDER_NAME = 'forwarder.cjs';

const ETC_MASKS = ['docker', 'containerd', 'NetworkManager', 'wpa_supplicant', 'wireguard', 'openvpn', 'ppp'];
const ROOT_LINKS = ['/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32'];
/** Never bound even if on PATH (§8.2.5 protected locations). */
const PROTECTED_HOME = ['.ssh', '.gnupg', '.aws', '.config', '.factory', '.claude.json', '.docker', '.kube', '.password-store', '.local/share/keyrings'];

function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * PATH directories to bind read-only: each existing absolute dir outside /usr, /bin … and its realpath. A version
 * dir of a toolchain manager (`~/.nvm/versions/node/<v>/bin` → `<v>`, which holds `lib/node_modules`) is bound as
 * a whole when it sits at least three levels below $HOME. $HOME itself, its ancestors and protected dirs never are.
 */
export function toolchainDirs(pathValue: string, home: string): string[] {
  const out = new Set<string>();
  const homeReal = safeReal(home) ?? home;
  const blocked = (p: string) =>
    p === '/' ||
    isUnder(home, p) ||
    isUnder(homeReal, p) ||
    PROTECTED_HOME.some((d) => isUnder(p, join(home, d)) || isUnder(p, join(homeReal, d))) ||
    ['/tmp', '/var', '/home', '/media', '/mnt', '/srv', '/opt', '/data'].includes(p) ||
    ['/bin', '/sbin', '/lib', '/lib64', '/etc', '/proc', '/dev', '/sys', '/run', '/var/run', '/var/lib'].some((r) => isUnder(p, r)) ||
    isUnder(p, '/usr');
  for (const entry of pathValue.split(':')) {
    if (!entry.startsWith('/')) continue;
    for (const candidate of [entry, safeReal(entry)]) {
      if (!candidate) continue;
      let st;
      try {
        st = statSync(candidate);
      } catch {
        continue;
      }
      if (!st.isDirectory() || blocked(candidate)) continue;
      let dir = candidate;
      const parent = dirname(candidate);
      if (candidate.endsWith(`${sep}bin`) && isUnder(parent, homeReal) && relative(homeReal, parent).split(sep).length >= 3) {
        try {
          if (statSync(join(parent, 'lib')).isDirectory()) dir = parent;
        } catch {
          /* bin only */
        }
      }
      if (!blocked(dir)) out.add(dir);
    }
  }
  // Drop entries already covered by a bound ancestor.
  const list = [...out].sort();
  return list.filter((d) => !list.some((o) => o !== d && isUnder(d, o)));
}

/** Probes the host once (sync; a few stat calls). */
export function probeHostLayout(opts: { home: string; path: string; execPath: string }): HostLayout {
  const rootLinks: HostLayout['rootLinks'] = [];
  for (const p of ROOT_LINKS) {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) rootLinks.push({ path: p, target: readlinkSync(p) });
      else if (st.isDirectory()) rootLinks.push({ path: p, target: null });
    } catch {
      /* absent */
    }
  }
  const etcMasks = ETC_MASKS.map((d) => `/etc/${d}`).filter((d) => {
    try {
      return lstatSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  const execReal = safeReal(opts.execPath) ?? opts.execPath;
  return { rootLinks, etcMasks, home: opts.home, toolchains: toolchainDirs(opts.path, opts.home), execDir: dirname(execReal), execPath: execReal };
}

// ─── Worktree scans (§8.2.6, §8.3) ───────────────────────────────────────────────────────────────────────────

/** Execution-sensitive and instruction paths mounted read-only (package.json, Makefile and *.sh are not: builds rewrite them). */
export const SENSITIVE_RELATIVE = ['.husky', '.git/hooks', '.github/workflows', '.envrc', '.vscode/settings.json', '.vscode/tasks.json', '.vscode/launch.json', 'AGENTS.md', 'CLAUDE.md', '.gmi-desk', '.mcp.json'];

/** Only real entries inside the worktree: a symlink as mount source could expose a host path (and is skipped). */
function realInside(worktree: string, rel: string): string | null {
  const p = join(worktree, rel);
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const real = safeReal(p);
  const wtReal = safeReal(worktree) ?? worktree;
  return real && isUnder(real, wtReal) && real === join(wtReal, rel) ? p : null;
}

/** Existing execution-sensitive paths (plus the in-repo `core.hooksPath` dir when the caller knows it). */
export function findSensitivePaths(worktree: string, extraRelative: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const rel of [...SENSITIVE_RELATIVE, ...extraRelative]) {
    if (rel.includes('..') || isAbsolute(rel)) continue;
    const p = realInside(worktree, rel);
    if (p) out.push(p);
  }
  return out;
}

/** Default bounds of the secret-file scan: generous, so `complete` is false only in pathological trees. */
export const MASK_SCAN_LIMITS = { maxDepth: 64, maxEntries: 400_000, maxFiles: 4_096 } as const;

export interface MaskScan {
  files: string[];
  /** False when a bound was hit: some secret files may be unmasked, so nothing may run without asking (review H2). */
  complete: boolean;
}

/**
 * Secret files in the worktree (regular files, case-insensitive names; skips `.git` and `node_modules`). Reports
 * whether the walk saw everything: callers fail closed on an incomplete scan.
 */
export function scanMaskedFiles(worktree: string, limits: { maxDepth?: number; maxEntries?: number; maxFiles?: number } = {}): MaskScan {
  const maxDepth = limits.maxDepth ?? MASK_SCAN_LIMITS.maxDepth;
  const maxEntries = limits.maxEntries ?? MASK_SCAN_LIMITS.maxEntries;
  const maxFiles = limits.maxFiles ?? MASK_SCAN_LIMITS.maxFiles;
  const files: string[] = [];
  let seen = 0;
  let complete = true;
  const walk = (dir: string, depth: number) => {
    if (!complete) return;
    if (depth > maxDepth) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen += 1;
      if (seen > maxEntries) {
        complete = false;
        return;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        walk(p, depth + 1);
        if (!complete) return;
      } else if (e.isFile() && isSecretFileName(e.name)) {
        if (files.length >= maxFiles) {
          complete = false;
          return;
        }
        files.push(p);
      }
    }
  };
  walk(worktree, 0);
  return { files, complete };
}

/** Secret files in the worktree (see scanMaskedFiles; the list only). */
export function findMaskedFiles(worktree: string, limits: { maxDepth?: number; maxEntries?: number; maxFiles?: number } = {}): string[] {
  return scanMaskedFiles(worktree, limits).files;
}

// ─── The plan ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlanExtras {
  /** Host directory holding `proxy.sock` and `forwarder.cjs`, mounted at /run/gmid-proxy (network `proxy`). */
  proxyDir: string | null;
  /**
   * An empty read-only regular file used to mask secret files (default `/dev/null`). bwrap bind mounts are `nodev`,
   * so a bound /dev/null cannot even be opened (EACCES); an empty file reads as empty, like the doc's /dev/null.
   */
  emptyFile?: string | null;
}

export interface SandboxPlan {
  mounts: Mount[];
  /** Keep the host network namespace (`shared`, the per-command fallback). */
  shareNet: boolean;
  cwd: string;
  env: Record<string, string>;
  /** The command argv inside the sandbox. */
  argv: string[];
}

function depth(p: string): number {
  return p.split('/').filter(Boolean).length;
}

function assertAbs(p: string, what: string): void {
  if (!isAbsolute(p) || p.includes('\0') || p.split('/').includes('..')) throw new Error(`sandbox: ${what} must be an absolute normalised path`);
}

/** The command argv: `bash --noprofile --norc -c` (never a login shell, SC-27) or the given argv. */
export function commandArgv(spec: Pick<SandboxSpec, 'command' | 'argv'>): string[] {
  if (spec.argv && spec.argv.length > 0) return [...spec.argv];
  return ['/bin/bash', '--noprofile', '--norc', '-c', spec.command ?? 'true'];
}

export function planMounts(spec: SandboxSpec, layout: HostLayout, extras: PlanExtras): SandboxPlan {
  const readonly = spec.profile === 'readonly';
  const network = readonly ? 'off' : spec.network;
  assertAbs(spec.worktree, 'worktree');
  assertAbs(spec.cwd, 'cwd');
  if (!isUnder(spec.cwd, spec.worktree)) throw new Error('sandbox: cwd must be inside the worktree');
  const home = layout.home;
  const m: Mount[] = [{ op: 'ro-bind', src: '/usr', dest: '/usr' }];
  for (const l of layout.rootLinks) m.push(l.target === null ? { op: 'ro-bind', src: l.path, dest: l.path } : { op: 'symlink', target: l.target, dest: l.path });
  m.push({ op: 'ro-bind', src: '/etc', dest: '/etc' });
  for (const d of layout.etcMasks) m.push({ op: 'tmpfs', dest: d });
  m.push({ op: 'ro-bind-try', src: '/sys/devices/system/cpu', dest: '/sys/devices/system/cpu' });
  m.push({ op: 'ro-bind-try', src: '/sys/fs/cgroup', dest: '/sys/fs/cgroup' });
  m.push({ op: 'dev', dest: '/dev' }, { op: 'proc', dest: '/proc' });
  m.push({ op: 'tmpfs', dest: '/tmp' }, { op: 'tmpfs', dest: '/var/tmp' }, { op: 'tmpfs', dest: '/run' }, { op: 'symlink', target: '../run', dest: '/var/run' });
  const homeOk = isAbsolute(home) && depth(home) >= 1 && !['/usr', '/etc', '/tmp', '/run', '/proc', '/dev'].some((r) => isUnder(home, r));
  if (homeOk) m.push({ op: 'tmpfs', dest: home });
  for (const t of layout.toolchains) m.push({ op: 'ro-bind', src: t, dest: t });
  const usesForwarder = network === 'proxy' && extras.proxyDir !== null;
  // The Node/Electron binary that runs the forwarder (or the self-test probe), read-only.
  const needsExec = usesForwarder || (spec.argv?.[0] !== undefined && spec.argv[0] === layout.execPath);
  if (needsExec && !layout.toolchains.some((t) => isUnder(layout.execDir, t)) && !isUnder(layout.execDir, '/usr')) {
    m.push({ op: 'ro-bind', src: layout.execDir, dest: layout.execDir });
  }

  // Project mounts, parents before children; at equal depth a read-only mount wins over a writable one.
  const project: Array<{ mount: Mount; prio: number; order: number }> = [];
  const add = (mount: Mount & { dest: string }, prio: number) => project.push({ mount, prio, order: project.length });
  add({ op: readonly ? 'ro-bind' : 'bind', src: spec.worktree, dest: spec.worktree }, 0);
  if (spec.git) {
    for (const p of spec.git.writable) {
      assertAbs(p, 'git mount');
      add({ op: readonly ? 'ro-bind' : 'bind', src: p, dest: p }, 1);
    }
    for (const p of spec.git.readOnly) {
      assertAbs(p, 'git mount');
      add({ op: 'ro-bind', src: p, dest: p }, 2);
    }
  }
  if (!readonly && !spec.sensitiveWrites) {
    for (const p of spec.sensitivePaths) {
      assertAbs(p, 'sensitive path');
      if (isUnder(p, spec.worktree)) add({ op: 'ro-bind', src: p, dest: p }, 3);
    }
  }
  for (const p of spec.maskedFiles) {
    assertAbs(p, 'masked file');
    if (isUnder(p, spec.worktree)) add({ op: 'ro-bind', src: extras.emptyFile ?? '/dev/null', dest: p }, 4);
  }
  project.sort((a, b) => depth(a.mount.op === 'symlink' ? a.mount.dest : a.mount.dest) - depth(b.mount.dest) || a.prio - b.prio || a.order - b.order);
  for (const p of project) m.push(p.mount);

  if (!readonly && spec.cacheDir && homeOk) {
    assertAbs(spec.cacheDir, 'cache dir');
    m.push({ op: 'bind', src: join(spec.cacheDir, 'cache'), dest: join(home, '.cache') });
    m.push({ op: 'bind', src: join(spec.cacheDir, 'npm'), dest: join(home, '.npm') });
    m.push({ op: 'bind', src: join(spec.cacheDir, 'pip'), dest: join(home, '.cache', 'pip') });
  }
  if (usesForwarder) m.push({ op: 'ro-bind', src: extras.proxyDir as string, dest: SANDBOX_PROXY_DIR });
  if (readonly && homeOk) m.push({ op: 'remount-ro', dest: home });

  let argv = commandArgv(spec);
  const env = { ...spec.env };
  if (usesForwarder) {
    argv = [layout.execPath, `${SANDBOX_PROXY_DIR}/${FORWARDER_NAME}`, '--', ...argv];
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return { mounts: m, shareNet: network === 'shared', cwd: spec.cwd, env, argv };
}
