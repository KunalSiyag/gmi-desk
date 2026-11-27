// UI kit motion contracts (Emil Kowalski's rules): which classes each component puts on which Base UI part.
// Screenshots cannot show motion, so the class contracts are the regression net: press feedback on buttons,
// origin-aware popups with data-starting-style / data-ending-style transitions, instant keyboard and adjacent-tooltip
// opens, a centred modal, ease-out only, exits faster than enters, no `transition-all`, reduced-motion fallback,
// and an instant command palette.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Base UI renders popups into portals, which react-dom/server skips. Swap the popup parts for plain elements that
// keep `className`, so the wrappers' class contracts can be read from static markup. Switch and Tabs stay real.
const fake = await vi.hoisted(async () => {
  const { createElement, Fragment } = await import('react');
  type PartProps = { children?: ReactNode; className?: unknown; render?: unknown };
  const passthrough = new Set(['Root', 'Portal', 'Provider']);
  const parts = () =>
    new Proxy(
      {},
      {
        get: (_target, part: string) =>
          function FakePart({ children, className, render }: PartProps) {
            if (render) return render as ReturnType<typeof createElement>;
            if (passthrough.has(part)) return createElement(Fragment, null, children);
            return createElement('div', { 'data-part': part, className: typeof className === 'string' ? className : undefined }, children);
          },
      },
    );
  return { parts };
});
vi.mock('@base-ui/react/dialog', () => ({ Dialog: fake.parts() }));
vi.mock('@base-ui/react/popover', () => ({ Popover: fake.parts() }));
vi.mock('@base-ui/react/menu', () => ({ Menu: fake.parts() }));
vi.mock('@base-ui/react/tooltip', () => ({ Tooltip: fake.parts() }));

import { Button, buttonVariants } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { DropdownMenu } from '@renderer/components/ui/menu';
import { backdropMotion, dialogMotion, popupMotion, pressMotion, rowPressMotion, tooltipMotion } from '@renderer/components/ui/motion';
import { Popover } from '@renderer/components/ui/popover';
import { Switch } from '@renderer/components/ui/switch';
import { TabStrip } from '@renderer/components/ui/tabs';
import { Tooltip } from '@renderer/components/ui/tooltip';

const ROOT = join(import.meta.dirname, '..', '..');
const UI_DIR = join(ROOT, 'src/renderer/components/ui');

/** Classes of the first element carrying `data-part="<part>"`. */
function partClasses(html: string, part: string): string[] {
  const match = new RegExp(`data-part="${part}" class="([^"]*)"`).exec(html);
  if (!match) throw new Error(`no ${part} in ${html}`);
  return match[1]!.replace(/&amp;/g, '&').split(/\s+/);
}

function allClasses(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.replace(/&amp;/g, '&').split(/\s+/));
}

const words = (classes: string) => classes.split(/\s+/).filter(Boolean);

/** Duration (ms) set by `duration-N` with the given variant prefix ('' = base). */
function duration(classes: string[], variant = ''): number | null {
  const hit = classes.find((c) => new RegExp(`^${variant.replace(/[[\]]/g, '\\$&')}duration-(\\d+)$`).test(c));
  return hit ? Number(hit.slice(hit.lastIndexOf('-') + 1)) : null;
}

// Only compositor-friendly properties (transform family + opacity) and colours may transition.
const ALLOWED_TRANSITION_PROPS = new Set(['opacity', 'scale', 'translate', 'transform', 'color', 'background-color', 'border-color']);

/** Shared rules for any class list: no transition-all, no ease-in, allowed properties only, never scale from < 0.95. */
function expectMotionRules(classes: string[]) {
  expect(classes).not.toContain('transition-all');
  expect(classes).not.toContain('transition');
  expect(classes.filter((c) => /(^|:)ease-(in|linear)$/.test(c))).toEqual([]);
  for (const c of classes) {
    const list = /(?:^|:)transition-\[([^\]]+)\]$/.exec(c)?.[1];
    if (list) for (const prop of list.split(',')) expect(ALLOWED_TRANSITION_PROPS, `${c} animates ${prop}`).toContain(prop);
    const scale = /(?:^|:)scale-(\d+)$/.exec(c)?.[1];
    if (scale) expect(Number(scale), `${c} starts too small`).toBeGreaterThanOrEqual(95);
    const ms = /(?:^|:)duration-(\d+)$/.exec(c)?.[1];
    if (ms) expect(Number(ms), `${c} is too slow for UI`).toBeLessThanOrEqual(250);
  }
}

/** Enter/exit contract for a Base UI popup: fades + scales on data-starting-style / data-ending-style. */
function expectEnterExit(classes: string[], scale: number) {
  for (const state of ['data-[starting-style]', 'data-[ending-style]']) {
    expect(classes).toContain(`${state}:opacity-0`);
    expect(classes).toContain(`${state}:scale-${scale}`);
  }
  expect(classes).toContain('ease-out');
  const enter = duration(classes);
  const exit = duration(classes, 'data-[ending-style]:');
  expect(enter).not.toBeNull();
  expect(exit).not.toBeNull();
  expect(exit!).toBeLessThan(enter!);
}

describe('buttons: press feedback', () => {
  it('every variant and size dips to 0.97 on :active with a colours + scale transition (160 ms ease-out)', () => {
    const variants = ['default', 'secondary', 'outline', 'ghost', 'subtle', 'destructive', 'link'] as const;
    const sizes = ['xs', 'sm', 'md', 'lg', 'icon', 'icon-sm', 'icon-xs'] as const;
    for (const variant of variants) {
      for (const size of sizes) {
        const classes = words(buttonVariants({ variant, size }));
        expect(classes).toContain('active:scale-97');
        expect(classes).toContain('transition-[color,background-color,border-color,scale]');
        expect(classes).toContain('duration-160');
        expect(classes).toContain('ease-out');
        expectMotionRules(classes);
      }
    }
  });

  it('the rendered <Button> keeps the press classes after class merging with caller classes', () => {
    const classes = allClasses(renderToStaticMarkup(<Button className="min-w-32 text-2xs">Go</Button>));
    for (const c of words(pressMotion)) expect(classes).toContain(c);
  });
});

describe('popovers and menus: origin-aware enter/exit', () => {
  it('Popover popup grows from its trigger (Base UI --transform-origin), 150 ms in / 100 ms out, instant from the keyboard', () => {
    const html = renderToStaticMarkup(
      <Popover open trigger={<button type="button">Open</button>} className="w-80 p-3">
        Body
      </Popover>,
    );
    const classes = partClasses(html, 'Popup');
    expect(classes).toContain('origin-(--transform-origin)');
    expect(classes).toContain('data-[instant]:transition-none');
    expect(classes).toContain('w-80');
    expectEnterExit(classes, 97);
    expect(duration(classes)).toBe(150);
    expect(duration(classes, 'data-[ending-style]:')).toBe(100);
    expectMotionRules(classes);
  });

  it('DropdownMenu popup uses the same recipe; highlighted items stay instant (keyboard navigation)', () => {
    const html = renderToStaticMarkup(
      <DropdownMenu trigger={<button type="button">More</button>} items={[{ label: 'Rename', onSelect: () => undefined }, 'separator', { label: 'Delete', onSelect: () => undefined, destructive: true }]} />,
    );
    const popup = partClasses(html, 'Popup');
    expect(popup).toContain('origin-(--transform-origin)');
    expect(popup).toContain('data-[instant]:transition-none');
    expectEnterExit(popup, 97);
    expectMotionRules(popup);
    const item = partClasses(html, 'Item');
    expect(item.some((c) => c.startsWith('transition'))).toBe(false);
  });
});

describe('tooltips', () => {
  it('grow from the trigger in 125 ms, leave faster, and open instantly while another tooltip is open (data-instant)', () => {
    const html = renderToStaticMarkup(
      <Tooltip label="Copy">
        <button type="button">c</button>
      </Tooltip>,
    );
    const classes = partClasses(html, 'Popup');
    expect(classes).toContain('origin-(--transform-origin)');
    expect(classes).toContain('data-[instant]:transition-none');
    expectEnterExit(classes, 97);
    expect(duration(classes)).toBe(125);
    expectMotionRules(classes);
  });
});

describe('dialog: centred modal', () => {
  const html = renderToStaticMarkup(
    <Dialog open onOpenChange={() => undefined} title="Confirm" footer={<Button>OK</Button>}>
      Body
    </Dialog>,
  );

  it('popup scales 0.96 → 1 with a fade (200 ms in, 150 ms out) from the centre, not from a trigger', () => {
    const classes = partClasses(html, 'Popup');
    expectEnterExit(classes, 96);
    expect(duration(classes)).toBe(200);
    expect(duration(classes, 'data-[ending-style]:')).toBe(150);
    expect(classes.some((c) => c.startsWith('origin-'))).toBe(false);
    expect(classes).toEqual(expect.arrayContaining(['left-1/2', 'top-1/2', '-translate-x-1/2', '-translate-y-1/2']));
    expectMotionRules(classes);
  });

  it('backdrop only fades, faster out than in', () => {
    const classes = partClasses(html, 'Backdrop');
    expect(classes).toEqual(expect.arrayContaining(['transition-opacity', 'data-[starting-style]:opacity-0', 'data-[ending-style]:opacity-0', 'ease-out']));
    expect(classes.some((c) => /scale|translate/.test(c))).toBe(false);
    expect(duration(classes, 'data-[ending-style]:')!).toBeLessThan(duration(classes)!);
    expectMotionRules(classes);
  });

  it('the close button has press feedback', () => {
    expect(partClasses(html, 'Close')).toContain('active:scale-97');
  });
});

describe('switch and tabs', () => {
  it('switch thumb slides (and recolours: black on lime when checked) with ease-out and snaps under reduced motion', () => {
    const classes = allClasses(renderToStaticMarkup(<Switch checked onCheckedChange={() => undefined} aria-label="Enforce" />));
    expect(classes).toEqual(
      expect.arrayContaining(['transition-[translate,background-color]', 'ease-out', 'duration-150', 'motion-reduce:transition-none']),
    );
    expectMotionRules(classes);
  });

  it('switch dips to 0.97 when pressed; disabled keys off data-disabled (Base UI renders a span, so :disabled never matches)', () => {
    const html = renderToStaticMarkup(<Switch checked={false} disabled onCheckedChange={() => undefined} aria-label="Enforce" />);
    expect(html).toMatch(/<span[^>]*data-disabled=""[^>]*role="switch"/);
    const root = words(/role="switch"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '');
    expect(root).toEqual(expect.arrayContaining(['active:scale-97', 'transition-[background-color,scale]', 'data-[disabled]:opacity-50', 'data-[disabled]:pointer-events-none']));
    expect(root).not.toContain('disabled:opacity-50');
    expectMotionRules(root);
  });

  it('tab strip switches instantly (no sliding indicator, no pill fade): only the hover text colour eases', () => {
    const html = renderToStaticMarkup(
      <TabStrip value="a" onValueChange={() => undefined} items={[{ value: 'a', label: 'All' }, { value: 'b', label: 'Image', count: 3 }]} />,
    );
    const classes = allClasses(html);
    expect(classes.some((c) => /(^|:)(translate|scale)-/.test(c))).toBe(false);
    // transition-colors would include background-color: the active pill would fade in while its shadow snaps.
    expect(classes).not.toContain('transition-colors');
    expect(classes).toEqual(expect.arrayContaining(['transition-[color]', 'ease-out', 'data-[active]:transition-none']));
    expectMotionRules(classes);
  });
});

describe('recipes and sources', () => {
  it('every exported recipe follows the rules', () => {
    for (const recipe of [pressMotion, rowPressMotion, popupMotion, tooltipMotion, backdropMotion, dialogMotion]) expectMotionRules(words(recipe));
  });

  it('full-width rows press with a deeper background, not a scale, and never fade (keyboard selection stays instant)', () => {
    const classes = words(rowPressMotion);
    expect(classes).toContain('active:bg-foreground/10');
    expect(classes.some((c) => /scale/.test(c))).toBe(false);
    expect(classes.some((c) => /transition|duration/.test(c))).toBe(false);
  });

  it('no UI kit file uses transition-all or keyframe entrances (transitions stay interruptible)', () => {
    for (const file of readdirSync(UI_DIR)) {
      const src = readFileSync(join(UI_DIR, file), 'utf8');
      expect(src, file).not.toMatch(/transition-all|\btransition:\s*all/);
      expect(src, file).not.toMatch(/animate-(in|out|fade|zoom|slide)/);
    }
  });

  it('the command palette stays instant (opened from the keyboard many times a day)', () => {
    for (const file of [join(UI_DIR, 'command.tsx'), join(ROOT, 'src/renderer/components/shell/CommandPalette.tsx')]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/transition|starting-style|ending-style|animate-|Motion\b/);
    }
  });

  it('prefers-reduced-motion drops scale on Base UI enter/exit states and presses but keeps the opacity fades', () => {
    const css = readFileSync(join(ROOT, 'src/renderer/styles/index.css'), 'utf8');
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/\[data-starting-style\],\s*\[data-ending-style\],[^{]*:active\s*\{\s*scale: none !important;/);
    expect(block).not.toMatch(/opacity|transition(-duration)?:\s*(none|0)/);
    // The curves the recipes rely on.
    expect(css).toContain('--ease-out: cubic-bezier(0.23, 1, 0.32, 1)');
  });
});
