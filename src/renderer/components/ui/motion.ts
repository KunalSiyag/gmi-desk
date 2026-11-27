/**
 * Motion recipes for the UI kit (Emil Kowalski's rules; ease curves are the --ease-* tokens in styles/index.css).
 *
 * - Only occasional UI animates: dialogs, popovers, menus, tooltips, switches, button presses.
 *   Keyboard-driven, high-frequency UI (command palette, list navigation, tab switches) stays instant.
 * - Only `opacity` and `scale` move; enters ease out, exits are faster than enters; nothing starts below 0.96.
 * - Anchored popups grow from their trigger (Base UI's `--transform-origin`); modals stay centred.
 * - Base UI sets `data-instant` when a popup opens or closes from the keyboard (Enter/Space, Escape, focus) or,
 *   for tooltips, when a neighbour was already open: those skip the transition entirely.
 * - prefers-reduced-motion: the global rule in styles/index.css drops the scale, the opacity fades stay.
 *
 * Use these strings with `cn(...)` on the Base UI part named in each comment.
 */

/** Anything pressable: colours ease, the element dips to 0.97 while held (160 ms ease-out). */
export const pressMotion = 'transition-[color,background-color,border-color,scale] duration-160 ease-out active:scale-97';

/**
 * Full-width rows (sidebar pages, thread rows, ranked lists, section nav): no scale (0.97 of a 220 px row is a 7 px
 * lurch that reads as layout shift); the background deepens one step past the row's hover (accent ≈ foreground/6)
 * while held. No colour transition: rows are hovered and arrow-keyed through dozens of times a day, and a fade would
 * leave a trail behind keyboard selection (Emil: high-frequency UI stays instant). Keep the row's own hover background.
 */
export const rowPressMotion = 'active:bg-foreground/10';

/** `Popover.Popup` / `Menu.Popup`: scale 0.97 → 1 + fade from the trigger, 150 ms in, 100 ms out. */
export const popupMotion = [
  'origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-out',
  'data-[starting-style]:scale-97 data-[starting-style]:opacity-0',
  'data-[ending-style]:scale-97 data-[ending-style]:opacity-0 data-[ending-style]:duration-100',
  'data-[instant]:transition-none',
].join(' ');

/** `Tooltip.Popup`: same shape as popups but quicker (125 ms in, 90 ms out); adjacent tooltips appear instantly. */
export const tooltipMotion = [
  'origin-(--transform-origin) transition-[opacity,scale] duration-125 ease-out',
  'data-[starting-style]:scale-97 data-[starting-style]:opacity-0',
  'data-[ending-style]:scale-97 data-[ending-style]:opacity-0 data-[ending-style]:duration-90',
  'data-[instant]:transition-none',
].join(' ');

/** `Dialog.Backdrop`: fade, 200 ms in, 150 ms out. */
export const backdropMotion =
  'transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[ending-style]:duration-150';

/** `Dialog.Popup` (modal, centred, so no transform origin): scale 0.96 → 1 + fade, 200 ms in, 150 ms out. */
export const dialogMotion = [
  'transition-[opacity,scale] duration-200 ease-out',
  'data-[starting-style]:scale-96 data-[starting-style]:opacity-0',
  'data-[ending-style]:scale-96 data-[ending-style]:opacity-0 data-[ending-style]:duration-150',
].join(' ');
