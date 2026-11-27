/**
 * The gateway core (harness.md §4.1, §4.2, §4.7; H1-A): GmiGateway.stream() validates a request (shape, sizes,
 * the host port's purpose / priority / run rules), resolves the model, estimates and prechecks it, queues it in the
 * scheduler (which reserves the worst case at admission), sends it (body-*, transport), parses the stream into
 * GatewayEvents, applies the retry policy, and settles every attempt (meter → release → calibration → trace).
 *
 * The money and flow parts (estimator, meter, reservations, thread ledger, scheduler, retry, breaker, connectivity,
 * trace, status) come in as GatewayParts (H1-B); the core owns the request lifecycle, the run registry, owner
 * tagging (`abortOwner`) and `gw.events` batching.
 *
 * Upstream failures never throw: the stream ends with an `error` event (preceded by `usage` whenever GMI may have
 * billed). The iterable throws only GmiError('invalid_input'), on its first next().
 */
import type { RouterMode } from '@shared/contracts/app';
import type { TokenUsage } from '@shared/contracts/chat';
import { GmiError, type GmiErrorShape } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayFinishReason, GatewayPriority, GatewayPurpose, GatewayRequest, GatewayStatus, GwMessage } from '@shared/contracts/gateway';
import type { Http } from '../../core/http';
import type { Logger } from '../../core/logger';
import { credentialRefused, type GmiGateway, type KeyProvider, type ThreadCaps } from '../../core/services';
import { buildChatBody, CHAT_COMPLETIONS_URL, withMaxCompletionTokens } from './body-chat';
import { buildResponsesBody, RESPONSES_URL } from './body-responses';
import { buildRouterBody, ROUTER_URL } from './body-router';
import type { GatewayModelResolver } from './capabilities';
import { ChatCompletionsParser, wantsMaxCompletionTokens } from './parsers/chat';
import { CONTEXT_OVERFLOW_PATTERN, CTX_EXCEEDED_PARAM, midStreamError, readStreamParts, streamErrorFrom, upstreamErrorCode, upstreamErrorParam, type StreamParser, type StreamPart } from './parsers/common';
import { ResponsesParser } from './parsers/responses';
import { isUnsupportedParameter, MAX_NOT_BILLED_REQUEUES, MAX_NOT_BILLED_REQUEUES_INTERACTIVE } from './retry';
import { RouterStreamParser } from './parsers/router';
import {
  AGENT_PURPOSES,
  BREAKER_OPEN_DETAIL,
  GATEWAY_LIMITS,
  HOST_PURPOSES,
  MAIN_PURPOSES,
  MAX_HOST_PRIORITY,
  PRIORITY_RANK,
  type AttemptFailure,
  type BreakerOutcome,
  type GatewayClock,
  type GatewayEstimate,
  type GatewayParts,
  type GatewayTimer,
  type MeteredUsage,
  type ResolvedModel,
  type RetryDecision,
  type RunRegistry,
  type SchedulerHandle,
  type SchedulerSlot,
  type TrackedRun,
} from './types';

// ─── Request validation (the host port, harness.md §4.4) ──────────────────────────────────────────────────────

const PURPOSES: readonly GatewayPurpose[] = ['chat', 'agent', 'subagent', 'compaction', 'title', 'commit_message', 'probe', 'eval'];
const PRIORITIES: readonly GatewayPriority[] = ['interactive', 'foreground', 'background', 'idle'];
const ROLES: readonly GwMessage['role'][] = ['system', 'user', 'assistant', 'tool'];
const ROUTER_MODES: readonly RouterMode[] = ['cost', 'balanced', 'quality'];
const EFFORTS = ['low', 'medium', 'high'] as const;
const ID_PATTERN = /^[\w.:@-]{1,128}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Purposes GMI Router never serves (harness.md §4.7): tool loops and compaction need a known model and window. */
export const ROUTER_REFUSED_PURPOSES = ['agent', 'subagent', 'compaction'] as const satisfies readonly GatewayPurpose[];
/** Largest `maxOutputTokens` a request may ask for (the capability clamp brings it down further). */
export const MAX_REQUEST_OUTPUT_TOKENS = 1_000_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown, max = 256) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
const idOrNull = (v: unknown) => v === null || (typeof v === 'string' && ID_PATTERN.test(v));

function validMessage(m: unknown): string | null {
  if (!isObj(m)) return 'a message is not an object';
  if (!ROLES.includes(m.role as GwMessage['role'])) return 'a message has an unknown role';
  const content = m.content;
  if (typeof content !== 'string') {
    if (!Array.isArray(content) || !content.every((p) => isObj(p) && p.type === 'text' && typeof p.text === 'string')) return 'a message has invalid content';
  }
  if (m.toolCalls !== undefined) {
    if (m.role !== 'assistant' || !Array.isArray(m.toolCalls)) return 'only assistant messages carry tool calls';
    for (const c of m.toolCalls) {
      if (!isObj(c) || typeof c.id !== 'string' || !c.id || c.id.length > 256 || typeof c.name !== 'string' || !TOOL_NAME_PATTERN.test(c.name) || typeof c.arguments !== 'string') {
        return 'a tool call is invalid';
      }
    }
  }
  if (m.role === 'tool' && (typeof m.toolCallId !== 'string' || !m.toolCallId || m.toolCallId.length > 256)) return 'a tool result has no tool call id';
  if (m.toolCallId !== undefined && (m.role !== 'tool' || typeof m.toolCallId !== 'string')) return 'only tool results carry a tool call id';
  if (!optStr(m.name, 128)) return 'a message name is invalid';
  if (m.reasoning !== undefined && m.reasoning !== null) {
    if (!isObj(m.reasoning) || typeof m.reasoning.text !== 'string' || typeof m.reasoning.family !== 'string' || m.reasoning.family.length > 128) return 'a message has invalid reasoning';
  }
  return null;
}

/**
 * Structural checks of a request (it may come from the harness host, i.e. untrusted): returns the problem, or
 * null. Sizes (message count, tool count, body bytes) are not checked here: those are `context_overflow`.
 */
export function requestShapeProblem(req: unknown): string | null {
  if (!isObj(req)) return 'The request must be an object.';
  if (typeof req.requestId !== 'string' || !ID_PATTERN.test(req.requestId)) return 'requestId is invalid.';
  if (!PURPOSES.includes(req.purpose as GatewayPurpose)) return 'purpose is invalid.';
  if (!PRIORITIES.includes(req.priority as GatewayPriority)) return 'priority is invalid.';
  const scope = req.scope;
  if (!isObj(scope) || !idOrNull(scope.threadId) || !idOrNull(scope.turnId) || !idOrNull(scope.runId)) return 'scope is invalid.';
  if (!(scope.step === null || (typeof scope.step === 'number' && Number.isInteger(scope.step) && scope.step >= 0))) return 'scope.step is invalid.';
  const target = req.target;
  if (!isObj(target)) return 'target is invalid.';
  const hasModel = 'model' in target;
  const hasRouter = 'router' in target;
  if (hasModel === hasRouter) return 'target must name either a model or the router.';
  if (hasModel && (typeof target.model !== 'string' || !target.model)) return 'target.model is invalid.';
  if (hasRouter && !ROUTER_MODES.includes(target.router as RouterMode)) return 'target.router is invalid.';
  if (!Array.isArray(req.messages) || req.messages.length === 0) return 'messages must be a non-empty list.';
  for (const m of req.messages) {
    const problem = validMessage(m);
    if (problem) return `Invalid messages: ${problem}.`;
  }
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) return 'tools must be a list.';
    const names = new Set<string>();
    for (const t of req.tools) {
      if (!isObj(t) || typeof t.name !== 'string' || !TOOL_NAME_PATTERN.test(t.name) || typeof t.description !== 'string' || !isObj(t.parameters)) return 'A tool definition is invalid.';
      if (names.has(t.name)) return `Tool ${t.name} is defined twice.`;
      names.add(t.name);
    }
  }
  if (req.toolChoice !== undefined && !['auto', 'none', 'required'].includes(req.toolChoice as string)) return 'toolChoice is invalid.';
  if (req.parallelToolCalls !== undefined && typeof req.parallelToolCalls !== 'boolean') return 'parallelToolCalls is invalid.';
  const maxOut = req.maxOutputTokens;
  if (typeof maxOut !== 'number' || !Number.isInteger(maxOut) || maxOut < 1 || maxOut > MAX_REQUEST_OUTPUT_TOKENS) return 'maxOutputTokens is invalid.';
  if (req.temperature !== undefined && req.temperature !== null) {
    if (typeof req.temperature !== 'number' || !Number.isFinite(req.temperature) || req.temperature < 0 || req.temperature > 2) return 'temperature is invalid.';
  }
  if (req.reasoningEffort !== undefined && req.reasoningEffort !== null && !EFFORTS.includes(req.reasoningEffort as (typeof EFFORTS)[number])) return 'reasoningEffort is invalid.';
  if (!(req.prefixHash === null || (typeof req.prefixHash === 'string' && req.prefixHash.length <= 256))) return 'prefixHash is invalid.';
  if (!optStr(req.cacheKey)) return 'cacheKey is invalid.';
  const force = (req as { forceBreakerProbe?: unknown }).forceBreakerProbe;
  if (force !== undefined && typeof force !== 'boolean') return 'forceBreakerProbe is invalid.';
  return null;
}

// ─── Runs main tracks ─────────────────────────────────────────────────────────────────────────────────────────

/** RunRegistry (types.ts): the §4.4 rules over the runs main opened. */
export function createRunRegistry(clock: Pick<GatewayClock, 'now'>): RunRegistry {
  const runs = new Map<string, TrackedRun>();
  const listeners = new Set<(run: TrackedRun) => void>();
  const refuse = (message: string): GmiErrorShape => ({ code: 'invalid_input', message });
  return {
    open(scope) {
      if (!ID_PATTERN.test(scope.threadId) || !ID_PATTERN.test(scope.turnId) || !ID_PATTERN.test(scope.runId)) throw new GmiError('invalid_input', 'The run scope is invalid.');
      const existing = runs.get(scope.runId);
      if (existing && (existing.threadId !== scope.threadId || existing.turnId !== scope.turnId)) throw new GmiError('invalid_input', 'That run id belongs to another turn.');
      if (!existing) runs.set(scope.runId, { threadId: scope.threadId, turnId: scope.turnId, runId: scope.runId, openedAt: clock.now() });
    },
    close(runId) {
      const run = runs.get(runId) ?? null;
      if (!run) return null;
      runs.delete(runId);
      for (const listener of [...listeners]) {
        try {
          listener(run);
        } catch {
          // A listener's failure must not keep the run open.
        }
      }
      return run;
    },
    get: (runId) => runs.get(runId) ?? null,
    list: () => [...runs.values()],
    validateRequest(req, owner) {
      if (owner) {
        if (!(HOST_PURPOSES as readonly string[]).includes(req.purpose)) return refuse(`Purpose ${req.purpose} is not allowed from the harness.`);
        if (PRIORITY_RANK[req.priority] > PRIORITY_RANK[MAX_HOST_PRIORITY]) return refuse(`Priority ${req.priority} is not allowed from the harness.`);
      }
      if ((MAIN_PURPOSES as readonly string[]).includes(req.purpose)) return owner ? refuse(`Purpose ${req.purpose} is main's own.`) : null;
      const { threadId, turnId, runId } = req.scope;
      const run = runId ? runs.get(runId) : undefined;
      if (!run || run.threadId !== threadId || run.turnId !== turnId) return refuse('The run is not running.');
      return null;
    },
    onClose(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ─── Transport ────────────────────────────────────────────────────────────────────────────────────────────────

export interface TransportRequest {
  api: 'chat' | 'responses' | 'router';
  url: string;
  /** Serialised body (JSON, deterministic key order). */
  bodyText: string;
  req: GatewayRequest;
  resolved: ResolvedModel;
  /** Inference credential; null in mock mode. */
  key: string | null;
  signal: AbortSignal;
  /** Every chunk of body bytes (watchdogs). */
  onChunk(): void;
}

/** Sends one attempt. Resolves when GMI answered 2xx (headers) with the reply's parts; rejects with a GmiError otherwise. */
export interface Transport {
  open(t: TransportRequest): Promise<AsyncIterable<StreamPart>>;
}

export function parserFor(api: TransportRequest['api'], router: { mode: RouterMode | null; recommendationId: string | null }): StreamParser {
  if (api === 'responses') return new ResponsesParser();
  if (api === 'router') return new RouterStreamParser(router);
  return new ChatCompletionsParser();
}

/** Real GMI over ctx.http (no retries there: the gateway's retry policy decides). */
export function httpTransport(http: Http): Transport {
  return {
    async open(t) {
      const res = await http.request(t.url, {
        method: 'POST',
        body: t.bodyText,
        headers: { 'Content-Type': 'application/json', Accept: t.api === 'router' ? 'text/event-stream, application/json' : 'text/event-stream' },
        bearer: t.key,
        timeoutMs: 0,
        signal: t.signal,
        unauthorizedCode: 'invalid_api_key',
      });
      if (t.signal.aborted) {
        void res.body?.cancel().catch(() => undefined);
        throw new GmiError('cancelled', 'The request was cancelled.');
      }
      const parser = parserFor(t.api, { mode: t.resolved.router, recommendationId: res.headers.get('x-recommendation-id') });
      return readStreamParts(res, parser, { signal: t.signal, onChunk: t.onChunk });
    },
  };
}

// ─── Failure classification ───────────────────────────────────────────────────────────────────────────────────

/** errno codes that mean the request never reached GMI (nothing can have been billed). */
const NOT_SENT_ERRNOS: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** The errno of a network failure (undici nests it: GmiError → TypeError('fetch failed') → cause.code). */
export function errnoOf(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^(E[A-Z_]+|UND_ERR_[A-Z_]+|[A-Z_]*CERT[A-Z_]*|UNABLE_TO_[A-Z_]+)$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** An error thrown before 2xx (ctx.http / transport) as the retry policy sees it. */
export function classifyOpenError(error: unknown): AttemptFailure {
  const e = error instanceof GmiError ? error : midStreamError(error);
  if (e.status !== null && e.status >= 300) {
    const inner = e.detail ? streamErrorFrom(e.detail, e.message) : null;
    const message = inner && inner.message !== 'GMI reported an error while generating the reply.' ? inner.message : e.message;
    return {
      kind: 'http',
      status: e.status,
      retryAfterSec: e.retryAfterSec,
      code: upstreamErrorCode(e.detail ?? null),
      message: `${message}`.slice(0, 1000),
      param: upstreamErrorParam(e.detail ?? null),
    };
  }
  const errno = errnoOf(error);
  return { kind: 'network', errno, bodySent: errno === null || !NOT_SENT_ERRNOS.has(errno), message: e.detail ?? e.message };
}

export function mapFinishReason(raw: string | null): GatewayFinishReason {
  switch ((raw ?? '').toLowerCase()) {
    case '':
    case 'stop':
    case 'end_turn':
    case 'eos':
    case 'stop_sequence':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

/** Removes every occurrence of `secret` from an error's text fields. */
export function redactSecret(shape: GmiErrorShape, secret: string | null): GmiErrorShape {
  if (!secret || secret.length < 8) return shape;
  const scrub = (text: string) => text.split(secret).join('[redacted]');
  return { ...shape, message: scrub(shape.message), detail: shape.detail ? scrub(shape.detail) : (shape.detail ?? null) };
}

/** The 400 names `context_length_exceeded_behavior` (message or `param`). */
function rejectsCtxParam(failure: Extract<AttemptFailure, { kind: 'http' }>): boolean {
  return failure.param === CTX_EXCEEDED_PARAM || failure.message.includes(CTX_EXCEEDED_PARAM);
}

function streamFailureError(failure: AttemptFailure): GmiErrorShape {
  if (failure.kind === 'stream') {
    if (failure.reason === 'idle_timeout') return { code: 'timeout', message: `GMI stopped sending the reply (nothing received for ${Math.round(GATEWAY_LIMITS.watchdog.idleMs / 1000)}s).` };
    if (failure.reason === 'total_timeout') return { code: 'timeout', message: 'The reply took longer than the gateway allows for one request.' };
    if (failure.reason === 'parse') return { code: 'upstream', message: failure.message || 'GMI sent a reply the app could not read.' };
    return { code: 'network', message: 'The connection to GMI dropped before the reply finished.', detail: failure.message || null };
  }
  if (failure.kind === 'first_byte_timeout') return { code: 'timeout', message: 'GMI accepted the request but sent nothing back in time.' };
  if (failure.kind === 'network') return { code: 'network', message: 'Could not reach GMI. Check your connection.', detail: failure.message || null };
  return { code: 'upstream', message: failure.message || `GMI returned HTTP ${failure.status}` };
}

// ─── An async channel (events pushed by the driver, pulled by the consumer) ───────────────────────────────────

class EventChannel<T> {
  private buffer: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value, done: false });
    } else this.buffer.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

// ─── The core ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface GatewayCoreDeps {
  keys: KeyProvider;
  transport: Transport;
  /** False in mock mode: no inference credential is needed. */
  needsKey: boolean;
  log: Logger;
  /** The resolver's run-time learning (max_completion_tokens); optional for fakes. */
  learn?: GatewayModelResolver['learn'];
  /** Pricing refresh for unknown / routed models (the resolver's refresh). */
  refreshModels?: (force?: boolean) => Promise<void>;
}

export interface GatewayCore extends GmiGateway {
  /** Requests running now (queued or streaming). */
  activeCount(): number;
  /** Quit: aborts every request (each settles: estimated charge, reservation released) and waits (bounded). */
  shutdown(timeoutMs?: number): Promise<void>;
}

type AbortReason = 'cancelled' | 'owner' | 'run_closed' | 'shutdown';

interface Active {
  requestId: string;
  owner: string | null;
  runId: string | null;
  controller: AbortController;
  reason: AbortReason | null;
  settled: Promise<void>;
}

const ABORT_MESSAGES: Record<AbortReason, string> = {
  cancelled: 'The request was cancelled.',
  owner: 'The agent process stopped; its request was cancelled.',
  run_closed: 'The run was stopped; its request was cancelled.',
  shutdown: 'The app is shutting down.',
};

interface AttemptOutcome {
  kind: 'ok' | 'in_stream_error' | 'failure' | 'aborted';
  responded: boolean;
  afterOutput: boolean;
  usage: TokenUsage | null;
  cacheWriteTokens: number | null;
  finishRaw: string | null;
  sawFinish: boolean;
  routedModel: string | null;
  firstChunkAt: number | null;
  failure: AttemptFailure | null;
  error: GmiError | null;
  /** What streamed in this attempt (for estimated usage when GMI sent none). */
  output: { text: string; reasoning: string; toolArguments: string };
}

export function createGatewayCore(parts: GatewayParts, deps: GatewayCoreDeps): GatewayCore {
  const { clock } = parts;
  const log = deps.log;
  const active = new Map<string, Active>();
  /** Runs closed while requests of theirs were still settling: their turn settles after the last one. */
  const closing = new Map<string, { run: TrackedRun; pending: Set<string> }>();
  let shuttingDown = false;

  const offRunClose = parts.runs.onClose((run) => {
    const pending = new Set<string>();
    for (const a of active.values()) {
      if (a.runId !== run.runId) continue;
      pending.add(a.requestId);
      abort(a, 'run_closed');
    }
    if (pending.size === 0) settleTurn(run);
    else closing.set(run.runId, { run, pending });
  });

  function settleTurn(run: TrackedRun): void {
    try {
      parts.threads.settleTurn(run.threadId, run.turnId);
    } catch (error) {
      log.warn('gateway: settling a turn failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  function abort(a: Active, reason: AbortReason): void {
    a.reason ??= reason;
    a.controller.abort();
  }

  const statusChanged = () => {
    try {
      parts.status.changed();
    } catch {
      // status is advisory
    }
  };

  async function* stream(req: GatewayRequest, signal: AbortSignal, owner: { hostId: string } | null = null): AsyncGenerator<GatewayEvent> {
    const problem = requestShapeProblem(req);
    if (problem) throw new GmiError('invalid_input', problem);
    if (owner !== null && (!isObj(owner) || typeof owner.hostId !== 'string' || !owner.hostId)) throw new GmiError('invalid_input', 'The request owner is invalid.');
    const refusal = parts.runs.validateRequest(req, owner);
    if (refusal) throw new GmiError('invalid_input', refusal.message);
    if (active.has(req.requestId)) throw new GmiError('invalid_input', 'A request with this id is already running.');
    if ('router' in req.target && (req.tools?.length ?? 0) > 0) throw new GmiError('invalid_input', 'GMI Router takes plain chat only: no tools.');
    // §4.7: the router's window and model are unknown, so it never serves tool loops or compaction.
    if ('router' in req.target && (ROUTER_REFUSED_PURPOSES as readonly string[]).includes(req.purpose)) {
      throw new GmiError('invalid_input', `GMI Router cannot serve ${req.purpose} requests.`);
    }
    let resolved = parts.resolver.resolve(req.target, req.maxOutputTokens, { purpose: req.purpose });
    if (!resolved) throw new GmiError('invalid_input', `${'model' in req.target ? req.target.model : 'This model'} is not a model that can chat.`);
    if (resolved.capabilities && !resolved.capabilities.tools && (req.tools?.length ?? 0) > 0) throw new GmiError('invalid_input', `${resolved.model} does not support tools.`);

    const a: Active = { requestId: req.requestId, owner: owner?.hostId ?? null, runId: req.scope.runId, controller: new AbortController(), reason: null, settled: Promise.resolve() };
    active.set(req.requestId, a);
    const channel = new EventChannel<GatewayEvent>();
    const onSignal = () => abort(a, 'cancelled');
    if (signal.aborted) abort(a, 'cancelled');
    else signal.addEventListener('abort', onSignal, { once: true });
    if (shuttingDown) abort(a, 'shutdown');

    // An unpriced model may be one the snapshot does not have yet: reload once (throttled) before estimating.
    if (resolved.api !== 'router' && !resolved.pricing && deps.refreshModels) {
      await deps.refreshModels().catch(() => undefined);
      resolved = parts.resolver.resolve(req.target, req.maxOutputTokens, { purpose: req.purpose }) ?? resolved;
    }

    a.settled = drive(req, resolved, a, channel)
      .catch((error: unknown) => {
        log.error('gateway: request driver crashed', { requestId: req.requestId, error: error instanceof Error ? error.message : String(error) });
        channel.push({ type: 'error', error: { code: 'internal', message: 'The gateway failed while handling this request.' }, afterOutput: false });
      })
      .finally(() => {
        signal.removeEventListener('abort', onSignal);
        active.delete(req.requestId);
        const closingRun = a.runId ? closing.get(a.runId) : undefined;
        if (closingRun) {
          closingRun.pending.delete(req.requestId);
          if (closingRun.pending.size === 0) {
            closing.delete(closingRun.run.runId);
            settleTurn(closingRun.run);
          }
        }
        channel.close();
        statusChanged();
      });

    try {
      for (;;) {
        const next = await channel.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // The consumer stopped early (break / return): the request is cancelled, and still settles.
      abort(a, 'cancelled');
    }
  }

  async function drive(req: GatewayRequest, resolved: ResolvedModel, a: Active, channel: EventChannel<GatewayEvent>): Promise<void> {
    const startedAt = clock.now();
    const emit = (e: GatewayEvent) => channel.push(e);
    const modelKey = resolved.modelKey;
    const scope = req.scope;
    const interactive = req.priority === 'interactive';
    const forceProbe = (req as GatewayRequest & { forceBreakerProbe?: boolean }).forceBreakerProbe === true;

    let attempts = 0;
    let queueMs = 0;
    let ttfbMs: number | null = null;
    let lastUsage: MeteredUsage | null = null;
    let totalCost: number | null = null;
    let maybeBilledAny = false;
    let key: string | null = null;
    let routedModel: string | null = null;

    const trace = (status: 'ok' | 'error' | 'cancelled', code: string | null) => {
      try {
        parts.trace.record({
          requestId: req.requestId,
          purpose: req.purpose,
          priority: req.priority,
          threadId: scope.threadId,
          runId: scope.runId,
          step: scope.step,
          model: routedModel ?? resolved.model,
          api: resolved.api,
          attempts,
          queueMs,
          ttfbMs,
          totalMs: Math.max(0, clock.now() - startedAt),
          promptTokens: lastUsage?.usage.promptTokens ?? null,
          cachedTokens: lastUsage?.usage.cachedTokens ?? null,
          cacheWriteTokens: lastUsage?.cacheWriteTokens ?? null,
          completionTokens: lastUsage?.usage.completionTokens ?? null,
          reasoningTokens: lastUsage?.usage.reasoningTokens ?? null,
          costUsd: totalCost,
          estimated: lastUsage?.estimated ?? false,
          maybeBilled: maybeBilledAny,
          status,
          code,
          prefixHash8: req.prefixHash ? req.prefixHash.slice(0, 8) : null,
          at: new Date(clock.now()).toISOString(),
        });
      } catch {
        // tracing is advisory
      }
    };
    const fail = (error: GmiErrorShape, afterOutput = false) => {
      const shape = redactSecret(error, key);
      emit({ type: 'error', error: shape, afterOutput });
      trace(shape.code === 'cancelled' ? 'cancelled' : 'error', shape.code);
    };
    const cancelled = (afterOutput = false) => fail({ code: 'cancelled', message: ABORT_MESSAGES[a.reason ?? 'cancelled'] }, afterOutput);

    // Body: built once (deterministic), sizes checked before anything is queued (§4.6: context_overflow).
    if (req.messages.length > GATEWAY_LIMITS.maxMessages) {
      return fail({ code: 'context_overflow', message: `The conversation has more than ${GATEWAY_LIMITS.maxMessages} messages; compact it or start a new one.` });
    }
    if ((req.tools?.length ?? 0) > GATEWAY_LIMITS.maxTools) {
      return fail({ code: 'context_overflow', message: `A request may carry at most ${GATEWAY_LIMITS.maxTools} tools.` });
    }
    let body = buildBody(req, resolved);
    let bodyText = JSON.stringify(body);
    if (Buffer.byteLength(bodyText, 'utf8') > GATEWAY_LIMITS.maxBodyBytes) {
      return fail({ code: 'context_overflow', message: 'The request is larger than the gateway sends in one request; compact the conversation or start a new one.' });
    }
    const url = resolved.api === 'router' ? ROUTER_URL : resolved.api === 'responses' ? RESPONSES_URL : CHAT_COMPLETIONS_URL;

    if (deps.needsKey) {
      try {
        key = await deps.keys.requireInferenceKey();
      } catch (error) {
        const e = error instanceof GmiError ? error : new GmiError('no_api_key', 'Add a GMI inference API key in Settings.');
        return fail(e.toShape());
      }
    }
    if (a.controller.signal.aborted) return cancelled();

    const estimate: GatewayEstimate = parts.estimator.estimate({
      scope,
      resolved,
      messages: req.messages,
      tools: req.tools ?? null,
      purpose: req.purpose,
    });

    const precheck = await parts.reservations.precheck({ purpose: req.purpose, threadId: scope.threadId, turnId: scope.turnId });
    if (!precheck.ok) return fail(precheck.error);
    if (a.controller.signal.aborted) return cancelled();

    // Chat fails fast while the model's breaker is open (§4.6); "Try anyway" sets forceBreakerProbe.
    const breakerOpen = (): GmiErrorShape => ({
      code: 'upstream',
      message: 'GMI is failing for this model right now.',
      detail: BREAKER_OPEN_DETAIL,
    });
    if (interactive && !forceProbe && parts.breaker.state(modelKey) === 'open') return fail(breakerOpen());

    let handle: SchedulerHandle = parts.scheduler.enqueue({
      requestId: req.requestId,
      purpose: req.purpose,
      priority: req.priority,
      threadId: scope.threadId,
      modelKey,
      tpmTokens: estimate.tpmTokens,
      forceProbe,
      reserve: (holdUsd) =>
        parts.reservations.tryReserve({
          requestId: req.requestId,
          purpose: req.purpose,
          threadId: scope.threadId,
          turnId: scope.turnId,
          reserveUsd: estimate.reserveUsd,
          holdUsd,
        }),
    });
    statusChanged();

    let maybeBilledRetries = 0;
    let notBilledRequeues = 0;
    let rateLimitedSince: number | null = null;
    let swappedMaxTokens = false;
    let strippedCtxParam = false;
    let committed = false;
    /** Interactive requests: when they first waited for the network (connect failures or the offline gate). */
    let offlineSince: number | null = null;
    const offlineGiveUpMs = GATEWAY_LIMITS.retry.rateLimitGiveUpInteractiveMs;
    const offlineFailure = (): GmiErrorShape => ({ code: 'network', message: 'Could not reach GMI. Check your connection.' });

    for (;;) {
      // ── Wait for admission ──
      const h = handle;
      // A cancel that landed while settle() awaited (requeue): the abort listener below would never fire.
      if (a.controller.signal.aborted) {
        h.cancel();
        return cancelled();
      }
      if (interactive && offlineSince !== null && clock.now() - offlineSince >= offlineGiveUpMs) {
        h.cancel();
        return fail(offlineFailure());
      }
      let breakerFastFail = false;
      let offlineGiveUp = false;
      let offlineTimer: GatewayTimer | null = null;
      const armOfflineTimer = () => {
        if (offlineTimer !== null || offlineSince === null) return;
        offlineTimer = clock.setTimeout(() => {
          offlineGiveUp = true;
          h.cancel();
        }, Math.max(0, offlineSince + offlineGiveUpMs - clock.now()));
      };
      if (interactive) armOfflineTimer();
      const offQueued = handle.onQueued((info) => {
        if (interactive && !forceProbe && info.reason === 'breaker') {
          // Not from inside the scheduler's own notification: cancel right after it.
          if (!breakerFastFail) queueMicrotask(() => h.cancel());
          breakerFastFail = true;
          return;
        }
        // Chat waits for the network at most 60 s (§4.8), then fails with `network`.
        if (interactive && info.reason === 'offline') {
          offlineSince ??= clock.now();
          armOfflineTimer();
        }
        emit({ type: 'queued', position: info.position, etaMs: info.etaMs, reason: info.reason });
      });
      const onAbort = () => h.cancel();
      a.controller.signal.addEventListener('abort', onAbort, { once: true });
      const admitted = await handle.result;
      a.controller.signal.removeEventListener('abort', onAbort);
      offQueued();
      if (offlineTimer !== null) clock.clearTimeout(offlineTimer);
      if (admitted.status === 'cancelled') {
        if (breakerFastFail) return fail(breakerOpen());
        if (offlineGiveUp && !a.controller.signal.aborted) return fail(offlineFailure());
        return cancelled();
      }
      if (admitted.status === 'refused') return fail(admitted.error);
      const slot: SchedulerSlot = admitted.slot;
      queueMs = slot.queuedMs;
      statusChanged();
      if (a.controller.signal.aborted) {
        safeRecord(modelKey, req.requestId, 'neutral');
        slot.release(null);
        return cancelled();
      }

      // ── One attempt (plus the max_completion_tokens re-send inside the same slot) ──
      attempts += 1;
      emit({ type: 'started', attempt: attempts, model: resolved.model, api: resolved.api });
      if (!committed) {
        committed = true;
        parts.estimator.commit(scope, modelKey, estimate.prefix, clock.now());
      }
      if (deps.needsKey) {
        try {
          key = await deps.keys.requireInferenceKey();
        } catch (error) {
          safeRecord(modelKey, req.requestId, 'neutral');
          slot.release(null);
          return fail((error instanceof GmiError ? error : new GmiError('no_api_key', 'Add a GMI inference API key in Settings.')).toShape());
        }
      }
      const sentAt = clock.now();
      let outcome = await attempt(req, resolved, url, bodyText, key, a, emit, estimate.promptTokens);
      // A 400 that rejects one of the gateway's own parameters is not billed: fix the body, remember it for this
      // model, and re-send at once in the same slot (each fix at most once per request).
      for (;;) {
        const f = outcome.kind === 'failure' && outcome.failure?.kind === 'http' && outcome.failure.status === 400 ? outcome.failure : null;
        if (!f) break;
        let fixed: Record<string, unknown> | null = null;
        if (!swappedMaxTokens && wantsMaxCompletionTokens(f.message)) {
          swappedMaxTokens = true;
          fixed = withMaxCompletionTokens(body);
          if (fixed && resolved.model) deps.learn?.(resolved.model, { maxTokensField: 'max_completion_tokens' });
        } else if (!strippedCtxParam && CTX_EXCEEDED_PARAM in body && isUnsupportedParameter(f) && rejectsCtxParam(f)) {
          // §4.2: the family rejects context_length_exceeded_behavior → strip it; the model is then truncationRisk.
          strippedCtxParam = true;
          fixed = { ...body };
          delete fixed[CTX_EXCEEDED_PARAM];
          if (resolved.model) deps.learn?.(resolved.model, { ctxExceededParam: false });
          log.warn('gateway: the model rejects context_length_exceeded_behavior; sent without it', { model: resolved.model });
        }
        if (!fixed) break;
        body = fixed;
        bodyText = JSON.stringify(body);
        parts.connectivity.reportResponse();
        outcome = await attempt(req, resolved, url, bodyText, key, a, emit, estimate.promptTokens);
      }
      if (outcome.firstChunkAt !== null) ttfbMs = outcome.firstChunkAt - sentAt;
      if (outcome.routedModel) routedModel = outcome.routedModel;
      if (outcome.responded) parts.connectivity.reportResponse();

      // Settles the attempt: charge (when billable), breaker outcome, release (in that order, synchronously).
      const settle = async (billable: { maybeBilled: boolean }, breaker: BreakerOutcome, requeue: (() => SchedulerHandle) | null): Promise<MeteredUsage | null> => {
        let metered: MeteredUsage | null = null;
        if (outcome.responded || billable.maybeBilled) {
          const billedModel = routedModel ?? resolved.model;
          let priced = routedModel ? parts.resolver.resolveRouted(routedModel) : { pricing: resolved.pricing, discount: resolved.discount };
          if (routedModel && !priced && deps.refreshModels) {
            await deps.refreshModels().catch(() => undefined);
            priced = parts.resolver.resolveRouted(routedModel);
          }
          metered = parts.meter.charge({
            requestId: req.requestId,
            purpose: req.purpose,
            scope,
            model: billedModel,
            pricing: priced?.pricing ?? null,
            discount: priced?.discount ?? null,
            estimate,
            usage: outcome.usage,
            cacheWriteTokens: outcome.cacheWriteTokens,
            responded: outcome.responded,
            maybeBilled: billable.maybeBilled,
            output: outcome.output,
          });
          if (metered) {
            lastUsage = metered;
            if (metered.costUsd !== null) totalCost = (totalCost ?? 0) + metered.costUsd;
            if (metered.maybeBilled) maybeBilledAny = true;
          }
        }
        safeRecord(modelKey, req.requestId, breaker);
        if (requeue) handle = requeue();
        else slot.release(outcome.usage ? outcome.usage.promptTokens + outcome.usage.completionTokens : null);
        if (outcome.usage && !routedModel) {
          try {
            parts.estimator.observe(scope, modelKey, estimate.promptTokens, outcome.usage.promptTokens);
          } catch {
            // calibration is advisory
          }
        }
        if (metered) emit({ type: 'usage', ...metered });
        statusChanged();
        return metered;
      };

      if (outcome.kind === 'aborted') {
        await settle({ maybeBilled: false }, outcome.responded ? 'success' : 'neutral', null);
        return cancelled(outcome.afterOutput);
      }

      if (outcome.kind === 'ok') {
        if (!outcome.afterOutput && !outcome.sawFinish && !outcome.usage) {
          await settle({ maybeBilled: false }, 'success', null);
          return fail({ code: 'upstream', message: 'GMI ended the reply without sending anything.' });
        }
        await settle({ maybeBilled: false }, 'success', null);
        emit({ type: 'finish', reason: mapFinishReason(outcome.finishRaw), raw: outcome.finishRaw });
        trace('ok', null);
        return;
      }

      if (outcome.kind === 'in_stream_error') {
        const error = outcome.error ?? new GmiError('upstream', 'GMI reported an error while generating the reply.');
        const counts = error.code === 'upstream' && !outcome.afterOutput;
        await settle({ maybeBilled: false }, counts ? 'failure' : 'success', null);
        if (credentialRefused(error)) await reportKey(error.message, key, error.status);
        return fail(error.toShape(), outcome.afterOutput);
      }

      // ── A failed attempt: the retry policy decides ──
      const failure = outcome.failure!;
      // The gate's probe checks the API host: a failure to reach GMI Router's host (console.gmicloud.ai) must not
      // close it, or a router outage would pause every request and cycle for ever.
      const routerHost = resolved.api === 'router';
      if (failure.kind === 'network') {
        if (!routerHost) parts.connectivity.reportNetworkFailure(failure.errno);
      } else if (failure.kind === 'http') parts.connectivity.reportResponse();
      let decision: RetryDecision = parts.retry.decide(failure, {
        purpose: req.purpose,
        priority: req.priority,
        promptTokens: estimate.promptTokens,
        attempt: attempts,
        maybeBilledRetries,
        notBilledRequeues,
        rateLimitedSince,
        afterOutput: outcome.afterOutput,
        now: clock.now(),
      });
      // After the first byte there is never a transparent retry (§4.6).
      if (failure.kind === 'stream' && decision.action !== 'fail') {
        decision = { action: 'fail', error: streamFailureError(failure), maybeBilled: false, countsForBreaker: false, reportInvalidKey: false };
      }
      if (decision.action === 'offline' && routerHost) {
        // Not the gate's host: an ordinary not-billed requeue, bounded by the retry policy's count.
        const max = interactive ? MAX_NOT_BILLED_REQUEUES_INTERACTIVE : MAX_NOT_BILLED_REQUEUES;
        decision =
          notBilledRequeues < max
            ? { action: 'requeue', delayMs: parts.retry.backoffMs(notBilledRequeues), reason: 'offline', rateLimited: false, countsForBreaker: false }
            : { action: 'fail', error: { code: 'network', message: 'Could not reach GMI Router.', detail: failure.kind === 'network' ? failure.errno : null }, maybeBilled: false, countsForBreaker: false, reportInvalidKey: false };
      }
      // Chat: not-billed connect failures are requeued for at most 60 s (§4.8).
      if (interactive && (decision.action === 'offline' || (decision.action === 'requeue' && !decision.rateLimited))) {
        offlineSince ??= clock.now();
        if (clock.now() - offlineSince >= offlineGiveUpMs) decision = { action: 'fail', error: offlineFailure(), maybeBilled: false, countsForBreaker: false, reportInvalidKey: false };
      }

      if (decision.action === 'requeue') {
        if (decision.rateLimited) {
          rateLimitedSince ??= clock.now();
          parts.scheduler.report429(modelKey, failure.kind === 'http' ? failure.retryAfterSec : null);
        } else rateLimitedSince = null;
        notBilledRequeues += 1;
        const { delayMs, reason } = decision;
        await settle({ maybeBilled: false }, 'neutral', () => slot.requeue({ delayMs, reason }));
        continue;
      }
      if (decision.action === 'offline') {
        rateLimitedSince = null;
        // Counted, so the retry policy's bound (MAX_OFFLINE_CYCLES) ends a host that refuses while its probe answers.
        notBilledRequeues += 1;
        await settle({ maybeBilled: false }, 'neutral', () => slot.requeue({ delayMs: 0, reason: 'offline' }));
        continue;
      }
      if (decision.action === 'retry') {
        rateLimitedSince = null;
        maybeBilledRetries += 1;
        const { delayMs } = decision;
        await settle({ maybeBilled: true }, decision.countsForBreaker ? 'failure' : 'neutral', () => slot.requeue({ delayMs, reason: 'concurrency' }));
        emit({ type: 'retry', attempt: attempts, delayMs, code: failureCode(failure) });
        continue;
      }
      // fail
      let error: GmiErrorShape = decision.error;
      if (failure.kind === 'http' && failure.status === 400 && !isUnsupportedParameter(failure) && CONTEXT_OVERFLOW_PATTERN.test(`${failure.code ?? ''} ${failure.message}`)) {
        error = { ...error, code: 'context_overflow' };
      }
      await settle({ maybeBilled: decision.maybeBilled }, decision.countsForBreaker ? 'failure' : 'neutral', null);
      if (decision.reportInvalidKey) await reportKey(error.message, key, failure.kind === 'http' ? failure.status : null);
      return fail(error, outcome.afterOutput);
    }

    // (unreachable)
  }

  async function reportKey(message: string, key: string | null, status: number | null): Promise<void> {
    if (!deps.needsKey) return;
    await deps.keys.reportInvalidKey(redactSecret({ code: 'invalid_api_key', message }, key).message, key, status).catch((e: unknown) => log.warn('gateway: could not report the invalid key', { error: String(e) }));
  }

  function safeRecord(modelKey: string, owner: string, outcome: BreakerOutcome): void {
    try {
      parts.breaker.record(modelKey, outcome, owner);
    } catch {
      // the breaker is advisory
    }
  }

  async function attempt(
    req: GatewayRequest,
    resolved: ResolvedModel,
    url: string,
    bodyText: string,
    key: string | null,
    a: Active,
    emit: (e: GatewayEvent) => void,
    promptTokens: number,
  ): Promise<AttemptOutcome> {
    const out: AttemptOutcome = {
      kind: 'ok',
      responded: false,
      afterOutput: false,
      usage: null,
      cacheWriteTokens: null,
      finishRaw: null,
      sawFinish: false,
      routedModel: null,
      firstChunkAt: null,
      failure: null,
      error: null,
      output: { text: '', reasoning: '', toolArguments: '' },
    };
    const attemptOutput = out.output;
    const w = parts.retry.watchdogs(promptTokens);
    const ac = new AbortController();
    const onOuter = () => ac.abort();
    if (a.controller.signal.aborted) ac.abort();
    else a.controller.signal.addEventListener('abort', onOuter, { once: true });

    let watchdog: 'first_byte' | 'idle' | 'total' | null = null;
    const fire = (kind: 'first_byte' | 'idle' | 'total') => () => {
      if (watchdog || ac.signal.aborted) return;
      watchdog = kind;
      ac.abort();
    };
    let firstByteTimer: GatewayTimer | null = clock.setTimeout(fire('first_byte'), w.firstByteMs);
    let idleTimer: GatewayTimer | null = null;
    const totalTimer = clock.setTimeout(fire('total'), w.totalMs);
    const touch = () => {
      if (firstByteTimer !== null) {
        clock.clearTimeout(firstByteTimer);
        firstByteTimer = null;
        out.firstChunkAt = clock.now();
      }
      if (idleTimer !== null) clock.clearTimeout(idleTimer);
      idleTimer = clock.setTimeout(fire('idle'), w.idleMs);
    };
    const userAborted = () => a.controller.signal.aborted && watchdog === null;
    const watchdogFailure = (): AttemptFailure => {
      if (watchdog === 'idle') return { kind: 'stream', reason: 'idle_timeout', message: 'idle' };
      if (watchdog === 'total' && out.firstChunkAt !== null) return { kind: 'stream', reason: 'total_timeout', message: 'total' };
      return { kind: 'first_byte_timeout' };
    };

    try {
      let parts$: AsyncIterable<StreamPart>;
      try {
        parts$ = await deps.transport.open({ api: resolved.api, url, bodyText, req, resolved, key, signal: ac.signal, onChunk: touch });
      } catch (error) {
        if (userAborted()) return { ...out, kind: 'aborted' };
        if (watchdog) return { ...out, kind: 'failure', failure: watchdogFailure() };
        return { ...out, kind: 'failure', failure: classifyOpenError(error) };
      }
      out.responded = true;
      let streamError: unknown = null;
      let inStream: GmiError | null = null;
      try {
        for await (const part of parts$) {
          if (ac.signal.aborted) break;
          touch();
          switch (part.type) {
            case 'content':
              attemptOutput.text += part.text;
              out.afterOutput = true;
              emit({ type: 'text', text: part.text });
              break;
            case 'reasoning':
              attemptOutput.reasoning += part.text;
              out.afterOutput = true;
              emit({ type: 'reasoning', text: part.text });
              break;
            case 'tool_call_delta':
              attemptOutput.toolArguments += part.argumentsDelta;
              out.afterOutput = true;
              emit({ type: 'tool_call_delta', index: part.index, id: part.id, name: part.name, argumentsDelta: part.argumentsDelta });
              break;
            case 'tool_call':
              out.afterOutput = true;
              emit({ type: 'tool_call', call: part.call });
              break;
            case 'model':
              emit({ type: 'model', model: part.model });
              break;
            case 'routing':
              out.routedModel = part.routing.selectedModel;
              emit({ type: 'routing', routing: part.routing });
              break;
            case 'usage':
              out.usage = part.usage;
              out.cacheWriteTokens = part.cacheWriteTokens;
              break;
            case 'finish':
              out.sawFinish = true;
              out.finishRaw = part.reason;
              break;
            case 'error':
              inStream = part.error;
              break;
          }
          if (inStream) break;
        }
      } catch (error) {
        streamError = error;
      }
      if (userAborted()) return { ...out, kind: 'aborted' };
      if (watchdog) return { ...out, kind: 'failure', failure: watchdogFailure() };
      if (inStream) return { ...out, kind: 'in_stream_error', error: inStream };
      if (streamError) {
        const e = midStreamError(streamError);
        const failure: AttemptFailure =
          e.code === 'upstream' ? { kind: 'stream', reason: 'parse', message: e.message } : { kind: 'stream', reason: 'cut', message: e.detail ?? e.message };
        return { ...out, kind: 'failure', failure };
      }
      return out;
    } finally {
      if (firstByteTimer !== null) clock.clearTimeout(firstByteTimer);
      if (idleTimer !== null) clock.clearTimeout(idleTimer);
      clock.clearTimeout(totalTimer);
      a.controller.signal.removeEventListener('abort', onOuter);
      ac.abort();
    }
  }

  function failureCode(failure: AttemptFailure): string {
    if (failure.kind === 'http') return failure.status === 429 ? 'rate_limited' : String(failure.status);
    if (failure.kind === 'network') return failure.errno ?? 'network';
    if (failure.kind === 'first_byte_timeout') return 'first_byte_timeout';
    return failure.reason;
  }

  return {
    stream,

    estimate(req) {
      if (!isObj(req) || !isObj(req.target) || !Array.isArray(req.messages) || typeof req.maxOutputTokens !== 'number') {
        throw new GmiError('invalid_input', 'Invalid estimate request.');
      }
      const resolved = parts.resolver.resolve(req.target, req.maxOutputTokens);
      if (!resolved) throw new GmiError('invalid_input', 'Unknown model.');
      const e = parts.estimator.estimate({
        scope: req.scope ?? { threadId: null, turnId: null, runId: null, step: null },
        resolved,
        messages: req.messages,
        tools: req.tools ?? null,
        purpose: 'agent',
      });
      return { promptTokens: e.promptTokens, expectedCachedTokens: e.expectedCachedTokens, reserveUsd: e.reserveUsd, expectedUsd: e.expectedUsd };
    },

    status(): GatewayStatus {
      return parts.status.snapshot();
    },

    abortOwner(hostId) {
      for (const a of [...active.values()]) if (a.owner === hostId) abort(a, 'owner');
    },

    openRun(scope) {
      parts.runs.open(scope);
    },

    closeRun(runId) {
      parts.runs.close(runId);
    },

    setThreadCaps(threadId: string, caps: ThreadCaps) {
      if (!ID_PATTERN.test(threadId)) throw new GmiError('invalid_input', 'Invalid thread id.');
      parts.threads.setCaps(threadId, caps);
    },

    approveThreadCaps(threadId: string, caps: ThreadCaps) {
      if (!ID_PATTERN.test(threadId)) throw new GmiError('invalid_input', 'Invalid thread id.');
      parts.threads.approveCaps(threadId, caps);
    },

    threadSpend(threadId, turnId) {
      return parts.threads.spend(threadId, turnId ?? null);
    },

    activeCount: () => active.size,

    async shutdown(timeoutMs = 1_500) {
      shuttingDown = true;
      const all = [...active.values()];
      for (const a of all) abort(a, 'shutdown');
      let timer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        Promise.all(all.map((a) => a.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      offRunClose();
    },
  };
}

function buildBody(req: GatewayRequest, resolved: ResolvedModel): Record<string, unknown> {
  if (resolved.api === 'router') return buildRouterBody(req, resolved.router ?? 'balanced');
  const caps = resolved.capabilities!;
  if (resolved.api === 'responses') return buildResponsesBody(req, { model: resolved.model, maxOutputTokens: resolved.maxOutputTokens, capabilities: caps });
  return buildChatBody(req, { model: resolved.model, maxOutputTokens: resolved.maxOutputTokens, capabilities: caps });
}

/** Purposes whose spend is the thread's (re-exported for callers that only import the core). */
export { AGENT_PURPOSES };

// ─── gw.events batching (harness.md §4.1) ─────────────────────────────────────────────────────────────────────

export interface EventBatcher {
  push(event: GatewayEvent): void;
  /** Posts whatever is pending now. */
  flush(): void;
  dispose(): void;
}

/**
 * Batches one request's events before they are posted to the harness host (`gw.events`): consecutive text,
 * reasoning and same-index tool-call deltas are merged and posted at most `minMs` after the first pending one
 * (16 ms by default, always within GATEWAY_LIMITS.eventBatchMaxMs); any other event posts the batch at once, in order.
 */
export function createEventBatcher(post: (events: GatewayEvent[]) => void, opts: { clock: Pick<GatewayClock, 'setTimeout' | 'clearTimeout'>; minMs?: number }): EventBatcher {
  const delayMs = Math.min(opts.minMs ?? GATEWAY_LIMITS.eventBatchMinMs, GATEWAY_LIMITS.eventBatchMaxMs);
  let pending: GatewayEvent[] = [];
  let timer: GatewayTimer | null = null;
  let disposed = false;

  const flush = () => {
    if (timer !== null) {
      opts.clock.clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    post(batch);
  };

  const merge = (event: GatewayEvent): boolean => {
    const last = pending[pending.length - 1];
    if (!last) return false;
    if ((event.type === 'text' && last.type === 'text') || (event.type === 'reasoning' && last.type === 'reasoning')) {
      pending[pending.length - 1] = { ...last, text: last.text + event.text } as GatewayEvent;
      return true;
    }
    if (event.type === 'tool_call_delta' && last.type === 'tool_call_delta' && last.index === event.index && (event.id === null || event.id === last.id)) {
      pending[pending.length - 1] = { ...last, id: last.id ?? event.id, name: last.name ?? event.name, argumentsDelta: last.argumentsDelta + event.argumentsDelta };
      return true;
    }
    return false;
  };

  return {
    push(event) {
      if (disposed) return;
      const isDelta = event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_call_delta';
      if (!merge(event)) pending.push(event);
      if (!isDelta) return flush();
      timer ??= opts.clock.setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      flush();
      disposed = true;
    },
  };
}

/** Streams `events` through a batcher into `post` (the supervisor's `gw.events` sender); resolves at the end. */
export async function pumpGatewayEvents(events: AsyncIterable<GatewayEvent>, post: (events: GatewayEvent[]) => void, opts: { clock: Pick<GatewayClock, 'setTimeout' | 'clearTimeout'>; minMs?: number }): Promise<void> {
  const batcher = createEventBatcher(post, opts);
  try {
    for await (const event of events) batcher.push(event);
  } finally {
    batcher.dispose();
  }
}
