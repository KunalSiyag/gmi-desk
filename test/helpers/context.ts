import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GmiEventName } from '@shared/contracts';
import type { AppContext, AppPaths, Platform } from '@main/core/context';
import { createEventBus } from '@main/core/events';
import { createHttp, type FetchLike } from '@main/core/http';
import { silentLogger } from '@main/core/logger';
import { createMemorySecureStore } from '@main/core/secure-store';
import { createSettingsService } from '@main/core/settings';

export interface FakePlatform extends Platform {
  opened: string[];
  revealed: string[];
  notifications: Array<{ title: string; body: string }>;
  /** Value returned by the next pickFile() call. */
  nextPickedFile: string | null;
  /** Value returned by the next pickFiles() call (null = cancelled). */
  nextPickedFiles: string[] | null;
  /** Value returned by the next pickSavePath() call. */
  nextSavePath: string | null;
  /** Value returned by the next pickDirectory() call. */
  nextPickedDirectory: string | null;
  /** Every native picker shown (pickFile / pickFiles / pickSavePath / pickDirectory), in order. */
  pickers: Array<{ kind: 'file' | 'files' | 'save' | 'directory'; title: string }>;
  /** Answer returned by confirm() (default true); every call is recorded in `confirms`. */
  confirmAnswer: boolean;
  confirms: Array<{ title: string; message: string }>;
  /** The fake system clipboard (readClipboardText / clearClipboardIfEquals). */
  clipboard: string;
  clipboardReads: number;
  /** Whether an app window has focus (default true). */
  focused: boolean;
  /** Simulates the main window gaining focus (calls every onAppFocus listener). */
  emitFocus(): void;
  focusListeners: Set<() => void>;
}

export interface TestContext {
  ctx: AppContext;
  dir: string;
  emitted: Array<{ name: GmiEventName; payload: unknown }>;
  platform: FakePlatform;
  cleanup(): Promise<void>;
}

/** A real AppContext over a temp dir, fake fetch, in-memory secrets and a recording platform. */
/** installId of every test context (32 hex characters, like a real one). */
export const TEST_INSTALL_ID = '0123456789abcdef0123456789abcdef';

export async function createTestContext(
  opts: { fetch?: FetchLike; mock?: boolean; now?: () => Date; installId?: string } = {},
): Promise<TestContext> {
  const dir = await mkdtemp(join(tmpdir(), 'gmi-desk-test-'));
  const paths: AppPaths = {
    userData: dir,
    data: join(dir, 'data'),
    media: join(dir, 'media'),
    logs: join(dir, 'logs'),
    secure: join(dir, 'secure'),
    exports: join(dir, 'exports'),
  };
  for (const p of Object.values(paths)) await mkdir(p, { recursive: true });

  const emitted: TestContext['emitted'] = [];
  const events = createEventBus((name, payload) => emitted.push({ name, payload }));
  const platform: FakePlatform = {
    opened: [],
    revealed: [],
    notifications: [],
    nextPickedFile: null,
    nextPickedFiles: null,
    nextSavePath: null,
    nextPickedDirectory: null,
    pickers: [],
    async openExternal(url) {
      platform.opened.push(url);
    },
    showItemInFolder(path) {
      platform.revealed.push(path);
    },
    notify({ title, body }) {
      platform.notifications.push({ title, body });
    },
    async pickFile({ title }) {
      platform.pickers.push({ kind: 'file', title });
      const f = platform.nextPickedFile;
      platform.nextPickedFile = null;
      return f;
    },
    async pickFiles({ title }) {
      platform.pickers.push({ kind: 'files', title });
      const files = platform.nextPickedFiles;
      platform.nextPickedFiles = null;
      return files && files.length > 0 ? files : null;
    },
    async pickSavePath({ title }) {
      platform.pickers.push({ kind: 'save', title });
      const path = platform.nextSavePath;
      platform.nextSavePath = null;
      return path;
    },
    async pickDirectory({ title }) {
      platform.pickers.push({ kind: 'directory', title });
      const dir = platform.nextPickedDirectory;
      platform.nextPickedDirectory = null;
      return dir;
    },
    focusApp() {},
    confirmAnswer: true,
    confirms: [],
    async confirm({ title, message }) {
      platform.confirms.push({ title, message });
      return platform.confirmAnswer;
    },
    clipboard: '',
    clipboardReads: 0,
    async readClipboardText() {
      platform.clipboardReads += 1;
      return platform.clipboard;
    },
    async clearClipboardIfEquals(text) {
      if (!text.trim() || platform.clipboard.trim() !== text.trim()) return false;
      platform.clipboard = '';
      return true;
    },
    focused: true,
    isAppFocused: () => platform.focused,
    focusListeners: new Set(),
    onAppFocus(listener) {
      platform.focusListeners.add(listener);
      return () => {
        platform.focusListeners.delete(listener);
      };
    },
    emitFocus() {
      platform.focused = true;
      for (const listener of [...platform.focusListeners]) listener();
    },
  };

  const ctx: AppContext = {
    mock: opts.mock ?? false,
    paths,
    log: silentLogger,
    http: createHttp({ userAgent: 'GMI-Desk/test', log: silentLogger, fetch: opts.fetch }),
    events,
    secure: createMemorySecureStore(),
    settings: await createSettingsService(join(paths.data, 'settings.json'), silentLogger),
    platform,
    installId: opts.installId ?? TEST_INSTALL_ID,
    now: opts.now ?? (() => new Date()),
  };

  return {
    ctx,
    dir,
    emitted,
    platform,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
