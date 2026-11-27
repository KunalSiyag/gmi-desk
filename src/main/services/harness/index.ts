/**
 * The harness bridge in main (harness.md §5, §9.4, §13.3): supervisor, host sessions and RPC router, approval
 * broker, spawn env and the view-only fallback. `mcp-bridge.ts` (H3-D) plugs into the RPC router.
 */
import { join } from 'node:path';
import type { CodeThreadEvent, CodeThreadSummary } from '@shared/contracts/code';
import type { AppContext } from '../../core/context';
import type { GmiGateway } from '../../core/services';
import type { HostInitSettings } from '@harness/protocol';
import { harnessDataDir } from './paths';
import { createApprovalBroker, type ApprovalBroker } from './approvals';
import { createRpcRouter, defaultRpcHandlers, type RpcHandlers } from './bridge';
import { buildHostEnv } from './env';
import { openReadOnlyHarnessDb } from './readonly-db';
import { createHarnessSupervisor, type HarnessSupervisor, type HostProcess, type HostSpawner, type SupervisorClock } from './supervisor';

export { createApprovalBroker, allowedDecisionsFor, confirmationFor, sanitizeDialogText, withinSuggested, APPROVAL_LIMITS, ONE_SHOT_TOOLS } from './approvals';
export type { ApprovalBroker, ApprovalBrokerDeps } from './approvals';
export { attachHostSession, createRpcRouter, defaultRpcHandlers } from './bridge';
export type { HostSession, RpcHandlers, RpcHandler, RpcContext } from './bridge';
export { buildHostEnv, HOST_ENV_ALLOWLIST, sanitizePath } from './env';
export { openReadOnlyHarnessDb } from './readonly-db';
export type { ReadOnlyHarnessDb } from './readonly-db';
export { createHarnessSupervisor, drainToLog, SUPERVISOR_LIMITS } from './supervisor';
export type { HarnessSupervisor, HostInfo, HostProcess, HostSpawner, HostState } from './supervisor';
export { harnessDataDir } from './paths';

export const systemSupervisorClock: SupervisorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Spawns `modulePath` (dist-electron/harness.cjs) in an Electron utilityProcess and hands it a MessagePort
 * (`{t:'port'}`). Electron is imported lazily so this module loads in tests.
 */
export function electronHostSpawner(modulePath: string): HostSpawner {
  return async ({ env, serviceName }) => {
    const { utilityProcess, MessageChannelMain } = await import('electron');
    const child = utilityProcess.fork(modulePath, [], { serviceName, stdio: 'pipe', env });
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ t: 'port' }, [port2]);
    const exitListeners: Array<(code: number) => void> = [];
    let exited = false;
    child.once('exit', (code: number) => {
      exited = true;
      port1.close();
      for (const l of exitListeners) l(code);
    });
    const proc: HostProcess = {
      get pid() {
        return child.pid ?? null;
      },
      postMessage: (message) => port1.postMessage(message),
      onMessage: (listener) => {
        port1.on('message', (event) => listener(event.data));
        port1.start();
      },
      onExit: (listener) => {
        if (exited) listener(-1);
        else exitListeners.push(listener);
      },
      stdout: child.stdout,
      stderr: child.stderr,
      kill: () => {
        child.kill();
      },
    };
    return proc;
  };
}

export interface HarnessServiceDeps {
  gateway: GmiGateway;
  /** Default: the Electron utilityProcess spawner for `<dist-electron>/harness.cjs`. */
  spawn?: HostSpawner;
  clock?: SupervisorClock;
  /** RPC handlers added by later slices (mcp-bridge.ts, the compute broker). */
  rpcHandlers?: RpcHandlers;
  /** H3-A's isLoosening for approval decisions (§9.4). */
  extraConfirmation?: Parameters<typeof createApprovalBroker>[0]['extraConfirmation'];
}

export interface HarnessService {
  supervisor: HarnessSupervisor;
  approvals: ApprovalBroker;
  /** Adds or replaces RPC handlers (H3-D mcp-bridge, H4-B compute broker register here). */
  setRpcHandlers(handlers: RpcHandlers): void;
  dispose(): Promise<void>;
}

/** The default module path: next to the main bundle (dist-electron/harness.cjs). */
export function defaultHostModulePath(): string {
  return join(__dirname, 'harness.cjs');
}

export function createHarnessService(ctx: AppContext, deps: HarnessServiceDeps): HarnessService {
  const clock = deps.clock ?? systemSupervisorClock;
  const log = ctx.log.child('harness');
  let supervisorRef: HarnessSupervisor | null = null;
  const approvals = createApprovalBroker({
    platform: ctx.platform,
    emit: (payload) => ctx.events.emit('code:approval', payload),
    // Decisions go to the host that asked, and only while it is the live one.
    deliver: (hostId, requestId, decision) => supervisorRef?.sendDecision(hostId, requestId, decision),
    clock,
    log: log.child('approvals'),
    extraConfirmation: deps.extraConfirmation,
  });
  let handlers: RpcHandlers = { ...defaultRpcHandlers(approvals), ...deps.rpcHandlers };
  const router = createRpcRouter(() => handlers);
  const settings: HostInitSettings = { mock: ctx.mock, logLevel: process.env.GMI_DESK_LOG_LEVEL === 'debug' ? 'debug' : 'info' };

  const supervisor = createHarnessSupervisor({
    spawn: deps.spawn ?? electronHostSpawner(defaultHostModulePath()),
    env: () => buildHostEnv(process.env),
    init: () => ({ dataDir: harnessDataDir(ctx.paths), installId: ctx.installId, settings, platform: process.platform }),
    gateway: deps.gateway,
    approvals,
    rpc: router,
    emitEvent: (event: CodeThreadEvent) => ctx.events.emit('code:event', event),
    emitThreads: (threads: CodeThreadSummary[]) => ctx.events.emit('code:threads', threads),
    clock,
    log,
    openViewOnly: () => openReadOnlyHarnessDb(join(harnessDataDir(ctx.paths), 'harness.sqlite')),
  });
  supervisorRef = supervisor;

  return {
    supervisor,
    approvals,
    setRpcHandlers(next) {
      handlers = { ...handlers, ...next };
    },
    async dispose() {
      approvals.dispose();
      await supervisor.stop();
    },
  };
}
