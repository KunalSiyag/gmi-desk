import type { ModelParameter } from './catalog';
import type { BudgetCheck } from './usage';

export type MediaModality = 'image' | 'video' | 'audio' | 'workflow' | 'other';

export type MediaJobStatus =
  | 'created'
  | 'queued'
  | 'dispatched'
  | 'processing'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export const TERMINAL_JOB_STATUSES: readonly MediaJobStatus[] = ['success', 'failed', 'cancelled'];

export interface MediaOutput {
  /** Remote URL. GMI stores outputs at public, unsigned URLs. */
  url: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  /** Local copy (inside the app's media folder) once downloaded. */
  localPath: string | null;
  /** `gmi-media://` URL the renderer can display for the local copy. */
  localUrl: string | null;
  mimeType: string | null;
  /** Size of the local copy in bytes, when downloaded. */
  bytes?: number | null;
}

/** Request fields GMI takes outside `parameters` (kept so a job can be retaken exactly). */
export interface MediaRequestOptions {
  aspectRatio?: string;
  negativePrompt?: string;
  n?: number;
  seed?: number;
}

export interface MediaJob {
  id: string;
  modelId: string;
  modality: MediaModality;
  status: MediaJobStatus;
  prompt: string | null;
  parameters: Record<string, unknown>;
  /** Approved estimate (charged price) when submitted from this app. */
  estimateUsd: number | null;
  createdAt: string;
  updatedAt: string;
  outputs: MediaOutput[];
  error: string | null;
  /** False for jobs found in GMI's history that were not started from this app. */
  fromThisDevice: boolean;
  /** List price (before discount) of the approved estimate. */
  listUsd?: number | null;
  /** Discount fraction applied to the approved estimate. */
  discount?: number | null;
  /** Poster / thumbnail GMI published for the job (https), mostly for video. */
  posterUrl?: string | null;
  /** Top-level request fields (aspect ratio, negative prompt, n, seed) used for the job. */
  options?: MediaRequestOptions | null;
  /**
   * Set on the job returned by `submit` when GMI de-duplicated an identical request and handed back an
   * earlier job instead of starting (and charging) a new one. Retake with a new nonce for a fresh take.
   */
  deduplicated?: boolean;
  /** True once the app gave up polling (too old, or GMI no longer knows the request). */
  pollingStopped?: boolean;
  /** When this app saw the job reach a terminal status (ISO); null/absent when unknown (e.g. GMI history). */
  finishedAt?: string | null;
}

export interface MediaRequest {
  modelId: string;
  prompt: string;
  /** Model-specific parameters, exactly as the model's schema names them. */
  parameters?: Record<string, unknown>;
  aspectRatio?: string;
  negativePrompt?: string;
  n?: number;
  seed?: number;
}

export interface MediaEstimate {
  listUsd: number | null;
  discount: number | null;
  /** listUsd × (1 − discount); what the job should actually cost. */
  chargedUsd: number | null;
  note: string | null;
  budget: BudgetCheck;
  /** GMI's pricing unit for this model ("image", "second", "1k character", ...). */
  unit?: string | null;
  /**
   * True when GMI cannot price this model before it runs (no list price, or billed by tokens): `chargedUsd` is
   * null, `note` says why, and the app refuses to run it (nothing to approve or check against the budget).
   */
  unpriced?: boolean;
}

export interface UploadResult {
  /** Public URL to pass as a parameter value. Anyone with the link can read it. */
  publicUrl: string;
  fileName: string;
  contentType: string;
  bytes: number;
  /** `gmi-media://` URL of the local copy kept in the media folder (for thumbnails), when available. */
  previewUrl?: string | null;
}

export interface MediaJobList {
  jobs: MediaJob[];
  total: number;
  /** Why GMI's history could not be merged in (the list then holds local jobs only). */
  remoteError?: string | null;
}

export interface MediaApi {
  /** Free; nothing is charged or queued. Note: GMI does not validate parameters here. */
  estimate(req: MediaRequest): Promise<MediaEstimate>;
  /** Spends balance. `approvedUsd` must be the estimate the user approved (budget + confirmation checks). */
  submit(req: MediaRequest & { approvedUsd: number | null; nonce?: string }): Promise<MediaJob>;
  getJob(id: string): Promise<MediaJob>;
  /** Local jobs merged with GMI's generation history, newest first. */
  listJobs(opts?: { limit?: number; offset?: number; modality?: MediaModality }): Promise<MediaJobList>;
  /** Opens a file picker, then uploads the file to a public GMI URL. Null when the picker is cancelled. */
  pickAndUpload(kind: 'image' | 'video' | 'audio'): Promise<UploadResult | null>;
  saveOutput(jobId: string, outputIndex: number): Promise<MediaJob>;
  revealOutput(jobId: string, outputIndex: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers shared by the main process (validation before estimate/submit) and the Create page
// (form generation), so both sides read a model's schema the same way.
// ---------------------------------------------------------------------------------------------

export function isTerminalJobStatus(status: MediaJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** File types GMI's upload_media accepts, per input kind. */
export const MEDIA_UPLOAD_TYPES = {
  image: ['png', 'jpg', 'jpeg'],
  video: ['mp4'],
  audio: ['mp3', 'wav'],
} as const satisfies Record<'image' | 'video' | 'audio', readonly string[]>;

/** Largest file the app uploads (GMI's own limits per model are often lower). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface PreparedMediaSchema {
  /**
   * Name of the field that holds the main text. Usually `prompt`; models without a `prompt` parameter use
   * their first required text field instead (e.g. `text` for text-to-speech). GMI's tools always need a
   * non-empty top-level `prompt`, so this field's value is sent as `prompt` and, when it is not literally
   * `prompt`, also as that parameter.
   */
  promptName: string;
  /** The schema entry for the main text, when the model declares one. */
  promptParam: ModelParameter | null;
  /** Every parameter except the main text field, in schema order (numeric enums reconciled). */
  fields: ModelParameter[];
  /** All parameters (numeric enums reconciled), including the main text field. */
  all: ModelParameter[];
}

const NUMERIC_TEXT = /^[+-]?(\d+(\.\d+)?|\.\d+)(e[+-]?\d+)?$/i;

/**
 * GMI publishes some numeric enums as strings while their default (and what the model expects) is a number,
 * e.g. `enum: ["1.048576e+06", ...]` with `default: 4194304`, or `enum: ["44100", ...]` with `default: 44100`.
 * Comparing as text would reject the model's own default, so such enums are converted to numbers.
 */
export function reconcileNumericEnum(p: ModelParameter): ModelParameter {
  if (p.type !== 'enum' || !p.enum || typeof p.default !== 'number') return p;
  if (!p.enum.every((v) => typeof v === 'number' || (typeof v === 'string' && NUMERIC_TEXT.test(v.trim())))) return p;
  const values = p.enum.map((v) => (typeof v === 'number' ? v : Number(v)));
  if (values.some((v) => !Number.isFinite(v))) return p;
  const labels: Record<string, string> = {};
  for (let i = 0; i < values.length; i += 1) {
    const original = p.enum[i];
    const value = values[i] as number;
    const label = p.enumLabels?.[String(original)];
    if (label) labels[String(value)] = label;
  }
  const unique = [...new Map(values.map((v) => [String(v), v])).values()];
  return { ...p, enum: unique, enumLabels: Object.keys(labels).length ? labels : null };
}

/**
 * GMI sometimes publishes an enum whose default is not among its options (seedream-5.0-lite: `size` defaults to
 * "2048x2048" while the enum lists "2K", "3K" and other sizes). The default is GMI's own value, so it is added to
 * the options; otherwise the form would open with a value that its own validation rejects.
 */
export function reconcileEnumDefault(p: ModelParameter): ModelParameter {
  if (p.type !== 'enum' || !p.enum) return p;
  const d = p.default;
  if ((typeof d !== 'string' && typeof d !== 'number') || String(d).trim() === '') return p;
  if (p.enum.some((v) => String(v) === String(d))) return p;
  return { ...p, enum: [d, ...p.enum] };
}

/** Splits a model's (normalised) parameter list into the main text field and the remaining form fields. */
export function prepareMediaSchema(params: ModelParameter[] | null | undefined): PreparedMediaSchema {
  const all = (params ?? []).map((p) => reconcileEnumDefault(reconcileNumericEnum(p)));
  const isText = (p: ModelParameter) => p.type === 'string' || p.type === 'text';
  const promptParam =
    all.find((p) => p.name === 'prompt') ?? all.find((p) => p.required && isText(p)) ?? null;
  const promptName = promptParam?.name ?? 'prompt';
  return { promptName, promptParam, fields: all.filter((p) => p !== promptParam), all };
}

/** Maps a catalog kind / GMI `model_type` to a job modality. */
export function modalityFromKind(kind: string | null | undefined): MediaModality {
  const k = (kind ?? '').toLowerCase();
  if (k === 'image' || k === 'video' || k === 'audio' || k === 'workflow') return k;
  if (k === 'speech' || k === 'tts' || k === 'music') return 'audio';
  return 'other';
}

/** True when every declared output is text (batch inference, face analysis, voice ids): nothing the gallery can show. */
export function producesTextOnly(outputs: ReadonlyArray<{ type: string }> | null | undefined): boolean {
  return !!outputs && outputs.length > 0 && outputs.every((o) => typeof o.type === 'string' && o.type.trim().toLowerCase() === 'text');
}

/** What GMI publishes about a model's price (list price per unit, free-text notes, outputs). */
export interface PricingSignals {
  usdPerUnit?: number | null;
  details?: string | null;
  outputs?: ReadonlyArray<{ type: string }> | null;
}

/**
 * "Actual cost depends on input/output tokens." Deliberately narrow: many image models mention tokens in their notes
 * ("Image output: $30 / 1M tokens", "Token-based; the pre-charge is the final price") and are priced per image.
 */
const COST_DEPENDS_ON_TOKENS = /\bdepends?\s+on\b[^.\n]{0,60}\btokens?\b/i;

/**
 * Why GMI cannot price a model before it runs, or null when its estimate can be trusted. For such models GMI's
 * estimate_generation returns a flat placeholder (e.g. $0.01 for any Gemini batch), which must never be approved,
 * budgeted or recorded as the charge.
 */
export function unpricedReason(signals: PricingSignals): string | null {
  if (producesTextOnly(signals.outputs)) return "GMI can't price this model before it runs: it returns text and is billed by the tokens it uses.";
  if (signals.details && COST_DEPENDS_ON_TOKENS.test(signals.details)) return "GMI can't price this model before it runs: its cost depends on the tokens it uses.";
  if (signals.usdPerUnit === 0) return "GMI can't price this model before it runs: it lists no price for it.";
  return null;
}

/** Host suffixes that only exist on private networks (mDNS, home routers, intranets). */
const PRIVATE_HOST_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'home.arpa', 'corp'];

/**
 * True for an https URL on a public host name: no credentials, no IP literal (v4 or v6), no localhost, single-label
 * or private-use name. GMI's storage and its providers' CDNs always qualify; anything else is not fetched or shown.
 */
export function isPublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  // The URL parser canonicalises every IPv4 spelling (2130706433, 0x7f.1) to dotted decimal; IPv6 keeps brackets.
  if (!host || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  // Single-label names ("https://intranet/") resolve through the local search domain.
  if (!host.includes('.')) return false;
  return !PRIVATE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
