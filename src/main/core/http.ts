import { GmiError, type GmiErrorCode } from '@shared/contracts/errors';
import type { Logger } from './logger';

/** Request body accepted by fetch (string, bytes, Blob, stream...). */
export type RequestBody = NonNullable<RequestInit['body']>;

export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** Raw body (e.g. file bytes for an upload PUT). */
  body?: RequestBody;
  /** Adds `Authorization: Bearer <token>`. */
  bearer?: string | null;
  /** Whole-request timeout in ms. Default 30s. Use 0 for streams (the caller handles idle timeouts). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Retries for transient failures (network, 429, 5xx). Only use for idempotent requests. Default 0. */
  retries?: number;
  /** Error code for a 401 (e.g. `invalid_api_key` for inference calls). Default `unauthorized`. */
  unauthorizedCode?: GmiErrorCode;
  /**
   * Redirect handling (default 'follow'). With 'manual', 3xx responses are returned instead of thrown,
   * so the caller can validate each Location before following it.
   */
  redirect?: 'follow' | 'manual' | 'error';
}

export interface Http {
  /** Resolves for 2xx responses (and 3xx when `redirect: 'manual'`); throws GmiError otherwise. */
  request(url: string, opts?: HttpOptions): Promise<Response>;
  json<T>(url: string, opts?: HttpOptions): Promise<T>;
  text(url: string, opts?: HttpOptions): Promise<string>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY = 4_000;

export function buildUrl(url: string, query?: HttpOptions['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Pulls a human-readable message out of common error payload shapes. */
export function extractErrorMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const err = parsed.error;
    if (typeof err === 'string') return typeof parsed.message === 'string' ? `${err}: ${parsed.message}` : err;
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, string>).message ?? null;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (typeof parsed.reason === 'string') return parsed.reason;
  } catch {
    // not JSON
  }
  if (/<html/i.test(trimmed)) return null;
  return trimmed.slice(0, 300);
}

export function codeForStatus(status: number, unauthorizedCode: GmiErrorCode = 'unauthorized'): GmiErrorCode {
  if (status === 400 || status === 409 || status === 422) return 'invalid_input';
  if (status === 401) return unauthorizedCode;
  if (status === 402) return 'payment_required';
  if (status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  return 'upstream';
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - Date.now()) / 1000));
}

/** Converts a non-2xx response into a GmiError (consumes the body). */
export async function errorFromResponse(res: Response, unauthorizedCode?: GmiErrorCode): Promise<GmiError> {
  let body = '';
  try {
    body = (await res.text()).slice(0, MAX_ERROR_BODY);
  } catch {
    // ignore
  }
  const code = codeForStatus(res.status, unauthorizedCode);
  const upstreamMessage = extractErrorMessage(body);
  if (res.status === 403 && /error code: 1010|cloudflare/i.test(body)) {
    return new GmiError('unauthorized', 'GMI blocked this request (Cloudflare).', { status: 403, detail: upstreamMessage });
  }
  const message = upstreamMessage ?? `GMI returned HTTP ${res.status}`;
  return new GmiError(code, message, {
    status: res.status,
    detail: body && upstreamMessage !== body.trim() ? body.slice(0, 500) : null,
    retryAfterSec: parseRetryAfter(res.headers.get('retry-after')),
  });
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof GmiError)) return false;
  return error.code === 'network' || error.code === 'rate_limited' || error.code === 'upstream' || error.code === 'timeout';
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new GmiError('cancelled', 'The request was cancelled.'));
      },
      { once: true },
    );
  });

export function createHttp(deps: { userAgent: string; log: Logger; fetch?: FetchLike }): Http {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const log = deps.log.child('http');

  async function once(url: string, opts: HttpOptions): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': deps.userAgent,
      Accept: 'application/json',
      ...opts.headers,
    };
    let body: RequestBody | undefined = opts.body;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signals: AbortSignal[] = [];
    if (opts.signal) signals.push(opts.signal);
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    const target = buildUrl(url, opts.query);
    let res: Response;
    try {
      res = await fetchImpl(target, {
        method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        signal,
        ...(opts.redirect ? { redirect: opts.redirect } : {}),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw new GmiError('cancelled', 'The request was cancelled.', { cause: error });
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GmiError('timeout', 'GMI took too long to answer.', { cause: error });
      }
      throw new GmiError('network', 'Could not reach GMI. Check your connection.', {
        cause: error,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (opts.redirect === 'manual' && res.status >= 300 && res.status < 400) return res;
    if (!res.ok) throw await errorFromResponse(res, opts.unauthorizedCode);
    return res;
  }

  async function request(url: string, opts: HttpOptions = {}): Promise<Response> {
    const retries = Math.max(0, opts.retries ?? 0);
    let attempt = 0;
    for (;;) {
      try {
        return await once(url, opts);
      } catch (error) {
        if (attempt >= retries || !isTransient(error) || opts.signal?.aborted) throw error;
        attempt += 1;
        const retryAfter = error instanceof GmiError && error.retryAfterSec ? error.retryAfterSec * 1000 : 0;
        const backoff = Math.min(8_000, Math.max(retryAfter, 400 * 2 ** (attempt - 1)));
        log.debug(`retrying ${new URL(url).pathname} in ${backoff}ms`, { attempt, code: (error as GmiError).code });
        await sleep(backoff, opts.signal);
      }
    }
  }

  return {
    request,
    async json<T>(url: string, opts: HttpOptions = {}) {
      const res = await request(url, opts);
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new GmiError('upstream', 'GMI returned a response that is not valid JSON.', { cause: error, detail: text.slice(0, 300) });
      }
    },
    async text(url: string, opts: HttpOptions = {}) {
      const res = await request(url, opts);
      return res.text();
    },
  };
}
