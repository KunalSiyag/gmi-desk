import type { ConsolePage } from '../app';

export type ThemePreference = 'system' | 'dark' | 'light';
export type RouterMode = 'cost' | 'balanced' | 'quality';
export type SecureStorageBackend = 'os' | 'basic_text' | 'unavailable';

/** Top-level pages. `welcome` is the signed-out landing screen. */
export type PageId = 'chat' | 'models' | 'create' | 'usage' | 'docs' | 'settings' | 'welcome' | 'compute' | 'code';

export interface NavigateRequest {
  page: PageId;
  params?: Record<string, string>;
}

export interface ToastMessage {
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  mock: boolean;
  userDataDir: string;
  mediaDir: string;
  secureStorage: SecureStorageBackend;
}

export interface AppSettings {
  theme: ThemePreference;
  sidebarCollapsed: boolean;
  /** How often the model catalog refreshes in the background. */
  catalogRefreshHours: number;
  /** Desktop notification when GMI adds models. */
  notifyNewModels: boolean;
  /** A model counts as "New" for this many days after the app first saw it. */
  newModelWindowDays: number;
  defaultChatModel: string | null;
  defaultRouterMode: RouterMode;
  /** Explicit max_tokens for chat (GMI's documented default is only 2000). */
  chatMaxTokens: number;
  /** Download generated media into the media folder automatically. */
  saveMediaLocally: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarCollapsed: false,
  catalogRefreshHours: 6,
  notifyNewModels: true,
  newModelWindowDays: 30,
  defaultChatModel: null,
  defaultRouterMode: 'balanced',
  chatMaxTokens: 8192,
  saveMediaLocally: true,
};

export interface AppApi {
  info(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Opens an allow-listed https URL in the system browser. */
  openExternal(url: string): Promise<void>;
  openConsole(page: ConsolePage): Promise<void>;
  /** Reveals a file that lives inside the app's data folders. */
  showItemInFolder(path: string): Promise<void>;
}
