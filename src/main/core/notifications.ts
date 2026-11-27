import type { Logger } from './logger';

/** The part of Electron's Notification the notifier uses (a fake in tests). */
export interface NotificationHandle {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
  show(): void;
}

export interface NotifierOptions {
  supported(): boolean;
  create(opts: { title: string; body: string }): NotificationHandle;
  /**
   * Brings the main window to the front, opening a new one when there is none (macOS keeps running after the
   * last window closes). Resolves once the window's page can receive events.
   */
  showWindow(): Promise<void>;
  /** Shown notifications kept referenced at most (the oldest are released first). */
  maxRetained?: number;
  log?: Logger;
}

export interface Notifier {
  notify(opts: { title: string; body: string; onClick?: () => void }): void;
  /** What a click does: show (or reopen) the main window, then run `onClick` once the page can receive it. */
  activate(onClick?: () => void): Promise<void>;
  /** Notifications currently referenced (for tests). */
  readonly retained: number;
}

/**
 * Desktop notifications that keep working in the background.
 * - Each shown notification stays referenced until it is clicked, closed or fails: a garbage-collected
 *   Electron Notification drops out of the macOS Notification Center and loses its click events on Windows.
 * - A click runs its action (usually an `app:navigate` event) only once a window exists and its page has
 *   loaded, so clicking "Video ready" after closing the window reopens it on the right page.
 */
export function createNotifier(opts: NotifierOptions): Notifier {
  const live = new Set<NotificationHandle>();
  const max = Math.max(1, opts.maxRetained ?? 50);

  async function activate(onClick?: () => void): Promise<void> {
    try {
      await opts.showWindow();
    } catch (error) {
      opts.log?.warn('could not show the window for a notification click', error);
      return;
    }
    try {
      onClick?.();
    } catch (error) {
      opts.log?.warn('notification click handler failed', error);
    }
  }

  return {
    get retained() {
      return live.size;
    },
    activate,
    notify({ title, body, onClick }) {
      if (!opts.supported()) return;
      const n = opts.create({ title, body });
      live.add(n);
      for (const old of live) {
        if (live.size <= max) break;
        live.delete(old);
      }
      const release = () => {
        live.delete(n);
      };
      n.on('click', () => {
        release();
        void activate(onClick);
      });
      n.on('close', release);
      n.on('failed', release);
      n.show();
    },
  };
}
