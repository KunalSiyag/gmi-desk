/**
 * Small, pure helpers for turning GMI's catalog rows into clean values: names, kinds, units,
 * junk detection. GMI's feeds mix production models with test/probe rows and UUID-named
 * workflows, so everything here is defensive.
 */
import type { ModalitySpec, ModelApi, ModelKind } from '@shared/contracts/catalog';

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s : null;
}

export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Merge key: GMI ids are compared case-insensitively across feeds. */
export function idKey(id: string): string {
  return id.trim().toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Test, probe and capture rows GMI leaves in its public feeds. */
const JUNK_PATTERN = /(?:^|[^a-z])test|probe|capture|ssrf/i;
/** Internal proxy entries and dedicated-endpoint price rows ("646d8d2d5c78/DeepSeek-V4-Pro"). */
const JUNK_ID = /^proxy:|^[0-9a-f]{12}\//i;
/** Early-access rows that are not meant for customers. */
const INTERNAL_TEXT = /internal testing|\[\s*ea\b|set real pricing before launch/i;
const PLACEHOLDER_NAME = /^(?:x+|\d+|n\/?a|null|none|undefined|untitled|tbd|todo|[-_.]+)$/i;

export function isUuidLike(value: string): boolean {
  return UUID.test(value.trim());
}

/** True for ids that never belong in the catalog (tests, probes, internal proxies, dedicated endpoints). */
export function isJunkId(id: string): boolean {
  const s = id.trim();
  return !s || s.length > 200 || JUNK_PATTERN.test(s) || JUNK_ID.test(s);
}

/** True when a display name marks the row as a test/probe/capture entry ("VTX Bypass Test", "Image Capture"). */
export function isJunkName(name: unknown): boolean {
  return typeof name === 'string' && JUNK_PATTERN.test(name);
}

/**
 * True when a description or pricing note marks the row as internal ("[EA - INTERNAL TESTING ONLY]").
 * Descriptions are not matched against the test/probe pattern: real ones say things like "for testing ideas".
 */
export function isInternalText(...values: unknown[]): boolean {
  return values.some((v) => typeof v === 'string' && INTERNAL_TEXT.test(v));
}

/** "ZAI: GLM-5.3" and "StepFun: Step-5" carry the provider as a prefix; it is shown separately. */
const PROVIDER_NAME_PREFIXES = new Set([
  'zai',
  'z.ai',
  'zhipu',
  'stepfun',
  'inclusionai',
  'deepseek',
  'qwen',
  'openai',
  'google',
  'minimax',
  'moonshot',
  'moonshotai',
  'xai',
  'x-ai',
  'nvidia',
  'tencent',
  'meta',
  'anthropic',
  'mistral',
  'bytedance',
  'xiaomi',
]);

const MAX_NAME = 64;

function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Cleans a GMI display name. Returns null when nothing usable is left (UUIDs, hashes, "XXXX", "123").
 *  - "Proxy: zai-org/GLM-4.7" → "GLM-4.7"         - "moonshotai/Kimi: K2.6" → "Kimi K2.6"
 *  - "ZAI: GLM-5.3 Flash" → "GLM-5.3 Flash"       - "Published Workflow - Kiss" → "Kiss" (workflows)
 */
export function cleanModelName(raw: unknown, opts: { workflow?: boolean } = {}): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/^proxy:\s*/i, '');
  if (opts.workflow) {
    s = s.replace(/^published workflows?\s*[-–—:]\s*/i, '').replace(/[.。]$/, '');
  } else {
    // "org/name" (and "org/sub/name") → "name"
    while (/^[A-Za-z0-9._-]+\/\S/.test(s)) s = s.slice(s.indexOf('/') + 1);
    const m = /^([^:]{1,24}):\s+(.+)$/.exec(s);
    if (m && m[1] && m[2]) {
      const prefix = m[1].trim();
      s = PROVIDER_NAME_PREFIXES.has(prefix.toLowerCase()) ? m[2] : `${prefix} ${m[2]}`;
    }
  }
  s = s.trim();
  if (!s || isUuidLike(s) || /^[0-9a-f]{12,}$/i.test(s) || PLACEHOLDER_NAME.test(s)) return null;
  return truncateWords(s, MAX_NAME);
}

/** GMI model_type / kind → app kind. Null when the row says nothing. */
export function mapKind(raw: unknown): ModelKind | null {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!t) return null;
  if (t === 'llm' || t === 'language' || t === 'text' || t === 'chat') return 'llm';
  if (t === 'image' || t === 'video' || t === 'audio' || t === 'workflow') return t;
  return 'other';
}

/** Which API a model is called through. */
export function classifyApi(id: string, kind: ModelKind): ModelApi {
  if (kind !== 'llm') return 'queue';
  if (/-codex|gpt-5\.4-pro|seed-2\.0-mini/i.test(id)) return 'responses';
  return 'chat';
}

/**
 * A "character" price of at least this many micro-USD ($0.001 per character, $1 per 1K) is GMI's
 * per-1K-characters price under a per-character label: Inworld TTS 2 lists 15000 per "character" while
 * GMI's estimate charges 15 micro-USD per character.
 */
const PER_1K_CHARACTERS_MIN_MICRO_USD = 1_000;

/**
 * Cleans GMI's pricing unit using the pricing-type note when the unit is ambiguous, and the price
 * (micro-USD per unit, as GMI publishes it) when the unit is mislabelled.
 */
export function normalizeUnit(unit: unknown, pricingType: unknown, priceMicroUsd?: unknown): string | null {
  const type = typeof pricingType === 'string' ? pricingType.toLowerCase() : '';
  let u = str(unit);
  if (!u) {
    if (/second/.test(type)) return 'second';
    if (/image/.test(type)) return 'image';
    if (/request/.test(type)) return 'request';
    return null;
  }
  const lower = u.toLowerCase();
  if (/^1k\s*characters?$/.test(lower) || (lower === 'character' && /1000|1k|thousand/.test(type))) return '1K characters';
  if (/^characters?$/.test(lower)) {
    const price = num(priceMicroUsd);
    if (price !== null && price >= PER_1K_CHARACTERS_MIN_MICRO_USD) return '1K characters';
  }
  if (lower === 'video' && /per[ _-]?second/.test(type)) return 'second';
  if (lower === 'seconds') u = 'second';
  return u;
}

/** GMI modality lists → ModalitySpec[] (deduped, lower-case types). */
export function normalizeModalities(raw: unknown): ModalitySpec[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, ModalitySpec>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const type = str((item as { type?: unknown }).type)?.toLowerCase();
    if (!type) continue;
    const required = (item as { required?: unknown }).required === true;
    const prev = out.get(type);
    out.set(type, { type, required: Boolean(prev?.required) || required });
  }
  return [...out.values()];
}

export function normalizeTags(...lists: unknown[]): string[] {
  const out = new Map<string, string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const s = str(t)?.replace(/^#+/, '').trim();
      if (!s || s.length > 40) continue;
      const key = s.toLowerCase();
      if (!out.has(key)) out.set(key, s);
    }
  }
  return [...out.values()].slice(0, 10);
}

/** Short free-text field: trimmed, whitespace-collapsed, capped. */
export function shortText(value: unknown, max = 600): string | null {
  const s = str(value);
  if (!s) return null;
  const collapsed = s.replace(/\s+/g, ' ');
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** Fraction 0..1 from a value that should already be a fraction; null for 0 / invalid. */
export function positiveFraction(value: unknown): number | null {
  const n = num(value);
  if (n === null || n <= 0) return null;
  return Math.min(1, n);
}
