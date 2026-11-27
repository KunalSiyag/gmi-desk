// C2-D: the terminal around xterm (compute.md §8.2, §8.7, T7): links and titles from hostile output, the key routing
// between shell and app, the theme from tokens in both themes, and the banners for every shell state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedExternalUrl } from '@shared/app';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import { SessionBanner, sessionBlocked, TerminalBanners } from '@renderer/components/computer/banners';
import { checkLink, cleanTitle, findLinks, LINK_MAX_CHARS, TITLE_MAX_CHARS } from '@renderer/components/computer/links';
import { ANSI_DARK, ANSI_LIGHT, DEFAULT_TOKENS, terminalTheme } from '@renderer/components/computer/terminal-theme';
import { terminalCanType, terminalKeyRoute, TerminalView } from '@renderer/components/computer/TerminalView';
import { expectDesignRules, installBridge, removeBridge, render, sandbox, session, text } from './ui-fixtures';

beforeEach(() => void installBridge());
afterEach(() => removeBridge());

describe('links in terminal output (T7)', () => {
  it('finds http(s) URLs and trims trailing punctuation and unbalanced brackets', () => {
    const line = 'Serving at https://example.com/a?b=1. See (https://docs.example.org/x_(y)) and http://localhost:8000/,';
    expect(findLinks(line).map((l) => l.url)).toEqual(['https://example.com/a?b=1', 'https://docs.example.org/x_(y)', 'http://localhost:8000/']);
    const first = findLinks(line)[0]!;
    expect(line.slice(first.start, first.end)).toBe(first.url);
  });

  it('stops at quotes, angle brackets, backticks and control characters', () => {
    expect(findLinks('href="https://a.example/x"><b>').map((l) => l.url)).toEqual(['https://a.example/x']);
    expect(findLinks('`https://b.example/y`').map((l) => l.url)).toEqual(['https://b.example/y']);
    expect(findLinks('https://c.example/z\x1b[0m').map((l) => l.url)).toEqual(['https://c.example/z']);
    expect(findLinks('ftp://x.example javascript:alert(1) file:///etc/passwd')).toEqual([]);
  });

  it('ignores absurdly long runs', () => {
    expect(findLinks(`https://x.example/${'a'.repeat(LINK_MAX_CHARS)}`)).toEqual([]);
  });

  it('opens only plain https links, never with credentials (same rule as main’s openExternal)', () => {
    const cases = [
      'https://example.com/docs',
      'http://example.com/',
      'https://bank.example@evil.example/',
      'https://user:pw@example.com/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url',
      'https://例え.jp/パス',
    ];
    for (const url of cases) expect(checkLink(url).ok, url).toBe(isAllowedExternalUrl(url));
    const ok = checkLink('https://example.com/docs');
    expect(ok).toEqual({ ok: true, url: 'https://example.com/docs', host: 'example.com' });
    const http = checkLink('http://example.com/');
    expect(http.ok).toBe(false);
    expect(!http.ok && http.reason).toMatch(/Only https/);
    expect(checkLink('https://bank.example@evil.example/').ok).toBe(false);
  });

  it('the confirmation shows the punycode host, so look-alike hosts are visible', () => {
    const v = checkLink('https://exаmple.com/'); // Cyrillic "а"
    expect(v.ok && v.host).toMatch(/^xn--exmple-[a-z0-9]+\.com$/);
  });

  it('titles are plain text: controls and bidi overrides removed, collapsed, capped at 80', () => {
    expect(cleanTitle('vim \x07 main.py\x1b]0;')).toBe('vim main.py ]0;');
    expect(cleanTitle('a‮gnp.exe')).toBe('a gnp.exe');
    expect(cleanTitle('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    const long = cleanTitle('x'.repeat(200));
    expect(long).toHaveLength(TITLE_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('keys inside the terminal', () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('Linux/Windows: Ctrl+letters go to the shell, except the dock toggle and page switches', () => {
    expect(terminalKeyRoute(key('k', { ctrlKey: true }), false)).toBe('shell');
    expect(terminalKeyRoute(key('b', { ctrlKey: true }), false)).toBe('shell');
    expect(terminalKeyRoute(key('c', { ctrlKey: true }), false)).toBe('shell');
    expect(terminalKeyRoute(key('j', { ctrlKey: true }), false)).toBe('app');
    expect(terminalKeyRoute(key('J', { ctrlKey: true }), false)).toBe('app');
    expect(terminalKeyRoute(key('3', { ctrlKey: true }), false)).toBe('app');
    expect(terminalKeyRoute(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe('copy');
    expect(terminalKeyRoute(key('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste');
    expect(terminalKeyRoute(key('a'), false)).toBe('default');
  });

  it('macOS: ⌘ shortcuts stay the app’s, Ctrl keys are plain terminal keys', () => {
    expect(terminalKeyRoute(key('j', { metaKey: true }), true)).toBe('app');
    expect(terminalKeyRoute(key('k', { metaKey: true }), true)).toBe('default');
    expect(terminalKeyRoute(key('c', { ctrlKey: true }), true)).toBe('default');
    expect(terminalKeyRoute(key('j', { ctrlKey: true }), true)).toBe('default');
  });
});

describe('terminal theme from tokens', () => {
  const hex = (c: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m) throw new Error(`not a hex colour: ${c}`);
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
  };
  const lum = (c: string) => {
    const [r, g, b] = hex(c);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };

  it('dark: true black, near-white text, a lime cursor', () => {
    const t = terminalTheme(true);
    expect(t.background).toBe('#000000');
    expect(t.foreground).toBe('#fafafa');
    expect(t.cursor).toBe('#ddea4d');
    expect(t.cursorAccent).toBe('#000000');
  });

  it('light: near-white, an olive cursor (never lime on light)', () => {
    const t = terminalTheme(false);
    expect(t.background).toBe('#fcfcfc');
    expect(t.cursor).toBe('#5c6a00');
    expect(JSON.stringify(t).toLowerCase()).not.toContain('#ddea4d');
  });

  it('tokens read from the page win; empty ones fall back', () => {
    const t = terminalTheme(true, { background: ' #050505 ', foreground: '', cursor: '#ddea4d' });
    expect(t.background).toBe('#050505');
    expect(t.foreground).toBe(DEFAULT_TOKENS.dark.foreground);
  });

  it('every ANSI colour is readable on its background (≥ 3:1; ANSI black on black is the one convention kept)', () => {
    for (const [name, colour] of Object.entries(ANSI_LIGHT)) expect(contrast(colour, DEFAULT_TOKENS.light.background), `light ${name}`).toBeGreaterThanOrEqual(3);
    for (const [name, colour] of Object.entries(ANSI_DARK)) {
      if (name === 'black') continue;
      expect(contrast(colour, DEFAULT_TOKENS.dark.background), `dark ${name}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(DEFAULT_TOKENS.light.foreground, DEFAULT_TOKENS.light.background)).toBeGreaterThan(7);
    expect(contrast(DEFAULT_TOKENS.dark.foreground, DEFAULT_TOKENS.dark.background)).toBeGreaterThan(7);
  });

  it('ANSI yellow is gold, not the brand lime', () => {
    for (const c of [ANSI_DARK.yellow, ANSI_DARK.brightYellow, ANSI_LIGHT.yellow, ANSI_LIGHT.brightYellow]) expect(c.toLowerCase()).not.toBe('#ddea4d');
  });
});

describe('banners (§8.7)', () => {
  const r = sandbox();
  const noop = () => undefined;

  it('attached elsewhere: says so and offers Take over (main confirms natively)', () => {
    const html = render(<TerminalBanners session={session({}, { state: 'attached_elsewhere' })} />);
    expect(text(html)).toContain('This shell is open somewhere else');
    expect(text(html)).toContain('closes that shell and every program running in it');
    expect(text(html)).toContain('Take over…');
    expectDesignRules(html, { dino: false });
  });

  it('reconnecting: Plates, and the warning that output meanwhile may be missing', () => {
    const html = render(<TerminalBanners session={session({ state: 'reconnecting' }, { state: 'reconnecting' })} />);
    expect(text(html)).toContain('Reconnecting…');
    expect(html).toContain('data-plates');
    expect(html).toContain('data-banner="working"');
  });

  it('connecting', () => {
    expect(text(render(<TerminalBanners session={session({}, { state: 'connecting' })} />))).toContain('Connecting to the shell…');
  });

  it('cold resume: processes may be gone, Restart services (n) when there are any', () => {
    const svc = { name: 'web', command: 'python3 -m http.server 8000', port: 8000, startedAt: new Date().toISOString() };
    const html = render(<TerminalBanners session={session({ coldResumed: true, services: [svc, { ...svc, name: 'api', port: 9000 }] })} />);
    expect(text(html)).toContain('Processes from before the pause may be gone');
    expect(text(html)).toContain('Restart services (2)');
    const none = render(<TerminalBanners session={session({ coldResumed: true })} />);
    expect(text(none)).not.toContain('Restart services');
  });

  it('attached and calm: no banner at all', () => {
    expect(render(<TerminalBanners session={session()} />)).toBe('');
  });

  it('paused: read-only banner with Resume…; terminal-only banners give way', () => {
    const paused = sandbox({ phase: 'paused' });
    const s = session({ state: 'paused' }, { state: 'attached_elsewhere' });
    const html = render(<SessionBanner session={s} resource={paused} onReconnect={noop} />);
    expect(text(html)).toContain('Paused: the terminal is read-only');
    expect(text(html)).toContain('Resume…');
    expect(text(html)).toContain('price is shown before anything starts');
    expect(sessionBlocked(s, paused)).toBe(true);
    expect(render(<TerminalBanners session={s} blocked />)).toBe('');
  });

  it('closed / unreachable: the reason and Reconnect', () => {
    const html = render(<SessionBanner session={session({ state: 'closed', reason: 'The sandbox was deleted.' })} resource={r} onReconnect={noop} />);
    expect(text(html)).toContain('This computer’s session has ended');
    expect(text(html)).toContain('The sandbox was deleted.');
    expect(text(html)).toContain('Reconnect');
    expect(text(render(<SessionBanner session={session({ state: 'unavailable' })} resource={r} onReconnect={noop} />))).toContain('not reachable');
    expect(render(<SessionBanner session={session()} resource={r} onReconnect={noop} />)).toBe('');
  });
});

describe('TerminalView markup (xterm loads in an effect, never during render)', () => {
  it('renders the themed host and a spinner until xterm is ready; no Dino in the terminal', () => {
    const html = render(<TerminalView session={session()} />);
    expect(html).toContain('data-terminal-host');
    expect(html).toContain('bg-background');
    expectDesignRules(html, { dino: false });
  });

  it('paused: banners stay with the session banner, no attach error is shown', () => {
    const html = render(<TerminalView session={session({ state: 'paused' })} blocked />);
    expect(text(html)).not.toContain('Reattach');
    expect(html).not.toContain('data-banner');
  });
});

describe('review: terminalCanType', () => {
  it('types only when main accepts input (ready/connecting session, shell attached or (re)connecting, not blocked)', () => {
    const at = (state: string, terminal: string) => ({ state, terminal: { state: terminal, cols: 80, rows: 24, lastSeq: 0 } }) as never;
    expect(terminalCanType(at('ready', 'attached'), false)).toBe(true);
    expect(terminalCanType(at('ready', 'reconnecting'), false)).toBe(true);
    expect(terminalCanType(at('reconnecting', 'connecting'), false)).toBe(true);
    expect(terminalCanType(at('ready', 'attached'), true)).toBe(false);
    expect(terminalCanType(at('paused', 'none'), false)).toBe(false);
    expect(terminalCanType(at('paused', 'attached'), false)).toBe(false);
    expect(terminalCanType(at('ready', 'attached_elsewhere'), false)).toBe(false);
    expect(terminalCanType(at('ready', 'none'), false)).toBe(false);
    expect(terminalCanType(at('ready', 'closed'), false)).toBe(false);
    expect(terminalCanType(at('unavailable', 'closed'), false)).toBe(false);
  });
});
