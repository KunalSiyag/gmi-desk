import { afterEach, describe, expect, it } from 'vitest';
import { createChatSlice, type ChatSlice } from '@main/services/chat';
import { buildSeedThreads, MOCK_THREAD_IDS, mockCostUsd } from '@main/services/chat/mock';
import { CONTEXT_FULL_MESSAGE } from '@main/services/chat/service';
import { pickMockRoute } from '@main/services/gateway/mock';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch } from '../helpers/fetch';
import { fakeBudget, fakeCatalog, fakeKeys, streamEvents, waitFor, waitForEnd } from './fakes';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function mockSlice(t?: TestContext, mockSpeed = 0): Promise<{ t: TestContext; slice: ChatSlice; requests: unknown[]; recorded: ReturnType<typeof fakeBudget>['recorded'] }> {
  const fake = createFakeFetch();
  const ctx = t ?? (await createTestContext({ fetch: fake.fetch, mock: true }));
  if (!t) cleanups.push(() => ctx.cleanup());
  const { budget, recorded } = fakeBudget();
  // No key at all: mock mode must not need one.
  const slice = await createChatSlice(ctx.ctx, { keys: fakeKeys(null).keys, catalog: fakeCatalog([]), budget }, { flushIntervalMs: 0, mockSpeed });
  cleanups.unshift(async () => {
    await slice.dispose();
  });
  return { t: ctx, slice, requests: fake.requests, recorded };
}

describe('mock mode', () => {
  it('seeds the demo threads once, with deterministic ids and recent timestamps', async () => {
    const { t, slice } = await mockSlice();
    const list = await slice.api.listThreads();
    expect(list.map((s) => s.id).sort()).toEqual([...MOCK_THREAD_IDS].sort());
    expect(list.length).toBeGreaterThanOrEqual(3);
    // Most recent first; all in the past.
    const times = list.map((s) => Date.parse(s.updatedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(times.every((x) => x <= Date.now())).toBe(true);

    const auto = await slice.api.getThread('5eed0000-0000-4000-8000-000000000002');
    expect(auto.mode).toBe('auto');
    const routed = auto.messages.filter((m) => m.role === 'assistant');
    expect(routed.every((m) => m.routing !== null && m.costUsd !== null && m.usage !== null)).toBe(true);
    expect(routed.map((m) => m.routing?.taskType)).toContain('coding');

    const reasoning = await slice.api.getThread('5eed0000-0000-4000-8000-000000000001');
    expect(reasoning.messages.some((m) => m.reasoning)).toBe(true);
    expect(reasoning.costUsd).toBeGreaterThan(0);

    // Deleting everything must not re-seed on the next start.
    for (const s of list) await slice.api.deleteThread(s.id);
    await slice.dispose();
    const again = await mockSlice(t);
    expect(await again.slice.api.listThreads()).toEqual([]);
  });

  it('streams a canned reply without any network call or key, with routing in Auto mode', async () => {
    const { t, slice, requests, recorded } = await mockSlice();
    const thread = await slice.api.createThread({ settings: { mode: 'auto', routerMode: 'balanced' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Write a Python function that parses SSE');
    const end = await waitForEnd(t, assistantMessageId);
    expect(requests).toHaveLength(0);
    expect(end.type).toBe('done');
    const message = end.type === 'done' ? end.message : null;
    expect(message?.routing).toMatchObject({ selectedModel: 'zai-org/GLM-5.3', taskType: 'coding', mode: 'balanced' });
    expect(message?.model).toBe('zai-org/GLM-5.3');
    expect(message?.content).toContain('```python');
    expect(message?.usage?.completionTokens).toBeGreaterThan(100);
    expect(message?.costUsd).toBeGreaterThan(0);
    expect(recorded).toHaveLength(1);
    expect(streamEvents(t).some((e) => e.type === 'routing')).toBe(true);
  });

  it('streams reasoning for reasoning models and can be stopped', async () => {
    const { t, slice } = await mockSlice(undefined, 1);
    const thread = await slice.api.createThread({ settings: { model: 'deepseek-ai/DeepSeek-V4-Pro' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Tell me something');
    await waitFor(() => streamEvents(t).find((e) => e.type === 'delta' && e.reasoning));
    await slice.api.stop(thread.id);
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'done' ? end.message : null).toMatchObject({ status: 'stopped' });
    expect(end.type === 'done' ? end.message.reasoning : null).toBeTruthy();
  });

  it('can simulate a mid-stream failure', async () => {
    const { t, slice } = await mockSlice();
    const thread = await slice.api.createThread({ settings: { model: 'zai-org/GLM-5.3' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Please simulate an error');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type).toBe('error');
    expect(end.type === 'error' ? end.message : null).toMatchObject({ status: 'error', error: { code: 'rate_limited' } });
    expect(end.type === 'error' ? end.message.content.length : 0).toBeGreaterThan(0);
  });

  it('can simulate a context overflow: the reply fails before any output with "Start a new chat"', async () => {
    const { t, slice, recorded } = await mockSlice();
    const thread = await slice.api.createThread({ settings: { model: 'zai-org/GLM-5.3' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Please simulate overflow');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'error' ? end.message : null).toMatchObject({ status: 'error', content: '', usage: null, error: { code: 'context_overflow', message: CONTEXT_FULL_MESSAGE } });
    expect(recorded).toEqual([]);
  });

  it('builds seeds relative to the given time and prices them from the mock table', () => {
    const now = new Date('2026-10-31T15:00:00');
    const seeds = buildSeedThreads(now);
    expect(seeds[0]?.updatedAt && Date.parse(seeds[0].updatedAt)).toBeLessThan(now.getTime());
    const yesterday = seeds.find((s) => s.id === '5eed0000-0000-4000-8000-000000000003');
    expect(new Date(yesterday?.updatedAt ?? '').getDate()).toBe(30);
    expect(mockCostUsd('zai-org/GLM-5.3', { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 0, reasoningTokens: null, cachedTokens: null })).toBeCloseTo(1.12, 6);
    expect(mockCostUsd('unknown/model', { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: null, cachedTokens: null })).toBeNull();
    expect(pickMockRoute('draft a tweet', 'cost').taskType).toBe('creative_writing');
  });
});
