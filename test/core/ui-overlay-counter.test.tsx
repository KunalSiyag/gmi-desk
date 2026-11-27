// The overlay counter in the ui kit (compute.md §8.4, C2-0): while a dialog, popover, menu, select list or the command
// palette is on screen, `useUi().overlayCount > 0`, so the computer dock hides its native preview view (drawn above the
// DOM) and shows a captured image. Effects do not run in a server render: layout effects run synchronously here and
// their cleanups are collected to simulate unmounting.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cleanups: Array<() => void> = [];
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useLayoutEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
});

import { Command, CommandInput } from '@renderer/components/ui/command';
import { OverlayMark, useOverlayCount } from '@renderer/components/ui/overlay';
import { useUi } from '@renderer/lib/store';

const unmountAll = () => {
  while (cleanups.length) cleanups.pop()!();
};

beforeEach(() => {
  unmountAll();
  useUi.setState({ overlayCount: 0 });
});
afterEach(unmountAll);

function Probe({ active }: { active: boolean }) {
  useOverlayCount(active);
  return null;
}

describe('overlay counter', () => {
  it('OverlayMark counts while mounted and uncounts on unmount', () => {
    renderToStaticMarkup(
      <>
        <OverlayMark />
        <OverlayMark />
      </>,
    );
    expect(useUi.getState().overlayCount).toBe(2);
    cleanups.pop()!();
    expect(useUi.getState().overlayCount).toBe(1);
    unmountAll();
    expect(useUi.getState().overlayCount).toBe(0);
  });

  it('useOverlayCount(false) does not count', () => {
    renderToStaticMarkup(<Probe active={false} />);
    expect(useUi.getState().overlayCount).toBe(0);
    renderToStaticMarkup(<Probe active />);
    expect(useUi.getState().overlayCount).toBe(1);
  });

  it('a mounted Command (the palette, the model picker) counts as an overlay', () => {
    const html = renderToStaticMarkup(
      <Command>
        <CommandInput placeholder="x" />
      </Command>,
    );
    expect(html).toContain('cmdk-input');
    expect(useUi.getState().overlayCount).toBeGreaterThanOrEqual(1);
    unmountAll();
    expect(useUi.getState().overlayCount).toBe(0);
  });

  it('the count never goes negative (idempotent uncount)', () => {
    renderToStaticMarkup(<OverlayMark />);
    const cleanup = cleanups.pop()!;
    cleanup();
    cleanup();
    expect(useUi.getState().overlayCount).toBe(0);
  });
});

describe('the kit wires it into every overlay', () => {
  const src = (f: string) => readFileSync(new URL(`../../src/renderer/components/ui/${f}`, import.meta.url), 'utf8');
  const popupBody = (text: string, popup: string) => {
    const start = text.indexOf(`<${popup}`);
    const end = text.indexOf(`</${popup}>`);
    expect(start, popup).toBeGreaterThan(-1);
    return text.slice(start, end);
  };

  it('dialog, popover and menu render <OverlayMark /> inside their popup (mounted only while open or exiting)', () => {
    expect(popupBody(src('dialog.tsx'), 'BaseDialog.Popup')).toContain('<OverlayMark />');
    expect(popupBody(src('popover.tsx'), 'BasePopover.Popup')).toContain('<OverlayMark />');
    expect(popupBody(src('menu.tsx'), 'BaseMenu.Popup')).toContain('<OverlayMark />');
  });

  it('select counts by open state (its list stays mounted while hidden) until the close transition ends', () => {
    const text = src('select.tsx');
    expect(text).toContain('useOverlayOpenState()');
    expect(text).toMatch(/overlay\.onOpen\(open\)/);
    expect(text).toContain('onOpenChangeComplete={overlay.onOpenComplete}');
    expect(popupBody(text, 'BaseSelect.Popup')).not.toContain('OverlayMark');
  });

  it('command counts while mounted', () => {
    expect(src('command.tsx')).toMatch(/export function Command\([^)]*\)[^{]*\{\s*useOverlayCount\(\);/);
  });
});
