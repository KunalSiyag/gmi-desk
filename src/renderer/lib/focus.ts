/** Minimal shapes so the helpers stay testable without a DOM. */
export interface FocusableLike {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
}

export interface FocusDocLike {
  readonly activeElement: unknown;
  readonly body: unknown;
}

function currentDocument(): FocusDocLike | null {
  return typeof document === 'undefined' ? null : document;
}

/** The element that has keyboard focus right now (null for <body> or nothing). */
export function focusedElement(doc: FocusDocLike | null = currentDocument()): HTMLElement | null {
  const el = doc?.activeElement as (HTMLElement & FocusableLike) | null | undefined;
  if (!el || el === doc?.body || typeof el.focus !== 'function') return null;
  return el;
}

/**
 * Where focus goes when an overlay closes (Base UI `finalFocus`): back to the element that had it when the
 * overlay opened, if it is still on the page; otherwise Base UI's default.
 * When the overlay closed because one of its commands ran, focus is left alone: the command may have opened
 * a dialog or navigated, and `restoreFocusIfIdle` puts it back afterwards if nothing took it.
 */
export function returnFocusTarget<T extends FocusableLike>(opener: T | null, closedByCommand: boolean): T | boolean {
  if (closedByCommand) return false;
  return opener && opener.isConnected ? opener : true;
}

/** Puts focus back on `opener` when nothing else has it (focus fell to <body>). */
export function restoreFocusIfIdle(opener: FocusableLike | null, doc: FocusDocLike | null = currentDocument()): boolean {
  if (!opener || !opener.isConnected || !doc) return false;
  if (doc.activeElement && doc.activeElement !== doc.body) return false;
  opener.focus({ preventScroll: true });
  return true;
}
