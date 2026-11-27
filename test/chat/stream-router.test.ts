import { describe, expect, it } from 'vitest';
import type { ChatSettings } from '@shared/contracts/chat';
import { RouterStreamParser } from '@main/services/gateway/parsers/router';
import type { StreamPart } from '@main/services/gateway/parsers/common';
import { jsonResponse, sseData, sseResponse } from '../helpers/fetch';
import { chunk, collectParts, textOf, wireBody } from './fakes';

const settings: ChatSettings = {
  mode: 'auto',
  model: null,
  routerMode: 'quality',
  maxTokens: 8192,
  temperature: 0.7,
  reasoningEffort: 'high',
  systemPrompt: null,
};

const metadata = {
  selected_model: 'zai-org/GLM-5.3',
  task_type: 'coding',
  selected_mode: 'quality',
  fallback_models: ['deepseek-ai/DeepSeek-V4-Pro'],
  recommendation_id: 'bab0a8bb-195f-49c5-8f9c-016da0d89cc8',
};

const routings = (parts: StreamPart[]) => parts.flatMap((p) => (p.type === 'routing' ? [p.routing] : []));

describe('GMI Router', () => {
  it('builds a plain-chat body: messages + mode + stream (no temperature/max_tokens)', () => {
    expect(wireBody({ route: 'router', model: null, settings, history: [{ role: 'user', content: 'Write a regex' }] })).toEqual({
      messages: [{ role: 'user', content: 'Write a regex' }],
      mode: 'quality',
      stream: true,
    });
  });

  it('streams OpenAI chunks, reports the routed model early, then the routing_metadata event', async () => {
    const res = sseResponse([
      sseData(chunk({ content: 'Use ' })),
      sseData(chunk({ content: '`^a+$`' })),
      `event: routing_metadata\ndata: ${JSON.stringify(metadata)}\n\n`,
      sseData('[DONE]'),
    ]);
    const parts = await collectParts(res, new RouterStreamParser({ mode: 'quality', recommendationId: 'from-header' }));
    expect(textOf(parts, 'content')).toBe('Use `^a+$`');
    const r = routings(parts);
    // Provisional (from chunk.model + header) and final (from routing_metadata).
    expect(r[0]).toEqual({ selectedModel: 'zai-org/GLM-5.3', taskType: null, mode: 'quality', fallbackModels: [], recommendationId: 'from-header' });
    expect(r[r.length - 1]).toEqual({
      selectedModel: 'zai-org/GLM-5.3',
      taskType: 'coding',
      mode: 'quality',
      fallbackModels: ['deepseek-ai/DeepSeek-V4-Pro'],
      recommendationId: 'bab0a8bb-195f-49c5-8f9c-016da0d89cc8',
    });
    // The first part is the routing info, so the UI can label the reply before any text arrives.
    expect(parts[0]?.type).toBe('routing');
  });

  it('accepts routing_metadata embedded in a data object (wrapped or flat)', async () => {
    const wrapped = await collectParts(
      sseResponse([sseData({ routing_metadata: metadata }), sseData(chunk({ content: 'Hi' }, { model: 'gmi-router' })), sseData('[DONE]')]),
      new RouterStreamParser({ mode: 'balanced', recommendationId: null }),
    );
    expect(routings(wrapped)).toHaveLength(1);
    expect(routings(wrapped)[0]?.taskType).toBe('coding');
    expect(textOf(wrapped, 'content')).toBe('Hi');

    const flat = await collectParts(
      sseResponse([sseData(chunk({ content: 'x' }, { model: 'gmi-router' })), sseData({ type: 'routing_metadata', ...metadata })]),
      new RouterStreamParser({ mode: 'balanced', recommendationId: null }),
    );
    // "gmi-router" has no provider prefix, so it is not taken as the routed model.
    expect(routings(flat).map((r) => r.selectedModel)).toEqual(['zai-org/GLM-5.3']);
  });

  it('handles non-stream style objects and reasoning chunks', async () => {
    const parts = await collectParts(
      sseResponse([
        sseData(chunk({ reasoning_content: 'hmm' })),
        sseData({ model: 'deepseek-ai/DeepSeek-V4-Flash', message: { role: 'assistant', content: 'Answer' }, routing_metadata: { ...metadata, selected_model: 'deepseek-ai/DeepSeek-V4-Flash' } }),
        sseData('[DONE]'),
      ]),
      new RouterStreamParser({ mode: 'balanced', recommendationId: null }),
    );
    expect(textOf(parts, 'reasoning')).toBe('hmm');
    expect(textOf(parts, 'content')).toBe('Answer');
    expect(routings(parts).at(-1)?.selectedModel).toBe('deepseek-ai/DeepSeek-V4-Flash');
  });

  it('keeps partial output and reports the error event', async () => {
    const parts = await collectParts(
      sseResponse([sseData(chunk({ content: 'Partial ' })), `event: error\ndata: ${JSON.stringify({ error: { message: 'Provider failed mid-stream' } })}\n\n`, sseData(chunk({ content: 'never' }))]),
      new RouterStreamParser({ mode: 'balanced', recommendationId: null }),
    );
    expect(textOf(parts, 'content')).toBe('Partial ');
    const error = parts.find((p) => p.type === 'error');
    expect(error && error.type === 'error' ? error.error.message : null).toBe('Provider failed mid-stream');
  });

  it('accepts error events with a plain message or plain text', async () => {
    const parts = await collectParts(sseResponse(['event: error\ndata: upstream exploded\n\n']), new RouterStreamParser({ mode: 'cost', recommendationId: null }));
    const error = parts.find((p) => p.type === 'error');
    expect(error && error.type === 'error' ? error.error.message : null).toBe('upstream exploded');
  });

  it('reads a JSON router response sent without a JSON content type', async () => {
    const body = JSON.stringify({ model: 'zai-org/GLM-5.3', message: { role: 'assistant', content: 'Untyped.' }, routing_metadata: metadata });
    for (const headers of [{ 'content-type': 'text/plain' }, {} as Record<string, string>]) {
      const res = new Response(body, { status: 200, headers });
      if (!('content-type' in headers)) res.headers.delete('content-type');
      const parts = await collectParts(res, new RouterStreamParser({ mode: 'balanced', recommendationId: null }));
      expect(textOf(parts, 'content')).toBe('Untyped.');
      expect(routings(parts).at(-1)?.taskType).toBe('coding');
    }
  });

  it('reports a web page answered with status 200 as an upstream error', async () => {
    const res = new Response('<!DOCTYPE html><html><body>Just a moment...</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(collectParts(res, new RouterStreamParser({ mode: 'balanced', recommendationId: null }))).rejects.toMatchObject({ code: 'upstream' });
  });

  it('reads a plain JSON (non-SSE) router response', async () => {
    const parts = await collectParts(
      jsonResponse({ model: 'zai-org/GLM-5.3', message: { role: 'assistant', content: 'Done.' }, routing_metadata: metadata, usage: { prompt_tokens: 9, completion_tokens: 3 } }),
      new RouterStreamParser({ mode: 'balanced', recommendationId: null }),
    );
    expect(textOf(parts, 'content')).toBe('Done.');
    expect(routings(parts).at(-1)).toMatchObject({ selectedModel: 'zai-org/GLM-5.3', taskType: 'coding', mode: 'quality' });
    expect(parts).toContainEqual({ type: 'finish', reason: 'stop' });
    expect(parts.find((p) => p.type === 'usage')).toBeTruthy();
  });
});
