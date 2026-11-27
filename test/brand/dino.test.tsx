// Dino (GMI Cloud's mascot), the boot splash and their motion rules (DECISIONS D16).
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dino, DinoLoader } from '@renderer/components/brand/Dino';
import { dinoSvg } from '@renderer/components/brand/dino-art';
import { GMI_MARK_PATHS, gmiLogoSvg } from '@renderer/components/brand/gmi-logo';
import { GmiLogo } from '@renderer/components/brand/GmiLogo';
import { hideBootSplash, MAX_VISIBLE_MS, MIN_VISIBLE_MS, resetBootSplashForTests } from '@renderer/lib/boot-splash';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('dinoSvg', () => {
  it('prefixes every gradient id and reference, so several Dinos can share a page', () => {
    const svg = dinoSvg('a1');
    const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^a1-/);
    for (const ref of refs) expect(ids).toContain(ref);
    expect(dinoSvg('b2')).not.toContain('a1-');
  });

  it('sanitises the prefix (React useId values contain colons or guillemets)', () => {
    const svg = dinoSvg('dino-«r3»');
    expect(svg).toContain('id="dino-r3-head"');
    expect(dinoSvg(':1:')).toContain('id="d1-head"');
    expect(dinoSvg('')).toContain('id="dino-head"');
  });

  it("is GMI's Dino: skull head, chip heart with the GMI mark, lime sticker outline, and the parts the moods animate", () => {
    const svg = dinoSvg();
    for (const part of ['dino-body', 'dino-head', 'dino-eye', 'dino-eye-happy', 'dino-eye-closed', 'dino-chip-core', 'dino-arm-l', 'dino-arm-r', 'dino-leg-l', 'dino-leg-r', 'dino-shadow', 'dino-outline']) {
      expect(svg).toContain(`class="${part}"`);
    }
    expect(svg.match(/class="dino-led"/g)).toHaveLength(5);
    // The chip shows GMI's own mark (official path data from gmi-logo.ts).
    expect(svg).toContain(GMI_MARK_PATHS[0].slice(0, 40));
    // Lime sticker outline behind the figure.
    expect(svg).toMatch(/class="dino-outline" fill="#ddea4d" stroke="#ddea4d"/);
    // No inline style attributes: the art keeps working under a stricter style-src.
    expect(svg).not.toMatch(/\sstyle=/);
  });

  it('gives each moving part and its outline piece the same class, so they move together', () => {
    const svg = dinoSvg();
    const outline = svg.slice(svg.indexOf('class="dino-outline"'), svg.indexOf('</g></g>', svg.indexOf('class="dino-outline"')));
    for (const part of ['dino-head', 'dino-arm-l', 'dino-arm-r', 'dino-leg-l', 'dino-leg-r']) {
      expect(outline).toContain(`class="${part}"`);
    }
  });
});

describe('<Dino /> and <DinoLoader />', () => {
  it('is decorative by default and an image when labelled', () => {
    const plain = renderToStaticMarkup(<Dino mood="sleep" size={40} />);
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).toContain('data-mood="sleep"');
    expect(plain).toContain('width:40px');
    const labelled = renderToStaticMarkup(<Dino label="Dino" still />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Dino"');
    expect(labelled).toContain('data-still=""');
  });

  it('DinoLoader is a polite status with its caption', () => {
    const html = renderToStaticMarkup(<DinoLoader label="Loading models" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-mood="loading"');
    expect(html).toContain('Loading models');
  });
});

describe('GMI logo', () => {
  it('uses the official mark + wordmark paths in currentColor', () => {
    const full = gmiLogoSvg('full');
    expect(full).toContain('fill="currentColor"');
    expect(full.match(/<path /g)).toHaveLength(9);
    expect(gmiLogoSvg('mark').match(/<path /g)).toHaveLength(2);
    expect(gmiLogoSvg('wordmark').match(/<path /g)).toHaveLength(7);
    expect(full).toContain('aria-label="GMI Cloud"');
  });

  it('<GmiLogo> is labelled by default and decorative with label={null}', () => {
    expect(renderToStaticMarkup(<GmiLogo />)).toContain('aria-label="GMI Cloud"');
    const mark = renderToStaticMarkup(<GmiLogo variant="mark" label={null} />);
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).toContain('viewBox="0 36 256.3 161"');
  });
});

describe('dino.css motion rules', () => {
  const css = read('src/renderer/styles/dino.css');

  it('keyframes animate only transform and opacity (compositor-only)', () => {
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)];
    expect(keyframes.length).toBeGreaterThan(5);
    for (const [, name, body] of keyframes) {
      const props = [...body!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const prop of props) expect(['transform', 'opacity'], `${name} animates ${prop}`).toContain(prop);
    }
  });

  it('respects reduced motion and the still flag', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/\.dino\[data-still\] \*/);
  });
});

describe('boot splash markup', () => {
  const html = read('src/renderer/index.html');

  it('ships the splash in index.html with the placeholders vite.config.ts fills', () => {
    expect(html).toContain('id="gmi-boot"');
    expect(html).toContain('<!-- gmi:boot-dino -->');
    expect(html).toContain('<!-- gmi:boot-logo -->');
    expect(html).toMatch(/<!-- gmi:boot-style[^>]*-->/);
    expect(html).toContain('role="status"');
    // The CSP forbids inline scripts in production: the splash must not need one.
    expect(html).not.toMatch(/<script(?![^>]*type="module" src=)/);
  });

  it('vite.config.ts inlines the Dino and its stylesheet', () => {
    const config = read('vite.config.ts');
    expect(config).toContain('bootSplashPlugin()');
    expect(config).toContain("dinoSvg('boot')");
    expect(config).toContain("gmiLogoSvg('full', 'gmi-boot-logo')");
    expect(config).toContain('styles/dino.css');
  });
});

describe('hideBootSplash', () => {
  type FakeEl = {
    attrs: Record<string, string>;
    removed: boolean;
    listeners: Array<(e: { target: unknown }) => void>;
    setAttribute(name: string, value: string): void;
    addEventListener(type: string, fn: (e: { target: unknown }) => void): void;
    remove(): void;
  };
  let el: FakeEl;
  let doc: Document;

  beforeEach(() => {
    vi.useFakeTimers();
    resetBootSplashForTests();
    el = {
      attrs: {},
      removed: false,
      listeners: [],
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      addEventListener(_type, fn) {
        this.listeners.push(fn);
      },
      remove() {
        this.removed = true;
      },
    };
    doc = { getElementById: (id: string) => (id === 'gmi-boot' ? el : null) } as unknown as Document;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the splash up for at least MIN_VISIBLE_MS after navigation start, then fades and removes it', () => {
    hideBootSplash(doc, () => 200);
    vi.advanceTimersByTime(MIN_VISIBLE_MS - 200 - 1);
    expect(el.attrs['data-done']).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(el.attrs['data-done']).toBe('');
    expect(el.attrs['aria-hidden']).toBe('true');
    expect(el.removed).toBe(false);
    el.listeners.forEach((fn) => fn({ target: el }));
    expect(el.removed).toBe(true);
  });

  it('hides at once when the app took longer than the minimum, and removes it even without transitionend', () => {
    hideBootSplash(doc, () => MIN_VISIBLE_MS + 500);
    vi.advanceTimersByTime(0);
    expect(el.attrs['data-done']).toBe('');
    vi.advanceTimersByTime(400);
    expect(el.removed).toBe(true);
  });

  it('ignores transitionend from children and runs only once', () => {
    hideBootSplash(doc, () => 10_000);
    hideBootSplash(doc, () => 10_000);
    vi.advanceTimersByTime(0);
    expect(el.listeners).toHaveLength(1);
    el.listeners[0]!({ target: {} });
    expect(el.removed).toBe(false);
  });

  it('gives up waiting for the app after a few seconds', () => {
    expect(MAX_VISIBLE_MS).toBeGreaterThanOrEqual(5000);
    expect(MAX_VISIBLE_MS).toBeLessThanOrEqual(10_000);
  });
});
