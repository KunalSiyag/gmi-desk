import { GmiError } from '@shared/contracts/errors';
import type { FetchLike } from '../../core/http';

export interface WrappedFetchOptions {
  userAgent: string;
  /** Aborts every request made through this fetch (e.g. the sign-in being cancelled). */
  signal?: AbortSignal;
  /** Per-request timeout in ms (0 = none, for long-lived MCP streams). */
  timeoutMs?: number;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Fetch for the MCP SDK (OAuth helpers and the MCP transport): adds the app's User-Agent
 * (Cloudflare in front of GMI blocks some defaults), flattens URLSearchParams bodies, and
 * turns transport failures into GmiError (network / timeout / cancelled).
 */
export function createWrappedFetch(base: FetchLike, opts: WrappedFetchOptions): FetchLike {
  const timeoutMs = opts.timeoutMs ?? 0;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', opts.userAgent);
    let body = init?.body;
    if (body instanceof URLSearchParams) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
      body = body.toString();
    }

    const signals: AbortSignal[] = [];
    if (init?.signal) signals.push(init.signal);
    if (opts.signal) signals.push(opts.signal);
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
    if (timeout) signals.push(timeout);
    const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);

    try {
      return await base(input, { ...init, headers, body, signal });
    } catch (error) {
      if (error instanceof GmiError) throw error;
      if (opts.signal?.aborted) throw new GmiError('cancelled', 'Cancelled.', { cause: error });
      if (timeout?.aborted) throw new GmiError('timeout', 'GMI took too long to answer.', { cause: error });
      // An abort requested by the caller (e.g. the MCP transport closing) keeps its own semantics.
      if (init?.signal?.aborted || isAbortLike(error)) throw error;
      throw new GmiError('network', 'Could not reach GMI. Check your connection.', {
        cause: error,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * Settles like `promise`, or rejects with GmiError('cancelled') as soon as `signal` aborts. For work
 * shared by several callers (a connection, a discovery), where one caller's abort must not cancel it.
 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, message = 'The request was cancelled.'): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new GmiError('cancelled', message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new GmiError('cancelled', message));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Wraps a fetch and remembers the HTTP status of the last response (OAuth error mapping needs it). */
export function trackStatus(base: FetchLike): { fetch: FetchLike; lastStatus: () => number | null } {
  let status: number | null = null;
  return {
    fetch: async (input, init) => {
      const res = await base(input, init);
      status = res.status;
      return res;
    },
    lastStatus: () => status,
  };
}
