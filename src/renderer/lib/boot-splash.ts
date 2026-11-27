/**
 * The boot splash (#gmi-boot in index.html: Dino + "GMI Desk", painted before any script runs) stays until the
 * app has its first state, then fades out (styles/dino.css) and is removed.
 *
 * It stays at least MIN_VISIBLE_MS after navigation start: a splash that flashes for a frame looks broken, and the
 * window only appears once the splash is painted (ready-to-show), so this is the launch moment, not extra waiting.
 */
export const MIN_VISIBLE_MS = 650;
/** Never keep the app hidden behind the splash longer than this, whatever happens to the first queries. */
export const MAX_VISIBLE_MS = 8000;

let done = false;

export function hideBootSplash(doc: Document = document, now: () => number = () => performance.now()): void {
  if (done) return;
  done = true;
  const el = doc.getElementById('gmi-boot');
  if (!el) return;
  const wait = Math.max(0, MIN_VISIBLE_MS - now());
  setTimeout(() => {
    el.setAttribute('data-done', '');
    el.setAttribute('aria-hidden', 'true');
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      el.remove();
    };
    el.addEventListener('transitionend', (event) => event.target === el && remove());
    // transitionend does not fire with reduced motion settings that zero durations, or when the window is hidden.
    setTimeout(remove, 400);
  }, wait);
}

/** Safety net: hide the splash after MAX_VISIBLE_MS even if the app never reports its first state. */
export function scheduleBootSplashFallback(): void {
  setTimeout(() => hideBootSplash(), MAX_VISIBLE_MS);
}

/** Test hook. */
export function resetBootSplashForTests(): void {
  done = false;
}
