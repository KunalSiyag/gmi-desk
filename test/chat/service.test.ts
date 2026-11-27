import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatStreamEvent } from '@shared/contracts/chat';
import type { BudgetGuard, GmiGateway } from '@main/core/services';
import { createChatSlice, type ChatSlice } from '@main/services/chat';
import { createGatewayRuntime } from '@main/services/gateway';
import type { GatewayClock } from '@main/services/gateway/types';
import { estimateTokens } from '@main/services/chat/cost';
import { guessApi, historyFor, titleFromMessage } from '@main/services/chat/service';
import { normalizeThreadRecord } from '@main/services/chat/store';
import { createBudgetService } from '@main/services/usage/budget';
import { openSpendLedger } from '@main/services/usage/ledger';
import { createTestContext, type TestContext } from '../helpers/context';
import { createFakeFetch, jsonResponse, sseData, sseResponse, type RecordedRequest } from '../helpers/fetch';
import { chunk, controllableSse, fakeBudget, fakeCatalog, fakeKeys, fastClock, llm, streamEvents, threadEvents, waitFor, waitForEnd } from './fakes';

const GLM = 'zai-org/GLM-5.3';
const THREAD = '11111111-2222-4333-8444-555555555555';

function okStream(text = 'Hello there', model = GLM) {
  return sseResponse([
    sseData(chunk({ role: 'assistant', content: '' }, { model })),
    ...text.split(' ').map((w, i) => sseData(chunk({ content: i === 0 ? w : ` ${w}` }, { model }))),
    sseData({ id: 'x', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseData({ id: 'x', model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 } }),
    sseData('[DONE]'),
  ]);
}

interface Setup {
  t: TestContext;
  slice: ChatSlice;
  requests: RecordedRequest[];
  reported: string[];
  recorded: ReturnType<typeof fakeBudget>['recorded'];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(
  opts: {
    respond?: (req: RecordedRequest) => Response | Promise<Response>;
    models?: ReturnType<typeof llm>[];
    key?: string | null;
    budget?: Parameters<typeof fakeBudget>[0];
    /** A real guard (e.g. the usage slice's) instead of the recording fake. */
    guard?: BudgetGuard;
    idleTimeoutMs?: number;
    t?: TestContext;
    /** A gateway built on this clock (e.g. fastClock()) instead of chat's private one on the system clock. */
    clock?: GatewayClock;
    /** A gateway to use as is (e.g. a scripted fake). */
    gateway?: GmiGateway;
  } = {},
): Promise<Setup> {
  const fake = createFakeFetch();
  if (opts.respond) fake.route({ match: () => true, respond: opts.respond });
  const t = opts.t ?? (await createTestContext({ fetch: fake.fetch }));
  if (!opts.t) cleanups.push(() => t.cleanup());
  const { keys, reported } = fakeKeys(opts.key === undefined ? 'sk-test-1234' : opts.key);
  const { budget, recorded } = fakeBudget(opts.budget);
  const catalog = fakeCatalog(opts.models ?? [llm(GLM, { featured: true })]);
  const guard = opts.guard ?? budget;
  let gateway = opts.gateway;
  if (!gateway && opts.clock) {
    const signals = { isOnline: () => true, onResume: () => () => undefined };
    const runtime = await createGatewayRuntime({ ctx: t.ctx, keys, catalog, budget: guard, signals, tpmLimit: () => 1_000_000, clock: opts.clock });
    cleanups.push(() => runtime.dispose());
    gateway = runtime.gateway;
  }
  const slice = await createChatSlice(t.ctx, { keys, catalog, budget: guard, gateway }, { flushIntervalMs: 0, idleTimeoutMs: opts.idleTimeoutMs });
  cleanups.unshift(async () => {
    await slice.dispose();
  });
  return { t, slice, requests: fake.requests, reported, recorded };
}

describe('threads', () => {
  it('creates threads with the default model, chat max tokens and router mode from settings', async () => {
    const { t, slice } = await setup({ models: [llm('a/not-featured'), llm('b/responses', { featured: true, api: 'responses' }), llm(GLM, { featured: true })] });
    const first = await slice.api.createThread();
    expect(first.settings).toMatchObject({ mode: 'model', model: GLM, maxTokens: 8192, routerMode: 'balanced' });
    expect(first.title).toBe('New chat');

    await t.ctx.settings.update({ defaultChatModel: 'deepseek-ai/DeepSeek-V4-Pro', chatMaxTokens: 4096, defaultRouterMode: 'cost' });
    const second = await slice.api.createThread();
    expect(second.settings).toMatchObject({ mode: 'model', model: 'deepseek-ai/DeepSeek-V4-Pro', maxTokens: 4096, routerMode: 'cost' });

    const auto = await slice.api.createThread({ settings: { mode: 'auto' } });
    expect(auto.mode).toBe('auto');
    expect(auto.model).toBeNull();
  });

  it('falls back to Auto when no default or featured chat model exists', async () => {
    const { slice } = await setup({ models: [] });
    const thread = await slice.api.createThread();
    expect(thread.settings.mode).toBe('auto');
  });

  it('discards empty, unnamed drafts when another chat is created', async () => {
    const { slice } = await setup();
    const draft = await slice.api.createThread();
    const named = await slice.api.createThread({ title: 'Keep me' });
    const next = await slice.api.createThread();
    const ids = (await slice.api.listThreads()).map((s) => s.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).toContain(named.id);
    expect(ids).toContain(next.id);
  });

  it('keeps an empty chat the user set up (system prompt or temperature) when another chat is created', async () => {
    const { slice } = await setup();
    const withPrompt = await slice.api.createThread();
    await slice.api.updateThread(withPrompt.id, { settings: { systemPrompt: 'Answer in French.' } });
    const withTemperature = await slice.api.createThread();
    await slice.api.updateThread(withTemperature.id, { settings: { temperature: 0.2 } });
    await slice.api.createThread();
    await expect(slice.api.getThread(withPrompt.id)).resolves.toMatchObject({ settings: { systemPrompt: 'Answer in French.' } });
    await expect(slice.api.getThread(withTemperature.id)).resolves.toMatchObject({ settings: { temperature: 0.2 } });
  });

  it('keeps empty chats listed in keepIds (unsent composer text) and still prunes the others', async () => {
    const { slice } = await setup();
    const typedIn = await slice.api.createThread();
    const abandoned = await slice.api.createThread({ keepIds: [typedIn.id] });
    await slice.api.createThread({ keepIds: [typedIn.id] });
    const ids = (await slice.api.listThreads()).map((s) => s.id);
    expect(ids).toContain(typedIn.id);
    expect(ids).not.toContain(abandoned.id);
  });

  it('validates keepIds before using them', async () => {
    const { slice } = await setup();
    for (const keepIds of [['../../etc/passwd'], 'not-a-list', [42]]) {
      await expect(slice.api.createThread({ keepIds: keepIds as string[] })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(await slice.api.listThreads()).toEqual([]);
  });

  it('validates ids before touching the disk', async () => {
    const { slice } = await setup();
    for (const bad of ['../../etc/passwd', 'x', '', '5eed0000-0000-4000-8000-00000000000g']) {
      await expect(slice.api.getThread(bad)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(slice.api.send(bad, 'hi')).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(slice.api.deleteThread(bad)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(slice.api.getThread('11111111-2222-4333-8444-555555555555')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('renames and updates settings (validated), keeping a custom title after the first message', async () => {
    const { t, slice } = await setup({ respond: () => okStream() });
    const thread = await slice.api.createThread();
    const renamed = await slice.api.updateThread(thread.id, { title: '  My   plan  ' });
    expect(renamed.title).toBe('My plan');
    const auto = await slice.api.updateThread(thread.id, { settings: { mode: 'auto', routerMode: 'quality' } });
    expect(auto).toMatchObject({ mode: 'auto', model: null, settings: { mode: 'auto', routerMode: 'quality' } });
    const back = await slice.api.updateThread(thread.id, { settings: { model: 'deepseek-ai/DeepSeek-V4-Pro' } });
    expect(back).toMatchObject({ mode: 'model', model: 'deepseek-ai/DeepSeek-V4-Pro' });
    await expect(slice.api.updateThread(thread.id, { settings: { routerMode: 'fastest' as never } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.updateThread(thread.id, { settings: { model: 'bad model id!' } })).rejects.toMatchObject({ code: 'invalid_input' });

    const { assistantMessageId } = await slice.api.send(thread.id, 'What is a KV cache?');
    await waitForEnd(t, assistantMessageId);
    expect((await slice.api.getThread(thread.id)).title).toBe('My plan');
    // Clearing the custom title goes back to the automatic one.
    expect((await slice.api.updateThread(thread.id, { title: '' })).title).toBe('What is a KV cache?');
  });

  it('titles a thread from its first message', () => {
    expect(titleFromMessage('  Explain   KV cache\nin 5 bullets ')).toBe('Explain KV cache in 5 bullets');
    expect(titleFromMessage('# Heading first')).toBe('Heading first');
    expect(titleFromMessage('x'.repeat(100))).toHaveLength(60);
    expect(titleFromMessage('```\ncode only\n```')).toBe('New chat');
  });

  it('deletes the thread file and its index entry', async () => {
    const { t, slice } = await setup();
    const thread = await slice.api.createThread({ title: 'Doomed' });
    const file = join(t.ctx.paths.data, 'chat', 'threads', `${thread.id}.json`);
    await waitFor(() => existsSync(file));
    await slice.api.deleteThread(thread.id);
    await waitFor(() => !existsSync(file));
    expect(await slice.api.listThreads()).toEqual([]);
    const index = JSON.parse(await readFile(join(t.ctx.paths.data, 'chat', 'index.json'), 'utf8')) as { threads: unknown[] };
    expect(index.threads).toEqual([]);
    await expect(slice.api.deleteThread(thread.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('send', () => {
  it('streams a chat completion: request, deltas, usage, cost, budget, events and title', async () => {
    const { t, slice, requests, recorded } = await setup({ respond: () => okStream('Hello there friend') });
    await t.ctx.settings.update({ chatMaxTokens: 2048 });
    const thread = await slice.api.createThread({ settings: { systemPrompt: 'Be brief.', temperature: 0.3 } });
    const ids = await slice.api.send(thread.id, '  Say hello  \n');
    const end = await waitForEnd(t, ids.assistantMessageId);
    expect(end.type).toBe('done');

    const req = requests[0];
    expect(req?.url).toBe('https://api.gmi-serving.com/v1/chat/completions');
    expect(req?.headers.authorization).toBe('Bearer sk-test-1234');
    expect(req?.headers['user-agent']).toBe('GMI-Desk/test');
    expect(JSON.parse(req?.body ?? '{}')).toEqual({
      model: GLM,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: '  Say hello' },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 2048,
      temperature: 0.3,
      // Added by the gateway (harness.md §4.8 behaviour change 1): an overflow is an error, not a silent cut.
      context_length_exceeded_behavior: 'error',
    });

    const final = await slice.api.getThread(thread.id);
    const reply = final.messages[1] as ChatMessage;
    expect(final.title).toBe('Say hello');
    expect(reply).toMatchObject({ role: 'assistant', content: 'Hello there friend', status: 'complete', model: GLM, finishReason: 'stop', error: null });
    expect(reply.usage).toEqual({ promptTokens: 1000, completionTokens: 2000, totalTokens: 3000, reasoningTokens: null, cachedTokens: null });
    // (1000 × 1.4 + 2000 × 4.4) / 1M × (1 − 0.5)
    expect(reply.costUsd).toBeCloseTo(0.0051, 9);
    expect(final.costUsd).toBeCloseTo(0.0051, 9);
    expect(recorded).toEqual([{ kind: 'chat', modelId: GLM, usd: reply.costUsd, ref: reply.id }]);

    const events = streamEvents(t).filter((e) => e.messageId === ids.assistantMessageId);
    expect(events[0]).toMatchObject({ type: 'start', model: GLM });
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.map((d) => (d.type === 'delta' ? d.content : '')).join('')).toBe('Hello there friend');
    // Offsets let the renderer apply each delta exactly once.
    let offset = 0;
    for (const d of deltas) {
      if (d.type !== 'delta') continue;
      expect(d.contentOffset).toBe(offset);
      offset += d.content?.length ?? 0;
    }
    expect(events.at(-1)?.type).toBe('done');

    const lists = threadEvents(t);
    expect(lists.some((l) => l.find((s) => s.id === thread.id)?.streaming === true)).toBe(true);
    expect(lists.at(-1)?.find((s) => s.id === thread.id)?.streaming).toBeUndefined();
  });

  it('sends previous turns as history, skipping failed and empty replies', () => {
    const base = { reasoning: null, model: null, routing: null, usage: null, costUsd: null, createdAt: '', error: null };
    const messages: ChatMessage[] = [
      { ...base, id: '1', role: 'user', content: 'one', status: 'complete' },
      { ...base, id: '2', role: 'assistant', content: 'partial', status: 'error' },
      { ...base, id: '3', role: 'user', content: 'two', status: 'complete' },
      { ...base, id: '4', role: 'assistant', content: '', status: 'stopped' },
      { ...base, id: '5', role: 'assistant', content: 'kept', status: 'stopped' },
    ];
    expect(historyFor(messages)).toEqual([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'kept' },
    ]);
  });

  it('routes reasoning and <think> content to the reasoning field', async () => {
    const { t, slice } = await setup({
      respond: () =>
        sseResponse([
          sseData(chunk({ reasoning_content: 'Plan. ' })),
          sseData(chunk({ content: '<thi' })),
          sseData(chunk({ content: 'nk>More plan</thi' })),
          sseData(chunk({ content: 'nk>Answer' })),
          sseData('[DONE]'),
        ]),
    });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Q');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'done' ? end.message : null).toMatchObject({ reasoning: 'Plan. More plan', content: 'Answer', status: 'complete' });
  });

  it('refuses a second send while a reply is streaming, then allows it after stop', async () => {
    const sse = controllableSse();
    const { t, slice } = await setup({ respond: () => sse.response });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'First');
    await expect(slice.api.send(thread.id, 'Second')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.regenerate(thread.id)).rejects.toMatchObject({ code: 'invalid_input' });

    sse.push(sseData(chunk({ content: 'Partial answer' })));
    await waitFor(() => streamEvents(t).find((e) => e.type === 'delta'));
    await slice.api.stop(thread.id);

    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type).toBe('done');
    expect(end.type === 'done' ? end.message : null).toMatchObject({ status: 'stopped', content: 'Partial answer', error: null });
    expect(sse.state.cancelled).toBe(true);
    const saved = await slice.api.getThread(thread.id);
    expect(saved.messages.at(-1)?.status).toBe('stopped');
  });

  it('regenerates: replaces the last reply, resends the same history and keeps the discarded cost', async () => {
    let n = 0;
    const { t, slice, requests } = await setup({ respond: () => okStream(n++ === 0 ? 'First answer' : 'Second answer') });
    const thread = await slice.api.createThread();
    const sent = await slice.api.send(thread.id, 'Question');
    await waitForEnd(t, sent.assistantMessageId);
    const firstCost = (await slice.api.getThread(thread.id)).costUsd;

    const { assistantMessageId } = await slice.api.regenerate(thread.id);
    expect(assistantMessageId).not.toBe(sent.assistantMessageId);
    await waitForEnd(t, assistantMessageId);
    const after = await slice.api.getThread(thread.id);
    expect(after.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Question'],
      ['assistant', 'Second answer'],
    ]);
    expect(JSON.parse(requests[1]?.body ?? '{}').messages).toEqual([{ role: 'user', content: 'Question' }]);
    expect(after.costUsd).toBeCloseTo(firstCost * 2, 9);
  });

  it('regenerate refuses a thread without messages', async () => {
    const { slice } = await setup({ respond: () => okStream() });
    const thread = await slice.api.createThread();
    await expect(slice.api.regenerate(thread.id)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reports a 401 as invalid_api_key and tells the key provider', async () => {
    const { t, slice, reported } = await setup({ respond: () => jsonResponse({ error: { message: 'Invalid API key' } }, 401) });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type).toBe('error');
    expect(end.type === 'error' ? end.error : null).toMatchObject({ code: 'invalid_api_key', status: 401 });
    expect(reported).toEqual(['Invalid API key']);
    expect((await slice.api.getThread(thread.id)).messages.at(-1)).toMatchObject({ status: 'error', error: { code: 'invalid_api_key' } });
  });

  it('never stores or reports the key when GMI echoes it in an error', async () => {
    const { t, slice, reported } = await setup({
      respond: () => jsonResponse({ error: { message: 'Invalid API key sk-test-1234 for this org' } }, 401),
    });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'error' ? end.error.message : null).toBe('Invalid API key [redacted] for this org');
    expect(reported).toEqual(['Invalid API key [redacted] for this org']);
    const saved = await slice.api.getThread(thread.id);
    expect(JSON.stringify(saved)).not.toContain('sk-test-1234');
    expect(JSON.stringify(t.emitted)).not.toContain('sk-test-1234');
  });

  it.each([
    [402, 'payment_required'],
    [429, 'rate_limited'],
    [503, 'upstream'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    // 429 is requeued for up to 60 s before chat gives up (harness.md §4.8): a fast clock makes that milliseconds.
    const { t, slice } = await setup({ respond: () => jsonResponse({ error: { message: 'nope' } }, status), clock: fastClock() });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'error' ? end.error.code : null).toBe(code);
  });

  it('keeps partial output when the stream reports an error', async () => {
    const { t, slice } = await setup({
      respond: () => sseResponse([sseData(chunk({ content: 'Half an ' })), sseData({ error: { message: 'Upstream overloaded', type: 'server_error' } })]),
    });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'error' ? end.message : null).toMatchObject({ status: 'error', content: 'Half an ', error: { code: 'upstream', message: 'Upstream overloaded' } });
  });

  it('fails with a timeout when the stream goes quiet', async () => {
    const sse = controllableSse();
    const { t, slice } = await setup({ respond: () => sse.response, idleTimeoutMs: 60 });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    sse.push(sseData(chunk({ content: 'Some text' })));
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'error' ? end.message : null).toMatchObject({ status: 'error', content: 'Some text', error: { code: 'timeout' } });
  });

  it('fails when the stream ends without anything', async () => {
    const { t, slice } = await setup({ respond: () => sseResponse(['data: [DONE]\n\n']) });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    const end = await waitForEnd(t, assistantMessageId);
    expect(end.type === 'error' ? end.error.code : null).toBe('upstream');
  });

  it('blocks on the local budget before appending anything', async () => {
    const { slice, requests } = await setup({ respond: () => okStream(), budget: { allowed: false, reason: 'Daily budget of $1.00 reached.' } });
    const thread = await slice.api.createThread();
    await expect(slice.api.send(thread.id, 'Hi')).rejects.toMatchObject({ code: 'budget_exceeded', message: 'Daily budget of $1.00 reached.' });
    expect((await slice.api.getThread(thread.id)).messages).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('warn-only budgets: sends anyway and returns the warning from send() and regenerate()', async () => {
    const reason = 'You have reached your daily budget ($5.00, $5.20 used). Limits are not enforced, so chat keeps working.';
    const { t, slice, requests } = await setup({ respond: () => okStream(), budget: { allowed: true, reason } });
    const thread = await slice.api.createThread();
    const sent = await slice.api.send(thread.id, 'Hi');
    expect(sent.budgetWarning).toBe(reason);
    expect((await waitForEnd(t, sent.assistantMessageId)).type).toBe('done');
    expect(requests).toHaveLength(1);
    const again = await slice.api.regenerate(thread.id);
    expect(again.budgetWarning).toBe(reason);
    await waitForEnd(t, again.assistantMessageId);
  });

  it('returns no budget warning while every limit has room', async () => {
    const { t, slice } = await setup({ respond: () => okStream() });
    const thread = await slice.api.createThread();
    const sent = await slice.api.send(thread.id, 'Hi');
    expect(sent.budgetWarning).toBeNull();
    await waitForEnd(t, sent.assistantMessageId);
    const again = await slice.api.regenerate(thread.id);
    expect(again.budgetWarning).toBeNull();
    await waitForEnd(t, again.assistantMessageId);
  });

  it('requires an inference key (outside mock mode)', async () => {
    const { slice } = await setup({ respond: () => okStream(), key: null });
    const thread = await slice.api.createThread();
    await expect(slice.api.send(thread.id, 'Hi')).rejects.toMatchObject({ code: 'no_api_key' });
    expect((await slice.api.getThread(thread.id)).messages).toEqual([]);
  });

  it('validates the message', async () => {
    const { slice } = await setup({ respond: () => okStream() });
    const thread = await slice.api.createThread();
    await expect(slice.api.send(thread.id, '   \n ')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.send(thread.id, 'x'.repeat(200_001))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.send(thread.id, 42 as unknown as string)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses media models', async () => {
    const { slice } = await setup({ models: [llm('kling/v3', { kind: 'video', api: 'queue', name: 'Kling 3' })] });
    const thread = await slice.api.createThread({ settings: { model: 'kling/v3' } });
    await expect(slice.api.send(thread.id, 'Hi')).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('Kling 3') });
  });

  it('retries once with max_completion_tokens when GMI asks for it', async () => {
    let calls = 0;
    const { t, slice, requests } = await setup({
      respond: () =>
        calls++ === 0
          ? jsonResponse({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400)
          : okStream('ok'),
    });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    expect((await waitForEnd(t, assistantMessageId)).type).toBe('done');
    const second = JSON.parse(requests[1]?.body ?? '{}') as Record<string, unknown>;
    expect(second.max_completion_tokens).toBe(8192);
    expect(second.max_tokens).toBeUndefined();
  });
});

describe('spend GMI did not report (estimated from the text)', () => {
  // ~70k characters: about 17.5k prompt tokens, i.e. about $0.012 at GLM's price with the 50% discount.
  const LONG = 'long question '.repeat(5000).trim();
  const REASONING = 'Thinking it through. ';
  const PARTIAL = 'Partial answer';

  const finalMessage = (end: ChatStreamEvent) => (end.type === 'done' || end.type === 'error' ? end.message : null);

  /** Sends LONG, streams some reasoning and text, then lets `finish` end the reply. */
  async function partialReply(finish: (s: Setup, sse: ReturnType<typeof controllableSse>, threadId: string) => Promise<void>, opts: Parameters<typeof setup>[0] = {}) {
    const sse = controllableSse();
    const s = await setup({ respond: () => sse.response, ...opts });
    const thread = await s.slice.api.createThread({ settings: { systemPrompt: 'Be thorough.' } });
    const { assistantMessageId } = await s.slice.api.send(thread.id, LONG);
    sse.push(sseData(chunk({ reasoning_content: REASONING })));
    sse.push(sseData(chunk({ content: PARTIAL })));
    await waitFor(() => streamEvents(s.t).find((e) => e.type === 'delta' && e.content));
    await finish(s, sse, thread.id);
    const message = finalMessage(await waitForEnd(s.t, assistantMessageId));
    return { ...s, threadId: thread.id, message };
  }

  function expectEstimated(message: ChatMessage | null) {
    expect(message?.usageEstimated).toBe(true);
    // System prompt + the user's message (4 chars a token, plus 4 per message); the reply includes its reasoning.
    expect(message?.usage).toEqual({
      promptTokens: estimateTokens('Be thorough.') + estimateTokens(LONG) + 8,
      completionTokens: estimateTokens(PARTIAL) + estimateTokens(REASONING),
      totalTokens: estimateTokens('Be thorough.') + estimateTokens(LONG) + 8 + estimateTokens(PARTIAL) + estimateTokens(REASONING),
      reasoningTokens: estimateTokens(REASONING),
      cachedTokens: null,
    });
    expect(message?.costUsd).toBeGreaterThan(0.01);
  }

  it('a stopped reply is estimated, priced and recorded', async () => {
    const { slice, recorded, threadId, message } = await partialReply(async (s, _sse, id) => s.slice.api.stop(id));
    expect(message).toMatchObject({ status: 'stopped', content: PARTIAL, reasoning: REASONING });
    expectEstimated(message);
    expect(recorded).toEqual([{ kind: 'chat', modelId: GLM, usd: message?.costUsd, ref: message?.id }]);
    // Saved with the thread (and its total), flag included.
    const saved = await slice.api.getThread(threadId);
    expect(saved.messages.at(-1)).toMatchObject({ usageEstimated: true, costUsd: message?.costUsd });
    expect(saved.costUsd).toBeCloseTo(message?.costUsd ?? 0, 9);
  });

  it('a reply that timed out is estimated and recorded', async () => {
    const { recorded, message } = await partialReply(async () => undefined, { idleTimeoutMs: 300 });
    expect(message).toMatchObject({ status: 'error', error: { code: 'timeout' } });
    expectEstimated(message);
    expect(recorded).toHaveLength(1);
  });

  it('a reply that failed mid-stream is estimated and recorded', async () => {
    const { recorded, message } = await partialReply(async (_s, sse) => {
      sse.push(sseData({ error: { message: 'Backend request failed', type: 'server_error' } }));
    });
    expect(message).toMatchObject({ status: 'error', content: PARTIAL, error: { message: 'Backend request failed' } });
    expectEstimated(message);
    expect(recorded).toHaveLength(1);
  });

  it('a request GMI refused (HTTP error) costs nothing', async () => {
    const { t, slice, recorded } = await setup({ respond: () => jsonResponse({ error: { message: 'Slow down' } }, 429), clock: fastClock() });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, LONG);
    const message = finalMessage(await waitForEnd(t, assistantMessageId));
    expect(message).toMatchObject({ status: 'error', usage: null, costUsd: null });
    expect(message?.usageEstimated).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it('measured usage is used as is, without the estimate flag', async () => {
    const { t, slice, recorded } = await setup({ respond: () => okStream() });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    const message = finalMessage(await waitForEnd(t, assistantMessageId));
    expect(message?.usage?.promptTokens).toBe(1000);
    expect(message?.usageEstimated).toBeUndefined();
    expect(recorded).toHaveLength(1);
  });

  it('with the real budget guard, a stopped reply counts toward an enforced daily limit', async () => {
    const sse = controllableSse();
    const fake = createFakeFetch([{ match: () => true, respond: () => sse.response }]);
    const t = await createTestContext({ fetch: fake.fetch });
    const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: () => t.ctx.now() });
    const budgets = await createBudgetService({ ctx: t.ctx, ledger });
    cleanups.push(async () => {
      budgets.dispose();
      await budgets.flush();
      await ledger.flush();
    });
    cleanups.push(() => t.cleanup());
    await budgets.setBudget({ dailyUsd: 0.01, enforce: true });

    const { slice } = await setup({ t, guard: budgets.guard });
    const thread = await slice.api.createThread();
    const { assistantMessageId } = await slice.api.send(thread.id, LONG);
    sse.push(sseData(chunk({ content: PARTIAL })));
    await waitFor(() => streamEvents(t).find((e) => e.type === 'delta'));
    await slice.api.stop(thread.id);
    await waitForEnd(t, assistantMessageId);

    expect(budgets.status().spentTodayUsd).toBeGreaterThan(0.01);
    expect((await budgets.guard.check(null, 'chat')).allowed).toBe(false);
    await expect(slice.api.send(thread.id, 'One more?')).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
});

describe('other APIs', () => {
  it('uses the Responses API for responses-only models', async () => {
    const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const { t, slice, requests } = await setup({
      models: [llm('openai/gpt-5.3-codex', { api: 'responses', llmPricing: { inputPerMTok: 1.75, outputPerMTok: 14, cacheReadPerMTok: null, cacheWritePerMTok: null }, discount: 0 })],
      respond: () =>
        sseResponse([
          ev('response.output_text.delta', { delta: 'Patched.' }),
          ev('response.completed', { response: { usage: { input_tokens: 100, output_tokens: 50 } } }),
        ]),
    });
    const thread = await slice.api.createThread({ settings: { model: 'openai/gpt-5.3-codex', reasoningEffort: 'low' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Fix the bug');
    const end = await waitForEnd(t, assistantMessageId);
    expect(requests[0]?.url).toBe('https://api.gmi-serving.com/v1/responses');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      model: 'openai/gpt-5.3-codex',
      input: [{ role: 'user', content: 'Fix the bug' }],
      stream: true,
      max_output_tokens: 8192,
      reasoning: { effort: 'low' },
      store: false,
    });
    expect(end.type === 'done' ? end.message : null).toMatchObject({ content: 'Patched.', costUsd: 0.000875 });
  });

  it('guesses the API for models the catalog does not know', () => {
    expect(guessApi('openai/gpt-5.3-codex')).toBe('responses');
    expect(guessApi('openai/gpt-5.4-pro')).toBe('responses');
    expect(guessApi('openai/gpt-5.4')).toBe('chat');
    expect(guessApi('deepseek-ai/DeepSeek-V4-Pro')).toBe('chat');
  });

  it('auto mode goes through GMI Router and labels the reply with the routed model', async () => {
    const { t, slice, requests, recorded } = await setup({
      respond: () =>
        new Response(
          [
            sseData(chunk({ content: 'Routed ' }, { model: GLM })),
            sseData(chunk({ content: 'answer' }, { model: GLM })),
            sseData({ id: 'x', model: GLM, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
            `event: routing_metadata\ndata: ${JSON.stringify({ selected_model: GLM, task_type: 'coding', selected_mode: 'balanced', fallback_models: [] })}\n\n`,
            'data: [DONE]\n\n',
          ].join(''),
          { headers: { 'content-type': 'text/event-stream', 'x-recommendation-id': 'rec-123' } },
        ),
    });
    const thread = await slice.api.createThread({ settings: { mode: 'auto', routerMode: 'balanced' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Write a regex');
    const end = await waitForEnd(t, assistantMessageId);

    expect(requests[0]?.url).toBe('https://console.gmicloud.ai/api/v1/ie/recommendation/autoroute');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ messages: [{ role: 'user', content: 'Write a regex' }], mode: 'balanced', stream: true });
    const start = streamEvents(t).find((e) => e.type === 'start');
    expect(start).toMatchObject({ model: null });
    const routing = streamEvents(t).filter((e) => e.type === 'routing');
    expect(routing[0]).toMatchObject({ routing: { selectedModel: GLM, recommendationId: 'rec-123' } });
    expect(end.type === 'done' ? end.message : null).toMatchObject({
      content: 'Routed answer',
      model: GLM,
      routing: { selectedModel: GLM, taskType: 'coding', mode: 'balanced', recommendationId: 'rec-123' },
    });
    expect(recorded[0]?.modelId).toBe(GLM);
  });

  it('a GMI Router stream without a usage chunk (as documented) is estimated and recorded at the routed model', async () => {
    const routing = { selected_model: GLM, task_type: 'qa', selected_mode: 'balanced', fallback_models: [], recommendation_id: 'r-1' };
    const { t, slice, recorded } = await setup({
      respond: () =>
        sseResponse([
          sseData(chunk({ content: 'Routed ' }, { model: GLM })),
          sseData(chunk({ content: 'answer' }, { model: GLM })),
          sseData({ id: 'x', model: GLM, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          `event: routing_metadata\ndata: ${JSON.stringify(routing)}\n\n`,
          sseData('[DONE]'),
        ]),
    });
    const thread = await slice.api.createThread({ settings: { mode: 'auto' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'What is a KV cache?');
    const end = await waitForEnd(t, assistantMessageId);
    const message = end.type === 'done' ? end.message : null;
    expect(message).toMatchObject({ status: 'complete', content: 'Routed answer', usageEstimated: true, routing: { selectedModel: GLM } });
    expect(message?.usage).toMatchObject({ promptTokens: estimateTokens('What is a KV cache?') + 4, completionTokens: estimateTokens('Routed answer') });
    expect(message?.costUsd).toBeGreaterThan(0);
    expect(recorded).toEqual([{ kind: 'chat', modelId: GLM, usd: message?.costUsd, ref: assistantMessageId }]);
  });

  it('a router reply stopped before GMI said which model it picked keeps an unknown cost (never $0)', async () => {
    const sse = controllableSse();
    const { t, slice, recorded } = await setup({ respond: () => sse.response });
    const thread = await slice.api.createThread({ settings: { mode: 'auto' } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Hi');
    // Reasoning from a chunk without a model id: the routed model is still unknown.
    sse.push(sseData({ id: 'x', choices: [{ index: 0, delta: { reasoning_content: 'hmm' }, finish_reason: null }] }));
    await waitFor(() => streamEvents(t).find((e) => e.type === 'delta'));
    await slice.api.stop(thread.id);
    const end = await waitForEnd(t, assistantMessageId);
    const message = end.type === 'done' ? end.message : null;
    expect(message).toMatchObject({ status: 'stopped', routing: null, model: null, usageEstimated: true, costUsd: null });
    expect(recorded).toEqual([]);
  });

  it('stores the output limit each reply was sent with (none for GMI Router)', async () => {
    const { t, slice } = await setup({ respond: () => okStream() });
    const direct = await slice.api.createThread({ settings: { maxTokens: 2048 } });
    const sent = await slice.api.send(direct.id, 'Hi');
    expect((await waitForEnd(t, sent.assistantMessageId)).type).toBe('done');
    // Changing the setting later does not rewrite what the reply was sent with.
    await slice.api.updateThread(direct.id, { settings: { maxTokens: 32_000 } });
    expect((await slice.api.getThread(direct.id)).messages.at(-1)?.maxTokens).toBe(2048);

    const routed = await slice.api.createThread({ settings: { mode: 'auto' } });
    const viaRouter = await slice.api.send(routed.id, 'Hi');
    await waitForEnd(t, viaRouter.assistantMessageId);
    expect((await slice.api.getThread(routed.id)).messages.at(-1)?.maxTokens).toBeNull();
  });
});

describe('persistence', () => {
  it('round-trips threads through disk and rebuilds a missing or corrupt index', async () => {
    const first = await setup({ respond: () => okStream('Persisted reply') });
    const thread = await first.slice.api.createThread();
    const { assistantMessageId } = await first.slice.api.send(thread.id, 'Remember me');
    await waitForEnd(first.t, assistantMessageId);
    await first.slice.dispose();

    const again = await setup({ t: first.t });
    const list = await again.slice.api.listThreads();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: thread.id, title: 'Remember me', messageCount: 2 });
    const loaded = await again.slice.api.getThread(thread.id);
    expect(loaded.messages.map((m) => m.content)).toEqual(['Remember me', 'Persisted reply']);
    expect(loaded.messages[1]?.usage?.completionTokens).toBe(2000);
    await again.slice.dispose();

    const dir = join(first.t.ctx.paths.data, 'chat');
    await rm(join(dir, 'index.json'));
    const rebuilt = await setup({ t: first.t });
    expect((await rebuilt.slice.api.listThreads()).map((s) => s.id)).toEqual([thread.id]);
    await rebuilt.slice.dispose();

    await writeFile(join(dir, 'index.json'), '{ not json');
    await writeFile(join(dir, 'threads', '11111111-2222-4333-8444-555555555555.json'), '{ broken');
    const repaired = await setup({ t: first.t });
    expect((await repaired.slice.api.listThreads()).map((s) => s.id)).toEqual([thread.id]);
  });

  it('keeps the estimate flag and the output limit of a reply across restarts', async () => {
    const sse = controllableSse();
    const first = await setup({ respond: () => sse.response });
    const thread = await first.slice.api.createThread({ settings: { maxTokens: 1024 } });
    const { assistantMessageId } = await first.slice.api.send(thread.id, 'Question');
    sse.push(sseData(chunk({ content: 'Partial' })));
    await waitFor(() => streamEvents(first.t).find((e) => e.type === 'delta'));
    await first.slice.api.stop(thread.id);
    await waitForEnd(first.t, assistantMessageId);
    await first.slice.dispose();

    const again = await setup({ t: first.t });
    const reply = (await again.slice.api.getThread(thread.id)).messages.at(-1);
    expect(reply).toMatchObject({ status: 'stopped', usageEstimated: true, maxTokens: 1024 });
    expect(reply?.costUsd).toBeGreaterThan(0);
  });

  it('reads the estimate flag and output limit from disk defensively', () => {
    const at = '2026-10-31T10:00:00.000Z';
    const usage = { promptTokens: 10, completionTokens: 5 };
    const record = normalizeThreadRecord(
      {
        id: THREAD,
        createdAt: at,
        messages: [
          { id: 'a', role: 'assistant', content: 'x', createdAt: at, status: 'complete', usage, usageEstimated: true, maxTokens: 2048.4 },
          { id: 'b', role: 'assistant', content: 'x', createdAt: at, status: 'complete', usage, maxTokens: null },
          { id: 'c', role: 'assistant', content: 'x', createdAt: at, status: 'complete', usageEstimated: true, maxTokens: 'lots' },
          { id: 'd', role: 'user', content: 'x', createdAt: at, status: 'complete', maxTokens: 10 },
        ],
      },
      THREAD,
      at,
    );
    const [a, b, c, d] = record?.messages ?? [];
    expect(a).toMatchObject({ usageEstimated: true, maxTokens: 2048 });
    expect(b?.maxTokens).toBeNull();
    expect(b?.usageEstimated).toBeUndefined();
    // No usage to qualify; unreadable limit = unknown (absent), not "none sent".
    expect(c?.usageEstimated).toBeUndefined();
    expect(c && 'maxTokens' in c).toBe(false);
    expect(d && 'maxTokens' in d).toBe(false);
  });

  it('marks a reply that was streaming at shutdown as stopped, keeping its text', async () => {
    const sse = controllableSse();
    const first = await setup({ respond: () => sse.response });
    const thread = await first.slice.api.createThread();
    await first.slice.api.send(thread.id, 'Long question');
    sse.push(sseData(chunk({ content: 'Started answering' })));
    await waitFor(() => streamEvents(first.t).find((e) => e.type === 'delta'));
    await first.slice.dispose();

    const again = await setup({ t: first.t });
    const loaded = await again.slice.api.getThread(thread.id);
    expect(loaded.messages.at(-1)).toMatchObject({ status: 'stopped', content: 'Started answering' });
  });

  it('a stream finishing after its thread was deleted does not bring it back', async () => {
    const sse = controllableSse();
    const { t, slice } = await setup({ respond: () => sse.response });
    const thread = await slice.api.createThread();
    await slice.api.send(thread.id, 'Hi');
    sse.push(sseData(chunk({ content: 'text' })));
    await waitFor(() => streamEvents(t).find((e) => e.type === 'delta'));
    await slice.api.deleteThread(thread.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(join(t.ctx.paths.data, 'chat', 'threads', `${thread.id}.json`))).toBe(false);
    expect(await slice.api.listThreads()).toEqual([]);
  });
});
