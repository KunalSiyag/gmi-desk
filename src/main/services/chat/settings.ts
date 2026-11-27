import type { RouterMode } from '@shared/contracts/app';
import { CHAT_MAX_TOKENS_MAX, CHAT_MAX_TOKENS_MIN, type ChatMode, type ChatSettings, type ReasoningEffort } from '@shared/contracts/chat';
import { GmiError } from '@shared/contracts/errors';

/** The renderer's "Auto · GMI Router" picker value (AUTO_MODEL); accepted defensively as a model id. */
export const AUTO_MODEL_SENTINEL = '__auto__';

const MODES: readonly ChatMode[] = ['model', 'auto'];
const ROUTER_MODES: readonly RouterMode[] = ['cost', 'balanced', 'quality'];
const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:/@+-]{0,199}$/;

export const MAX_SYSTEM_PROMPT_CHARS = 20_000;
export const MIN_MAX_TOKENS = CHAT_MAX_TOKENS_MIN;
export const MAX_MAX_TOKENS = CHAT_MAX_TOKENS_MAX;

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

/**
 * Merges `raw` (untrusted: renderer patch or file on disk) over `base`.
 * strict: invalid values throw invalid_input (renderer input); otherwise they fall back to `base` (disk).
 */
export function normalizeChatSettings(raw: unknown, base: ChatSettings, opts: { strict?: boolean } = {}): ChatSettings {
  const strict = opts.strict ?? false;
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const bad = (field: string): never => {
    throw new GmiError('invalid_input', `Invalid chat setting: ${field}.`);
  };
  const out: ChatSettings = { ...base };

  if ('mode' in r && r.mode !== undefined) {
    if (MODES.includes(r.mode as ChatMode)) out.mode = r.mode as ChatMode;
    else if (strict) bad('mode');
  }
  if ('model' in r && r.model !== undefined) {
    if (r.model === null) out.model = null;
    else if (r.model === AUTO_MODEL_SENTINEL) out.mode = 'auto';
    else if (isModelId(r.model)) {
      out.model = r.model;
      // Picking a model implies model mode unless the same patch asks for auto.
      if (!('mode' in r) || r.mode === undefined) out.mode = 'model';
    } else if (strict) bad('model');
  }
  if ('routerMode' in r && r.routerMode !== undefined) {
    if (ROUTER_MODES.includes(r.routerMode as RouterMode)) out.routerMode = r.routerMode as RouterMode;
    else if (strict) bad('routerMode');
  }
  if ('maxTokens' in r && r.maxTokens !== undefined) {
    const n = typeof r.maxTokens === 'number' ? r.maxTokens : Number.NaN;
    if (Number.isFinite(n)) out.maxTokens = Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(n)));
    else if (strict) bad('maxTokens');
  }
  if ('temperature' in r && r.temperature !== undefined) {
    if (r.temperature === null) out.temperature = null;
    else if (typeof r.temperature === 'number' && Number.isFinite(r.temperature)) out.temperature = Math.min(2, Math.max(0, r.temperature));
    else if (strict) bad('temperature');
  }
  if ('reasoningEffort' in r && r.reasoningEffort !== undefined) {
    if (r.reasoningEffort === null) out.reasoningEffort = null;
    else if (EFFORTS.includes(r.reasoningEffort as ReasoningEffort)) out.reasoningEffort = r.reasoningEffort as ReasoningEffort;
    else if (strict) bad('reasoningEffort');
  }
  if ('systemPrompt' in r && r.systemPrompt !== undefined) {
    if (r.systemPrompt === null) out.systemPrompt = null;
    else if (typeof r.systemPrompt === 'string') {
      if (r.systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS && strict) bad('systemPrompt (too long)');
      const trimmed = r.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS).trim();
      out.systemPrompt = trimmed ? trimmed : null;
    } else if (strict) bad('systemPrompt');
  }
  if (out.mode === 'model' && !out.model) out.mode = 'auto';
  return out;
}
