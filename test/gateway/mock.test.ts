import { afterEach, describe, expect, it } from 'vitest';
import { GATEWAY_TPM_TIERS, type GatewayEvent, type GatewayRequest, type GwMessage } from '@shared/contracts/gateway';
import type { SpendKind } from '@shared/contracts/usage';
import type { BudgetGuard, CatalogService, KeyProvider } from '@main/core/services';
import { createGatewayRuntime } from '@main/services/gateway';
import { mockOpen, mockPricing, pickMockReply, pickMockRoute } from '@main/services/gateway/mock';
import type { StreamPart } from '@main/services/gateway/parsers/common';
import { systemClock } from '@main/services/gateway/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch } from '../helpers/fetch';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const t of contexts.splice(0)) await t.cleanup();
});

let seq = 0;
const request = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({
  requestId: `mock-${++seq}`,
  purpose: 'chat',
  priority: 'interactive',
  scope: { threadId: null, turnId: null, runId: null, step: null },
  target: { model: 'zai-org/GLM-5.3' },
  messages: [{ role: 'user', content: 'Explain prompt caching' }],
  maxOutputTokens: 4096,
  prefixHash: null,
  ...over,
});

async function drain(it: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const textOf = (events: GatewayEvent[], type: 'text' | 'reasoning' = 'text') => events.map((e) => (e.type === type ? e.text : '')).join('');
const usageOf = (events: GatewayEvent[]) => events.find((e): e is Extract<GatewayEvent, { type: 'usage' }> => e.type === 'usage');
const last = (events: GatewayEvent[]) => events[events.length - 1]!;

async function mockRuntime() {
  const fake = createFakeFetch();
  const t = await createTestContext({ mock: true, fetch: fake.fetch });
  contexts.push(t);
  const recorded: Array<{ kind: SpendKind; modelId: string; usd: number; ref?: string | null }> = [];
  const budget: BudgetGuard = {
    check: async () => ({ allowed: true, needsConfirmation: false, reason: null, remainingTodayUsd: null, remainingMonthUsd: null }),
    record: async (entry) => {
      recorded.push(entry);
    },
    statusSnapshot: () => ({
      budget: { dailyUsd: null, monthlyUsd: null, confirmAboveUsd: 0, enforce: true },
      spentTodayUsd: 0,
      spentMonthUsd: 0,
      remainingTodayUsd: null,
      remainingMonthUsd: null,
      updatedAt: new Date(0).toISOString(),
    }),
  };
  let keyReads = 0;
  const keys: KeyProvider = {
    getInferenceKey: async () => {
      keyReads += 1;
      return null;
    },
    requireInferenceKey: async () => {
      keyReads += 1;
      throw new Error('mock mode must not need a key');
    },
    reportInvalidKey: async () => undefined,
  };
  const catalog: CatalogService = { getSnapshot: async () => ({ models: [], updatedAt: null, sources: {}, refreshing: false }), findModel: async () => null };
  const runtime = await createGatewayRuntime(
    {
      ctx: t.ctx,
      keys,
      catalog,
      budget,
      signals: { isOnline: () => true, onResume: () => () => undefined },
      tpmLimit: () => GATEWAY_TPM_TIERS.t1,
      clock: systemClock,
    },
    { mockSpeed: 0 },
  );
  return { runtime, gw: runtime.gateway, fake, recorded, keyReads: () => keyReads, t };
}

describe('the gateway mock serves the chat fixtures (whole pipeline, real money/flow parts)', () => {
  it('a model reply: the canned text, the mock usage rule, priced from the fixture prices; no network, no key', async () => {
    const { runtime, gw, fake, keyReads } = await mockRuntime();
    const prompt = 'Explain prompt caching';
    const events = await drain(gw.stream(request(), new AbortController().signal));
    expect(events[0]).toMatchObject({ type: 'started', model: 'zai-org/GLM-5.3', api: 'chat' });
    expect(textOf(events)).toBe(pickMockReply(prompt).content);
    const usage = usageOf(events)!;
    expect(usage).toMatchObject({ estimated: false, maybeBilled: false });
    expect(usage.usage.promptTokens).toBe(Math.max(8, Math.ceil(prompt.length / 4) + 6));
    const price = mockPricing('zai-org/GLM-5.3')!;
    const expected = ((usage.usage.promptTokens * price.pricing.inputPerMTok! + usage.usage.completionTokens * price.pricing.outputPerMTok!) / 1e6) * (1 - price.discount!);
    expect(usage.costUsd).toBeCloseTo(expected, 12);
    expect(last(events)).toEqual({ type: 'finish', reason: 'stop', raw: 'stop' });
    expect(fake.requests).toHaveLength(0);
    expect(keyReads()).toBe(0);
    expect(runtime.spendSource?.kind).toBe('agent');
    await runtime.dispose();
  });

  it('reasoning models (and an explicit effort) stream the canned reasoning first', async () => {
    const { runtime, gw } = await mockRuntime();
    const prompt = 'Write a python function';
    const reply = pickMockReply(prompt);
    const events = await drain(gw.stream(request({ target: { model: 'deepseek-ai/DeepSeek-V4-Pro' }, messages: [{ role: 'user', content: prompt }] }), new AbortController().signal));
    expect(textOf(events, 'reasoning')).toBe(reply.reasoning);
    expect(textOf(events)).toBe(reply.content);
    const plain = await drain(gw.stream(request({ messages: [{ role: 'user', content: prompt }] }), new AbortController().signal));
    expect(textOf(plain, 'reasoning')).toBe('');
    const effort = await drain(gw.stream(request({ messages: [{ role: 'user', content: prompt }], reasoningEffort: 'high' }), new AbortController().signal));
    expect(textOf(effort, 'reasoning')).toBe(reply.reasoning);
    await runtime.dispose();
  });

  it('GMI Router: routing first, the routed model priced', async () => {
    const { runtime, gw } = await mockRuntime();
    const prompt = 'Write a regex in javascript';
    const events = await drain(gw.stream(request({ target: { router: 'cost' }, messages: [{ role: 'user', content: prompt }] }), new AbortController().signal));
    const routing = events.find((e) => e.type === 'routing');
    const route = pickMockRoute(prompt, 'cost');
    expect(routing).toMatchObject({ routing: { selectedModel: route.selectedModel, taskType: route.taskType, mode: 'cost' } });
    expect(events.findIndex((e) => e.type === 'routing')).toBeLessThan(events.findIndex((e) => e.type === 'text'));
    expect(usageOf(events)!.costUsd).not.toBeNull();
    await runtime.dispose();
  });

  it('"simulate error" fails mid-stream (partial output kept); "simulate overflow" is context_overflow before any byte', async () => {
    const { runtime, gw } = await mockRuntime();
    const failed = await drain(gw.stream(request({ messages: [{ role: 'user', content: 'Please simulate an error' }] }), new AbortController().signal));
    expect(textOf(failed).length).toBeGreaterThan(0);
    expect(failed.slice(-2).map((e) => e.type)).toEqual(['usage', 'error']);
    expect(last(failed)).toMatchObject({ error: { code: 'rate_limited' }, afterOutput: true });

    const overflow = await drain(gw.stream(request({ messages: [{ role: 'user', content: 'simulate overflow' }] }), new AbortController().signal));
    expect(last(overflow)).toMatchObject({ type: 'error', error: { code: 'context_overflow' }, afterOutput: false });
    expect(overflow.some((e) => e.type === 'usage')).toBe(false);
    await runtime.dispose();
  });

  it('agent purposes: a deterministic tool-call script, then a final answer; cached share rises after step 1', async () => {
    const { runtime, gw } = await mockRuntime();
    const tools = ['read', 'grep', 'edit', 'bash', 'list'].map((name) => ({ name, description: name, parameters: { type: 'object' } }));
    gw.openRun({ threadId: 'c0de-t1', turnId: 'u1', runId: 'r1' });
    const messages: GwMessage[] = [{ role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'Fix the failing test' }];
    const names: string[] = [];
    const cached: Array<number | null> = [];
    for (let step = 0; step < 5; step++) {
      const events = await drain(
        gw.stream(
          request({ purpose: 'agent', priority: 'foreground', scope: { threadId: 'c0de-t1', turnId: 'u1', runId: 'r1', step }, messages: structuredClone(messages), tools }),
          new AbortController().signal,
          { hostId: 'h1' },
        ),
      );
      cached.push(usageOf(events)!.usage.cachedTokens);
      const call = events.find((e) => e.type === 'tool_call');
      if (!call || call.type !== 'tool_call') {
        expect(last(events)).toMatchObject({ type: 'finish', reason: 'stop' });
        break;
      }
      expect(last(events)).toMatchObject({ type: 'finish', reason: 'tool_calls' });
      names.push(call.call.name);
      messages.push({ role: 'assistant', content: textOf(events), toolCalls: [call.call] }, { role: 'tool', toolCallId: call.call.id, content: 'ok' });
    }
    expect(names).toEqual(['read', 'grep', 'edit', 'bash']);
    expect(cached[0]).toBeNull();
    expect(cached[1]).toBeGreaterThan(0);
    // Agent spend is the thread's: counted at once, and a ledger row once the turn settles.
    expect(gw.threadSpend('c0de-t1', 'u1').turnUsd).toBeGreaterThan(0);
    gw.closeRun('r1');
    await runtime.dispose();
  });

  it('mockOpen stops at an abort', async () => {
    const ac = new AbortController();
    const parts: StreamPart[] = [];
    const iterable = await mockOpen({ req: request(), resolved: { model: 'zai-org/GLM-5.3', router: null, api: 'chat' }, signal: ac.signal, speed: 0, random: () => 0 });
    for await (const p of iterable) {
      parts.push(p);
      if (parts.length === 3) ac.abort();
    }
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.type === 'content')).toBe(true);
  });
});
