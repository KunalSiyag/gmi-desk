/**
 * Tolerant parsers for GMI's media MCP tools. Shapes recorded 2026-10-31 (see src/main/mock/fixtures/media):
 *  - estimate_generation → { currency: "micro_usd", model_id, price_micro_usd, price_usd: "0.024", unit, note? }
 *  - get_generation      → { request_id, model_id, status, media: [{ type, mime_type, url }], poster? }
 *                          | { request_id, model_id, status: "failed", failure_reason, note }
 *  - submit_generation   → the finished result (same shape as get_generation) or a handle to poll; for video GMI
 *                          answers with text ("Still running ... request_id \"req_...\"") or { request_id, status }.
 *  - list_generations    → { generations: [{ request_id, model_id, modality, status, created_at }], offset, total }
 *  - get_model           → { model_id, display_name, multimodal: { model_type, pricing: { price, unit } }, parameters, ... }
 * Anything unexpected degrades to nulls instead of throwing.
 */
import type { ModelParameter } from '@shared/contracts/catalog';
import { isPublicHttpsUrl, modalityFromKind, type MediaJobStatus, type MediaModality } from '@shared/contracts/media';
import { toIsoDate } from '@shared/lib/format';
import { clampFraction, microUsdToUsd, roundPrice } from '@shared/lib/money';
import { normalizeParameters } from '@shared/lib/parameters';
import { extractOutputs, type ExtractedOutput } from './outputs';

export type Obj = Record<string, unknown>;

export const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const RESULT_KEYS = ['request_id', 'requestId', 'status', 'media', 'generations', 'price_micro_usd', 'price_usd', 'model_id', 'upload_url'];

/**
 * The gateway returns structuredContent or the first text block parsed as JSON; be lenient anyway:
 * JSON text is parsed, and a raw CallToolResult ({ content: [...] }) is unwrapped.
 */
export function unwrapToolResult(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return JSON.parse(t) as unknown;
      } catch {
        return raw;
      }
    }
    return raw;
  }
  if (isObj(raw) && !RESULT_KEYS.some((k) => k in raw)) {
    if (isObj(raw.structuredContent)) return raw.structuredContent;
    if (Array.isArray(raw.content)) {
      const texts = raw.content
        .filter((c): c is Obj => isObj(c) && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string);
      for (const text of texts) {
        const parsed = unwrapToolResult(text);
        if (isObj(parsed)) return parsed;
      }
      if (texts.length) return texts.join('\n');
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------------------------- status

const STATUS_MAP: Record<string, MediaJobStatus> = {
  created: 'created',
  new: 'created',
  submitted: 'created',
  accepted: 'queued',
  pending: 'queued',
  queued: 'queued',
  waiting: 'queued',
  dispatched: 'dispatched',
  processing: 'processing',
  running: 'processing',
  in_progress: 'processing',
  started: 'processing',
  generating: 'processing',
  success: 'success',
  succeeded: 'success',
  successful: 'success',
  completed: 'success',
  complete: 'success',
  done: 'success',
  finished: 'success',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  errored: 'failed',
  rejected: 'failed',
  timeout: 'failed',
  timed_out: 'failed',
  expired: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  aborted: 'cancelled',
};

/** Maps GMI's (and the request queue's) status words to a job status; `unknown` when unrecognised. */
export function mapJobStatus(value: unknown): MediaJobStatus {
  const s = str(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  return (s && STATUS_MAP[s]) || 'unknown';
}

// ---------------------------------------------------------------------------------------------- estimate

export interface ParsedEstimate {
  listUsd: number | null;
  unit: string | null;
  note: string | null;
}

export function parseEstimate(raw: unknown): ParsedEstimate {
  const r = unwrapToolResult(raw);
  if (typeof r === 'string') {
    const m = /\$\s*(\d+(?:\.\d+)?)/.exec(r);
    return { listUsd: m ? roundPrice(Number(m[1])) : null, unit: null, note: r.slice(0, 300) || null };
  }
  if (!isObj(r)) return { listUsd: null, unit: null, note: null };
  const e = isObj(r.estimate) ? r.estimate : r;
  let listUsd = microUsdToUsd(e.price_micro_usd ?? e.priceMicroUsd ?? e.micro_usd ?? e.estimated_micro_usd);
  if (listUsd === null) {
    const currency = str(e.currency)?.toLowerCase();
    if (currency === 'micro_usd' && num(e.price) !== null) listUsd = microUsdToUsd(e.price);
  }
  if (listUsd === null) {
    const usd = num(e.price_usd ?? e.priceUsd ?? e.estimated_usd ?? e.cost_usd ?? e.usd ?? e.amount_usd);
    if (usd !== null) listUsd = roundPrice(usd);
  }
  return {
    listUsd: listUsd !== null && listUsd >= 0 ? listUsd : null,
    unit: str(e.unit) ?? str(e.pricing_unit),
    note: str(e.note) ?? str(r.note),
  };
}

// ---------------------------------------------------------------------------------------------- model

export interface ParsedModel {
  id: string;
  name: string | null;
  modality: MediaModality;
  parameters: ModelParameter[] | null;
  /** Fraction 0..1 (charged = list × (1 − discount)). */
  discount: number | null;
  unitPriceUsd: number | null;
  unit: string | null;
  available: boolean | null;
  /** Declared output modalities (`multimodal.output`), null when GMI lists none. */
  outputs: Array<{ type: string }> | null;
}

function modalityList(value: unknown): Array<{ type: string }> | null {
  if (!Array.isArray(value)) return null;
  const list = value
    .map((entry) => (typeof entry === 'string' ? entry : isObj(entry) ? str(entry.type) : null))
    .filter((type): type is string => typeof type === 'string' && type.trim().length > 0)
    .map((type) => ({ type: type.trim().toLowerCase() }));
  return list.length ? list : null;
}

/** discount_to_user is a fraction; tolerate percentages (20) and hundredths of a percent (2000). */
export function parseDiscount(value: unknown): number | null {
  const n = num(value);
  if (n === null || n < 0) return null;
  if (n <= 1) return clampFraction(n);
  if (n <= 100) return clampFraction(n / 100);
  return clampFraction(n / 10_000);
}

export function parseModel(raw: unknown, fallbackId: string): ParsedModel {
  const r = unwrapToolResult(raw);
  const m = isObj(r) ? (isObj(r.model) ? r.model : r) : {};
  const mm = isObj(m.multimodal) ? m.multimodal : {};
  const pricing = isObj(mm.pricing) ? mm.pricing : isObj(m.pricing) ? m.pricing : {};
  const llmPricing = isObj(m.llm) && isObj(m.llm.pricing) ? m.llm.pricing : {};
  const discount = parseDiscount(m.discount_to_user ?? pricing.discount_to_user ?? llmPricing.discount_to_user ?? m.discount);
  return {
    id: str(m.model_id) ?? str(m.id) ?? fallbackId,
    name: str(m.display_name) ?? str(m.name),
    modality: modalityFromKind(str(mm.model_type) ?? str(m.model_type) ?? str(m.modality)),
    parameters: normalizeParameters(m.parameters),
    discount,
    unitPriceUsd: microUsdToUsd(pricing.price),
    unit: str(pricing.unit),
    available: typeof m.available === 'boolean' ? m.available : null,
    outputs: modalityList(mm.output ?? m.output),
  };
}

// ---------------------------------------------------------------------------------------------- generation

export interface ParsedGeneration {
  requestId: string | null;
  /** `unknown` when GMI did not say. */
  status: MediaJobStatus;
  modelId: string | null;
  modality: MediaModality | null;
  outputs: ExtractedOutput[];
  posterUrl: string | null;
  error: string | null;
  createdAt: string | null;
  note: string | null;
}

const REQUEST_ID_IN_TEXT = /request[_\s-]?id\W{0,4}([A-Za-z0-9][\w.:-]{3,127})/i;

function errorText(value: unknown): string | null {
  if (typeof value === 'string') return str(value);
  if (isObj(value)) return str(value.message) ?? str(value.reason) ?? str(value.detail) ?? str(value.code);
  return null;
}

/**
 * Parses a get_generation / submit_generation result (object or text). A text answer never counts as finished and
 * yields no outputs: links in prose (docs, status pages) are not results, so only GMI's JSON result (polled with
 * get_generation) can complete a job.
 */
export function parseGeneration(raw: unknown, fallbackModality?: MediaModality | null): ParsedGeneration {
  const r = unwrapToolResult(raw);
  if (typeof r === 'string') {
    const id = REQUEST_ID_IN_TEXT.exec(r)?.[1] ?? null;
    let status: MediaJobStatus = 'unknown';
    if (/\bfailed\b|\berror\b|refused|rejected/i.test(r) && !/did not fail/i.test(r)) status = 'failed';
    else if (/still running|accepted|queued|processing|being charged/i.test(r)) status = 'processing';
    return {
      requestId: id,
      status,
      modelId: null,
      modality: null,
      outputs: [],
      posterUrl: null,
      error: status === 'failed' ? r.slice(0, 500) : null,
      createdAt: null,
      note: r.slice(0, 500),
    };
  }
  const g = isObj(r) ? (isObj(r.generation) ? { ...r, ...r.generation } : r) : {};
  const outcome = isObj(g.outcome) ? g.outcome : {};
  const modality = str(g.modality) ? modalityFromKind(str(g.modality)) : null;
  const outputs = extractOutputs(g, modality ?? fallbackModality ?? null);
  let status = mapJobStatus(g.status ?? g.state);
  if (status === 'unknown' && outputs.length) status = 'success';
  const failure = errorText(g.failure_reason) ?? errorText(g.error) ?? errorText(g.error_message) ?? errorText(outcome.error);
  const poster = [g.poster, g.poster_url, g.thumbnail_image_url, g.thumbnail_url, outcome.thumbnail_image_url, outcome.poster].find(isPublicHttpsUrl);
  return {
    requestId: str(g.request_id) ?? str(g.requestId) ?? str(g.id),
    status,
    modelId: str(g.model_id) ?? str(g.model),
    modality,
    outputs,
    posterUrl: typeof poster === 'string' ? poster : null,
    error: status === 'failed' || status === 'cancelled' ? (failure ?? null) : failure && status === 'unknown' ? failure : null,
    createdAt: toIsoDate(g.created_at ?? g.createdAt),
    note: str(g.note),
  };
}

// ---------------------------------------------------------------------------------------------- list

export interface RemoteGeneration {
  requestId: string;
  modelId: string | null;
  modality: MediaModality;
  status: MediaJobStatus;
  createdAt: string | null;
}

export interface ParsedGenerationList {
  items: RemoteGeneration[];
  total: number | null;
  offset: number;
}

export function parseGenerationList(raw: unknown): ParsedGenerationList {
  const r = unwrapToolResult(raw);
  const list = Array.isArray(r) ? r : isObj(r) ? (r.generations ?? r.items ?? r.requests ?? r.data) : null;
  const items: RemoteGeneration[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isObj(entry)) continue;
      const requestId = str(entry.request_id) ?? str(entry.requestId) ?? str(entry.id);
      if (!requestId) continue;
      items.push({
        requestId,
        modelId: str(entry.model_id) ?? str(entry.model),
        modality: modalityFromKind(str(entry.modality) ?? str(entry.model_type)),
        status: mapJobStatus(entry.status),
        createdAt: toIsoDate(entry.created_at ?? entry.createdAt),
      });
    }
  }
  return {
    items,
    total: isObj(r) ? num(r.total) : null,
    offset: (isObj(r) ? num(r.offset) : null) ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------- upload

export interface UploadSlot {
  uploadUrl: string;
  publicUrl: string;
  contentType: string | null;
  expiresInSeconds: number | null;
}

/**
 * upload_media → { upload_url, public_url, content_type, expires_in_seconds } (camelCase / nested tolerated).
 * Both URLs must be https on a public host; uploads.ts further requires GMI's storage host before it PUTs the file.
 */
export function parseUploadSlot(raw: unknown): UploadSlot | null {
  const r = unwrapToolResult(raw);
  if (!isObj(r)) return null;
  const s = isObj(r.upload) ? { ...r, ...r.upload } : isObj(r.slot) ? { ...r, ...r.slot } : r;
  const uploadUrl = str(s.upload_url) ?? str(s.uploadUrl) ?? str(s.signed_url) ?? str(s.put_url);
  const publicUrl = str(s.public_url) ?? str(s.publicUrl) ?? str(s.url);
  if (!uploadUrl || !publicUrl || !isPublicHttpsUrl(uploadUrl) || !isPublicHttpsUrl(publicUrl)) return null;
  return {
    uploadUrl,
    publicUrl,
    contentType: str(s.content_type) ?? str(s.contentType) ?? str(s.mime_type),
    expiresInSeconds: num(s.expires_in_seconds ?? s.expiresInSeconds ?? s.expires_in),
  };
}
