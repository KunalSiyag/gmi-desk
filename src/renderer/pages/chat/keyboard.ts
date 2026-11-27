/** Chat-page keyboard decisions (pure: takes event-like objects, so it is testable without a DOM). */

/** The parts of a KeyboardEvent the decision reads. */
export interface KeyEventLike {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target: unknown;
}

/**
 * Where Esc belongs to something else: dialogs (palette, rename, delete), menus, popovers (Base UI popups are
 * role="dialog") and listboxes close on Esc, and a trigger whose popup is open carries data-popup-open.
 */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-popup-open]';

function insideOverlay(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null;
  return Boolean(el && typeof el.closest === 'function' && el.closest(OVERLAY_SELECTOR));
}

/**
 * True when a window-level keydown should stop the streaming reply: a plain Esc that nothing handled (the
 * composer's own Esc handler prevents the default) and that was not meant for an open dialog, menu or popover.
 * Covers focus that left the composer: a clicked Send button turns into Stop, a clicked starter card unmounts.
 */
export function shouldStopOnEscape(event: KeyEventLike): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !insideOverlay(event.target);
}
