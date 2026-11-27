import { GMI_URLS, isAllowedExternalUrl } from '@shared/app';
import { GmiError } from '@shared/contracts/errors';
import { DOCS_QUERY_LIMITS, type DocHit, type DocsApi } from '@shared/contracts/usage';
import type { McpGateway } from '../../core/services';
import { createTtlCache, isRecord } from './util';

export const DOCS_DEFAULT_LIMIT = 8;
export const DOCS_MAX_LIMIT = 10;
export const EXCERPT_MAX_CHARS = 600;
const CODE_MAX_LINES = 10;
const CODE_MAX_LINE_CHARS = 160;
const DOCS_TTL_MS = 5 * 60_000;

/*
 * GMI's search_docs returns raw Mintlify MDX: <img srcset=…>, <Frame>, <Card>, <Note>, tables, fenced code with
 * `theme={null}` meta, and long text that GMI itself cuts with " [truncated]" (sometimes inside a tag).
 * cleanExcerpt turns that into short plain text: paragraphs separated by blank lines, list/table rows on their own
 * lines, inline code kept in backticks and code blocks kept as ``` fences. The result is display data only.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', rarr: '→', larr: '←' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Attribute body of a JSX/HTML tag: quoted strings and {expressions} may contain anything but nesting. */
const ATTRS = String.raw`(?:[^<>"'{}]|"[^"]*"|'[^']*'|\{[^{}]*\})*`;
// Closing tags anywhere; opening tags only when not glued to a word: `string<uuid>` / `enum<string>` in API
// references are types, not tags.
const TAG_RE = new RegExp(String.raw`<\/([A-Za-z][\w.:-]*)\s*>|(?<![\w])<([A-Za-z][\w.:-]*)(?:${ATTRS})\/?>`, 'g');
const TITLED_RE = new RegExp(String.raw`<(Card|Step|Tab|Accordion|Update|Expandable|ParamField|ResponseField|Callout)\b(${ATTRS})\/?>`, 'g');
const CALLOUT_RE = /<(Note|Tip|Warning|Info|Check|Danger|Callout)\b[^<>]*>/g;
const DROP_ELEMENT_RE = /<(script|style|svg|video|audio|iframe|picture|object|noscript|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const VOID_MEDIA_RE = /<(img|image|source|track|embed|input|meta|link|area|wbr)\b[^>]*(?:>|$)/gi;
const BREAK_RE = /<(br|hr)\b[^>]*>/gi;
const BLOCK_TAGS = new Set([
  'frame', 'cardgroup', 'card', 'steps', 'step', 'tabs', 'tab', 'accordiongroup', 'accordion', 'codegroup', 'columns',
  'column', 'expandable', 'paramfield', 'responsefield', 'update', 'note', 'tip', 'warning', 'info', 'check', 'danger',
  'callout', 'div', 'p', 'section', 'article', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'blockquote', 'figure', 'figcaption', 'details', 'summary', 'pre', 'center',
]);
const CALLOUT_LABELS: Record<string, string> = { Note: 'Note: ', Tip: 'Tip: ', Warning: 'Warning: ', Danger: 'Warning: ' };
const IMAGE_URL_LINE_RE = /^(?:https?:\/\/|\/)\S+\.(?:png|jpe?g|gif|webp|svg|avif|mp4|webm)(?:\?\S*)?$/i;

function attrValue(attrs: string, names: string[]): string | null {
  for (const name of names) {
    const m = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'\`]([^"'\`]*)["'\`]\s*\})`).exec(attrs);
    const value = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
    if (value) return value;
  }
  return null;
}

type Block = { kind: 'text'; lines: string[] } | { kind: 'code'; lang: string; lines: string[] };

/** Splits fenced code blocks (``` or ~~~, possibly unclosed when GMI truncated the text) from prose. */
function splitFences(text: string): Array<{ kind: 'text'; text: string } | { kind: 'code'; lang: string; lines: string[] }> {
  const out: Array<{ kind: 'text'; text: string } | { kind: 'code'; lang: string; lines: string[] }> = [];
  let prose: string[] = [];
  let code: { fence: string; lang: string; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    if (code) {
      if (line.trim().startsWith(code.fence) && line.trim().replace(/[`~]/g, '') === '') {
        out.push({ kind: 'code', lang: code.lang, lines: code.lines });
        code = null;
      } else code.lines.push(line);
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (open) {
      if (prose.length) out.push({ kind: 'text', text: prose.join('\n') });
      prose = [];
      const lang = (open[2] ?? '').replace(/[^\w+#.-]/g, '').slice(0, 20);
      code = { fence: open[1] ?? '```', lang, lines: [] };
      continue;
    }
    prose.push(line);
  }
  if (code) out.push({ kind: 'code', lang: code.lang, lines: code.lines });
  if (prose.length) out.push({ kind: 'text', text: prose.join('\n') });
  return out;
}

/** MDX/HTML → markdown-ish plain text (tags removed, components flattened, media dropped). */
function stripMarkup(input: string, truncated = false): string {
  let t = input
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*import\s+[\w{}*\s,]+\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?:const|default|function)\b.*$/gm, '')
    .replace(/<(https?:\/\/[^\s<>]+)>/g, '$1')
    .replace(DROP_ELEMENT_RE, '')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${inner.replace(/<[^>]*>/g, '')}\``)
    .replace(VOID_MEDIA_RE, '')
    .replace(BREAK_RE, '\n')
    .replace(CALLOUT_RE, (_m, name: string) => `\n\n${CALLOUT_LABELS[name] ?? ''}`)
    .replace(TITLED_RE, (_m, _name: string, attrs: string) => {
      const title = attrValue(attrs, ['title', 'label', 'name', 'path', 'field']);
      return title ? `\n\n${title}: ` : '\n\n';
    })
    .replace(TAG_RE, (_m, closing: string | undefined, opening: string | undefined) =>
      BLOCK_TAGS.has((closing ?? opening ?? '').toLowerCase()) ? '\n\n' : '',
    )
    .replace(/\{\s*["'`]\s*["'`]\s*\}/g, ' ');
  // A tag GMI cut in half (`<Card title="…" href="… [truncated]`).
  if (truncated) t = t.replace(/<\/?[A-Za-z][^<>]*$/, '');
  // Markdown images (inline and reference style).
  return t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');
}

/** Inline markdown → text; inline code spans are protected and kept in backticks. */
function inlineText(line: string): string {
  const spans: string[] = [];
  let t = line.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    spans.push(code);
    return `\u0000${spans.length - 1}\u0000`;
  });
  t = t
    .replace(/\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // A link GMI's truncation cut in half: `[Kling V3 Text To Video](/gmi-studio/nodes/video/kl`.
    .replace(/\[([^\]]*)\]\([^)\s]*$/, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*\\])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|$<>~])/g, '$1');
  t = decodeEntities(t);
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `\`${spans[Number(i)] ?? ''}\``);
}

const normalizeForCompare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A plain line continues the previous one (soft wrap) when it is indented component content, or when the previous
 * line does not end a sentence and this one starts lower-case or with inline code. Otherwise the line break is kept
 * ("Summary: …" / "Description: …" rows in API reference excerpts).
 */
function continuesLine(prev: string, next: string, indented: boolean): boolean {
  return indented || (!/[.!?:;]$/.test(prev) && /^[a-z0-9(`]/.test(next));
}

/** Prose → paragraphs. Soft-wrapped lines are joined; list items and table rows keep their own line. */
function proseBlocks(text: string, truncated: boolean): Block[] {
  // Inline code is literal: keep `<your-api-key>` out of the tag stripping.
  const spans: string[] = [];
  const shielded = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    spans.push(code);
    return `\u0001${spans.length - 1}\u0001`;
  });
  const restore = (line: string) => line.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => `\`${spans[Number(i)] ?? ''}\``);

  const blocks: Block[] = [];
  let current: string[] | null = null;
  let lastKind: 'text' | 'item' = 'text';
  for (const raw of stripMarkup(shielded, truncated).split('\n').map(restore)) {
    const indented = /^\s{2,}\S/.test(raw);
    let line = raw.replace(/[\s\u200b]+/g, ' ').trim();
    if (!line || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line) || IMAGE_URL_LINE_RE.test(line)) {
      current = null;
      continue;
    }
    if (/^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue; // table separator row
    const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'text', lines: [inlineText(heading[1] ?? '')] });
      current = null;
      continue;
    }
    let kind: 'text' | 'item' = 'text';
    let m: RegExpExecArray | null;
    if (line.startsWith('|')) {
      const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => inlineText(c.trim())).filter(Boolean);
      if (cells.length === 0) continue;
      line = cells.join(' · ');
      kind = 'item';
    } else if ((m = /^(?:[*+-]|•)\s+(.*)$/.exec(line))) {
      // One level of nesting stays visible: "  ◦ First top-up ≥ $50 → +$3 credit".
      line = `${indented ? '  ◦' : '•'} ${inlineText(m[1] ?? '')}`;
      kind = 'item';
    } else if ((m = /^(\d{1,3})[.)]\s+(.*)$/.exec(line))) {
      line = `${indented ? '  ' : ''}${m[1]}. ${inlineText(m[2] ?? '')}`;
      kind = 'item';
    } else {
      line = inlineText(line.replace(/^>\s?/, '').trim());
      if (!line) continue;
    }
    const prev = current?.[current.length - 1];
    if (!current || prev === undefined) {
      current = [line];
      blocks.push({ kind: 'text', lines: current });
    } else if (kind === 'text' && (lastKind === 'text' ? continuesLine(prev, line, indented) : indented)) {
      current[current.length - 1] = `${prev} ${line}`;
    } else {
      current.push(line);
    }
    lastKind = kind;
  }
  return blocks;
}

function withEllipsis(text: string): string {
  return text.endsWith('```') ? `${text}\n\n…` : `${text.replace(/[\s.,;:]+$/, '')}…`;
}

function codeBlock(lang: string, rawLines: string[]): Block | null {
  const lines = rawLines.map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  if (lines.length === 0) return null;
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)?.[0].length ?? 0));
  let out = lines.map((l) => {
    const s = l.slice(indent);
    return s.length > CODE_MAX_LINE_CHARS ? `${s.slice(0, CODE_MAX_LINE_CHARS - 1)}…` : s;
  });
  if (out.length > CODE_MAX_LINES) out = [...out.slice(0, CODE_MAX_LINES), '…'];
  return { kind: 'code', lang, lines: out };
}

function renderBlock(block: Block): string {
  return block.kind === 'code' ? `\`\`\`${block.lang}\n${block.lines.join('\n')}\n\`\`\`` : block.lines.join('\n');
}

/** Cuts at a word boundary and never leaves half an inline code span. */
function cutText(text: string, room: number): string {
  let cut = text.slice(0, Math.max(0, room - 1));
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace);
  if ((cut.match(/`/g)?.length ?? 0) % 2 === 1) cut = cut.slice(0, cut.lastIndexOf('`'));
  // Never end on a bare list marker ("•…").
  cut = cut.replace(/\n[ \t]*(?:[•◦]|\d{1,3}\.)?[ \t]*$/, '');
  return `${cut.replace(/[\s,;:([{–—-]+$/, '')}…`;
}

/**
 * Raw Mintlify excerpt → readable plain text of at most ~maxChars characters.
 * Drops images/media and component markup, keeps code fences (without `theme={null}` meta), removes GMI's
 * " [truncated]" marker, and drops a leading heading that only repeats the hit's title.
 */
export function cleanExcerpt(raw: unknown, opts: { title?: string | null; maxChars?: number } = {}): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const maxChars = opts.maxChars ?? EXCERPT_MAX_CHARS;
  let text = raw.replace(/\r\n?/g, '\n');
  const gmiTruncated = /\s*\[truncated\]\s*$/i.test(text);
  if (gmiTruncated) text = text.replace(/\s*\[truncated\]\s*$/i, '');
  // When GMI's cut fell inside a tag we drop anyway (an <img srcset=…>), no visible text was lost.
  const lostVisibleText = gmiTruncated && !/<[A-Za-z][^<>]*$/.test(text);

  const blocks: Block[] = [];
  const segments = splitFences(text);
  segments.forEach((segment, i) => {
    if (segment.kind === 'code') {
      const block = codeBlock(segment.lang, segment.lines);
      if (block) blocks.push(block);
    } else blocks.push(...proseBlocks(segment.text, gmiTruncated && i === segments.length - 1));
  });

  // A first line that only repeats the hit's title ("## Payment settings", "Create an API key\n…") is noise.
  const first = blocks[0];
  if (opts.title && first?.kind === 'text' && normalizeForCompare(first.lines[0] ?? '') === normalizeForCompare(opts.title)) {
    first.lines.shift();
    if (first.lines.length === 0) blocks.shift();
  }

  const out: string[] = [];
  let used = 0;
  let cut = false;
  for (const block of blocks) {
    const sep = out.length ? 2 : 0;
    const rendered = renderBlock(block);
    if (used + sep + rendered.length <= maxChars) {
      out.push(rendered);
      used += sep + rendered.length;
      continue;
    }
    cut = true;
    const room = maxChars - used - sep;
    if (block.kind === 'code') {
      const fenceCost = block.lang.length + 8;
      const lines: string[] = [];
      let size = fenceCost;
      for (const line of block.lines) {
        if (size + line.length + 1 > room) break;
        lines.push(line);
        size += line.length + 1;
      }
      if (lines.length) out.push(renderBlock({ kind: 'code', lang: block.lang, lines: [...lines, '…'] }));
      else if (out.length) out[out.length - 1] = withEllipsis(out[out.length - 1] ?? '');
    } else if (room >= 40) {
      out.push(cutText(rendered, room));
    } else if (out.length) {
      out[out.length - 1] = withEllipsis(out[out.length - 1] ?? '');
    }
    break;
  }
  if (!cut && lostVisibleText && out.length) out[out.length - 1] = withEllipsis(out[out.length - 1] ?? '');
  return out.join('\n\n').trim();
}

/** Titles may carry markdown or escapes too. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = inlineText(stripMarkup(raw).replace(/^#{1,6}\s+/, '')).replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : null;
}

/** https URLs only; site-relative paths resolve against the docs site. */
export function resolveDocUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim(), `${GMI_URLS.docs}/`);
    return isAllowedExternalUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    const words = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'GMI Cloud docs';
  } catch {
    return 'GMI Cloud docs';
  }
}

/** MCP search_docs → DocHit[]: cleaned excerpts, https links only, duplicates removed. */
export function normalizeDocHits(raw: unknown, limit = DOCS_MAX_LIMIT): DocHit[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.results) ? raw.results : null;
  if (!list) throw new GmiError('upstream', 'GMI returned unexpected docs search results.');
  const hits: DocHit[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const url = resolveDocUrl(item.url ?? item.link);
    if (!url) continue;
    const title = cleanTitle(item.title) ?? titleFromUrl(url);
    const excerpt = cleanExcerpt(item.excerpt ?? item.content ?? item.snippet, { title });
    const page = url.split('#')[0] ?? url;
    const keys = [url, `${page}\n${excerpt}`];
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    hits.push({ title, url, excerpt });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Trimmed, whitespace-collapsed query of 2–300 characters (else invalid_input). */
export function validateDocsQuery(query: unknown): string {
  const q = typeof query === 'string' ? query.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (q.length < DOCS_QUERY_LIMITS.min) {
    throw new GmiError('invalid_input', `Type at least ${DOCS_QUERY_LIMITS.min} characters to search the docs.`);
  }
  if (q.length > DOCS_QUERY_LIMITS.max) {
    throw new GmiError('invalid_input', `Keep the search under ${DOCS_QUERY_LIMITS.max} characters.`);
  }
  return q;
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DOCS_DEFAULT_LIMIT;
  return Math.min(DOCS_MAX_LIMIT, Math.max(1, Math.round(limit)));
}

export interface DocsService {
  api: DocsApi;
  clear(): void;
}

export function createDocsService(mcp: McpGateway, now: () => Date): DocsService {
  const cache = createTtlCache<string, DocHit[]>({ ttlMs: DOCS_TTL_MS, now: () => now().getTime(), maxEntries: 50 });
  return {
    api: {
      async search(query: string, limit?: number) {
        const q = validateDocsQuery(query);
        const n = clampLimit(limit);
        return cache.get(`${n}\u0000${q.toLowerCase()}`, async () =>
          normalizeDocHits(await mcp.callTool('search_docs', { query: q, limit: n }), n),
        );
      },
    },
    clear: () => cache.clear(),
  };
}
