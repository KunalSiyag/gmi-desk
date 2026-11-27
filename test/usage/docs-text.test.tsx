// Docs page text helpers (src/renderer/pages/docs/text.ts) and the excerpt's highlighting, rendered with
// react-dom/server (node environment, no DOM).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Excerpt } from '@renderer/pages/docs/Excerpt';
import { docBreadcrumb, highlightTerms, splitHighlights } from '@renderer/pages/docs/text';

describe('docBreadcrumb', () => {
  it('lists the folders above the page, humanised (the page is the title)', () => {
    expect(docBreadcrumb('https://docs.gmicloud.ai/inference-engine/gmi-router/gmi-router-overview')).toEqual(['inference engine', 'gmi router']);
    expect(docBreadcrumb('https://docs.gmicloud.ai/index')).toEqual([]);
    expect(docBreadcrumb('https://docs.gmicloud.ai/')).toEqual([]);
  });

  it('keeps the page when the hit is a section of it (#fragment)', () => {
    expect(docBreadcrumb('https://docs.gmicloud.ai/mcp/gmi-mcp-server#step-3-confirm-it-worked')).toEqual(['mcp', 'gmi mcp server']);
  });

  it('never throws on odd input', () => {
    expect(docBreadcrumb('not a url')).toEqual([]);
    expect(docBreadcrumb('https://docs.gmicloud.ai/a%E0%A4%A/b')).toEqual(['a%E0%A4%A']);
  });
});

describe('highlightTerms', () => {
  it('drops stop words and one-letter words, stems plurals lightly, longest first', () => {
    expect(highlightTerms('How do I use chat completions?')).toEqual(['completion', 'chat']);
    expect(highlightTerms('rate limits for video models')).toEqual(['limit', 'video', 'model', 'rate']);
    expect(highlightTerms('speed')).toEqual(['speed']);
    expect(highlightTerms('  ')).toEqual([]);
  });

  it('keeps technical tokens whole', () => {
    expect(highlightTerms('max_tokens gpt-5.4')).toEqual(['max_token', 'gpt-5.4']);
  });
});

describe('splitHighlights', () => {
  it('marks whole words that start with a term, case-insensitively', () => {
    const parts = splitHighlights('Chat completions: one completion per chat. WeChat is not.', ['completion', 'chat']);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Chat', 'completions', 'completion', 'chat']);
    expect(parts.map((p) => p.text).join('')).toBe('Chat completions: one completion per chat. WeChat is not.');
  });

  it('escapes regex characters in terms and handles no terms', () => {
    expect(splitHighlights('use gpt-5.4 or gpt-5x4', ['gpt-5.4']).filter((p) => p.hit).map((p) => p.text)).toEqual(['gpt-5.4']);
    expect(splitHighlights('plain', [])).toEqual([{ text: 'plain', hit: false }]);
    expect(splitHighlights('', ['x'])).toEqual([]);
  });
});

describe('Excerpt', () => {
  const text = 'Send a `chat` request.\n\n```python\nchat = client.chat()\n```\n\nChat replies stream.';

  it('marks the search words in prose and inline code, never inside code blocks', () => {
    const html = renderToStaticMarkup(<Excerpt text={text} terms={['chat']} />);
    expect(html.match(/<mark/g)?.length).toBe(2);
    expect(html).toContain('<code class="rounded bg-muted px-1 py-px font-mono text-[0.92em] text-foreground"><mark');
    expect(html).toMatch(/<pre[^>]*><code>chat = client\.chat\(\)<\/code><\/pre>/);
    // Brand ink, never lime text on light surfaces.
    expect(html).toContain('text-primary-ink');
    expect(html).not.toMatch(/\btext-primary\b(?!-)/);
  });

  it('renders plain text without terms', () => {
    expect(renderToStaticMarkup(<Excerpt text="Chat replies stream." />)).not.toContain('<mark');
  });
});
