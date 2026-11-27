/**
 * The retry matrix and watchdogs (harness.md §4.6). Retries only where GMI cannot have billed; maybe-billed
 * failures are charged (an estimated prompt) and retried at most once, never above 32k prompt tokens, never for chat.
 *
 * | Failure                                                  | Decision                                              |
 * |----------------------------------------------------------|-------------------------------------------------------|
 * | no response, DNS / refused / unreachable, body not sent  | offline (the gate closes; requeued when it reopens)   |
 * | no response, other errno, body not sent                  | requeue with backoff (≤ 5; 3 for interactive) → network |
 * | 429; 503 with Retry-After                                | requeue (Retry-After or backoff), keep position;       |
 * |                                                          | rate_limited after 10 min of 429s (60 s interactive)  |
 * | 5xx, first-byte timeout, reset after the body was sent   | maybe billed: ≤ 1 retry (none if P > 32k, none for    |
 * |                                                          | chat), then upstream / timeout / network; 5xx and     |
 * |                                                          | first-byte timeouts count for the breaker             |
 * | context overflow (400 / 413 + "context length"…)         | context_overflow                                      |
 * | 401; 403 not from Cloudflare                             | invalid_api_key / unauthorized + reportInvalidKey     |
 * | other 4xx                                                | fail with the status's code                           |
 * | after the first byte (cut, idle, total, parse)           | fail (afterOutput); never retried                     |
 */
import type { GmiErrorCode, GmiErrorShape } from '@shared/contracts/errors';
import { codeForStatus } from '../../core/http';
import { GATEWAY_LIMITS, type AttemptFailure, type GatewayClock, type RetryContext, type RetryDecision, type RetryPolicy, type Watchdogs } from './types';

/** errno values (no response, body not sent) that mean the network looks down → the connectivity gate. */
const NETWORK_DOWN_ERRNOS: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN']);

/** Not-billed connect failures requeued at most this often before `network`. */
export const MAX_NOT_BILLED_REQUEUES = 5;
export const MAX_NOT_BILLED_REQUEUES_INTERACTIVE = 3;
/** Offline decisions for one request before it fails with `network`. */
export const MAX_OFFLINE_CYCLES = 20;

/** Statuses (and messages) of a request that does not fit the model's context window. */
const OVERFLOW_PATTERN = /context[_ ]length(?![_ ]?exceeded[_ ]?behavior)|maximum context|context window|too many tokens|prompt is too long|input is too long|reduce the length/i;

/** A 400 that rejects a request parameter (e.g. `context_length_exceeded_behavior`): never an overflow. */
export function isUnsupportedParameter(failure: Extract<AttemptFailure, { kind: 'http' }>): boolean {
  return /^(unsupported|unknown|invalid|unrecognized)[_ ]param(eter)?s?$/i.test(failure.code ?? '') || /context_length_exceeded_behavior/i.test(`${failure.param ?? ''} ${failure.message}`);
}

export function isContextOverflow(failure: Extract<AttemptFailure, { kind: 'http' }>): boolean {
  if (isUnsupportedParameter(failure)) return false;
  if (failure.code === 'context_overflow' || failure.code === 'context_length_exceeded') return true;
  if (failure.status === 413) return true;
  return (failure.status === 400 || failure.status === 422) && OVERFLOW_PATTERN.test(`${failure.code ?? ''} ${failure.message}`);
}

const isInteractive = (ctx: Pick<RetryContext, 'purpose' | 'priority'>) => ctx.purpose === 'chat' || ctx.priority === 'interactive';

const err = (code: GmiErrorCode, message: string, extra: Partial<GmiErrorShape> = {}): GmiErrorShape => ({ code, message, ...extra });

export interface RetryPolicyDeps {
  clock: Pick<GatewayClock, 'random'>;
}

export function createRetryPolicy(deps: RetryPolicyDeps): RetryPolicy {
  const r = GATEWAY_LIMITS.retry;
  const w = GATEWAY_LIMITS.watchdog;

  const backoffMs = (n: number): number => {
    const ceiling = Math.min(r.backoffCapMs, r.backoffBaseMs * r.backoffFactor ** Math.max(0, n));
    const rand = deps.clock.random();
    return Math.floor((Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 1) : 0.5) * ceiling);
  };

  /** Maybe billed: one retry where allowed, else a terminal error. */
  const maybeBilled = (ctx: RetryContext, error: GmiErrorShape, countsForBreaker: boolean): RetryDecision => {
    const allowed = !isInteractive(ctx) && ctx.maybeBilledRetries < r.maybeBilledRetries && ctx.promptTokens <= r.maybeBilledMaxPromptTokens;
    if (allowed) return { action: 'retry', delayMs: backoffMs(ctx.maybeBilledRetries), maybeBilled: true, countsForBreaker };
    return { action: 'fail', error, maybeBilled: true, countsForBreaker, reportInvalidKey: false };
  };

  /** 429 / 503 + Retry-After: requeue until the give-up time of continuous rate limiting. */
  const rateLimited = (ctx: RetryContext, retryAfterSec: number | null, status: number): RetryDecision => {
    const giveUpMs = isInteractive(ctx) ? r.rateLimitGiveUpInteractiveMs : r.rateLimitGiveUpMs;
    const since = ctx.rateLimitedSince ?? ctx.now;
    const left = giveUpMs - (ctx.now - since);
    if (left <= 0) {
      return {
        action: 'fail',
        error: err('rate_limited', 'GMI is rate-limiting these requests. Try again in a little while.', { status, retryAfterSec }),
        maybeBilled: false,
        countsForBreaker: false,
        reportInvalidKey: false,
      };
    }
    const wanted = retryAfterSec !== null && Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : backoffMs(ctx.notBilledRequeues);
    return { action: 'requeue', delayMs: Math.max(0, Math.min(wanted, left)), reason: 'tpm', rateLimited: true, countsForBreaker: false };
  };

  return {
    backoffMs,

    watchdogs(promptTokens: number): Watchdogs {
      const p = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
      return { firstByteMs: w.firstByteBaseMs + Math.ceil(p / 10_000) * w.firstBytePerTenKPromptMs, idleMs: w.idleMs, totalMs: w.totalMs };
    },

    decide(failure, ctx): RetryDecision {
      switch (failure.kind) {
        case 'network': {
          if (failure.bodySent) return maybeBilled(ctx, err('network', 'The connection to GMI broke after the request was sent.'), false);
          // The gate pauses everything without using retry budget; the bound only stops a host that refuses
          // connections while its probe answers from cycling forever (the core counts offline decisions too).
          if (failure.errno !== null && NETWORK_DOWN_ERRNOS.has(failure.errno) && ctx.notBilledRequeues < MAX_OFFLINE_CYCLES) return { action: 'offline', countsForBreaker: false };
          const max = isInteractive(ctx) ? MAX_NOT_BILLED_REQUEUES_INTERACTIVE : MAX_NOT_BILLED_REQUEUES;
          if (ctx.notBilledRequeues < max) return { action: 'requeue', delayMs: backoffMs(ctx.notBilledRequeues), reason: 'offline', rateLimited: false, countsForBreaker: false };
          return { action: 'fail', error: err('network', 'Could not connect to GMI.', { detail: failure.errno }), maybeBilled: false, countsForBreaker: false, reportInvalidKey: false };
        }

        case 'first_byte_timeout':
          return maybeBilled(ctx, err('timeout', 'GMI did not start answering in time.'), true);

        case 'stream': {
          const code: GmiErrorCode = failure.reason === 'cut' ? 'network' : failure.reason === 'parse' ? 'upstream' : 'timeout';
          const message =
            failure.reason === 'cut'
              ? 'The connection to GMI broke during the reply.'
              : failure.reason === 'parse'
                ? 'GMI sent a reply the app could not read.'
                : failure.reason === 'idle_timeout'
                  ? 'GMI stopped sending the reply.'
                  : 'The reply took too long.';
          return { action: 'fail', error: err(code, message, { detail: failure.message || null }), maybeBilled: false, countsForBreaker: false, reportInvalidKey: false };
        }

        case 'http': {
          const { status, retryAfterSec } = failure;
          if (status === 429) return rateLimited(ctx, retryAfterSec, status);
          if (status === 503 && retryAfterSec !== null) return rateLimited(ctx, retryAfterSec, status);
          if (status >= 500) return maybeBilled(ctx, err('upstream', failure.message || `GMI returned HTTP ${status}.`, { status }), true);
          if (isContextOverflow(failure)) {
            return {
              action: 'fail',
              error: err('context_overflow', "The conversation no longer fits the model's context window.", { status, detail: failure.message || null }),
              maybeBilled: false,
              countsForBreaker: false,
              reportInvalidKey: false,
            };
          }
          const cloudflare = status === 403 && /cloudflare|error code: 1010/i.test(failure.message);
          const credentialRefused = status === 401 || (status === 403 && !cloudflare) || failure.code === 'invalid_api_key';
          const code = codeForStatus(status, 'invalid_api_key');
          return {
            action: 'fail',
            error: err(code, failure.message || `GMI returned HTTP ${status}.`, { status, retryAfterSec }),
            maybeBilled: false,
            countsForBreaker: false,
            reportInvalidKey: credentialRefused,
          };
        }
      }
    },
  };
}
