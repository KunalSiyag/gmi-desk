// H1-B: the retry matrix and watchdogs (harness.md §4.6): retry only where GMI cannot have billed; maybe-billed
// attempts are charged and retried at most once (none above 32k, never for chat); 429s are requeued, never surfaced
// before 10 minutes (60 s for chat).
import { describe, expect, it } from 'vitest';
import { createRetryPolicy, MAX_NOT_BILLED_REQUEUES, MAX_NOT_BILLED_REQUEUES_INTERACTIVE, MAX_OFFLINE_CYCLES } from '@main/services/gateway/retry';
import { GATEWAY_LIMITS, type AttemptFailure, type RetryContext } from '@main/services/gateway/types';
import { fakeClock } from './fakes';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const policy = (random = 0.5) => createRetryPolicy({ clock: fakeClock(NOW, random) });
const agent = (over: Partial<RetryContext> = {}): RetryContext => ({
  purpose: 'agent',
  priority: 'foreground',
  promptTokens: 10_000,
  attempt: 1,
  maybeBilledRetries: 0,
  notBilledRequeues: 0,
  rateLimitedSince: null,
  afterOutput: false,
  now: NOW,
  ...over,
});
const chat = (over: Partial<RetryContext> = {}) => agent({ purpose: 'chat', priority: 'interactive', ...over });
const http = (status: number, over: Partial<Extract<AttemptFailure, { kind: 'http' }>> = {}): AttemptFailure => ({ kind: 'http', status, retryAfterSec: null, code: null, message: `HTTP ${status}`, ...over });
const net = (errno: string | null, bodySent: boolean): AttemptFailure => ({ kind: 'network', errno, bodySent, message: errno ?? 'socket hang up' });

describe('not billed: requeue', () => {
  it('429 → requeue (tpm, rateLimited), honouring Retry-After; never surfaced before 10 minutes', () => {
    const p = policy();
    expect(p.decide(http(429, { retryAfterSec: 7 }), agent())).toEqual({ action: 'requeue', delayMs: 7_000, reason: 'tpm', rateLimited: true, countsForBreaker: false });
    const noHeader = p.decide(http(429), agent({ notBilledRequeues: 3 }));
    expect(noHeader).toMatchObject({ action: 'requeue', rateLimited: true, delayMs: 4_000 });
    const since = NOW - GATEWAY_LIMITS.retry.rateLimitGiveUpMs + 1;
    expect(p.decide(http(429), agent({ rateLimitedSince: since }))).toMatchObject({ action: 'requeue' });
    // The delay never runs past the give-up time.
    expect(p.decide(http(429, { retryAfterSec: 60 }), agent({ rateLimitedSince: since }))).toMatchObject({ action: 'requeue', delayMs: 1 });
    expect(p.decide(http(429), agent({ rateLimitedSince: NOW - GATEWAY_LIMITS.retry.rateLimitGiveUpMs }))).toMatchObject({
      action: 'fail',
      maybeBilled: false,
      countsForBreaker: false,
      error: { code: 'rate_limited', status: 429 },
    });
  });

  it('chat (interactive) is requeued for at most 60 s', () => {
    const p = policy();
    expect(p.decide(http(429), chat({ rateLimitedSince: NOW - 59_999 }))).toMatchObject({ action: 'requeue' });
    expect(p.decide(http(429), chat({ rateLimitedSince: NOW - 60_000 }))).toMatchObject({ action: 'fail', error: { code: 'rate_limited' } });
  });

  it('503 with Retry-After is requeued like a 429; without it, it is maybe billed', () => {
    const p = policy();
    expect(p.decide(http(503, { retryAfterSec: 2 }), agent())).toMatchObject({ action: 'requeue', delayMs: 2_000, reason: 'tpm', rateLimited: true });
    expect(p.decide(http(503), agent())).toMatchObject({ action: 'retry', maybeBilled: true, countsForBreaker: true });
  });

  it('connect failure before the body was sent: offline when the network looks down, else backoff requeues', () => {
    const p = policy();
    for (const errno of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH']) expect(p.decide(net(errno, false), agent())).toEqual({ action: 'offline', countsForBreaker: false });
    expect(p.decide(net('ENOTFOUND', false), agent({ notBilledRequeues: MAX_OFFLINE_CYCLES }))).toMatchObject({ action: 'fail', error: { code: 'network' } });
    expect(p.decide(net('ECONNRESET', false), agent())).toMatchObject({ action: 'requeue', reason: 'offline', rateLimited: false, countsForBreaker: false });
    expect(p.decide(net('ECONNRESET', false), agent({ notBilledRequeues: MAX_NOT_BILLED_REQUEUES }))).toMatchObject({ action: 'fail', maybeBilled: false, error: { code: 'network' } });
    expect(p.decide(net(null, false), chat({ notBilledRequeues: MAX_NOT_BILLED_REQUEUES_INTERACTIVE }))).toMatchObject({ action: 'fail' });
  });
});

describe('maybe billed: charged, at most one retry', () => {
  for (const status of [500, 502, 504, 524]) {
    it(`${status}: one retry (counts for the breaker), then upstream`, () => {
      const p = policy();
      expect(p.decide(http(status), agent())).toMatchObject({ action: 'retry', maybeBilled: true, countsForBreaker: true });
      expect(p.decide(http(status), agent({ maybeBilledRetries: 1 }))).toEqual({
        action: 'fail',
        error: expect.objectContaining({ code: 'upstream', status }),
        maybeBilled: true,
        countsForBreaker: true,
        reportInvalidKey: false,
      });
    });
  }

  it('no retry above 32k prompt tokens', () => {
    const p = policy();
    expect(p.decide(http(500), agent({ promptTokens: GATEWAY_LIMITS.retry.maybeBilledMaxPromptTokens }))).toMatchObject({ action: 'retry' });
    expect(p.decide(http(500), agent({ promptTokens: GATEWAY_LIMITS.retry.maybeBilledMaxPromptTokens + 1 }))).toMatchObject({ action: 'fail', maybeBilled: true });
  });

  it('chat never retries these (today\'s retries: 0)', () => {
    const p = policy();
    expect(p.decide(http(502), chat())).toMatchObject({ action: 'fail', maybeBilled: true, countsForBreaker: true });
    expect(p.decide({ kind: 'first_byte_timeout' }, chat())).toMatchObject({ action: 'fail', maybeBilled: true, error: { code: 'timeout' } });
  });

  it('first-byte timeout counts for the breaker; a reset after the body was sent does not (network level)', () => {
    const p = policy();
    expect(p.decide({ kind: 'first_byte_timeout' }, agent())).toMatchObject({ action: 'retry', maybeBilled: true, countsForBreaker: true });
    expect(p.decide(net('ECONNRESET', true), agent())).toMatchObject({ action: 'retry', maybeBilled: true, countsForBreaker: false });
    expect(p.decide(net('ECONNRESET', true), agent({ maybeBilledRetries: 1 }))).toMatchObject({ action: 'fail', maybeBilled: true, error: { code: 'network' } });
  });
});

describe('terminal 4xx', () => {
  it('context overflow (400 / 413 + message, or the code) → context_overflow', () => {
    const p = policy();
    for (const f of [
      http(400, { message: "This model's maximum context length is 131072 tokens." }),
      http(400, { code: 'context_length_exceeded', message: 'too long' }),
      http(400, { message: 'Input has too many tokens' }),
      http(413, { message: 'Payload Too Large' }),
      http(422, { message: 'prompt is too long' }),
    ]) {
      expect(p.decide(f, agent())).toMatchObject({ action: 'fail', maybeBilled: false, countsForBreaker: false, reportInvalidKey: false, error: { code: 'context_overflow' } });
    }
    expect(p.decide(http(400, { message: 'unsupported_parameter: foo' }), agent())).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('401 and a non-Cloudflare 403 report the credential; a Cloudflare 403 does not', () => {
    const p = policy();
    expect(p.decide(http(401), agent())).toMatchObject({ action: 'fail', reportInvalidKey: true, error: { code: 'invalid_api_key', status: 401 } });
    expect(p.decide(http(403, { message: 'insufficient_scope' }), agent())).toMatchObject({ reportInvalidKey: true, error: { code: 'unauthorized' } });
    expect(p.decide(http(403, { message: 'error code: 1010 (Cloudflare)' }), agent())).toMatchObject({ reportInvalidKey: false });
  });

  it('402 / 404 / 422 fail with their codes and never retry', () => {
    const p = policy();
    expect(p.decide(http(402), agent())).toMatchObject({ action: 'fail', error: { code: 'payment_required' }, countsForBreaker: false });
    expect(p.decide(http(404), agent())).toMatchObject({ action: 'fail', error: { code: 'not_found' } });
    expect(p.decide(http(422, { message: 'bad schema' }), agent())).toMatchObject({ action: 'fail', error: { code: 'invalid_input' } });
  });
});

describe('after the first byte: never retried', () => {
  it.each([
    ['cut', 'network'],
    ['idle_timeout', 'timeout'],
    ['total_timeout', 'timeout'],
    ['parse', 'upstream'],
  ] as const)('%s → %s', (reason, code) => {
    expect(policy().decide({ kind: 'stream', reason, message: 'x' }, agent({ afterOutput: true }))).toMatchObject({ action: 'fail', maybeBilled: false, countsForBreaker: false, error: { code } });
  });
});

describe('watchdogs and backoff', () => {
  it('first byte: 90 s + 1 s per 10k prompt tokens; idle 120 s; total 15 min', () => {
    const p = policy();
    expect(p.watchdogs(0)).toEqual({ firstByteMs: 90_000, idleMs: 120_000, totalMs: 900_000 });
    expect(p.watchdogs(100_000).firstByteMs).toBe(100_000);
    expect(p.watchdogs(15_000).firstByteMs).toBe(92_000);
    expect(p.watchdogs(1_000_000).firstByteMs).toBe(190_000);
    expect(p.watchdogs(Number.NaN).firstByteMs).toBe(90_000);
  });

  it('full jitter: random(0, min(20 s, 1 s · 2^n))', () => {
    expect(policy(0).backoffMs(3)).toBe(0);
    expect(policy(0.5).backoffMs(0)).toBe(500);
    expect(policy(0.5).backoffMs(2)).toBe(2_000);
    expect(policy(0.999).backoffMs(10)).toBeLessThan(20_000);
    expect(policy(0.5).backoffMs(10)).toBe(10_000);
  });
});
