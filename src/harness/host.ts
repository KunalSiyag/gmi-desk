/**
 * Entry of the harness host (harness.md §5): the agent loop runs here, in an Electron utilityProcess started by
 * main's supervisor (src/main/services/harness/supervisor.ts), bundled to dist-electron/harness.cjs. The same bundle
 * also runs as the host's worker thread (worker.ts).
 *
 * Startup: main sends `{t:'port'}` with a MessagePort over `process.parentPort`; every later message travels over
 * that port and is validated (protocol.ts). Then `init` → the HostRuntime starts (migrations, replay, recovery) while
 * pings are answered with the current phase → `ready`. Commands go to the runtime; gateway events, RPC results
 * and approval decisions go to the main link (gateway-client.ts). `shutdown` aborts and exits within its grace.
 *
 * The runtime (store, loop, tools, sandbox, git) is host-runtime.ts (`createHostRuntime` below);
 * `createNotImplementedRuntime` stays for tests of the host's message handling.
 */
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import { createMainLink, createPortLog } from './gateway-client';
import { decodeMainToHost, HARNESS_PROTOCOL, MAX_MESSAGE_BYTES, messageBytes, type HostInitSettings, type HostPhase, type HostToMain } from './protocol';
import { createProductionHostRuntime } from './host-runtime';
import { createThreadWorker, runWorkerThread, WORKER_MARKER } from './worker';
import {
  harnessPaths,
  type CreateHostRuntime,
  type HostClock,
  type HostInit,
  type HostReadyInfo,
  type HostRuntime,
  type Worker,
} from './types';

declare const __APP_VERSION__: string;

/** Two crashes while recovering the same thread quarantine it (§5.1). */
export const QUARANTINE_AFTER_CRASHES = 2;

export const systemHostClock: HostClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// ─── Quarantine journal (§5.1) ────────────────────────────────────────────────────────────────────────────────

export interface RecoveryJournalState {
  /** The thread being recovered when the journal was last written; non-null at start = the host crashed on it. */
  current: string | null;
  crashes: Record<string, number>;
}

export interface RecoveryJournalIo {
  read(): Promise<RecoveryJournalState | null>;
  /** Durable (fsync) before recovery of a thread starts. */
  write(state: RecoveryJournalState): Promise<void>;
}

export function fileJournalIo(file: string): RecoveryJournalIo {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<RecoveryJournalState>;
        const crashes: Record<string, number> = {};
        if (parsed.crashes && typeof parsed.crashes === 'object') {
          for (const [id, n] of Object.entries(parsed.crashes)) if (typeof n === 'number' && Number.isFinite(n)) crashes[id] = n;
        }
        return { current: typeof parsed.current === 'string' ? parsed.current : null, crashes };
      } catch {
        return null;
      }
    },
    async write(state) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    },
  };
}

export function memoryJournalIo(initial: RecoveryJournalState | null = null): RecoveryJournalIo & { state: RecoveryJournalState | null } {
  const io = {
    state: initial,
    async read() {
      return io.state ? { current: io.state.current, crashes: { ...io.state.crashes } } : null;
    },
    async write(state: RecoveryJournalState) {
      io.state = { current: state.current, crashes: { ...state.crashes } };
    },
  };
  return io;
}

/**
 * Reads the journal at start: a thread still marked `current` crashed the previous host during its recovery.
 * Returns the threads to skip (quarantined) and the `recovering` callback the runtime calls per thread.
 */
export async function openRecoveryJournal(io: RecoveryJournalIo): Promise<{ skipThreads: string[]; recovering(threadId: string | null): Promise<void> }> {
  const state = (await io.read()) ?? { current: null, crashes: {} };
  if (state.current) state.crashes[state.current] = (state.crashes[state.current] ?? 0) + 1;
  state.current = null;
  await io.write(state);
  const skipThreads = Object.entries(state.crashes)
    .filter(([, n]) => n >= QUARANTINE_AFTER_CRASHES)
    .map(([id]) => id);
  return {
    skipThreads,
    async recovering(threadId) {
      if (threadId === null) {
        // Recovery finished: quarantined threads are marked failed by now; clean slate.
        state.current = null;
        state.crashes = {};
      } else {
        state.current = threadId;
      }
      await io.write(state);
    },
  };
}

// ─── Default runtime (until the H2-0 integration step wires store, loop, tools, sandbox and git) ─────────────

function probeVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000, windowsHide: true, env: { PATH: process.env.PATH ?? '' } }, (error, stdout) => {
      if (error) return resolve(null);
      const line = String(stdout).split('\n')[0]?.trim() ?? '';
      resolve(line ? line.slice(0, 200) : null);
    });
  });
}

/** git and ripgrep availability; the sandbox is reported unavailable until H2-E's self-test is wired in. */
export async function probeHostTools(): Promise<HostReadyInfo> {
  const [git, rg] = await Promise.all([probeVersion('git', ['--version']), probeVersion('rg', ['--version'])]);
  return {
    sandbox: { kind: 'none', ok: false, detail: 'The sandbox is not built yet.', network: 'none' },
    git: { ok: git !== null, version: git ? git.replace(/^git version\s+/i, '') : null },
    ripgrep: rg !== null,
  };
}

export const createNotImplementedRuntime: CreateHostRuntime = () => ({
  async start(_init, io) {
    io.phase('starting');
    await io.recovering(null);
    return probeHostTools();
  },
  async handle() {
    throw new GmiError('not_implemented', 'The agent runtime is not available yet.');
  },
  async shutdown() {
    return undefined;
  },
});

// ─── The host ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface HostDeps {
  /** Posts to main over the port (throws when the message is too large). */
  send(msg: HostToMain): void;
  clock: HostClock;
  worker: Worker;
  createRuntime: CreateHostRuntime;
  /** Default: the file journal under init.dataDir. */
  journal?: (init: HostInit) => RecoveryJournalIo;
  exit(code: number): void;
  version?: string;
}

export interface Host {
  /** One raw message from main (validated here). */
  receive(raw: unknown): void;
  phase(): HostPhase;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function initSettings(raw: unknown): HostInitSettings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const level = LOG_LEVELS.find((l) => l === s.logLevel) ?? 'info';
  return { mock: s.mock === true, logLevel: level };
}

export function createHost(deps: HostDeps): Host {
  const { send, clock } = deps;
  const log = createPortLog(send, clock, 'harness');
  const link = createMainLink({ send, clock, log: log.child('link') });
  const shutdownController = new AbortController();
  let phase: HostPhase = 'starting';
  let runtime: HostRuntime | null = null;
  let initialised = false;
  let shuttingDown = false;
  const inflight = new Set<string>();

  const reply = (msg: HostToMain) => {
    try {
      if (messageBytes(msg) > MAX_MESSAGE_BYTES) {
        if (msg.t === 'cmd.result') send({ t: 'cmd.result', id: msg.id, ok: false, error: { code: 'internal', message: 'The result is larger than 4 MiB.' } });
        else log.warn('dropped an oversized message to main', { t: msg.t });
        return;
      }
      send(msg);
    } catch {
      // The port is closed: main is gone or restarting us.
    }
  };

  const start = (init: HostInit) => {
    runtime = deps.createRuntime({ link, worker: deps.worker, clock, log: log.child('runtime') });
    const rt = runtime;
    void (async () => {
      const journalIo = (deps.journal ?? ((i: HostInit) => fileJournalIo(harnessPaths(i.dataDir).recoveryJournal)))(init);
      const journal = await openRecoveryJournal(journalIo);
      if (journal.skipThreads.length > 0) log.warn('quarantined threads skipped at recovery', { count: journal.skipThreads.length });
      const info = await rt.start(init, {
        phase: (p) => {
          if (phase !== 'ready') phase = p;
        },
        skipThreads: journal.skipThreads,
        recovering: (threadId) => journal.recovering(threadId),
      });
      phase = 'ready';
      reply({ t: 'ready', protocol: HARNESS_PROTOCOL, version: deps.version ?? __APP_VERSION__, sandbox: info.sandbox, git: info.git, ripgrep: info.ripgrep });
    })().catch((error: unknown) => {
      log.error('host start failed', { code: toGmiError(error).code });
      deps.exit(1);
    });
  };

  const runCommand = (id: string, cmd: Parameters<HostRuntime['handle']>[0]) => {
    if (inflight.has(id)) return; // the same command id is already running; its result answers both
    if (phase !== 'ready' || !runtime || shuttingDown) {
      reply({ t: 'cmd.result', id, ok: false, error: { code: 'internal', message: shuttingDown ? 'The agent runtime is shutting down.' : 'The agent runtime is still starting.' } });
      return;
    }
    inflight.add(id);
    runtime
      .handle(cmd, { commandId: id, signal: shutdownController.signal })
      .then(
        (data) => reply({ t: 'cmd.result', id, ok: true, data: data ?? null }),
        (error: unknown) => reply({ t: 'cmd.result', id, ok: false, error: toGmiError(error).toShape() }),
      )
      .finally(() => inflight.delete(id));
  };

  const shutdown = (graceMs: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort();
    const rt = runtime;
    void (async () => {
      let timer: unknown = null;
      try {
        await Promise.race([
          rt ? rt.shutdown(graceMs) : Promise.resolve(),
          new Promise<void>((resolve) => {
            timer = clock.setTimeout(resolve, graceMs);
          }),
        ]);
      } catch (error) {
        log.warn('runtime shutdown failed', { code: toGmiError(error).code });
      } finally {
        if (timer !== null) clock.clearTimeout(timer);
        link.failAll(new GmiError('cancelled', 'The agent runtime is shutting down.'));
        await deps.worker.close().catch(() => undefined);
        deps.exit(0);
      }
    })();
  };

  return {
    phase: () => phase,
    receive(raw) {
      const decoded = decodeMainToHost(raw);
      if (!decoded.ok) {
        log.warn('dropped an invalid message from main', { reason: decoded.reason });
        return;
      }
      const msg = decoded.msg;
      switch (msg.t) {
        case 'init':
          if (initialised) {
            log.warn('ignored a second init');
            return;
          }
          initialised = true;
          start({ dataDir: msg.dataDir, installId: msg.installId, settings: initSettings(msg.settings), platform: msg.platform });
          return;
        case 'ping':
          reply({ t: 'pong', at: msg.at, phase });
          return;
        case 'cmd':
          runCommand(msg.id, msg.cmd);
          return;
        case 'shutdown':
          shutdown(msg.graceMs);
          return;
        default:
          link.handle(msg);
      }
    },
  };
}

// ─── Process entry ────────────────────────────────────────────────────────────────────────────────────────────

/** The real runtime (store, loop, tools, sandbox, git): host-runtime.ts. */
export const createHostRuntime: CreateHostRuntime = createProductionHostRuntime;

interface PortEventLike {
  data: unknown;
  ports?: PortLike[];
}
interface PortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: PortEventLike) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
}
interface ParentPortLike {
  on(event: 'message', listener: (event: PortEventLike) => void): unknown;
}

function startHostProcess(parentPort: ParentPortLike): void {
  // node:sqlite prints an ExperimentalWarning (§5.2); every other warning still reaches stderr (drained by main).
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });

  let host: Host | null = null;
  parentPort.on('message', (event) => {
    const data = event.data as { t?: unknown } | null;
    const port = event.ports?.[0];
    if (host || !data || data.t !== 'port' || !port) return;
    const send = (msg: HostToMain) => {
      if (messageBytes(msg) > MAX_MESSAGE_BYTES) throw new GmiError('invalid_input', 'Message too large.');
      port.postMessage(msg);
    };
    const exit = (code: number) => {
      // Let the last messages flush before the process ends.
      setTimeout(() => process.exit(code), 20);
    };
    host = createHost({
      send,
      clock: systemHostClock,
      worker: createThreadWorker({ file: __filename, log: createPortLog(send, systemHostClock, 'worker') }),
      createRuntime: createHostRuntime,
      exit,
    });
    const h = host;
    port.on('message', (e) => h.receive(e.data));
    port.on('close', () => exit(0));
    port.start();
    process.on('uncaughtException', (error) => {
      try {
        send({ t: 'log', level: 'error', scope: 'harness', message: 'uncaught exception', meta: { name: error.name } });
      } catch {
        // ignore
      }
      exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      try {
        send({ t: 'log', level: 'error', scope: 'harness', message: 'unhandled rejection', meta: { code: toGmiError(reason).code } });
      } catch {
        // ignore
      }
    });
  });
}

if (!isMainThread && (workerData as Record<string, unknown> | null)?.[WORKER_MARKER] === true) {
  runWorkerThread();
} else {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
  if (parentPort) startHostProcess(parentPort);
}
