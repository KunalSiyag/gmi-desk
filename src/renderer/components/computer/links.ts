// Terminal links and titles (compute.md §8.2, threat T7). Remote output is hostile: a link is only ever opened after
// a confirmation that shows the whole URL, only https, and through main's openExternal; the title (OSC 0/2) is plain
// text, capped.

/** Longest URL the link provider recognises (longer runs are not links, and would fill the confirmation). */
export const LINK_MAX_CHARS = 2048;
/** Longest terminal title shown (§8.2). */
export const TITLE_MAX_CHARS = 80;

export interface FoundLink {
  /** Index of the first character in the line text. */
  start: number;
  /** Index after the last character. */
  end: number;
  url: string;
}

// http(s) only; stops at whitespace, quotes, angle brackets, backticks and control characters.
const URL_RE = /https?:\/\/[^\s"'<>`\u0000-\u001f\u007f]+/g;
const TRAILING = /[.,;:!?'"]+$/;

/** Drops trailing punctuation and closing brackets that are not part of the URL ("(see https://x.y/a)."). */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    while (url.endsWith(close) && count(url, close) > count(url, open)) url = url.slice(0, -1).replace(TRAILING, '');
  }
  return url;
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/** http(s) URLs in one line of terminal text. */
export function findLinks(line: string): FoundLink[] {
  const out: FoundLink[] = [];
  for (const match of line.matchAll(URL_RE)) {
    const url = trimUrl(match[0]);
    if (url.length <= 'https://'.length || url.length > LINK_MAX_CHARS) continue;
    out.push({ start: match.index, end: match.index + url.length, url });
  }
  return out;
}

/** What the confirmation does with a link the user clicked. */
export type LinkVerdict = { ok: true; url: string; host: string } | { ok: false; url: string; reason: string };

/**
 * Only plain https URLs open (main's openExternal is https-only too). Credentials in the URL are refused: they are a
 * classic way to make `https://bank.example@evil.example/` look like the first host.
 */
export function checkLink(text: string): LinkVerdict {
  const url = text.trim();
  if (url.length > LINK_MAX_CHARS) return { ok: false, url: url.slice(0, LINK_MAX_CHARS), reason: 'This link is too long to open.' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, reason: 'This is not a valid link.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, url, reason: 'Only https links open from the terminal.' };
  if (parsed.username || parsed.password) return { ok: false, url, reason: 'Links with a user name or password are not opened.' };
  if (!parsed.hostname) return { ok: false, url, reason: 'This link has no host.' };
  return { ok: true, url: parsed.href, host: parsed.host };
}

/**
 * A terminal title as plain text: control and bidi-override characters removed, whitespace collapsed, at most 80
 * characters. React renders it as text, so markup in it is inert either way.
 */
export function cleanTitle(title: string): string {
  const flat = title
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > TITLE_MAX_CHARS ? `${flat.slice(0, TITLE_MAX_CHARS - 1)}…` : flat;
}
