/**
 * Main's side of one host's messages (harness.md §5.1, §13.3), after zod validation (protocol.ts): gateway requests
 * with the supervisor-assigned owner (never a field the host sends), batched `gw.events` back, `gw.cancel`, the RPC
 * router, approvals through the broker, thread events forwarded to the renderer, `run.ended`, and the host's logs.
 *
 * A session is attached per host process. `detach()` (host exit or watchdog kill) aborts the host's upstream
 * requests (`gateway.abortOwner`: settled with estimated usage, reservations released), closes its runs and
 * withdraws its approvals.
 */
import type { CodeThreadEvent, CodeThreadSummary, ApprovalRequest } from '@shared/contracts/code';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { GatewayEvent } from '@shared/contracts/gateway';
import type { GmiGateway } from '../../core/services';
import type { Logger } from '../../core/logger';
import { pumpGatewayEvents } from '../gateway/gateway';
import type { GatewayClock } from '../gateway/types';
import { turnIdOf, type HostRpc, type HostRpcMethod, type HostRpcParams, type HostToMain, type MainToHost, type RunStartedResult } from '@harness/protocol';
import type { ApprovalBroker } from './approvals';

export interface RpcContext {
  hostId: string;
}
export type RpcHandler<M extends HostRpcMethod> = (params: HostRpcParams<M>, ctx: RpcContext) => Promise<unknown>;
export type RpcHandlers = { [M in HostRpcMethod]?: RpcHandler<M> };

/** Routes a validated host RPC; methods without a handler answer not_implemented. */
export function createRpcRouter(handlers: RpcHandlers | (() => RpcHandlers)): (call: HostRpc, ctx: RpcContext) => Promise<unknown> {
  return async (call, ctx) => {
    const table = typeof handlers === 'function' ? handlers() : handlers;
    const handler = table[call.method] as RpcHandler<typeof call.method> | undefined;
    if (!handler) throw new GmiError('not_implemented', `${call.method} is not available yet.`);
    return handler(call.params as never, ctx);
  };
}

/** The default handlers H2-0 provides: structured native dialogs. mcp.* and secrets.* come with H3-D, compute.call with H4-B. */
export function defaultRpcHandlers(approvals: Pick<ApprovalBroker, 'confirmStructured'>): RpcHandlers {
  return {
    'dialog.confirm': async (params) => ({ confirmed: await approvals.confirmStructured(params.kind, params.subject) }),
  };
}

export interface HostBridgeDeps {
  gateway: GmiGateway;
  approvals: ApprovalBroker;
  rpc: (call: HostRpc, ctx: RpcContext) => Promise<unknown>;
  /** `code:event` / `code:threads` to the renderer. */
  emitEvent(event: CodeThreadEvent): void;
  emitThreads(threads: CodeThreadSummary[]): void;
  clock: Pick<GatewayClock, 'now' | 'setTimeout' | 'clearTimeout'>;
  log: Logger;
}

export interface HostSession {
  readonly hostId: string;
  /** Messages the supervisor does not handle itself (everything except ready, pong and cmd.result). */
  handle(msg: Exclude<HostToMain, { t: 'ready' | 'pong' | 'cmd.result' }>): void;
  /** A run.send / run.resume result: main opens the run before reading the host's next message (§4.4). */
  runStarted(threadId: string, result: RunStartedResult): void;
  /** `run.interrupt` sent: the thread's runs are closed now, so later requests of them are refused. */
  interruptThread(threadId: string): void;
  openRuns(): Array<{ threadId: string; runId: string }>;
  inFlight(): number;
  detach(): void;
}

const isTerminal = (e: GatewayEvent) => e.type === 'finish' || e.type === 'error';

export function attachHostSession(hostId: string, send: (msg: MainToHost) => void, deps: HostBridgeDeps): HostSession {
  const { gateway, approvals, log } = deps;
  const requests = new Map<string, { controller: AbortController; cancelledByHost: boolean }>();
  const runs = new Map<string, string>(); // runId → threadId
  let detached = false;

  const post = (msg: MainToHost) => {
    if (detached) return;
    try {
      send(msg);
    } catch (error) {
      log.warn('could not post to the harness host', { t: msg.t, code: toGmiError(error).code });
    }
  };

  const closeRun = (runId: string) => {
    if (!runs.delete(runId)) return;
    try {
      gateway.closeRun(runId);
    } catch (error) {
      log.warn('gateway closeRun failed', { code: toGmiError(error).code });
    }
  };

  const startRequest = (reqId: string, req: Extract<HostToMain, { t: 'gw.request' }>['req']) => {
    const fail = (error: GmiError) => post({ t: 'gw.events', reqId, events: [{ type: 'error', error: error.toShape(), afterOutput: false }] });
    if (requests.has(reqId)) {
      log.warn('duplicate gateway request id from the host', { reqId });
      return;
    }
    if (req.requestId !== reqId) {
      fail(new GmiError('invalid_input', 'The request id does not match.'));
      return;
    }
    const entry = { controller: new AbortController(), cancelledByHost: false };
    requests.set(reqId, entry);
    let terminal = false;
    const forward = (events: GatewayEvent[]) => {
      if (entry.cancelledByHost) {
        // The host stopped listening, but money it was charged still reaches it (review H2: the thread cost missed
        // aborted requests). Only `usage` events are forwarded after a cancel.
        const usage = events.filter((e) => e.type === 'usage');
        if (usage.length > 0) post({ t: 'gw.events', reqId, events: usage });
        return;
      }
      if (events.some(isTerminal)) terminal = true;
      post({ t: 'gw.events', reqId, events });
    };
    void (async () => {
      try {
        // The owner is the supervisor's id for this process, never a field from the host (§4.1).
        await pumpGatewayEvents(gateway.stream(req, entry.controller.signal, { hostId }), forward, { clock: deps.clock });
      } catch (error) {
        if (!terminal) forward([{ type: 'error', error: toGmiError(error).toShape(), afterOutput: false }]);
        terminal = true;
      } finally {
        requests.delete(reqId);
        if (!terminal && !entry.cancelledByHost) forward([{ type: 'error', error: { code: 'internal', message: 'The gateway stream ended without a result.' }, afterOutput: false }]);
      }
    })();
  };

  return {
    hostId,
    handle(msg) {
      if (detached) return;
      switch (msg.t) {
        case 'gw.request':
          startRequest(msg.reqId, msg.req);
          return;
        case 'gw.cancel': {
          const entry = requests.get(msg.reqId);
          if (entry) {
            entry.cancelledByHost = true;
            entry.controller.abort();
          }
          return;
        }
        case 'rpc':
          void deps.rpc(msg.call, { hostId }).then(
            (data) => post({ t: 'rpc.result', id: msg.id, ok: true, data: data ?? null }),
            (error: unknown) => post({ t: 'rpc.result', id: msg.id, ok: false, error: toGmiError(error).toShape() }),
          );
          return;
        case 'event':
          deps.emitEvent(msg.event);
          return;
        case 'threads':
          deps.emitThreads(msg.threads);
          return;
        case 'approval.request':
          approvals.submit(hostId, msg.request as ApprovalRequest);
          return;
        case 'approval.withdrawn':
          approvals.withdraw(msg.requestId, hostId);
          return;
        case 'run.ended':
          if (runs.get(msg.runId) === msg.threadId) closeRun(msg.runId);
          return;
        case 'log': {
          const scoped = log.child(msg.scope.replace(/[^\w.-]/g, '_').slice(0, 64) || 'host');
          scoped[msg.level](msg.message, msg.meta);
          return;
        }
      }
    },
    runStarted(threadId, result) {
      if (detached) return;
      try {
        gateway.openRun({ threadId, turnId: turnIdOf(threadId, result.turn), runId: result.runId });
        runs.set(result.runId, threadId);
      } catch (error) {
        log.warn('gateway openRun refused', { code: toGmiError(error).code });
      }
    },
    interruptThread(threadId) {
      for (const [runId, t] of [...runs]) if (t === threadId) closeRun(runId);
    },
    openRuns: () => [...runs].map(([runId, threadId]) => ({ runId, threadId })),
    inFlight: () => requests.size,
    detach() {
      if (detached) return;
      detached = true;
      for (const entry of requests.values()) entry.controller.abort();
      requests.clear();
      try {
        gateway.abortOwner(hostId);
      } catch (error) {
        log.warn('gateway abortOwner failed', { code: toGmiError(error).code });
      }
      for (const runId of [...runs.keys()]) closeRun(runId);
      approvals.dropHost(hostId);
    },
  };
}
