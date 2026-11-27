// Light-theme warning/success text must meet WCAG AA (4.5:1) for the 10-13px text it is used for
// (finding foundation-54). Reads the tokens from the stylesheet itself.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block`);
  return css.slice(start, css.indexOf('}', start));
}

type Oklch = [number, number, number];

/** A colour token as gamma-encoded sRGB; tokens are oklch() or #rrggbb. */
function token(scope: string, name: string): number[] {
  const body = block(scope);
  const hex = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6});`).exec(body);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255);
  const m = new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(body);
  if (!m) throw new Error(`--${name} is not an oklch() or #rrggbb value in ${scope}`);
  return toSrgb([Number(m[1]), Number(m[2]), Number(m[3])]);
}

// OKLCH -> sRGB (CSS Color 4), then WCAG 2 relative luminance.
function toSrgb([L, C, h]: Oklch): number[] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
  return lin.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}
const luminance = (srgb: number[]) => {
  const [r, g, b] = srgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** A translucent fill over the page, as browsers composite it (gamma-encoded sRGB). */
const over = (fill: number[], alpha: number, page: number[]) => fill.map((v, i) => v * alpha + page[i]! * (1 - alpha));

describe('light theme text contrast', () => {
  const background = token(':root', 'background');
  const card = token(':root', 'card');
  const muted = token(':root', 'muted');

  it.each([
    ['warning', 0.2],
    ['success', 0.15],
  ] as const)('%s text passes AA on the page, cards, muted panels and its tinted badges/callouts', (name, maxTint) => {
    const text = token(':root', `${name}-foreground`);
    const fill = token(':root', name);
    for (const [label, surface] of [
      ['background', background],
      ['card', card],
      ['muted', muted],
      [`bg-${name}/${maxTint}`, over(fill, maxTint, background)],
    ] as const) {
      expect(contrast(text, surface), `${name}-foreground on ${label}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the fills alone would not pass (why the text tokens exist)', () => {
    expect(contrast(token(':root', 'warning'), background)).toBeLessThan(4.5);
  });

  it('maps the text tokens into the theme and keeps the dark theme colours', () => {
    expect(css).toMatch(/--color-warning-foreground:\s*var\(--warning-foreground\)/);
    expect(css).toMatch(/--color-success-foreground:\s*var\(--success-foreground\)/);
    expect(block('.dark')).toMatch(/--warning-foreground:\s*var\(--warning\)/);
    expect(block('.dark')).toMatch(/--success-foreground:\s*var\(--success\)/);
  });
});

// GMI lime (#DDEA4D) is a fill colour: 1.3:1 on white. Brand-coloured text uses --primary-ink (D16).
describe('GMI lime brand colours', () => {
  it.each([':root', '.dark'])('%s: brand text (--primary-ink) passes AA on the page, cards, muted panels and lime tints', (scope) => {
    const ink = token(scope, 'primary-ink');
    const page = token(scope, 'background');
    const lime = token(scope, 'primary');
    for (const [label, surface] of [
      ['background', page],
      ['card', token(scope, 'card')],
      ['muted', token(scope, 'muted')],
      ['bg-primary/15', over(lime, 0.15, page)],
    ] as const) {
      expect(contrast(ink, surface), `${scope} primary-ink on ${label}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([':root', '.dark'])('%s: text on lime buttons and badges passes AA', (scope) => {
    expect(contrast(token(scope, 'primary-foreground'), token(scope, 'primary'))).toBeGreaterThanOrEqual(4.5);
  });

  it('lime itself would not pass as text on the light theme (why --primary-ink exists)', () => {
    expect(contrast(token(':root', 'primary'), token(':root', 'background'))).toBeLessThan(2);
  });
});
