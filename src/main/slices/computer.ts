// Registration of the live "computer" (compute.md §8, §14): the `computer` namespace and the PreviewHost it draws port
// previews with. Owned by C2-0 (from F0's stub).
//
// The service itself is `services/compute/computer/index.ts` (C2-A) with one part for files, transfers, ports,
// services (C2-B) and previews (C2-C) (`computer/parts.ts`). Main's own hooks on the main window: a reload or crash of
// its page closes every preview (the new page cannot know their ids, the native views would stay drawn over it) and
// starts the sessions' warm period (§8.1); the renderer's own timers died with the page.
import { app, session, WebContentsView, type BrowserWindow } from 'electron';
import { COMPUTER_API_METHODS, type ComputerApi } from '@shared/contracts/compute';
import type { AppContext } from '../core/context';
import { createElectronPreviewHost, type PreviewHost } from '../core/preview-host';
import type { SliceHost } from '../core/services';
import { createNotImplementedApi } from '../ipc/registry';
import { createComputerService as createComputerServiceImpl } from '../services/compute/computer';
import { computerParts } from '../services/compute/computer/parts';
import { getMainWindow, onMainWindowCreated } from '../window';
import type { ComputeSlice } from './compute';

export interface ComputerSliceDeps {
  compute: ComputeSlice;
}

/** What the computer service (C2-A's `createComputerService`) is built from. */
export interface ComputerServiceDeps extends ComputerSliceDeps {
  /** Native preview views (§8.4); the preview manager (C2-C) is its only user. */
  previewHost: PreviewHost;
}

/** What the computer service hands back to this registration. */
export interface ComputerService {
  api: ComputerApi;
  /** The main window's page reloaded or crashed. */
  viewsGone?(): void;
  dispose(): void | Promise<void>;
}

/** Ports polling pauses while the main window is minimised or hidden (an offscreen screenshot window counts as shown). */
export function mainWindowHidden(win: Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'isVisible'> & { webContents?: { isOffscreen?(): boolean } } | null): boolean {
  if (!win || win.isDestroyed()) return true;
  if (win.isMinimized()) return true;
  if (win.isVisible()) return false;
  return !(win.webContents?.isOffscreen?.() ?? false);
}

/** Calls `gone` when the window's page reloads (a new main-frame document) or its renderer process dies. */
export function watchPageGone(
  win: { webContents: { on(event: 'render-process-gone', l: () => void): unknown; on(event: 'did-start-navigation', l: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown } },
  gone: () => void,
): void {
  // The first navigation (the initial load) also passes here: nothing is open yet, so it is a no-op.
  win.webContents.on('render-process-gone', () => gone());
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) gone();
  });
}

/** The stub API: every method rejects with not_implemented. */
export function notImplementedComputerApi(): ComputerApi {
  return createNotImplementedApi<ComputerApi>('The computer panel', COMPUTER_API_METHODS);
}

/** DevTools for preview views: unpackaged builds with the dev server or GMI_DESK_DEVTOOLS=1 only (as the main window). */
export function previewDevToolsEnabled(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  if (packaged) return false;
  return Boolean(env.VITE_DEV_SERVER_URL) || env.GMI_DESK_DEVTOOLS === '1';
}

export async function setupComputerSlice(ctx: AppContext, deps: ComputerSliceDeps, host: SliceHost): Promise<void> {
  const previewHost = createElectronPreviewHost({
    electron: { WebContentsView, session },
    getWindow: getMainWindow,
    // Outside Electron (unit tests) `app` is undefined: treat as packaged (no DevTools). Nothing else is touched
    // until a preview is created.
    devTools: previewDevToolsEnabled(process.env, typeof app === 'object' && app !== null ? app.isPackaged : true),
    log: ctx.log.child('preview'),
  });
  host.onDispose(() => previewHost.dispose());

  const serviceDeps: ComputerServiceDeps = { ...deps, previewHost };
  const service = createComputerService(ctx, serviceDeps);
  host.registerApi('computer', service.api);
  const offWindow = onMainWindowCreated((win) => {
    watchPageGone(win as never, () => {
      try {
        service.viewsGone?.();
      } catch (error) {
        ctx.log.child('computer').warn('viewsGone failed', { error: String(error) });
      }
    });
  });
  host.onDispose(offWindow);
  // Disposers run concurrently; the preview manager and the host both tolerate the other going first.
  host.onDispose(() => service.dispose());
}

/** The computer service: sessions and terminal (C2-A) plus files, transfers, ports, services and previews. */
export function createComputerService(ctx: AppContext, deps: ComputerServiceDeps): ComputerService {
  const impl = createComputerServiceImpl(ctx, {
    compute: { internals: deps.compute.internals, backends: deps.compute.backends ?? null },
    previewHost: deps.previewHost,
    parts: [computerParts({ windowHidden: () => mainWindowHidden(getMainWindow()) })],
  });
  return { api: impl.api, viewsGone: () => impl.viewsGone(), dispose: () => impl.dispose() };
}
