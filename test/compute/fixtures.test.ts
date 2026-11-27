// C1-B: the compute fixtures stay synthetic and sanitised (ground rule 6, compute.md §16), and the mock simulators
// never reach the network (T17).
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_COMPUTE_FLAGS, MOCK_COMPUTE_KEY, createMockCompute, expandFixture, mockComputeFlags, mockComputeKeyProvider, mockComputeScenario } from '@main/mock/compute';
import { DEV_ENV_VARS } from '@main/core/dev-env';
import { PUBLIC_ROW_DENY, filterPublicProducts, isPublicSkuAllowed } from '@main/services/compute/sanitize';

const DIR = fileURLToPath(new URL('../../src/main/mock/fixtures/compute/', import.meta.url));

/** Every SKU the fixtures may name: generic, allowlisted, none copied from a customer row. */
const FIXTURE_SKUS = new Set([
  'gmi.container.nv.H200x1.tw3',
  'gmi.container.nv.H200x8.tw3',
  'gmi.container.nv.H100x1.tw1',
  'gmi.container.nv.H100x8.tw1',
  'gmi.container.intel.x4660.large',
  'gmi.sandbox.small',
  'gmi.sandbox.medium',
  'gmi.sandbox.large',
  'gmi.eip.sole.shared',
]);
const ZERO_ORG = '00000000-0000-0000-0000-000000000000';

async function fixtures(): Promise<Array<{ name: string; text: string; json: unknown }>> {
  const names = (await readdir(DIR)).sort();
  return Promise.all(names.map(async (name) => {
    const text = await readFile(join(DIR, name), 'utf8');
    return { name, text, json: name.endsWith('.json') ? JSON.parse(text) : null };
  }));
}

function walk(v: unknown, visit: (key: string, value: unknown) => void, key = ''): void {
  visit(key, v);
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, visit, k);
}

describe('compute fixtures', () => {
  it('the documented files exist and are all JSON', async () => {
    const names = (await fixtures()).map((f) => f.name);
    for (const n of ['idcs.json', 'public-templates.json', 'billing-products.json', 'account-products.json', 'containers.json', 'sandboxes.json', 'snapshots.json', 'eips.json', 'firewalls.json', 'logs.json']) {
      expect(names).toContain(n);
    }
    expect(names.every((n) => n.endsWith('.json'))).toBe(true);
  });

  it('every org id is the zero UUID', async () => {
    for (const f of await fixtures()) {
      walk(f.json, (k, v) => {
        if (k === 'orgId') expect(v, f.name).toBe(ZERO_ORG);
      });
    }
  });

  it('every IPv4 address is in 203.0.113.0/24 (TEST-NET-3), except CIDR rules 0.0.0.0/0', async () => {
    for (const f of await fixtures()) {
      for (const ip of f.text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        if (ip === '0.0.0.0') continue;
        expect(ip.startsWith('203.0.113.'), `${f.name}: ${ip}`).toBe(true);
      }
    }
  });

  it('no customer SKU: every SKU-shaped string is on the fixture allowlist (and the public allowlist)', async () => {
    for (const f of await fixtures()) {
      for (const sku of f.text.match(/\bgmi(?:\.[A-Za-z0-9_]+){2,}/g) ?? []) {
        expect(FIXTURE_SKUS.has(sku), `${f.name}: ${sku}`).toBe(true);
        expect(isPublicSkuAllowed(sku)).toBe(true);
      }
    }
  });

  it('billing rows carry no description and every row survives the sanitiser unchanged in number', async () => {
    const billing = JSON.parse(await readFile(join(DIR, 'billing-products.json'), 'utf8')) as { products: Array<Record<string, unknown>> };
    for (const row of billing.products) {
      expect('description' in row).toBe(false);
      for (const v of [row.instanceType, row.productName, (row.spec as { name?: string } | null)?.name]) {
        if (typeof v === 'string') expect(PUBLIC_ROW_DENY.test(v), v).toBe(false);
      }
    }
    expect(filterPublicProducts(billing)).toHaveLength(billing.products.length);
  });

  it('no secrets: env values redacted, no credentials, no tokens, no JWTs, no private keys', async () => {
    for (const f of await fixtures()) {
      walk(f.json, (k, v) => {
        if (k === 'envs' && Array.isArray(v)) for (const e of v as Array<{ value?: string }>) expect(['[redacted]', ''], f.name).toContain(e.value);
        expect(['credential', 'secret', 'password', 'sandbox_access_token', 'traffic_access_token', 'urlPath', 'env_vars'], f.name).not.toContain(k);
      });
      expect(f.text, f.name).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
      expect(f.text, f.name).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|ssh-(ed25519|rsa) AAAA/);
      expect(f.text, f.name).not.toMatch(/Bearer\s+\S/);
    }
  });

  it('public templates are official, with no credential', async () => {
    const t = JSON.parse(await readFile(join(DIR, 'public-templates.json'), 'utf8')) as { templates: Array<Record<string, unknown>> };
    expect(t.templates).toHaveLength(4);
    for (const row of t.templates) {
      expect(row.official).toBe(true);
      expect('credential' in row).toBe(false);
    }
  });

  it('managed demo resources carry the install placeholders, not a real install tag', async () => {
    const c = await readFile(join(DIR, 'containers.json'), 'utf8');
    expect(c).toContain('gmid-{inst6}-');
    const s = await readFile(join(DIR, 'sandboxes.json'), 'utf8');
    expect(s).toContain('"inst": "{inst}"');
    expect(s).toContain('cr_mock_sb1');
  });

  it('every container / EIP / firewall name has the shape names.ts generates (base32 tag and nonce)', async () => {
    const shape = /^gmid-[a-z2-7]{6}-.+-[a-z2-7]{6}(-eip|-fw)?$/;
    for (const name of ['containers.json', 'eips.json', 'firewalls.json']) {
      const text = (await readFile(join(DIR, name), 'utf8')).replace(/\{inst6\}/g, 'abcdef');
      walk(JSON.parse(text), (k, v) => {
        if (k === 'name' && typeof v === 'string' && v.startsWith('gmid-')) expect(v, name).toMatch(shape);
      });
    }
  });
});

describe('mock simulators never touch the network (T17)', () => {
  const fetchSpy = vi.fn(async () => {
    throw new Error('network is forbidden in mock mode');
  });
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    fetchSpy.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a full tour of every simulated API makes no fetch', async () => {
    const sim = createMockCompute({ flags: new Set(['orphan', 'orphan_other_install', 'eip_orphan', 'org_billing', 'paused']), installTag: 'abcdef', installLabel: '0123456789abcdef' });
    await sim.publicApi.idcs();
    await sim.publicApi.billingProducts();
    await sim.publicApi.publicTemplates();
    const containers = await sim.ce.listContainers();
    expect(containers.some((c) => c.name.startsWith('gmid-abcdef-'))).toBe(true);
    expect(containers.some((c) => c.name.startsWith('gmid-zzzzzz-'))).toBe(true);
    expect(JSON.stringify(containers)).not.toContain('[redacted]');
    await sim.ce.getLogs('00000000-0000-4000-8000-00000000d001');
    await sim.ce.listEips();
    await sim.ce.listFirewalls();
    await sim.ce.listProducts('asia-east-taiwan3');
    const sbs = await sim.sandbox.listAll({ metadata: { app: 'gmi-desk', inst: '0123456789abcdef' } });
    expect(sbs.map((s) => s.metadata?.rid).sort()).toEqual(['cr_mock_sb1', 'cr_mock_sb2', 'cr_mock_sb3']);
    const r = await sim.dataPlane.exec('sbx-mock-0001', { command: `printf '%s\\t%s' "$HOME" "$(id -un)"`, timeoutSec: 10 });
    expect(r.stdout).toBe('/root\troot');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('simulator behaviour', () => {
  let now = Date.parse('2026-11-02T10:00:00Z');
  const clock = () => new Date(now);
  const sim = (flags: string[] = []) => createMockCompute({ flags: new Set(flags), installTag: 'abcdef', installLabel: '0123456789abcdef', now: clock });
  beforeEach(() => {
    now = Date.parse('2026-11-02T10:00:00Z');
  });

  it('containers: creating 3 s → running; delete → terminating → gone', async () => {
    const s = sim();
    const out = await s.ce.createContainer({ count: 1, idc: 'asia-east-taiwan3', product: 'gmi.container.nv.H200x1.tw3', name: 'gmid-abcdef-x-q1w2e3', templateId: 't', envs: [{ name: 'K', value: 'secret-value' }] });
    if (out.outcome !== 'confirmed') throw new Error('create failed');
    expect((await s.ce.getContainer(out.value)).status).toBe('creating');
    now += 3_000;
    const c = await s.ce.getContainer(out.value);
    expect(c.status).toBe('running');
    expect(JSON.stringify(c)).not.toContain('secret-value');
    await s.ce.deleteContainer(out.value);
    expect((await s.ce.getContainer(out.value)).status).toBe('terminating');
    now += 2_000;
    await expect(s.ce.getContainer(out.value)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('flags: create_fails → failed, create_unknown → unknown and nothing appears, not_entitled → 403, api_down → upstream', async () => {
    const req = { count: 1, idc: 'asia-east-taiwan3', product: 'p', name: 'gmid-abcdef-y-q1w2e3', templateId: 't' };
    expect((await sim(['create_fails']).ce.createContainer(req)).outcome).toBe('failed');
    const u = sim(['create_unknown']);
    expect((await u.ce.createContainer(req)).outcome).toBe('unknown');
    expect((await u.ce.listContainers()).some((c) => c.name === req.name)).toBe(false);
    await expect(sim(['not_entitled']).ce.listContainers()).rejects.toMatchObject({ code: 'not_entitled' });
    await expect(sim(['not_entitled']).sandbox.list()).rejects.toMatchObject({ code: 'not_entitled' });
    expect(await sim(['sandboxes_only']).sandbox.list()).toMatchObject({ total: 1 });
    await expect(sim(['sandboxes_only']).ce.listContainers()).rejects.toMatchObject({ code: 'not_entitled' });
    await expect(sim(['api_down']).publicApi.idcs()).rejects.toMatchObject({ code: 'upstream' });
    await expect(sim(['lease_action_failed']).ce.deleteContainer('00000000-0000-4000-8000-00000000d001')).rejects.toMatchObject({ code: 'upstream' });
  });

  it('sandboxes: idempotent create, provisioning → running, connect only when running, pause → paused, cold resume', async () => {
    const s = sim();
    const req = { template_id: 'tpl-mock-python', product: 'gmi.sandbox.small', timeout: 3600, auto_pause: true, metadata: { app: 'gmi-desk', rid: 'cr_x' } };
    const a = await s.sandbox.create(req, { idempotencyKey: 'cr_xxxxxxxxxxxx' });
    const b = await s.sandbox.create(req, { idempotencyKey: 'cr_xxxxxxxxxxxx' });
    if (a.outcome !== 'confirmed' || b.outcome !== 'confirmed') throw new Error('create failed');
    expect(b.value.id).toBe(a.value.id);
    await expect(s.sandbox.connect(a.value.id)).rejects.toMatchObject({ code: 'not_found' });
    now += 3_000;
    const access = await s.sandbox.connect(a.value.id);
    expect(access.sandbox_access_token).toMatch(/^mock-sat-/);
    await s.dataPlane.exec(a.value.id, { command: 'python3 -m http.server 8000', timeoutSec: 30 });
    expect((await s.dataPlane.exec(a.value.id, { command: 'cat /proc/net/tcp', timeoutSec: 10 })).stdout).toContain(':1F40 ');
    await s.sandbox.pause(a.value.id);
    await expect(s.sandbox.connect(a.value.id)).rejects.toMatchObject({ code: 'conflict' });
    now += 2_000;
    expect((await s.sandbox.get(a.value.id)).state).toBe('paused');
    await s.sandbox.resume(a.value.id, 600);
    now += 2_000;
    expect((await s.sandbox.get(a.value.id)).state).toBe('running');
    expect(s.coldResumed.has(a.value.id)).toBe(true);
    expect((await s.dataPlane.exec(a.value.id, { command: 'cat /proc/net/tcp', timeoutSec: 10 })).stdout).not.toContain(':1F40 ');
  });

  it('the deleted state is listed only when asked', async () => {
    const s = sim();
    await s.sandbox.delete('sbx-mock-0001');
    now += 2_000;
    expect((await s.sandbox.list()).items.find((x) => x.id === 'sbx-mock-0001')).toBeUndefined();
    expect((await s.sandbox.list({ state: 'deleted', metadata: { rid: 'cr_mock_sb1' } })).items).toHaveLength(1);
  });

  it('the fake filesystem: find -printf listing, write / read, mkdir -p, mv, rm', async () => {
    const s = sim();
    const id = 'sbx-mock-0001';
    const list = await s.dataPlane.exec(id, { command: `find "$GMID_P" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%m\\t%f\\0'`, envs: { GMID_P: '/root/app' }, timeoutSec: 25 });
    const names = (list.stdout ?? '').split('\0').filter(Boolean).map((e) => e.split('\t')[4]);
    expect(names).toEqual(['README.md', 'index.html', 'main.py']);
    await s.dataPlane.exec(id, { command: 'mkdir -p "$GMID_P"', envs: { GMID_P: '/root/new/deep' }, timeoutSec: 5 });
    await s.dataPlane.writeFile(id, '/root/new/deep/a.txt', 'hello');
    expect(new TextDecoder().decode((await s.dataPlane.readFile(id, '/root/new/deep/a.txt')).bytes)).toBe('hello');
    await s.dataPlane.exec(id, { command: 'mv "$A" "$B"', envs: { A: '/root/new/deep/a.txt', B: '/root/b.txt' }, timeoutSec: 5 });
    await expect(s.dataPlane.readFile(id, '/root/new/deep/a.txt')).rejects.toMatchObject({ code: 'not_found' });
    await s.dataPlane.exec(id, { command: 'rm -rf "$P"', envs: { P: '/root/new' }, timeoutSec: 5 });
    expect((await s.dataPlane.exec(id, { command: 'ls /root', timeoutSec: 5 })).stdout).not.toContain('new');
    await expect(s.dataPlane.writeFile(id, '/nope/x.txt', 'x')).rejects.toMatchObject({ code: 'invalid_input' });
    const dl = await s.dataPlane.download(id, '/root/b.txt', { offset: 2 });
    expect(dl).toMatchObject({ status: 206, resumed: true, totalBytes: 5 });
  });

  it('the fake PTY echoes input and runs commands; shell_busy refuses to attach', async () => {
    const s = sim();
    const pty = s.openPty('sbx-mock-0001');
    let out = '';
    pty.onData((b) => (out += new TextDecoder().decode(b)));
    await Promise.resolve();
    pty.write('pwd\r');
    pty.write('uname -a\r');
    pty.write('nvidia-smi\r');
    expect(out).toContain('pwd\r\n/root\r\n');
    expect(out).toContain('Linux mk0001');
    expect(out).toContain('command not found');
    expect(() => sim(['shell_busy']).openPty('sbx-mock-0001')).toThrow(/Another terminal/);
  });

  it('flags parse strictly; the scenario seeds budgets; the mock key is fake', async () => {
    expect([...mockComputeFlags('orphan, budget_low,nonsense')]).toEqual(['orphan', 'budget_low']);
    expect(MOCK_COMPUTE_FLAGS).toContain('org_billing');
    expect(mockComputeScenario(new Set(['no_daily_budget'])).budget).toEqual({ dailyUsd: null });
    expect(mockComputeScenario(new Set(['budget_low']))).toMatchObject({ budget: { dailyUsd: 5 }, spentTodayUsd: 4.6 });
    expect(mockComputeScenario(new Set(['lease_expiring'])).leaseEndsInMin).toBe(12);
    expect(mockComputeScenario(new Set()).budget).toEqual({ dailyUsd: 25, enforce: true });
    expect(await mockComputeKeyProvider(new Set()).getComputeKey()).toBe(MOCK_COMPUTE_KEY);
    await expect(mockComputeKeyProvider(new Set(['no_key'])).requireComputeKey()).rejects.toMatchObject({ code: 'no_compute_key' });
    expect(DEV_ENV_VARS).toContain('GMI_DESK_MOCK_COMPUTE');
  });

  it('expandFixture fills the install placeholders and relative times', () => {
    const out = expandFixture({ name: 'gmid-{inst6}-x', inst: '{inst}', at: '{ago:2h}', end: '{in:30m}', _note: 'dropped' }, { inst6: 'abcdef', inst: 'feed', now: Date.parse('2026-11-02T10:00:00Z') });
    expect(out).toEqual({ name: 'gmid-abcdef-x', inst: 'feed', at: '2026-11-02T08:00:00.000Z', end: '2026-11-02T10:30:00.000Z' });
  });
});
