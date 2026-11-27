import { defaultFilter } from 'cmdk';
import type { ChatThreadSummary } from '@shared/contracts/chat';

/**
 * cmdk matches what the user types against an item's `value`, so the value must start with the label the
 * user sees; extra search words follow it.
 */
export function paletteValue(label: string, keywords: readonly string[] = []): string {
  return [label, ...keywords].join(' ');
}

/** Built-in actions (label as shown, plus extra words that should find it). */
export const PALETTE_ACTIONS = {
  newChat: { label: 'New chat', keywords: ['thread', 'conversation'] },
  refreshCatalog: { label: 'Refresh model catalog', keywords: ['reload', 'update', 'models'] },
  signIn: { label: 'Sign in with GMI', keywords: ['log in', 'login', 'account', 'connect'] },
  reopenSignIn: { label: 'Open the GMI sign-in page again', keywords: ['sign in', 'login', 'browser', 'reopen'] },
  cancelSignIn: { label: 'Cancel sign-in', keywords: ['stop', 'abort', 'login'] },
  signOut: { label: 'Sign out of GMI', keywords: ['log out', 'logout', 'account'] },
  connectChat: { label: 'Connect chat', keywords: ['api key', 'inference key', 'add key', 'clipboard', 'setup'] },
  apiKey: { label: 'Manage inference API key', keywords: ['api key', 'token', 'settings'] },
  themeDark: { label: 'Dark theme', keywords: ['appearance', 'mode', 'theme'] },
  themeLight: { label: 'Light theme', keywords: ['appearance', 'mode', 'theme'] },
  themeSystem: { label: 'System theme', keywords: ['appearance', 'mode', 'theme', 'auto'] },
  docs: { label: 'GMI documentation', keywords: ['docs', 'website', 'help'] },
} as const satisfies Record<string, { label: string; keywords: readonly string[] }>;

export type PaletteActionId = keyof typeof PALETTE_ACTIONS;

export function actionValue(id: PaletteActionId): string {
  const a = PALETTE_ACTIONS[id];
  return paletteValue(a.label, a.keywords);
}

/**
 * Separates the searchable part of a value from a hidden suffix that only keeps values unique (cmdk keys
 * items by value). Chat ids go after it, so typing hex-like words ("add", "face") does not match every chat.
 */
const HIDDEN_SUFFIX = '⁣';

/** The palette's filter: cmdk's default scoring, ignoring hidden suffixes. */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const cut = value.indexOf(HIDDEN_SUFFIX);
  return defaultFilter(cut === -1 ? value : value.slice(0, cut), search, keywords);
}

/** Recent chats the palette lists (searchable by title). */
export const MAX_PALETTE_CHATS = 50;

export interface ChatPaletteItem {
  id: string;
  title: string;
  value: string;
}

export function chatPaletteItems(threads: readonly ChatThreadSummary[] | undefined, max = MAX_PALETTE_CHATS): ChatPaletteItem[] {
  if (!threads) return [];
  return [...threads]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, max)
    .map((t) => {
      const title = t.title.trim() || 'Untitled chat';
      return { id: t.id, title, value: `${title}${HIDDEN_SUFFIX}${t.id}` };
    });
}
