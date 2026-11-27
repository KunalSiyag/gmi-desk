// The shared kit pieces every page adopts (design rules: one accent green, one select, one micro-label, one
// discount badge, one "working" signal, one selection bar), plus the token/utility contracts in styles/index.css.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Plates } from '@renderer/components/brand/Plates';
import { PageHeader } from '@renderer/components/PageHeader';
import { ActiveBar, activeBarBefore } from '@renderer/components/ui/active-bar';
import { badgeVariants, DiscountBadge, discountLabel } from '@renderer/components/ui/badge';
import { CommandInput, Command } from '@renderer/components/ui/command';
import { fieldBase, Input } from '@renderer/components/ui/input';
import { MicroLabel, microLabel, SectionLabel, Stat } from '@renderer/components/ui/misc';
import { selectTriggerVariants } from '@renderer/components/ui/select';

const css = readFileSync(new URL('../../src/renderer/styles/index.css', import.meta.url), 'utf8');
const RENDERER = join(import.meta.dirname, '..', '..', 'src/renderer');
const words = (classes: string) => classes.split(/\s+/).filter(Boolean);
const classOf = (html: string, tag: string) => new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(html)?.[1] ?? '';

describe('Select: the one themed select (details in select.test.tsx)', () => {
  it('no native <select> anywhere in the renderer: its OS-drawn list ignores the GMI theme', () => {
    const files = (readdirSync(RENDERER, { recursive: true }) as string[]).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const text = readFileSync(join(RENDERER, f), 'utf8');
      expect(text, f).not.toMatch(/<select[\s>]|<option[\s>]|NativeSelect|appearance-none/);
    }
  });

  it('the boxed select trigger shares the input look', () => {
    expect(selectTriggerVariants.field).toContain(fieldBase.split(' ')[0]!);
    for (const c of ['border-input', 'focus-visible:ring-3', 'focus-visible:ring-ring/20']) expect(words(selectTriggerVariants.field)).toContain(c);
  });
});

describe('placeholders are AA in both themes (full muted-foreground)', () => {
  it('inputs and the command input', () => {
    expect(renderToStaticMarkup(<Input placeholder="x" />)).toContain('placeholder:text-muted-foreground ');
    const cmd = renderToStaticMarkup(
      <Command>
        <CommandInput placeholder="x" />
      </Command>,
    );
    expect(cmd).toContain('placeholder:text-muted-foreground');
    expect(cmd).not.toContain('placeholder:text-muted-foreground/');
  });
});

describe('MicroLabel', () => {
  it('microLabel is mono, uppercase, 3xs, medium, 0.16em tracking, muted', () => {
    expect(words(microLabel)).toEqual(
      expect.arrayContaining(['font-mono', 'uppercase', 'text-3xs', 'font-medium', 'tracking-[0.16em]', 'text-muted-foreground']),
    );
  });

  it('renders as any element, with an optional brand-ink (or danger) dot', () => {
    const plain = renderToStaticMarkup(<MicroLabel>Balance</MicroLabel>);
    expect(plain).toMatch(/^<span class="[^"]*font-mono/);
    expect(plain).not.toContain('bg-primary-ink');
    const dotted = renderToStaticMarkup(
      <MicroLabel as="dt" dot className="mt-2">
        Balance
      </MicroLabel>,
    );
    expect(dotted).toMatch(/^<dt class="[^"]*mt-2/);
    expect(dotted).toContain('size-1.5 shrink-0 bg-primary-ink');
    expect(renderToStaticMarkup(<MicroLabel dot="danger">Over</MicroLabel>)).toContain('bg-destructive');
  });

  it('SectionLabel and Stat use it', () => {
    for (const html of [renderToStaticMarkup(<SectionLabel>Recent</SectionLabel>), renderToStaticMarkup(<Stat label="Context" value="1M" />)]) {
      for (const c of words(microLabel)) expect(html).toContain(c);
    }
  });
});

describe('DiscountBadge: the one GMI deal badge', () => {
  it('lime tint + brand ink, mono tabular, from a fraction or whole percent', () => {
    const fromFraction = renderToStaticMarkup(<DiscountBadge discount={0.2} />);
    const fromPct = renderToStaticMarkup(<DiscountBadge pct={20} />);
    expect(fromFraction).toBe(fromPct);
    expect(fromPct).toContain('>-20%<');
    const cls = words(classOf(fromPct, 'span'));
    expect(cls).toEqual(expect.arrayContaining(['bg-primary/15', 'text-primary-ink', 'ring-primary-ink/20', 'font-mono', 'tabular-nums']));
    expect(fromPct).not.toContain('success');
  });

  it('renders nothing without a positive discount; one decimal at most; children replace the text', () => {
    expect(renderToStaticMarkup(<DiscountBadge discount={0} />)).toBe('');
    expect(renderToStaticMarkup(<DiscountBadge pct={null} />)).toBe('');
    expect(renderToStaticMarkup(<DiscountBadge />)).toBe('');
    expect(discountLabel(0.125)).toBe('-12.5%');
    expect(discountLabel(12.5, 'pct')).toBe('-12.5%');
    expect(discountLabel(1.4)).toBe('-100%');
    expect(discountLabel(-0.1)).toBeNull();
    expect(renderToStaticMarkup(<DiscountBadge pct={20}>-20% · org</DiscountBadge>)).toContain('-20% · org');
  });
});

describe('ActiveBar: the one current/selected marker', () => {
  it('a 2px brand-ink bar, edge (nav) or inset (rows), with no transition', () => {
    const edge = renderToStaticMarkup(<ActiveBar placement="edge" />);
    const inset = renderToStaticMarkup(<ActiveBar />);
    for (const html of [edge, inset]) {
      expect(words(classOf(html, 'span'))).toEqual(expect.arrayContaining(['absolute', 'w-0.5', 'h-4', 'bg-primary-ink', 'pointer-events-none']));
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain('transition');
    }
    expect(edge).toContain('-left-2');
    expect(inset).toContain('left-0');
    expect(renderToStaticMarkup(<ActiveBar placement="edge" className="-left-2.5" />)).not.toMatch(/-left-2[\s"]/);
    expect(activeBarBefore).toContain('before:bg-primary-ink');
    expect(activeBarBefore).toContain('before:w-0.5');
  });
});

describe('Plates: the one "working" signal', () => {
  it('three brand-ink plates, opacity-only animation, sm and md sizes', () => {
    const md = renderToStaticMarkup(<Plates />);
    const sm = renderToStaticMarkup(<Plates size="sm" />);
    expect(md.match(/dino-plate-fade/g)).toHaveLength(3);
    expect(md).toContain('bg-primary-ink');
    expect(md).toContain('aria-hidden="true"');
    expect(md).toContain('size-[5px]');
    expect(sm).toContain('size-[4px]');
  });
});

describe('Badge variants', () => {
  it('"new" is a heavier primary tint with brand ink, never a lime fill (lime fill is the one action per screen)', () => {
    const fresh = words(badgeVariants({ variant: 'new' }));
    const primary = words(badgeVariants({ variant: 'primary' }));
    expect(fresh).toEqual(expect.arrayContaining(['bg-primary/20', 'dark:bg-primary/15', 'text-primary-ink', 'ring-1', 'ring-inset', 'ring-primary-ink/30', 'font-semibold']));
    expect(fresh).not.toContain('bg-primary');
    expect(fresh).not.toContain('text-primary-foreground');
    expect(fresh.join(' ')).not.toContain('primary-edge');
    // Same family as the sidebar's "N new" counter (variant primary), one step heavier.
    expect(primary).toEqual(expect.arrayContaining(['text-primary-ink', 'ring-1', 'ring-inset']));
  });
});

describe('PageHeader: no repeated title', () => {
  it('keeps the title as a hidden h1 and shows the description as one muted line', () => {
    const html = renderToStaticMarkup(<PageHeader title="Usage" description="Your GMI balance." actions={<button type="button">x</button>} />);
    expect(html).toContain('<h1 class="sr-only">Usage</h1>');
    expect(html).toMatch(/<p class="[^"]*text-muted-foreground[^"]*">Your GMI balance\.<\/p>/);
    expect(html).not.toContain('text-lg');
    expect(renderToStaticMarkup(<PageHeader title="Docs" />)).toBe('<h1 class="sr-only">Docs</h1>');
  });
});

describe('styles/index.css contracts', () => {
  it('grid-floor takes its cell size (and fade) from CSS variables; --grid-line is a colour', () => {
    const util = css.slice(css.indexOf('@utility grid-floor'), css.indexOf('}', css.indexOf('@utility grid-floor')));
    expect(util).toContain('background-size: var(--grid-cell, 16px) var(--grid-cell, 16px)');
    expect(util).toMatch(/mask-image: var\(--grid-fade,/);
    expect(css).toMatch(/--color-grid-line:\s*var\(--grid-line\)/);
  });

  it('success is a leaf green (hue 130-135) in both themes, apart from lime', () => {
    for (const scope of [':root {', '.dark {']) {
      const body = css.slice(css.indexOf(scope), css.indexOf('}', css.indexOf(scope)));
      const hue = Number(/--success:\s*oklch\([\d.]+\s+[\d.]+\s+([\d.]+)\)/.exec(body)?.[1]);
      expect(hue).toBeGreaterThanOrEqual(130);
      expect(hue).toBeLessThanOrEqual(135);
    }
    expect(css).toMatch(/rare verification states only; brand-positive states/);
  });

  it('markdown tables: hairline rows, no cell grid, no block display (Markdown.tsx frames and scrolls them)', () => {
    const table = css.slice(css.indexOf('.gmi-markdown table {'), css.indexOf('}', css.indexOf('.gmi-markdown table {')));
    expect(table).not.toContain('display: block');
    expect(table).not.toContain('overflow-x');
    expect(css).toMatch(/\.gmi-markdown th,\n\.gmi-markdown td \{\n\s+border: 0;/);
    expect(css).toMatch(/\.gmi-markdown td \{\n\s+border-top: 1px solid var\(--color-border\);/);
    expect(css).toMatch(/\.gmi-markdown th \{[^}]*font-weight: 500;/);
  });
});
