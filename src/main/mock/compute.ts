// Mock simulators of the Cluster Engine and Sandbox v2 APIs (compute.md §16), behind the same client interfaces as the
// real ones (CePublicApi, CeApi, SandboxApi, DataPlaneApi). Owned by C1-B; wired by the compute slice when `ctx.mock`.
//
// Nothing here touches the network: no `ctx.http`, no fetch. Phases advance lazily on read (creating 3 s → running;
// pause / resume 2 s; delete 2 s), so there are no timers to dispose. The data plane runs a fake filesystem and a small
// shell (exec and the PTY share it): ls, pwd, cd, cat, echo, printf, clear, uname -a, nvidia-smi (canned), nproc, free,
// df, id, mkdir, rm, mv, touch, find -printf, `python3 -m http.server N` (registers a listening port), nohup services.
// Errors are built with the real mapper (`computeErrorFrom`), so mock and real mode fail the same way.
//
// GMI_DESK_MOCK_COMPUTE=<flags> (mock only; in DEV_ENV_VARS): see MOCK_COMPUTE_FLAGS.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Budget } from '@shared/contracts/usage';
import { GmiError } from '@shared/contracts/errors';
import type { ComputeKeyProvider } from '../core/services';
import type { CeApi, CeLogsResult, CePublicApi, CreateOutcome } from '../services/compute/ce/client';
import type {
  CeContainer,
  CeContainerStatus,
  CeElasticIp,
  CeFirewall,
  CeIdc,
  CeProduct,
  CeSshKey,
  CeTemplate,
} from '../services/compute/ce/dto';
import { computeErrorFrom, type ComputeApiFamily } from '../services/compute/errors';
import type { SandboxApi, SandboxListQuery } from '../services/compute/sandbox/client';
import {
  createTokenCache,
  isTerminalExec,
  validateExecInput,
  assertRemotePath,
  type DataPlaneApi,
  type DownloadResult,
  type ExecInput,
  type ReadFileResult,
  type TokenCache,
} from '../services/compute/sandbox/dataplane';
import type {
  V2ConnectResult,
  V2CreateSandboxRequest,
  V2CreateSandboxResult,
  V2ExecResult,
  V2Page,
  V2Product,
  V2SandboxDetail,
  V2SandboxSummary,
  V2Snapshot,
  V2Template,
} from '../services/compute/sandbox/dto';
import { redactContainer } from '../services/compute/sanitize';
import accountFixture from './fixtures/compute/account-products.json';
import billingFixture from './fixtures/compute/billing-products.json';
import containersFixture from './fixtures/compute/containers.json';
import eipsFixture from './fixtures/compute/eips.json';
import firewallsFixture from './fixtures/compute/firewalls.json';
import idcsFixture from './fixtures/compute/idcs.json';
import logsFixture from './fixtures/compute/logs.json';
import publicTemplatesFixture from './fixtures/compute/public-templates.json';
import sandboxCatalogFixture from './fixtures/compute/sandbox-catalog.json';
import sandboxesFixture from './fixtures/compute/sandboxes.json';
import snapshotsFixture from './fixtures/compute/snapshots.json';

// ─── Flags ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every GMI_DESK_MOCK_COMPUTE flag (compute.md §16). */
export const MOCK_COMPUTE_FLAGS = [
  'no_key',
  'not_entitled',
  'sandboxes_only',
  'create_fails',
  'create_unknown',
  'orphan',
  'orphan_other_install',
  'eip_orphan',
  'budget_low',
  'no_daily_budget',
  'lease_expiring',
  'lease_action_failed',
  'org_billing',
  'paused',
  'cold_resume',
  'shell_busy',
  'api_down',
  'price_unknown',
] as const;
export type MockComputeFlag = (typeof MOCK_COMPUTE_FLAGS)[number];

const KNOWN_FLAGS: ReadonlySet<string> = new Set(MOCK_COMPUTE_FLAGS);

/** Parses GMI_DESK_MOCK_COMPUTE (unknown names are ignored). */
export function mockComputeFlags(raw: string | undefined = process.env.GMI_DESK_MOCK_COMPUTE): Set<MockComputeFlag> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f): f is MockComputeFlag => KNOWN_FLAGS.has(f)),
  );
}

/**
 * What the flags mean outside the simulated APIs, for the slice wiring (C1-C) and the guard (C1-D) to apply in mock
 * mode: the budget seed, how much of today is already spent, and the lease state of the demo container.
 */
export interface MockComputeScenario {
  /** Budget to seed (null: leave the user's mock budget alone). `no_daily_budget` → no daily limit. */
  budget: Partial<Budget> | null;
  /** Local spend already recorded today (USD), so `budget_low` shows a nearly used budget. */
  spentTodayUsd: number;
  /** `lease_expiring`: the demo container's lease ends this many minutes from now. Null: the default 4 h lease. */
  leaseEndsInMin: number | null;
  /** `lease_action_failed`: guard deletes / pauses fail (the simulators answer 503). */
  leaseActionsFail: boolean;
  /** `no_key`: act as if no Compute key is stored. */
  noKey: boolean;
}

export function mockComputeScenario(flags: ReadonlySet<string>): MockComputeScenario {
  return {
    budget: flags.has('no_daily_budget') ? { dailyUsd: null } : flags.has('budget_low') ? { dailyUsd: 5, enforce: true } : { dailyUsd: 25, enforce: true },
    spentTodayUsd: flags.has('budget_low') ? 4.6 : 0,
    leaseEndsInMin: flags.has('lease_expiring') ? 12 : null,
    leaseActionsFail: flags.has('lease_action_failed'),
    noKey: flags.has('no_key'),
  };
}

/** The fake key mock mode uses (never a real credential; the simulators ignore it). */
export const MOCK_COMPUTE_KEY = 'mock-compute-key-not-a-secret';

/** A ComputeKeyProvider for mock mode: a fake key unless `no_key`. */
export function mockComputeKeyProvider(flags: ReadonlySet<string>): ComputeKeyProvider {
  const has = !flags.has('no_key');
  return {
    getComputeKey: async () => (has ? MOCK_COMPUTE_KEY : null),
    requireComputeKey: async () => {
      if (!has) throw new GmiError('no_compute_key', 'Compute needs a GMI Compute API key. Connect Compute to add one.');
      return MOCK_COMPUTE_KEY;
    },
    reportInvalidComputeKey: async () => undefined,
    onChange: () => () => undefined,
  };
}

// ─── Fixture expansion ─────────────────────────────────────────────────────────────────────────────────────────────

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Replaces `{inst6}`, `{inst}`, `{ago:90m}` and `{in:2h}` in every string of a fixture value (a deep copy). */
export function expandFixture<T>(value: T, vars: { inst6: string; inst: string; now: number }): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v
        .replace(/\{inst6\}/g, vars.inst6)
        .replace(/\{inst\}/g, vars.inst)
        .replace(/^\{(ago|in):(\d+)([smhd])\}$/, (_m, dir: string, n: string, unit: string) => {
          const delta = Number(n) * (UNIT_MS[unit] ?? 0);
          return new Date(vars.now + (dir === 'ago' ? -delta : delta)).toISOString();
        });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_note').map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

function withFlags<T>(fixture: { base: unknown[]; flags?: Record<string, unknown[]> }, flags: ReadonlySet<string>): T[] {
  const out = [...fixture.base];
  for (const [flag, rows] of Object.entries(fixture.flags ?? {})) if (flags.has(flag)) out.push(...rows);
  return out as T[];
}

// ─── Errors (through the real mapper) ──────────────────────────────────────────────────────────────────────────────

const err = (family: ComputeApiFamily, status: number, body: unknown) =>
  computeErrorFrom({ family, status, body: typeof body === 'string' ? body : JSON.stringify(body) });

const downError = (family: ComputeApiFamily) => err(family, 503, '<html><body>503 Service Temporarily Unavailable (demo)</body></html>');
const NOT_ENTITLED = { reason: 'access denied: tenant has no permission to do the operation' };
const v2Body = (code: string, message: string, details?: Record<string, unknown>) => ({ code, message, request_id: `req-mock-${rand(6)}`, ...(details ? { details } : {}) });

function rand(n: number): string {
  return randomBytes(n).toString('hex').slice(0, n);
}

// ─── Timing ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MOCK_COMPUTE_TIMING = { creatingMs: 3_000, pauseMs: 2_000, resumeMs: 2_000, deleteMs: 2_000, restartMs: 2_000 } as const;

export interface MockComputeOptions {
  flags?: ReadonlySet<string>;
  /** `inst6` of this install (C1-C names.ts): managed demo containers carry it. */
  installTag: string;
  /** The `inst` metadata label of this install's sandboxes. */
  installLabel: string;
  now?: () => Date;
}

export interface MockCompute {
  publicApi: CePublicApi;
  ce: CeApi;
  sandbox: SandboxApi;
  dataPlane: DataPlaneApi;
  tokens: TokenCache;
  /** A fake PTY for the computer's terminal in mock mode (C2-A wires it instead of a WebSocket). */
  openPty(sandboxId: string): MockPty;
  scenario: MockComputeScenario;
  flags: ReadonlySet<string>;
  /** Sandboxes resumed (cold) since the simulator started; `cold_resume` marks the demo ones. */
  coldResumed: ReadonlySet<string>;
}

export interface MockPty {
  write(data: string | Uint8Array): void;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  resize(cols: number, rows: number): void;
  close(): void;
}

// ─── Fake filesystem + shell (shared by exec and the PTY) ──────────────────────────────────────────────────────────

interface FsNode {
  type: 'dir' | 'file';
  data: Uint8Array;
  mode: string;
  mtime: number;
}

class FakeMachine {
  readonly fs = new Map<string, FsNode>();
  readonly ports = new Set<number>();
  readonly services: string[] = [];
  readonly home = '/root';
  cwd = '/root';
  constructor(
    readonly hostname: string,
    private readonly now: () => number,
    readonly gpu: boolean,
  ) {
    const t = now();
    for (const d of ['/', '/root', '/root/app', '/tmp', '/etc', '/proc', '/proc/net']) this.fs.set(d, { type: 'dir', data: new Uint8Array(), mode: '755', mtime: t });
    this.put('/root/app/README.md', '# Demo app\n\nRun `python3 -m http.server 8000` to preview it.\n');
    this.put('/root/app/main.py', 'print("hello from the GMI Desk demo sandbox")\n');
    this.put('/root/app/index.html', '<!doctype html><title>Demo</title><h1>It works</h1>\n');
    this.put('/etc/hostname', `${hostname}\n`);
  }
  put(path: string, text: string | Uint8Array, mode = '644') {
    this.fs.set(path, { type: 'file', data: typeof text === 'string' ? new TextEncoder().encode(text) : text, mode, mtime: this.now() });
  }
  resolve(p: string): string {
    const parts = (p.startsWith('/') ? p : `${this.cwd}/${p}`).replace(/^~(?=\/|$)/, this.home).split('/');
    const out: string[] = [];
    for (const s of parts) {
      if (!s || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return `/${out.join('/')}`;
  }
  children(dir: string): string[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    return [...this.fs.keys()].filter((k) => k !== dir && k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).sort();
  }
  procNetTcp(): string {
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    return head + [...this.ports].sort((a, b) => a - b).map((p, i) => `   ${i}: 00000000:${p.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 ${1000 + i} 1\n`).join('');
  }
  readText(path: string): string | null {
    if (path === '/proc/net/tcp') return this.procNetTcp();
    if (path === '/proc/net/tcp6') return '  sl  local_address                         remote_address                        st\n';
    const n = this.fs.get(path);
    return n && n.type === 'file' ? new TextDecoder().decode(n.data) : null;
  }
  ensureParent(path: string): boolean {
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    return this.fs.get(parent)?.type === 'dir';
  }
}

interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Splits a command line into words (single/double quotes, `$VAR`, `$(id -un)`, `$(pwd)`). */
function words(line: string, env: Record<string, string>, m: FakeMachine): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const expand = (s: string) =>
    s
      .replace(/\$\((id -un|whoami)\)/g, 'root')
      .replace(/\$\(pwd\)/g, m.cwd)
      .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_x, name: string) => env[name] ?? (name === 'HOME' ? m.home : ''));
  while (i < line.length) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end < 0 ? undefined : end);
      has = true;
      i = end < 0 ? line.length : end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < line.length && line[j] !== '"') {
        if (line[j] === '\\' && j + 1 < line.length) {
          s += line[j + 1];
          j += 2;
        } else {
          s += line[j];
          j += 1;
        }
      }
      cur += expand(s);
      has = true;
      i = j + 1;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i += 1;
    } else {
      let j = i;
      while (j < line.length && !/[\s'"]/.test(line[j] as string)) j += 1;
      cur += expand(line.slice(i, j));
      has = true;
      i = j;
    }
  }
  if (has) out.push(cur);
  return out;
}

function unescapeFormat(fmt: string): string {
  return fmt.replace(/\\([tn0\\])/g, (_m, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === '0' ? '\0' : '\\'));
}

const NVIDIA_SMI = `+-----------------------------------------------------------------------------+
| NVIDIA-SMI 550.54     Driver Version: 550.54     CUDA Version: 12.4           |
|-------------------------------+----------------------+----------------------+
| GPU  Name        Persistence-M| Bus-Id        Disp.A | Volatile Uncorr. ECC |
|   0  NVIDIA H200          On  | 00000000:18:00.0 Off |                    0 |
| N/A   31C    P0    72W / 700W |      0MiB / 143771MiB |      0%      Default |
+-------------------------------+----------------------+----------------------+
`;

/** Runs one command line on the fake machine. */
function runLine(m: FakeMachine, line: string, env: Record<string, string> = {}): ShellResult {
  let stdout = '';
  let stderr = '';
  let code = 0;
  const segments = line.split(/\s*(;|&&|\|\|)\s*/);
  let op = ';';
  for (const seg of segments) {
    if (seg === ';' || seg === '&&' || seg === '||') {
      op = seg;
      continue;
    }
    if ((op === '&&' && code !== 0) || (op === '||' && code === 0)) continue;
    if (!seg.trim()) continue;
    let cmd = seg.trim().replace(/\s*&$/, '');
    let redirect: string | null = null;
    const r = /\s(?:1)?>\s*(\S+)(?:\s+2>&1)?\s*$/.exec(cmd);
    if (r && !cmd.startsWith('printf')) {
      redirect = r[1] ?? null;
      cmd = cmd.slice(0, r.index);
    }
    const res = runSimple(m, cmd, env);
    code = res.code;
    if (redirect) {
      const target = m.resolve(words(redirect, env, m)[0] ?? redirect);
      if (m.ensureParent(target)) m.put(target, res.stdout);
    } else stdout += res.stdout;
    stderr += res.stderr;
  }
  return { stdout, stderr, code };
}

function runSimple(m: FakeMachine, cmd: string, env: Record<string, string>): ShellResult {
  const w = words(cmd, env, m);
  const [name, ...args] = w;
  const ok = (stdout = ''): ShellResult => ({ stdout, stderr: '', code: 0 });
  const fail = (stderr: string, code = 1): ShellResult => ({ stdout: '', stderr, code });
  const paths = args.filter((a) => !a.startsWith('-'));
  switch (name) {
    case undefined:
      return ok();
    case 'pwd':
      return ok(`${m.cwd}\n`);
    case 'cd': {
      const target = m.resolve(paths[0] ?? m.home);
      if (m.fs.get(target)?.type !== 'dir') return fail(`cd: ${paths[0]}: No such file or directory\n`);
      m.cwd = target;
      return ok();
    }
    case 'ls': {
      const long = args.some((a) => /^-\w*l/.test(a));
      const target = m.resolve(paths[0] ?? '.');
      const node = m.fs.get(target);
      if (!node) return fail(`ls: cannot access '${paths[0]}': No such file or directory\n`, 2);
      const names = node.type === 'dir' ? m.children(target).map((p) => p.slice(p.lastIndexOf('/') + 1)) : [target.slice(target.lastIndexOf('/') + 1)];
      if (!long) return ok(names.length ? `${names.join('  ')}\n` : '');
      return ok(
        names
          .map((n) => {
            const f = m.fs.get(node.type === 'dir' ? m.resolve(`${target}/${n}`) : target) as FsNode;
            return `${f.type === 'dir' ? 'd' : '-'}rw-r--r-- 1 root root ${String(f.data.byteLength).padStart(6)} Nov  2 09:00 ${n}`;
          })
          .join('\n') + '\n',
      );
    }
    case 'cat': {
      let out = '';
      for (const p of paths) {
        const text = m.readText(m.resolve(p));
        if (text === null) return { stdout: out, stderr: `cat: ${p}: No such file or directory\n`, code: 1 };
        out += text;
      }
      return ok(out);
    }
    case 'echo':
      return ok(`${args.join(' ')}\n`);
    case 'printf': {
      const fmt = unescapeFormat(args[0] ?? '');
      let k = 1;
      return ok(fmt.replace(/%s/g, () => args[k++] ?? ''));
    }
    case 'clear':
      return ok('\x1b[H\x1b[2J');
    case 'uname':
      return ok(`Linux ${m.hostname} 6.8.0-gmi #1 SMP x86_64 GNU/Linux\n`);
    case 'nvidia-smi':
      return m.gpu ? ok(NVIDIA_SMI) : fail('nvidia-smi: command not found\n', 127);
    case 'nproc':
      return ok('2\n');
    case 'free':
      return ok('               total        used        free      shared  buff/cache   available\nMem:            4096         612        2871           4         612        3241\nSwap:              0           0           0\n');
    case 'df':
      return ok('Filesystem      Size  Used Avail Use% Mounted on\noverlay          20G  2.1G   18G  11% /\n');
    case 'id':
      return ok(args.includes('-u') ? '0\n' : 'root\n');
    case 'whoami':
      return ok('root\n');
    case 'true':
    case 'sleep':
      return ok();
    case 'false':
      return fail('');
    case 'mkdir': {
      for (const p of paths) {
        const target = m.resolve(p);
        const parts = target.split('/').filter(Boolean);
        for (let i = 1; i <= parts.length; i += 1) {
          const sub = `/${parts.slice(0, i).join('/')}`;
          if (!m.fs.has(sub)) {
            if (i < parts.length && !args.includes('-p')) return fail(`mkdir: cannot create directory '${p}': No such file or directory\n`);
            m.fs.set(sub, { type: 'dir', data: new Uint8Array(), mode: '755', mtime: Date.now() });
          }
        }
      }
      return ok();
    }
    case 'touch':
      for (const p of paths) {
        const target = m.resolve(p);
        if (!m.fs.has(target)) {
          if (!m.ensureParent(target)) return fail(`touch: cannot touch '${p}': No such file or directory\n`);
          m.put(target, '');
        }
      }
      return ok();
    case 'rm': {
      for (const p of paths) {
        const target = m.resolve(p);
        if (target === '/' || target === m.home) return fail(`rm: refusing to remove '${p}'\n`);
        if (!m.fs.has(target)) {
          if (args.some((a) => a.includes('f'))) continue;
          return fail(`rm: cannot remove '${p}': No such file or directory\n`);
        }
        for (const k of [...m.fs.keys()]) if (k === target || k.startsWith(`${target}/`)) m.fs.delete(k);
      }
      return ok();
    }
    case 'mv': {
      const [from, to] = paths.map((p) => m.resolve(p));
      if (!from || !to || !m.fs.has(from)) return fail(`mv: cannot stat '${paths[0] ?? ''}': No such file or directory\n`);
      const dest = m.fs.get(to)?.type === 'dir' ? `${to}/${from.slice(from.lastIndexOf('/') + 1)}` : to;
      for (const k of [...m.fs.keys()]) {
        if (k === from || k.startsWith(`${from}/`)) {
          m.fs.set(dest + k.slice(from.length), m.fs.get(k) as FsNode);
          m.fs.delete(k);
        }
      }
      return ok();
    }
    case 'find': {
      // find "$GMID_P" -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%m\t%f\0'
      const root = m.resolve(paths[0] ?? '.');
      if (m.fs.get(root)?.type !== 'dir') return fail(`find: '${paths[0]}': No such file or directory\n`);
      const fi = args.indexOf('-printf');
      const fmt = fi >= 0 ? unescapeFormat(args[fi + 1] ?? '%p\n') : '%p\n';
      return ok(
        m
          .children(root)
          .map((p) => {
            const f = m.fs.get(p) as FsNode;
            return fmt
              .replace(/%y/g, f.type === 'dir' ? 'd' : 'f')
              .replace(/%s/g, String(f.data.byteLength))
              .replace(/%T@/g, (f.mtime / 1000).toFixed(10))
              .replace(/%m/g, f.mode)
              .replace(/%f/g, p.slice(p.lastIndexOf('/') + 1))
              .replace(/%p/g, p);
          })
          .join(''),
      );
    }
    case 'python3':
    case 'python': {
      const i = args.indexOf('http.server');
      if (args[0] === '-m' && i === 1) {
        const port = Number(args[2] ?? 8000);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('python3: invalid port\n', 2);
        m.ports.add(port);
        return ok(`Serving HTTP on 0.0.0.0 port ${port} (http://0.0.0.0:${port}/) ...\n`);
      }
      if (paths[0]) {
        const text = m.readText(m.resolve(paths[0]));
        if (text === null) return fail(`python3: can't open file '${paths[0]}'\n`, 2);
        const printed = /print\("([^"]*)"\)/.exec(text)?.[1];
        return ok(printed ? `${printed}\n` : '');
      }
      return fail('Python 3.12 interactive mode is not available in the demo.\n', 1);
    }
    case 'nohup': {
      // nohup sh -c "$GMID_CMD" > /tmp/gmid-svc-$GMID_NAME.log 2>&1 &
      const inner = args[0] === 'sh' && args[1] === '-c' ? (args[2] ?? '') : args.join(' ');
      m.services.push(inner);
      const res = runLine(m, inner, env);
      void res;
      return ok();
    }
    case 'sh':
    case 'bash':
      return args[0] === '-c' ? runLine(m, args[1] ?? '', env) : fail(`${name}: interactive shells are not available in the demo\n`);
    case 'ss':
      return fail('ss: command not found\n', 127);
    case 'command':
      return args[1] === 'ss' ? fail('', 1) : ok(`/usr/bin/${args[1] ?? ''}\n`);
    default:
      return fail(`${name}: command not found\n`, 127);
  }
}

// ─── The simulator ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Transition<S> {
  to: S | 'gone';
  at: number;
  then?: Transition<S>;
}

interface SimContainer {
  wire: CeContainer;
  next: Transition<CeContainerStatus> | null;
}

interface SimSandbox {
  detail: V2SandboxDetail;
  next: Transition<string> | null;
  idemKey: string | null;
  created: V2CreateSandboxResult | null;
}

export function createMockCompute(opts: MockComputeOptions): MockCompute {
  const flags: ReadonlySet<string> = opts.flags ?? mockComputeFlags();
  const nowDate = opts.now ?? (() => new Date());
  const now = () => nowDate().getTime();
  const iso = (t = now()) => new Date(t).toISOString();
  const vars = { inst6: opts.installTag, inst: opts.installLabel, now: now() };
  /** `shell_busy`: another client holds each sandbox's shell until a Take over (`shellControl` close) ends it. */
  const shellTakenOver = new Set<string>();
  const shellBusy = (sandboxId: string) => flags.has('shell_busy') && !shellTakenOver.has(sandboxId);
  const scenario = mockComputeScenario(flags);
  const down = flags.has('api_down');
  const ceDenied = flags.has('not_entitled') || flags.has('sandboxes_only');
  const v2Denied = flags.has('not_entitled');

  // ── state ──
  const containers = new Map<string, SimContainer>();
  for (const c of expandFixture(withFlags<CeContainer>(containersFixture as never, flags), vars)) containers.set(c.id, { wire: c, next: null });
  const eips = new Map<string, CeElasticIp>();
  for (const e of expandFixture(withFlags<CeElasticIp>(eipsFixture as never, flags), vars)) eips.set(e.id, e);
  const firewalls = new Map<string, CeFirewall>();
  for (const f of expandFixture(firewallsFixture.items as unknown as CeFirewall[], vars)) firewalls.set(f.id, f);
  const sandboxes = new Map<string, SimSandbox>();
  for (const s of expandFixture(withFlags<V2SandboxDetail>(sandboxesFixture as never, flags), vars)) sandboxes.set(s.id, { detail: s, next: null, idemKey: null, created: null });
  const snapshots = new Map<string, V2Snapshot>();
  for (const s of expandFixture(snapshotsFixture.items as unknown as V2Snapshot[], vars)) snapshots.set(s.snapshot_id, s);
  const machines = new Map<string, FakeMachine>();
  const coldResumed = new Set<string>();
  // `cold_resume`: the demo sandbox has just come back from a pause (the session shows "Restart services").
  if (flags.has('cold_resume')) for (const id of sandboxes.keys()) coldResumed.add(id);

  const machine = (sandboxId: string): FakeMachine => {
    let mm = machines.get(sandboxId);
    if (!mm) {
      const sb = sandboxes.get(sandboxId);
      mm = new FakeMachine(sb?.detail.sandbox_key ?? 'sandbox', now, false);
      machines.set(sandboxId, mm);
    }
    return mm;
  };

  // ── lazy phase progression ──
  function advanceContainers() {
    const t = now();
    for (const [id, c] of containers) {
      while (c.next && t >= c.next.at) {
        const step: Transition<CeContainerStatus> = c.next;
        if (step.to === 'gone') {
          containers.delete(id);
          for (const e of eips.values()) if (e.instanceID === id) Object.assign(e, { status: 'disassociated', instanceID: null, instanceType: null });
          break;
        }
        c.wire = { ...c.wire, status: step.to, modifiedAt: iso(step.at) };
        c.next = step.then ?? null;
      }
    }
  }

  function advanceSandboxes() {
    const t = now();
    for (const s of sandboxes.values()) {
      while (s.next && t >= s.next.at) {
        const step: Transition<string> = s.next;
        const d = s.detail;
        if (step.to === 'running') {
          s.detail = { ...d, state: 'running', ...(d.running_at ? {} : { running_at: iso(step.at), started_at: iso(step.at) }) };
          delete s.detail.pause;
          delete s.detail.paused_at;
        } else if (step.to === 'paused') s.detail = { ...d, state: 'paused', paused_at: iso(step.at), paused_expire_at: iso(step.at + 7 * 86_400_000) };
        else if (step.to === 'deleted') s.detail = { ...d, state: 'deleted', deletion: { ...(d.deletion as NonNullable<V2SandboxDetail['deletion']>), completed_at: iso(step.at) } };
        else s.detail = { ...d, state: step.to as string };
        s.next = step.then ?? null;
      }
      // Server timeout (on_timeout pause | kill).
      const d = s.detail;
      if (d.state === 'running' && d.end_at && Date.parse(d.end_at) <= t) {
        if (d.lifecycle?.on_timeout === 'kill') {
          s.detail = { ...d, state: 'deleted', deletion: { code: 'Sandbox.Expired', initiator: 'lifecycle', message: 'Expired.', requested_at: d.end_at, completed_at: d.end_at } };
        } else {
          s.detail = { ...d, state: 'paused', paused_at: d.end_at, paused_expire_at: iso(Date.parse(d.end_at) + 7 * 86_400_000), pause: { code: 'Sandbox.Expired', initiator: 'lifecycle', message: 'Paused at its time limit.', requested_at: d.end_at } };
        }
      }
    }
  }

  const ceGuard = () => {
    if (down) throw downError('ce');
    if (ceDenied) throw err('ce', 403, NOT_ENTITLED);
  };
  const v2Guard = () => {
    if (down) throw downError('v2');
    if (v2Denied) throw err('v2', 403, v2Body('Auth.Forbidden', 'access denied: tenant has no permission to do the operation'));
  };
  const leaseFail = (family: ComputeApiFamily) => {
    if (scenario.leaseActionsFail) throw err(family, 503, '<html>503 (demo: lease_action_failed)</html>');
  };
  const notFound = (family: ComputeApiFamily, what: string) =>
    family === 'ce' ? err(family, 404, { reason: `resource ${what} was not found` }) : err(family, 404, v2Body('Resource.NotFound', `${what} not found`));

  // ── public feeds ──
  const publicApi: CePublicApi = {
    async idcs() {
      if (down) throw downError('public');
      return expandFixture(idcsFixture.idcs, vars) as CeIdc[];
    },
    async publicTemplates() {
      if (down) throw downError('public');
      return expandFixture(publicTemplatesFixture.templates, vars) as CeTemplate[];
    },
    async billingProducts(dataCenter) {
      if (down) throw downError('public');
      let rows = billingFixture.products as Array<{ instanceType: string; dataCenter: string }>;
      if (flags.has('price_unknown')) rows = rows.filter((r) => r.instanceType !== 'gmi.container.nv.H100x1.tw1');
      if (dataCenter) rows = rows.filter((r) => r.dataCenter === dataCenter);
      return { products: rows.map((r) => ({ ...r })) };
    },
  };

  // ── Cluster Engine ──
  const ce: CeApi = {
    async listContainers() {
      ceGuard();
      advanceContainers();
      return [...containers.values()].map((c) => redactContainer(c.wire));
    },
    async getContainer(id) {
      ceGuard();
      advanceContainers();
      const c = containers.get(id);
      if (!c) throw notFound('ce', id);
      return redactContainer(c.wire);
    },
    async createContainer(req): Promise<CreateOutcome<string>> {
      if (down) return { outcome: 'unknown', error: downError('ce') };
      if (ceDenied) return { outcome: 'failed', error: err('ce', 403, NOT_ENTITLED) };
      if (flags.has('create_fails')) return { outcome: 'failed', error: err('ce', 400, { reason: 'product is not available in this data centre (demo)' }) };
      if (flags.has('create_unknown')) return { outcome: 'unknown', error: err('ce', 503, '<html><title>502 Bad gateway</title> (demo)</html>') };
      const id = `00000000-0000-4000-8000-${rand(12)}`;
      const t = now();
      containers.set(id, {
        wire: {
          id,
          orgId: '00000000-0000-0000-0000-000000000000',
          name: req.name,
          idc: req.idc,
          product: req.product,
          templateId: req.templateId,
          status: 'creating',
          reason: '',
          createdAt: iso(t),
          modifiedAt: iso(t),
          ...(req.command ? { command: req.command } : {}),
          args: req.args ?? [],
          envs: (req.envs ?? []).map((e) => ({ name: e.name, value: '[redacted]' })),
          ports: (req.ports ?? []).map((p, i) => ({ ...p, port: 30000 + i })),
          sshKeyIdList: req.sshKeyIdList ?? [],
          storages: [],
          firewalls: [],
        },
        next: { to: 'running', at: t + MOCK_COMPUTE_TIMING.creatingMs },
      });
      return { outcome: 'confirmed', value: id };
    },
    async deleteContainer(id) {
      ceGuard();
      leaseFail('ce');
      advanceContainers();
      const c = containers.get(id);
      if (!c) throw notFound('ce', id);
      if (c.wire.status === 'creating' || c.wire.status === 'terminating') throw err('ce', 409, { reason: 'Cannot terminate during creation or termination' });
      c.wire = { ...c.wire, status: 'terminating' };
      c.next = { to: 'gone', at: now() + MOCK_COMPUTE_TIMING.deleteMs };
    },
    async restartContainer(id) {
      ceGuard();
      advanceContainers();
      const c = containers.get(id);
      if (!c) throw notFound('ce', id);
      const t = now();
      c.wire = { ...c.wire, status: 'terminating' };
      c.next = { to: 'creating', at: t + MOCK_COMPUTE_TIMING.restartMs / 2, then: { to: 'running', at: t + MOCK_COMPUTE_TIMING.restartMs } };
    },
    async containerShell(id) {
      ceGuard();
      if (!containers.has(id)) throw notFound('ce', id);
      return { urlPath: `/mock/shell/${id}/${rand(16)}` };
    },
    async getLogs(id, o = {}): Promise<CeLogsResult> {
      ceGuard();
      if (!containers.has(id)) throw notFound('ce', id);
      const text = `${logsFixture.lines.join('\n')}\n`;
      const tail = o.tailBytes ?? 1024 * 1024;
      return { text: text.length > tail ? text.slice(-tail) : text, truncated: text.length > tail, totalBytes: text.length, rangeSupported: true, autoPoll: true, fetchedAt: iso() };
    },
    async saveLogs(id, destPath) {
      ceGuard();
      if (!containers.has(id)) throw notFound('ce', id);
      const text = `${logsFixture.lines.join('\n')}\n`;
      await writeFile(destPath, text, { mode: 0o600 });
      return Buffer.byteLength(text);
    },
    async listProducts(idc) {
      ceGuard();
      const byIdc = (accountFixture.containers as Record<string, CeProduct[]>)[idc] ?? [];
      return byIdc.map((p) => ({ ...p }));
    },
    async listTemplates() {
      ceGuard();
      return [...(publicTemplatesFixture.templates as CeTemplate[]), ...(accountFixture.templates as CeTemplate[])].map((t) => ({ ...t }));
    },
    async listSshKeys() {
      ceGuard();
      return (accountFixture.sshKeys as CeSshKey[]).map((k) => ({ ...k }));
    },
    async listEips() {
      ceGuard();
      advanceContainers();
      return [...eips.values()].map((e) => ({ ...e }));
    },
    async eipProducts(idc) {
      ceGuard();
      return ((accountFixture.eips as Record<string, CeProduct[]>)[idc] ?? []).map((p) => ({ ...p }));
    },
    async allocateEip(req) {
      if (down) return { outcome: 'unknown', error: downError('ce') };
      const id = `00000000-0000-4000-8000-${rand(12)}`;
      eips.set(id, {
        id,
        orgId: '00000000-0000-0000-0000-000000000000',
        idc: req.idc,
        name: req.name,
        ipAddress: `203.0.113.${100 + (eips.size % 100)}`,
        product: req.product,
        status: 'disassociated',
        instanceID: null,
        instanceType: null,
      });
      return { outcome: 'confirmed', value: id };
    },
    async associateEip(id, req) {
      ceGuard();
      const e = eips.get(id);
      if (!e) throw notFound('ce', id);
      Object.assign(e, { status: 'associated', instanceID: req.instanceID, instanceType: req.instanceType });
    },
    async disassociateEip(id) {
      ceGuard();
      const e = eips.get(id);
      if (!e) throw notFound('ce', id);
      Object.assign(e, { status: 'disassociated', instanceID: null, instanceType: null });
    },
    async releaseEip(id) {
      ceGuard();
      const e = eips.get(id);
      if (!e) throw notFound('ce', id);
      if (e.status === 'associated') throw err('ce', 409, { reason: 'elastic ip is still associated' });
      eips.delete(id);
    },
    async listFirewalls(idc) {
      ceGuard();
      return [...firewalls.values()].filter((f) => !idc || f.idc === idc).map((f) => ({ ...f }));
    },
    async createFirewall(req) {
      if (down) return { outcome: 'unknown', error: downError('ce') };
      const fw: CeFirewall = { ...req, id: `00000000-0000-4000-8000-${rand(12)}`, orgId: '00000000-0000-0000-0000-000000000000', isPreset: false, status: 'active', assoInstances: [], assoContainers: [] };
      firewalls.set(fw.id, fw);
      return { outcome: 'confirmed', value: { ...fw } };
    },
    async updateFirewall(id, req) {
      ceGuard();
      const f = firewalls.get(id);
      if (!f) throw notFound('ce', id);
      if (f.isPreset) throw err('ce', 400, { reason: 'preset firewalls cannot be modified' });
      Object.assign(f, req);
    },
    async deleteFirewall(id) {
      ceGuard();
      const f = firewalls.get(id);
      if (!f) throw notFound('ce', id);
      if ((f.assoContainers?.length ?? 0) + (f.assoInstances?.length ?? 0) > 0) throw err('ce', 409, { reason: 'firewall is still associated' });
      firewalls.delete(id);
    },
    async associateFirewall(id, req) {
      ceGuard();
      const f = firewalls.get(id);
      if (!f) throw notFound('ce', id);
      f.assoContainers = [...new Set([...(f.assoContainers ?? []), ...req.instances])];
    },
    async disassociateFirewall(id, req) {
      ceGuard();
      const f = firewalls.get(id);
      if (!f) throw notFound('ce', id);
      f.assoContainers = (f.assoContainers ?? []).filter((x) => !req.instances.includes(x));
    },
  };

  // ── Sandbox v2 control plane ──
  const mintAccess = (s: SimSandbox): V2ConnectResult => ({
    id: s.detail.id,
    sandbox_key: s.detail.sandbox_key ?? 'mk0000',
    domain: s.detail.domain ?? 'us-central-iowa2.sandbox.mock.invalid',
    sandbox_access_token: `mock-sat-${rand(24)}`,
    traffic_access_token: `mock-tat-${rand(24)}`,
    end_at: s.detail.end_at ?? iso(now() + 3_600_000),
    ...(s.detail.template_id ? { template_id: s.detail.template_id } : {}),
  });
  const summary = (d: V2SandboxDetail): V2SandboxSummary => ({
    id: d.id,
    state: d.state,
    ...(d.sandbox_key ? { sandbox_key: d.sandbox_key } : {}),
    ...(d.template_id ? { template_id: d.template_id } : {}),
    ...(d.snapshot_id ? { snapshot_id: d.snapshot_id } : {}),
    ...(d.idc_name ? { idc_name: d.idc_name } : {}),
    ...(d.metadata ? { metadata: { ...d.metadata } } : {}),
    ...(d.created_at ? { created_at: d.created_at } : {}),
    ...(d.running_at ? { running_at: d.running_at } : {}),
  });
  const sbOr404 = (id: string) => {
    const s = sandboxes.get(id);
    if (!s) throw notFound('v2', 'sandbox');
    return s;
  };
  const conflict = (state: string) => err('v2', 409, v2Body('Resource.StateConflict', `sandbox is ${state}`, { state }));

  const sandbox: SandboxApi = {
    async create(req: V2CreateSandboxRequest, o) {
      if (down) return { outcome: 'unknown', error: downError('v2') };
      if (v2Denied) return { outcome: 'failed', error: err('v2', 403, v2Body('Auth.Forbidden', 'access denied: tenant has no permission to do the operation')) };
      if (flags.has('create_fails')) return { outcome: 'failed', error: err('v2', 429, v2Body('Resource.QuotaExceeded', 'quota exceeded (demo)', { quota_name: 'sandboxes', quota: 2, used: 2, requested: 1 })) };
      const existing = [...sandboxes.values()].find((s) => s.idemKey === o.idempotencyKey);
      if (existing?.created) return { outcome: 'confirmed', value: { ...existing.created } };
      const t = now();
      const id = `sbx-${rand(10)}`;
      const key = `mk${rand(8)}`;
      const s: SimSandbox = {
        detail: {
          id,
          sandbox_key: key,
          ...(req.template_id ? { template_id: req.template_id } : {}),
          ...(req.snapshot_id ? { snapshot_id: req.snapshot_id } : {}),
          idc_name: req.idc_name ?? 'us-central-iowa2',
          state: 'provisioning',
          product: req.product ?? 'gmi.sandbox.small',
          metadata: { ...(req.metadata ?? {}) },
          created_at: iso(t),
          end_at: iso(t + (req.timeout ?? 300) * 1000),
          domain: `${req.idc_name ?? 'us-central-iowa2'}.sandbox.mock.invalid`,
          lifecycle: { auto_resume: false, on_timeout: req.auto_pause ? 'pause' : 'kill' },
          egress_control: req.egress_control === true,
          ...(req.egress ? { egress: req.egress } : {}),
        },
        next: { to: 'running', at: t + MOCK_COMPUTE_TIMING.creatingMs },
        idemKey: o.idempotencyKey,
        created: null,
      };
      const access = mintAccess(s);
      s.created = { id, sandbox_key: key, domain: access.domain, sandbox_access_token: access.sandbox_access_token, traffic_access_token: access.traffic_access_token, ...(req.template_id ? { template_id: req.template_id } : {}) };
      sandboxes.set(id, s);
      return { outcome: 'confirmed', value: { ...s.created } };
    },
    async list(q: SandboxListQuery = {}): Promise<V2Page<V2SandboxSummary>> {
      v2Guard();
      advanceSandboxes();
      const items = [...sandboxes.values()]
        .map((s) => s.detail)
        .filter((d) => (q.state ? d.state === q.state || (q.state === 'running' && (d.state === 'updating' || d.state === 'checkpointing')) : d.state !== 'deleted'))
        .filter((d) => !q.idc || d.idc_name === q.idc)
        .filter((d) => Object.entries(q.metadata ?? {}).every(([k, v]) => d.metadata?.[k] === v))
        .map(summary);
      const pageSize = Math.min(q.pageSize ?? 100, 100);
      const page = q.page ?? 1;
      return { request_id: `req-mock-${rand(6)}`, total: items.length, page, page_size: pageSize, items: items.slice((page - 1) * pageSize, page * pageSize) };
    },
    async listAll(q = {}) {
      const states = q.states && q.states.length ? q.states : [null];
      const seen = new Map<string, V2SandboxSummary>();
      for (const state of states) for (const item of (await sandbox.list({ ...q, state, pageSize: 100 })).items) seen.set(item.id, item);
      return [...seen.values()];
    },
    async get(id) {
      v2Guard();
      advanceSandboxes();
      return structuredClone(sbOr404(id).detail);
    },
    async delete(id) {
      v2Guard();
      leaseFail('v2');
      advanceSandboxes();
      const s = sbOr404(id);
      if (s.detail.state === 'deleted') return { id, state: 'deleted' };
      const t = now();
      s.detail = { ...s.detail, state: 'deleting', deletion: { code: 'Sandbox.UserDeleted', initiator: 'user', message: 'Deleted by the user.', requested_at: iso(t), completed_at: null } };
      s.next = { to: 'deleted', at: t + MOCK_COMPUTE_TIMING.deleteMs };
      machines.delete(id);
      return { id, state: 'deleting' };
    },
    async pause(id) {
      v2Guard();
      leaseFail('v2');
      advanceSandboxes();
      const s = sbOr404(id);
      if (s.detail.state !== 'running') throw conflict(String(s.detail.state));
      const t = now();
      s.detail = { ...s.detail, state: 'pausing', pause: { code: 'Sandbox.UserPaused', initiator: 'user', message: 'Paused.', requested_at: iso(t) } };
      s.next = { to: 'paused', at: t + MOCK_COMPUTE_TIMING.pauseMs };
      return { id, state: 'pausing' };
    },
    async resume(id, timeoutSec) {
      v2Guard();
      advanceSandboxes();
      const s = sbOr404(id);
      if (s.detail.state !== 'paused') throw conflict(String(s.detail.state));
      const t = now();
      const remaining = s.detail.end_at && s.detail.paused_at ? Math.max(60_000, Date.parse(s.detail.end_at) - Date.parse(s.detail.paused_at)) : 3_600_000;
      s.detail = { ...s.detail, state: 'resuming', end_at: iso(t + (timeoutSec && timeoutSec > 0 ? timeoutSec * 1000 : remaining)) };
      s.next = { to: 'running', at: t + MOCK_COMPUTE_TIMING.resumeMs };
      // Always a cold resume in the demo (§7.3 assumes one): processes, listening ports and /tmp are gone.
      const mm = machines.get(id);
      if (mm) {
        mm.ports.clear();
        mm.services.length = 0;
        for (const k of [...mm.fs.keys()]) if (k.startsWith('/tmp/')) mm.fs.delete(k);
      }
      coldResumed.add(id);
      return { id, state: 'resuming' };
    },
    async setTimeout(id, timeoutSec) {
      v2Guard();
      advanceSandboxes();
      const s = sbOr404(id);
      if (s.detail.state !== 'running' && s.detail.state !== 'paused') throw conflict(String(s.detail.state));
      const old = s.detail.end_at ?? iso();
      const base = s.detail.state === 'paused' && s.detail.paused_at ? Date.parse(s.detail.paused_at) : now();
      s.detail = { ...s.detail, end_at: iso(base + timeoutSec * 1000) };
      return { id, old_end_at: old, new_end_at: s.detail.end_at as string };
    },
    async connect(id) {
      v2Guard();
      advanceSandboxes();
      const s = sbOr404(id);
      const state = String(s.detail.state);
      if (state === 'provisioning' || state === 'failed' || state === 'deleted' || state === 'deleting') throw notFound('v2', 'sandbox');
      if (state !== 'running') throw conflict(state);
      return mintAccess(s);
    },
    async updateEgress(id, policy) {
      v2Guard();
      const s = sbOr404(id);
      if (s.detail.state !== 'running' || !s.detail.egress_control) throw conflict(String(s.detail.state));
      s.detail = { ...s.detail, egress: { ...policy } };
      return { state: 'running', last_mutation: { type: 'update_egress_policy', status: 'succeeded' }, applied: 'immediate' };
    },
    async products(idc) {
      v2Guard();
      return ((sandboxCatalogFixture.products as Record<string, V2Product[]>)[idc] ?? []).map((p) => structuredClone(p));
    },
    async templates(idc) {
      v2Guard();
      return ((sandboxCatalogFixture.templates as Record<string, V2Template[]>)[idc] ?? []).map((t) => structuredClone(t));
    },
    async listSnapshots() {
      v2Guard();
      return [...snapshots.values()].map((s) => structuredClone(s));
    },
    async getSnapshot(id) {
      v2Guard();
      const s = snapshots.get(id);
      if (!s) throw notFound('v2', 'snapshot');
      return structuredClone(s);
    },
    async createSnapshot(req) {
      if (down) return { outcome: 'unknown', error: downError('v2') };
      const src = sandboxes.get(req.sandbox_id);
      if (!src) return { outcome: 'failed', error: notFound('v2', 'sandbox') };
      if (src.detail.state !== 'running') return { outcome: 'failed', error: conflict(String(src.detail.state)) };
      const snap: V2Snapshot = {
        snapshot_id: `snp-${rand(10)}`,
        name: req.name ?? `snapshot-${rand(4)}`,
        status: 'ready',
        source_sandbox_id: req.sandbox_id,
        ...(src.detail.idc_name ? { idc_name: src.detail.idc_name } : {}),
        ...(src.detail.product ? { product: src.detail.product } : {}),
        metadata: { ...(req.metadata ?? {}) },
        created_at: iso(),
        ready_at: iso(),
        updated_at: iso(),
      };
      snapshots.set(snap.snapshot_id, snap);
      return { outcome: 'confirmed', value: structuredClone(snap) };
    },
    async deleteSnapshot(id) {
      v2Guard();
      if (!snapshots.delete(id)) throw notFound('v2', 'snapshot');
    },
  };

  // ── Data plane ──
  const tokens = createTokenCache({ connect: (id) => sandbox.connect(id), now: nowDate });
  const dpReady = (sandboxId: string) => {
    if (down) throw downError('dataplane');
    advanceSandboxes();
    const s = sandboxes.get(sandboxId);
    if (!s || s.detail.state !== 'running') throw err('dataplane', 409, v2Body('Execution.RuntimeNotRunning', 'the sandbox is not running'));
    return machine(sandboxId);
  };
  const execResult = (eid: string, key: string, res: ShellResult): V2ExecResult => ({
    request_id: `req-mock-${rand(6)}`,
    execution_id: eid,
    sandbox_id: key,
    status: res.code === 0 ? 'succeeded' : 'failed',
    exit_code: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    stdout_truncated: false,
    stderr_truncated: false,
    started_at: iso(),
    completed_at: iso(),
  });
  const executions = new Map<string, V2ExecResult>();

  const dataPlane: DataPlaneApi = {
    tokens,
    async startExec(sandboxId, input: ExecInput) {
      validateExecInput(input);
      await tokens.get(sandboxId);
      const mm = dpReady(sandboxId);
      const saved = mm.cwd;
      if (input.cwd) mm.cwd = input.cwd;
      const res = runLine(mm, input.command, input.envs ?? {});
      mm.cwd = saved;
      const eid = `exe-${rand(12)}`;
      const result = execResult(eid, sandboxes.get(sandboxId)?.detail.sandbox_key ?? '', res);
      executions.set(eid, result);
      if (input.onAccepted) await input.onAccepted(eid);
      return result;
    },
    async exec(sandboxId, input) {
      const r = await dataPlane.startExec(sandboxId, input);
      return isTerminalExec(r.status) ? (r as V2ExecResult) : dataPlane.waitExecution(sandboxId, r.execution_id, { signal: input.signal });
    },
    async getExecution(_sandboxId, eid) {
      const r = executions.get(eid);
      if (!r) throw err('dataplane', 404, v2Body('Execution.NotFound', 'execution not found'));
      return { ...r };
    },
    async waitExecution(sandboxId, eid) {
      return dataPlane.getExecution(sandboxId, eid);
    },
    async cancelExecution() {
      // Demo executions finish at once: there is never anything to cancel.
    },
    async readFile(sandboxId, path, o = {}): Promise<ReadFileResult> {
      assertRemotePath(path);
      await tokens.get(sandboxId);
      const mm = dpReady(sandboxId);
      const node = mm.fs.get(path);
      if (!node || node.type !== 'file') throw err('dataplane', 404, v2Body('File.NotFound', 'file not found'));
      const max = o.maxBytes ?? 2 * 1024 * 1024;
      return { bytes: node.data.slice(0, max), size: node.data.byteLength, truncated: node.data.byteLength > max };
    },
    async writeFile(sandboxId, path, data) {
      assertRemotePath(path);
      await tokens.get(sandboxId);
      const mm = dpReady(sandboxId);
      if (!mm.ensureParent(path)) throw err('dataplane', 400, v2Body('Parameter.Invalid', 'parent directory does not exist'));
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : typeof data === 'string' ? new TextEncoder().encode(data) : data;
      mm.put(path, bytes);
      return [{ path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file' }];
    },
    async download(sandboxId, path, o = {}): Promise<DownloadResult> {
      assertRemotePath(path);
      await tokens.get(sandboxId);
      const mm = dpReady(sandboxId);
      const node = mm.fs.get(path);
      if (!node || node.type !== 'file') throw err('dataplane', 404, v2Body('File.NotFound', 'file not found'));
      const offset = Math.max(0, o.offset ?? 0);
      const resumed = offset > 0 && offset < node.data.byteLength;
      const bytes = resumed ? node.data.slice(offset) : node.data.slice();
      return { status: resumed ? 206 : 200, body: new Blob([bytes]).stream(), resumed, acceptRanges: true, totalBytes: node.data.byteLength };
    },
    async shellLaunch(sandboxId) {
      await tokens.get(sandboxId);
      dpReady(sandboxId);
      const key = sandboxes.get(sandboxId)?.detail.sandbox_key ?? '';
      return { request_id: `req-mock-${rand(6)}`, sandbox_key: key, status: shellBusy(sandboxId) ? 'attached' : 'ready', connect_url: '/shell/connect' };
    },
    async shellControl(sandboxId, req) {
      await tokens.get(sandboxId);
      dpReady(sandboxId);
      if (req.action === 'resize' && shellBusy(sandboxId)) throw err('dataplane', 409, v2Body('Shell.NotAttached', 'no active attach'));
      // Take over: the other client's shell is gone for good, so the next attach succeeds.
      if (req.action === 'close') shellTakenOver.add(sandboxId);
      return { request_id: `req-mock-${rand(6)}`, sandbox_key: sandboxes.get(sandboxId)?.detail.sandbox_key ?? '', status: req.action === 'close' ? 'closed' : 'attached' };
    },
    async shellSocket(sandboxId, connectUrl) {
      const a = await tokens.get(sandboxId);
      return { url: `wss://${a.host}${connectUrl}`, headers: { 'X-Access-Token': a.accessToken } };
    },
  };

  function openPty(sandboxId: string): MockPty {
    if (shellBusy(sandboxId)) throw err('dataplane', 409, v2Body('Shell.AlreadyAttached', 'another client is attached'));
    const mm = dpReady(sandboxId);
    const listeners = new Set<(chunk: Uint8Array) => void>();
    const enc = new TextEncoder();
    const emit = (s: string) => {
      const bytes = enc.encode(s);
      for (const l of [...listeners]) l(bytes);
    };
    const prompt = () => emit(`\x1b[1;32mroot@${mm.hostname}\x1b[0m:\x1b[1;34m${mm.cwd === mm.home ? '~' : mm.cwd}\x1b[0m# `);
    let line = '';
    let closed = false;
    queueMicrotask(() => {
      if (coldResumed.has(sandboxId)) emit('\r\n[demo] This sandbox was resumed: processes from before the pause are gone.\r\n');
      prompt();
    });
    return {
      write(data) {
        if (closed) return;
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        for (const ch of text) {
          if (ch === '\r' || ch === '\n') {
            emit('\r\n');
            const res = runLine(mm, line, { HOME: mm.home });
            const out = (res.stdout + res.stderr).replace(/\r?\n/g, '\r\n');
            if (out) emit(out);
            line = '';
            prompt();
          } else if (ch === '\x7f' || ch === '\b') {
            if (line) {
              line = line.slice(0, -1);
              emit('\b \b');
            }
          } else if (ch === '\x03') {
            line = '';
            emit('^C\r\n');
            prompt();
          } else if (ch >= ' ') {
            line += ch;
            emit(ch);
          }
        }
      },
      onData(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      resize() {},
      close() {
        closed = true;
        listeners.clear();
      },
    };
  }

  return { publicApi, ce, sandbox, dataPlane, tokens, openPty, scenario, flags, coldResumed };
}
