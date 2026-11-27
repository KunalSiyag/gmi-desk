import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { codeForStatus, createHttp, extractErrorMessage } from '@main/core/http';
import { silentLogger } from '@main/core/logger';
import { createFakeFetch, jsonResponse } from '../helpers/fetch';

describe('http', () => {
  it('sends UA, bearer, JSON body and query params', async () => {
    const fake = createFakeFetch([{ match: '/thing', respond: () => jsonResponse({ ok: true }) }]);
    const http = createHttp({ userAgent: 'GMI-Desk/test', log: silentLogger, fetch: fake.fetch });
    const out = await http.json<{ ok: boolean }>('https://example.test/thing', { json: { a: 1 }, bearer: 'sk-123', query: { limit: 5, skip: undefined } });
    expect(out).toEqual({ ok: true });
    const req = fake.requests[0]!;
    expect(req.url).toBe('https://example.test/thing?limit=5');
    expect(req.method).toBe('POST');
    expect(req.headers['user-agent']).toBe('GMI-Desk/test');
    expect(req.headers.authorization).toBe('Bearer sk-123');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toBe('{"a":1}');
  });

  it('maps HTTP statuses to error codes with the upstream message', async () => {
    const fake = createFakeFetch([
      { match: '/401', respond: () => jsonResponse({ error: { message: 'bad key' } }, 401) },
      { match: '/429', respond: () => jsonResponse({ message: 'slow down' }, 429, { 'retry-after': '3' }) },
      { match: '/cf', respond: () => new Response('error code: 1010', { status: 403 }) },
    ]);
    const http = createHttp({ userAgent: 'x', log: silentLogger, fetch: fake.fetch });
    await expect(http.json('https://e.test/401', { unauthorizedCode: 'invalid_api_key' })).rejects.toMatchObject({ code: 'invalid_api_key', message: 'bad key', status: 401 });
    await expect(http.json('https://e.test/429')).rejects.toMatchObject({ code: 'rate_limited', retryAfterSec: 3 });
    await expect(http.json('https://e.test/cf')).rejects.toMatchObject({ code: 'unauthorized', message: 'GMI blocked this request (Cloudflare).' });
  });

  it('retries transient failures when asked', async () => {
    let calls = 0;
    const fake = createFakeFetch([
      {
        match: '/flaky',
        respond: () => {
          calls += 1;
          return calls < 2 ? new Response('oops', { status: 503 }) : jsonResponse({ n: calls });
        },
      },
    ]);
    const http = createHttp({ userAgent: 'x', log: silentLogger, fetch: fake.fetch });
    await expect(http.json('https://e.test/flaky', { retries: 2 })).resolves.toEqual({ n: 2 });
  });

  it('reports network failures and timeouts with stable codes', async () => {
    const http = createHttp({
      userAgent: 'x',
      log: silentLogger,
      fetch: async (_url, init) => {
        if (String(_url).includes('slow')) {
          await new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })));
          });
        }
        throw new TypeError('fetch failed');
      },
    });
    await expect(http.json('https://e.test/x')).rejects.toMatchObject({ code: 'network' });
    await expect(http.json('https://e.test/slow', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('returns 3xx responses to the caller with redirect: manual', async () => {
    const fake = createFakeFetch([
      { match: '/moved', respond: () => new Response(null, { status: 302, headers: { location: 'https://cdn.test/file' } }) },
    ]);
    const http = createHttp({ userAgent: 'x', log: silentLogger, fetch: fake.fetch });
    const res = await http.request('https://e.test/moved', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://cdn.test/file');
    await expect(http.request('https://e.test/moved')).rejects.toMatchObject({ code: 'upstream', status: 302 });
  });

  it('rejects non-JSON success bodies as upstream errors', async () => {
    const fake = createFakeFetch([{ match: '/html', respond: () => new Response('<html>hi</html>', { status: 200 }) }]);
    const http = createHttp({ userAgent: 'x', log: silentLogger, fetch: fake.fetch });
    const err = await http.json('https://e.test/html').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmiError);
    expect((err as GmiError).code).toBe('upstream');
  });

  it('extracts messages from common payloads', () => {
    expect(extractErrorMessage('{"error":"unauthorized","message":"Invalid IAM token or API key"}')).toBe('unauthorized: Invalid IAM token or API key');
    expect(extractErrorMessage('{"group":"api_key","message":"API key is required."}')).toBe('API key is required.');
    expect(extractErrorMessage('<html>nope</html>')).toBeNull();
    expect(codeForStatus(402)).toBe('payment_required');
    expect(codeForStatus(500)).toBe('upstream');
  });
});
