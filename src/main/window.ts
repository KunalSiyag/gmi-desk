import { BrowserWindow, shell } from 'electron';
import { APP_NAME, isAllowedExternalUrl } from '@shared/app';
import { APP_INDEX_URL } from './core/app-origin';
import type { Logger } from './core/logger';

export { makeAppUrlCheck } from './core/app-origin';

export interface MainWindowOptions {
  preload: string;
  /** Loopback Vite dev server URL in development (see resolveDevServerUrl), null otherwise. */
  devServerUrl: string | null;
  /** The app's own URLs (makeAppUrlCheck): the only in-window navigation allowed. */
  isAppUrl: (url: string) => boolean;
  /** DevTools are available only in development (or with GMI_DESK_DEVTOOLS=1 in an unpackaged build). */
  devTools: boolean;
  /** Render without showing a window (screenshot mode). */
  offscreen: boolean;
  dark: boolean;
  /** Window/taskbar icon (Linux, Windows): build/icon.png (Dino), when it exists. */
  icon?: string;
  log: Logger;
}

/** The current main window (the one createMainWindow made last and that is still open). */
let currentMainWindow: BrowserWindow | null = null;

/**
 * The window native views are drawn in (preview WebContentsViews, compute.md §8.4), or null when none is open
 * (macOS keeps running after the last window closed). Slices read it lazily; the window can be replaced.
 */
export function getMainWindow(): BrowserWindow | null {
  return currentMainWindow && !currentMainWindow.isDestroyed() ? currentMainWindow : null;
}

const createdListeners = new Set<(win: BrowserWindow) => void>();

/**
 * Called for every main window createMainWindow makes (slices that must react to the page reloading or crashing,
 * e.g. the computer's native preview views). Returns an unsubscribe function.
 */
export function onMainWindowCreated(listener: (win: BrowserWindow) => void): () => void {
  createdListeners.add(listener);
  const current = getMainWindow();
  if (current) listener(current);
  return () => {
    createdListeners.delete(listener);
  };
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    // Same as the boot splash and the theme's --background, so the first frame never flashes another colour.
    backgroundColor: opts.dark ? '#000000' : '#fcfcfc',
    ...(opts.icon ? { icon: opts.icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: opts.devTools,
      spellcheck: true,
      offscreen: opts.offscreen,
      backgroundThrottling: !opts.offscreen,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    else opts.log.warn('blocked window.open', { url });
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (opts.isAppUrl(url)) return;
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    else opts.log.warn('blocked navigation', { url });
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  currentMainWindow = win;
  win.on('closed', () => {
    if (currentMainWindow === win) currentMainWindow = null;
  });
  for (const listener of [...createdListeners]) {
    try {
      listener(win);
    } catch (error) {
      opts.log.warn('main window listener failed', { error: String(error) });
    }
  }

  if (!opts.offscreen) win.once('ready-to-show', () => win.show());

  // Production: the privileged app:// scheme (served from dist/renderer by the main process), never file://.
  void win.loadURL(opts.devServerUrl ?? APP_INDEX_URL);

  return win;
}
