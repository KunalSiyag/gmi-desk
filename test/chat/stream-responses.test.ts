import { describe, expect, it } from 'vitest';
import type { ChatSettings } from '@shared/contracts/chat';
import { ResponsesParser } from '@main/services/gateway/parsers/responses';
import { jsonResponse, sseResponse } from '../helpers/fetch';
import { collectParts, textOf, wireBody } from './fakes';

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const settings: ChatSettings = {
  mode: 'model',
  model: 'openai/gpt-5.3-codex',
  routerMode: 'balanced',
  maxTokens: 4096,
  temperature: null,
  reasoningEffort: 'medium',
  systemPrompt: 'You are terse.',
};

describe('Responses API', () => {
  it('builds the body with input items, instructions, max_output_tokens and reasoning effort (plus store:false)', () => {
    const body = wireBody({
      route: 'responses',
      model: 'openai/gpt-5.3-codex',
      settings,
      history: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Fix it' },
      ],
    });
    expect(JSON.stringify(body)).toBe(JSON.stringify({
      model: 'openai/gpt-5.3-codex',
      input: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Fix it' },
      ],
      stream: true,
      max_output_tokens: 4096,
      instructions: 'You are terse.',
      reasoning: { effort: 'medium' },
      store: false,
    }));
  });

  it('parses text and reasoning deltas, separates summary parts and reads usage from response.completed', async () => {
    const res = sseResponse([
      ev('response.created', { response: { id: 'resp_1', model: 'openai/gpt-5.3-codex', status: 'in_progress' } }),
      ev('response.reasoning_summary_part.added', { summary_index: 0 }),
      ev('response.reasoning_summary_text.delta', { delta: 'First idea.' }),
      ev('response.reasoning_summary_part.added', { summary_index: 1 }),
      ev('response.reasoning_summary_text.delta', { delta: 'Second idea.' }),
      ev('response.output_text.delta', { delta: 'Hel' }),
      ev('response.output_text.delta', { delta: 'lo' }),
      ev('response.output_text.done', { text: 'Hello' }),
      ev('response.completed', {
        response: {
          status: 'completed',
          usage: { input_tokens: 21, output_tokens: 40, total_tokens: 61, output_tokens_details: { reasoning_tokens: 16 }, input_tokens_details: { cached_tokens: 0 } },
        },
      }),
    ]);
    const parts = await collectParts(res, new ResponsesParser());
    expect(parts[0]).toEqual({ type: 'model', model: 'openai/gpt-5.3-codex' });
    expect(textOf(parts, 'reasoning')).toBe('First idea.\n\nSecond idea.');
    expect(textOf(parts, 'content')).toBe('Hello');
    expect(parts).toContainEqual({ type: 'usage', usage: { promptTokens: 21, completionTokens: 40, totalTokens: 61, reasoningTokens: 16, cachedTokens: 0 }, cacheWriteTokens: null });
    expect(parts).toContainEqual({ type: 'finish', reason: 'stop' });
  });

  it('accepts raw reasoning_text deltas (open models)', async () => {
    const res = sseResponse([ev('response.reasoning_text.delta', { delta: 'raw thought' }), ev('response.output_text.delta', { delta: 'ok' })]);
    const parts = await collectParts(res, new ResponsesParser());
    expect(textOf(parts, 'reasoning')).toBe('raw thought');
    expect(textOf(parts, 'content')).toBe('ok');
  });

  it('maps response.incomplete (max_output_tokens) to finish "length"', async () => {
    const res = sseResponse([
      ev('response.output_text.delta', { delta: 'cut' }),
      ev('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 2 } } }),
    ]);
    const parts = await collectParts(res, new ResponsesParser());
    expect(parts).toContainEqual({ type: 'finish', reason: 'length' });
  });

  it('turns response.failed and error events into error parts', async () => {
    const failed = await collectParts(
      sseResponse([ev('response.output_text.delta', { delta: 'part' }), ev('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: 'Model crashed' } } })]),
      new ResponsesParser(),
    );
    const e1 = failed.find((p) => p.type === 'error');
    expect(e1 && e1.type === 'error' ? e1.error.message : null).toBe('Model crashed');

    const errored = await collectParts(sseResponse([ev('error', { code: 'rate_limit_exceeded', message: 'Slow down' })]), new ResponsesParser());
    const e2 = errored.find((p) => p.type === 'error');
    expect(e2 && e2.type === 'error' ? e2.error.code : null).toBe('rate_limited');
  });

  it('reads a non-streamed Responses object', async () => {
    const parts = await collectParts(
      jsonResponse({
        model: 'openai/gpt-5.4-pro',
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Because.' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final.' }] },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
      new ResponsesParser(),
    );
    expect(textOf(parts, 'content')).toBe('Final.');
    expect(textOf(parts, 'reasoning')).toBe('Because.');
    expect(parts).toContainEqual({ type: 'finish', reason: 'stop' });
  });
});
