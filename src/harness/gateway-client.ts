/**
 * The host's side of every request to main (harness.md §5.1, §13.3): model requests through main's gateway
 * (`gw.request` → batched `gw.events`, `gw.cancel`), RPCs (`rpc` → `rpc.result`), approvals
 * (`approval.request` → `approval.decision`, `approval.withdrawn`) and notifications (`event`, `threads`,
 * `run.ended`, `log`). The host holds no credentials; everything paid or privileged is decided in main.
 */
import { GmiError, type GmiErrorShape } from '@shared/contracts/errors';
import type { ApprovalDecision, ApprovalRequest } from '@shared/contracts/code';
import type { GatewayEvent } from '@shared/contracts/gateway';
import { decodeHostToMain, MAX_MESSAGE_BYTES, messageBytes, type HostToMain, type MainToHost } from './protocol';
import { newId, type HostClock, type HostLog, type MainLink } from './types';

export const LINK_LIMITS = {
  /** Default RPC timeout; `dialog.confirm` waits for the user (APPROVAL_TTL_MS). */
  rpcTimeoutMs: 60_000,
  /** Approvals expire after 24 h in main (§9.4); a dialog RPC never outlives that. */
  approvalTtlMs: 24 * 60 * 60 * 1000,
  /** Host log lines forwarded per second (excess dropped and counted). */
  logLinesPerSecond: 100,
} as const;

const cancelled = () => new GmiError('cancelled', 'Cancelled.');
const isTerminal = (event: GatewayEvent) => event.type === 'finish' || event.type === 'error';

export interface MainLinkHandle extends MainLink {
  /** Feeds a validated message from main; returns false when it is not a link message (init, cmd, ping, shutdown). */
  handle(msg: MainToHost): boolean;
  /** The link to main is gone (shutdown): pending RPCs and approvals reject, streams end with an error. */
  failAll(error: GmiError): void;
}

/** Keeps only flat, short, primitive meta values (ids, counts, codes): the host never forwards content (§21). */
export function safeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [key, value] of Object.entries(meta)) {
    if (n >= 20 || key.length > 64) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.length > 256 ? `${value.slice(0, 256)}…` : value;
    else continue;
    n += 1;
  }
  return out;
}

/** A HostLog that forwards `{t:'log'}` to main, rate-limited per second. */
export function createPortLog(send: (msg: HostToMain) => void, clock: Pick<HostClock, 'now'>, scope = 'harness', limit: number = LINK_LIMITS.logLinesPerSecond): HostLog {
  const state = { windowStart: 0, count: 0, dropped: 0 };
  const make = (s: string): HostLog => {
    const emit = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => {
      const now = clock.now();
      if (now - state.windowStart >= 1_000) {
        const dropped = state.dropped;
        state.windowStart = now;
        state.count = 0;
        state.dropped = 0;
        if (dropped > 0) {
          state.count += 1;
          trySend({ t: 'log', level: 'warn', scope: 'harness', message: 'host log lines dropped (rate limit)', meta: { dropped } });
        }
      }
      if (state.count >= limit) {
        state.dropped += 1;
        return;
      }
      state.count += 1;
      const m = safeMeta(meta);
      trySend({ t: 'log', level, scope: s.slice(0, 128), message: message.slice(0, 4_096), ...(m ? { meta: m } : {}) });
    };
    return {
      debug: (m, meta) => emit('debug', m, meta),
      info: (m, meta) => emit('info', m, meta),
      warn: (m, meta) => emit('warn', m, meta),
      error: (m, meta) => emit('error', m, meta),
      child: (child) => make(`${s}.${child}`),
    };
  };
  const trySend = (msg: HostToMain) => {
    try {
      send(msg);
    } catch {
      // The port is gone: nothing to log to.
    }
  };
  return make(scope);
}

/** A `usage` event that arrived after its stream closed (cancelled, aborted): main charged it anyway. */
export type LateUsageHandler = (scope: { threadId: string; contextRunId: string | null }, event: Extract<GatewayEvent, { type: 'usage' }>) => void;

export function createMainLink(opts: { send: (msg: HostToMain) => void; clock: HostClock; log?: HostLog; rpcTimeoutMs?: number }): MainLinkHandle & { onLateUsage(handler: LateUsageHandler | null): void } {
  const { send, clock } = opts;
  const log = opts.log ?? createPortLog(send, clock);
  let lateUsage: LateUsageHandler | null = null;
  /** Recently closed requests (bounded): their late `usage` is credited to the thread (review H2). */
  const closed = new Map<string, { threadId: string; runId: string | null }>();
  const rememberClosed = (reqId: string, scope: { threadId: string; runId: string | null }) => {
    closed.set(reqId, scope);
    while (closed.size > 512) closed.delete(closed.keys().next().value as string);
  };

  // ── Gateway streams ──
  interface StreamState {
    push(events: GatewayEvent[]): void;
    fail(error: GmiError): void;
  }
  const streams = new Map<string, StreamState>();

  // ── RPCs ──
  const rpcs = new Map<string, { resolve(v: unknown): void; reject(e: unknown): void }>();

  // ── Approvals ──
  const approvals = new Map<string, { resolve(d: ApprovalDecision): void; reject(e: unknown): void }>();

  const link: MainLinkHandle & { onLateUsage(handler: LateUsageHandler | null): void } = {
    log,
    onLateUsage(handler) {
      lateUsage = handler;
    },
    gateway: {
      async *stream(req, signal) {
        if (signal.aborted) throw cancelled();
        const reqId = req.requestId;
        if (streams.has(reqId)) throw new GmiError('invalid_input', 'A gateway request with this id is already running.');
        const request: HostToMain = { t: 'gw.request', reqId, req };
        if (messageBytes(request) > MAX_MESSAGE_BYTES) {
          // Main would refuse it the same way (§13.3): compaction layer 2 handles it (§7.5).
          yield { type: 'error', error: { code: 'context_overflow', message: 'The request is larger than 4 MiB.' }, afterOutput: false };
          return;
        }
        // Review H2: main drops a request its schema refuses without an answer; check it here and end the stream.
        const checked = decodeHostToMain(request);
        if (!checked.ok) {
          log.warn('refused an invalid gateway request', { reason: checked.reason.slice(0, 200) });
          yield { type: 'error', error: { code: 'internal', message: 'The model request was invalid and was not sent.' }, afterOutput: false };
          return;
        }
        const queue: GatewayEvent[] = [];
        let wake: (() => void) | null = null;
        let failure: GmiError | null = null;
        let aborted = false;
        let terminal = false;
        const notify = () => {
          const w = wake;
          wake = null;
          w?.();
        };
        streams.set(reqId, {
          push(events) {
            queue.push(...events);
            notify();
          },
          fail(error) {
            failure = error;
            notify();
          },
        });
        const onAbort = () => {
          aborted = true;
          notify();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          send(request);
          for (;;) {
            while (queue.length > 0) {
              const event = queue.shift() as GatewayEvent;
              if (isTerminal(event)) terminal = true;
              yield event;
              if (terminal) return;
            }
            if (aborted) throw cancelled();
            if (failure) throw failure;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
          streams.delete(reqId);
          if (!terminal && req.scope.threadId) rememberClosed(reqId, { threadId: req.scope.threadId, runId: req.scope.runId ?? null });
          // Aborted, or the consumer stopped early: main must abort the upstream fetch.
          if (!terminal && !failure) {
            try {
              send({ t: 'gw.cancel', reqId });
            } catch {
              // The port is gone; main aborts our requests itself (abortOwner).
            }
          }
        }
      },
    },
    rpc: {
      call(method, params, callOpts = {}) {
        const signal = callOpts.signal;
        if (signal?.aborted) return Promise.reject(cancelled());
        const id = newId('rpc', clock.now());
        const timeoutMs = callOpts.timeoutMs ?? (method === 'dialog.confirm' ? LINK_LIMITS.approvalTtlMs : (opts.rpcTimeoutMs ?? LINK_LIMITS.rpcTimeoutMs));
        return new Promise((resolve, reject) => {
          let timer: unknown = null;
          const done = () => {
            rpcs.delete(id);
            if (timer !== null) clock.clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          };
          const onAbort = () => {
            done();
            reject(cancelled());
          };
          rpcs.set(id, {
            resolve: (v) => {
              done();
              resolve(v);
            },
            reject: (e) => {
              done();
              reject(e);
            },
          });
          signal?.addEventListener('abort', onAbort, { once: true });
          timer = clock.setTimeout(() => {
            done();
            reject(new GmiError('timeout', `Main did not answer ${method} in time.`));
          }, timeoutMs);
          try {
            send({ t: 'rpc', id, call: { method, params } as Extract<HostToMain, { t: 'rpc' }>['call'] });
          } catch (error) {
            done();
            reject(error);
          }
        });
      },
    },
    approvals: {
      request(request: ApprovalRequest, signal: AbortSignal) {
        if (signal.aborted) return Promise.reject(cancelled());
        const requestId = request.requestId;
        if (approvals.has(requestId)) return Promise.reject(new GmiError('invalid_input', 'This approval is already pending.'));
        // Review H2: an approval main's schema refuses would be dropped silently (the run would wait forever).
        const checked = decodeHostToMain({ t: 'approval.request', request: { ...request, allowedDecisions: [] } });
        if (!checked.ok) {
          log.warn('refused an invalid approval request', { reason: checked.reason.slice(0, 200) });
          return Promise.resolve<ApprovalDecision>({ kind: 'deny', feedback: 'The approval request could not be shown to the user (invalid request).' });
        }
        return new Promise<ApprovalDecision>((resolve, reject) => {
          const done = () => {
            approvals.delete(requestId);
            signal.removeEventListener('abort', onAbort);
          };
          const onAbort = () => {
            done();
            try {
              send({ t: 'approval.withdrawn', requestId });
            } catch {
              // Main withdraws a dead host's approvals itself.
            }
            reject(cancelled());
          };
          approvals.set(requestId, {
            resolve: (d) => {
              done();
              resolve(d);
            },
            reject: (e) => {
              done();
              reject(e);
            },
          });
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            // Main fills allowedDecisions itself (§9.4); the host's value is never trusted.
            send({ t: 'approval.request', request: { ...request, allowedDecisions: [] } });
          } catch (error) {
            done();
            reject(error);
          }
        });
      },
      pending: () => [...approvals.keys()],
    },
    events: {
      event: (event) => send({ t: 'event', event }),
      threads: (threads) => send({ t: 'threads', threads }),
      runEnded: (threadId, runId) => send({ t: 'run.ended', threadId, runId }),
    },
    handle(msg) {
      switch (msg.t) {
        case 'gw.events': {
          // A restarted host ignores events for requests it does not know (§5.1), except money charged for a request
          // this host cancelled.
          const live = streams.get(msg.reqId);
          if (live) live.push(msg.events);
          else {
            const scope = closed.get(msg.reqId);
            if (scope && lateUsage) {
              for (const ev of msg.events) {
                if (ev.type !== 'usage') continue;
                try {
                  lateUsage({ threadId: scope.threadId, contextRunId: scope.runId }, ev);
                } catch (error) {
                  log.warn('late usage handler failed', { name: (error as Error).name });
                }
              }
            }
          }
          return true;
        }
        case 'rpc.result': {
          const pending = rpcs.get(msg.id);
          if (!pending) return true;
          if (msg.ok) pending.resolve(msg.data);
          else pending.reject(GmiError.fromShape(msg.error as GmiErrorShape));
          return true;
        }
        case 'approval.decision':
          approvals.get(msg.requestId)?.resolve(msg.decision);
          return true;
        default:
          return false;
      }
    },
    failAll(error) {
      for (const s of [...streams.values()]) s.fail(error);
      for (const r of [...rpcs.values()]) r.reject(error);
      for (const a of [...approvals.values()]) a.reject(error);
    },
  };
  return link;
}
