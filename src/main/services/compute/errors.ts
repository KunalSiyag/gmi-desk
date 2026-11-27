// Every error shape the compute APIs answer with → GmiError (compute.md §14 `errors.ts`, §11), plus the one request
// helper both control-plane clients and the data plane use (C1-B).
//
// Shapes (docs/research/cluster-engine.md §9, agentbox.md §11):
//   CE            {reason, code?}
//   IAM / IDC     {group, code, message?, traces?, validationDetail?}   (both 401 variants: api-key/200, auth/2, auth_verify/0|1)
//   billing       {error}
//   v2 (dotted)   {code: "Resource.QuotaExceeded", message, request_id, trace_id?, details?}
// `traces` and `trace_id` never reach a message or the renderer (debug log only).
//
// Only a 400/401/403/404/422 whose body parsed as one of these shapes is a *definite* failure (`isDefiniteFailure`):
// a CE create that ends any other way (409, 429, 5xx, timeout, network, an HTML page, an odd 200) is `unknown` and
// reconciled by listing (§6.2), never re-sent.
import { GmiError, type GmiErrorCode } from '@shared/contracts/errors';
import type { Http, HttpOptions } from '../../core/http';
import { redact, type Logger } from '../../core/logger';
import type { ComputeTrace, TraceApi } from './sanitize';

/** Which API answered: decides the 401 meaning (control plane = the Compute key; data plane = a sandbox token). */
export type ComputeApiFamily = 'ce' | 'v2' | 'dataplane' | 'public';

export type GmiErrorBodyShape = 'ce_reason' | 'iam' | 'billing' | 'v2';

/** A parsed GMI error body (never holds `traces`). */
export interface ParsedGmiError {
  shape: GmiErrorBodyShape;
  /** v2 dotted code (`Sandbox.IdempotentKeyConsumed`), IAM `group/code` (`api-key/200`), CE numeric code, billing error. */
  remoteCode: string | null;
  /** GMI's own text (v2 messages are sanitised by GMI; CE reasons may be internal on 5xx, see `messageFor`). */
  message: string | null;
  requestId: string | null;
  details: Record<string, unknown> | null;
  /** IAM validation hints: field names only. */
  fields: string[];
}

/** A compute API error: a GmiError (so IPC and ErrorNotice treat it as usual) with what main needs to decide. */
export class ComputeHttpError extends GmiError {
  readonly family: ComputeApiFamily;
  /** The GMI error body parsed as one of the documented shapes. False: HTML, Cloudflare, plain text, truncated noise. */
  readonly parsed: boolean;
  readonly remoteCode: string | null;
  readonly requestId: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(
    code: GmiErrorCode,
    message: string,
    opts: {
      family: ComputeApiFamily;
      status: number | null;
      parsed: boolean;
      remoteCode?: string | null;
      requestId?: string | null;
      details?: Record<string, unknown> | null;
      detail?: string | null;
      retryAfterSec?: number | null;
      cause?: unknown;
    },
  ) {
    super(code, message, { status: opts.status, detail: opts.detail ?? null, retryAfterSec: opts.retryAfterSec ?? null, cause: opts.cause });
    this.family = opts.family;
    this.parsed = opts.parsed;
    this.remoteCode = opts.remoteCode ?? null;
    this.requestId = opts.requestId ?? null;
    this.details = opts.details ?? null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Parses a GMI error body into one of the documented shapes; null for anything else (HTML, text, `[]`, …). */
export function parseErrorBody(body: string): ParsedGmiError | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return parseTruncatedJson(trimmed);
  }
  return parseErrorObject(value);
}

export function parseErrorObject(value: unknown): ParsedGmiError | null {
  if (!isObj(value)) return null;
  const requestId = str(value.request_id) ?? str(value.requestId);
  const details = isObj(value.details) ? value.details : null;
  // v2: a dotted string code.
  if (typeof value.code === 'string' && /^[A-Za-z]+(\.[A-Za-z0-9]+)+$/.test(value.code)) {
    return { shape: 'v2', remoteCode: value.code, message: str(value.message), requestId, details, fields: [] };
  }
  // IAM substatus: {group, code(number)}.
  if (typeof value.group === 'string' && (typeof value.code === 'number' || typeof value.code === 'string')) {
    const fields = Array.isArray(value.validationDetail)
      ? value.validationDetail.flatMap((d) => (isObj(d) && typeof d.field === 'string' ? [d.field] : []))
      : [];
    return { shape: 'iam', remoteCode: `${value.group}/${String(value.code)}`, message: str(value.message), requestId, details: null, fields };
  }
  // CE: {reason, code?}.
  if (typeof value.reason === 'string') {
    const code = typeof value.code === 'number' || typeof value.code === 'string' ? String(value.code) : null;
    return { shape: 'ce_reason', remoteCode: code, message: str(value.reason), requestId, details: null, fields: [] };
  }
  // Billing: {error: "missing_authorization_header"} (an object `error` is not a documented compute shape).
  if (typeof value.error === 'string') {
    return { shape: 'billing', remoteCode: value.error, message: str(value.message) ?? str(value.error), requestId, details: null, fields: [] };
  }
  return null;
}

/**
 * `ctx.http` keeps at most 500 characters of an error body: a long v2 body (big `details`) arrives cut off. The
 * leading keys still identify the shape, so read them leniently instead of losing a definite answer.
 */
function parseTruncatedJson(text: string): ParsedGmiError | null {
  const field = (name: string): string | null => {
    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    return m?.[1] ? m[1].replace(/\\(.)/g, '$1') : null;
  };
  const code = field('code');
  if (code && /^[A-Za-z]+(\.[A-Za-z0-9]+)+$/.test(code)) {
    return { shape: 'v2', remoteCode: code, message: field('message'), requestId: field('request_id'), details: null, fields: [] };
  }
  const group = field('group');
  const numCode = /"code"\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
  if (group && numCode) return { shape: 'iam', remoteCode: `${group}/${numCode}`, message: field('message'), requestId: null, details: null, fields: [] };
  const reason = field('reason');
  if (reason) return { shape: 'ce_reason', remoteCode: numCode, message: reason, requestId: null, details: null, fields: [] };
  return null;
}

const DEFINITE_STATUSES = new Set([400, 401, 403, 404, 422]);

/** True when GMI definitely refused (§6.2): a parsed GMI body with 400/401/403/404/422. Everything else is unclear. */
export function isDefiniteFailure(error: unknown): boolean {
  return error instanceof ComputeHttpError && error.parsed && error.status !== null && DEFINITE_STATUSES.has(error.status);
}

/** Plain sentences for v2 pause / deletion / failure codes and CE states (§7.4); unknown codes get a neutral line. */
const REASON_TEXT: Record<string, string> = {
  'Sandbox.UserPaused': 'Paused.',
  'Sandbox.UserDeleted': 'Deleted.',
  'Sandbox.Expired': 'Its time limit ran out.',
  'Sandbox.BillingInsufficientBalance': 'GMI paused this because your balance is low.',
  'Sandbox.BillingNoPermission': 'GMI stopped this: the organization is not allowed to bill for it.',
  'Sandbox.BillingProductNotFound': 'GMI stopped this: its size is no longer sold.',
  'Sandbox.BillingOrderCreateFailed': 'GMI could not start billing for this.',
  'Sandbox.BillingSuspended': 'GMI suspended billing for this organization.',
  'Sandbox.ProvisionTimedOut': 'GMI could not start it in time.',
  'Sandbox.ProvisionFailed': 'GMI could not start it.',
  'Sandbox.ResumeTimedOut': 'Resuming took too long.',
  'Sandbox.PauseFailed': 'Pausing failed.',
  'Sandbox.ProviderGone': 'The machine behind it is gone.',
  'Sandbox.Unknown': 'GMI did not say why.',
};

export function sandboxReasonText(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASON_TEXT[code] ?? 'GMI stopped this (reason not known to GMI Desk).';
}

/** Initiator `billing` raises a budget-style alarm (§7.4). */
export function isBillingInitiated(initiator: string | null | undefined, code?: string | null): boolean {
  return initiator === 'billing' || (typeof code === 'string' && code.startsWith('Sandbox.Billing'));
}

/** User-facing message for a mapped error. GMI's text only where it is meant for users (never `traces`, never 5xx internals). */
function messageFor(code: GmiErrorCode, status: number | null, parsed: ParsedGmiError | null, family: ComputeApiFamily): string {
  const remote = parsed?.remoteCode ?? '';
  const gmiText = parsed?.message ? redact(parsed.message).slice(0, 300) : null;
  switch (code) {
    case 'invalid_compute_key':
      return 'GMI rejected your Compute API key. Connect a new one.';
    case 'not_entitled':
      return 'Your GMI organization does not have access to this product yet. Contact GMI support to enable it.';
    case 'quota_exceeded': {
      const d = parsed?.details ?? {};
      const parts = [d.quota_name, d.used !== undefined ? `used ${String(d.used)}` : null, d.quota !== undefined ? `of ${String(d.quota)}` : null]
        .filter((p): p is string => typeof p === 'string');
      return `Your GMI organization reached its quota${parts.length ? ` (${parts.join(' ')})` : ''}.`;
    }
    case 'rate_limited':
      if (remote === 'Execution.ConcurrencyLimitExceeded') return 'Too many commands are running in this sandbox. Wait for one to finish.';
      return 'GMI is rate-limiting this organization. Try again shortly.';
    case 'conflict':
      if (remote === 'IDC.UnderMaintenance') return 'This data centre is under maintenance: changes are paused there (reading still works).';
      if (remote === 'Shell.AlreadyAttached') return 'Another terminal is attached to this sandbox.';
      return gmiText ?? 'This changed on GMI in the meantime. Refresh and try again.';
    case 'unauthorized':
      if (family === 'dataplane') return 'The sandbox refused the connection token.';
      if (status === 403 && remote === 'Auth.Forbidden') return 'GMI refused: only its creator or an organization owner can do this.';
      return gmiText ?? 'GMI refused the request.';
    case 'upstream':
      if (status === 507) return 'The sandbox disk is full. Free some space and try again.';
      // 5xx reasons can hold internal detail (e.g. cluster addresses): never shown.
      return status ? `GMI had a problem handling this request (HTTP ${status}). Try again.` : 'GMI had a problem handling this request. Try again.';
    case 'invalid_input':
      if (status === 413) return 'The file is too large for the sandbox.';
      return gmiText ?? 'GMI did not accept this request.';
    case 'not_found':
      return gmiText ?? 'GMI does not know this resource (it may have been deleted).';
    default:
      return gmiText ?? `GMI returned HTTP ${status ?? '?'}`;
  }
}

function codeFor(status: number, parsed: ParsedGmiError | null, family: ComputeApiFamily, body: string): GmiErrorCode {
  const remote = parsed?.remoteCode ?? '';
  const text = `${parsed?.message ?? ''}`;
  if (status === 401) return family === 'ce' || family === 'v2' ? 'invalid_compute_key' : 'unauthorized';
  if (status === 403) {
    if (!parsed) return 'unauthorized'; // Cloudflare / HTML: not a statement about the org
    if (family === 'dataplane') return 'unauthorized';
    // v2 `Auth.Forbidden` is also a per-object permission (renaming or deleting a colleague's snapshot, agentbox.md
    // §10/§11): only an entitlement wording makes it "not entitled". CE's "tenant has no permission" stays one.
    if (/tenant has no permission|not entitled|not enabled|entitle/i.test(text)) return 'not_entitled';
    if (remote === 'Auth.Forbidden' || /no permission/i.test(text)) return family === 'v2' ? 'unauthorized' : 'not_entitled';
    return 'unauthorized';
  }
  if (status === 402) return 'payment_required';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid_input';
  if (status === 429) {
    if (remote === 'Resource.QuotaExceeded') return 'quota_exceeded';
    return 'rate_limited';
  }
  if (status === 499) return 'cancelled';
  void body;
  return 'upstream';
}

function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - now) / 1000));
}

/** Maps one HTTP error answer (status + body) to a ComputeHttpError. Pure: the tests drive every shape through it. */
export function computeErrorFrom(input: {
  family: ComputeApiFamily;
  status: number;
  body: string;
  retryAfter?: string | null;
  retryAfterSec?: number | null;
  requestIdHeader?: string | null;
  now?: number;
}): ComputeHttpError {
  const parsed = /<html|<!doctype/i.test(input.body) ? null : parseErrorBody(input.body);
  const code = codeFor(input.status, parsed, input.family, input.body);
  const cloudflare = !parsed && /cloudflare|error code: 1\d{3}/i.test(input.body);
  const message = cloudflare && input.status === 403 ? 'GMI blocked this request (Cloudflare).' : messageFor(code, input.status, parsed, input.family);
  const requestId = parsed?.requestId ?? input.requestIdHeader ?? null;
  const retryAfterSec = input.retryAfterSec ?? parseRetryAfter(input.retryAfter, input.now ?? Date.now());
  const detailParts = [parsed?.remoteCode ? `GMI code ${parsed.remoteCode}` : null, requestId ? `request ${requestId}` : null];
  if (parsed?.fields.length) detailParts.push(`fields: ${parsed.fields.join(', ')}`);
  return new ComputeHttpError(code, message, {
    family: input.family,
    status: input.status,
    parsed: parsed !== null,
    remoteCode: parsed?.remoteCode ?? null,
    requestId,
    details: parsed?.details ?? null,
    detail: detailParts.filter(Boolean).join(' · ') || null,
    retryAfterSec,
  });
}

/**
 * Re-maps an error thrown by `ctx.http` (which already consumed the body: `detail` holds up to 500 characters of a
 * JSON body, `message` the text of a short plain one) into a ComputeHttpError. Errors without a status (network,
 * timeout, cancelled) are returned unchanged: they are never definite.
 */
export function fromHttpError(error: unknown, family: ComputeApiFamily): GmiError {
  if (error instanceof ComputeHttpError) return error;
  if (!(error instanceof GmiError)) {
    return new GmiError('internal', error instanceof Error ? error.message : 'Unexpected error', { cause: error });
  }
  if (error.status === null) return error;
  let body = error.detail ?? '';
  if (!body) body = /^GMI returned HTTP \d+$/.test(error.message) ? '' : error.message;
  if (/Cloudflare/.test(error.message) && !body.includes('{')) body = `cloudflare ${body}`;
  return computeErrorFrom({ family, status: error.status, body, retryAfterSec: error.retryAfterSec });
}

// ─── The request helper (control plane and data plane) ─────────────────────────────────────────────────────────────

export interface ComputeRequestDeps {
  http: Http;
  log: Logger;
  trace?: ComputeTrace | null;
  /** GMI's `Date` header of every successful answer (the supervisor's clock-skew input, §6.6). */
  onServerDate?: ((serverDate: Date) => void) | null;
}

export interface ComputeRequest extends Omit<HttpOptions, 'json' | 'redirect'> {
  family: ComputeApiFamily;
  url: string;
  json?: unknown;
  /** What the dev trace may record: control-plane bodies (sanitised) or only status/sizes (data plane). */
  traceBody?: boolean;
}

function traceApi(family: ComputeApiFamily): TraceApi {
  return family === 'dataplane' ? 'dataplane' : family;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

/** Codes a GET may be retried on here. Never 429 (rate_limited / quota_exceeded): the caller honours Retry-After (§6.6). */
const RETRYABLE: ReadonlySet<GmiErrorCode> = new Set(['network', 'upstream', 'timeout']);

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/**
 * Sends one request through `ctx.http`; errors come back as ComputeHttpError (or a status-less GmiError). `retries`
 * is applied here, not by `ctx.http`: a 429 is never retried within seconds of GMI asking to wait (its Retry-After
 * goes to the supervisor's back-off instead).
 */
export async function computeRequest(deps: ComputeRequestDeps, req: ComputeRequest): Promise<Response> {
  const retries = Math.max(0, req.retries ?? 0);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await computeRequestOnce(deps, { ...req, retries: 0 });
    } catch (error) {
      const code = error instanceof GmiError ? error.code : 'internal';
      if (attempt >= retries || !RETRYABLE.has(code) || req.signal?.aborted) throw error;
      await pause(Math.min(8_000, 400 * 2 ** attempt), req.signal ?? undefined);
    }
  }
}

async function computeRequestOnce(deps: ComputeRequestDeps, req: ComputeRequest): Promise<Response> {
  const { family, url, traceBody, ...opts } = req;
  const started = Date.now();
  try {
    const res = await deps.http.request(url, { ...opts, redirect: 'error' });
    const date = res.headers.get('date');
    if (date && deps.onServerDate) {
      const at = new Date(date);
      if (!Number.isNaN(at.getTime())) deps.onServerDate(at);
    }
    if (deps.trace && !traceBody) {
      deps.trace.record({
        api: traceApi(family),
        method: opts.method ?? (opts.json !== undefined || opts.body !== undefined ? 'POST' : 'GET'),
        path: pathOf(url),
        status: res.status,
        requestId: res.headers.get('x-request-id') ?? res.headers.get('x-gmi-request-id'),
        bytes: Number(res.headers.get('content-length')) || null,
        ms: Date.now() - started,
      });
    }
    return res;
  } catch (error) {
    const mapped = fromHttpError(error, family);
    deps.trace?.record({
      api: traceApi(family),
      method: opts.method ?? (opts.json !== undefined || opts.body !== undefined ? 'POST' : 'GET'),
      path: pathOf(url),
      status: mapped.status,
      requestId: mapped instanceof ComputeHttpError ? mapped.requestId : null,
      bytes: null,
      ms: Date.now() - started,
      error: mapped.code,
    });
    throw mapped;
  }
}

/** A request whose 2xx body is JSON. An unparsable 2xx body is `upstream` (not definite). Control-plane bodies are traced. */
export async function computeJson<T>(deps: ComputeRequestDeps, req: ComputeRequest): Promise<{ status: number; body: T; headers: Headers }> {
  const started = Date.now();
  const res = await computeRequest(deps, { ...req, traceBody: true });
  const text = await res.text();
  let body: unknown = undefined;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      deps.trace?.record({ api: traceApi(req.family), method: req.method ?? 'GET', path: pathOf(req.url), status: res.status, requestId: null, bytes: text.length, ms: Date.now() - started, error: 'not_json' });
      throw new ComputeHttpError('upstream', 'GMI returned a response that is not valid JSON.', {
        family: req.family,
        status: res.status,
        parsed: false,
        cause: error,
      });
    }
  }
  deps.trace?.record({
    api: traceApi(req.family),
    method: req.method ?? (req.json !== undefined || req.body !== undefined ? 'POST' : 'GET'),
    path: pathOf(req.url),
    status: res.status,
    requestId: (isObj(body) ? str(body.request_id) : null) ?? res.headers.get('x-request-id') ?? res.headers.get('x-gmi-request-id'),
    bytes: text.length,
    ms: Date.now() - started,
    ...(req.family === 'dataplane' ? {} : { body }),
  });
  return { status: res.status, body: body as T, headers: res.headers };
}

/** Unwraps a v2 `{request_id, data}` envelope (tolerates a bare object). */
export function unwrapV2<T>(body: unknown): T {
  if (isObj(body) && 'data' in body && body.data !== undefined) return body.data as T;
  return body as T;
}
