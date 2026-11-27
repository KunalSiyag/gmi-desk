// Docs page text helpers. Pure (no React, no DOM) so tests can check them.

/** Words a search ignores when highlighting (they match everywhere and say nothing). */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'into', 'is',
  'it', 'my', 'of', 'on', 'or', 'the', 'to', 'use', 'what', 'when', 'where', 'which', 'with', 'you', 'your',
]);

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/**
 * Where a docs hit sits, as humanised path folders ("inference engine", "gmi router"). The page itself is the
 * hit's title, so it is left out, unless the hit is a section of that page (a #fragment): then the page is a
 * parent too.
 */
export function docBreadcrumb(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const parts = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decode(part).replace(/\.\w+$/, '').replace(/[-_]+/g, ' ').trim())
    .filter(Boolean);
  return parsed.hash.length > 1 ? parts : parts.slice(0, -1);
}

/** The words of a query worth highlighting, longest first (so "completions" wins over "complet…" overlaps). */
export function highlightTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  // A light stem, so "completions" also marks "completion" and "limits" marks "limited" ("speed" stays whole).
  const stems = words.map((w) => {
    if (w.length < 5) return w;
    const stem = w.replace(/(?:ies|es|s|ing|ed)$/, '');
    return stem.length >= 4 ? stem : w;
  });
  return [...new Set(stems)].sort((a, b) => b.length - a.length);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface TextPart {
  text: string;
  hit: boolean;
}

/**
 * Splits text into plain and highlighted parts: a hit starts at a word boundary and runs to the end of that word,
 * so "complet" marks "completions" and "chat" marks "chat" but not "wechat".
 */
export function splitHighlights(text: string, terms: readonly string[]): TextPart[] {
  if (!text || terms.length === 0) return text ? [{ text, hit: false }] : [];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.map(escapeRegExp).join('|')})[\\p{L}\\p{N}_]*`, 'giu');
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), hit: false });
    parts.push({ text: match[0], hit: true });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
