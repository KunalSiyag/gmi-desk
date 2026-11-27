/**
 * Errors crossing the IPC boundary. Main-process handlers throw GmiError; the IPC layer
 * serialises it to GmiErrorShape; the renderer proxy rethrows it as a GmiError.
 */
export type GmiErrorCode =
  | 'not_signed_in' // no GMI OAuth session (needed for catalog-with-discount, billing, media, docs, support)
  | 'reauth_required' // OAuth grant expired/revoked or org membership changed
  | 'insufficient_scope' // OAuth grant lacks a scope (e.g. generation:write)
  | 'no_api_key' // inference key needed (chat, router) but none stored
  | 'invalid_api_key' // inference key rejected (401) or wrong scope/org
  | 'unauthorized' // other 401/403
  | 'payment_required' // 402 / insufficient balance reported by GMI
  | 'budget_exceeded' // blocked by the user's local budget
  | 'confirmation_required' // spend needs an explicit approval first
  | 'rate_limited' // 429
  | 'upstream' // 5xx or upstream_unavailable
  | 'network' // DNS/TLS/connection failure
  | 'timeout'
  | 'cancelled'
  | 'not_found'
  | 'invalid_input'
  | 'not_implemented'
  | 'internal'
  // Compute (compute.md §13.2)
  | 'no_compute_key' // Compute key (ce_resource) needed but none stored
  | 'invalid_compute_key' // Compute key rejected (401); a 403 is never treated as a dead key
  | 'not_entitled' // the organization has no access to this product (Cluster Engine / Agentbox)
  | 'quota_exceeded' // GMI refused: organization quota for this resource reached
  | 'conflict' // the resource changed state meanwhile (409)
  // Harness and gateway (harness.md §4, §9)
  | 'context_overflow' // the request does not fit the model's context window (or main's size caps)
  | 'limit_reached' // a thread or turn cap (cost, steps, time) was reached
  | 'permission_denied'; // refused by the agent's permission rules or the user

export interface GmiErrorShape {
  code: GmiErrorCode;
  message: string;
  detail?: string | null;
  status?: number | null;
  retryAfterSec?: number | null;
}

export class GmiError extends Error {
  readonly code: GmiErrorCode;
  readonly detail: string | null;
  readonly status: number | null;
  readonly retryAfterSec: number | null;

  constructor(
    code: GmiErrorCode,
    message: string,
    opts: { detail?: string | null; status?: number | null; retryAfterSec?: number | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GmiError';
    this.code = code;
    this.detail = opts.detail ?? null;
    this.status = opts.status ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
  }

  toShape(): GmiErrorShape {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      status: this.status,
      retryAfterSec: this.retryAfterSec,
    };
  }

  static fromShape(shape: GmiErrorShape): GmiError {
    return new GmiError(shape.code, shape.message, {
      detail: shape.detail ?? null,
      status: shape.status ?? null,
      retryAfterSec: shape.retryAfterSec ?? null,
    });
  }
}

export function isGmiError(value: unknown): value is GmiError {
  return value instanceof GmiError || (typeof value === 'object' && value !== null && (value as { name?: unknown }).name === 'GmiError');
}

/** Normalises anything thrown into a GmiError (unknown errors become `internal`). */
export function toGmiError(value: unknown): GmiError {
  if (value instanceof GmiError) return value;
  if (isGmiError(value)) {
    const v = value as unknown as GmiErrorShape;
    return new GmiError(v.code, v.message, { detail: v.detail ?? null, status: v.status ?? null });
  }
  if (value instanceof Error) {
    if (value.name === 'AbortError') return new GmiError('cancelled', 'The request was cancelled.', { cause: value });
    if (value.name === 'TimeoutError') return new GmiError('timeout', 'The request timed out.', { cause: value });
    return new GmiError('internal', value.message || 'Unexpected error', { cause: value });
  }
  return new GmiError('internal', typeof value === 'string' ? value : 'Unexpected error');
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: GmiErrorShape };

/** Human-friendly default copy for each code (pages may override). */
export const ERROR_HINTS: Record<GmiErrorCode, string> = {
  not_signed_in: 'Sign in with your GMI Cloud account to use this.',
  reauth_required: 'Your GMI sign-in expired or changed. Sign in again.',
  insufficient_scope: 'Your GMI sign-in did not grant this permission. Sign out and sign in again to approve it.',
  no_api_key: 'Chat needs a GMI API key. Connect chat to add one (about 30 seconds).',
  invalid_api_key: 'GMI rejected your API key. Connect a new one.',
  unauthorized: 'GMI refused the request.',
  payment_required: 'Your GMI balance is too low for this request.',
  budget_exceeded: 'This would go over the budget you set in Usage.',
  confirmation_required: 'Approve the cost before running this.',
  rate_limited: 'GMI is rate-limiting this organization. Try again shortly.',
  upstream: 'GMI had a problem handling this request. Try again.',
  network: 'Could not reach GMI. Check your connection.',
  timeout: 'GMI took too long to answer.',
  cancelled: 'Cancelled.',
  not_found: 'Not found.',
  invalid_input: 'Some input is not valid.',
  not_implemented: 'Not available yet.',
  internal: 'Something went wrong.',
  no_compute_key: 'Compute needs a GMI Compute API key. Connect Compute to add one.',
  invalid_compute_key: 'GMI rejected your Compute API key. Connect a new one.',
  not_entitled: 'Your GMI organization does not have access to this product yet.',
  quota_exceeded: 'Your GMI organization reached its quota for this. Free something up or ask GMI for more.',
  conflict: 'This changed on GMI in the meantime. Refresh and try again.',
  context_overflow: 'This no longer fits the model\'s context window.',
  limit_reached: 'A limit you set for this thread was reached.',
  permission_denied: 'Not allowed by the current permission settings.',
};
