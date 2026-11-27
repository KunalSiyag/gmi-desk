// The kit Select (components/ui/select.tsx): a Base UI Select with a themed trigger and popup, replacing the native
// <select> whose OS-drawn list ignored the GMI theme (blue highlight, system colours). Closed triggers render with the
// real Base UI (react-dom/server); the popup is portalled (client only), so its class contracts are read by rendering
// the same component against plain stand-ins for the Base UI parts.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { popupMotion } from '@renderer/components/ui/motion';
import {
  Select,
  selectCheckClass,
  selectHintClass,
  selectItemClass,
  selectPopupClass,
  selectTriggerVariants,
  type SelectOption,
} from '@renderer/components/ui/select';

const words = (classes: string) => classes.split(/\s+/).filter(Boolean);
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&gt;/g, '>');
const buttonClasses = (html: string) => words(decode(/<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? ''));
const buttonTag = (html: string) => /<button[^>]*>/.exec(html)?.[0] ?? '';

const OPTIONS: SelectOption[] = [
  { value: '', label: 'All providers' },
  { value: 'deepseek', label: 'DeepSeek', hint: 12 },
  { value: 'qwen', label: 'Qwen', hint: 0, disabled: true },
];

function trigger(props: Partial<Parameters<typeof Select>[0]> = {}): string {
  return renderToStaticMarkup(<Select aria-label="Provider" value="deepseek" onValueChange={() => undefined} options={OPTIONS} {...props} />);
}

describe('Select trigger (closed, real Base UI)', () => {
  it('is a combobox button showing the selected label, with its aria-label and a quiet chevron; no native <select>', () => {
    const html = trigger();
    const tag = buttonTag(html);
    expect(tag).toContain('role="combobox"');
    expect(tag).toContain('aria-haspopup="listbox"');
    expect(tag).toContain('aria-expanded="false"');
    expect(tag).toContain('aria-label="Provider"');
    expect(html).toMatch(/<span class="[^"]*truncate[^"]*">DeepSeek<\/span>/);
    // The hint is list-only: the trigger shows the label alone.
    expect(html).not.toContain('>12<');
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*text-muted-foreground[^"]*"><svg[^>]*lucide-chevron-down/);
    expect(html).not.toMatch(/<select|<option/);
    expect(html).not.toMatch(/appearance|bg-blue/);
  });

  it('shows the empty option\'s label for "" (e.g. "Default effort"), and the placeholder or raw value for an unknown value', () => {
    expect(trigger({ value: '' })).toContain('>All providers</span>');
    expect(trigger({ value: 'retired' })).toContain('>retired</span>');
    expect(trigger({ value: 'retired', placeholder: 'Choose…' })).toContain('>Choose…</span>');
  });

  it('field (default): the input look (border-input, brand focus ring, invalid state), h-8 / 13px, caller width wins', () => {
    const cls = buttonClasses(trigger({ className: 'w-36' }));
    expect(cls).toEqual(
      expect.arrayContaining(['border-input', 'rounded-md', 'focus-visible:border-ring', 'focus-visible:ring-3', 'focus-visible:ring-ring/20', 'aria-[invalid=true]:border-destructive/70', 'h-8', 'text-[13px]', 'pl-2.5', 'w-36']),
    );
    expect(cls).not.toContain('w-full');
    const small = buttonClasses(trigger({ size: 'sm' }));
    expect(small).toEqual(expect.arrayContaining(['h-7', 'text-xs', 'pl-2', 'w-full']));
    expect(small).not.toContain('h-8');
  });

  it('ghost: no box, leading icon, h-7 / 12px, muted until hover/open, keyboard ring', () => {
    const html = trigger({ variant: 'ghost', icon: <svg data-icon="brain" /> });
    const cls = buttonClasses(html);
    expect(cls).toEqual(
      expect.arrayContaining(['h-7', 'text-xs', 'text-muted-foreground', 'hover:bg-accent', 'hover:text-foreground', 'data-[popup-open]:bg-accent', 'data-[popup-open]:text-foreground', 'focus-visible:ring-2', 'focus-visible:ring-ring/40', 'outline-none']),
    );
    expect(cls).not.toContain('border-input');
    expect(html.indexOf('data-icon="brain"')).toBeLessThan(html.indexOf('>DeepSeek<'));
  });

  it('id lands on the trigger (so <label htmlFor> names it); aria-invalid and disabled reach it', () => {
    expect(buttonTag(trigger({ id: 'catalog-refresh' }))).toContain('id="catalog-refresh"');
    expect(buttonTag(trigger({ 'aria-invalid': true }))).toContain('aria-invalid="true"');
    expect(buttonTag(trigger({ 'aria-invalid': false }))).not.toContain('aria-invalid');
    expect(buttonTag(trigger({ disabled: true }))).toMatch(/data-disabled/);
  });

  it('trigger looks only animate colours (no transition-all)', () => {
    for (const variant of Object.values(selectTriggerVariants)) {
      expect(words(variant)).not.toContain('transition-all');
      expect(variant).not.toMatch(/\btransition(\s|$)/);
    }
  });
});

describe('Select popup and items (class contracts)', () => {
  /** Renders <Select> with every Base UI part swapped for a plain <div data-part> keeping className and primitive props. */
  async function renderParts(props: Partial<Parameters<typeof Select>[0]> = {}): Promise<string> {
    vi.resetModules();
    vi.doMock('@base-ui/react/select', async () => {
      const { createElement, Fragment } = await import('react');
      type PartProps = Record<string, unknown> & { children?: ReactNode | ((value: unknown) => ReactNode); className?: unknown };
      const passthrough = new Set(['Root', 'Portal']);
      const Select = new Proxy(
        {},
        {
          get: (_target, part: string) =>
            function FakePart({ children, className, ...rest }: PartProps) {
              const kids = typeof children === 'function' ? children(undefined) : children;
              if (passthrough.has(part)) return createElement(Fragment, null, kids);
              const attrs: Record<string, string> = { 'data-part': part };
              if (typeof className === 'string') attrs.className = className;
              for (const [k, v] of Object.entries(rest)) {
                if (['string', 'number', 'boolean'].includes(typeof v)) attrs[k.startsWith('data-') || k.startsWith('aria-') ? k : `data-p-${k.toLowerCase()}`] = String(v);
              }
              return createElement('div', attrs, kids);
            },
        },
      );
      return { Select };
    });
    const mod = await import('@renderer/components/ui/select');
    vi.doUnmock('@base-ui/react/select');
    return renderToStaticMarkup(<mod.Select aria-label="Provider" value="deepseek" onValueChange={() => undefined} options={OPTIONS} {...props} />);
  }

  const partTag = (html: string, part: string, nth = 0) => [...html.matchAll(new RegExp(`<div data-part="${part}"[^>]*>`, 'g'))][nth]?.[0] ?? '';
  const partClasses = (html: string, part: string, nth = 0) => words(decode(/class="([^"]*)"/.exec(partTag(html, part, nth))?.[1] ?? ''));

  it('popup: the kit popover surface with popupMotion (origin-aware, 150/100 ms, instant from the keyboard)', async () => {
    const html = await renderParts({ popupClassName: 'tabular-nums' });
    const popup = partClasses(html, 'Popup');
    expect(popup).toEqual(expect.arrayContaining(['bg-popover', 'text-popover-foreground', 'rounded-lg', 'border-border', 'dark:border-input', 'shadow-xl', 'min-w-(--anchor-width)', 'tabular-nums']));
    for (const c of words(popupMotion)) expect(popup).toContain(c);
    expect(popup).toEqual(expect.arrayContaining(['origin-(--transform-origin)', 'data-[instant]:transition-none', 'duration-150', 'data-[ending-style]:duration-100']));
    // Closed or mouse-opened: no data-instant (it is set only for keyboard open/close).
    expect(partTag(html, 'Popup')).not.toContain('data-instant');
  });

  it('positioner: a dropdown under the trigger (not aligned over it), 4px gap, above dialogs like the other popups', async () => {
    const tag = partTag(await renderParts(), 'Positioner');
    expect(tag).toContain('data-p-alignitemwithtrigger="false"');
    expect(tag).toContain('data-p-sideoffset="4"');
    expect(tag).toContain('data-p-side="bottom"');
    expect(words(/class="([^"]*)"/.exec(tag)?.[1] ?? '')).toContain('z-50');
    expect(partTag(await renderParts({ side: 'top', align: 'end' }), 'Positioner')).toMatch(/data-p-side="top".*data-p-align="end"|data-p-align="end".*data-p-side="top"/);
  });

  it('items: accent highlight (instant), brand-ink check for the selected one, muted disabled; never lime-filled or blue', async () => {
    const html = await renderParts();
    const item = partClasses(html, 'Item', 1);
    expect(item).toEqual(expect.arrayContaining(['data-[highlighted]:bg-accent', 'data-[highlighted]:text-foreground', 'data-[disabled]:opacity-50', 'text-[13px]', 'h-8', 'rounded-md']));
    expect(item.some((c) => c.startsWith('transition'))).toBe(false);
    expect(item.some((c) => /(^|:)bg-primary\b/.test(c))).toBe(false);
    expect(words(selectCheckClass)).toContain('text-primary-ink');
    expect(html).toMatch(/<div data-part="ItemIndicator"[^>]*><svg[^>]*class="lucide lucide-check size-3\.5 text-primary-ink"/);
    for (const cls of [selectItemClass, selectPopupClass, selectCheckClass, selectHintClass, ...Object.values(selectTriggerVariants)]) {
      expect(cls).not.toMatch(/bg-blue|text-blue|appearance/);
    }
    expect(html).not.toMatch(/bg-blue|appearance|<select|<option/);
    // Small selects get h-7 rows.
    expect(partClasses(await renderParts({ size: 'sm' }), 'Item')).toContain('h-7');
  });

  it('one item per option, in order, with value, disabled and type-ahead label; hints in quiet mono at the right', async () => {
    const html = await renderParts();
    const items = [0, 1, 2].map((i) => partTag(html, 'Item', i));
    expect(items[0]).toContain('data-p-value=""');
    expect(items[1]).toContain('data-p-value="deepseek"');
    expect(items[1]).toContain('data-p-label="DeepSeek"');
    expect(items[2]).toContain('data-p-disabled="true"');
    expect(partTag(html, 'Item', 3)).toBe('');
    expect(html).toContain(`<span class="${selectHintClass}">12</span>`);
    // A zero count is still shown.
    expect(html).toContain(`<span class="${selectHintClass}">0</span>`);
    expect(words(selectHintClass)).toEqual(expect.arrayContaining(['ml-auto', 'font-mono', 'tabular-nums', 'text-muted-foreground']));
  });
});
