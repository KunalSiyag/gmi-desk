import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { readSse, SSE_MAX_LINE_CHARS, SseParser } from '@shared/lib/sse';
import { sseResponse } from '../helpers/fetch';

describe('SseParser', () => {
  it('parses events split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"a"')).toEqual([]);
    expect(p.push(':1}\n')).toEqual([]);
    const events = p.push('\n');
    expect(events).toEqual([{ event: null, data: '{"a":1}', id: null, retry: null }]);
  });

  it('handles CRLF, CR split at chunk boundary, comments and named events', () => {
    const p = new SseParser();
    const out = [
      ...p.push(': keep-alive\r\nevent: routing_metadata\r\ndata: {"x":1}\r'),
      ...p.push('\n\r\ndata: second\n\n'),
    ];
    expect(out).toEqual([
      { event: 'routing_metadata', data: '{"x":1}', id: null, retry: null },
      { event: null, data: 'second', id: null, retry: null },
    ]);
  });

  it('joins multi-line data and keeps id/retry', () => {
    const p = new SseParser();
    const out = p.push('id: 7\nretry: 1500\ndata: line1\ndata: line2\n\n');
    expect(out).toEqual([{ event: null, data: 'line1\nline2', id: '7', retry: 1500 }]);
  });

  it('flushes a final event without a trailing blank line', () => {
    const p = new SseParser();
    expect(p.push('data: [DONE]')).toEqual([]);
    expect(p.flush()).toEqual([{ event: null, data: '[DONE]', id: null, retry: null }]);
  });

  it('ignores blank dispatches without data', () => {
    const p = new SseParser();
    expect(p.push('event: ping\n\n\n')).toEqual([]);
  });
});

describe('SseParser on large lines (finding foundation-7)', () => {
  const CHUNK = 16 * 1024;
  const pushInChunks = (p: SseParser, text: string) => {
    const events = [];
    for (let i = 0; i < text.length; i += CHUNK) events.push(...p.push(text.slice(i, i + CHUNK)));
    return events;
  };

  it('parses a 4 MiB data line arriving in 16 KiB chunks in linear time', () => {
    const payload = 'x'.repeat(4 * 1024 * 1024);
    const p = new SseParser();
    const started = performance.now();
    const events = pushInChunks(p, `data: ${payload}\n\n`);
    const elapsed = performance.now() - started;
    expect(events).toHaveLength(1);
    expect(events[0]!.data.length).toBe(payload.length);
    // The old parser rescanned the whole buffer on every chunk: ~3.4 s for this input.
    expect(elapsed).toBeLessThan(400);
  });

  it('handles CRLF split across the chunk boundary of a long line', () => {
    const p = new SseParser();
    const long = 'y'.repeat(100_000);
    const out = [...pushInChunks(p, `data: ${long}\r`), ...p.push('\n\r\n'), ...p.push('data: next\r'), ...p.push('\n\n')];
    expect(out.map((e) => e.data.length)).toEqual([long.length, 4]);
  });

  it('fails the stream with an upstream error past the line limit', () => {
    const p = new SseParser({ maxLineChars: 1000 });
    expect(() => pushInChunks(p, `data: ${'z'.repeat(2000)}`)).toThrow(GmiError);
    try {
      new SseParser({ maxLineChars: 1000 }).push(`data: ${'z'.repeat(2000)}`);
    } catch (error) {
      expect(error).toMatchObject({ code: 'upstream' });
    }
  });

  it('fails past the event limit when many data lines add up', () => {
    const p = new SseParser({ maxLineChars: 1000 });
    expect(() => p.push('data: 0123456789\n'.repeat(200))).toThrow(GmiError);
    // Normal-sized traffic is unaffected by the limit.
    const ok = new SseParser({ maxLineChars: 1000 });
    expect(ok.push('data: 0123456789\n\n'.repeat(200))).toHaveLength(200);
  });

  it('defaults to an 8 MiB limit', () => {
    expect(SSE_MAX_LINE_CHARS).toBe(8 * 1024 * 1024);
  });
});

describe('readSse', () => {
  it('reads a streamed response body', async () => {
    const res = sseResponse(['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n']);
    const data: string[] = [];
    for await (const ev of readSse(res.body!)) data.push(ev.data);
    expect(data).toEqual(['{"choices":[{"delta":{"content":"Hel"}}]}', '{"choices":[{"delta":{"content":"lo"}}]}', '[DONE]']);
  });

  it('rejects with GmiError(upstream) when the upstream sends an endless line', async () => {
    const big = 'q'.repeat(1024 * 1024);
    const blocks = Array.from({ length: 10 }, (_, i) => (i === 0 ? `data: ${big}` : big));
    const res = sseResponse(blocks);
    const consume = async () => {
      for await (const _ev of readSse(res.body!)) {
        // no events: the line never ends
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: 'upstream' });
  });
});
