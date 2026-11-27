// The terminal's colours (compute.md §8.2 "Theme", D16/D17): the page's own tokens for background, text and cursor
// (true black / near-white, GMI greys, a lime cursor on dark and an olive one on light — never lime on light), plus an
// ANSI palette tuned per theme so coloured output stays readable (light: every colour ≥ 3:1 on the background).
import type { ITheme } from '@xterm/xterm';

/** The CSS custom properties the terminal reads (styles/index.css). */
export interface TerminalTokens {
  background: string;
  foreground: string;
  /** --primary-ink: lime on dark, olive on light. */
  cursor: string;
  scrollbar: string;
  scrollbarHover: string;
}

export const TERMINAL_FONT_FAMILY = "'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
export const TERMINAL_FONT_SIZE = 13;

/** Fallbacks: the token values of styles/index.css (used before styles load, and in tests). */
export const DEFAULT_TOKENS: Record<'dark' | 'light', TerminalTokens> = {
  dark: {
    background: '#000000',
    foreground: '#fafafa',
    cursor: '#ddea4d',
    scrollbar: 'rgb(255 255 255 / 0.14)',
    scrollbarHover: 'rgb(255 255 255 / 0.28)',
  },
  light: {
    background: '#fcfcfc',
    foreground: '#0a0a0a',
    cursor: '#5c6a00',
    scrollbar: 'rgb(0 0 0 / 0.16)',
    scrollbarHover: 'rgb(0 0 0 / 0.3)',
  },
};

type Ansi = Pick<
  ITheme,
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
>;

/** Soft, slightly desaturated colours on black; yellow is a warm gold so it never reads as the lime brand colour. */
export const ANSI_DARK: Required<Ansi> = {
  black: '#2e2e2e',
  red: '#f87171',
  green: '#86d97a',
  yellow: '#e8c766',
  blue: '#7aa7f5',
  magenta: '#c79af2',
  cyan: '#6fd3d0',
  white: '#d4d4d4',
  brightBlack: '#737373',
  brightRed: '#fca5a5',
  brightGreen: '#b0eba4',
  brightYellow: '#f2dc94',
  brightBlue: '#a5c4fa',
  brightMagenta: '#dcbdf7',
  brightCyan: '#9fe5e2',
  brightWhite: '#fafafa',
};

/** Deep colours on near-white; "white" is a mid grey so `ls` colours and prompts stay visible. */
export const ANSI_LIGHT: Required<Ansi> = {
  black: '#0a0a0a',
  red: '#c62828',
  green: '#2e7d32',
  yellow: '#8a6100',
  blue: '#1d4ed8',
  magenta: '#9c27b0',
  cyan: '#00796b',
  white: '#737373',
  brightBlack: '#525252',
  brightRed: '#d32f2f',
  brightGreen: '#357a38',
  brightYellow: '#946800',
  brightBlue: '#2563eb',
  brightMagenta: '#a33ab5',
  brightCyan: '#00838f',
  brightWhite: '#7a7a7a',
};

/** xterm's theme for the current app theme. Missing tokens fall back to the stylesheet's values. */
export function terminalTheme(dark: boolean, tokens: Partial<TerminalTokens> = {}): ITheme {
  const t = { ...DEFAULT_TOKENS[dark ? 'dark' : 'light'], ...stripEmpty(tokens) };
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.background,
    // A brand-tinted selection: lime on black, olive on white (both well under the text's contrast).
    selectionBackground: dark ? 'rgba(221, 234, 77, 0.26)' : 'rgba(92, 106, 0, 0.18)',
    selectionInactiveBackground: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)',
    scrollbarSliderBackground: t.scrollbar,
    scrollbarSliderHoverBackground: t.scrollbarHover,
    scrollbarSliderActiveBackground: t.scrollbarHover,
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

function stripEmpty(tokens: Partial<TerminalTokens>): Partial<TerminalTokens> {
  const out: Partial<TerminalTokens> = {};
  for (const [k, v] of Object.entries(tokens) as Array<[keyof TerminalTokens, string | undefined]>) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** Reads the tokens from the document (the `dark` class on <html> picks the set). */
export function readTerminalTokens(root: HTMLElement = document.documentElement): { dark: boolean; tokens: Partial<TerminalTokens> } {
  const style = getComputedStyle(root);
  const read = (name: string) => style.getPropertyValue(name);
  return {
    dark: root.classList.contains('dark'),
    tokens: {
      background: read('--background'),
      foreground: read('--foreground'),
      cursor: read('--primary-ink'),
      scrollbar: read('--scrollbar'),
      scrollbarHover: read('--scrollbar-hover'),
    },
  };
}
