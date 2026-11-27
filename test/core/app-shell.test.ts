// Main-process shell: window web preferences, the production menu, quit-time disposal and notifications
// (findings media-4 part 1, foundation-53, foundation-34 main part, foundation-25, foundation-2 window load).
import { afterEach, describe, expect, it, vi } from 'vitest';

const { created } = vi.hoisted(() => ({ created: [] as Array<{ options: Record<string, unknown>; loaded: string[] }> }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWebContents extends EventEmitter {
    setWindowOpenHandler() {}
  }
  class BrowserWindow extends EventEmitter {
    webContents = new FakeWebContents();
    record: { options: Record<string, unknown>; loaded: string[] };
    constructor(options: Record<string, unknown>) {
      super();
      this.record = { options, loaded: [] };
      created.push(this.record);
    }
    loadURL(url: string) {
      this.record.loaded.push(url);
      return Promise.resolve();
    }
    loadFile(path: string) {
      this.record.loaded.push(`loadFile:${path}`);
      return Promise.resolve();
    }
    show() {}
  }
  return { BrowserWindow, shell: { openExternal: async () => undefined } };
});

import { menuRoles, productionMenuTemplate } from '@main/core/app-menu';
import { APP_INDEX_URL, makeAppUrlCheck } from '@main/core/app-origin';
import { silentLogger } from '@main/core/logger';
import { createNotifier, type NotificationHandle } from '@main/core/notifications';
import { createQuitGuard, runDisposers } from '@main/core/shutdown';
import { createMainWindow } from '@main/window';

afterEach(() => {
  created.length = 0;
  vi.useRealTimers();
});

function openWindow(devServerUrl: string | null, devTools: boolean) {
  createMainWindow({
    preload: '/app/preload.cjs',
    devServerUrl,
    isAppUrl: makeAppUrlCheck({ devServerUrl, packaged: false }),
    devTools,
    offscreen: true,
    dark: true,
    log: silentLogger,
  });
  const rec = created.at(-1)!;
  return { prefs: rec.options.webPreferences as Record<string, unknown>, loaded: rec.loaded };
}

describe('createMainWindow', () => {
  it('loads the app:// origin (never file://) with DevTools off outside development', () => {
    const { prefs, loaded } = openWindow(null, false);
    expect(prefs.devTools).toBe(false);
    expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true });
    expect(loaded).toEqual([APP_INDEX_URL]);
  });

  it('keeps DevTools and the dev server in development', () => {
    const { prefs, loaded } = openWindow('http://127.0.0.1:5199/', true);
    expect(prefs.devTools).toBe(true);
    expect(loaded).toEqual(['http://127.0.0.1:5199/']);
  });
});

describe('productionMenuTemplate', () => {
  const forbidden = ['reload', 'forceReload', 'toggleDevTools', 'close', 'viewMenu', 'fileMenu', 'windowMenu', 'defaultMenu'];

  it.each(['linux', 'win32', 'darwin'] as const)('has no reload, close-window or DevTools items on %s', (platform) => {
    const roles = menuRoles(productionMenuTemplate(platform, 'GMI Desk'));
    for (const role of forbidden) expect(roles, role).not.toContain(role);
    // Copy/paste, zoom and quit keep working.
    for (const role of ['copy', 'paste', 'cut', 'selectAll', 'undo', 'zoomIn', 'zoomOut', 'resetZoom', 'quit']) expect(roles, role).toContain(role);
  });

  it('keeps the macOS app and window menus', () => {
    const roles = menuRoles(productionMenuTemplate('darwin', 'GMI Desk'));
    expect(roles).toEqual(expect.arrayContaining(['about', 'hide', 'hideOthers', 'minimize', 'front']));
  });
});

describe('createQuitGuard (before-quit)', () => {
  const event = () => ({ preventDefault: vi.fn() });

  it('holds the first quit until every disposer settled, then quits once', async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const quit = vi.fn(() => order.push('quit'));
    const onBeforeQuit = createQuitGuard({
      disposers: () => [
        () => {
          order.push('media start');
          return slow.then(() => order.push('media flushed')).then(() => undefined);
        },
        () => {
          order.push('sync');
        },
        () => {
          throw new Error('broken disposer');
        },
      ],
      timeoutMs: 3_000,
      quit,
    });
    const first = event();
    onBeforeQuit(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    // A second quit request while disposing is held back too and does not start a second round.
    const second = event();
    onBeforeQuit(second);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(quit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(order.indexOf('media flushed')).toBeLessThan(order.indexOf('quit'));
    // The quit the guard itself triggers goes straight through.
    const final = event();
    onBeforeQuit(final);
    expect(final.preventDefault).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting for a stuck disposer after the timeout', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const done = runDisposers([() => new Promise<void>(() => undefined)], 3_000, { ...silentLogger, warn });
    let finished = false;
    void done.then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(2_900);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(finished).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

class FakeNotification implements NotificationHandle {
  private listeners = new Map<string, Array<() => void>>();
  shown = 0;
  on(event: 'click' | 'close' | 'failed', listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  show() {
    this.shown += 1;
  }
  emit(event: 'click' | 'close' | 'failed') {
    for (const l of this.listeners.get(event) ?? []) l();
  }
}

describe('createNotifier', () => {
  function setup(opts: { maxRetained?: number } = {}) {
    const instances: FakeNotification[] = [];
    let windowExists = false;
    let resolveLoad: (() => void) | null = null;
    const showWindow = vi.fn(() => {
      if (windowExists) return Promise.resolve();
      windowExists = true; // a new window opens; its page loads later
      return new Promise<void>((r) => (resolveLoad = r));
    });
    const notifier = createNotifier({
      supported: () => true,
      create: () => {
        const n = new FakeNotification();
        instances.push(n);
        return n;
      },
      showWindow,
      maxRetained: opts.maxRetained,
    });
    return { notifier, instances, showWindow, finishLoad: () => resolveLoad?.(), setWindow: (v: boolean) => (windowExists = v) };
  }

  it('keeps shown notifications referenced until they are clicked, closed or fail', () => {
    const { notifier, instances } = setup();
    notifier.notify({ title: 'Video ready', body: 'a' });
    notifier.notify({ title: 'New on GMI', body: 'b' });
    notifier.notify({ title: 'Video failed', body: 'c' });
    expect(instances.map((n) => n.shown)).toEqual([1, 1, 1]);
    expect(notifier.retained).toBe(3);
    instances[0]!.emit('close');
    expect(notifier.retained).toBe(2);
    instances[1]!.emit('failed');
    instances[2]!.emit('click');
    expect(notifier.retained).toBe(0);
  });

  it('bounds how many it keeps', () => {
    const { notifier } = setup({ maxRetained: 2 });
    for (let i = 0; i < 5; i++) notifier.notify({ title: 't', body: String(i) });
    expect(notifier.retained).toBe(2);
  });

  it('a click with no window reopens it and runs the action only after the page loaded', async () => {
    const { notifier, instances, showWindow, finishLoad } = setup();
    const onClick = vi.fn();
    notifier.notify({ title: 'Video ready', body: 'cat', onClick });
    instances[0]!.emit('click');
    await Promise.resolve();
    expect(showWindow).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    finishLoad();
    await vi.waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));
  });

  it('a click with a window focuses it and runs the action right away', async () => {
    const { notifier, instances, showWindow, setWindow } = setup();
    setWindow(true);
    const onClick = vi.fn();
    notifier.notify({ title: 'New on GMI', body: 'x', onClick });
    instances[0]!.emit('click');
    await vi.waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));
    expect(showWindow).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when notifications are unsupported', () => {
    const create = vi.fn();
    const notifier = createNotifier({ supported: () => false, create, showWindow: async () => undefined });
    notifier.notify({ title: 't', body: 'b' });
    expect(create).not.toHaveBeenCalled();
  });
});
