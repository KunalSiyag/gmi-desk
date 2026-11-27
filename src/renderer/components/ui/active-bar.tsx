import { cn } from '@renderer/lib/cn';

/**
 * Where the bar sits:
 * - 'edge': navigation (app sidebar pages, Settings' section nav). Hangs on the nav container's left edge, outside
 *   the item: the default offset `-left-2` fits a list inside `px-2`; pass e.g. `className="-left-2.5"` otherwise.
 * - 'inset': a selected row in a list (chat threads, models table, leaderboard, Create's model list), on the row's
 *   own inner left edge. Pair it with `bg-accent` on the row.
 */
export type ActiveBarPlacement = 'edge' | 'inset';

const BAR = 'pointer-events-none absolute top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-primary-ink';
const OFFSET: Record<ActiveBarPlacement, string> = { edge: '-left-2', inset: 'left-0' };

/**
 * The current/selected marker: a 2px × 16px brand-ink bar (lime on dark, olive on light), vertically centred.
 * Render it only for the current item, inside a `relative` parent; it appears instantly (selection changes from the
 * keyboard, so no transition). Decorative: mark the item itself with aria-current / aria-selected.
 *
 * Props: `placement` 'edge' | 'inset' (default 'inset'); `className` (offset or height overrides).
 */
export function ActiveBar({ placement = 'inset', className }: { placement?: ActiveBarPlacement; className?: string }) {
  return <span aria-hidden data-active-bar={placement} className={cn(BAR, OFFSET[placement], className)} />;
}

/**
 * The same 'inset' bar as a `::before` on the row itself, for rows that cannot take a child span (a <tr>'s cell,
 * a CSS-grid row you don't want to add a node to). Add it (only while selected) to a `relative` element.
 */
export const activeBarBefore =
  'before:pointer-events-none before:absolute before:left-0 before:top-1/2 before:h-4 before:w-0.5 before:-translate-y-1/2 before:rounded-r-full before:bg-primary-ink';
