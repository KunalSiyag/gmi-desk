import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayRequest, GwMessage } from '@shared/contracts/gateway';
import { codeForStatus, createHttp } from '@main/core/http';
import { silentLogger } from '@main/core/logger';
import type { KeyProvider } from '@main/core/services';
import { CHAT_COMPLETIONS_URL } from '@main/services/gateway/body-chat';
import { RESPONSES_URL } from '@main/services/gateway/body-responses';
import { ROUTER_URL } from '@main/services/gateway/body-router';
import {
  classifyOpenError,
  createEventBatcher,
  createGatewayCore,
  createRunRegistry,
  httpTransport,
  mapFinishReason,
  pumpGatewayEvents,
  requestShapeProblem,
  type Transport,
  type TransportRequest,
} from '@main/services/gateway/gateway';
import type { StreamPart } from '@main/services/gateway/parsers/common';
import { BREAKER_OPEN_DETAIL, GATEWAY_LIMITS, type ModelCapabilities, type RetryDecision } from '@main/services/gateway/types';
import { createFakeFetch, sseData, sseResponse } from '../helpers/fetch';
import { describeRunRegistryContract } from './contracts';
import { fakeClock, fakeParts, fakeReservations, fakeRetryPolicy } from './fakes';

const GLM = 'zai-org/GLM-5.3';
const KEY = 'eyJhbGciOiJIUzI1NiJ9.secret-test-key-1234';

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

let seq = 0;
function request(over: Partial<GatewayRequest> = {}): GatewayRequest {
  seq += 1;
  return {
    requestId: `req-${seq}`,
    purpose: 'chat',
    priority: 'interactive',
    scope: { threadId: null, turnId: null, runId: null, step: null },
    target: { model: GLM },
    messages: [{ role: 'user', content: 'Hello there' }],
    maxOutputTokens: 1000,
    prefixHash: null,
    ...over,
  };
}
const agentRequest = (over: Partial<GatewayRequest> = {}) =>
  request({ purpose: 'agent', priority: 'foreground', scope: { threadId: 't1', turnId: 'u1', runId: 'r1', step: 1 }, ...over });

async function drain(it: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const types = (events: GatewayEvent[]) => events.map((e) => e.type);
const textOf = (events: GatewayEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');
const last = (events: GatewayEvent[]) => events[events.length - 1]!;

function fakeKeys(key: string | null = KEY) {
  const reported: Array<{ reason: string; key: string | null | undefined; status: number | null | undefined }> = [];
  let requests = 0;
  const keys: KeyProvider = {
    getInferenceKey: async () => key,
    requireInferenceKey: async () => {
      requests += 1;
      if (!key) throw new GmiError('no_api_key', 'Add a GMI inference API key in Settings.');
      return key;
    },
    reportInvalidKey: async (reason, k, status) => {
      reported.push({ reason, key: k, status });
    },
  };
  return { keys, reported, requests: () => requests };
}

type Handler = (t: TransportRequest) => Promise<AsyncIterable<StreamPart>>;

/** A transport that serves `handlers` in order (the last one repeats) and records every request. */
function scripted(handlers: Handler[]): Transport & { sent: TransportRequest[] } {
  const sent: TransportRequest[] = [];
  return {
    sent,
    open(t) {
      sent.push(t);
      const h = handlers[Math.min(sent.length - 1, handlers.length - 1)]!;
      return h(t);
    },
  };
}

const reply =
  (parts: StreamPart[]): Handler =>
  async (t) =>
    (async function* () {
      for (const p of parts) {
        await Promise.resolve();
        t.onChunk();
        if (t.signal.aborted) return;
        yield p;
      }
    })();
const okReply = (text = 'Hi!', usage = { promptTokens: 12, completionTokens: 3 }) =>
  reply([
    { type: 'content', text },
    { type: 'usage', usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens, reasoningTokens: null, cachedTokens: null }, cacheWriteTokens: null },
    { type: 'finish', reason: 'stop' },
  ]);
const httpFail =
  (status: number, message: string, opts: { retryAfterSec?: number; detail?: string } = {}): Handler =>
  async () => {
    throw new GmiError(codeForStatus(status, 'invalid_api_key'), message, { status, retryAfterSec: opts.retryAfterSec ?? null, detail: opts.detail ?? null });
  };
const netFail =
  (code: string): Handler =>
  async () => {
    throw new GmiError('network', 'Could not reach GMI. Check your connection.', { cause: new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) }), detail: 'fetch failed' });
  };
/** Never answers until aborted (then rejects like ctx.http does). */
const hang: Handler = (t) =>
  new Promise((_, reject) => {
    t.signal.addEventListener('abort', () => reject(new GmiError('cancelled', 'The request was cancelled.')), { once: true });
  });

/** A reply the test drives part by part; it ends at end() or when aborted. */
function controlled() {
  const queue: StreamPart[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const handler: Handler = async (t) =>
    (async function* () {
      for (;;) {
        while (queue.length > 0) {
          t.onChunk();
          yield queue.shift()!;
        }
        if (ended || t.signal.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          t.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        wake = null;
      }
    })();
  return {
    handler,
    push(p: StreamPart) {
      queue.push(p);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

function setup(opts: {
  handlers?: Handler[];
  transport?: Transport;
  models?: Record<string, { capabilities?: Partial<ModelCapabilities>; pricing?: null }>;
  decide?: Parameters<typeof fakeRetryPolicy>[0];
  remainingUsd?: number | null;
  key?: string | null;
  needsKey?: boolean;
} = {}) {
  const clock = fakeClock();
  const parts = fakeParts({
    clock,
    remainingUsd: opts.remainingUsd ?? null,
    models: opts.models ?? { [GLM]: {}, 'deepseek-ai/DeepSeek-V4-Flash': {}, 'openai/gpt-5.3-codex': { capabilities: { api: 'responses' } } },
  });
  const retry = fakeRetryPolicy(opts.decide);
  const allParts = { ...parts, retry };
  const transport = opts.transport ?? scripted(opts.handlers ?? [okReply()]);
  const keys = fakeKeys(opts.key === undefined ? KEY : opts.key);
  const learned: Array<{ model: string; caps: Partial<ModelCapabilities> }> = [];
  const gw = createGatewayCore(allParts, {
    keys: keys.keys,
    transport,
    needsKey: opts.needsKey ?? true,
    log: silentLogger,
    learn: (model, caps) => learned.push({ model, caps }),
    refreshModels: async () => undefined,
  });
  return { gw, parts: allParts, clock, transport, keys, learned, retry };
}

// ─── the run registry ─────────────────────────────────────────────────────────────────────────────────────────

describeRunRegistryContract('gateway.ts createRunRegistry', () => createRunRegistry(fakeClock()));

describe('run registry extras', () => {
  it('refuses malformed scopes and a run id reused for another turn; re-opening the same run is a no-op', () => {
    const runs = createRunRegistry(fakeClock());
    expect(() => runs.open({ threadId: '', turnId: 'u', runId: 'r' })).toThrow(GmiError);
    runs.open({ threadId: 't', turnId: 'u', runId: 'r' });
    runs.open({ threadId: 't', turnId: 'u', runId: 'r' });
    expect(runs.list()).toHaveLength(1);
    expect(() => runs.open({ threadId: 't', turnId: 'other', runId: 'r' })).toThrow(/another turn/);
  });
});

// ─── the lifecycle ────────────────────────────────────────────────────────────────────────────────────────────

describe('stream lifecycle', () => {
  it('chat over HTTP: the exact request, events started → text → usage → finish, charge then release', async () => {
    const fake = createFakeFetch([
      {
        match: '/chat/completions',
        respond: () =>
          sseResponse([
            sseData({ model: GLM, choices: [{ index: 0, delta: { content: 'Hel' } }] }),
            sseData({ model: GLM, choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] }),
            sseData({ model: GLM, choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }),
            sseData('[DONE]'),
          ]),
      },
    ]);
    const { gw, parts } = setup({ transport: httpTransport(createHttp({ userAgent: 'GMI-Desk/test', log: silentLogger, fetch: fake.fetch })) });
    const events = await drain(gw.stream(request({ temperature: 0.3 }), new AbortController().signal));

    expect(fake.requests).toHaveLength(1);
    const sent = fake.requests[0]!;
    expect(sent.url).toBe(CHAT_COMPLETIONS_URL);
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers.accept).toBe('text/event-stream');
    expect(sent.body).toBe(
      '{"model":"zai-org/GLM-5.3","messages":[{"role":"user","content":"Hello there"}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":1000,"temperature":0.3,"context_length_exceeded_behavior":"error"}',
    );

    expect(types(events)).toEqual(['started', 'model', 'text', 'text', 'usage', 'finish']);
    expect(events[0]).toEqual({ type: 'started', attempt: 1, model: GLM, api: 'chat' });
    expect(textOf(events)).toBe('Hello');
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { promptTokens: 9, completionTokens: 2 }, estimated: false, maybeBilled: false });
    expect(last(events)).toEqual({ type: 'finish', reason: 'stop', raw: 'stop' });

    expect(parts.meter.charges).toHaveLength(1);
    expect(parts.meter.charges[0]).toMatchObject({ purpose: 'chat', model: GLM, responded: true, maybeBilled: false });
    expect(parts.reservations.count()).toBe(0);
    expect(parts.scheduler.enqueued[0]).toMatchObject({ priority: 'interactive', modelKey: GLM });
    expect(parts.breaker.recorded).toEqual([{ modelKey: GLM, outcome: 'success' }]);
    expect(parts.estimator.commits).toBe(1);
    expect(parts.estimator.observations).toEqual([{ estimated: expect.any(Number), measured: 9 }]);
    expect(parts.connectivity.responses).toBeGreaterThan(0);
    const trace = parts.trace.records[0]!;
    expect(trace).toMatchObject({ status: 'ok', attempts: 1, model: GLM, api: 'chat', promptTokens: 9, code: null });
    expect(JSON.stringify(trace)).not.toContain('Hello there');
    expect(JSON.stringify(trace)).not.toContain(KEY);
    expect(gw.activeCount()).toBe(0);
  });

  it('GMI Router over HTTP: router body, routing events, the routed model metered at its price', async () => {
    const fake = createFakeFetch([
      {
        match: '/autoroute',
        respond: () =>
          sseResponse([
            sseData({ model: 'deepseek-ai/DeepSeek-V4-Flash', choices: [{ index: 0, delta: { content: 'Routed.' }, finish_reason: 'stop' }] }),
            `event: routing_metadata\ndata: ${JSON.stringify({ selected_model: 'deepseek-ai/DeepSeek-V4-Flash', task_type: 'chat' })}\n\n`,
            sseData('[DONE]'),
          ]),
      },
    ]);
    const { gw, parts } = setup({ transport: httpTransport(createHttp({ userAgent: 't', log: silentLogger, fetch: fake.fetch })) });
    const events = await drain(gw.stream(request({ target: { router: 'cost' }, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }] }), new AbortController().signal));
    expect(fake.requests[0]!.url).toBe(ROUTER_URL);
    expect(fake.requests[0]!.body).toBe('{"messages":[{"role":"system","content":"S"},{"role":"user","content":"Q"}],"mode":"cost","stream":true}');
    expect(events.filter((e) => e.type === 'routing').length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ type: 'started', model: null, api: 'router' });
    // No usage chunk from the router: estimated from the text, priced as the routed model.
    expect(parts.meter.charges[0]).toMatchObject({ model: 'deepseek-ai/DeepSeek-V4-Flash', pricing: { inputPerMTok: 1.4 }, responded: true, usage: null });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ estimated: true });
    expect(last(events)).toMatchObject({ type: 'finish', reason: 'stop' });
    expect(parts.scheduler.enqueued[0]!.modelKey).toBe('router:cost');
  });

  it('Responses-only models go to /v1/responses with store:false', async () => {
    const t = scripted([okReply()]);
    const { gw } = setup({ transport: t });
    await drain(gw.stream(request({ target: { model: 'openai/gpt-5.3-codex' } }), new AbortController().signal));
    expect(t.sent[0]).toMatchObject({ api: 'responses', url: RESPONSES_URL });
    expect(JSON.parse(t.sent[0]!.bodyText)).toMatchObject({ model: 'openai/gpt-5.3-codex', store: false, max_output_tokens: 1000 });
  });

  it('tool calls: deltas and complete calls, finish tool_calls; tools are sent only to models that take them', async () => {
    const { gw, transport } = setup({
      handlers: [
        reply([
          { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"path":' },
          { type: 'tool_call_delta', index: 0, id: null, name: null, argumentsDelta: '"a.ts"}' },
          { type: 'tool_call', call: { id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' } },
          { type: 'finish', reason: 'tool_calls' },
        ]),
      ],
    });
    const tools = [{ name: 'read', description: 'Read.', parameters: { type: 'object' } }];
    gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const events = await drain(gw.stream(agentRequest({ tools }), new AbortController().signal, { hostId: 'h1' }));
    expect(events.filter((e) => e.type === 'tool_call_delta')).toHaveLength(2);
    expect(events.find((e) => e.type === 'tool_call')).toEqual({ type: 'tool_call', call: { id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' } });
    expect(last(events)).toEqual({ type: 'finish', reason: 'tool_calls', raw: 'tool_calls' });
    // No usage chunk: the estimate counts the streamed arguments.
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ estimated: true });
    expect((transport as ReturnType<typeof scripted>).sent[0]!.bodyText).toContain('"tools":[');

    const noTools = setup({ models: { 'acme/plain': { capabilities: { tools: false } } } });
    await expect(drain(noTools.gw.stream(request({ target: { model: 'acme/plain' }, tools }), new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('an empty 2xx reply is an upstream error, and its prompt is still charged', async () => {
    const { gw, parts } = setup({ handlers: [reply([])] });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(types(events)).toEqual(['started', 'usage', 'error']);
    expect(last(events)).toMatchObject({ error: { code: 'upstream', message: 'GMI ended the reply without sending anything.' }, afterOutput: false });
    expect(parts.meter.charges[0]).toMatchObject({ responded: true });
  });

  it('a stream that ends cleanly without a finish reason finishes as stop (raw null)', async () => {
    const { gw } = setup({ handlers: [reply([{ type: 'content', text: 'ok' }])] });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(last(events)).toEqual({ type: 'finish', reason: 'stop', raw: null });
  });

  it('maps finish reasons', () => {
    expect([null, 'stop', 'end_turn', 'length', 'max_output_tokens', 'tool_calls', 'function_call', 'content_filter', 'weird'].map(mapFinishReason)).toEqual([
      'stop',
      'stop',
      'stop',
      'length',
      'length',
      'tool_calls',
      'tool_calls',
      'content_filter',
      'other',
    ]);
  });
});

// ─── refused purposes, priorities and scopes (the host port) ──────────────────────────────────────────────────

describe('host-port validation', () => {
  const host = { hostId: 'h1' };

  it('refuses main-only purposes, the interactive priority and unknown or closed runs from a host', async () => {
    const { gw, transport } = setup();
    gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const refused = async (req: GatewayRequest, owner: { hostId: string } | null = host) =>
      expect(drain(gw.stream(req, new AbortController().signal, owner))).rejects.toMatchObject({ code: 'invalid_input' });

    for (const purpose of ['chat', 'probe', 'eval'] as const) await refused(agentRequest({ purpose, priority: 'background' }));
    await refused(agentRequest({ priority: 'interactive' }));
    await refused(agentRequest({ scope: { threadId: 't1', turnId: 'u1', runId: 'unknown', step: 1 } }));
    await refused(agentRequest({ scope: { threadId: 't2', turnId: 'u1', runId: 'r1', step: 1 } }));
    // Main itself may not send agent purposes outside a run either.
    await refused(agentRequest({ scope: { threadId: null, turnId: null, runId: null, step: null } }), null);
    expect((transport as ReturnType<typeof scripted>).sent).toHaveLength(0);

    const ok = await drain(gw.stream(agentRequest(), new AbortController().signal, host));
    expect(last(ok).type).toBe('finish');
    gw.closeRun('r1');
    await refused(agentRequest());
  });

  it('refuses malformed requests (untrusted structured clones) before anything happens', async () => {
    const { gw, transport } = setup();
    const bad: unknown[] = [
      null,
      { ...request(), requestId: '' },
      { ...request(), requestId: 'has spaces' },
      { ...request(), purpose: 'mine' },
      { ...request(), priority: 'urgent' },
      { ...request(), scope: { threadId: 1, turnId: null, runId: null, step: null } },
      { ...request(), target: { model: GLM, router: 'cost' } },
      { ...request(), target: { router: 'fastest' } },
      { ...request(), messages: [] },
      { ...request(), messages: [{ role: 'root', content: 'x' }] },
      { ...request(), messages: [{ role: 'user', content: 5 }] },
      { ...request(), messages: [{ role: 'tool', content: 'x' }] },
      { ...request(), messages: [{ role: 'user', content: 'x', toolCalls: [] }] },
      { ...request(), messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bad name', arguments: '{}' }] }] },
      { ...request(), tools: [{ name: 'read', description: 'r', parameters: {} }, { name: 'read', description: 'r', parameters: {} }] },
      { ...request(), maxOutputTokens: 0 },
      { ...request(), maxOutputTokens: 1.5 },
      { ...request(), temperature: 3 },
      { ...request(), reasoningEffort: 'max' },
      { ...request(), forceBreakerProbe: 'yes' },
    ];
    for (const req of bad) {
      expect(requestShapeProblem(req)).not.toBeNull();
      await expect(drain(gw.stream(req as GatewayRequest, new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(requestShapeProblem(request())).toBeNull();
    // Router for tool loops or compaction (§4.7), even without tools; titles may use it.
    for (const purpose of ['agent', 'subagent', 'compaction'] as const) {
      await expect(drain(gw.stream({ ...agentRequest({ purpose }), target: { router: 'cost' } }, new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(requestShapeProblem({ ...request(), purpose: 'title', target: { router: 'cost' } })).toBeNull();
    // Router with tools; a model that cannot chat; an invalid owner.
    await expect(drain(gw.stream(request({ target: { router: 'cost' }, tools: [{ name: 'read', description: '', parameters: {} }] }), new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(drain(gw.stream(request({ target: { model: 'black-forest-labs/FLUX' } }), new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(drain(gw.stream(request(), new AbortController().signal, { hostId: '' }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect((transport as ReturnType<typeof scripted>).sent).toHaveLength(0);
  });

  it('refuses a request id that is already running', async () => {
    const c = controlled();
    const { gw } = setup({ handlers: [c.handler] });
    const req = request();
    const first = drain(gw.stream(req, new AbortController().signal));
    await waitFor(() => gw.activeCount() === 1);
    await expect(drain(gw.stream({ ...req }, new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
    c.end();
    await first;
  });

  it("main's size caps are context_overflow (an error event), not invalid_input", async () => {
    const { gw, transport } = setup();
    const many: GwMessage[] = Array.from({ length: GATEWAY_LIMITS.maxMessages + 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
    const tooMany = await drain(gw.stream(request({ messages: many }), new AbortController().signal));
    expect(tooMany).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'context_overflow' }), afterOutput: false }]);
    const huge = await drain(gw.stream(request({ messages: [{ role: 'user', content: 'x'.repeat(GATEWAY_LIMITS.maxBodyBytes) }] }), new AbortController().signal));
    expect(huge[0]).toMatchObject({ type: 'error', error: { code: 'context_overflow' } });
    expect((transport as ReturnType<typeof scripted>).sent).toHaveLength(0);
  });
});

// ─── aborts: owner, run, consumer, signal, shutdown ───────────────────────────────────────────────────────────

describe('owner tagging and aborts', () => {
  it('abortOwner() ends every request of that host (fetch aborted, prompt charged, reservations back to 0)', async () => {
    const streams: Array<{ cancelled: boolean }> = [];
    const fake = createFakeFetch([
      {
        match: '/chat/completions',
        respond: () => {
          const state = { cancelled: false };
          streams.push(state);
          const enc = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(sseData({ choices: [{ index: 0, delta: { content: 'partial ' } }] })));
            },
            cancel() {
              state.cancelled = true;
            },
          });
          return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        },
      },
    ]);
    const { gw, parts } = setup({ transport: httpTransport(createHttp({ userAgent: 't', log: silentLogger, fetch: fake.fetch })) });
    gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    gw.openRun({ threadId: 't2', turnId: 'u2', runId: 'r2' });
    const a = drain(gw.stream(agentRequest(), new AbortController().signal, { hostId: 'h1' }));
    const b = drain(gw.stream(agentRequest({ purpose: 'subagent', priority: 'background' }), new AbortController().signal, { hostId: 'h1' }));
    const otherHost = agentRequest({ scope: { threadId: 't2', turnId: 'u2', runId: 'r2', step: 1 } });
    const c = drain(gw.stream(otherHost, new AbortController().signal, { hostId: 'h2' }));
    await waitFor(() => fake.requests.length === 3);
    await waitFor(() => parts.reservations.count() === 3);
    expect(parts.reservations.outstandingUsd()).toBeGreaterThan(0);

    gw.abortOwner('h1');
    for (const events of await Promise.all([a, b])) {
      expect(textOf(events)).toBe('partial ');
      expect(types(events).slice(-2)).toEqual(['usage', 'error']);
      expect(last(events)).toMatchObject({ error: { code: 'cancelled' }, afterOutput: true });
    }
    expect(gw.activeCount()).toBe(1);
    expect(parts.reservations.count()).toBe(1);
    expect(parts.meter.charges.filter((ch) => ch.responded)).toHaveLength(2);
    // Charged to the thread ledger at once.
    expect(parts.threads.spend('t1', 'u1').threadUsd).toBeGreaterThan(0);

    gw.abortOwner('h2');
    await c;
    expect(parts.reservations.count()).toBe(0);
    expect(gw.activeCount()).toBe(0);
    await waitFor(() => streams.every((s) => s.cancelled));
    gw.abortOwner('nobody');
  });

  it('closeRun() aborts the run\'s requests and settles its turn after they settle (one ledger row per model)', async () => {
    const c = controlled();
    const { gw, parts } = setup({ handlers: [c.handler] });
    gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const run = drain(gw.stream(agentRequest(), new AbortController().signal, { hostId: 'h1' }));
    c.push({ type: 'content', text: 'working' });
    await waitFor(() => parts.reservations.count() === 1);
    gw.closeRun('r1');
    const events = await run;
    expect(last(events)).toMatchObject({ error: { code: 'cancelled', message: expect.stringContaining('run') } });
    expect(parts.threads.rows).toEqual([expect.objectContaining({ kind: 'agent', modelId: GLM, ref: 'thr:t1/turn:u1' })]);
  });

  it('a run closed with nothing in flight settles its turn at once', () => {
    const { gw, parts } = setup();
    gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    parts.threads.add({ threadId: 't1', turnId: 'u1', modelId: GLM, usd: 0.01, at: 0 });
    gw.closeRun('r1');
    expect(parts.threads.rows).toHaveLength(1);
  });

  it('a consumer that stops iterating cancels the request, which still settles', async () => {
    const c = controlled();
    const { gw, parts } = setup({ handlers: [c.handler] });
    c.push({ type: 'content', text: 'a' });
    for await (const e of gw.stream(request(), new AbortController().signal)) {
      if (e.type === 'text') break;
    }
    await waitFor(() => gw.activeCount() === 0);
    expect(parts.meter.charges).toHaveLength(1);
    expect(parts.reservations.count()).toBe(0);
    expect(parts.trace.records[0]).toMatchObject({ status: 'cancelled', code: 'cancelled' });
  });

  it('the caller\'s signal cancels a request waiting for budget (it is never sent)', async () => {
    const c = controlled();
    const { gw, parts, transport } = setup({ handlers: [c.handler], remainingUsd: 1 });
    gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    gw.openRun({ threadId: 't2', turnId: 'u2', runId: 'r2' });
    // Each reserves (P × 1.4 + 20,000 × 4.4) / 1e6 × 0.5 ≈ $0.044: two do not fit in $0.08.
    parts.reservations.setRemaining(0.08);
    const first = drain(gw.stream(agentRequest({ maxOutputTokens: 20_000 }), new AbortController().signal, { hostId: 'h' }));
    await waitFor(() => parts.reservations.count() === 1);
    const ac = new AbortController();
    const seen: GatewayEvent[] = [];
    const second = (async () => {
      for await (const e of gw.stream(agentRequest({ maxOutputTokens: 20_000, scope: { threadId: 't2', turnId: 'u2', runId: 'r2', step: 1 } }), ac.signal, { hostId: 'h' })) seen.push(e);
    })();
    await waitFor(() => seen.find((e) => e.type === 'queued'));
    expect(seen[0]).toMatchObject({ type: 'queued', reason: 'budget' });
    ac.abort();
    await second;
    expect(last(seen)).toMatchObject({ type: 'error', error: { code: 'cancelled' } });
    expect((transport as ReturnType<typeof scripted>).sent).toHaveLength(1);
    c.end();
    await first;
  });

  it('shutdown() aborts everything in flight and later requests end cancelled', async () => {
    const c = controlled();
    const { gw } = setup({ handlers: [c.handler] });
    const pending = drain(gw.stream(request(), new AbortController().signal));
    await waitFor(() => gw.activeCount() === 1);
    await gw.shutdown(500);
    expect(last(await pending)).toMatchObject({ error: { code: 'cancelled' } });
    expect(last(await drain(gw.stream(request(), new AbortController().signal)))).toMatchObject({ error: { code: 'cancelled', message: expect.stringContaining('shutting down') } });
  });
});

// ─── failures and the retry policy ────────────────────────────────────────────────────────────────────────────

describe('failures and retries', () => {
  it('a 429 is requeued (not billed, not surfaced) and the next attempt streams', async () => {
    const { gw, parts, retry } = setup({
      handlers: [httpFail(429, 'Too many requests', { retryAfterSec: 3 }), okReply('after wait')],
      decide: (f): RetryDecision => (f.kind === 'http' && f.status === 429 ? { action: 'requeue', delayMs: 0, reason: 'tpm', rateLimited: true, countsForBreaker: false } : { action: 'fail', error: { code: 'upstream', message: 'x' }, maybeBilled: false, countsForBreaker: false, reportInvalidKey: false }),
    });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(textOf(events)).toBe('after wait');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'started').map((e) => (e.type === 'started' ? e.attempt : 0))).toEqual([1, 2]);
    expect(parts.scheduler.rateLimits).toEqual([{ modelKey: GLM, retryAfterSec: 3 }]);
    expect(retry.asked[0]!.failure).toMatchObject({ kind: 'http', status: 429, retryAfterSec: 3 });
    expect(parts.meter.charges).toHaveLength(1);
    expect(parts.breaker.recorded.map((r) => r.outcome)).toEqual(['neutral', 'success']);
  });

  it('a maybe-billed 502 is charged (estimated) before its one retry', async () => {
    const { gw, parts } = setup({
      handlers: [httpFail(502, 'Bad gateway'), okReply('second')],
      decide: (f, ctx): RetryDecision =>
        f.kind === 'http' && f.status === 502 && ctx.maybeBilledRetries === 0
          ? { action: 'retry', delayMs: 0, maybeBilled: true, countsForBreaker: true }
          : { action: 'fail', error: { code: 'upstream', message: 'x' }, maybeBilled: true, countsForBreaker: true, reportInvalidKey: false },
    });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(types(events)).toEqual(['started', 'usage', 'retry', 'started', 'text', 'usage', 'finish']);
    expect(events[1]).toMatchObject({ type: 'usage', estimated: true, maybeBilled: true });
    expect(events[2]).toMatchObject({ type: 'retry', attempt: 1, code: '502' });
    expect(parts.meter.charges.map((c) => [c.responded, c.maybeBilled])).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(parts.breaker.recorded.map((r) => r.outcome)).toEqual(['failure', 'success']);
    expect(parts.trace.records[0]).toMatchObject({ attempts: 2, maybeBilled: true });
  });

  it('a refused key is reported (D15) and never leaks into the error text', async () => {
    const { gw, keys } = setup({
      handlers: [httpFail(401, `Invalid token ${KEY}`)],
      decide: (f): RetryDecision => ({ action: 'fail', error: { code: 'invalid_api_key', message: f.kind === 'http' ? f.message : 'x' }, maybeBilled: false, countsForBreaker: false, reportInvalidKey: true }),
    });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'invalid_api_key' } });
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(keys.reported).toEqual([{ reason: expect.any(String), key: KEY, status: 401 }]);
  });

  it('a 400 context-length error is context_overflow whatever the policy calls it', async () => {
    const { gw } = setup({
      handlers: [httpFail(400, 'Backend request failed with status 400', { detail: JSON.stringify({ error: { message: 'Backend request failed with status 400', details: { error: { message: "This model's maximum context length is 131072 tokens" } } } }) })],
    });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'context_overflow' }, afterOutput: false });
  });

  it('a 400 asking for max_completion_tokens is re-sent at once with it (not billed, learnt)', async () => {
    const t = scripted([httpFail(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), okReply()]);
    const { gw, retry, learned, parts } = setup({ transport: t });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(last(events).type).toBe('finish');
    expect(JSON.parse(t.sent[0]!.bodyText)).toHaveProperty('max_tokens', 1000);
    const second = JSON.parse(t.sent[1]!.bodyText) as Record<string, unknown>;
    expect(second).toHaveProperty('max_completion_tokens', 1000);
    expect(second).not.toHaveProperty('max_tokens');
    expect(retry.asked).toHaveLength(0);
    expect(learned).toEqual([{ model: GLM, caps: { maxTokensField: 'max_completion_tokens' } }]);
    expect(parts.breaker.recorded).toHaveLength(1);
  });

  it('a connect failure is classified not-sent and reported to the connectivity gate', async () => {
    const { gw, parts, retry } = setup({
      handlers: [netFail('ECONNREFUSED'), okReply()],
      decide: (f): RetryDecision => (f.kind === 'network' ? { action: 'offline', countsForBreaker: false } : { action: 'fail', error: { code: 'upstream', message: 'x' }, maybeBilled: false, countsForBreaker: false, reportInvalidKey: false }),
    });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(last(events).type).toBe('finish');
    expect(retry.asked[0]!.failure).toEqual({ kind: 'network', errno: 'ECONNREFUSED', bodySent: false, message: 'fetch failed' });
    expect(parts.connectivity.failures).toEqual(['ECONNREFUSED']);
    expect(parts.meter.charges).toHaveLength(1);
  });

  it('classifies open errors: a reset may have sent the body, an HTTP error keeps GMI\'s nested message and code', () => {
    const reset = new GmiError('network', 'x', { cause: new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) }) });
    expect(classifyOpenError(reset)).toMatchObject({ kind: 'network', errno: 'ECONNRESET', bodySent: true });
    expect(classifyOpenError(new GmiError('network', 'x'))).toMatchObject({ kind: 'network', errno: null, bodySent: true });
    const wrapped = new GmiError('invalid_input', 'Backend request failed with status 400', {
      status: 400,
      detail: JSON.stringify({ error: { message: 'Backend request failed with status 400', details: { error: { message: "Unsupported parameter: 'top_k'", code: 'unsupported_parameter' } } } }),
    });
    expect(classifyOpenError(wrapped)).toEqual({ kind: 'http', status: 400, retryAfterSec: null, code: 'unsupported_parameter', message: "Unsupported parameter: 'top_k'", param: null });
  });

  it('after the first byte there is no retry: a cut stream ends with estimated usage and error {afterOutput}', async () => {
    const cut: Handler = async (t) =>
      (async function* () {
        t.onChunk();
        yield { type: 'content', text: 'half' } as StreamPart;
        throw new TypeError('terminated');
      })();
    const { gw, retry, transport } = setup({
      handlers: [cut, okReply()],
      decide: (): RetryDecision => ({ action: 'requeue', delayMs: 0, reason: 'concurrency', rateLimited: false, countsForBreaker: false }),
    });
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(retry.asked[0]!.failure).toMatchObject({ kind: 'stream', reason: 'cut' });
    expect(types(events)).toEqual(['started', 'text', 'usage', 'error']);
    expect(last(events)).toMatchObject({ error: { code: 'network' }, afterOutput: true });
    expect((transport as ReturnType<typeof scripted>).sent).toHaveLength(1);
  });

  it('an error inside a 2xx stream: usage first, then the error; before output it counts for the breaker', async () => {
    const { gw, parts } = setup({
      handlers: [
        reply([{ type: 'content', text: 'part' }, { type: 'error', error: new GmiError('rate_limited', 'slow down') }]),
        reply([{ type: 'error', error: new GmiError('upstream', 'backend down') }]),
      ],
    });
    const a = await drain(gw.stream(request(), new AbortController().signal));
    expect(types(a)).toEqual(['started', 'text', 'usage', 'error']);
    expect(last(a)).toMatchObject({ error: { code: 'rate_limited' }, afterOutput: true });
    const b = await drain(gw.stream(request(), new AbortController().signal));
    expect(last(b)).toMatchObject({ error: { code: 'upstream' }, afterOutput: false });
    expect(parts.breaker.recorded.map((r) => r.outcome)).toEqual(['success', 'failure']);
  });

  it('no inference key → no_api_key, nothing queued; mock mode needs none', async () => {
    const noKey = setup({ key: null });
    const events = await drain(noKey.gw.stream(request(), new AbortController().signal));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'no_api_key' }), afterOutput: false }]);
    expect(noKey.parts.scheduler.enqueued).toHaveLength(0);
    const mock = setup({ key: null, needsKey: false });
    expect(last(await drain(mock.gw.stream(request(), new AbortController().signal))).type).toBe('finish');
  });

  it('budget: a reached limit refuses before queueing; a reservation that can never fit is refused at admission', async () => {
    const reached = setup();
    reached.parts.reservations = fakeReservations({ remainingUsd: 0 });
    reached.gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    // A fresh core over the replaced part.
    const gw = createGatewayCore(reached.parts, { keys: reached.keys.keys, transport: reached.transport, needsKey: true, log: silentLogger });
    gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const refused = await drain(gw.stream(agentRequest(), new AbortController().signal));
    expect(refused).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'budget_exceeded' }), afterOutput: false }]);

    const small = setup({ remainingUsd: 0.001 });
    small.gw.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const never = await drain(small.gw.stream(agentRequest({ maxOutputTokens: 100_000 }), new AbortController().signal));
    expect(last(never)).toMatchObject({ type: 'error', error: { code: 'budget_exceeded' } });
    expect((small.transport as ReturnType<typeof scripted>).sent).toHaveLength(0);
  });
});

// ─── watchdogs (fake clock) ───────────────────────────────────────────────────────────────────────────────────

describe('watchdogs', () => {
  it('first byte: 90 s + 1 s per 10k prompt tokens, then the policy decides (a timeout)', async () => {
    const { gw, clock, retry } = setup({ handlers: [hang] });
    const seen: GatewayEvent[] = [];
    const done = (async () => {
      for await (const e of gw.stream(request(), new AbortController().signal)) seen.push(e);
    })();
    await waitFor(() => seen.find((e) => e.type === 'started'));
    clock.advance(GATEWAY_LIMITS.watchdog.firstByteBaseMs - 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.some((e) => e.type === 'error')).toBe(false);
    clock.advance(1);
    await done;
    expect(retry.asked[0]!.failure).toEqual({ kind: 'first_byte_timeout' });
    expect(last(seen)).toMatchObject({ type: 'error', error: { code: 'timeout' }, afterOutput: false });
  });

  it('idle after output: estimated usage, then error {afterOutput: true}', async () => {
    const c = controlled();
    const { gw, clock, parts } = setup({ handlers: [c.handler] });
    const seen: GatewayEvent[] = [];
    const done = (async () => {
      for await (const e of gw.stream(request(), new AbortController().signal)) seen.push(e);
    })();
    c.push({ type: 'content', text: 'some' });
    await waitFor(() => seen.find((e) => e.type === 'text'));
    clock.advance(GATEWAY_LIMITS.watchdog.idleMs);
    await done;
    expect(types(seen).slice(-2)).toEqual(['usage', 'error']);
    expect(last(seen)).toMatchObject({ error: { code: 'timeout' }, afterOutput: true });
    expect(parts.meter.charges[0]).toMatchObject({ responded: true, output: { text: 'some' } });
  });
});

// ─── the breaker and "Try anyway" ─────────────────────────────────────────────────────────────────────────────

describe('breaker fast-fail for chat', () => {
  it('fails fast while open (detail breaker_open); forceBreakerProbe sends one probe', async () => {
    const { gw, parts, transport } = setup();
    for (let i = 0; i < GATEWAY_LIMITS.breaker.failures; i++) {
      parts.breaker.tryAcquire(GLM);
      parts.breaker.record(GLM, 'failure');
    }
    expect(parts.breaker.state(GLM)).toBe('open');
    const fast = await drain(gw.stream(request(), new AbortController().signal));
    expect(fast).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'upstream', detail: BREAKER_OPEN_DETAIL }), afterOutput: false }]);
    expect((transport as ReturnType<typeof scripted>).sent).toHaveLength(0);

    const forced = await drain(gw.stream({ ...request(), forceBreakerProbe: true } as GatewayRequest, new AbortController().signal));
    expect(last(forced).type).toBe('finish');
    expect(parts.breaker.state(GLM)).toBe('closed');
  });

  it('a half-open breaker whose probe is taken also fails chat fast (it would otherwise wait in queued(breaker))', async () => {
    const { gw, parts, clock, transport } = setup();
    for (let i = 0; i < GATEWAY_LIMITS.breaker.failures; i++) {
      parts.breaker.tryAcquire(GLM);
      parts.breaker.record(GLM, 'failure');
    }
    clock.advance(GATEWAY_LIMITS.breaker.openMs);
    expect(parts.breaker.tryAcquire(GLM)).toBe(true);
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ detail: BREAKER_OPEN_DETAIL }), afterOutput: false }]);
    expect((transport as ReturnType<typeof scripted>).sent).toHaveLength(0);
    expect(gw.activeCount()).toBe(0);
  });
});

// ─── the rest of GmiGateway ───────────────────────────────────────────────────────────────────────────────────

describe('estimate, caps, spend and status', () => {
  it('estimate() is main\'s own; unknown models are refused', () => {
    const { gw } = setup();
    const e = gw.estimate({ target: { model: GLM }, messages: [{ role: 'user', content: 'x'.repeat(400) }], maxOutputTokens: 1000, scope: { threadId: null, turnId: null, runId: null, step: null } });
    expect(e.promptTokens).toBeGreaterThan(100);
    expect(e.reserveUsd).toBeGreaterThan(0);
    expect(() => gw.estimate({ target: { model: 'nobody/knows' }, messages: [], maxOutputTokens: 1, scope: { threadId: null, turnId: null, runId: null, step: null } })).toThrow(GmiError);
  });

  it('host caps only tighten; approved caps loosen; spend reads the ledger', () => {
    const { gw, parts } = setup();
    gw.setThreadCaps('t1', { perTurnUsd: 0.5, perThreadUsd: 100 });
    expect(parts.threads.caps('t1').perTurnUsd).toBe(0.5);
    gw.setThreadCaps('t1', { perTurnUsd: 5, perThreadUsd: null });
    expect(parts.threads.caps('t1').perTurnUsd).toBe(0.5);
    gw.approveThreadCaps('t1', { perTurnUsd: 5, perThreadUsd: null });
    expect(parts.threads.caps('t1')).toMatchObject({ perTurnUsd: 5, perThreadUsd: null });
    parts.threads.add({ threadId: 't1', turnId: 'u1', modelId: GLM, usd: 0.25, at: 0 });
    expect(gw.threadSpend('t1', 'u1')).toEqual({ turnUsd: 0.25, threadUsd: 0.25 });
    expect(() => gw.setThreadCaps('../x', { perTurnUsd: 1, perThreadUsd: 1 })).toThrow(GmiError);
  });

  it('status() is the tracker\'s snapshot, and lifecycle changes are signalled', async () => {
    const { gw, parts } = setup();
    expect(gw.status()).toBe(parts.status.snapshot());
    await drain(gw.stream(request(), new AbortController().signal));
    expect(parts.status.changes).toBeGreaterThan(1);
  });
});

// ─── gw.events batching ───────────────────────────────────────────────────────────────────────────────────────

describe('gw.events batching', () => {
  it('merges deltas within 16 ms; other events post the batch at once, in order', () => {
    const clock = fakeClock();
    const posted: GatewayEvent[][] = [];
    const b = createEventBatcher((events) => posted.push(events), { clock });
    b.push({ type: 'started', attempt: 1, model: GLM, api: 'chat' });
    expect(posted).toHaveLength(1);
    b.push({ type: 'text', text: 'a' });
    b.push({ type: 'text', text: 'b' });
    b.push({ type: 'reasoning', text: 'r' });
    b.push({ type: 'tool_call_delta', index: 0, id: 'c', name: 'read', argumentsDelta: '{"p' });
    b.push({ type: 'tool_call_delta', index: 0, id: null, name: null, argumentsDelta: '":1}' });
    b.push({ type: 'tool_call_delta', index: 1, id: 'd', name: 'grep', argumentsDelta: '{}' });
    expect(posted).toHaveLength(1);
    clock.advance(GATEWAY_LIMITS.eventBatchMinMs - 1);
    expect(posted).toHaveLength(1);
    clock.advance(1);
    expect(posted[1]).toEqual([
      { type: 'text', text: 'ab' },
      { type: 'reasoning', text: 'r' },
      { type: 'tool_call_delta', index: 0, id: 'c', name: 'read', argumentsDelta: '{"p":1}' },
      { type: 'tool_call_delta', index: 1, id: 'd', name: 'grep', argumentsDelta: '{}' },
    ]);
    b.push({ type: 'text', text: 'x' });
    b.push({ type: 'finish', reason: 'stop', raw: 'stop' });
    expect(posted[2]).toEqual([
      { type: 'text', text: 'x' },
      { type: 'finish', reason: 'stop', raw: 'stop' },
    ]);
    expect(clock.pendingTimers()).toBe(0);
    b.dispose();
    b.push({ type: 'text', text: 'late' });
    expect(posted).toHaveLength(3);
  });

  it('pumpGatewayEvents posts everything of a stream and flushes at the end', async () => {
    const { gw } = setup({ handlers: [okReply('pumped')] });
    const posted: GatewayEvent[][] = [];
    await pumpGatewayEvents(gw.stream(request(), new AbortController().signal), (events) => posted.push(events), { clock: fakeClock() });
    const flat = posted.flat();
    expect(textOf(flat)).toBe('pumped');
    expect(last(flat).type).toBe('finish');
  });
});
