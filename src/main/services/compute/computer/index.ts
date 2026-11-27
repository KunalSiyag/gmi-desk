// The computer service (compute.md §8, §14): the `computer` namespace. Owned by C2-A; C2-B (files, ports, services,
// transfers) and C2-C (previews) plug in as `parts` (the integrator wires them in `slices/computer.ts`).
//
// C2-A serves the session lifecycle and the terminal: open, close, getSession, terminalAttach / Input / Resize / Ack /
// Visibility / TakeOver. Every other method comes from a part, or answers not_implemented until one provides it.
//
// Mock mode (`backends.mock`): the shell runs on the simulator's fake PTY instead of a WebSocket, through the same
// bridge, flow control and session code. Nothing here can reach GMI in mock mode (T17).
import { COMPUTER_API_METHODS, type ComputerApi } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { AppContext } from '../../../core/context';
import type { Logger } from '../../../core/logger';
import { createNotImplementedApi } from '../../../ipc/registry';
import type { MockCompute } from '../../../mock/compute';
import type { ComputeBackends } from '../index';
import type { DataPlaneApi, TokenCache } from '../sandbox/dataplane';
import type { ComputeInternals } from '../types';
import { createExecPort, createSessionManager, type ExecPortImpl, type SessionManager, type SessionManagerDeps } from './session';
import { createWsShellOpener, ShellHandshakeError, type ShellSocket, type ShellSocketOpener, type WsCtor } from './shell-v2';

export { runExec, type ComputerSessionHandle, type SessionManager, type ExecPortImpl } from './session';

/** Methods C2-A serves itself; parts cannot replace them. */
export const COMPUTER_SESSION_METHODS = [
  'open',
  'close',
  'getSession',
  'terminalAttach',
  'terminalInput',
  'terminalResize',
  'terminalAck',
  'terminalVisibility',
  'terminalTakeOver',
] as const satisfies readonly (keyof ComputerApi)[];

type SessionMethod = (typeof COMPUTER_SESSION_METHODS)[number];
export type ComputerPartMethods = Partial<Omit<ComputerApi, SessionMethod>>;

/** What a part (C2-B, C2-C) is built from. Main only. */
export interface ComputerPartContext {
  ctx: AppContext;
  log: Logger;
  sessions: SessionManager;
  execPort: ExecPortImpl;
  dataPlane: DataPlaneApi;
  tokens: TokenCache;
  internals: ComputeInternals;
  /** The PreviewHost from `slices/computer.ts` (C2-C). */
  previewHost: unknown;
}

export interface ComputerPart {
  api: ComputerPartMethods;
  /** The session became ready (open, resume, reconnect): tokens may be new. */
  sessionReady?(sessionId: string): void;
  /** The renderer reloaded or crashed (see `ComputerServiceInstance.viewsGone`). */
  viewsGone?(): void;
  dispose?(): void | Promise<void>;
}

export type ComputerPartFactory = (c: ComputerPartContext) => ComputerPart;

/** Structurally compatible with `slices/computer.ts` `ComputerServiceDeps` (plus what C2-A needs). */
export interface ComputerServiceDeps {
  compute: { internals: ComputeInternals | null; backends?: ComputeBackends | null };
  /** The compute slice's clients; `compute.backends` is used when this is not given. */
  backends?: ComputeBackends | null;
  previewHost?: unknown;
  parts?: ComputerPartFactory[];
  /** Tests: overrides for the session manager (timers, backoff, flow, the socket opener). */
  overrides?: Partial<Pick<SessionManagerDeps, 'warmMs' | 'shell' | 'flow' | 'sleep' | 'openShell'>> & { WebSocketImpl?: WsCtor };
}

export interface ComputerServiceInstance {
  api: ComputerApi;
  /** Null when the compute slice is not available (the API then answers not_implemented). */
  sessions: SessionManager | null;
  execPort: ExecPortImpl | null;
  /** The renderer reloaded or crashed: nobody watches any terminal until it attaches again (§8.2). */
  viewsGone(): void;
  dispose(): Promise<void>;
}

/** The fake PTY as a shell socket (mock mode). A busy demo shell answers like a 409 handshake. */
export function createMockShellOpener(mock: Pick<MockCompute, 'openPty'>): ShellSocketOpener {
  return async (target, handlers, signal) => {
    if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
    let pty: ReturnType<MockCompute['openPty']>;
    try {
      pty = mock.openPty(target.sandboxId);
    } catch (error) {
      if (error instanceof GmiError && (error.status === 409 || error.status === 401)) {
        throw new ShellHandshakeError(error.status);
      }
      throw error;
    }
    let closed = false;
    const off = pty.onData((bytes) => {
      if (!closed) handlers.onData(bytes);
    });
    const socket: ShellSocket = {
      send: (bytes) => pty.write(bytes),
      pause: () => undefined,
      resume: () => undefined,
      close() {
        closed = true;
        off();
        pty.close();
      },
    };
    return socket;
  };
}

export function createComputerService(ctx: AppContext, deps: ComputerServiceDeps): ComputerServiceInstance {
  const log = ctx.log.child('computer');
  const internals = deps.compute.internals;
  const backends = deps.backends ?? deps.compute.backends ?? null;
  const stub = createNotImplementedApi<ComputerApi>('The computer panel', COMPUTER_API_METHODS);

  if (!internals || !backends) {
    log.warn('computer not wired: the compute slice gave no internals or clients');
    return { api: stub, sessions: null, execPort: null, viewsGone: () => undefined, dispose: async () => undefined };
  }

  const parts: ComputerPart[] = [];
  const lastState = new Map<string, string>();
  const execPort = createExecPort({ registry: internals.registry, dataPlane: backends.dataPlane, log: log.child('computer.exec'), now: () => ctx.now() });
  const openShell =
    deps.overrides?.openShell ??
    (backends.mock ? createMockShellOpener(backends.mock) : createWsShellOpener({ dataPlane: backends.dataPlane, WebSocketImpl: deps.overrides?.WebSocketImpl }));

  const sessions = createSessionManager({
    registry: internals.registry,
    supervisor: internals.supervisor,
    activity: internals.guard.activity,
    dataPlane: backends.dataPlane,
    execPort,
    openShell,
    log,
    emitSession: (info) => {
      ctx.events.emit('computer:session', info);
      const was = lastState.get(info.sessionId);
      if (info.state === 'closed') lastState.delete(info.sessionId);
      else lastState.set(info.sessionId, info.state);
      if (info.state === 'ready' && was !== 'ready') {
        for (const p of parts) {
          try {
            p.sessionReady?.(info.sessionId);
          } catch {
            // a part never breaks the session
          }
        }
      }
    },
    emitTerminal: (chunk) => ctx.events.emit('computer:terminal', chunk),
    confirm: (opts) => ctx.platform.confirm(opts),
    warmMs: deps.overrides?.warmMs,
    shell: deps.overrides?.shell,
    flow: deps.overrides?.flow,
    sleep: deps.overrides?.sleep,
  });

  const own: Pick<ComputerApi, SessionMethod> = {
    open: (resourceId) => sessions.open(resourceId),
    close: (sessionId) => sessions.release(sessionId),
    getSession: async (sessionId) => sessions.info(sessionId),
    // Synchronous up to the replay: nothing awaits before the ring is read.
    terminalAttach: async (sessionId, size) => sessions.terminalAttach(sessionId, size),
    // No await before the bytes are queued: invokes keep their order (§8.2).
    terminalInput: async (sessionId, data) => sessions.terminalInput(sessionId, data),
    terminalResize: async (sessionId, size) => sessions.terminalResize(sessionId, size),
    terminalAck: async (sessionId, seq) => sessions.terminalAck(sessionId, seq),
    terminalVisibility: async (sessionId, visible) => sessions.terminalVisibility(sessionId, visible),
    terminalTakeOver: (sessionId) => sessions.terminalTakeOver(sessionId),
  };

  const partCtx: ComputerPartContext = {
    ctx,
    log,
    sessions,
    execPort,
    dataPlane: backends.dataPlane,
    tokens: backends.tokens,
    internals,
    previewHost: deps.previewHost ?? null,
  };
  for (const factory of deps.parts ?? []) {
    try {
      parts.push(factory(partCtx));
    } catch (error) {
      log.error('computer part failed to start', { code: error instanceof GmiError ? error.code : 'internal' });
    }
  }

  const api = { ...stub } as ComputerApi;
  const sessionMethods = new Set<string>(COMPUTER_SESSION_METHODS);
  for (const part of parts) {
    for (const [name, fn] of Object.entries(part.api)) {
      if (sessionMethods.has(name) || typeof fn !== 'function' || !(COMPUTER_API_METHODS as readonly string[]).includes(name)) continue;
      (api as unknown as Record<string, unknown>)[name] = fn;
    }
  }
  Object.assign(api, own);

  let disposed = false;
  return {
    api,
    sessions,
    execPort,
    viewsGone: () => {
      sessions.viewsGone();
      for (const p of parts) {
        try {
          p.viewsGone?.();
        } catch {
          // ignore
        }
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled(parts.map(async (p) => p.dispose?.()));
      sessions.dispose();
    },
  };
}
