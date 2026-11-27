/**
 * Chat on the GMI gateway (harness.md §4.8): the request chat sends, how gateway events map to the unchanged
 * ChatStreamEvents, and the deliberate behaviour changes (context_overflow UX, breaker fast fail with "Try anyway",
 * 429 requeue, maybe-billed failures never retried for chat).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/contracts/chat';
import type { GatewayEvent } from '@shared/contracts/gateway';
import type { GmiGateway } from '@main/core/services';
import { createChatSlice, type ChatSlice } from '@main/services/chat';
import { BREAKER_OPEN_MESSAGE, chatGatewayRequest, CONTEXT_FULL_MESSAGE } from '@main/services/chat/service';
import { createGatewayRuntime } from '@main/services/gateway';
import { BREAKER_OPEN_DETAIL, type GatewayClock } from '@main/services/gateway/types';
import { redactingKeys } from '@main/slices/gateway';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch, jsonResponse, sseData, sseResponse, type RecordedRequest } from '../helpers/fetch';
import { replyEvents, scriptedGateway, usageEvent, type ScriptedGateway } from '../gateway/fakes';
import { chunk, fakeBudget, fakeCatalog, fakeKeys, fastClock, llm, streamEvents, waitForEnd } from './fakes';

const GLM = 'zai-org/GLM-5.3';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const okStream = (text = 'Hello there') =>
  sseResponse([
    sseData(chunk({ content: text })),
    sseData({ id: 'x', model: GLM, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseData({ id: 'x', model: GLM, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 } }),
    sseData('[DONE]'),
  ]);

const finalMessage = (end: { type: string; message?: ChatMessage }) => end.message ?? null;

/** Chat on a scripted fake gateway. */
async function onFake(gw: ScriptedGateway = scriptedGateway()) {
  const t = await createTestContext();
  cleanups.push(() => t.cleanup());
  const { budget, recorded } = fakeBudget();
  const slice = await createChatSlice(t.ctx, { gateway: gw, catalog: fakeCatalog([llm(GLM, { featured: true })]), budget, keys: fakeKeys().keys }, { flushIntervalMs: 0 });
  cleanups.unshift(async () => {
    await slice.dispose();
  });
  return { t, slice, gw, recorded };
}

/** Chat on the real gateway over a fake fetch. */
async function onReal(respond: (req: RecordedRequest) => Response | Promise<Response>, clock: GatewayClock = fastClock()) {
  const fake = createFakeFetch([{ match: () => true, respond }]);
  const t = await createTestContext({ fetch: fake.fetch });
  cleanups.push(() => t.cleanup());
  const { keys, reported } = fakeKeys();
  const { budget, recorded } = fakeBudget();
  const catalog = fakeCatalog([llm(GLM, { featured: true })]);
  const signals = { isOnline: () => true, onResume: () => () => undefined };
  const runtime = await createGatewayRuntime({ ctx: t.ctx, keys: redactingKeys(keys), catalog, budget, signals, tpmLimit: () => 1_000_000, clock });
  cleanups.push(() => runtime.dispose());
  const slice: ChatSlice = await createChatSlice(t.ctx, { gateway: runtime.gateway, catalog, budget, keys }, { flushIntervalMs: 0 });
  cleanups.unshift(async () => {
    await slice.dispose();
  });
  return { t, slice, requests: fake.requests, recorded, reported, gateway: runtime.gateway as GmiGateway };
}

async function sendAndWait(s: { t: TestContext; slice: ChatSlice }, threadId: string, text = 'Hi') {
  const { assistantMessageId } = await s.slice.api.send(threadId, text);
  return { id: assistantMessageId, end: await waitForEnd(s.t, assistantMessageId) };
}

describe('the request chat sends through the gateway', () => {
  it('purpose chat, priority interactive, scoped to the thread, the assistant message id as request id', async () => {
    const s = await onFake();
    const thread = await s.slice.api.createThread({ settings: { systemPrompt: 'Be brief.', temperature: 0.4, reasoningEffort: 'low', maxTokens: 2048 } });
    const { id } = await sendAndWait(s, thread.id, 'Question');
    const sent = s.gw.requests[0]!;
    expect(sent.owner).toBeNull();
    expect(sent.req).toEqual({
      requestId: id,
      purpose: 'chat',
      priority: 'interactive',
      scope: { threadId: thread.id, turnId: null, runId: null, step: null },
      target: { model: GLM },
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Question' },
      ],
      maxOutputTokens: 2048,
      temperature: 0.4,
      reasoningEffort: 'low',
      prefixHash: null,
    });
  });

  it('Auto mode targets GMI Router without sampling options; history skips failed replies', async () => {
    const s = await onFake();
    s.gw.script.push([{ type: 'error', error: { code: 'upstream', message: 'boom' }, afterOutput: false }]);
    const thread = await s.slice.api.createThread({ settings: { mode: 'auto', routerMode: 'cost', temperature: 0.9 } });
    await sendAndWait(s, thread.id, 'First');
    await sendAndWait(s, thread.id, 'Second');
    const req = s.gw.requests[1]!.req;
    expect(req.target).toEqual({ router: 'cost' });
    expect(req.temperature).toBeNull();
    expect(req.reasoningEffort).toBeNull();
    expect(req.messages).toEqual([
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Second' },
    ]);
  });

  it('chatGatewayRequest sets forceBreakerProbe only when asked', () => {
    const plan = { route: 'chat' as const, model: GLM, settings: { mode: 'model' as const, model: GLM, routerMode: 'balanced' as const, maxTokens: 100, temperature: null, reasoningEffort: null, systemPrompt: null }, history: [{ role: 'user' as const, content: 'x' }] };
    expect('forceBreakerProbe' in chatGatewayRequest('r', 't', plan)).toBe(false);
    expect(chatGatewayRequest('r', 't', plan, true).forceBreakerProbe).toBe(true);
  });
});

describe('gateway events → chat stream events', () => {
  it('text, model, usage and finish map to deltas and the stored reply; the gateway price is the cost', async () => {
    const s = await onFake();
    s.gw.script.push([
      { type: 'queued', position: 1, etaMs: 500, reason: 'tpm' },
      { type: 'started', attempt: 1, model: GLM, api: 'chat' },
      { type: 'reasoning', text: 'Thinking. ' },
      { type: 'text', text: 'Hello ' },
      { type: 'model', model: GLM },
      { type: 'text', text: 'world' },
      usageEvent({ promptTokens: 10, completionTokens: 5 }, { costUsd: 0.0042 }),
      { type: 'finish', reason: 'length', raw: 'length' },
    ]);
    const thread = await s.slice.api.createThread();
    const { id, end } = await sendAndWait(s, thread.id);
    expect(end.type).toBe('done');
    expect(finalMessage(end)).toMatchObject({ content: 'Hello world', reasoning: 'Thinking. ', model: GLM, finishReason: 'length', costUsd: 0.0042, status: 'complete' });
    expect(finalMessage(end)?.usageEstimated).toBeUndefined();
    // The gateway priced it, so its meter wrote the ledger row (the scripted fake records nothing); chat adds none.
    expect(s.recorded).toEqual([]);
    expect(streamEvents(s.t).filter((e) => e.messageId === id).map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
  });

  it('an estimated usage event marks the reply as estimated; billed attempts add up', async () => {
    const s = await onFake();
    s.gw.script.push([
      usageEvent({ promptTokens: 500, completionTokens: 0 }, { costUsd: 0.001, estimated: true, maybeBilled: true }),
      { type: 'text', text: 'ok' },
      usageEvent({ promptTokens: 500, completionTokens: 1 }, { costUsd: 0.002, estimated: true }),
      { type: 'finish', reason: 'stop', raw: 'stop' },
    ]);
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(finalMessage(end)).toMatchObject({ usageEstimated: true, costUsd: 0.003, usage: { promptTokens: 500, completionTokens: 1 } });
  });

  it('a gateway that reports no price falls back to the catalog price', async () => {
    const s = await onFake();
    s.gw.script.push([{ type: 'text', text: 'ok' }, usageEvent({ promptTokens: 1000, completionTokens: 2000 }, { costUsd: null }), { type: 'finish', reason: 'stop', raw: 'stop' }]);
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    // (1000 × 1.4 + 2000 × 4.4) / 1M × (1 − 0.5)
    expect(finalMessage(end)?.costUsd).toBeCloseTo(0.0051, 9);
  });

  it('a gateway that shuts down under a reply (quit) leaves it stopped, not failed', async () => {
    const s = await onFake();
    s.gw.script.push([{ type: 'text', text: 'Partial' }, { type: 'error', error: { code: 'cancelled', message: 'The app is shutting down.' }, afterOutput: true }]);
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(end.type).toBe('done');
    expect(finalMessage(end)).toMatchObject({ status: 'stopped', content: 'Partial', error: null });
  });

  it('a request the gateway refuses outright (invalid_input) fails the reply', async () => {
    const gw = scriptedGateway();
    const refusing: GmiGateway = {
      ...gw,
      async *stream(): AsyncGenerator<GatewayEvent> {
        throw new Error('not a model that can chat');
      },
    };
    const s = await onFake(refusing as ScriptedGateway);
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(end.type).toBe('error');
    expect(finalMessage(end)?.status).toBe('error');
  });
});

describe('context overflow (behaviour change 1)', () => {
  it('a 400 "maximum context length" shows context_overflow with "Start a new chat", costs nothing and is not retried', async () => {
    const s = await onReal(() => jsonResponse({ error: { message: "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens." } }, 400));
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(end.type).toBe('error');
    expect(finalMessage(end)).toMatchObject({
      status: 'error',
      usage: null,
      error: { code: 'context_overflow', message: CONTEXT_FULL_MESSAGE, detail: expect.stringContaining('maximum context length') },
    });
    expect(s.requests).toHaveLength(1);
    expect(JSON.parse(s.requests[0]!.body ?? '{}')).toMatchObject({ context_length_exceeded_behavior: 'error' });
    expect(s.recorded).toEqual([]);
  });

  it('an overflow reported inside the stream keeps the partial text and shows the same notice', async () => {
    const s = await onReal(() =>
      sseResponse([sseData(chunk({ content: 'Part' })), sseData({ error: { message: 'context_length_exceeded: the prompt is too long', type: 'invalid_request_error', code: 400 } })]),
    );
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(finalMessage(end)).toMatchObject({ status: 'error', content: 'Part', error: { code: 'context_overflow', message: CONTEXT_FULL_MESSAGE } });
  });
});

describe('scheduler and retries (behaviour changes 2 and 3)', () => {
  it('a 429 is requeued and the reply then goes through', async () => {
    let n = 0;
    const s = await onReal(() => (n++ === 0 ? jsonResponse({ error: { message: 'Slow down' } }, 429) : okStream('After the wait')));
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(end.type).toBe('done');
    expect(finalMessage(end)).toMatchObject({ status: 'complete', content: 'After the wait' });
    expect(s.requests).toHaveLength(2);
    expect(s.recorded).toHaveLength(1);
  });

  it('continuous 429s end with rate_limited after the interactive give-up time, nothing charged', async () => {
    const s = await onReal(() => jsonResponse({ error: { message: 'Slow down' } }, 429));
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(finalMessage(end)).toMatchObject({ status: 'error', usage: null, error: { code: 'rate_limited' } });
    expect(s.requests.length).toBeGreaterThan(1);
    expect(s.recorded).toEqual([]);
  });

  it('a maybe-billed failure (502) is never retried for chat and its estimated prompt charge is recorded', async () => {
    const s = await onReal(() => jsonResponse({ error: { message: 'Bad gateway' } }, 502));
    const thread = await s.slice.api.createThread();
    const { id, end } = await sendAndWait(s, thread.id);
    expect(finalMessage(end)).toMatchObject({ status: 'error', usageEstimated: true, error: { code: 'upstream' } });
    expect(finalMessage(end)?.usage?.completionTokens).toBe(0);
    expect(s.requests).toHaveLength(1);
    expect(s.recorded).toEqual([{ kind: 'chat', modelId: GLM, usd: finalMessage(end)?.costUsd, ref: id }]);
  });
});

describe('circuit breaker: fast fail and "Try anyway"', () => {
  it('after 5 server errors chat fails fast without a request; Retry on that reply forces the probe', async () => {
    let failing = true;
    // 10× clock: the breaker's 60 s failure window and 30 s open time are 6 s and 3 s real, so a loaded machine still
    // lands 5 failures in the window and the fast fail before the half-open probe (1000× made them 60 ms and 30 ms).
    const s = await onReal(() => (failing ? jsonResponse({ error: { message: 'Internal error' } }, 500) : okStream('Back again')), fastClock(10));
    const thread = await s.slice.api.createThread();
    for (let i = 0; i < 5; i++) {
      const { end } = await sendAndWait(s, thread.id, `Try ${i}`);
      expect(finalMessage(end)?.error?.code).toBe('upstream');
    }
    expect(s.requests).toHaveLength(5);
    expect(s.gateway.status().models.find((m) => m.model === GLM)?.breaker).toBe('open');

    const fast = await sendAndWait(s, thread.id, 'Again');
    expect(finalMessage(fast.end)).toMatchObject({ status: 'error', error: { code: 'upstream', detail: BREAKER_OPEN_DETAIL, message: BREAKER_OPEN_MESSAGE } });
    expect(s.requests).toHaveLength(5);

    failing = false;
    const { assistantMessageId } = await s.slice.api.regenerate(thread.id);
    const forced = await waitForEnd(s.t, assistantMessageId);
    expect(finalMessage(forced)).toMatchObject({ status: 'complete', content: 'Back again' });
    expect(s.requests).toHaveLength(6);
  });

  it('only a breaker fast fail makes Retry force the probe', async () => {
    const s = await onFake();
    s.gw.script.push(
      [{ type: 'error', error: { code: 'upstream', message: 'GMI is failing for this model right now.', detail: BREAKER_OPEN_DETAIL }, afterOutput: false }],
      replyEvents('ok'),
      [{ type: 'error', error: { code: 'upstream', message: 'boom' }, afterOutput: false }],
    );
    const thread = await s.slice.api.createThread();
    const first = await sendAndWait(s, thread.id);
    expect(finalMessage(first.end)?.error).toMatchObject({ detail: BREAKER_OPEN_DETAIL, message: BREAKER_OPEN_MESSAGE });
    await waitForEnd(s.t, (await s.slice.api.regenerate(thread.id)).assistantMessageId);
    expect((s.gw.requests[1]!.req as { forceBreakerProbe?: boolean }).forceBreakerProbe).toBe(true);

    await sendAndWait(s, thread.id, 'Next');
    await waitForEnd(s.t, (await s.slice.api.regenerate(thread.id)).assistantMessageId);
    expect(s.gw.requests.map((r) => (r.req as { forceBreakerProbe?: boolean }).forceBreakerProbe ?? false)).toEqual([false, true, false, false]);
  });
});

describe('composition', () => {
  it('without a gateway the slice needs keys to compose its own', async () => {
    const t = await createTestContext();
    cleanups.push(() => t.cleanup());
    await expect(createChatSlice(t.ctx, { catalog: fakeCatalog(), budget: fakeBudget().budget })).rejects.toThrow(/gateway/);
  });

  it('a key GMI echoes in an error is redacted before it is reported', async () => {
    const s = await onReal(() => jsonResponse({ error: { message: 'Invalid API key sk-test-1234 for this org' } }, 401));
    const thread = await s.slice.api.createThread();
    const { end } = await sendAndWait(s, thread.id);
    expect(finalMessage(end)?.error).toMatchObject({ code: 'invalid_api_key', message: 'Invalid API key [redacted] for this org' });
    expect(s.reported).toEqual(['Invalid API key [redacted] for this org']);
  });
});
