// C1-B: the CE client. POST is never retried (fake-fetch call counts); the create outcome follows §6.2 exactly; 401
// reports the key, 403 never does; logs use Range when it works and a bounded ring when it does not.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { ByteRing, CE_LOGS, createCePublicClient, createCeClient, decodeLogTail, parseCreateIds } from '@main/services/compute/ce/client';
import type { CeContainerCreateRequest } from '@main/services/compute/ce/dto';
import { TEST_COMPUTE_KEY, fakeComputeKeys, fakeHttp, htmlPage, json, lazyBody } from './fakes';

const createReq: CeContainerCreateRequest = { count: 5, idc: 'asia-east-taiwan3', product: 'gmi.container.nv.H200x1.tw3', name: 'gmid-abcdef-box-q1w2e3', templateId: 't1' };

function client(routes: Parameters<typeof fakeHttp>[0], keys = fakeComputeKeys()) {
  const fake = fakeHttp(routes);
  const ce = createCeClient({ http: fake.http, log: silentLogger, keys });
  return { ce, keys, ...fake };
}

const postsTo = (requests: Array<{ method: string; url: string }>, suffix: string) => requests.filter((r) => r.method === 'POST' && r.url.endsWith(suffix)).length;

describe('create: one POST, outcome per §6.2', () => {
  it('200 [{id}] → confirmed; count forced to 1; bearer = the Compute key', async () => {
    const { ce, requests } = client([{ match: '/api/v1/containers', method: 'POST', respond: () => json([{ id: 'c-new' }]) }]);
    const out = await ce.createContainer(createReq);
    expect(out).toEqual({ outcome: 'confirmed', value: 'c-new' });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({ count: 1, name: createReq.name });
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TEST_COMPUTE_KEY}`);
    expect(requests[0]?.headers['user-agent']).toBe('GMI-Desk/test');
  });

  it.each([
    [400, { reason: 'resources.CPU is a required property' }],
    [401, { code: 200, group: 'api-key', message: 'Invalid API key.' }],
    [403, { reason: 'access denied: tenant has no permission to do the operation' }],
    [404, { reason: 'template t1 was not found' }],
    [422, { group: 'request', code: 1, message: 'invalid', validationDetail: [{ field: 'name' }] }],
  ])('%i with a parsed GMI body → failed (definitely not created), one POST', async (status, body) => {
    const { ce, requests } = client([{ match: '/api/v1/containers', method: 'POST', respond: () => json(body, status) }]);
    const out = await ce.createContainer(createReq);
    expect(out.outcome).toBe('failed');
    expect(postsTo(requests, '/containers')).toBe(1);
  });

  it.each([
    ['409', () => json({ reason: 'timestamp mismatched' }, 409)],
    ['429 (Cloudflare)', () => new Response('error code: 1015', { status: 429 })],
    ['429 with JSON', () => json({ reason: 'slow down' }, 429)],
    ['500', () => json({ reason: 'An error occurred in the kubernetes cluster' }, 500)],
    ['503', () => json({ reason: 'database is unavailable' }, 503)],
    ['an HTML challenge page (403)', () => new Response(htmlPage, { status: 403, headers: { 'content-type': 'text/html' } })],
    ['an HTML page with 200', () => new Response(htmlPage, { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a 200 that is not [{id}]', () => json({ id: 'x' })],
    ['a 200 with []', () => json([])],
    ['a 200 with two ids', () => json([{ id: 'a' }, { id: 'b' }])],
    ['a 400 without a GMI body', () => new Response('Bad Request', { status: 400 })],
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s → unknown (reconcile by listing), never a second POST', async (_label, respond) => {
    const { ce, requests } = client([{ match: '/api/v1/containers', method: 'POST', respond }]);
    const out = await ce.createContainer(createReq);
    expect(out.outcome).toBe('unknown');
    expect(postsTo(requests, '/containers')).toBe(1);
  });

  it('a timeout → unknown, one POST', async () => {
    const { ce, requests } = client([
      {
        match: '/api/v1/containers',
        method: 'POST',
        respond: () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
      },
    ]);
    const out = await ce.createContainer(createReq);
    expect(out.outcome).toBe('unknown');
    if (out.outcome !== 'confirmed') expect(out.error.code).toBe('timeout');
    expect(requests).toHaveLength(1);
  });

  it('EIP allocate and firewall create follow the same rules', async () => {
    const { ce, requests } = client([
      { match: '/elastic-ips', method: 'POST', respond: () => json({ reason: 'boom' }, 500) },
      { match: '/firewalls', method: 'POST', respond: () => json({ id: 'fw1', idc: 'i', name: 'n', inboundRules: [] }) },
    ]);
    expect((await ce.allocateEip({ idc: 'i', count: 3, name: 'n', product: 'gmi.eip.sole.shared' })).outcome).toBe('unknown');
    expect(JSON.parse(requests[0]?.body ?? '{}').count).toBe(1);
    expect(await ce.createFirewall({ idc: 'i', name: 'n', inboundRules: [] })).toMatchObject({ outcome: 'confirmed', value: { id: 'fw1' } });
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });
});

describe('retries: GET twice, mutations never', () => {
  it('a GET retries transient failures (3 calls in all)', async () => {
    let n = 0;
    const { ce, requests } = client([{ match: '/api/v1/containers', method: 'GET', respond: () => (++n < 3 ? json({ reason: 'busy' }, 503) : json([])) }]);
    expect(await ce.listContainers()).toEqual([]);
    expect(requests).toHaveLength(3);
  });

  it.each([
    ['DELETE container', (ce: ReturnType<typeof createCeClient>) => ce.deleteContainer('c1')],
    ['restart', (ce: ReturnType<typeof createCeClient>) => ce.restartContainer('c1')],
    ['associate EIP', (ce: ReturnType<typeof createCeClient>) => ce.associateEip('e1', { instanceID: 'c1', instanceType: 'container' })],
    ['release EIP', (ce: ReturnType<typeof createCeClient>) => ce.releaseEip('e1')],
    ['update firewall', (ce: ReturnType<typeof createCeClient>) => ce.updateFirewall('f1', { name: 'n', inboundRules: [] })],
    ['delete firewall', (ce: ReturnType<typeof createCeClient>) => ce.deleteFirewall('f1')],
    ['shell', (ce: ReturnType<typeof createCeClient>) => ce.containerShell('c1')],
  ])('%s: a 503 is not retried', async (_label, call) => {
    const { ce, requests } = client([{ match: () => true, respond: () => json({ reason: 'unavailable' }, 503) }]);
    await expect(call(ce)).rejects.toMatchObject({ code: 'upstream' });
    expect(requests).toHaveLength(1);
  });

  it('ids are validated before any request', async () => {
    const { ce, requests } = client([]);
    await expect(ce.deleteContainer('../../me/api-keys')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toHaveLength(0);
  });
});

describe('the Compute key', () => {
  it('a 401 reports the key that was used; a 403 never does', async () => {
    const keys = fakeComputeKeys();
    const a = client([{ match: () => true, respond: () => json({ code: 2, group: 'auth', message: 'Invalid access token.' }, 401) }], keys);
    await expect(a.ce.listContainers()).rejects.toMatchObject({ code: 'invalid_compute_key' });
    expect(keys.reports).toEqual([expect.objectContaining({ key: TEST_COMPUTE_KEY, status: 401 })]);
    const b = client([{ match: () => true, respond: () => json({ reason: 'access denied: tenant has no permission to do the operation' }, 403) }], keys);
    await expect(b.ce.listContainers()).rejects.toMatchObject({ code: 'not_entitled' });
    expect(keys.reports).toHaveLength(1);
  });
  it('no key → no_compute_key and no request', async () => {
    const { ce, requests } = client([], fakeComputeKeys(null));
    await expect(ce.listContainers()).rejects.toMatchObject({ code: 'no_compute_key' });
    expect(requests).toHaveLength(0);
  });
  it('responses are sanitised: env values never come out', async () => {
    const { ce } = client([{ match: '/api/v1/containers', respond: () => json([{ id: 'c1', name: 'n', idc: 'i', product: 'p', templateId: 't', status: 'running', reason: '', storages: [], envs: [{ name: 'K', value: 'SECRET' }] }]) }]);
    const [c] = await ce.listContainers();
    expect(c?.envNames).toEqual(['K']);
    expect(JSON.stringify(c)).not.toContain('SECRET');
  });
});

describe('public feeds (key-less)', () => {
  it('send no Authorization header', async () => {
    const fake = fakeHttp([
      { match: '/api/v1/idcs', respond: () => json({ idcs: [{ idcId: 'a', name: 'A', country: 'US', countrySubdivision: '', status: 'available' }] }) },
      { match: '/billing/products', respond: () => json({ products: [] }) },
    ]);
    const pub = createCePublicClient({ http: fake.http, log: silentLogger });
    expect(await pub.idcs()).toHaveLength(1);
    await pub.billingProducts('asia-east-taiwan3');
    expect(fake.requests.every((r) => !r.headers.authorization)).toBe(true);
    expect(fake.requests[1]?.url).toContain('dataCenter=asia-east-taiwan3');
  });
});

describe('logs (§6.4)', () => {
  it('Range works (206): a tail is requested, rangeSupported is learned, auto-poll stays on', async () => {
    const { ce, requests } = client([
      {
        match: '/logs',
        respond: (req) => {
          expect(req.headers.range).toBe(`bytes=-${CE_LOGS.ringBytes}`);
          return new Response('line 1\nline 2\n', { status: 206, headers: { 'content-range': 'bytes 5000-5013/5014' } });
        },
      },
    ]);
    const r = await ce.getLogs('c1');
    expect(r).toMatchObject({ rangeSupported: true, autoPoll: true, truncated: true, totalBytes: 5014 });
    expect(r.text).toContain('line 2');
    expect(requests).toHaveLength(1);
  });

  it('a 200 to the Range probe → rangeSupported false; the next call sends no Range', async () => {
    const seen: Array<string | undefined> = [];
    const { ce } = client([{ match: '/logs', respond: (req) => (seen.push(req.headers.range), new Response('small log\n', { status: 200 })) }]);
    expect((await ce.getLogs('c1')).rangeSupported).toBe(false);
    await ce.getLogs('c1');
    expect(seen).toEqual([`bytes=-${CE_LOGS.ringBytes}`, undefined]);
  });

  it('a 200 MB log without Range keeps memory bounded (1 MiB ring) and stops auto-polling', async () => {
    const total = 200 * 1024 * 1024;
    const { ce } = client([{ match: '/logs', respond: () => new Response(lazyBody(total), { status: 200 }) }]);
    const before = process.memoryUsage().arrayBuffers;
    const r = await ce.getLogs('c1', { rangeSupported: false });
    const grown = process.memoryUsage().arrayBuffers - before;
    expect(r.totalBytes).toBe(total);
    expect(r.truncated).toBe(true);
    expect(r.autoPoll).toBe(false);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(CE_LOGS.ringBytes);
    expect(r.text.length).toBeGreaterThan(CE_LOGS.ringBytes - 200);
    // Nowhere near the 200 MB that went through (GC timing makes this loose, the ring test below is exact).
    expect(grown).toBeLessThan(64 * 1024 * 1024);
  });

  it('auto-poll stays on for a log under 10 MB without Range', async () => {
    const { ce } = client([{ match: '/logs', respond: () => new Response(lazyBody(3 * 1024 * 1024), { status: 200 }) }]);
    const r = await ce.getLogs('c1', { rangeSupported: false });
    expect(r).toMatchObject({ autoPoll: true, truncated: true, rangeSupported: false });
  });

  it('a Content-Length above 10 MB stops auto-polling even before the bytes are read', async () => {
    const { ce } = client([{ match: '/logs', respond: () => new Response(lazyBody(1024), { status: 200, headers: { 'content-length': String(11_000_000) } }) }]);
    // The fake body is shorter than the declared length; the client trusts the larger figure.
    const r = await ce.getLogs('c1', { rangeSupported: false });
    expect(r.autoPoll).toBe(false);
    expect(r.totalBytes).toBe(11_000_000);
  });

  it('save full log streams to <dest>.part, then renames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gmi-logs-'));
    try {
      const { ce } = client([{ match: '/logs', respond: () => new Response(lazyBody(5 * 1024 * 1024), { status: 200 }) }]);
      const dest = join(dir, 'container.log');
      expect(await ce.saveLogs('c1', dest)).toBe(5 * 1024 * 1024);
      expect((await stat(dest)).size).toBe(5 * 1024 * 1024);
      await expect(stat(`${dest}.part`)).rejects.toThrow();
      expect((await readFile(dest, 'utf8')).slice(0, 5)).toBe('aaaaa');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ByteRing and tail decoding', () => {
  it('never holds more than its capacity and keeps the newest bytes', () => {
    const ring = new ByteRing(8);
    ring.write(new TextEncoder().encode('abc'));
    ring.write(new TextEncoder().encode('defgh'));
    ring.write(new TextEncoder().encode('ij'));
    expect(new TextDecoder().decode(ring.bytes())).toBe('cdefghij');
    expect(ring.length).toBe(8);
    expect(ring.total).toBe(10);
    expect(ring.dropped).toBe(true);
    ring.write(new TextEncoder().encode('0123456789XY'));
    expect(new TextDecoder().decode(ring.bytes())).toBe('456789XY');
  });
  it('a cut tail drops a split UTF-8 sequence and the partial first line', () => {
    const bytes = new TextEncoder().encode('é partial\nwhole line\n');
    expect(decodeLogTail(bytes.subarray(1), true)).toBe('whole line\n');
    expect(decodeLogTail(bytes, false)).toBe('é partial\nwhole line\n');
  });
  it('parseCreateIds accepts exactly [{id}, …]', () => {
    expect(parseCreateIds([{ id: 'a' }])).toEqual(['a']);
    expect(parseCreateIds([])).toBeNull();
    expect(parseCreateIds([{ id: '' }])).toBeNull();
    expect(parseCreateIds({ id: 'a' })).toBeNull();
  });
});
