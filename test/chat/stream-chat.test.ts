import { describe, expect, it } from 'vitest';
import type { ChatSettings } from '@shared/contracts/chat';
import { GmiError } from '@shared/contracts/errors';
import { ChatCompletionsParser, wantsMaxCompletionTokens } from '@main/services/gateway/parsers/chat';
import { parseUsage, streamErrorFrom } from '@main/services/gateway/parsers/common';
import { jsonResponse, sseData, sseResponse } from '../helpers/fetch';
import { chunk, collectParts, textOf, wireBody } from './fakes';

const settings: ChatSettings = {
  mode: 'model',
  model: 'zai-org/GLM-5.3',
  routerMode: 'balanced',
  maxTokens: 8192,
  temperature: null,
  reasoningEffort: null,
  systemPrompt: null,
};

// The parsers moved to the gateway (harness.md §4.8); these are chat's tests, kept against the moved code.
describe('chat completions body (chat request → gateway builder)', () => {
  it('sends stream options and max_tokens, and only the sampling options that are set (plus context_length_exceeded_behavior)', () => {
    const history = [{ role: 'user' as const, content: 'Hi' }];
    expect(JSON.stringify(wireBody({ route: 'chat', model: 'zai-org/GLM-5.3', settings, history }))).toBe(
      JSON.stringify({
        model: 'zai-org/GLM-5.3',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 8192,
        context_length_exceeded_behavior: 'error',
      }),
    );
    const body = wireBody({ route: 'chat', model: 'm/x', settings: { ...settings, temperature: 0.2, reasoningEffort: 'high', systemPrompt: 'Be brief.' }, history });
    expect(body.temperature).toBe(0.2);
    expect(body.reasoning_effort).toBe('high');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('detects the max_completion_tokens rejection', () => {
    expect(wantsMaxCompletionTokens("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")).toBe(true);
    expect(wantsMaxCompletionTokens('bad')).toBe(false);
  });
});

describe('ChatCompletionsParser', () => {
  it('parses content, reasoning_content, finish_reason and the usage chunk, then stops at [DONE]', async () => {
    const res = sseResponse([
      sseData(chunk({ role: 'assistant', content: '' })),
      sseData(chunk({ reasoning_content: 'Think ' })),
      sseData(chunk({ reasoning_content: 'hard.' })),
      sseData(chunk({ content: 'Hello' })),
      sseData(chunk({ content: ' world' })),
      sseData({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      sseData({
        id: 'chatcmpl-1',
        model: 'zai-org/GLM-5.3',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 30,
          total_tokens: 42,
          completion_tokens_details: { reasoning_tokens: 8 },
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
      sseData('[DONE]'),
      sseData(chunk({ content: 'IGNORED after done' })),
    ]);
    const parts = await collectParts(res, new ChatCompletionsParser());
    expect(textOf(parts, 'reasoning')).toBe('Think hard.');
    expect(textOf(parts, 'content')).toBe('Hello world');
    expect(parts).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(parts).toContainEqual({ type: 'model', model: 'zai-org/GLM-5.3' });
    expect(parts.filter((p) => p.type === 'model')).toHaveLength(1);
    expect(parts).toContainEqual({
      type: 'usage',
      usage: { promptTokens: 12, completionTokens: 30, totalTokens: 42, reasoningTokens: 8, cachedTokens: 4 },
      cacheWriteTokens: null,
    });
  });

  it('reassembles events split mid-JSON across network chunks', async () => {
    const whole = `${sseData(chunk({ content: 'Split ' }))}${sseData(chunk({ content: 'across chunks' }))}data: [DONE]\n\n`;
    const pieces: string[] = [];
    for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7));
    const parts = await collectParts(sseResponse(pieces), new ChatCompletionsParser());
    expect(textOf(parts, 'content')).toBe('Split across chunks');
  });

  it('accepts `reasoning` as an alias and routes <think> content to reasoning', async () => {
    const res = sseResponse([
      sseData(chunk({ reasoning: 'alias. ' })),
      sseData(chunk({ content: '<thi' })),
      sseData(chunk({ content: 'nk>inline</th' })),
      sseData(chunk({ content: 'ink>\n\nAnswer' })),
      sseData('[DONE]'),
    ]);
    const parts = await collectParts(res, new ChatCompletionsParser());
    expect(textOf(parts, 'reasoning')).toBe('alias. inline');
    expect(textOf(parts, 'content')).toBe('Answer');
  });

  it('turns an error chunk into an error part with a mapped code', async () => {
    const res = sseResponse([sseData(chunk({ content: 'partial' })), sseData({ error: { message: 'Rate limit reached', code: 429 } })]);
    const parts = await collectParts(res, new ChatCompletionsParser());
    const error = parts.find((p) => p.type === 'error');
    expect(textOf(parts, 'content')).toBe('partial');
    expect(error && error.type === 'error' ? error.error.code : null).toBe('rate_limited');
  });

  it('handles a server that ignores stream:true and answers with one JSON document', async () => {
    const res = jsonResponse({
      model: 'zai-org/GLM-5.3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Whole answer', reasoning_content: 'why' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    });
    const parts = await collectParts(res, new ChatCompletionsParser());
    expect(textOf(parts, 'content')).toBe('Whole answer');
    expect(textOf(parts, 'reasoning')).toBe('why');
    expect(parts).toContainEqual({ type: 'finish', reason: 'length' });
    expect(parts).toContainEqual({ type: 'usage', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8, reasoningTokens: null, cachedTokens: null }, cacheWriteTokens: null });
  });
});

describe('usage and stream errors', () => {
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

  it('maps in-stream errors to GmiError codes and unwraps GMI backend details', () => {
    expect(streamErrorFrom({ error: { message: 'Insufficient balance', type: 'insufficient_quota' } }).code).toBe('payment_required');
    expect(streamErrorFrom({ error: { message: 'nope', code: 401 } }).code).toBe('invalid_api_key');
    expect(streamErrorFrom({ message: 'boom' }).code).toBe('upstream');
    expect(streamErrorFrom('plain text failure').message).toBe('plain text failure');
    const wrapped = streamErrorFrom({
      error: {
        message: 'Backend request failed with status 400',
        type: 'backend_error',
        code: 400,
        details: { error: { message: "Unsupported parameter: 'max_tokens'", type: 'invalid_request_error' } },
      },
    });
    expect(wrapped.code).toBe('invalid_input');
    expect(wrapped.message).toBe("Unsupported parameter: 'max_tokens'");
    expect(wrapped.detail).toBe('Backend request failed with status 400');
  });
});
