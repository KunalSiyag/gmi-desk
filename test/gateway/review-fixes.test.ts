/**
 * Regression tests for the H1 review findings (.review/h1): money (chat spend counted before its reservation is
 * released, conservative reservations, budget head-of-line, crash-safe thread ledger), flow (bounded offline
 * cycles, chat's 60 s network give-up, the router host never closing the global gate, a cancel during requeue),
 * the breaker's probe ownership, and chat parity (a family that rejects context_length_exceeded_behavior, Max
 * tokens above 32k).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@shared/contracts/chat';
import { GmiError } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayRequest } from '@shared/contracts/gateway';
import type { Budget, BudgetStatus } from '@shared/contracts/usage';
import { silentLogger } from '@main/core/logger';
import type { BudgetGuard, KeyProvider, SpendSource } from '@main/core/services';
import { createChatSlice, type ChatSlice } from '@main/services/chat';
import { createGatewayRuntime } from '@main/services/gateway';
import { createBreaker } from '@main/services/gateway/breaker';
import { createConnectivityGate } from '@main/services/gateway/connectivity';
import { createEstimator } from '@main/services/gateway/estimate';
import { createGatewayCore, createRunRegistry, type Transport, type TransportRequest } from '@main/services/gateway/gateway';
import { createMeter } from '@main/services/gateway/meter';
import { CONTEXT_OVERFLOW_PATTERN, type StreamPart } from '@main/services/gateway/parsers/common';
import { createReservations } from '@main/services/gateway/reservations';
import { createRetryPolicy, isContextOverflow } from '@main/services/gateway/retry';
import { createScheduler } from '@main/services/gateway/scheduler';
import { createStatusTracker } from '@main/services/gateway/status';
import { createThreadLedger, THREAD_LEDGER_FILE } from '@main/services/gateway/threads';
import { createGatewayTrace } from '@main/services/gateway/trace';
import { systemClock, type AdmitResult, type GatewayClock, type SchedulerTicket } from '@main/services/gateway/types';
import { computeBudgetStatus, evaluateBudget } from '@main/services/usage/budget';
import { redactingKeys } from '@main/slices/gateway';
import { createTestContext } from '../helpers/context';
import { createFakeFetch, jsonResponse, sseData, sseResponse, type RecordedRequest } from '../helpers/fetch';
import { chunk, fakeBudget, fakeCatalog, fakeKeys, fastClock, llm, waitForEnd } from '../chat/fakes';
import { fakeClock, fakeResolver } from './fakes';

const MODEL = 'zai-org/GLM-5.3';
const KEY = 'eyJhbGciOiJIUzI1NiJ9.secret-test-key-1234';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

// ─── A real gateway core over a budget that behaves like usage's BudgetGuard ─────────────────────────────────

function budgetHarness(dailyUsd: number) {
  const rows: Array<{ kind: string; usd: number; ref: string | null; at: number }> = [];
  const sources: SpendSource[] = [];
  const b: Budget = { dailyUsd, monthlyUsd: null, confirmAboveUsd: 0, enforce: true };
  const ledger = { totalsSince: (since: Date) => ({ total: rows.filter((r) => r.at >= since.getTime()).reduce((a, r) => a + r.usd, 0) }) };
  const status = () => computeBudgetStatus(b, ledger, new Date(), sources);
  const guard: BudgetGuard = {
    async check(usd, kind) {
      return evaluateBudget(status(), usd, kind);
    },
    async record(entry) {
      rows.push({ kind: entry.kind, usd: entry.usd, ref: entry.ref ?? null, at: Date.now() });
    },
    statusSnapshot: () => status(),
  };
  return { guard, rows, sources, total: () => rows.reduce((a, r) => a + r.usd, 0) + sources.reduce((a, s) => a + s.totalSince(new Date(0)), 0) };
}

async function build(opts: { dailyUsd: number; transport: Transport; clock?: GatewayClock; probe?: () => Promise<boolean>; keys?: KeyProvider }) {
  const clock = opts.clock ?? systemClock;
  const bh = budgetHarness(opts.dailyUsd);
  const dir = await mkdtemp(join(tmpdir(), 'gw-review-'));
  const resolver = fakeResolver({ [MODEL]: { discount: 0 } });
  const threads = createThreadLedger({ dataDir: dir, budget: bh.guard, clock });
  bh.sources.push(threads.source);
  const estimator = createEstimator({ clock });
  const meter = createMeter({ threads, budget: bh.guard, estimator, clock });
  const reservations = createReservations({ budget: bh.guard, threads });
  const breaker = createBreaker({ clock });
  const connectivity = createConnectivityGate({ signals: { isOnline: () => true, onResume: () => () => undefined }, probe: opts.probe ?? (async () => true), clock });
  const scheduler = createScheduler({ clock, breaker, connectivity, reservations, limits: { perThread: {} } });
  const retry = createRetryPolicy({ clock });
  const trace = createGatewayTrace({});
  const status = createStatusTracker({ scheduler, breaker, connectivity, meter, clock });
  const runs = createRunRegistry(clock);
  const parts = { resolver, estimator, meter, reservations, threads, runs, scheduler, retry, breaker, connectivity, trace, status, clock };
  const keys: KeyProvider = opts.keys ?? { getInferenceKey: async () => KEY, requireInferenceKey: async () => KEY, reportInvalidKey: async () => undefined };
  const core = createGatewayCore(parts, { keys, transport: opts.transport, needsKey: true, log: silentLogger });
  cleanups.push(async () => {
    await core.shutdown(200);
    scheduler.dispose();
    connectivity.dispose();
    breaker.dispose();
    await threads.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { core, parts, bh };
}

async function drain(events: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function agentReq(i: number, content: string, maxOut = 4000): GatewayRequest {
  return {
    requestId: `a-${i}`,
    purpose: 'agent',
    priority: 'foreground',
    scope: { threadId: `t${i}`, turnId: 'u1', runId: `r${i}`, step: 1 },
    target: { model: MODEL },
    messages: [{ role: 'user', content }],
    maxOutputTokens: maxOut,
    prefixHash: null,
  };
}

function reply(t: TransportRequest, promptTokens: number, completionTokens: number): AsyncIterable<StreamPart> {
  return (async function* () {
    t.onChunk();
    yield { type: 'content', text: 'x' } as StreamPart;
    yield { type: 'usage', usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens: null, cachedTokens: 0 }, cacheWriteTokens: null } as StreamPart;
    yield { type: 'finish', reason: 'stop' } as StreamPart;
  })();
}

const networkError = (code: string) => new GmiError('network', 'fetch failed', { cause: new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) }) });

// ─── Money ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('money (review findings 1, 2, 3, 6)', () => {
  it('chat spend is in the ledger before its reservation is released: a budget-waiting agent never overshoots', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transport: Transport = {
      async open(t) {
        if (t.req.purpose === 'chat') await gate;
        return reply(t, 10, t.req.purpose === 'chat' ? 30_000 : 4000);
      },
    };
    const h = await build({ dailyUsd: 0.14, transport });
    const chatReq: GatewayRequest = {
      requestId: 'msg-1',
      purpose: 'chat',
      priority: 'interactive',
      scope: { threadId: 'chat1', turnId: null, runId: null, step: null },
      target: { model: MODEL },
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 30_000,
      prefixHash: null,
    };
    // Consumed like the chat slice now does: it records nothing itself when the gateway priced the reply.
    const chatDone = drain(h.core.stream(chatReq, new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.core.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const agentEvents: GatewayEvent[] = [];
    const agentDone = (async () => {
      for await (const e of h.core.stream(agentReq(1, 'hello', 4000), new AbortController().signal)) agentEvents.push(e);
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agentEvents.some((e) => e.type === 'queued' && e.reason === 'budget')).toBe(true);
    release();
    await chatDone;
    await agentDone;
    expect(h.bh.rows.filter((r) => r.kind === 'chat')).toEqual([expect.objectContaining({ ref: 'msg-1' })]);
    expect(agentEvents.at(-1)).toMatchObject({ type: 'error', error: { code: 'budget_exceeded' } });
    expect(h.bh.total()).toBeLessThanOrEqual(0.14 + 1e-9);
  });

  for (const factor of [1, 1.4]) {
    it(`10 parallel cache-miss first requests on fresh threads never exceed the budget (GMI counts ${factor} × the estimate)`, async () => {
      // JSON-like text: ~2.5–3 characters per token upstream, while the display estimate assumes 4.
      const content = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ k: i, v: 'ab"c{}' }))).slice(0, 200_000);
      let estimate = 0;
      const transport: Transport = {
        async open(t) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return reply(t, Math.ceil(estimate * factor), t.resolved.maxOutputTokens);
        },
      };
      const h = await build({ dailyUsd: 0.3, transport });
      const resolved = h.parts.resolver.resolve({ model: MODEL }, 4000)!;
      estimate = h.parts.estimator.estimate({ scope: { threadId: 'x', turnId: null, runId: null, step: null }, resolved, messages: [{ role: 'user', content }], tools: null, purpose: 'agent' }).promptTokens;
      for (let i = 0; i < 10; i++) h.core.openRun({ threadId: `t${i}`, turnId: 'u1', runId: `r${i}` });
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => drain(h.core.stream(agentReq(i, content), new AbortController().signal))));
      expect(results.filter((r) => r.at(-1)?.type === 'finish').length).toBeGreaterThan(0);
      expect(h.bh.total()).toBeLessThanOrEqual(0.3 + 1e-9);
    });
  }

  it('calibration only raises a reservation, and a new thread starts from the model’s calibration', () => {
    const est = createEstimator({ clock: fakeClock() });
    const resolved = { modelKey: MODEL, pricing: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: null, cacheWritePerMTok: null }, discount: 0, maxOutputTokens: 1 };
    const scope = (threadId: string) => ({ threadId, turnId: null, runId: null, step: null });
    const messages = [{ role: 'user' as const, content: 'word '.repeat(4_000) }];
    const before = est.estimate({ scope: scope('a'), resolved, messages, purpose: 'agent' });
    // Prose: GMI counts half the estimate; the display follows, the reservation does not drop.
    for (let i = 0; i < 10; i++) est.observe(scope('a'), MODEL, est.estimate({ scope: scope('a'), resolved, messages, purpose: 'agent' }).promptTokens, before.promptTokens / 2);
    const prose = est.estimate({ scope: scope('a'), resolved, messages, purpose: 'agent' });
    expect(prose.promptTokens).toBeLessThan(before.promptTokens);
    expect(prose.reserveUsd).toBe(before.reserveUsd);
    // Thread b measures 2.4× on the same model: thread c (no measurement of its own) reserves at least that.
    for (let i = 0; i < 10; i++) est.observe(scope('b'), MODEL, est.estimate({ scope: scope('b'), resolved, messages, purpose: 'agent' }).promptTokens, before.promptTokens * 2.4);
    const fresh = est.estimate({ scope: scope('c'), resolved, messages, purpose: 'agent' });
    expect(fresh.promptTokens).toBe(before.promptTokens);
    expect(fresh.reserveUsd!).toBeGreaterThan(before.reserveUsd!);
  });

  it('budget head-of-line: a large request waiting for budget is not overtaken by younger small ones', async () => {
    const clock = fakeClock();
    const status = (): BudgetStatus => ({
      budget: { dailyUsd: 0.1, monthlyUsd: null, confirmAboveUsd: 0, enforce: true },
      spentTodayUsd: 0,
      spentMonthUsd: 0,
      remainingTodayUsd: 0.1,
      remainingMonthUsd: null,
      updatedAt: '',
    });
    const reservations = createReservations({
      budget: { check: async () => ({ allowed: true, needsConfirmation: false, reason: null, remainingTodayUsd: 0.1, remainingMonthUsd: null }), statusSnapshot: status },
      threads: { spend: () => ({ turnUsd: 0, threadUsd: 0 }), caps: () => ({ perTurnUsd: null, perThreadUsd: null, approvedAt: null }) },
    });
    const scheduler = createScheduler({ clock, breaker: createBreaker({ clock }), connectivity: { online: () => true, onChange: () => () => undefined }, reservations, limits: { perThread: {} } });
    cleanups.push(() => scheduler.dispose());
    const ticket = (id: string, usd: number, thread: string): SchedulerTicket => ({
      requestId: id,
      purpose: 'agent',
      priority: 'background',
      threadId: thread,
      modelKey: 'm',
      tpmTokens: 10,
      reserve: (holdUsd) => reservations.tryReserve({ requestId: id, purpose: 'agent', threadId: thread, turnId: null, reserveUsd: usd, holdUsd }),
    });
    const admitted = (r: AdmitResult) => (r as Extract<AdmitResult, { status: 'admitted' }>).slot;
    const s0 = scheduler.enqueue(ticket('s0', 0.03, 'small'));
    await tick();
    const slot0 = admitted(await s0.result);
    const big = scheduler.enqueue(ticket('big', 0.09, 'big'));
    const order: string[] = [];
    void big.result.then((r) => r.status === 'admitted' && order.push('big'));
    const s1 = scheduler.enqueue(ticket('s1', 0.03, 'small'));
    void s1.result.then((r) => r.status === 'admitted' && order.push('s1'));
    await tick();
    // $0.03 would fit next to s0, but the head ($0.09) keeps its amount back.
    expect(order).toEqual([]);
    slot0.release(10);
    await tick();
    await tick();
    expect(order).toEqual(['big']);
    admitted(await big.result).release(10);
    await tick();
    await tick();
    expect(order).toEqual(['big', 's1']);
    admitted(await s1.result).release(10);
  });

  it('a thread whose turn cap is what it waits for holds nothing back from other threads', () => {
    const reservations = createReservations({
      budget: {
        check: async () => ({ allowed: true, needsConfirmation: false, reason: null, remainingTodayUsd: null, remainingMonthUsd: null }),
        statusSnapshot: () => ({ budget: { dailyUsd: 1, monthlyUsd: null, confirmAboveUsd: 0, enforce: true }, spentTodayUsd: 0, spentMonthUsd: 0, remainingTodayUsd: 1, remainingMonthUsd: null, updatedAt: '' }),
      },
      threads: { spend: () => ({ turnUsd: 0, threadUsd: 0 }), caps: (id) => ({ perTurnUsd: id === 'capped' ? 0.1 : null, perThreadUsd: null, approvedAt: null }) },
    });
    const first = reservations.tryReserve({ requestId: 'a', purpose: 'agent', threadId: 'capped', turnId: 'u', reserveUsd: 0.06 });
    expect(first.status).toBe('reserved');
    expect(reservations.tryReserve({ requestId: 'b', purpose: 'agent', threadId: 'capped', turnId: 'u', reserveUsd: 0.06 })).toEqual({ status: 'wait', usd: 0.06, appBudget: false });
    expect(reservations.tryReserve({ requestId: 'c', purpose: 'agent', threadId: 'other', turnId: 'u', reserveUsd: 0.5, holdUsd: 0.4 })).toMatchObject({ status: 'reserved' });
    expect(reservations.tryReserve({ requestId: 'd', purpose: 'agent', threadId: 'other', turnId: 'u', reserveUsd: 0.2, holdUsd: 0.3 })).toEqual({ status: 'wait', usd: 0.2, appBudget: true });
  });

  it('the thread ledger never drops a flushed bucket from its file before the ledger rows are written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-threads-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let releaseRecord!: () => void;
    let gated = false;
    const gate = new Promise<void>((resolve) => (releaseRecord = resolve));
    const recorded: number[] = [];
    const budget = {
      record: async (entry: { usd: number }) => {
        if (gated) await gate;
        recorded.push(entry.usd);
      },
    };
    const ledger = createThreadLedger({ dataDir: dir, budget, clock: fakeClock() });
    await ledger.load();
    const file = async () => JSON.parse(await readFile(join(dir, THREAD_LEDGER_FILE), 'utf8')) as { threads: Record<string, { spentUsd: number; unflushed?: Record<string, unknown> }> };
    ledger.add({ threadId: 't1', turnId: 'u1', modelId: 'm', usd: 0.05, at: 0 });
    await vi.waitFor(async () => expect((await file()).threads.t1?.unflushed?.u1).toBeDefined());
    gated = true;
    // Crosses the flush threshold: the bucket becomes a ledger row (still being written).
    ledger.add({ threadId: 't1', turnId: 'u1', modelId: 'm', usd: 0.06, at: 0 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await file()).threads.t1?.unflushed?.u1).toBeDefined();
    releaseRecord();
    await vi.waitFor(async () => {
      const t1 = (await file()).threads.t1!;
      expect(t1.spentUsd).toBeCloseTo(0.11, 9);
      expect(t1.unflushed?.u1).toBeUndefined();
    });
    expect(recorded).toHaveLength(1);
    await ledger.dispose();
  });
});

// ─── Flow ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('flow (review findings 4, 7, 9) and the breaker (finding 5)', () => {
  it('ECONNREFUSED while the probe answers: the offline cycle ends with `network` after at most 20 cycles', async () => {
    const clock = fakeClock();
    let sent = 0;
    const transport: Transport = {
      async open() {
        sent += 1;
        throw networkError('ECONNREFUSED');
      },
    };
    const h = await build({ dailyUsd: 100, transport, clock });
    h.core.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    let last: GatewayEvent | undefined;
    let ended = false;
    void (async () => {
      for await (const e of h.core.stream(agentReq(1, 'hello', 100), new AbortController().signal)) last = e;
      ended = true;
    })();
    for (let i = 0; i < 400 && !ended; i++) {
      await tick();
      clock.advance(1_000);
      await tick();
    }
    expect(ended).toBe(true);
    expect(sent).toBeLessThanOrEqual(21);
    expect(last).toMatchObject({ type: 'error', error: { code: 'network' } });
  });

  it('a cancel that lands while a request is being requeued ends it at once (no listener is missed)', async () => {
    const clock = fakeClock();
    const ac = new AbortController();
    const transport: Transport = {
      async open() {
        throw new GmiError('rate_limited', 'Slow down', { status: 429, retryAfterSec: 30 });
      },
    };
    const h = await build({ dailyUsd: 100, transport, clock });
    // The abort lands between the failed attempt and the requeued handle's listener (report429 runs in between).
    const report429 = h.parts.scheduler.report429.bind(h.parts.scheduler);
    h.parts.scheduler.report429 = (modelKey, retryAfterSec) => {
      report429(modelKey, retryAfterSec);
      ac.abort();
    };
    h.core.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const events = await Promise.race([drain(h.core.stream(agentReq(1, 'hello', 100), ac.signal)), new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))]);
    expect(events).not.toBeNull();
    expect(events!.at(-1)).toMatchObject({ type: 'error', error: { code: 'cancelled' } });
  });

  it('a refused key is reported with the key removed from GMI’s text', async () => {
    const reported: string[] = [];
    const keys: KeyProvider = { getInferenceKey: async () => KEY, requireInferenceKey: async () => KEY, reportInvalidKey: async (reason) => void reported.push(reason) };
    const transport: Transport = {
      async open() {
        throw new GmiError('invalid_api_key', `Invalid token ${KEY}`, { status: 401 });
      },
    };
    const h = await build({ dailyUsd: 100, transport, keys });
    h.core.openRun({ threadId: 't1', turnId: 'u1', runId: 'r1' });
    const events = await drain(h.core.stream(agentReq(1, 'hello', 100), new AbortController().signal));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'invalid_api_key' } });
    expect(reported).toHaveLength(1);
    expect(reported[0]).not.toContain(KEY);
  });

  it('half-open: only the probe’s own outcome moves the breaker', () => {
    const clock = fakeClock();
    const b = createBreaker({ clock });
    expect(b.tryAcquire('m', { owner: 'old' })).toBe(true);
    for (let i = 0; i < 5; i++) b.record('m', 'failure', `f${i}`);
    expect(b.state('m')).toBe('open');
    clock.advance(30_000);
    expect(b.tryAcquire('m', { owner: 'probe' })).toBe(true);
    // The old request (admitted before the breaker opened) fails now: neutral, and the probe slot stays taken.
    b.record('m', 'failure', 'old');
    expect(b.state('m')).toBe('half_open');
    expect(b.tryAcquire('m', { owner: 'second' })).toBe(false);
    b.record('m', 'success', 'probe');
    expect(b.state('m')).toBe('closed');
    // An old success during half-open does not close it either.
    for (let i = 0; i < 5; i++) b.record('m', 'failure', `g${i}`);
    clock.advance(30_000);
    expect(b.tryAcquire('m', { owner: 'probe2' })).toBe(true);
    b.record('m', 'success', 'old2');
    expect(b.state('m')).toBe('half_open');
    b.record('m', 'failure', 'probe2');
    expect(b.state('m')).toBe('open');
  });
});

// ─── Chat on the real gateway (findings 8, 9, 10) ────────────────────────────────────────────────────────────

async function chatOnReal(respond: (req: RecordedRequest) => Response | Promise<Response>, opts: { idleTimeoutMs?: number; models?: ReturnType<typeof llm>[] } = {}) {
  const fake = createFakeFetch([{ match: () => true, respond }]);
  const t = await createTestContext({ fetch: fake.fetch });
  cleanups.push(() => t.cleanup());
  const { keys } = fakeKeys();
  const { budget, recorded } = fakeBudget();
  const catalog = fakeCatalog(opts.models ?? [llm(MODEL, { featured: true })]);
  const signals = { isOnline: () => true, onResume: () => () => undefined };
  const runtime = await createGatewayRuntime({ ctx: t.ctx, keys: redactingKeys(keys), catalog, budget, signals, tpmLimit: () => 1_000_000, clock: fastClock() });
  cleanups.push(() => runtime.dispose());
  const slice: ChatSlice = await createChatSlice(t.ctx, { gateway: runtime.gateway, catalog, budget, keys }, { flushIntervalMs: 0, idleTimeoutMs: opts.idleTimeoutMs });
  cleanups.unshift(async () => {
    await slice.dispose();
  });
  return { t, slice, requests: fake.requests, recorded };
}

const okStream = () =>
  sseResponse([
    sseData(chunk({ content: 'Hello' })),
    sseData({ id: 'x', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseData({ id: 'x', model: MODEL, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }),
    sseData('[DONE]'),
  ]);

const bodyOf = (r: RecordedRequest) => JSON.parse(r.body ?? 'null') as Record<string, unknown>;

/** GMI's wrapped 400 for a parameter the provider rejects. */
const UNSUPPORTED_CTX_PARAM = {
  error: {
    message: 'Backend request failed with status 400',
    type: 'backend_error',
    code: 400,
    details: { error: { message: 'Unsupported parameter: context_length_exceeded_behavior', type: 'invalid_request_error', param: 'context_length_exceeded_behavior', code: 'unsupported_parameter' } },
  },
};

describe('chat parity on the gateway', () => {
  it('a family that rejects context_length_exceeded_behavior: stripped, re-sent once, remembered (not a context overflow)', async () => {
    const s = await chatOnReal((r) => ('context_length_exceeded_behavior' in bodyOf(r) ? jsonResponse(UNSUPPORTED_CTX_PARAM, 400) : okStream()));
    const thread = await s.slice.api.createThread({ settings: { model: MODEL } });
    const { assistantMessageId } = await s.slice.api.send(thread.id, 'Hi');
    const end = (await waitForEnd(s.t, assistantMessageId)) as { type: string; message: ChatMessage };
    expect(end.type).toBe('done');
    expect(end.message).toMatchObject({ status: 'complete', content: 'Hello' });
    expect(s.requests).toHaveLength(2);
    expect(bodyOf(s.requests[0]!)).toHaveProperty('context_length_exceeded_behavior', 'error');
    expect(bodyOf(s.requests[1]!)).not.toHaveProperty('context_length_exceeded_behavior');
    // The second reply goes out without it at once.
    const again = await s.slice.api.send(thread.id, 'Again');
    await waitForEnd(s.t, again.assistantMessageId);
    expect(s.requests).toHaveLength(3);
    expect(bodyOf(s.requests[2]!)).not.toHaveProperty('context_length_exceeded_behavior');
  });

  it('the parameter’s name alone is never read as a context overflow; a real overflow still is', () => {
    expect(CONTEXT_OVERFLOW_PATTERN.test('Unsupported parameter: context_length_exceeded_behavior')).toBe(false);
    expect(CONTEXT_OVERFLOW_PATTERN.test('context_length_exceeded: the prompt is too long')).toBe(true);
    expect(CONTEXT_OVERFLOW_PATTERN.test("This model's maximum context length is 131072 tokens")).toBe(true);
    const http = (code: string | null, message: string) => ({ kind: 'http' as const, status: 400, retryAfterSec: null, code, message });
    expect(isContextOverflow(http('unsupported_parameter', 'Unsupported parameter: context_length_exceeded_behavior'))).toBe(false);
    expect(isContextOverflow({ ...http('invalid_request_error', 'bad'), param: 'context_length_exceeded_behavior' })).toBe(false);
    expect(isContextOverflow(http('context_length_exceeded', 'too long'))).toBe(true);
  });

  it('Max tokens above 32,768 is sent as set (no unknown-model clamp for chat), so the stored limit is the real one', async () => {
    const s = await chatOnReal(() => okStream());
    const thread = await s.slice.api.createThread({ settings: { model: MODEL, maxTokens: 100_000 } });
    const { assistantMessageId } = await s.slice.api.send(thread.id, 'Hi');
    const end = (await waitForEnd(s.t, assistantMessageId)) as { message: ChatMessage };
    expect(bodyOf(s.requests[0]!)).toMatchObject({ max_tokens: 100_000 });
    expect(end.message.maxTokens).toBe(100_000);
  });

  it('chat while GMI is unreachable (ENOTFOUND): `network` within the 60 s give-up, not chat’s idle timeout', async () => {
    const s = await chatOnReal(
      () => {
        throw networkError('ENOTFOUND');
      },
      { idleTimeoutMs: 20_000 },
    );
    const thread = await s.slice.api.createThread({ settings: { model: MODEL } });
    const started = Date.now();
    const { assistantMessageId } = await s.slice.api.send(thread.id, 'Hi');
    const end = (await waitForEnd(s.t, assistantMessageId)) as { type: string; message: ChatMessage };
    expect(end.type).toBe('error');
    expect(end.message.error).toMatchObject({ code: 'network', message: 'Could not reach GMI. Check your connection.' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it('GMI Router’s host unreachable while the API host answers: a few attempts, then `network`; the gate stays open', async () => {
    const s = await chatOnReal(
      (r) => {
        if (r.url.includes('autoroute')) throw networkError('ENOTFOUND');
        return jsonResponse({ error: 'unauthorized' }, 401);
      },
      { idleTimeoutMs: 20_000, models: [llm(MODEL)] },
    );
    const thread = await s.slice.api.createThread({ settings: { mode: 'auto' } });
    const { assistantMessageId } = await s.slice.api.send(thread.id, 'Hi');
    const end = (await waitForEnd(s.t, assistantMessageId)) as { type: string; message: ChatMessage };
    expect(end.type).toBe('error');
    expect(end.message.error?.code).toBe('network');
    const routerAttempts = s.requests.filter((r) => r.url.includes('autoroute')).length;
    expect(routerAttempts).toBeGreaterThan(1);
    expect(routerAttempts).toBeLessThanOrEqual(4);
    // No connectivity probes: the router host's failure never closed the API host's gate.
    expect(s.requests.filter((r) => r.url.endsWith('/models'))).toHaveLength(0);
  }, 15_000);
});
