/**
 * SandboxRunner (harness.md §8.3): picks bubblewrap (Linux), seatbelt (macOS) or none, runs the self-test with the
 * production argv, owns the CONNECT proxy (started once per host on the first approved network use) and runs
 * commands:
 *   - bwrap is spawned with an empty environment (the command's env is passed only through `--clearenv --setenv`);
 *   - its own process group (`detached`), killed with SIGTERM and then SIGKILL after 5 s on abort or timeout;
 *     `--die-with-parent` tears the sandbox down if the host dies;
 *   - stdout and stderr interleaved; head + tail kept in memory, everything to the spill file (0600).
 * Without a working sandbox (`kind:'none'` or a failed self-test) a command still runs after its explicit approval
 * (`unsandboxed` flag), with the scrubbed env and a fresh HOME — never in the auto modes (the engine asks).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CodeState } from '@shared/contracts/code';
import type { HostLog, SandboxRunIo, SandboxRunner, SandboxRunResult, SandboxSpec } from '../types';
import { buildBwrapArgv } from './bwrap';
import { createNetProxy, type HostPolicy, type NetProxy, type Resolver } from './netproxy';
import { commandArgv, PROXY_SOCKET_NAME, probeHostLayout, type HostLayout } from './profiles';
import { FD_CLOSE_LAUNCHER, keyctlSyscall, LAUNCHER_SHELL, seccompProgram } from './seccomp';
import { buildSeatbeltArgv } from './seatbelt';
import { evaluateProbe, homeMountPoints, hostUnixSockets, makeSelfTestFixture, selfTestSpec } from './selftest';

export interface SandboxRunnerOptions {
  platform: NodeJS.Platform;
  /** `<userData>/data/harness`: the proxy dir and self-test fixtures live under `<dataDir>/sandbox`. */
  dataDir: string;
  log: HostLog;
  /** The host's (already scrubbed) env: PATH for toolchains, HOME. Default process.env. */
  hostEnv?: Record<string, string | undefined>;
  /** Runs the forwarder and the self-test probe (Electron as Node in the app). Default process.execPath. */
  execPath?: string;
  /** Default: `bwrap` found on PATH (or /usr/bin/bwrap). Null: treat as missing. */
  bwrapPath?: string | null;
  /** Default: probed once from the host. */
  layout?: HostLayout;
  /** CONNECT proxy options (tests inject a resolver; production uses DNS and the IP table). */
  proxy?: { resolver?: Resolver; hostPolicy?: HostPolicy; addressCheck?: (ip: string) => string | null };
  killGraceMs?: number;
  /** The app's userData (seatbelt denies reads of it). Default: two levels above `dataDir` (`<userData>/data/harness`). */
  userData?: string | null;
}

export interface HarnessSandboxRunner extends SandboxRunner {
  /** Starts the CONNECT proxy if needed (once per host). Null when it cannot start. */
  ensureProxy(): Promise<NetProxy | null>;
  hostLayout(): HostLayout;
  close(): Promise<void>;
}

const DEFAULT_CAPTURE = 1024 * 1024;
const MAX_SPILL = 64 * 1024 * 1024;

function findOnPath(name: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir.startsWith('/')) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return existsSync(`/usr/bin/${name}`) ? `/usr/bin/${name}` : null;
}

interface SpawnPlan {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cleanup: () => void;
  /** Descriptors passed as fd 3, 4 … (the seccomp filter); closed by execute() once the child is spawned. */
  extraFds?: number[];
}

function closeFds(plan: SpawnPlan): void {
  for (const fd of plan.extraFds ?? []) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  plan.extraFds = [];
}

/** Runs a plan with process-group kill, timeout and head/tail capture. */
function execute(plan: SpawnPlan, timeoutMs: number, io: SandboxRunIo, killGraceMs: number): Promise<SandboxRunResult> {
  const started = Date.now();
  const max = Math.max(1024, io.maxCaptureBytes ?? DEFAULT_CAPTURE);
  const half = Math.floor(max / 2);
  let head = Buffer.alloc(0);
  let tail: Buffer[] = [];
  let tailBytes = 0;
  let total = 0;
  let spill: WriteStream | null = null;
  let spilled = 0;
  if (io.spillFile) {
    mkdirSync(dirname(io.spillFile), { recursive: true, mode: 0o700 });
    spill = createWriteStream(io.spillFile, { mode: 0o600, flags: 'w' });
    spill.on('error', () => {
      spill = null;
    });
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return new Promise((resolve) => {
    let child: ChildProcess;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let settled = false;
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* gone */
        }
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), killGraceMs);
    };
    const finish = (exitCode: number | null, signal: string | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      io.signal.removeEventListener('abort', onAbort);
      if (extra) onChunk(Buffer.from(extra));
      plan.cleanup();
      const truncated = total > head.length + tailBytes;
      const tailBuf = Buffer.concat(tail);
      const output = truncated ? `${head.toString('utf8')}\n[… ${total - head.length - tailBuf.length} bytes omitted …]\n${tailBuf.toString('utf8')}` : Buffer.concat([head, tailBuf]).toString('utf8');
      const result = { exitCode, signal, timedOut, cancelled, durationMs: Date.now() - started, output, outputBytes: total, outputTruncated: truncated };
      // Resolve only once the spill file is fully on disk: the result tells the model to read it, and end() alone
      // returns before buffered writes land (a loaded machine showed a 300k-line spill cut to 67k lines).
      const open = spill;
      if (!open) {
        resolve(result);
        return;
      }
      const done = () => resolve(result);
      open.once('finish', done);
      open.once('error', done);
      open.end();
    };
    const onChunk = (chunk: Buffer) => {
      total += chunk.length;
      if (spill && spilled < MAX_SPILL) {
        spill.write(chunk.subarray(0, MAX_SPILL - spilled));
        spilled += Math.min(chunk.length, MAX_SPILL - spilled);
      }
      io.onOutput?.(decoder.decode(chunk, { stream: true }));
      let rest = chunk;
      if (head.length < half) {
        const take = Math.min(half - head.length, rest.length);
        head = Buffer.concat([head, rest.subarray(0, take)]);
        rest = rest.subarray(take);
      }
      if (rest.length) {
        tail.push(rest);
        tailBytes += rest.length;
        while (tailBytes > half && tail.length) {
          const over = tailBytes - half;
          const first = tail[0] as Buffer;
          if (first.length <= over) {
            tailBytes -= first.length;
            tail.shift();
          } else {
            tail[0] = first.subarray(over);
            tailBytes -= over;
          }
        }
      }
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, timeoutMs));
    try {
      child = spawn(plan.file, plan.args, { cwd: plan.cwd, env: plan.env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(plan.extraFds ?? [])] });
      closeFds(plan);
    } catch (e) {
      closeFds(plan);
      child = { pid: undefined } as ChildProcess;
      finish(127, null, `sandbox: could not start (${(e as NodeJS.ErrnoException).code ?? 'error'})\n`);
      return;
    }
    if (io.signal.aborted) onAbort();
    else io.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (e: NodeJS.ErrnoException) => finish(127, null, `sandbox: could not start (${e.code ?? 'error'})\n`));
    child.on('close', (code, sig) => finish(code, sig));
  });
}

export function createSandboxRunner(opts: SandboxRunnerOptions): HarnessSandboxRunner {
  const hostEnv = opts.hostEnv ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  const home = hostEnv.HOME && hostEnv.HOME.startsWith('/') ? hostEnv.HOME : tmpdir();
  const sandboxDir = join(opts.dataDir, 'sandbox');
  // A Unix socket path must fit sockaddr_un (108 bytes): a long profile path falls back to a private temp dir.
  let proxyDir = join(sandboxDir, 'proxy');
  /** Masks secret files (§8.3): an empty, read-only regular file. */
  const emptyFile = join(sandboxDir, 'empty');
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const kind: CodeState['sandbox']['kind'] = opts.platform === 'linux' ? 'bwrap' : opts.platform === 'darwin' ? 'seatbelt' : 'none';
  const bwrapPath = opts.bwrapPath === undefined ? (kind === 'bwrap' ? findOnPath('bwrap', hostEnv.PATH) : null) : opts.bwrapPath;
  let layout: HostLayout | null = opts.layout ?? null;
  let state: CodeState['sandbox'] = { kind, ok: false, detail: 'Self-test not run yet.', network: 'none' };
  let selftestRun: Promise<CodeState['sandbox']> | null = null;
  let proxy: NetProxy | null = null;
  let proxyStart: Promise<NetProxy | null> | null = null;
  const log = opts.log;

  const getLayout = (): HostLayout => (layout ??= probeHostLayout({ home, path: hostEnv.PATH ?? '', execPath }));

  function argvFor(spec: SandboxSpec, sandboxed: boolean, tmp: string): string[] {
    if (!sandboxed || kind === 'none') return commandArgv(spec);
    if (kind === 'bwrap') return buildBwrapArgv(bwrapPath ?? 'bwrap', spec, getLayout(), { proxyDir: spec.network === 'proxy' ? proxyDir : null, emptyFile });
    return buildSeatbeltArgv(spec, { home, proxyDir: spec.network === 'proxy' ? proxyDir : null, tmpDir: tmp, execPath, userData: opts.userData ?? dirname(dirname(opts.dataDir)) });
  }

  function planFor(spec: SandboxSpec, sandboxed: boolean): SpawnPlan {
    const useBwrap = sandboxed && kind === 'bwrap';
    if (useBwrap) {
      ensureEmptyFile();
      if (spec.cacheDir && spec.profile === 'exec') for (const d of ['cache', 'npm', 'pip']) mkdirSync(join(spec.cacheDir, d), { recursive: true, mode: 0o700 });
      const argv = argvFor(spec, true, '/tmp');
      // bwrap itself gets an empty env: the command's env is only what --setenv passes. Review H2: the launcher closes
      // inherited host descriptors before exec, and bwrap installs the keyring seccomp filter from fd 3.
      const filter = seccompFd();
      const bwrapArgs = filter === null ? argv.slice(1) : ['--seccomp', '3', ...argv.slice(1)];
      return {
        file: LAUNCHER_SHELL,
        args: ['--noprofile', '--norc', '-c', FD_CLOSE_LAUNCHER, 'gmid-sandbox', argv[0] ?? 'bwrap', ...bwrapArgs],
        cwd: '/',
        env: {},
        cleanup: () => undefined,
        ...(filter === null ? {} : { extraFds: [filter] }),
      };
    }
    // seatbelt or unsandboxed: a fresh HOME and TMPDIR per command.
    const tmp = mkdtempSync(join(tmpdir(), 'gmid-cmd-'));
    const freshHome = join(tmp, 'home');
    mkdirSync(freshHome, { mode: 0o700 });
    const argv = argvFor(spec, sandboxed, tmp);
    const env: Record<string, string> = { ...spec.env, HOME: freshHome, TMPDIR: tmp };
    if (sandboxed && spec.network === 'proxy') {
      env.ELECTRON_RUN_AS_NODE = '1';
      env.GMID_PROXY_SOCKET = join(proxyDir, PROXY_SOCKET_NAME);
    }
    return { file: argv[0] ?? '/bin/bash', args: argv.slice(1), cwd: spec.cwd, env, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }

  /** A fresh read descriptor of the seccomp program (written once, 0444), or null on an unknown architecture. */
  const seccompFile = join(sandboxDir, 'seccomp.bpf');
  const program = seccompProgram();
  function seccompFd(): number | null {
    if (!program) return null;
    let ok = false;
    try {
      ok = readFileSync(seccompFile).equals(program);
    } catch {
      /* write it */
    }
    if (!ok) {
      mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
      rmSync(seccompFile, { force: true });
      writeFileSync(seccompFile, program, { mode: 0o444 });
    }
    return openSync(seccompFile, 'r');
  }

  function ensureEmptyFile(): void {
    try {
      if (statSync(emptyFile).size === 0) return;
    } catch {
      /* create */
    }
    mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
    rmSync(emptyFile, { force: true });
    writeFileSync(emptyFile, '', { mode: 0o444 });
  }

  async function ensureProxy(): Promise<NetProxy | null> {
    if (proxy) return proxy;
    if (!proxyStart && Buffer.byteLength(join(proxyDir, PROXY_SOCKET_NAME)) > 100) proxyDir = mkdtempSync(join(tmpdir(), 'gmid-px-'));
    proxyStart ??= createNetProxy({ dir: proxyDir, log: log.child('proxy'), ...opts.proxy })
      .then((p) => (proxy = p))
      .catch((e: NodeJS.ErrnoException) => {
        log.warn('proxy could not start', { code: e.code ?? null });
        proxyStart = null;
        return null;
      });
    return proxyStart;
  }

  async function runSelfTest(): Promise<CodeState['sandbox']> {
    if (kind === 'none') return { kind, ok: false, detail: 'No OS sandbox on this platform: every command asks.', network: 'none' };
    if (kind === 'bwrap' && !bwrapPath) return { kind, ok: false, detail: 'bubblewrap (bwrap) is not installed.', network: 'none' };
    const dir = join(sandboxDir, `selftest-${randomBytes(6).toString('hex')}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const sockets = hostUnixSockets();
      const homeAllowed = homeMountPoints(home, [...getLayout().toolchains, getLayout().execDir]);
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, ELECTRON_RUN_AS_NODE: '1' };
      const io = (): SandboxRunIo => ({ signal: new AbortController().signal, maxCaptureBytes: 256 * 1024 });
      const fx = makeSelfTestFixture(dir, sockets, false);
      // 1. The production argv with `true`.
      const t = await execute(planFor(selfTestSpec(fx, env, null, 'off'), true), 20_000, io(), killGraceMs);
      if (t.exitCode !== 0) return { kind, ok: false, detail: `The sandbox does not start: ${t.output.trim().slice(0, 300) || `exit ${t.exitCode}`}`, network: 'none' };
      // 1b. Review H2: no inherited host descriptor (only 0–2, plus ls's own directory fd 3) and, where the filter
      // exists, no keyring syscalls.
      const fdRun = await execute(planFor({ ...selfTestSpec(fx, env, null, 'off'), command: 'ls /proc/self/fd' }, true), 20_000, io(), killGraceMs);
      const fds = fdRun.output.split(/\s+/).filter(Boolean).sort();
      if (fdRun.exitCode !== 0 || fds.join(',') !== '0,1,2,3') return { kind, ok: false, detail: `Sandbox self-test failed: host file descriptors leak into the sandbox (${fds.slice(0, 12).join(' ')})`, network: 'none' };
      const nr = keyctlSyscall();
      if (nr !== null && program) {
        const keyRun = await execute(
          planFor({ ...selfTestSpec(fx, env, null, 'off'), command: `if command -v perl >/dev/null 2>&1; then perl -e 'my $r = syscall(${nr}, 0, -3, 0); print(($r < 0 && $!{EPERM}) ? "blocked" : "open")'; else echo skipped; fi` }, true),
          20_000,
          io(),
          killGraceMs,
        );
        if (/open/.test(keyRun.output)) return { kind, ok: false, detail: 'Sandbox self-test failed: the kernel keyring is reachable from the sandbox', network: 'none' };
      }
      // 2. The probe, network off.
      const p = await execute(planFor(selfTestSpec(fx, env, [getLayout().execPath, fx.probeFile, fx.configFile], 'off'), true), 30_000, io(), killGraceMs);
      const problems = p.exitCode === 0 ? evaluateProbe(p.output, false, homeAllowed) : [`probe failed: ${p.output.trim().slice(0, 300)}`];
      if (problems.length) return { kind, ok: false, detail: `Sandbox self-test failed: ${problems.join('; ')}`, network: 'none' };
      // 3. The proxy and the forwarder.
      let network: CodeState['sandbox']['network'] = 'shared_per_command';
      const px = await ensureProxy();
      if (px) {
        const fx2 = makeSelfTestFixture(join(dir, 'proxy'), sockets, true);
        // The forwarder drops ELECTRON_RUN_AS_NODE for the command it runs; the probe (Electron as Node) needs it back.
        const probeArgv = ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', getLayout().execPath, fx2.probeFile, fx2.configFile];
        const q = await execute(planFor(selfTestSpec(fx2, env, probeArgv, 'proxy'), true), 30_000, io(), killGraceMs);
        if (q.exitCode !== 0) log.warn('proxy self-test did not run', { exitCode: q.exitCode });
        else {
          const qp = evaluateProbe(q.output, true, homeAllowed);
          // An isolation problem fails the whole self-test; a forwarder that does not answer only loses the proxy.
          if (qp.some((x) => !x.startsWith('proxy forwarder'))) return { kind, ok: false, detail: `Sandbox self-test failed: ${qp.join('; ')}`, network: 'none' };
          if (qp.length === 0) network = 'proxy';
          else log.warn('proxy self-test failed', { problems: qp.length });
        }
      }
      return { kind, ok: true, detail: null, network };
    } catch (e) {
      return { kind, ok: false, detail: `Sandbox self-test error: ${(e as Error).message.slice(0, 300)}`, network: 'none' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const runner: HarnessSandboxRunner = {
    kind,
    state: () => ({ ...state }),
    async selftest() {
      selftestRun = runSelfTest().then((s) => {
        state = s;
        log.info('sandbox self-test', { kind: s.kind, ok: s.ok, network: s.network });
        return s;
      });
      return selftestRun;
    },
    buildArgv(spec) {
      return argvFor(spec, kind !== 'none', '/tmp');
    },
    async run(spec, io) {
      const st = await (selftestRun ?? runner.selftest());
      let effective = spec;
      let note = '';
      if (st.ok && spec.profile === 'exec' && spec.network === 'proxy') {
        const px = await ensureProxy();
        if (!px) {
          effective = { ...spec, network: 'off' };
          note = '[network unavailable: the proxy could not start]\n';
        }
      }
      if (!st.ok && spec.network === 'proxy') effective = { ...spec, network: 'off' };
      let plan: SpawnPlan;
      try {
        plan = planFor(effective, st.ok);
      } catch (e) {
        return { exitCode: 126, signal: null, timedOut: false, cancelled: false, durationMs: 0, output: `sandbox: ${(e as Error).message}\n`, outputBytes: 0, outputTruncated: false };
      }
      const result = await execute(plan, spec.timeoutMs, io, killGraceMs);
      return note ? { ...result, output: note + result.output } : result;
    },
    ensureProxy,
    hostLayout: getLayout,
    async close() {
      const p = proxy;
      proxy = null;
      proxyStart = null;
      await p?.close();
    },
  };
  return runner;
}
