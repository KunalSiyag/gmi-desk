import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, Notification, powerMonitor, protocol, safeStorage, session, shell } from 'electron';
import { APP_ID, APP_NAME, APP_VERSION, isAllowedExternalUrl, USER_AGENT } from '@shared/app';
import { IPC_EVENT_CHANNEL, type GmiEventName } from '@shared/contracts';
import type { AppInfo, SecureStorageBackend } from '@shared/contracts/app';
import { productionMenuTemplate } from './core/app-menu';
import { createClipboardOps } from './core/clipboard';
import { APP_SCHEME, makeAppUrlCheck, resolveAppFile, resolveDevServerUrl } from './core/app-origin';
import type { AppContext, AppPaths, Platform } from './core/context';
import { stripDevEnv } from './core/dev-env';
import { createEventBus } from './core/events';
import { createHttp } from './core/http';
import { loadInstallId } from './core/install-id';
import { createLogger, type Logger } from './core/logger';
import { fromMediaUrl, MEDIA_SCHEME } from './core/media-paths';
import { safeSaveName } from './core/save-path';
import { createSecureStore, type Cipher } from './core/secure-store';
import { sweepStaleTempFiles } from './core/store';
import { createNotifier } from './core/notifications';
import { createSettingsService } from './core/settings';
import type { SliceHost } from './core/services';
import { createQuitGuard, registeredQuitChecks, type Disposer } from './core/shutdown';
import { parseShotSpecs, runScreenshots } from './dev/screenshots';
import { registerApi } from './ipc/registry';
import { createAppApi } from './services/app';
import { createAuthSlice } from './services/auth';
import { createCatalogSlice } from './services/catalog';
import { createChatSlice } from './services/chat';
import { createMediaSlice } from './services/media';
import { createUsageSlice } from './services/usage';
import { setupCodeSlice } from './slices/code';
import { setupComputeSlice } from './slices/compute';
import { setupComputerSlice } from './slices/computer';
import { alwaysOnlineSignals, setupGatewaySlice } from './slices/gateway';
import { setupHarnessSlice } from './slices/harness';
import { createMainWindow } from './window';

// A packaged build ignores every developer override (dev server URL, mock data, screenshot mode, profile dir,
// DevTools, GMI_API_KEY): they are deleted before anything reads them.
const packaged = app.isPackaged;
const strippedEnv = stripDevEnv(process.env, packaged);

/** build/icon.png (Dino on a black tile, scripts/make-icon.mjs) next to dist-electron/, when present. */
function appIconPath(): string | undefined {
  const file = join(__dirname, '..', 'build', 'icon.png');
  return existsSync(file) ? file : undefined;
}

const shotsDir = process.env.GMI_DESK_SHOTS?.trim() || null;
const mock = process.env.GMI_DESK_MOCK === '1' || (shotsDir !== null && process.env.GMI_DESK_SHOTS_LIVE !== '1');
/** Loopback Vite dev server in development; null otherwise (then the renderer loads from app://gmi-desk/). */
const devServerUrl = resolveDevServerUrl(process.env.VITE_DEV_SERVER_URL, packaged);
/** DevTools, reload and Electron's default menu: development only (or GMI_DESK_DEVTOOLS=1 in an unpackaged build). */
const devTools = devServerUrl !== null || process.env.GMI_DESK_DEVTOOLS === '1';
/** Grace period for slices to dispose (abort downloads, flush stores) before the process exits. */
const QUIT_DISPOSE_TIMEOUT_MS = 3_000;
/** After a (re)opened window finished loading, time for React to mount and subscribe to events. */
const RENDERER_SETTLE_MS = 500;

app.setName(APP_NAME);
if (process.env.GMI_DESK_USER_DATA) app.setPath('userData', process.env.GMI_DESK_USER_DATA);
else if (shotsDir) {
  const throwaway = join(tmpdir(), `gmi-desk-shots-${process.pid}`);
  app.setPath('userData', throwaway);
  // Screenshot runs use a fresh profile each time; remove it when the process exits.
  process.once('exit', () => {
    try {
      rmSync(throwaway, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}
else if (mock) app.setPath('userData', join(app.getPath('appData'), `${APP_NAME} Mock`));

// Must be a single call: app:// serves the renderer itself, gmi-media:// the downloaded outputs.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const singleInstance = mock || shotsDir ? true : app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow: BrowserWindow | null = null;
/** Set by bootstrap; reopens the main window (macOS dock click after all windows closed). */
let openMainWindow: (() => void) | null = null;
/** Resolves once the current main window's page has loaded (see showMainWindow). */
let mainWindowReady: Promise<void> = Promise.resolve();
const disposers: Disposer[] = [];
/** Set by bootstrap (shutdown logging). */
let rootLog: Logger | undefined;

function electronCipher(): Cipher {
  return {
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    backend(): SecureStorageBackend {
      if (process.platform !== 'linux') return 'os';
      const backend = safeStorage.getSelectedStorageBackend();
      return backend === 'basic_text' ? 'basic_text' : 'os';
    },
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    async decrypt(data) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(data);
      return { value: result, shouldReEncrypt };
    },
  };
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

/**
 * Shows the main window, opening a new one when there is none (macOS keeps running after the last window
 * closes). Resolves once the page has loaded and React had time to subscribe to events.
 */
function showMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    return mainWindowReady;
  }
  if (!openMainWindow) return Promise.reject(new Error('the app is still starting'));
  openMainWindow();
  return mainWindowReady.then(() => focusMainWindow());
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  const paths: AppPaths = {
    userData,
    data: join(userData, 'data'),
    media: join(userData, 'media'),
    logs: join(userData, 'logs'),
    secure: join(userData, 'secure'),
    exports: join(userData, 'exports'),
  };
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });

  const log = createLogger({
    file: join(paths.logs, 'main.log'),
    level: process.env.GMI_DESK_LOG_LEVEL === 'debug' ? 'debug' : 'info',
    scope: 'main',
  });
  rootLog = log;
  log.info(`${APP_NAME} ${APP_VERSION} starting`, { mock, shots: Boolean(shotsDir), dev: Boolean(devServerUrl), packaged, devTools });
  if (strippedEnv.length > 0) log.warn('packaged build: ignoring developer environment overrides', { names: strippedEnv });
  // Temp files of writes interrupted by a crash or kill (the media slice sweeps its own partial downloads).
  void sweepStaleTempFiles([paths.data, paths.secure, paths.exports], { log: log.child('sweep') });

  const http = createHttp({ userAgent: USER_AGENT, log });
  const events = createEventBus((name: GmiEventName, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_EVENT_CHANNEL, name, payload);
    }
  });
  const settings = await createSettingsService(join(paths.data, 'settings.json'), log.child('settings'));
  const secure = await createSecureStore(paths.secure, electronCipher(), log.child('secure'));

  const notifier = createNotifier({
    supported: () => !shotsDir && Notification.isSupported(),
    create({ title, body }) {
      const n = new Notification({ title, body, silent: false });
      // The handle (and through it `n`) stays referenced by the notifier until click/close/failed.
      return { on: (event, listener) => n.on(event as 'click', listener), show: () => n.show() };
    },
    showWindow: showMainWindow,
    log: log.child('notify'),
  });

  const platform: Platform = {
    async openExternal(url) {
      if (!isAllowedExternalUrl(url)) throw new Error(`refusing to open ${url}`);
      await shell.openExternal(url);
    },
    showItemInFolder: (path) => shell.showItemInFolder(path),
    notify: (opts) => notifier.notify(opts),
    async pickFile({ title, filters }) {
      const options = { title, filters, properties: ['openFile' as const] };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async pickFiles({ title, filters }) {
      const options = { title, filters, properties: ['openFile' as const, 'multiSelections' as const] };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths;
    },
    async pickSavePath({ title, defaultName }) {
      // Only a file name is ever suggested (names can come from a remote machine); the folder is Downloads.
      const options = { title, defaultPath: join(app.getPath('downloads'), safeSaveName(defaultName)) };
      const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    async pickDirectory({ title }) {
      const options = { title, properties: ['openDirectory' as const, 'createDirectory' as const] };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    focusApp: focusMainWindow,
    async confirm({ title, message, detail, confirmLabel, cancelLabel }) {
      const options = {
        type: 'warning' as const,
        title,
        message,
        detail,
        buttons: [cancelLabel ?? 'Cancel', confirmLabel],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
      return result.response === 1;
    },
    ...createClipboardOps(clipboard),
    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,
    onAppFocus(listener) {
      const onFocus = () => listener();
      app.on('browser-window-focus', onFocus);
      return () => {
        app.off('browser-window-focus', onFocus);
      };
    },
  };

  const installId = await loadInstallId(paths.data, { log: log.child('install') });
  const ctx: AppContext = { mock, paths, log, http, events, secure, settings, platform, installId, now: () => new Date() };

  /** The built renderer, next to the main bundle; served as app://gmi-desk/. */
  const rendererDir = join(__dirname, '../dist/renderer');
  const isAppUrl = makeAppUrlCheck({ devServerUrl, packaged });
  const isTrustedSender = (event: { senderFrame?: { url: string } | null }) => {
    const url = event.senderFrame?.url;
    return typeof url === 'string' && isAppUrl(url);
  };
  const regOpts = { log, isTrustedSender };
  // Feature registrations (src/main/slices/): each registers its own namespaces and disposers.
  const sliceHost: SliceHost = {
    registerApi: (ns, api) => {
      disposers.push(registerApi(ipcMain, ns, api, regOpts));
    },
    onDispose: (dispose) => {
      disposers.push(dispose);
    },
  };

  const auth = await createAuthSlice(ctx);
  const catalog = await createCatalogSlice(ctx, { auth: auth.service, mcp: auth.mcp, keys: auth.keys });
  const usage = await createUsageSlice(ctx, { auth: auth.service, mcp: auth.mcp });
  const budgetDeps = { budget: usage.budget, budgetSources: usage.budgetSources };
  // The gateway is registered before chat (harness.md §24 H1-0); chat's traffic runs on it (H1-C). Its
  // connectivity gate hears the OS (mock mode: always online, so demo chat never waits for a real network).
  const signals = mock
    ? alwaysOnlineSignals
    : {
        isOnline: () => net.isOnline(),
        onResume: (listener: () => void) => {
          powerMonitor.on('resume', listener);
          return () => {
            powerMonitor.off('resume', listener);
          };
        },
      };
  const gateway = await setupGatewaySlice(ctx, { keys: auth.keys, catalog: catalog.service, ...budgetDeps, signals }, sliceHost);
  const chat = await createChatSlice(ctx, { keys: auth.keys, catalog: catalog.service, budget: usage.budget, gateway: gateway.gateway });
  const media = await createMediaSlice(ctx, { auth: auth.service, mcp: auth.mcp, catalog: catalog.service, budget: usage.budget });
  disposers.push(
    () => media.dispose(),
    () => chat.dispose(),
    // The gateway's final flush writes spend-ledger rows: usage shuts down only after it.
    async () => {
      await gateway.dispose();
      await usage.dispose();
    },
    () => catalog.dispose(),
    () => auth.dispose(),
  );

  const getInfo = (): AppInfo => ({
    name: APP_NAME,
    version: APP_VERSION,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    mock,
    userDataDir: paths.userData,
    mediaDir: paths.media,
    secureStorage: secure.backend,
  });

  disposers.push(
    registerApi(ipcMain, 'app', createAppApi(ctx, getInfo), regOpts),
    registerApi(ipcMain, 'auth', auth.api, regOpts),
    registerApi(ipcMain, 'catalog', catalog.api, regOpts),
    registerApi(ipcMain, 'chat', chat.api, regOpts),
    registerApi(ipcMain, 'media', media.api, regOpts),
    registerApi(ipcMain, 'usage', usage.usage, regOpts),
    registerApi(ipcMain, 'docs', usage.docs, regOpts),
    registerApi(ipcMain, 'support', usage.support, regOpts),
  );

  const compute = await setupComputeSlice(ctx, { auth: auth.service, keys: auth.computeKeys, catalog: catalog.service, ...budgetDeps }, sliceHost);
  await setupComputerSlice(ctx, { compute }, sliceHost);
  const harness = await setupHarnessSlice(
    ctx,
    { gateway: gateway.gateway, catalog: catalog.service, mcp: auth.mcp, auth: auth.service, budget: usage.budget, compute },
    sliceHost,
  );
  await setupCodeSlice(ctx, { gateway: gateway.gateway, harness, compute }, sliceHost);

  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    const file = resolveAppFile(rendererDir, request.url);
    const isFile = file ? await stat(file).then((s) => s.isFile(), () => false) : false;
    if (!file || !isFile) return new Response('Not found', { status: 404 });
    // net.fetch on the file URL supplies the right Content-Type for scripts, styles, fonts and images.
    return net.fetch(pathToFileURL(file).toString());
  });

  protocol.handle(MEDIA_SCHEME, async (request) => {
    const file = fromMediaUrl(paths.media, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Outside development: no reload, close-window or DevTools accelerators (see productionMenuTemplate).
  if (!devTools) Menu.setApplicationMenu(Menu.buildFromTemplate(productionMenuTemplate(process.platform, APP_NAME)));

  // Deny every web permission (camera, mic, geolocation, notifications...). The renderer needs none.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

  const applyTheme = () => {
    nativeTheme.themeSource = settings.get().theme;
  };
  applyTheme();
  settings.onChange((next) => {
    applyTheme();
    events.emit('app:settings', next);
  });

  openMainWindow = () => {
    const win = createMainWindow({
      preload: join(__dirname, 'preload.cjs'),
      devServerUrl,
      isAppUrl,
      devTools,
      offscreen: Boolean(shotsDir),
      dark: nativeTheme.shouldUseDarkColors,
      icon: process.platform === 'darwin' ? undefined : appIconPath(),
      log: log.child('window'),
    });
    // The clipboard watcher belongs to the Connect dialog in this page. A closed window (macOS keeps the app
    // running), a crashed renderer or a reload never sends stopKeyDetection, so stop it here (DECISIONS D14).
    const stopKeyWatch = () => void auth.api.stopKeyDetection().catch(() => undefined);
    win.webContents.on('render-process-gone', stopKeyWatch);
    win.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopKeyWatch();
    });
    win.on('closed', () => {
      stopKeyWatch();
      if (mainWindow === win) mainWindow = null;
    });
    mainWindow = win;
    mainWindowReady = new Promise<void>((resolve) => {
      const settle = () => setTimeout(resolve, RENDERER_SETTLE_MS);
      win.webContents.once('did-finish-load', settle);
      win.webContents.once('did-fail-load', settle);
      win.once('closed', () => resolve());
    });
  };
  openMainWindow();

  // Windows: clicks on toasts whose Notification object is gone (Action Center, after a restart) still
  // bring the app to the front.
  if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') {
    Notification.handleActivation((details) => {
      if (details.type === 'click') void notifier.activate();
    });
  }

  catalog.start();
  // Timers do not fire during sleep: re-check the catalog schedule when the machine wakes up.
  powerMonitor.on('resume', () => catalog.wake());
  powerMonitor.on('unlock-screen', () => catalog.wake());

  if (shotsDir && mainWindow) {
    const specs = parseShotSpecs(process.env.GMI_DESK_SHOTS_PAGES);
    try {
      await runScreenshots(mainWindow, { dir: shotsDir, specs, events, settings, log: log.child('shots') });
    } catch (error) {
      log.error('screenshot run failed', error);
      process.exitCode = 1;
    }
    app.quit();
  }
}

if (singleInstance) {
  // A second launch brings the app back, opening a window when there is none (e.g. after a cancelled quit).
  app.on('second-instance', () => {
    showMainWindow().catch(() => undefined);
  });
  app.setAppUserModelId(APP_ID);

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error('[main] failed to start', error);
    dialog.showErrorBox(`${APP_NAME} failed to start`, error instanceof Error ? error.message : String(error));
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || shotsDir) app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && openMainWindow) openMainWindow();
  });

  // Quit waits (up to QUIT_DISPOSE_TIMEOUT_MS) for the slices to abort downloads/streams and flush their stores.
  app.on(
    'before-quit',
    createQuitGuard({
      // Asked first (e.g. compute: containers still billing); a cancel keeps the app running.
      checks: registeredQuitChecks,
      disposers: () => disposers.splice(0),
      timeoutMs: QUIT_DISPOSE_TIMEOUT_MS,
      quit: () => app.quit(),
      // Closing the last window quits on Linux/Windows: after a cancel, show a window again or the app runs headless.
      onCancel: () => {
        if (BrowserWindow.getAllWindows().length === 0) openMainWindow?.();
      },
      get log() {
        return rootLog?.child('shutdown');
      },
    }),
  );
}
