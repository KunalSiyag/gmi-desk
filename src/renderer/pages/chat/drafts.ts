/**
 * Unsaved input on the chat page (pure, no React / DOM): the Chat settings popover's fields and the
 * composer's unsent text per thread.
 */
import { CHAT_MAX_TOKENS_MAX, CHAT_MAX_TOKENS_MIN, type ChatSettings } from '@shared/contracts/chat';

type DraftedSettings = Pick<ChatSettings, 'systemPrompt' | 'temperature' | 'maxTokens'>;

/** The Chat settings popover's fields, as typed. */
export interface SettingsDraft {
  systemPrompt: string;
  temperature: string;
  maxTokens: string;
}

export function draftFromSettings(settings: DraftedSettings): SettingsDraft {
  return {
    systemPrompt: settings.systemPrompt ?? '',
    temperature: settings.temperature === null ? '' : String(settings.temperature),
    maxTokens: String(settings.maxTokens),
  };
}

/** "" → null (use the default), a finite number → it, anything else → undefined (invalid). */
export function parseOptionalNumber(raw: string): number | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The settings change the popover's fields describe (`patch` null when nothing changed) and the fields as they
 * read once saved: an invalid number reverts to the saved value, temperature is clamped to 0–2 and max tokens
 * to the range the main process accepts. One patch for all three fields, so any way of closing the popover
 * (Esc, outside click, Enter, blur) saves everything that was typed.
 */
export function settingsPatchFromDraft(draft: SettingsDraft, settings: DraftedSettings): { patch: Partial<ChatSettings> | null; draft: SettingsDraft } {
  const patch: Partial<ChatSettings> = {};
  const next: SettingsDraft = { ...draft };

  const systemPrompt = draft.systemPrompt.trim() || null;
  if (systemPrompt !== settings.systemPrompt) patch.systemPrompt = systemPrompt;

  const temperature = parseOptionalNumber(draft.temperature);
  if (temperature === undefined) {
    next.temperature = draftFromSettings(settings).temperature;
  } else {
    const value = temperature === null ? null : Math.min(2, Math.max(0, temperature));
    if (value !== settings.temperature) patch.temperature = value;
    next.temperature = value === null ? '' : String(value);
  }

  const maxTokens = parseOptionalNumber(draft.maxTokens);
  if (maxTokens === undefined || maxTokens === null) {
    next.maxTokens = String(settings.maxTokens);
  } else {
    const value = Math.min(CHAT_MAX_TOKENS_MAX, Math.max(CHAT_MAX_TOKENS_MIN, Math.round(maxTokens)));
    if (value !== settings.maxTokens) patch.maxTokens = value;
    next.maxTokens = String(value);
  }

  return { patch: Object.keys(patch).length > 0 ? patch : null, draft: next };
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEEP_IDS = 1_000;

/**
 * Chats with unsent composer text, for createThread's `keepIds`: starting another new chat must not discard an
 * empty chat the user was typing in. Only well-formed ids (the main process rejects the whole call otherwise).
 */
export function keepIdsFromDrafts(drafts: Readonly<Record<string, string>>): string[] {
  return Object.keys(drafts)
    .filter((id) => THREAD_ID.test(id) && Boolean(drafts[id]?.trim()))
    .slice(0, MAX_KEEP_IDS);
}
