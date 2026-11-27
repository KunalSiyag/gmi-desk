import type { EventBus } from './events';
import type { Http } from './http';
import type { Logger } from './logger';
import type { SecureStore } from './secure-store';
import type { SettingsService } from './settings';

export interface AppPaths {
  /** Electron userData dir. */
  userData: string;
  /** JSON stores (catalog cache, chat threads, media ledger, budgets...). */
  data: string;
  /** Downloaded media outputs (served to the renderer via gmi-media://). */
  media: string;
  logs: string;
  /** Encrypted secrets. */
  secure: string;
  /** Exports such as the OpenCode config. */
  exports: string;
}

/** OS integrations, injected so services stay testable without Electron. */
export interface Platform {
  /** Opens an allow-listed https URL in the system browser (throws for anything else). */
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): void;
  notify(opts: { title: string; body: string; onClick?: () => void }): void;
  /** Native open-file dialog. Null when cancelled. */
  pickFile(opts: { title: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
  /** Native multi-file open dialog. Null when cancelled (never an empty list). */
  pickFiles(opts: { title: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[] | null>;
  /** Native save dialog. Null when cancelled. */
  pickSavePath(opts: { title: string; defaultName: string }): Promise<string | null>;
  /** Native folder picker. Null when cancelled. */
  pickDirectory(opts: { title: string }): Promise<string | null>;
  /** Brings the main window to the front (e.g. after the OAuth browser round-trip). */
  focusApp(): void;
  /**
   * Native confirmation dialog shown by the MAIN process (a compromised renderer cannot skip it).
   * Use for actions that loosen safety limits. Resolves true only when the user confirms.
   */
  confirm(opts: { title: string; message: string; detail?: string; confirmLabel: string; cancelLabel?: string }): Promise<boolean>;
  /**
   * Plain text on the system clipboard ('' when empty or unreadable; Wayland only answers while a window has
   * focus). Main process only: clipboard contents never go to the renderer or the logs.
   */
  readClipboardText(): Promise<string>;
  /** Clears the clipboard when it still holds `text` (ignoring surrounding whitespace). True when it was cleared. */
  clearClipboardIfEquals(text: string): Promise<boolean>;
  /** Whether one of the app's windows has keyboard focus. */
  isAppFocused(): boolean;
  /** Calls `listener` whenever an app window gains focus. Returns the unsubscribe function. */
  onAppFocus(listener: () => void): () => void;
}

export interface AppContext {
  /** GMI_DESK_MOCK=1: services serve recorded fixtures instead of calling GMI. */
  mock: boolean;
  paths: AppPaths;
  log: Logger;
  http: Http;
  events: EventBus;
  secure: SecureStore;
  settings: SettingsService;
  platform: Platform;
  /**
   * Random id of this installation (16 bytes, hex; `data/install.json`). Not a secret: it tags remote resources
   * this install creates (`gmid-<inst6>-…`) and scopes local data.
   */
  installId: string;
  now(): Date;
}
