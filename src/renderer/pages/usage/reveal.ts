/**
 * Brings `el` to the middle of its nearest scrolling ancestor (the page body) and nothing else.
 * Element.scrollIntoView also scrolls every other ancestor, including the app shell's overflow:hidden
 * containers, which would push the top bar and sidebar out of view.
 */
export function revealInPage(el: HTMLElement | null, margin = 16): void {
  if (!el) return;
  let scroller = el.parentElement;
  while (scroller) {
    const { overflowY } = getComputedStyle(scroller);
    if ((overflowY === 'auto' || overflowY === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  if (!scroller) return;
  const box = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  const top = box.top - view.top + scroller.scrollTop;
  // Taller than the view: show its top edge; otherwise centre it.
  const target = box.height + 2 * margin >= scroller.clientHeight ? top - margin : top - (scroller.clientHeight - box.height) / 2;
  scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, Math.round(target)));
}
