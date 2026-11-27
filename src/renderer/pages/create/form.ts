/**
 * Pure helpers for the Create page (no React, no DOM): how a model's schema becomes a form, how form values become a
 * MediaRequest, and how jobs are labelled and merged into the gallery. DOM-free so test/media can unit-test them.
 */
import type { CatalogModel, ModelParameter } from '@shared/contracts/catalog';
import {
  isPublicHttpsUrl,
  prepareMediaSchema,
  producesTextOnly,
  unpricedReason,
  type MediaEstimate,
  type MediaJob,
  type MediaJobList,
  type MediaOutput,
  type MediaRequest,
  type PreparedMediaSchema,
} from '@shared/contracts/media';
import { truncate } from '@shared/lib/format';
import { applyDiscount, formatDiscount, formatUsd } from '@shared/lib/money';
import { coerceParameterValues, MEDIA_INPUT_TYPES, validateParameterValues } from '@shared/lib/parameters';

// ------------------------------------------------------------------------------------------------ tabs & models

export type CreateTab = 'image' | 'video' | 'audio' | 'workflow';

export const CREATE_TABS: readonly CreateTab[] = ['image', 'video', 'audio', 'workflow'];

export const TAB_LABELS: Record<CreateTab, string> = { image: 'Image', video: 'Video', audio: 'Audio', workflow: 'Workflows' };

export function isCreateTab(value: unknown): value is CreateTab {
  return typeof value === 'string' && (CREATE_TABS as readonly string[]).includes(value);
}

/**
 * Models the Create page can run and show: a media tab's kind and at least one non-text output. Text-only models
 * (Gemini batch inference, face analysis, voice ids) return nothing the gallery can display and are billed by tokens.
 */
export function isGeneratable(model: Pick<CatalogModel, 'kind' | 'outputs'>): boolean {
  return isCreateTab(model.kind) && !producesTextOnly(model.outputs);
}

/** Models offered on a tab: available, matching the search, New first, then GMI's featured picks, then by name. */
export function modelsForTab(models: readonly CatalogModel[], tab: CreateTab, query = ''): CatalogModel[] {
  const q = query.trim().toLowerCase();
  return models
    .filter((m) => m.kind === tab && m.available && isGeneratable(m))
    .filter((m) => !q || [m.id, m.name, m.provider ?? '', ...m.tags].some((s) => s.toLowerCase().includes(q)))
    .sort(
      (a, b) =>
        Number(b.isNew) - Number(a.isNew) ||
        Number(b.featured) - Number(a.featured) ||
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }),
    );
}

/** Why GMI cannot price this catalog model before it runs (no list price, billed by tokens...), or null. */
export function catalogUnpricedReason(model: Pick<CatalogModel, 'mediaPricing' | 'outputs'>): string | null {
  return unpricedReason({ usdPerUnit: model.mediaPricing?.usdPerUnit ?? null, details: model.mediaPricing?.details ?? null, outputs: model.outputs });
}

/**
 * Charged list price per unit for the model header ("$0.068 / image"), with the list price when discounted.
 * Null when GMI publishes no usable unit price (none, or a placeholder for a model it cannot price in advance).
 */
export function unitPrice(model: Pick<CatalogModel, 'mediaPricing' | 'discount'> & Partial<Pick<CatalogModel, 'outputs'>>): {
  charged: string;
  list: string | null;
  unit: string;
} | null {
  const p = model.mediaPricing;
  if (!p || p.usdPerUnit === null) return null;
  if (catalogUnpricedReason({ mediaPricing: p, outputs: model.outputs ?? [] })) return null;
  const charged = applyDiscount(p.usdPerUnit, model.discount);
  const discounted = (model.discount ?? 0) > 0;
  return { charged: formatUsd(charged), list: discounted ? formatUsd(p.usdPerUnit) : null, unit: p.unit ?? 'unit' };
}

// ------------------------------------------------------------------------------------------------ form layout

const NEGATIVE_PROMPT = /^negative[_\s-]?prompt$/i;
/** Rarely changed knobs: always under Advanced. */
const ALWAYS_ADVANCED = /^(seed|watermark|user|moderation|output_compression|enable_safety_checker|safety_tolerance|sync_mode|webhook|callback_url)$/i;
const LONG_TEXT_NAME = /(lyric|text|script|caption|content|story|instruction|negative)/i;

export function isMediaParam(p: ModelParameter): boolean {
  return MEDIA_INPUT_TYPES.includes(p.type);
}

/** Media inputs that take several files (GMI's `max` is the item count for media). */
export function acceptsMany(p: ModelParameter): boolean {
  return isMediaParam(p) && p.max !== null && p.max > 1;
}

export function isLongText(p: ModelParameter): boolean {
  if (p.type === 'text') return true;
  if (p.type !== 'string' && p.type !== 'unknown') return false;
  return LONG_TEXT_NAME.test(p.name) || (typeof p.default === 'string' && p.default.length > 60);
}

/** Fields that need the full form width (uploads, JSON, long text); the rest sit in a two-column grid. */
export function isWideField(p: ModelParameter): boolean {
  return isMediaParam(p) || p.type === 'object' || p.type === 'array' || isLongText(p);
}

export interface FormLayout {
  schema: PreparedMediaSchema;
  /** `negative_prompt`, shown right under the main prompt. */
  negative: ModelParameter | null;
  /** Always visible: required fields, the first couple of media inputs, the first few settings. Wide fields first. */
  primary: ModelParameter[];
  /** Behind the "Advanced" disclosure. Wide fields first. */
  advanced: ModelParameter[];
}

const wideFirst = (list: ModelParameter[]) => [...list.filter(isWideField), ...list.filter((p) => !isWideField(p))];

/** Splits a model's parameters into what the form shows up front and what goes under "Advanced". */
export function layoutFields(params: ModelParameter[] | null | undefined, limits = { settings: 4, media: 2 }): FormLayout {
  const schema = prepareMediaSchema(params);
  const negative = schema.fields.find((p) => NEGATIVE_PROMPT.test(p.name) && (p.type === 'string' || p.type === 'text')) ?? null;
  const primary: ModelParameter[] = [];
  const advanced: ModelParameter[] = [];
  let settings = 0;
  let media = 0;
  for (const p of schema.fields) {
    if (p === negative) continue;
    if (p.required) primary.push(p);
    else if (isMediaParam(p)) {
      if (media < limits.media) {
        primary.push(p);
        media += 1;
      } else advanced.push(p);
    } else if (settings < limits.settings && !ALWAYS_ADVANCED.test(p.name)) {
      primary.push(p);
      settings += 1;
    } else advanced.push(p);
  }
  return { schema, negative, primary: wideFirst(primary), advanced: wideFirst(advanced) };
}

const PROMPT_PLACEHOLDER: Record<CreateTab | 'speech' | 'music', string> = {
  image: 'Describe the image: subject, setting, light, style…',
  video: 'Describe the shot: subject, action, camera movement, style…',
  audio: 'Describe the sound you want…',
  music: 'Describe the music: genre, mood, instruments…',
  speech: 'Type the text to speak…',
  workflow: 'What should this workflow make?',
};

/** Text a model reads out loud (TTS, lip-synced avatars). Whole words, so "description" is not "script". */
const SPOKEN_TEXT = /\b(?:speak\w*|spoken|speech|scripts?|tts|voice\w*|narrat\w*)\b/i;
const mentionsSpokenText = (text: string) => SPOKEN_TEXT.test(text.replace(/[_-]+/g, ' '));

/**
 * Placeholder for the main text field. When the model's main field is not a prompt: text it reads out (TTS, an
 * avatar's `input_text`) asks for the words to speak, and other fields (a session id, an instruction) show GMI's own
 * description of them. Prompts, and fields that describe themselves as one, get the tab's hint.
 */
export function promptPlaceholder(tab: CreateTab, schema: Pick<PreparedMediaSchema, 'promptName' | 'promptParam'>, modelId: string): string {
  const name = schema.promptName;
  if (name !== 'prompt') {
    const description = schema.promptParam?.description?.replace(/\s+/g, ' ').trim() ?? '';
    if (tab === 'audio' || mentionsSpokenText(name) || mentionsSpokenText(description)) return PROMPT_PLACEHOLDER.speech;
    // wan2.7-image's `text` is "The user-entered prompt…": an ordinary prompt.
    if (description.length >= 12 && !/\bprompt\b/i.test(description)) return truncate(description, 90);
  } else if (tab === 'audio') {
    if (/tts|speech|voice/i.test(modelId)) return PROMPT_PLACEHOLDER.speech;
    if (/music|song/i.test(modelId)) return PROMPT_PLACEHOLDER.music;
  }
  return PROMPT_PLACEHOLDER[tab];
}

// ------------------------------------------------------------------------------------------------ values

export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Form values from the schema defaults (the main text field excluded), overlaid with a preset (e.g. a past job). */
export function initialValues(schema: PreparedMediaSchema, preset?: Record<string, unknown> | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const p of schema.fields) {
    if (p.default !== null && p.default !== undefined && p.default !== '') values[p.name] = p.default;
  }
  if (preset) {
    const known = new Set(schema.fields.map((p) => p.name));
    for (const [name, value] of Object.entries(preset)) {
      if (name === 'prompt' || name === schema.promptName) continue;
      // Unknown names are kept only when the model publishes no schema (nothing to check them against).
      if (known.has(name) || schema.all.length === 0) values[name] = value;
    }
  }
  return values;
}

function parseJsonArray(text: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Form values → what validation and GMI expect (JSON lists parsed; numbers, enums and JSON objects coerced). */
function normalizedValues(schema: PreparedMediaSchema, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const byName = new Map(schema.all.map((p) => [p.name, p]));
  for (const [name, value] of Object.entries(values)) {
    const p = byName.get(name);
    if (p?.type === 'array' && typeof value === 'string' && value.trim()) out[name] = parseJsonArray(value) ?? value;
    else if (typeof value === 'string' && p && (isMediaParam(p) || p.type === 'integer' || p.type === 'number')) out[name] = value.trim();
    else out[name] = value;
  }
  return out;
}

export interface FormIssues {
  /** Problem with the main text field, if any. */
  prompt: string | null;
  promptMissing: boolean;
  /** Message per parameter name. */
  fields: Record<string, string>;
  /** Names whose only problem is a missing required value (shown once the user tries to run). */
  missing: Set<string>;
  count: number;
}

/** Client-side validation of the whole form (GMI's estimate does not validate parameters). */
export function formIssues(schema: PreparedMediaSchema, prompt: string, values: Record<string, unknown>): FormIssues {
  const label = schema.promptParam?.label ?? 'Prompt';
  const text = prompt.trim();
  let promptIssue: string | null = null;
  const maxChars = schema.promptParam && (schema.promptParam.type === 'string' || schema.promptParam.type === 'text') ? schema.promptParam.max : null;
  if (!text) promptIssue = `${label} is required.`;
  else if (maxChars && text.length > maxChars) promptIssue = `${label} is too long (${text.length} of ${maxChars} characters).`;

  const fields: Record<string, string> = {};
  const missing = new Set<string>();
  const normalized = normalizedValues(schema, values);
  const byName = new Map(schema.all.map((p) => [p.name, p]));
  for (const issue of validateParameterValues(schema.all, normalized, ['prompt', schema.promptName])) {
    fields[issue.name] = issue.message;
    if (byName.get(issue.name)?.required && isEmptyValue(normalized[issue.name])) missing.add(issue.name);
  }
  return { prompt: promptIssue, promptMissing: !text, fields, missing, count: Object.keys(fields).length + (promptIssue ? 1 : 0) };
}

/** The request the main process prices and runs. The main text goes in `prompt`; the main process maps it. */
export function buildRequest(modelId: string, schema: PreparedMediaSchema, prompt: string, values: Record<string, unknown>): MediaRequest {
  const skip = ['prompt', schema.promptName];
  const normalized = normalizedValues(schema, values);
  return { modelId, prompt: prompt.trim(), parameters: coerceParameterValues(schema.all, normalized, skip) };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Stable JSON for a request (cache key; equal requests give equal keys regardless of key order). */
export function requestKey(req: MediaRequest): string {
  return JSON.stringify(stable(req));
}

/** Deep equality of two form value maps, ignoring key order. */
export function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

// ------------------------------------------------------------------------------------------------ jobs

/** The exact request behind a job started from this app (for a retake). Null for jobs without one. */
export function requestFromJob(job: MediaJob): MediaRequest | null {
  if (!job.prompt || !job.modelId || job.modelId === 'unknown') return null;
  const req: MediaRequest = { modelId: job.modelId, prompt: job.prompt, parameters: { ...job.parameters } };
  const o = job.options;
  if (o?.aspectRatio) req.aspectRatio = o.aspectRatio;
  if (o?.negativePrompt) req.negativePrompt = o.negativePrompt;
  if (o?.n !== undefined) req.n = o.n;
  if (o?.seed !== undefined) req.seed = o.seed;
  return req;
}

const byNewest = (a: MediaJob, b: MediaJob) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/** Applies one `media:job` update to a gallery page: replaces the job, or inserts it in date order. */
export function upsertJob(list: MediaJobList, job: MediaJob): MediaJobList {
  const index = list.jobs.findIndex((j) => j.id === job.id);
  if (index >= 0) {
    const jobs = list.jobs.slice();
    jobs[index] = job;
    return { ...list, jobs };
  }
  return { ...list, jobs: [job, ...list.jobs].sort(byNewest), total: list.total + 1 };
}

export type StatusTone = 'muted' | 'progress' | 'success' | 'danger' | 'warning';

export interface StatusView {
  label: string;
  tone: StatusTone;
  /** Still running: show the working signal (<Plates>). */
  busy: boolean;
}

export function statusView(job: Pick<MediaJob, 'status' | 'pollingStopped'>): StatusView {
  switch (job.status) {
    case 'created':
    case 'queued':
    case 'dispatched':
      return job.pollingStopped ? { label: 'Not tracked', tone: 'warning', busy: false } : { label: 'Queued', tone: 'progress', busy: true };
    case 'processing':
      return job.pollingStopped ? { label: 'Not tracked', tone: 'warning', busy: false } : { label: 'Processing', tone: 'progress', busy: true };
    case 'success':
      return { label: 'Done', tone: 'success', busy: false };
    case 'failed':
      return { label: 'Failed', tone: 'danger', busy: false };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'warning', busy: false };
    default:
      return { label: 'Unknown', tone: 'muted', busy: false };
  }
}

/**
 * What the renderer can display for an output: the local copy when there is one, else its https URL on a public host
 * (never an IP literal, localhost or private-network name, which the main process refuses to download as well).
 */
export function outputSrc(output: MediaOutput): string | null {
  if (output.localUrl) return output.localUrl;
  return isPublicHttpsUrl(output.url) ? output.url : null;
}

/** Charged price headline plus the list price / discount detail ("list $0.07 · 50% off"). */
export function estimateSummary(estimate: MediaEstimate): { charged: string; detail: string | null } {
  const parts: string[] = [];
  const discount = formatDiscount(estimate.discount);
  if (discount && estimate.listUsd !== null && estimate.listUsd !== estimate.chargedUsd) parts.push(`list ${formatUsd(estimate.listUsd)}`, discount);
  return { charged: formatUsd(estimate.chargedUsd), detail: parts.length ? parts.join(' · ') : null };
}

const centsFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Budget amounts read in cents: "$0.79", "<$0.01". */
export function formatCents(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01';
  return centsFmt.format(value);
}

/** Compact age for dense cards: "now", "5m", "3h", "2d", else "Oct 28" (or "Oct 28, 2025"). */
export function shortAge(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.round((now.getTime() - t) / 1000);
  if (sec < 45) return 'now';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  if (sec < 7 * 86_400) return `${Math.round(sec / 86_400)}d`;
  const d = new Date(t);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** Short model label for cards ("seedream-5.0-pro" stays, "org/Model-Name" → "Model-Name"). */
export function shortModelId(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(tail) ? `Workflow ${tail.slice(0, 8)}` : tail;
}
