/**
 * HarnessSupervisor (harness.md §5.1, §17): runs the harness host in an Electron utilityProcess and keeps it healthy.
 *
 * - Spawn with an allowlisted env (env.ts) and a MessagePort (`{t:'port'}`), then `init`.
 * - Startup has its own budget (5 min) that every heartbeat (`pong` with a phase) extends; the liveness watchdog is
 *   armed only after `ready`: `ping` every 5 s, no `pong` for 15 s → kill and restart.
 * - stdout and stderr are always drained into the log, rate-limited (50 lines/s), so a chatty host never blocks.
 * - Exit or kill → the session detaches (gateway.abortOwner, runs closed, approvals withdrawn), pending commands
 *   reject; restart with backoff 1, 2, 4, 8 … ≤ 60 s; 5 crashes in 5 min → `crashed` (and the view-only fallback).
 * - Every message from the host is validated (protocol.ts) and dropped if invalid.
 */
import { randomBytes } from 'node:crypto';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { ApprovalDecision, CodeState } from '@shared/contracts/code';
import type { Logger } from '../../core/logger';
import {
  decodeHostToMain,
  harnessCommandSchema,
  HARNESS_PROTOCOL,
  MAX_MESSAGE_BYTES,
  messageBytes,
  runStartedResult,
  type HarnessCommand,
  type HostPhase,
  type HostToMain,
  type MainToHost,
} from '@harness/protocol';
import { attachHostSession, type HostBridgeDeps, type HostSession } from './bridge';
import type { ReadOnlyHarnessDb } from './readonly-db';

export const SUPERVISOR_LIMITS = {
  pingIntervalMs: 5_000,
  pongTimeoutMs: 15_000,
  startupBudgetMs: 5 * 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  crashLoopCount: 5,
  crashLoopWindowMs: 5 * 60_000,
  stdioLinesPerSecond: 50,
  /** A partial stdio line longer than this is cut (a host printing without newlines). */
  stdioMaxLineChars: 4_096,
  /** Quit: shutdown grace for the host, then kill (the app's quit guard allows 3 s). */
  shutdownGraceMs: 2_500,
  shutdownKillAfterMs: 3_000,
  /** If `exit` never arrives after kill(), the host is treated as gone after this. */
  exitAfterKillMs: 5_000,
  commandTimeoutMs: 120_000,
} as const;

export type HostState = CodeState['hostState'];

export interface ReadableLike {
  setEncoding?(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  resume?(): unknown;
}

/** One spawned host process (Electron utilityProcess + MessagePort in production; a fake in tests). */
export interface HostProcess {
  readonly pid: number | null;
  postMessage(message: MainToHost): void;
  onMessage(listener: (data: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  kill(): void;
}

export type HostSpawner = (opts: { env: Record<string, string>; serviceName: string }) => Promise<HostProcess>;

export interface SupervisorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface SupervisorDeps extends Omit<HostBridgeDeps, 'clock' | 'log'> {
  spawn: HostSpawner;
  env(): Record<string, string>;
  init(): Omit<Extract<MainToHost, { t: 'init' }>, 't' | 'protocol'>;
  clock: SupervisorClock;
  log: Logger;
  /** The view-only fallback (readonly-db.ts), opened lazily while `crashed`. */
  openViewOnly?: () => Promise<ReadOnlyHarnessDb>;
}

export interface HostInfo {
  hostState: HostState;
  viewOnly: boolean;
  hostId: string | null;
  phase: HostPhase | null;
  sandbox: CodeState['sandbox'] | null;
  git: CodeState['git'] | null;
  ripgrep: boolean | null;
  version: string | null;
  restarts: number;
  lastExitCode: number | null;
}

export interface HarnessSupervisor {
  info(): HostInfo;
  onState(listener: (info: HostInfo) => void): () => void;
  /** Starts the host if stopped and resolves when it is ready (rejects when it ends up `crashed`). */
  ready(): Promise<void>;
  /** Sends a command (starting the host if needed). Same `commandId` → idempotent in the host (receipts). */
  command(cmd: HarnessCommand, opts?: { commandId?: string; timeoutMs?: number }): Promise<unknown>;
  /** Round trip to the host (Diagnostics). */
  ping(): Promise<{ rttMs: number; phase: HostPhase }>;
  /** "Restart runtime": clears the crash history and starts again. */
  restart(): Promise<void>;
  /** Quit: `shutdown` with a grace period, then kill. */
  stop(graceMs?: number): Promise<void>;
  /** The view-only database while `crashed`, else null. */
  viewOnlyDb(): Promise<ReadOnlyHarnessDb | null>;
  /** `approval.decision` to the host `hostId` if it is still the live one (the broker's deliver). */
  sendDecision(hostId: string, requestId: string, decision: ApprovalDecision): boolean;
}

interface Live {
  hostId: string;
  proc: HostProcess | null;
  session: HostSession;
  phase: HostPhase;
  ready: Extract<HostToMain, { t: 'ready' }> | null;
  lastHeartbeat: number;
  tickTimer: unknown;
  exited: boolean;
  killTimer: unknown;
}

/** Drains a stream into the log, line by line, at most `perSecond` lines per second (the rest is counted and dropped). */
export function drainToLog(stream: ReadableLike | null, log: Pick<Logger, 'info' | 'warn'>, clock: Pick<SupervisorClock, 'now'>, name: string, perSecond: number = SUPERVISOR_LIMITS.stdioLinesPerSecond): void {
  if (!stream) return;
  let buffer = '';
  let windowStart = clock.now();
  let count = 0;
  let dropped = 0;
  const emit = (line: string) => {
    const now = clock.now();
    if (now - windowStart >= 1_000) {
      if (dropped > 0) log.warn(`harness ${name}: lines dropped (rate limit)`, { dropped });
      windowStart = now;
      count = 0;
      dropped = 0;
    }
    if (count >= perSecond) {
      dropped += 1;
      return;
    }
    count += 1;
    log.info(`harness ${name}`, { line: line.slice(0, SUPERVISOR_LIMITS.stdioMaxLineChars) });
  };
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line) emit(line);
      nl = buffer.indexOf('\n');
    }
    if (buffer.length > SUPERVISOR_LIMITS.stdioMaxLineChars) {
      emit(buffer);
      buffer = '';
    }
  });
  stream.on('end', () => {
    if (buffer) emit(buffer);
    buffer = '';
  });
  stream.resume?.();
}

export function createHarnessSupervisor(deps: SupervisorDeps): HarnessSupervisor {
  const { clock, log } = deps;
  const L = SUPERVISOR_LIMITS;
  let state: HostState = 'stopped';
  let live: Live | null = null;
  let hostSeq = 0;
  let stopping = false;
  let restartTimer: unknown = null;
  let restarts = 0;
  let lastExitCode: number | null = null;
  let crashTimes: number[] = [];
  let viewOnly: Promise<ReadOnlyHarnessDb> | null = null;
  let stopWaiters: Array<() => void> = [];
  let readyWaiters: Array<{ resolve(): void; reject(e: unknown): void }> = [];
  const listeners = new Set<(info: HostInfo) => void>();
  const commands = new Map<string, { promise: Promise<unknown>; resolve(v: unknown): void; reject(e: unknown): void; timer: unknown; cmd: HarnessCommand; hostId: string | null }>();
  const pings = new Map<number, { sentAt: number; resolve(v: { rttMs: number; phase: HostPhase }): void; reject(e: unknown): void; timer: unknown }>();
  let pingSeq = 0;

  const info = (): HostInfo => ({
    hostState: state,
    viewOnly: state === 'crashed',
    hostId: live?.hostId ?? null,
    phase: live?.phase ?? null,
    sandbox: live?.ready?.sandbox ?? null,
    git: live?.ready?.git ?? null,
    ripgrep: live?.ready?.ripgrep ?? null,
    version: live?.ready?.version ?? null,
    restarts,
    lastExitCode,
  });

  const setState = (next: HostState) => {
    if (state === next) return;
    state = next;
    if (next !== 'crashed' && viewOnly) {
      const v = viewOnly;
      viewOnly = null;
      void v.then((db) => db.close(), () => undefined);
    }
    const snapshot = info();
    for (const l of [...listeners]) {
      try {
        l(snapshot);
      } catch {
        // a listener must not break the supervisor
      }
    }
  };

  const settleReady = (error: unknown | null) => {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) (error === null ? w.resolve() : w.reject(error));
  };

  const send = (l: Live, msg: MainToHost) => {
    if (!l.proc || l.exited) throw new GmiError('internal', 'The agent runtime is not running.');
    if (messageBytes(msg) > MAX_MESSAGE_BYTES) throw new GmiError('invalid_input', 'The message to the agent runtime is larger than 4 MiB.');
    l.proc.postMessage(msg);
  };

  const kill = (l: Live, reason: string) => {
    if (l.exited) return;
    log.warn('killing the harness host', { reason, hostId: l.hostId });
    try {
      l.proc?.kill();
    } catch {
      // already gone
    }
    // If the platform never reports the exit, treat the host as gone anyway.
    l.killTimer ??= clock.setTimeout(() => onExit(l, -1), L.exitAfterKillMs);
  };

  const tick = (l: Live) => {
    l.tickTimer = null;
    if (l.exited || live !== l) return;
    const now = clock.now();
    if (l.ready) {
      if (now - l.lastHeartbeat > L.pongTimeoutMs) return kill(l, 'no pong for 15 s');
    } else if (now - l.lastHeartbeat > L.startupBudgetMs) {
      return kill(l, 'startup took longer than its budget');
    }
    try {
      send(l, { t: 'ping', at: now });
    } catch {
      // exit handling follows
    }
    l.tickTimer = clock.setTimeout(() => tick(l), L.pingIntervalMs);
  };

  const failCommands = (hostId: string, error: GmiError) => {
    for (const [id, c] of [...commands]) {
      if (c.hostId !== hostId) continue;
      commands.delete(id);
      if (c.timer !== null) clock.clearTimeout(c.timer);
      c.reject(error);
    }
  };

  /**
   * Review H2: a dropped `gw.request` or `approval.request` whose id is readable gets a terminal answer, so the host's
   * run does not wait forever (an error event; a deny).
   */
  const answerDropped = (l: Live, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return;
    const r = raw as { t?: unknown; reqId?: unknown; request?: { requestId?: unknown } | null };
    const okId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(v);
    try {
      if (r.t === 'gw.request' && okId(r.reqId)) {
        send(l, { t: 'gw.events', reqId: r.reqId, events: [{ type: 'error', error: { code: 'internal', message: 'The agent runtime sent an invalid model request.' }, afterOutput: false }] });
      } else if (r.t === 'approval.request' && okId(r.request?.requestId)) {
        send(l, { t: 'approval.decision', requestId: r.request.requestId, decision: { kind: 'deny', feedback: 'The approval request was invalid and could not be shown.' } });
      }
    } catch {
      // The host is gone.
    }
  };

  const onMessage = (l: Live, raw: unknown) => {
    if (live !== l || l.exited) return;
    const decoded = decodeHostToMain(raw);
    if (!decoded.ok) {
      log.warn('dropped an invalid message from the harness host', { reason: decoded.reason });
      answerDropped(l, raw);
      return;
    }
    const msg = decoded.msg;
    switch (msg.t) {
      case 'ready':
        if (l.ready) return;
        l.ready = msg;
        l.phase = 'ready';
        l.lastHeartbeat = clock.now();
        log.info('harness host ready', { hostId: l.hostId, version: msg.version, sandbox: msg.sandbox.kind, sandboxOk: msg.sandbox.ok, git: msg.git.ok, ripgrep: msg.ripgrep });
        setState('ready');
        settleReady(null);
        return;
      case 'pong': {
        l.lastHeartbeat = clock.now();
        if (!l.ready) l.phase = msg.phase;
        const p = pings.get(msg.at);
        if (p) {
          pings.delete(msg.at);
          clock.clearTimeout(p.timer);
          p.resolve({ rttMs: clock.now() - p.sentAt, phase: msg.phase });
        }
        return;
      }
      case 'cmd.result': {
        const c = commands.get(msg.id);
        if (!c || c.hostId !== l.hostId) return;
        commands.delete(msg.id);
        if (c.timer !== null) clock.clearTimeout(c.timer);
        if (msg.ok) {
          if (c.cmd.op === 'run.send' || c.cmd.op === 'run.resume') {
            const started = runStartedResult(msg.data);
            if (started) l.session.runStarted(c.cmd.threadId, started);
            else log.warn('run command result without a run id', { op: c.cmd.op });
          }
          c.resolve(msg.data);
        } else {
          c.reject(GmiError.fromShape(msg.error));
        }
        return;
      }
      default:
        l.session.handle(msg);
    }
  };

  const onExit = (l: Live, code: number) => {
    if (l.exited) return;
    l.exited = true;
    if (l.tickTimer !== null) clock.clearTimeout(l.tickTimer);
    if (l.killTimer) clock.clearTimeout(l.killTimer);
    l.session.detach();
    failCommands(l.hostId, new GmiError('internal', 'The agent runtime stopped. Try again.'));
    for (const [at, p] of [...pings]) {
      pings.delete(at);
      clock.clearTimeout(p.timer);
      p.reject(new GmiError('internal', 'The agent runtime stopped.'));
    }
    if (live !== l) return;
    live = null;
    lastExitCode = code;
    if (stopping) {
      setState('stopped');
      const waiters = stopWaiters;
      stopWaiters = [];
      for (const w of waiters) w();
      return;
    }
    const now = clock.now();
    crashTimes = [...crashTimes.filter((t) => now - t < L.crashLoopWindowMs), now];
    log.warn('harness host exited', { hostId: l.hostId, code, crashesInWindow: crashTimes.length });
    if (crashTimes.length >= L.crashLoopCount) {
      setState('crashed');
      settleReady(new GmiError('internal', 'The agent runtime keeps crashing. Use "Restart runtime" to try again.'));
      return;
    }
    const delay = Math.min(L.backoffMaxMs, L.backoffBaseMs * 2 ** (crashTimes.length - 1));
    setState('restarting');
    restartTimer = clock.setTimeout(() => {
      restartTimer = null;
      restarts += 1;
      void spawnHost();
    }, delay);
  };

  const spawnHost = async (): Promise<void> => {
    if (live || stopping) return;
    hostSeq += 1;
    const hostId = `host_${hostSeq}_${randomBytes(4).toString('hex')}`;
    const l: Live = {
      hostId,
      proc: null,
      session: null as unknown as HostSession,
      phase: 'starting',
      ready: null,
      lastHeartbeat: clock.now(),
      tickTimer: null,
      exited: false,
      killTimer: null,
    };
    l.session = attachHostSession(hostId, (msg) => send(l, msg), { ...deps, log: log.child('host') });
    live = l;
    if (state !== 'restarting') setState('starting');
    let proc: HostProcess;
    try {
      proc = await deps.spawn({ env: deps.env(), serviceName: 'GMI Desk Harness' });
    } catch (error) {
      log.error('could not start the harness host', { code: toGmiError(error).code });
      onExit(l, -1);
      return;
    }
    l.proc = proc;
    if (stopping) {
      kill(l, 'stopped during start');
      return;
    }
    const stdio = log.child('host-stdio');
    drainToLog(proc.stdout, stdio, clock, 'stdout');
    drainToLog(proc.stderr, stdio, clock, 'stderr');
    proc.onMessage((data) => onMessage(l, data));
    proc.onExit((code) => onExit(l, code));
    try {
      send(l, { t: 'init', protocol: HARNESS_PROTOCOL, ...deps.init() });
    } catch (error) {
      log.error('could not send init to the harness host', { code: toGmiError(error).code });
      kill(l, 'init failed');
      return;
    }
    l.tickTimer = clock.setTimeout(() => tick(l), L.pingIntervalMs);
  };

  const ready = (): Promise<void> => {
    if (state === 'ready' && live?.ready) return Promise.resolve();
    if (state === 'crashed') return Promise.reject(new GmiError('internal', 'The agent runtime keeps crashing. Use "Restart runtime" to try again.'));
    if (stopping) return Promise.reject(new GmiError('internal', 'The agent runtime is stopping.'));
    const waiter = new Promise<void>((resolve, reject) => readyWaiters.push({ resolve, reject }));
    if (state === 'stopped' && !live) void spawnHost();
    return waiter;
  };

  const stop = (graceMs: number = L.shutdownGraceMs): Promise<void> => {
    stopping = true;
    if (restartTimer !== null) {
      clock.clearTimeout(restartTimer);
      restartTimer = null;
    }
    settleReady(new GmiError('internal', 'The agent runtime is stopping.'));
    const l = live;
    if (!l) {
      setState('stopped');
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      stopWaiters.push(resolve);
      try {
        send(l, { t: 'shutdown', graceMs });
      } catch {
        kill(l, 'shutdown could not be sent');
      }
      clock.setTimeout(() => kill(l, 'shutdown grace elapsed'), Math.max(graceMs, L.shutdownKillAfterMs));
    });
  };

  return {
    info,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready,
    command(cmd, opts = {}) {
      if (!harnessCommandSchema.safeParse(cmd).success || messageBytes(cmd) > MAX_MESSAGE_BYTES - 1_024) {
        return Promise.reject(new GmiError('invalid_input', 'The agent command is invalid or too large.'));
      }
      const id = opts.commandId ?? `cmd_${clock.now().toString(36)}_${randomBytes(6).toString('hex')}`;
      const existing = commands.get(id);
      if (existing) return existing.promise;
      // Registered before waiting for the host, so a second call with the same id joins this one.
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry = { promise, resolve, reject, timer: null as unknown, cmd, hostId: null as string | null };
      commands.set(id, entry);
      const fail = (error: unknown) => {
        if (commands.get(id) === entry) commands.delete(id);
        if (entry.timer !== null) clock.clearTimeout(entry.timer);
        reject(toGmiError(error));
      };
      ready().then(() => {
        if (commands.get(id) !== entry) return;
        const l = live;
        if (!l) return fail(new GmiError('internal', 'The agent runtime is not running.'));
        entry.hostId = l.hostId;
        entry.timer = clock.setTimeout(() => fail(new GmiError('timeout', 'The agent runtime did not answer in time.')), opts.timeoutMs ?? L.commandTimeoutMs);
        // Main refuses the thread's requests from the moment it asks for the interrupt (§4.4).
        if (cmd.op === 'run.interrupt') l.session.interruptThread(cmd.threadId);
        try {
          send(l, { t: 'cmd', id, cmd });
        } catch (error) {
          fail(error);
        }
      }, fail);
      return promise;
    },
    async ping() {
      await ready();
      const l = live;
      if (!l) throw new GmiError('internal', 'The agent runtime is not running.');
      pingSeq += 1;
      const at = clock.now() + pingSeq / 1_000_000;
      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => {
          pings.delete(at);
          reject(new GmiError('timeout', 'The agent runtime did not answer the ping.'));
        }, L.pongTimeoutMs);
        pings.set(at, { sentAt: clock.now(), resolve, reject, timer });
        try {
          send(l, { t: 'ping', at });
        } catch (error) {
          pings.delete(at);
          clock.clearTimeout(timer);
          reject(toGmiError(error));
        }
      });
    },
    async restart() {
      if (live) await stop();
      stopping = false;
      crashTimes = [];
      setState('stopped');
      await ready();
    },
    stop,
    sendDecision(hostId, requestId, decision) {
      const l = live;
      if (!l || l.hostId !== hostId || l.exited) return false;
      try {
        send(l, { t: 'approval.decision', requestId, decision });
        return true;
      } catch {
        return false;
      }
    },
    async viewOnlyDb() {
      if (state !== 'crashed' || !deps.openViewOnly) return null;
      viewOnly ??= deps.openViewOnly();
      try {
        return await viewOnly;
      } catch (error) {
        viewOnly = null;
        throw error;
      }
    },
  };
}
