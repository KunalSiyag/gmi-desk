import { DEFAULT_SETTINGS, type AppSettings, type RouterMode, type ThemePreference } from '@shared/contracts/app';
import type { Logger } from './logger';
import { openJsonStore, type JsonStore } from './store';

export interface SettingsService {
  get(): AppSettings;
  update(patch: Partial<AppSettings>): Promise<AppSettings>;
  onChange(listener: (settings: AppSettings, previous: AppSettings) => void): () => void;
}

const THEMES: ThemePreference[] = ['system', 'dark', 'light'];
const ROUTER_MODES: RouterMode[] = ['cost', 'balanced', 'quality'];

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Coerces untrusted input (disk or renderer) into valid settings. */
export function normalizeSettings(raw: unknown, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    theme: THEMES.includes(r.theme as ThemePreference) ? (r.theme as ThemePreference) : base.theme,
    sidebarCollapsed: typeof r.sidebarCollapsed === 'boolean' ? r.sidebarCollapsed : base.sidebarCollapsed,
    catalogRefreshHours: clampInt(r.catalogRefreshHours, 1, 168, base.catalogRefreshHours),
    notifyNewModels: typeof r.notifyNewModels === 'boolean' ? r.notifyNewModels : base.notifyNewModels,
    newModelWindowDays: clampInt(r.newModelWindowDays, 1, 365, base.newModelWindowDays),
    defaultChatModel:
      typeof r.defaultChatModel === 'string' && r.defaultChatModel.length > 0 && r.defaultChatModel.length < 200
        ? r.defaultChatModel
        : r.defaultChatModel === null
          ? null
          : base.defaultChatModel,
    defaultRouterMode: ROUTER_MODES.includes(r.defaultRouterMode as RouterMode) ? (r.defaultRouterMode as RouterMode) : base.defaultRouterMode,
    chatMaxTokens: clampInt(r.chatMaxTokens, 256, 131_072, base.chatMaxTokens),
    saveMediaLocally: typeof r.saveMediaLocally === 'boolean' ? r.saveMediaLocally : base.saveMediaLocally,
  };
}

export async function createSettingsService(path: string, log: Logger): Promise<SettingsService> {
  const store: JsonStore<AppSettings> = await openJsonStore(path, DEFAULT_SETTINGS, {
    log,
    normalize: (raw) => normalizeSettings(raw),
  });
  const listeners = new Set<(s: AppSettings, prev: AppSettings) => void>();
  return {
    get: () => store.get(),
    async update(patch) {
      const previous = store.get();
      const next = normalizeSettings({ ...previous, ...patch }, previous);
      await store.set(next);
      for (const l of listeners) l(next, previous);
      return next;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
