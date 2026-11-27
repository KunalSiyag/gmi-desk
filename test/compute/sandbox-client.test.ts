// C1-B: the Sandbox v2 control plane. Idempotency-Key on create (the same one on every retry); retries only for network
// errors and 503, at most 3, inside 2 minutes; every other POST/DELETE is sent once.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { V2_CREATE_RETRY, createSandboxClient, parseCreateResult, parsePage } from '@main/services/compute/sandbox/client';
import type { V2CreateSandboxRequest } from '@main/services/compute/sandbox/dto';
import { TEST_COMPUTE_KEY, fakeComputeKeys, fakeHttp, htmlPage, instantSleep, json, v2Error } from './fakes';

const RID = 'cr_0123456789abcdef0123';
const req: V2CreateSandboxRequest = {
  template_id: 'tpl',
  product: 'gmi.sandbox.small',
  timeout: 3600,
  auto_pause: true,
  secure: true,
  metadata: { app: 'gmi-desk', inst: '0123456789abcdef', rid: RID, purpose: 'computer' },
};
const created = { id: 'sbx-1', sandbox_key: 'mk1', domain: 'iowa2.sandbox.example', sandbox_access_token: 'sat', traffic_access_token: 'tat' };

function client(routes: Parameters<typeof fakeHttp>[0], opts: { now?: () => Date } = {}) {
  const fake = fakeHttp(routes);
  const keys = fakeComputeKeys();
  const sleeper = instantSleep();
  const sb = createSandboxClient({ http: fake.http, log: silentLogger, keys, sleep: sleeper.sleep, now: opts.now });
  return { sb, keys, sleeper, ...fake };
}

const creates = (requests: Array<{ method: string; url: string; headers: Record<string, string> }>) => requests.filter((r) => r.method === 'POST' && /\/sandboxes$/.test(r.url));

describe('create', () => {
  it('sends Idempotency-Key = rid, the bearer, and the explicit timeout; 201 → confirmed with access', async () => {
    const { sb, requests } = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => json({ request_id: 'r', data: created }, 201) }]);
    const out = await sb.create(req, { idempotencyKey: RID });
    expect(out).toEqual({ outcome: 'confirmed', value: created });
    expect(requests[0]?.headers['idempotency-key']).toBe(RID);
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TEST_COMPUTE_KEY}`);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ timeout: 3600, secure: true, metadata: { rid: RID } });
  });

  it('refuses a create without a timeout or without a key (no request)', async () => {
    const { sb, requests } = client([]);
    await expect(sb.create({ ...req, timeout: undefined }, { idempotencyKey: RID })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(sb.create(req, { idempotencyKey: '' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toHaveLength(0);
  });

  it('network errors and 503 are retried with the same key, at most 3 times', async () => {
    let n = 0;
    const { sb, requests, sleeper } = client([
      { match: /\/sandboxes$/, method: 'POST', respond: () => (++n === 1 ? Promise.reject(new TypeError('fetch failed')) : n < 4 ? json(v2Error('System.Internal'), 503) : json({ data: created }, 201)) },
    ]);
    const out = await sb.create(req, { idempotencyKey: RID });
    expect(out.outcome).toBe('confirmed');
    const posts = creates(requests);
    expect(posts).toHaveLength(4);
    expect(new Set(posts.map((p) => p.headers['idempotency-key']))).toEqual(new Set([RID]));
    expect(sleeper.delays).toEqual([...V2_CREATE_RETRY.delaysMs]);
  });

  it('gives up after 3 retries → unknown (reconcile by listing)', async () => {
    const { sb, requests } = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => json(v2Error('System.Internal'), 503) }]);
    const out = await sb.create(req, { idempotencyKey: RID });
    expect(out.outcome).toBe('unknown');
    expect(creates(requests)).toHaveLength(1 + V2_CREATE_RETRY.max);
  });

  it('never retries outside the 2-minute window', async () => {
    let t = Date.parse('2026-11-02T10:00:00Z');
    const { sb, requests } = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => ((t += 119_500), json(v2Error('System.Internal'), 503)) }], { now: () => new Date(t) });
    expect((await sb.create(req, { idempotencyKey: RID })).outcome).toBe('unknown');
    expect(creates(requests)).toHaveLength(1);
  });

  it.each([
    ['500', () => json(v2Error('System.Internal'), 500)],
    ['502', () => json(v2Error('System.Internal'), 502)],
    ['a timeout', () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))],
    ['an HTML page', () => new Response(htmlPage, { status: 403 })],
    ['a 409 conflict', () => json(v2Error('Resource.StateConflict'), 409)],
  ])('%s is not retried and is unknown', async (_l, respond) => {
    const { sb, requests } = client([{ match: /\/sandboxes$/, method: 'POST', respond }]);
    expect((await sb.create(req, { idempotencyKey: RID })).outcome).toBe('unknown');
    expect(creates(requests)).toHaveLength(1);
  });

  it('Sandbox.IdempotentKeyConsumed → unknown (reconcile by metadata[rid]); ParameterMismatch → failed (a bug)', async () => {
    const a = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => json(v2Error('Sandbox.IdempotentKeyConsumed'), 409) }]);
    const consumed = await a.sb.create(req, { idempotencyKey: RID });
    expect(consumed.outcome).toBe('unknown');
    if (consumed.outcome !== 'confirmed') expect(consumed.error).toMatchObject({ remoteCode: 'Sandbox.IdempotentKeyConsumed' });
    const b = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => json(v2Error('Sandbox.IdempotentParameterMismatch'), 400) }]);
    expect((await b.sb.create(req, { idempotencyKey: RID })).outcome).toBe('failed');
  });

  it('quota and rate limits are definite refusals, never retried', async () => {
    const a = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => json(v2Error('Resource.QuotaExceeded', 'q', { quota: 2, used: 2, requested: 1 }), 429) }]);
    const q = await a.sb.create(req, { idempotencyKey: RID });
    expect(q.outcome).toBe('failed');
    if (q.outcome !== 'confirmed') expect(q.error.code).toBe('quota_exceeded');
    const b = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => json(v2Error('RateLimit.Exceeded'), 429, { 'retry-after': '12' }) }]);
    const r = await b.sb.create(req, { idempotencyKey: RID });
    expect(r.outcome).toBe('failed');
    if (r.outcome !== 'confirmed') expect(r.error).toMatchObject({ code: 'rate_limited', retryAfterSec: 12 });
    expect(creates([...a.requests, ...b.requests])).toHaveLength(2);
  });

  it('a 201 without the access fields → unknown', async () => {
    const { sb } = client([{ match: /\/sandboxes$/, method: 'POST', respond: () => json({ data: { id: 'sbx-1' } }, 201) }]);
    expect((await sb.create(req, { idempotencyKey: RID })).outcome).toBe('unknown');
  });
});

describe('other mutations are sent once', () => {
  it.each([
    ['pause', (sb: ReturnType<typeof createSandboxClient>) => sb.pause('sbx-1')],
    ['resume', (sb: ReturnType<typeof createSandboxClient>) => sb.resume('sbx-1', 600)],
    ['timeout', (sb: ReturnType<typeof createSandboxClient>) => sb.setTimeout('sbx-1', 600)],
    ['delete', (sb: ReturnType<typeof createSandboxClient>) => sb.delete('sbx-1')],
    ['connect', (sb: ReturnType<typeof createSandboxClient>) => sb.connect('sbx-1')],
    ['snapshot delete', (sb: ReturnType<typeof createSandboxClient>) => sb.deleteSnapshot('snp-1')],
  ])('%s: a 503 is not retried', async (_l, call) => {
    const { sb, requests } = client([{ match: () => true, respond: () => json(v2Error('System.Internal'), 503) }]);
    await expect(call(sb)).rejects.toMatchObject({ code: 'upstream' });
    expect(requests).toHaveLength(1);
  });

  it('unwraps envelopes: timeout result, delete state, connect end_at', async () => {
    const { sb } = client([
      { match: '/timeout', respond: () => json({ request_id: 'r', data: { id: 'sbx-1', old_end_at: 'a', new_end_at: '2026-11-02T12:00:00Z' } }) },
      { match: /\/sandboxes\/sbx-1$/, method: 'DELETE', respond: () => json({ request_id: 'r', data: { id: 'sbx-1', state: 'deleting' } }, 202) },
      { match: '/connect', respond: () => json({ request_id: 'r', data: { ...created, end_at: '2026-11-02T11:00:00Z' } }) },
    ]);
    expect((await sb.setTimeout('sbx-1', 600)).new_end_at).toBe('2026-11-02T12:00:00Z');
    expect((await sb.delete('sbx-1')).state).toBe('deleting');
    expect((await sb.connect('sbx-1')).end_at).toBe('2026-11-02T11:00:00Z');
  });

  it('a 401 reports the key; a 403 never does', async () => {
    const a = client([{ match: () => true, respond: () => json(v2Error('Auth.Unauthorized'), 401) }]);
    await expect(a.sb.get('sbx-1')).rejects.toMatchObject({ code: 'invalid_compute_key' });
    expect(a.keys.reports).toHaveLength(1);
    const b = client([{ match: () => true, respond: () => json(v2Error('Auth.Forbidden', 'tenant has no permission'), 403) }]);
    await expect(b.sb.get('sbx-1')).rejects.toMatchObject({ code: 'not_entitled' });
    expect(b.keys.reports).toHaveLength(0);
  });
});

describe('lists', () => {
  it('metadata filters as metadata[k]=v, page_size 100, one listing per state, deduplicated', async () => {
    const urls: string[] = [];
    const { sb } = client([
      {
        match: /\/sandboxes\?/,
        respond: (r) => {
          urls.push(decodeURIComponent(r.url));
          const state = new URL(r.url).searchParams.get('state');
          return json({ request_id: 'r', total: 1, page: 1, page_size: 100, items: [{ id: state === 'deleted' ? 'sbx-2' : 'sbx-1', state: state ?? 'running' }] });
        },
      },
    ]);
    const all = await sb.listAll({ metadata: { app: 'gmi-desk', rid: RID }, states: ['running', 'paused', 'deleted'] });
    expect(all.map((s) => s.id).sort()).toEqual(['sbx-1', 'sbx-2']);
    expect(urls).toHaveLength(3);
    for (const u of urls) {
      expect(u).toContain(`metadata[rid]=${RID}`);
      expect(u).toContain('metadata[app]=gmi-desk');
      expect(u).toContain('page_size=100');
    }
    expect(urls.some((u) => u.includes('state=deleted'))).toBe(true);
  });

  it('pages until the total is reached', async () => {
    const { sb, requests } = client([
      {
        match: /\/sandboxes\?/,
        respond: (r) => {
          const page = Number(new URL(r.url).searchParams.get('page'));
          const items = Array.from({ length: page < 3 ? 100 : 5 }, (_, i) => ({ id: `sbx-${page}-${i}`, state: 'running' }));
          return json({ request_id: 'r', total: 205, page, page_size: 100, items });
        },
      },
    ]);
    expect(await sb.listAll()).toHaveLength(205);
    expect(requests).toHaveLength(3);
  });

  it('rejects metadata label names that could change the query', async () => {
    const { sb, requests } = client([]);
    await expect(sb.list({ metadata: { 'a]&state=deleted&x[': '1' } })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toHaveLength(0);
  });

  it('products and templates per IDC', async () => {
    const { sb, requests } = client([
      { match: '/products', respond: () => json({ request_id: 'r', data: [{ resource_type: 'sandbox', product: 'gmi.sandbox.small', name: 'SMALL', status: 'active', resources: { cpu_count: 2, memory_mb: 4096, disk_size_mb: 1, architecture: 'x86_64' } }] }) },
      { match: '/templates', respond: () => json({ request_id: 'r', total: 1, page: 1, page_size: 100, items: [{ id: 't', name: 'py' }] }) },
    ]);
    expect(await sb.products('us-central-iowa2')).toHaveLength(1);
    expect(await sb.templates('us-central-iowa2')).toHaveLength(1);
    expect(requests[0]?.url).toContain('idc_name=us-central-iowa2');
    expect(requests[0]?.url).toContain('resource_type=sandbox');
  });

  it('parsePage / parseCreateResult tolerate envelopes and reject odd shapes', () => {
    expect(parsePage({ data: { items: [{ id: 'a', state: 'running' }, { nope: 1 }], total: 1 } }, (v): v is { id: string } => typeof (v as { id?: unknown }).id === 'string').items).toHaveLength(1);
    expect(parseCreateResult({ data: created })).toEqual(created);
    expect(parseCreateResult(created)).toEqual(created);
    expect(parseCreateResult({ data: { ...created, domain: '' } })).toBeNull();
  });
});
