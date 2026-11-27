// C1-B: every compute error shape → the right GmiError code; only a parsed 400/401/403/404/422 is a definite failure.
import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { errorFromResponse } from '@main/core/http';
import {
  ComputeHttpError,
  computeErrorFrom,
  fromHttpError,
  isBillingInitiated,
  isDefiniteFailure,
  parseErrorBody,
  sandboxReasonText,
  type ComputeApiFamily,
} from '@main/services/compute/errors';
import { htmlPage, v2Error } from './fakes';

const map = (family: ComputeApiFamily, status: number, body: unknown, extra: { retryAfter?: string } = {}) =>
  computeErrorFrom({ family, status, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });

describe('parseErrorBody: the four documented shapes', () => {
  it('CE {reason, code?}', () => {
    expect(parseErrorBody('{"code":400,"reason":"resources.CPU is a required property"}')).toMatchObject({ shape: 'ce_reason', remoteCode: '400', message: 'resources.CPU is a required property' });
  });
  it('IAM {group, code, message, traces, validationDetail}: traces never kept', () => {
    const p = parseErrorBody(JSON.stringify({ group: 'auth', code: 2, message: 'Invalid access token.', traces: ['error: parse token string error (internal detail)'], validationDetail: [{ field: 'name', reason: 'bad' }] }));
    expect(p).toMatchObject({ shape: 'iam', remoteCode: 'auth/2', message: 'Invalid access token.', fields: ['name'] });
    expect(JSON.stringify(p)).not.toContain('internal detail');
  });
  it('billing {error}', () => {
    expect(parseErrorBody('{"error":"missing_authorization_header"}')).toMatchObject({ shape: 'billing', remoteCode: 'missing_authorization_header' });
  });
  it('v2 dotted {code, message, request_id, details}', () => {
    expect(parseErrorBody(JSON.stringify(v2Error('Resource.QuotaExceeded', 'quota', { quota: 2, used: 2 })))).toMatchObject({
      shape: 'v2',
      remoteCode: 'Resource.QuotaExceeded',
      requestId: 'req-test-1',
      details: { quota: 2, used: 2 },
    });
  });
  it('HTML, plain text, arrays and unknown JSON are not GMI error bodies', () => {
    expect(parseErrorBody(htmlPage)).toBeNull();
    expect(parseErrorBody('upstream connect error')).toBeNull();
    expect(parseErrorBody('[]')).toBeNull();
    expect(parseErrorBody('{"hello":1}')).toBeNull();
  });
  it('a body cut at 500 characters still yields its leading keys', () => {
    const long = JSON.stringify(v2Error('Sandbox.IdempotentKeyConsumed', 'consumed', { blob: 'x'.repeat(2000) })).slice(0, 500);
    expect(parseErrorBody(long)).toMatchObject({ shape: 'v2', remoteCode: 'Sandbox.IdempotentKeyConsumed' });
  });
});

describe('computeErrorFrom: status + shape → code', () => {
  it('both 401 variants on the control plane → invalid_compute_key (definite)', () => {
    for (const body of [{ code: 200, group: 'api-key', message: 'Invalid API key.' }, { code: 2, group: 'auth', message: 'Invalid access token.', traces: ['x'] }, { code: 0, group: 'auth_verify', message: 'Invalid access token.' }]) {
      const e = map('ce', 401, body);
      expect(e.code).toBe('invalid_compute_key');
      expect(isDefiniteFailure(e)).toBe(true);
    }
    expect(map('v2', 401, v2Error('Auth.Unauthorized')).code).toBe('invalid_compute_key');
  });
  it('a data-plane 401 is a token problem, never the Compute key', () => {
    expect(map('dataplane', 401, v2Error('Auth.Unauthorized')).code).toBe('unauthorized');
  });
  it('403 "tenant has no permission" → not_entitled; Cloudflare 403 → unauthorized and not definite', () => {
    const ent = map('ce', 403, { reason: 'access denied: tenant has no permission to do the operation' });
    expect(ent.code).toBe('not_entitled');
    expect(isDefiniteFailure(ent)).toBe(true);
    const cf = map('ce', 403, 'error code: 1010');
    expect(cf.code).toBe('unauthorized');
    expect(cf.message).toMatch(/Cloudflare/);
    expect(isDefiniteFailure(cf)).toBe(false);
  });
  it('429: quota_exceeded (with numbers) vs rate_limited with Retry-After; never definite', () => {
    const q = map('v2', 429, v2Error('Resource.QuotaExceeded', 'q', { quota_name: 'sandboxes', quota: 2, used: 2, requested: 1 }));
    expect(q.code).toBe('quota_exceeded');
    expect(q.message).toContain('sandboxes');
    expect(isDefiniteFailure(q)).toBe(false);
    const r = map('v2', 429, v2Error('RateLimit.Exceeded'), { retryAfter: '17' });
    expect(r.code).toBe('rate_limited');
    expect(r.retryAfterSec).toBe(17);
    expect(map('dataplane', 429, v2Error('Execution.ConcurrencyLimitExceeded')).message).toMatch(/Too many commands/);
  });
  it('409 → conflict (maintenance, idempotency, shell); never definite', () => {
    const m = map('v2', 409, v2Error('IDC.UnderMaintenance'));
    expect(m.code).toBe('conflict');
    expect(m.message).toMatch(/maintenance/);
    expect(isDefiniteFailure(m)).toBe(false);
    expect(map('v2', 409, v2Error('Sandbox.IdempotentKeyConsumed')).remoteCode).toBe('Sandbox.IdempotentKeyConsumed');
    expect(map('ce', 409, { reason: 'timestamp mismatched' }).code).toBe('conflict');
  });
  it('400 / 404 / 422 with a parsed body are definite; without one they are not', () => {
    for (const s of [400, 404, 422]) {
      expect(isDefiniteFailure(map('ce', s, { reason: 'nope' }))).toBe(true);
      expect(isDefiniteFailure(map('ce', s, htmlPage))).toBe(false);
      expect(isDefiniteFailure(map('ce', s, 'plain text'))).toBe(false);
    }
    expect(map('ce', 400, { reason: 'bad' }).code).toBe('invalid_input');
    expect(map('ce', 404, { reason: 'resource x was not found' }).code).toBe('not_found');
    expect(map('v2', 422, v2Error('Template.ProviderNotSupported')).code).toBe('invalid_input');
  });
  it('5xx → upstream with a generic message (CE reasons on 5xx can leak internals); 504 → timeout; 507 → disk full', () => {
    const e = map('ce', 503, { reason: 'dial tcp 10.0.0.1:6443: i/o timeout' });
    expect(e.code).toBe('upstream');
    expect(e.message).not.toContain('10.0.0.1');
    expect(JSON.stringify(e.toShape())).not.toContain('10.0.0.1');
    expect(isDefiniteFailure(e)).toBe(false);
    expect(map('v2', 504, v2Error('Request.Timeout')).code).toBe('timeout');
    expect(map('dataplane', 507, v2Error('File.DiskFull')).message).toMatch(/disk is full/);
  });
  it('402 → payment_required; 413 → invalid_input "too large"', () => {
    expect(map('ce', 402, { error: 'insufficient balance' }).code).toBe('payment_required');
    expect(map('dataplane', 413, v2Error('File.TooLarge')).message).toMatch(/too large/);
  });
  it('messages never carry JWTs or traces', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXN1YmplY3QifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
    const e = map('ce', 400, { reason: `bad token ${jwt}` });
    expect(e.message).not.toContain(jwt);
    const t = map('ce', 401, { group: 'auth', code: 2, message: 'Invalid access token.', traces: ['SECRET-TRACE'] });
    expect(JSON.stringify(t.toShape())).not.toContain('SECRET-TRACE');
  });
  it('it is a GmiError (IPC and ErrorNotice treat it as usual)', () => {
    const e = map('ce', 400, { reason: 'x' });
    expect(e).toBeInstanceOf(GmiError);
    expect(e.toShape()).toMatchObject({ code: 'invalid_input', status: 400 });
  });
});

describe('fromHttpError: recovering what ctx.http consumed', () => {
  async function viaHttp(status: number, body: string, headers: Record<string, string> = {}) {
    return errorFromResponse(new Response(body, { status, headers }));
  }
  it('a JSON body survives (detail) and maps the same as the raw body', async () => {
    const e = fromHttpError(await viaHttp(400, JSON.stringify({ reason: 'name invalid' })), 'ce');
    expect(e).toBeInstanceOf(ComputeHttpError);
    expect(isDefiniteFailure(e)).toBe(true);
    const v2 = fromHttpError(await viaHttp(429, JSON.stringify(v2Error('Resource.QuotaExceeded', 'q', { quota: 1, used: 1 }))), 'v2');
    expect(v2.code).toBe('quota_exceeded');
  });
  it('a long v2 body (truncated to 500 characters by ctx.http) keeps its code', async () => {
    const body = JSON.stringify(v2Error('Sandbox.IdempotentParameterMismatch', 'mismatch', { blob: 'y'.repeat(3000) }));
    const e = fromHttpError(await viaHttp(400, body), 'v2') as ComputeHttpError;
    expect(e.remoteCode).toBe('Sandbox.IdempotentParameterMismatch');
    expect(isDefiniteFailure(e)).toBe(true);
  });
  it('HTML, Cloudflare and plain text are never definite', async () => {
    expect(isDefiniteFailure(fromHttpError(await viaHttp(400, htmlPage), 'ce'))).toBe(false);
    expect(isDefiniteFailure(fromHttpError(await viaHttp(403, 'error code: 1010'), 'ce'))).toBe(false);
    expect(isDefiniteFailure(fromHttpError(await viaHttp(404, 'not here'), 'ce'))).toBe(false);
  });
  it('network / timeout errors pass through unchanged and are not definite', () => {
    const net = new GmiError('network', 'down');
    expect(fromHttpError(net, 'ce')).toBe(net);
    expect(isDefiniteFailure(new GmiError('timeout', 't'))).toBe(false);
  });
  it('Retry-After survives', async () => {
    const e = fromHttpError(await viaHttp(429, JSON.stringify(v2Error('RateLimit.Exceeded')), { 'retry-after': '30' }), 'v2');
    expect(e.retryAfterSec).toBe(30);
  });
});

describe('reason texts (§7.4)', () => {
  it('maps pause / deletion codes to sentences and flags billing', () => {
    expect(sandboxReasonText('Sandbox.BillingInsufficientBalance')).toMatch(/balance is low/);
    expect(sandboxReasonText('Sandbox.Expired')).toMatch(/time limit/);
    expect(sandboxReasonText('Sandbox.SomethingNew')).toMatch(/not known/);
    expect(sandboxReasonText(null)).toBeNull();
    expect(isBillingInitiated('billing')).toBe(true);
    expect(isBillingInitiated('user', 'Sandbox.BillingSuspended')).toBe(true);
    expect(isBillingInitiated('user', 'Sandbox.UserPaused')).toBe(false);
  });
});
