import { describe, expect, it } from 'vitest';
import { ThinkTagSplitter, type ThinkSegment } from '@main/services/gateway/parsers/think';

function run(chunks: string[]): { content: string; reasoning: string; segments: ThinkSegment[] } {
  const splitter = new ThinkTagSplitter();
  const segments: ThinkSegment[] = [];
  for (const c of chunks) segments.push(...splitter.push(c));
  segments.push(...splitter.end());
  return {
    content: segments.filter((s) => s.channel === 'content').map((s) => s.text).join(''),
    reasoning: segments.filter((s) => s.channel === 'reasoning').map((s) => s.text).join(''),
    segments,
  };
}

describe('ThinkTagSplitter', () => {
  it('routes a <think> block to reasoning and trims the whitespace around the tags', () => {
    const out = run(['<think>\nLet me plan.\n</think>\n\nHello!']);
    expect(out.reasoning).toBe('Let me plan.\n');
    expect(out.content).toBe('Hello!');
  });

  it('handles tags split across chunk boundaries, one character at a time', () => {
    const text = 'Intro <think>step one, step two</think> answer <b>bold</b> done';
    const out = run(text.split(''));
    expect(out.reasoning).toBe('step one, step two');
    expect(out.content).toBe('Intro answer <b>bold</b> done');
  });

  it('handles awkward splits right inside both tags', () => {
    const out = run(['<th', 'ink>a', 'b</th', 'in', 'k>c', 'd']);
    expect(out.reasoning).toBe('ab');
    expect(out.content).toBe('cd');
  });

  it('keeps text that only looks like the start of a tag', () => {
    const out = run(['if a <', ' b then <t', 'able> x <thin']);
    expect(out.content).toBe('if a < b then <table> x <thin');
    expect(out.reasoning).toBe('');
  });

  it('supports several think blocks', () => {
    const out = run(['<think>one</think>A<think>two</think>B']);
    expect(out.reasoning).toBe('onetwo');
    expect(out.content).toBe('AB');
  });

  it('treats an unterminated think block as reasoning at end of stream', () => {
    const out = run(['<think>still thinking', ' when the stream ended</']);
    expect(out.reasoning).toBe('still thinking when the stream ended</');
    expect(out.content).toBe('');
  });

  it('drops a stray closing tag', () => {
    const out = run(['answer</think> more']);
    expect(out.content).toBe('answer more');
  });

  it('passes plain text straight through without holding it back', () => {
    const splitter = new ThinkTagSplitter();
    expect(splitter.push('Hello world')).toEqual([{ channel: 'content', text: 'Hello world' }]);
    expect(splitter.push(' and <')).toEqual([{ channel: 'content', text: ' and ' }]);
    expect(splitter.end()).toEqual([{ channel: 'content', text: '<' }]);
  });
});
