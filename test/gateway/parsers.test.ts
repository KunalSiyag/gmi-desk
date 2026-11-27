import { describe, expect, it } from 'vitest';
import { ChatCompletionsParser, wantsMaxCompletionTokens } from '@main/services/gateway/parsers/chat';
import { parseUsage, parseUsageDetailed, readStreamParts, streamErrorFrom, upstreamErrorCode, type StreamParser, type StreamPart } from '@main/services/gateway/parsers/common';
import { ResponsesParser } from '@main/services/gateway/parsers/responses';
import { RouterStreamParser } from '@main/services/gateway/parsers/router';
import { ThinkTagSplitter } from '@main/services/gateway/parsers/think';
import { jsonResponse, sseData, sseResponse } from '../helpers/fetch';

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  model: 'zai-org/GLM-5.3',
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});
const finishChunk = (reason: string) => ({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

async function collect(res: Response, parser: StreamParser): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  let chunks = 0;
  for await (const part of readStreamParts(res, parser, { signal: new AbortController().signal, onChunk: () => (chunks += 1) })) parts.push(part);
  expect(chunks).toBeGreaterThan(0);
  return parts;
}
const textOf = (parts: StreamPart[], type: 'content' | 'reasoning') =>
  parts
    .filter((p): p is Extract<StreamPart, { type: 'content' | 'reasoning' }> => p.type === type)
    .map((p) => p.text)
    .join('');
const calls = (parts: StreamPart[]) => parts.flatMap((p) => (p.type === 'tool_call' ? [p.call] : []));

describe('chat completions parser (copied from chat)', () => {
  it('parses content, reasoning_content, finish_reason and the usage chunk, then stops at [DONE]', async () => {
    const parts = await collect(
      sseResponse([
        sseData(chunk({ role: 'assistant', content: '' })),
        sseData(chunk({ reasoning_content: 'Think ' })),
        sseData(chunk({ reasoning_content: 'hard.' })),
        sseData(chunk({ content: 'Hello' })),
        sseData(chunk({ content: ' world' })),
        sseData(finishChunk('stop')),
        sseData({
          id: 'chatcmpl-1',
          model: 'zai-org/GLM-5.3',
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42, completion_tokens_details: { reasoning_tokens: 8 }, prompt_tokens_details: { cached_tokens: 4 } },
        }),
        sseData('[DONE]'),
        sseData(chunk({ content: 'IGNORED after done' })),
      ]),
      new ChatCompletionsParser(),
    );
    expect(textOf(parts, 'reasoning')).toBe('Think hard.');
    expect(textOf(parts, 'content')).toBe('Hello world');
    expect(parts).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(parts.filter((p) => p.type === 'model')).toEqual([{ type: 'model', model: 'zai-org/GLM-5.3' }]);
    expect(parts).toContainEqual({ type: 'usage', usage: { promptTokens: 12, completionTokens: 30, totalTokens: 42, reasoningTokens: 8, cachedTokens: 4 }, cacheWriteTokens: null });
  });

  it('reassembles events split mid-JSON across network chunks', async () => {
    const whole = `${sseData(chunk({ content: 'Split ' }))}${sseData(chunk({ content: 'across chunks' }))}data: [DONE]\n\n`;
    const pieces: string[] = [];
    for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7));
    expect(textOf(await collect(sseResponse(pieces), new ChatCompletionsParser()), 'content')).toBe('Split across chunks');
  });

  it('accepts `reasoning` as an alias and routes <think> content to reasoning', async () => {
    const parts = await collect(
      sseResponse([
        sseData(chunk({ reasoning: 'alias. ' })),
        sseData(chunk({ content: '<thi' })),
        sseData(chunk({ content: 'nk>inline</th' })),
        sseData(chunk({ content: 'ink>\n\nAnswer' })),
        sseData('[DONE]'),
      ]),
      new ChatCompletionsParser(),
    );
    expect(textOf(parts, 'reasoning')).toBe('alias. inline');
    expect(textOf(parts, 'content')).toBe('Answer');
  });

  it('turns an error chunk into an error part with a mapped code', async () => {
    const parts = await collect(sseResponse([sseData(chunk({ content: 'partial' })), sseData({ error: { message: 'Rate limit reached', code: 429 } })]), new ChatCompletionsParser());
    const error = parts.find((p) => p.type === 'error');
    expect(textOf(parts, 'content')).toBe('partial');
    expect(error?.type === 'error' ? error.error.code : null).toBe('rate_limited');
  });

  it('handles a server that ignores stream:true and answers with one JSON document', async () => {
    const parts = await collect(
      jsonResponse({
        model: 'zai-org/GLM-5.3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Whole answer', reasoning_content: 'why' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      }),
      new ChatCompletionsParser(),
    );
    expect(textOf(parts, 'content')).toBe('Whole answer');
    expect(textOf(parts, 'reasoning')).toBe('why');
    expect(parts).toContainEqual({ type: 'finish', reason: 'length' });
  });

  it('recognises a JSON document sent without a JSON content type, and refuses an HTML page', async () => {
    const plain = new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'text/plain' } });
    expect(textOf(await collect(plain, new ChatCompletionsParser()), 'content')).toBe('ok');
    const html = new Response('<!doctype html><html>Bad gateway</html>', { headers: { 'content-type': 'text/html' } });
    await expect(collect(html, new ChatCompletionsParser())).rejects.toMatchObject({ code: 'upstream' });
  });
});

describe('tool-call assembly (chat completions)', () => {
  const toolDelta = (index: number, fn: Record<string, unknown>, id?: string) => chunk({ tool_calls: [{ index, ...(id ? { id, type: 'function' } : {}), function: fn }] });

  it('accumulates delta.tool_calls by index and emits complete calls at the finish, in index order', async () => {
    const parts = await collect(
      sseResponse([
        sseData(chunk({ content: 'Let me look.' })),
        sseData(toolDelta(0, { name: 'read', arguments: '' }, 'call_a')),
        sseData(toolDelta(1, { name: 'grep', arguments: '{"pat' }, 'call_b')),
        sseData(toolDelta(0, { arguments: '{"path":' })),
        sseData(toolDelta(1, { arguments: 'tern":"x"}' })),
        sseData(toolDelta(0, { arguments: '"a.ts"}' })),
        sseData(finishChunk('tool_calls')),
        sseData({ ...chunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 9 } }),
        sseData('[DONE]'),
      ]),
      new ChatCompletionsParser(),
    );
    const deltas = parts.filter((p) => p.type === 'tool_call_delta');
    expect(deltas).toHaveLength(5);
    expect(deltas[0]).toEqual({ type: 'tool_call_delta', index: 0, id: 'call_a', name: 'read', argumentsDelta: '' });
    expect(calls(parts)).toEqual([
      { id: 'call_a', name: 'read', arguments: '{"path":"a.ts"}' },
      { id: 'call_b', name: 'grep', arguments: '{"pattern":"x"}' },
    ]);
    // Calls come before the finish part, usage after it.
    const order = parts.map((p) => p.type).filter((t) => t === 'tool_call' || t === 'finish' || t === 'usage');
    expect(order).toEqual(['tool_call', 'tool_call', 'finish', 'usage']);
  });

  it('a server that reuses index 0 with a new id starts a new call', async () => {
    const parts = await collect(
      sseResponse([
        sseData(toolDelta(0, { name: 'read', arguments: '{"path":"a"}' }, 'call_1')),
        sseData(toolDelta(0, { name: 'read', arguments: '{"path":"b"}' }, 'call_2')),
        sseData(finishChunk('tool_calls')),
        sseData('[DONE]'),
      ]),
      new ChatCompletionsParser(),
    );
    expect(calls(parts)).toEqual([
      { id: 'call_1', name: 'read', arguments: '{"path":"a"}' },
      { id: 'call_2', name: 'read', arguments: '{"path":"b"}' },
    ]);
    expect(parts.filter((p) => p.type === 'tool_call_delta').map((p) => (p.type === 'tool_call_delta' ? p.index : -1))).toEqual([0, 1]);
  });

  it('a cut stream (no finish, no [DONE]) emits deltas but never an incomplete call', async () => {
    const parts = await collect(sseResponse([sseData(toolDelta(0, { name: 'edit', arguments: '{"path":"a.ts","old":"x' }, 'call_c'))]), new ChatCompletionsParser());
    expect(parts.some((p) => p.type === 'tool_call_delta')).toBe(true);
    expect(calls(parts)).toEqual([]);
  });

  it('[DONE] without a finish chunk still completes the calls; a missing id gets call_<index>', async () => {
    const parts = await collect(sseResponse([sseData(toolDelta(0, { name: 'list', arguments: '{}' })), sseData('[DONE]')]), new ChatCompletionsParser());
    expect(calls(parts)).toEqual([{ id: 'call_0', name: 'list', arguments: '{}' }]);
  });

  it('reads tool calls from a non-streamed message', async () => {
    const parts = await collect(
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }],
      }),
      new ChatCompletionsParser(),
    );
    expect(calls(parts)).toEqual([{ id: 'call_x', name: 'bash', arguments: '{"command":"ls"}' }]);
    expect(parts).toContainEqual({ type: 'finish', reason: 'tool_calls' });
  });
});

describe('Responses parser (copied from chat, extended with function calls)', () => {
  it('parses text and reasoning deltas, separates summary parts and reads usage from response.completed', async () => {
    const parts = await collect(
      sseResponse([
        ev('response.created', { response: { id: 'resp_1', model: 'openai/gpt-5.3-codex', status: 'in_progress' } }),
        ev('response.reasoning_summary_part.added', { summary_index: 0 }),
        ev('response.reasoning_summary_text.delta', { delta: 'First idea.' }),
        ev('response.reasoning_summary_part.added', { summary_index: 1 }),
        ev('response.reasoning_summary_text.delta', { delta: 'Second idea.' }),
        ev('response.output_text.delta', { delta: 'Hel' }),
        ev('response.output_text.delta', { delta: 'lo' }),
        ev('response.completed', { response: { status: 'completed', usage: { input_tokens: 21, output_tokens: 40, total_tokens: 61, output_tokens_details: { reasoning_tokens: 16 }, input_tokens_details: { cached_tokens: 0 } } } }),
      ]),
      new ResponsesParser(),
    );
    expect(parts[0]).toEqual({ type: 'model', model: 'openai/gpt-5.3-codex' });
    expect(textOf(parts, 'reasoning')).toBe('First idea.\n\nSecond idea.');
    expect(textOf(parts, 'content')).toBe('Hello');
    expect(parts).toContainEqual({ type: 'usage', usage: { promptTokens: 21, completionTokens: 40, totalTokens: 61, reasoningTokens: 16, cachedTokens: 0 }, cacheWriteTokens: null });
    expect(parts).toContainEqual({ type: 'finish', reason: 'stop' });
  });

  it('maps response.incomplete (max_output_tokens) to "length" and failures to error parts', async () => {
    const cut = await collect(sseResponse([ev('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })]), new ResponsesParser());
    expect(cut).toContainEqual({ type: 'finish', reason: 'length' });
    const failed = await collect(sseResponse([ev('response.failed', { response: { error: { code: 'server_error', message: 'Model crashed' } } })]), new ResponsesParser());
    expect(failed.find((p) => p.type === 'error')).toMatchObject({ error: { message: 'Model crashed' } });
    const errored = await collect(sseResponse([ev('error', { code: 'rate_limit_exceeded', message: 'Slow down' })]), new ResponsesParser());
    expect(errored.find((p) => p.type === 'error')).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('assembles function calls from output_item.added + arguments deltas, final text from .done', async () => {
    const parts = await collect(
      sseResponse([
        ev('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' } }),
        ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 0, delta: '{"path"' }),
        ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 0, delta: ':"a.ts"}' }),
        ev('response.output_item.added', { output_index: 1, item: { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'grep' } }),
        ev('response.function_call_arguments.delta', { item_id: 'fc_2', delta: '{"pattern":"x"' }),
        ev('response.function_call_arguments.done', { item_id: 'fc_2', arguments: '{"pattern":"x"}' }),
        ev('response.completed', { response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 6 } } }),
      ]),
      new ResponsesParser(),
    );
    expect(parts.filter((p) => p.type === 'tool_call_delta')).toHaveLength(5);
    expect(calls(parts)).toEqual([
      { id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      { id: 'call_2', name: 'grep', arguments: '{"pattern":"x"}' },
    ]);
    expect(parts).toContainEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('reads a non-streamed Responses object with text, reasoning and a function call', async () => {
    const parts = await collect(
      jsonResponse({
        model: 'openai/gpt-5.4-pro',
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Because.' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final.' }] },
          { type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
      new ResponsesParser(),
    );
    expect(textOf(parts, 'content')).toBe('Final.');
    expect(textOf(parts, 'reasoning')).toBe('Because.');
    expect(calls(parts)).toEqual([{ id: 'call_9', name: 'bash', arguments: '{"command":"ls"}' }]);
    expect(parts).toContainEqual({ type: 'finish', reason: 'tool_calls' });
  });
});

describe('router parser (copied from chat)', () => {
  const metadata = { selected_model: 'zai-org/GLM-5.3', task_type: 'coding', selected_mode: 'quality', fallback_models: ['deepseek-ai/DeepSeek-V4-Pro'], recommendation_id: 'rec-1' };

  it('reports the routed model early from chunk.model, then the routing_metadata event', async () => {
    const parts = await collect(
      sseResponse([sseData(chunk({ content: 'Use ' })), sseData(chunk({ content: 'x' })), `event: routing_metadata\ndata: ${JSON.stringify(metadata)}\n\n`, sseData('[DONE]')]),
      new RouterStreamParser({ mode: 'quality', recommendationId: 'from-header' }),
    );
    expect(textOf(parts, 'content')).toBe('Use x');
    const routings = parts.flatMap((p) => (p.type === 'routing' ? [p.routing] : []));
    expect(routings[0]).toEqual({ selectedModel: 'zai-org/GLM-5.3', taskType: null, mode: 'quality', fallbackModels: [], recommendationId: 'from-header' });
    expect(routings[routings.length - 1]).toMatchObject({ taskType: 'coding', recommendationId: 'rec-1' });
    expect(parts[0]?.type).toBe('routing');
  });

  it('accepts a plain JSON body with routing_metadata and a message', async () => {
    const parts = await collect(
      jsonResponse({ model: 'zai-org/GLM-5.3', message: { content: 'Hi' }, routing_metadata: metadata, usage: { prompt_tokens: 2, completion_tokens: 1 } }),
      new RouterStreamParser({ mode: 'balanced', recommendationId: null }),
    );
    expect(textOf(parts, 'content')).toBe('Hi');
    expect(parts).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(parts.some((p) => p.type === 'usage')).toBe(true);
  });

  it('turns an error event into an error part', async () => {
    const parts = await collect(sseResponse([`event: error\ndata: ${JSON.stringify({ error: { message: 'No route', code: 503 } })}\n\n`]), new RouterStreamParser({ mode: 'cost', recommendationId: null }));
    expect(parts.find((p) => p.type === 'error')).toMatchObject({ error: { code: 'upstream', message: 'No route' } });
  });
});

describe('usage, cache writes and stream errors', () => {
  it('parses both API shapes and DeepSeek cache hits', () => {
    expect(parseUsage({ input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 }, input_tokens_details: { cached_tokens: 2 } })).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      reasoningTokens: 5,
      cachedTokens: 2,
    });
    expect(parseUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 64 })?.cachedTokens).toBe(64);
    expect(parseUsage({ prompt_tokens: null, completion_tokens: null })).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });

  it('reads cache-write tokens where reported ([U] shapes)', () => {
    expect(parseUsageDetailed({ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 10, cache_creation_tokens: 80 } })?.cacheWriteTokens).toBe(80);
    expect(parseUsageDetailed({ input_tokens: 100, output_tokens: 2, cache_creation_input_tokens: 64 })?.cacheWriteTokens).toBe(64);
    expect(parseUsageDetailed({ prompt_tokens: 1, completion_tokens: 1 })?.cacheWriteTokens).toBeNull();
  });

  it('maps in-stream errors, unwraps GMI backend details and recognises context overflow', () => {
    expect(streamErrorFrom({ error: { message: 'Insufficient balance', type: 'insufficient_quota' } }).code).toBe('payment_required');
    expect(streamErrorFrom({ error: { message: 'nope', code: 401 } }).code).toBe('invalid_api_key');
    expect(streamErrorFrom({ message: 'boom' }).code).toBe('upstream');
    const wrapped = streamErrorFrom({
      error: { message: 'Backend request failed with status 400', type: 'backend_error', code: 400, details: { error: { message: "Unsupported parameter: 'max_tokens'", code: 'unsupported_parameter' } } },
    });
    expect(wrapped).toMatchObject({ code: 'invalid_input', message: "Unsupported parameter: 'max_tokens'", detail: 'Backend request failed with status 400' });
    expect(upstreamErrorCode(JSON.stringify({ error: { message: 'x', details: { error: { code: 'unsupported_parameter' } } } }))).toBe('unsupported_parameter');
    expect(streamErrorFrom({ error: { message: "This model's maximum context length is 131072 tokens", code: 400 } }).code).toBe('context_overflow');
    expect(streamErrorFrom('prompt is too long').code).toBe('context_overflow');
  });

  it('detects the max_completion_tokens rejection text', () => {
    expect(wantsMaxCompletionTokens("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")).toBe(true);
    expect(wantsMaxCompletionTokens('bad')).toBe(false);
  });
});

describe('think splitter (copied from chat)', () => {
  it('holds back split tags and trims whitespace after them', () => {
    const s = new ThinkTagSplitter();
    expect(s.push('Hi <thi')).toEqual([{ channel: 'content', text: 'Hi ' }]);
    expect(s.push('nk>\n plan</think>\n\nanswer')).toEqual([
      { channel: 'reasoning', text: 'plan' },
      { channel: 'content', text: 'answer' },
    ]);
    expect(s.end()).toEqual([]);
  });
});
