// Computer sessions and the exec semaphore (compute.md §8.1, §8.7, §9.5, §14 `computer/session.ts`). Owned by C2-A.
//
// ExecPort: 10 slots per sandbox (v2 allows 10 non-terminal executions [V]), shared by the user's computer and the H4
// broker; waiting `user` requests go first and the agent holds at most 6. A slot is held until its execution is
// TERMINAL, not until the HTTP call returns (a 25 s wait that times out leaves it running [V]). Execution ids are
// persisted in the registry as soon as GMI names them; before the first slot of a resource in this run, persisted
// ones are polled and, when still running, cancelled (their slots stay taken until they end). A 429
// `Execution.ConcurrencyLimitExceeded` lowers the local capacity to what GMI allows, restored step by step later.
//
// Sessions: one per open resource, owned by main. open → connecting (connect + one exec for $HOME and the user name) →
// ready. The supervisor's transitions drive paused / resumed (cold) / closed. `close` from the renderer starts the
// 5 min warm period (the last view unmounted); deletion and quit close at once. Terminal input is user activity for
// the idle guard; output never is (§9.5).
import { randomUUID } from 'node:crypto';
import type { ComputerSessionInfo, ComputerSessionState, TerminalState } from '@shared/contracts/compute';
import { TERMINAL_INPUT_MAX_BYTES } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../../core/logger';
import type { DataPlaneApi, ExecInput } from '../sandbox/dataplane';
import { EXEC_POLL_DELAYS_MS, isTerminalExec } from '../sandbox/dataplane';
import type { V2ExecAccepted, V2ExecResult } from '../sandbox/dto';
import {
  AGENT_EXEC_SLOTS_MAX,
  COMPUTE_TIMING,
  EXEC_SLOTS_PER_SANDBOX,
  type ActivitySink,
  type ExecOrigin,
  type ExecPort,
  type ExecPriority,
  type ExecReleaseOutcome,
  type ExecSlot,
  type PhaseTransition,
  type Registry,
  type Supervisor,
} from '../types';
import { TerminalFlow, type TerminalFlowOptions, type FlowTimers } from './flow';
import { ShellBridge, type ShellSocketOpener, type ShellTiming } from './shell-v2';

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new GmiError('cancelled', 'Cancelled.'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (t as { unref?: () => void }).unref?.();
    const onAbort = () => {
      clearTimeout(t);
      reject(new GmiError('cancelled', 'Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const cancelled = () => new GmiError('cancelled', 'Cancelled.');

// ─── ExecPort ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const EXEC_PORT_TIMING = {
  /** After a 429, one slot of capacity comes back this often. */
  capacityRestoreMs: 60_000,
  /** A watched execution is assumed over this long after its own timeout (it cannot outlive it on GMI's side). */
  terminalGraceMs: 60_000,
} as const;

export type ExecPortRegistry = Pick<Registry, 'get' | 'inflightExecs' | 'addInflightExec' | 'removeInflightExec'>;

export interface ExecPortDeps {
  registry: ExecPortRegistry;
  dataPlane: Pick<DataPlaneApi, 'getExecution' | 'cancelExecution'>;
  log: Logger;
  now?: () => Date;
  sleep?: Sleep;
  capacityRestoreMs?: number;
  /** Slot usage of a resource changed (sessions show `execInUse`). */
  onChange?(resourceId: string): void;
}

interface Waiter {
  priority: ExecPriority;
  resolve(slot: ExecSlot): void;
  reject(error: unknown): void;
  cleanup(): void;
}

interface Pool {
  capacity: number;
  inUse: number;
  agentInUse: number;
  waiters: Waiter[];
  reconciled: Promise<void> | null;
  restoreTimer: ReturnType<typeof setTimeout> | null;
}

/** ExecPort plus what the session manager and tests use. */
export interface ExecPortImpl extends ExecPort {
  /** Polls / cancels persisted in-flight executions of a resource (once per run; `acquire` waits for it). */
  reconcile(resourceId: string): Promise<void>;
  dispose(): void;
}

export function createExecPort(deps: ExecPortDeps): ExecPortImpl {
  const log = deps.log;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const restoreMs = deps.capacityRestoreMs ?? EXEC_PORT_TIMING.capacityRestoreMs;
  const pools = new Map<string, Pool>();
  /** Slots bound to an execution id (this run). */
  const bound = new Map<string, SlotImpl>();
  /** Executions being watched until terminal (cancel, leftovers). */
  const watching = new Set<string>();
  const stop = new AbortController();
  let disposed = false;

  const pool = (rid: string): Pool => {
    let p = pools.get(rid);
    if (!p) {
      p = { capacity: EXEC_SLOTS_PER_SANDBOX, inUse: 0, agentInUse: 0, waiters: [], reconciled: null, restoreTimer: null };
      pools.set(rid, p);
    }
    return p;
  };

  const sandboxOf = (rid: string): string => {
    const rec = deps.registry.get(rid);
    if (!rec || rec.backend !== 'sandbox_v2' || !rec.remoteId) throw new GmiError('invalid_input', 'Commands run only on a sandbox that exists.');
    return rec.remoteId;
  };

  const changed = (rid: string) => {
    try {
      deps.onChange?.(rid);
    } catch {
      // listeners never break the port
    }
  };

  const canGrant = (p: Pool, priority: ExecPriority) => p.inUse < p.capacity && (priority === 'user' || p.agentInUse < AGENT_EXEC_SLOTS_MAX);

  class SlotImpl implements ExecSlot {
    readonly slotId = randomUUID();
    eid: string | null = null;
    released = false;
    constructor(
      readonly resourceId: string,
      readonly priority: ExecPriority,
    ) {}
    async bind(exec: { eid: string; origin: ExecOrigin; grantId?: string | null; timeoutSec: number }): Promise<void> {
      if (this.released) throw new GmiError('internal', 'This exec slot was already released.');
      if (this.eid !== null) throw new GmiError('internal', 'This exec slot is already bound.');
      this.eid = exec.eid;
      bound.set(exec.eid, this);
      await deps.registry.addInflightExec({
        eid: exec.eid,
        resourceId: this.resourceId,
        origin: exec.origin,
        grantId: exec.grantId ?? null,
        timeoutSec: exec.timeoutSec,
        startedAt: now().toISOString(),
      });
    }
    async release(outcome: ExecReleaseOutcome): Promise<void> {
      if (this.released) return;
      this.released = true;
      const p = pool(this.resourceId);
      p.inUse = Math.max(0, p.inUse - 1);
      if (this.priority === 'agent') p.agentInUse = Math.max(0, p.agentInUse - 1);
      const eid = this.eid;
      if (eid !== null) bound.delete(eid);
      pump(this.resourceId);
      changed(this.resourceId);
      if (eid !== null) {
        await deps.registry.removeInflightExec(eid).catch((error: unknown) => log.warn('inflight exec not removed', { outcome, code: error instanceof GmiError ? error.code : 'internal' }));
      }
    }
  }

  const take = (rid: string, priority: ExecPriority): SlotImpl => {
    const p = pool(rid);
    p.inUse += 1;
    if (priority === 'agent') p.agentInUse += 1;
    changed(rid);
    return new SlotImpl(rid, priority);
  };

  /** Grants waiting requests: every user first (FIFO), then agents within their cap. */
  function pump(rid: string): void {
    const p = pool(rid);
    for (const priority of ['user', 'agent'] as const) {
      for (let i = 0; i < p.waiters.length; ) {
        const w = p.waiters[i] as Waiter;
        if (w.priority !== priority) {
          i += 1;
          continue;
        }
        if (!canGrant(p, priority)) break;
        p.waiters.splice(i, 1);
        w.cleanup();
        w.resolve(take(rid, priority));
      }
      // A waiting user is never overtaken by an agent.
      if (priority === 'user' && p.waiters.some((w) => w.priority === 'user')) return;
    }
  }

  /** A slot-like hold for an execution from an earlier run (counted in `inUse` until it ends). */
  function holdGhost(rid: string): () => void {
    const p = pool(rid);
    p.inUse += 1;
    let freed = false;
    changed(rid);
    return () => {
      if (freed) return;
      freed = true;
      p.inUse = Math.max(0, p.inUse - 1);
      pump(rid);
      changed(rid);
    };
  }

  /** Polls an execution until it is terminal (or surely over), then calls `done`. Background. */
  function watchUntilTerminal(rid: string, sandboxId: string, eid: string, timeoutSec: number, startedAt: number, done: (status: ExecReleaseOutcome) => void): void {
    if (watching.has(eid)) return;
    watching.add(eid);
    const deadline = startedAt + timeoutSec * 1000 + EXEC_PORT_TIMING.terminalGraceMs;
    void (async () => {
      try {
        for (let i = 0; ; i += 1) {
          if (now().getTime() > deadline) {
            log.info('exec assumed over', { rid });
            done('timed_out');
            return;
          }
          try {
            const r = await deps.dataPlane.getExecution(sandboxId, eid);
            if (isTerminalExec(r.status)) {
              done(r.status as ExecReleaseOutcome);
              return;
            }
          } catch (error) {
            if (error instanceof GmiError && error.status === 404) {
              done('cancelled');
              return;
            }
          }
          await sleep(EXEC_POLL_DELAYS_MS[Math.min(i, EXEC_POLL_DELAYS_MS.length - 1)] as number, stop.signal);
        }
      } catch {
        // disposed
      } finally {
        watching.delete(eid);
      }
    })();
  }

  async function reconcileOnce(rid: string): Promise<void> {
    const leftovers = deps.registry.inflightExecs(rid).filter((e) => !bound.has(e.eid));
    if (leftovers.length === 0) return;
    let sandboxId: string;
    try {
      sandboxId = sandboxOf(rid);
    } catch {
      return;
    }
    await Promise.allSettled(
      leftovers.map(async (e) => {
        const free = holdGhost(rid);
        const finish = () => {
          free();
          void deps.registry.removeInflightExec(e.eid).catch(() => undefined);
        };
        const started = Date.parse(e.startedAt) || now().getTime();
        try {
          const r = await deps.dataPlane.getExecution(sandboxId, e.eid);
          if (isTerminalExec(r.status)) return finish();
          // Nobody waits for it any more: cancel, and keep its slot until it ends.
          await deps.dataPlane.cancelExecution(sandboxId, e.eid);
          log.info('cancelled a leftover exec', { rid, origin: e.origin });
        } catch (error) {
          if (error instanceof GmiError && error.status === 404) return finish();
          log.warn('leftover exec not reconciled yet', { rid, code: error instanceof GmiError ? error.code : 'internal' });
        }
        watchUntilTerminal(rid, sandboxId, e.eid, e.timeoutSec, started, finish);
      }),
    );
  }

  const port: ExecPortImpl = {
    reconcile(rid) {
      const p = pool(rid);
      p.reconciled ??= reconcileOnce(rid).catch((error: unknown) => log.warn('exec reconcile failed', { code: error instanceof GmiError ? error.code : 'internal' }));
      return p.reconciled;
    },

    async acquire(rid, opts) {
      if (disposed) throw cancelled();
      if (opts.priority !== 'user' && opts.priority !== 'agent') throw new GmiError('invalid_input', 'Unknown exec priority.');
      sandboxOf(rid);
      if (opts.signal?.aborted) throw cancelled();
      await port.reconcile(rid);
      if (disposed || opts.signal?.aborted) throw cancelled();
      const p = pool(rid);
      const usersWaiting = p.waiters.some((w) => w.priority === 'user');
      const sameWaiting = p.waiters.some((w) => w.priority === opts.priority);
      if (canGrant(p, opts.priority) && !usersWaiting && !sameWaiting) return take(rid, opts.priority);
      return new Promise<ExecSlot>((resolve, reject) => {
        const signal = opts.signal;
        const onAbort = () => {
          const i = p.waiters.indexOf(waiter);
          if (i >= 0) p.waiters.splice(i, 1);
          changed(rid);
          reject(cancelled());
        };
        const waiter: Waiter = {
          priority: opts.priority,
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener('abort', onAbort),
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        p.waiters.push(waiter);
        changed(rid);
      });
    },

    async cancel(eid) {
      const slot = bound.get(eid) ?? null;
      const rid = slot?.resourceId ?? deps.registry.inflightExecs().find((e) => e.eid === eid)?.resourceId ?? null;
      if (!rid) return;
      let sandboxId: string;
      try {
        sandboxId = sandboxOf(rid);
      } catch (error) {
        // The sandbox is gone: its executions went with it.
        if (slot) await slot.release('cancelled');
        throw error;
      }
      const persisted = deps.registry.inflightExecs(rid).find((e) => e.eid === eid);
      const timeoutSec = persisted?.timeoutSec ?? 3600;
      const started = persisted ? Date.parse(persisted.startedAt) || now().getTime() : now().getTime();
      // Whatever the cancel's outcome (network drop, 404 for an execution already reaped), a bound slot is watched
      // until its execution is terminal or surely over: a failed cancel must never leak the slot.
      try {
        await deps.dataPlane.cancelExecution(sandboxId, eid);
      } catch (error) {
        if (error instanceof GmiError && error.status === 404) {
          if (slot) await slot.release('cancelled');
          return;
        }
        if (slot) watchUntilTerminal(rid, sandboxId, eid, timeoutSec, started, (status) => void slot.release(status));
        throw error;
      }
      if (slot) watchUntilTerminal(rid, sandboxId, eid, timeoutSec, started, (status) => void slot.release(status));
    },

    lowerCapacity(rid, observed) {
      const p = pool(rid);
      const next = Math.max(1, Math.min(p.capacity, Math.floor(observed)));
      if (next === p.capacity) return;
      p.capacity = next;
      log.warn('exec capacity lowered', { rid, capacity: next });
      changed(rid);
      const restore = () => {
        p.restoreTimer = null;
        if (disposed) return;
        p.capacity = Math.min(EXEC_SLOTS_PER_SANDBOX, p.capacity + 1);
        pump(rid);
        changed(rid);
        if (p.capacity < EXEC_SLOTS_PER_SANDBOX) schedule();
      };
      const schedule = () => {
        if (p.restoreTimer) clearTimeout(p.restoreTimer);
        p.restoreTimer = setTimeout(restore, restoreMs);
        (p.restoreTimer as { unref?: () => void }).unref?.();
      };
      schedule();
    },

    usage(rid) {
      const p = pools.get(rid);
      if (!p) return { capacity: EXEC_SLOTS_PER_SANDBOX, inUse: 0, agentInUse: 0, waiting: 0 };
      return { capacity: p.capacity, inUse: p.inUse, agentInUse: p.agentInUse, waiting: p.waiters.length };
    },

    dispose() {
      disposed = true;
      stop.abort();
      for (const p of pools.values()) {
        if (p.restoreTimer) clearTimeout(p.restoreTimer);
        for (const w of p.waiters.splice(0)) {
          w.cleanup();
          w.reject(cancelled());
        }
      }
    },
  };
  return port;
}

const isConcurrencyLimit = (error: unknown) =>
  error instanceof GmiError && error.status === 429 && (error as { remoteCode?: unknown }).remoteCode === 'Execution.ConcurrencyLimitExceeded';

export interface RunExecOptions {
  resourceId: string;
  sandboxId: string;
  input: Omit<ExecInput, 'onAccepted' | 'signal'>;
  priority: ExecPriority;
  /** `app` execs (listings, port scans, usage) are never activity (§9.5); the caller records user activity. */
  origin: ExecOrigin;
  grantId?: string | null;
  /** Abort → the execution is cancelled remotely; its slot is released once it is terminal. */
  signal?: AbortSignal;
  sleep?: Sleep;
  /** Retries after a 429 Execution.ConcurrencyLimitExceeded (default 3). */
  concurrencyRetries?: number;
}

/**
 * One exec through the port: acquire → POST (25 s wait; the slot is bound as soon as GMI names the execution) → poll
 * until terminal → release. The POST itself is not aborted (an aborted request could leave an execution nobody
 * tracks); an abort after it cancels the execution. Used by the session (home exec) and C2-B (files, ports, services).
 */
export async function runExec(port: ExecPort, dataPlane: Pick<DataPlaneApi, 'startExec' | 'getExecution'>, opts: RunExecOptions): Promise<V2ExecResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.concurrencyRetries ?? 3;
  for (let attempt = 0; ; attempt += 1) {
    const slot = await port.acquire(opts.resourceId, { priority: opts.priority, signal: opts.signal });
    let started: V2ExecResult | V2ExecAccepted;
    try {
      started = await dataPlane.startExec(opts.sandboxId, {
        ...opts.input,
        onAccepted: (eid) => slot.bind({ eid, origin: opts.origin, grantId: opts.grantId ?? null, timeoutSec: opts.input.timeoutSec }),
      });
    } catch (error) {
      await slot.release('not_started');
      if (isConcurrencyLimit(error) && attempt < retries) {
        // GMI counts more executions than we hold (another client, or leftovers): use what it allows, back off.
        port.lowerCapacity(opts.resourceId, port.usage(opts.resourceId).inUse);
        await sleep(2_000 * 2 ** attempt, opts.signal);
        continue;
      }
      if (isConcurrencyLimit(error)) throw new GmiError('rate_limited', 'The sandbox is running too many commands at once. Try again shortly.', { status: 429 });
      throw error;
    }
    const eid = started.execution_id;
    if (isTerminalExec(started.status)) {
      await slot.release(started.status as ExecReleaseOutcome);
      return started as V2ExecResult;
    }
    // A wait that timed out leaves the execution running [V]: the slot stays taken while we poll.
    for (let i = 0; ; i += 1) {
      if (opts.signal?.aborted) {
        await port.cancel(eid).catch(() => undefined);
        throw cancelled();
      }
      try {
        await sleep(EXEC_POLL_DELAYS_MS[Math.min(i, EXEC_POLL_DELAYS_MS.length - 1)] as number, opts.signal);
      } catch {
        await port.cancel(eid).catch(() => undefined);
        throw cancelled();
      }
      let result: V2ExecResult;
      try {
        result = await dataPlane.getExecution(opts.sandboxId, eid);
      } catch (error) {
        // We cannot deliver the result any more: cancel it; the port keeps the slot until it ends.
        await port.cancel(eid).catch(() => undefined);
        throw error;
      }
      if (isTerminalExec(result.status)) {
        await slot.release(result.status as ExecReleaseOutcome);
        return result;
      }
    }
  }
}

// ─── Sessions ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first exec of a session: file browser root and user name (§8.1). */
export const SESSION_HOME_COMMAND = `printf '%s\\t%s' "$HOME" "$(id -un)"`;
export const SESSION_HOME_TIMEOUT_SEC = 30;

/** What C2-B / C2-C use to act inside a session (main only). */
export interface ComputerSessionHandle {
  readonly sessionId: string;
  readonly resourceId: string;
  readonly sandboxId: string;
  readonly state: ComputerSessionState;
  readonly home: string | null;
  readonly user: string | null;
  /** Aborted when the session closes: pass it to `runExec` / transfers so abandoned work is cancelled. */
  readonly signal: AbortSignal;
}

export interface SessionManagerDeps {
  registry: ExecPortRegistry;
  supervisor: Pick<Supervisor, 'onTransition'> & Partial<Pick<Supervisor, 'watch' | 'setHints'>>;
  activity: ActivitySink;
  dataPlane: DataPlaneApi;
  execPort: ExecPortImpl;
  openShell: ShellSocketOpener;
  log: Logger;
  emitSession(info: ComputerSessionInfo): void;
  emitTerminal(chunk: { sessionId: string; seq: number; data: Uint8Array }): void;
  /** Native confirmation (main); "Take over" needs it. */
  confirm(opts: { title: string; message: string; detail?: string; confirmLabel: string; cancelLabel?: string }): Promise<boolean>;
  warmMs?: number;
  shell?: { timing?: Partial<ShellTiming>; delay?: (ms: number, signal: AbortSignal) => Promise<void>; random?: () => number; now?: () => number };
  flow?: { options?: Partial<TerminalFlowOptions>; timers?: FlowTimers };
  sleep?: Sleep;
}

class Session implements ComputerSessionHandle {
  state: ComputerSessionState = 'connecting';
  reason: string | null = null;
  home: string | null = null;
  user: string | null = null;
  coldResumed = false;
  warmTimer: ReturnType<typeof setTimeout> | null = null;
  preparing: Promise<void> | null = null;
  readonly abort = new AbortController();
  readonly flow: TerminalFlow;
  readonly shell: ShellBridge;
  constructor(
    readonly sessionId: string,
    readonly resourceId: string,
    readonly sandboxId: string,
    build: (s: Session) => { flow: TerminalFlow; shell: ShellBridge },
  ) {
    const parts = build(this);
    this.flow = parts.flow;
    this.shell = parts.shell;
  }
  get signal(): AbortSignal {
    return this.abort.signal;
  }
}

const SESSION_ID = /^cs_[0-9a-f-]{36}$/;

export interface SessionManager {
  open(resourceId: string): Promise<ComputerSessionInfo>;
  /** The renderer's `close`: the last view went away; closes after the warm period unless reopened. */
  release(sessionId: string): Promise<void>;
  /** Closes at once (deletion, quit, tests). */
  closeNow(sessionId: string, reason: string | null): void;
  info(sessionId: string): ComputerSessionInfo;
  /** For C2-B / C2-C: a live session (throws not_found / conflict when closed or not ready). */
  handle(sessionId: string, opts?: { requireReady?: boolean }): ComputerSessionHandle;
  /** Records user activity for the idle guard (§9.5). */
  recordActivity(sessionId: string, kind: 'file_op' | 'transfer' | 'preview_input' | 'user_exec' | 'service_start'): void;
  terminalAttach(sessionId: string, size: { cols: number; rows: number }): { replay: Uint8Array; seq: number };
  /** Synchronous on purpose: input order = invoke order. */
  terminalInput(sessionId: string, data: string): void;
  terminalResize(sessionId: string, size: { cols: number; rows: number }): void;
  terminalAck(sessionId: string, seq: number): void;
  terminalVisibility(sessionId: string, visible: boolean): void;
  terminalTakeOver(sessionId: string): Promise<void>;
  /** Open sessions (Diagnostics). */
  list(): ComputerSessionInfo[];
  /** Diagnostics (§17): per session, ws reconnects, unacked bytes, paused flow, exec slots. No secrets, no bytes. */
  diagnostics(): Array<{ sessionId: string; state: ComputerSessionState; terminal: TerminalState; reconnects: number; unackedBytes: number; flowPaused: boolean; ringBytes: number; exec: { capacity: number; inUse: number; agentInUse: number; waiting: number } }>;
  /** The renderer went away (reload / crash): nobody watches any terminal until it attaches again. */
  viewsGone(): void;
  onClose(listener: (sessionId: string) => void): () => void;
  dispose(): void;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const log = deps.log;
  const warmMs = deps.warmMs ?? COMPUTE_TIMING.sessionWarmMs;
  const sleep = deps.sleep ?? defaultSleep;
  const byId = new Map<string, Session>();
  const byResource = new Map<string, Session>();
  const closeListeners = new Set<(sessionId: string) => void>();
  let disposed = false;

  const info = (s: Session): ComputerSessionInfo => {
    const shell = s.shell.info();
    const rec = deps.registry.get(s.resourceId);
    return {
      sessionId: s.sessionId,
      resourceId: s.resourceId,
      state: s.state,
      reason: s.reason,
      terminal: { state: shell.state, cols: shell.cols, rows: shell.rows, lastSeq: shell.lastSeq },
      home: s.home,
      user: s.user,
      coldResumed: s.coldResumed,
      services: rec?.services.map((x) => ({ ...x })) ?? [],
      execInUse: deps.execPort.usage(s.resourceId).inUse,
    };
  };

  const emit = (s: Session) => {
    if (disposed && s.state !== 'closed') return;
    try {
      deps.emitSession(info(s));
    } catch (error) {
      log.warn('session event failed', { code: error instanceof GmiError ? error.code : 'internal' });
    }
  };

  const setState = (s: Session, state: ComputerSessionState, reason: string | null = null) => {
    if (s.state === 'closed') return;
    if (s.state === state && s.reason === reason) return;
    log.info('session.state', { sid: s.sessionId, from: s.state, to: state });
    s.state = state;
    s.reason = reason;
    emit(s);
  };

  const hints = () => deps.supervisor.setHints?.({ computerOpen: byId.size > 0 });

  const get = (sessionId: string): Session => {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new GmiError('invalid_input', 'Not a valid session id.');
    const s = byId.get(sessionId);
    if (!s || s.state === 'closed') throw new GmiError('not_found', 'This computer session is closed. Open the computer again.');
    return s;
  };

  function build(s: Session) {
    const flow = new TerminalFlow({
      emit: (chunk) => deps.emitTerminal({ sessionId: s.sessionId, seq: chunk.seq, data: chunk.data }),
      setPaused: (paused) => s.shell?.setPaused(paused),
      onGap: () => emit(s),
      options: deps.flow?.options,
      timers: deps.flow?.timers,
    });
    const shell = new ShellBridge({
      sessionId: s.sessionId,
      sandboxId: s.sandboxId,
      dataPlane: deps.dataPlane,
      open: deps.openShell,
      flow,
      log: log.child('computer.shell'),
      onState: (state: TerminalState) => {
        if (s.signal.aborted) return;
        if (s.state === 'ready' && state === 'reconnecting') setState(s, 'reconnecting');
        else if (s.state === 'reconnecting' && (state === 'attached' || state === 'attached_elsewhere')) setState(s, 'ready');
        else emit(s);
      },
      onUnavailable: (reason) => setState(s, 'unavailable', reason),
      ...deps.shell,
    });
    // No shell before the session is ready (it needs a running sandbox and a token).
    shell.suspend();
    return { flow, shell };
  }

  /** connect + the home exec → ready; a sandbox that is not running yet waits for the supervisor. */
  function prepare(s: Session): Promise<void> {
    s.preparing ??= (async () => {
      setState(s, 'connecting');
      try {
        await deps.dataPlane.tokens.get(s.sandboxId);
      } catch (error) {
        return notReady(s, error);
      }
      try {
        const r = await runExec(deps.execPort, deps.dataPlane, {
          resourceId: s.resourceId,
          sandboxId: s.sandboxId,
          input: { command: SESSION_HOME_COMMAND, timeoutSec: SESSION_HOME_TIMEOUT_SEC },
          priority: 'user',
          origin: 'app',
          signal: s.signal,
          sleep,
        });
        const [home, user] = (r.stdout ?? '').split('\t');
        s.home = home && home.startsWith('/') && !home.includes('\0') ? home.slice(0, 4096) : null;
        s.user = user && /^[A-Za-z0-9._-]{1,64}$/.test(user.trim()) ? user.trim() : null;
      } catch (error) {
        if (s.state === 'closed') return;
        if (error instanceof GmiError && error.status === 409) return notReady(s, error);
        // The terminal works without a home; the file browser falls back to '/'.
        log.warn('home exec failed', { sid: s.sessionId, code: error instanceof GmiError ? error.code : 'internal' });
      }
      if (s.state === 'closed') return;
      setState(s, 'ready');
      s.shell.resume();
    })().finally(() => {
      s.preparing = null;
    });
    return s.preparing;
  }

  function notReady(s: Session, error: unknown): void {
    if (s.state === 'closed') return;
    const status = error instanceof GmiError ? error.status : null;
    // connect: 409 while paused or transitional, 404 while provisioning / failed / deleted → wait for the supervisor.
    if (status === 409 || status === 404) {
      const rec = deps.registry.get(s.resourceId);
      if (rec && (rec.phase === 'paused' || rec.phase === 'pausing')) setState(s, 'paused', 'This sandbox is paused.');
      else setState(s, 'connecting', 'Waiting for the sandbox to run.');
      deps.supervisor.watch?.(s.resourceId);
      return;
    }
    setState(s, 'unavailable', error instanceof GmiError ? error.message : 'Could not reach the sandbox.');
  }

  function closeSession(s: Session, reason: string | null): void {
    if (s.state === 'closed') return;
    if (s.warmTimer) clearTimeout(s.warmTimer);
    s.warmTimer = null;
    s.abort.abort();
    s.shell.dispose();
    s.flow.dispose();
    s.state = 'closed';
    s.reason = reason;
    log.info('session.state', { sid: s.sessionId, to: 'closed' });
    emit(s);
    byId.delete(s.sessionId);
    if (byResource.get(s.resourceId) === s) byResource.delete(s.resourceId);
    hints();
    for (const l of [...closeListeners]) {
      try {
        l(s.sessionId);
      } catch {
        // ignore
      }
    }
  }

  function onTransition(t: PhaseTransition): void {
    const s = byResource.get(t.resourceId);
    if (!s || s.state === 'closed') return;
    switch (t.to) {
      case 'pausing':
      case 'paused':
        s.shell.suspend();
        setState(s, 'paused', t.to === 'paused' ? 'This sandbox is paused.' : 'Pausing…');
        return;
      case 'resuming':
      case 'creating':
        s.shell.suspend();
        setState(s, 'connecting', 'Waiting for the sandbox to run.');
        return;
      case 'running':
      case 'busy':
        if (t.from === 'paused' || t.from === 'resuming' || t.from === 'pausing') {
          // Always assume a cold resume [U] (§7.3): processes and /tmp may be gone; a new token is needed.
          s.coldResumed = true;
          deps.dataPlane.tokens.invalidate(s.sandboxId);
        }
        if (s.state !== 'ready' && s.state !== 'reconnecting') void prepare(s);
        return;
      case 'deleting':
      case 'deleted':
      case 'failed':
        closeSession(s, t.to === 'failed' ? 'This sandbox failed.' : 'This sandbox was deleted.');
        return;
      default:
        return;
    }
  }

  /** Main owns the warm period (§8.1): it closes the session unless a view comes back (open / terminalAttach). */
  function armWarm(s: Session): void {
    if (s.state === 'closed') return;
    if (s.warmTimer) clearTimeout(s.warmTimer);
    s.warmTimer = setTimeout(() => closeSession(s, null), warmMs);
    (s.warmTimer as { unref?: () => void }).unref?.();
  }

  const unsubscribe = deps.supervisor.onTransition(onTransition);

  const manager: SessionManager = {
    async open(resourceId) {
      if (disposed) throw new GmiError('cancelled', 'The app is closing.');
      if (typeof resourceId !== 'string' || !/^cr_[A-Za-z0-9_-]{1,64}$/.test(resourceId)) throw new GmiError('invalid_input', 'Not a valid resource id.');
      const rec = deps.registry.get(resourceId);
      if (!rec || rec.tombstone || rec.phase === 'deleted' || rec.phase === 'deleting') throw new GmiError('not_found', 'This computer no longer exists.');
      if (!rec.managed) throw new GmiError('invalid_input', 'This resource belongs to someone else in your organization: it is read-only here.');
      if (rec.backend !== 'sandbox_v2') {
        throw new GmiError('not_implemented', 'A terminal for containers comes after the container shell check. Logs and status are on the Compute page.');
      }
      if (!rec.remoteId) throw new GmiError('conflict', 'This sandbox is still being created.');

      let s = byResource.get(resourceId);
      if (s && s.state !== 'closed') {
        if (s.warmTimer) clearTimeout(s.warmTimer);
        s.warmTimer = null;
        if (s.state === 'unavailable') await prepare(s);
        else if (s.preparing) await s.preparing;
        return info(s);
      }
      const sandboxId = rec.remoteId;
      s = new Session(`cs_${randomUUID()}`, resourceId, sandboxId, (x) => build(x));
      byId.set(s.sessionId, s);
      byResource.set(resourceId, s);
      hints();
      emit(s);
      if (rec.phase === 'paused' || rec.phase === 'pausing') {
        setState(s, 'paused', 'This sandbox is paused.');
        return info(s);
      }
      if (rec.phase === 'creating' || rec.phase === 'resuming') {
        setState(s, 'connecting', 'Waiting for the sandbox to run.');
        deps.supervisor.watch?.(resourceId);
        return info(s);
      }
      if (rec.phase === 'failed') {
        closeSession(s, 'This sandbox failed.');
        throw new GmiError('conflict', 'This sandbox failed. Delete it from the Compute page.');
      }
      await prepare(s);
      return info(s);
    },

    async release(sessionId) {
      const s = get(sessionId);
      s.flow.setVisible(false);
      armWarm(s);
    },

    closeNow(sessionId, reason) {
      const s = byId.get(sessionId);
      if (s) closeSession(s, reason);
    },

    info: (sessionId) => info(get(sessionId)),

    handle(sessionId, opts = {}) {
      const s = get(sessionId);
      if (opts.requireReady && s.state !== 'ready' && s.state !== 'reconnecting') {
        throw new GmiError('conflict', s.state === 'paused' ? 'This sandbox is paused. Resume it first.' : 'The computer is not ready yet.');
      }
      return s;
    },

    recordActivity(sessionId, kind) {
      const s = get(sessionId);
      deps.activity.record(s.resourceId, { kind });
    },

    terminalAttach(sessionId, size) {
      const s = get(sessionId);
      if (s.state === 'unavailable') {
        // Remember that a view wants the terminal: Reconnect (open → ready) then starts the shell by itself.
        s.shell.want();
        throw new GmiError('conflict', s.reason ?? 'The computer is not available. Reconnect first.');
      }
      if (s.warmTimer) {
        clearTimeout(s.warmTimer);
        s.warmTimer = null;
      }
      const out = s.shell.attach(size);
      emit(s);
      return out;
    },

    terminalInput(sessionId, data) {
      // Synchronous until the bytes are queued: no await may come before `write` (§8.2).
      if (typeof data !== 'string') throw new GmiError('invalid_input', 'Terminal input must be text.');
      if (Buffer.byteLength(data, 'utf8') > TERMINAL_INPUT_MAX_BYTES) throw new GmiError('invalid_input', 'Terminal input is limited to 64 KiB per call.');
      const s = get(sessionId);
      if (s.state === 'paused') throw new GmiError('conflict', 'This sandbox is paused. Resume it first.');
      s.shell.write(data);
      deps.activity.record(s.resourceId, { kind: 'terminal_input' });
    },

    terminalResize(sessionId, size) {
      get(sessionId).shell.resize(size);
    },

    terminalAck(sessionId, seq) {
      if (!Number.isSafeInteger(seq) || seq < 0) throw new GmiError('invalid_input', 'Not a valid sequence number.');
      get(sessionId).flow.ack(seq);
    },

    terminalVisibility(sessionId, visible) {
      if (typeof visible !== 'boolean') throw new GmiError('invalid_input', 'Visibility must be true or false.');
      const s = get(sessionId);
      s.flow.setVisible(visible);
      // A view that comes back after a gap sees `lastSeq` ahead of its own and reattaches.
      if (visible && !s.flow.stats().synced) emit(s);
    },

    async terminalTakeOver(sessionId) {
      const s = get(sessionId);
      if (s.state !== 'ready' && s.state !== 'reconnecting') throw new GmiError('conflict', 'The computer is not ready yet.');
      const ok = await deps.confirm({
        title: 'Take over the terminal?',
        message: 'Another window or device is attached to this sandbox’s shell.',
        detail: 'Taking over closes that shell for good: programs running in it stop. This cannot be undone.',
        confirmLabel: 'Take over',
        cancelLabel: 'Cancel',
      });
      if (!ok) throw new GmiError('cancelled', 'Take over cancelled.');
      if ((s.state as ComputerSessionState) === 'closed') throw new GmiError('not_found', 'This computer session is closed.');
      await s.shell.takeOver();
      emit(s);
    },

    list: () => [...byId.values()].map(info),

    diagnostics: () =>
      [...byId.values()].map((s) => {
        const flow = s.flow.stats();
        return {
          sessionId: s.sessionId,
          state: s.state,
          terminal: s.shell.terminalState,
          reconnects: s.shell.reconnects,
          unackedBytes: flow.unacked,
          flowPaused: flow.paused,
          ringBytes: flow.ringBytes,
          exec: deps.execPort.usage(s.resourceId),
        };
      }),

    viewsGone() {
      // The renderer reloaded or crashed: its views (and its own timers) are gone. Sessions it reopens are kept
      // (open / terminalAttach clear the timer); the rest close after the warm period.
      for (const s of byId.values()) {
        s.flow.setVisible(false);
        armWarm(s);
      }
    },

    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const s of [...byId.values()]) closeSession(s, null);
      deps.execPort.dispose();
    },
  };

  return manager;
}
