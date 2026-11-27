// C1-B: the compute catalog (§5): signed-out aggregation without SKUs, the org's exact products with joined prices,
// per-source states with last good data, the cache, and the PriceBook.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createMockCompute } from '@main/mock/compute';
import {
  aggregateOfferId,
  aggregatePublicOffers,
  createComputeCatalog,
  pickPrice,
  readCatalogCache,
  type ComputeCatalogDeps,
} from '@main/services/compute/catalog';
import type { CePublicApi } from '@main/services/compute/ce/client';
import { filterPublicProducts } from '@main/services/compute/sanitize';
import { COMPUTE_DATA_FILES } from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeComputeKeys } from './fakes';

let t: TestContext | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function setup(opts: { key?: string | null; flags?: string[]; publicApi?: Partial<CePublicApi>; now?: () => Date } = {}) {
  t = await createTestContext();
  const sim = createMockCompute({ flags: new Set(opts.flags ?? []), installTag: 'abcdef', installLabel: '0123456789abcdef' });
  const keys = fakeComputeKeys(opts.key === undefined ? 'ck' : opts.key);
  const calls = { idcs: 0, feed: 0, templates: 0, products: 0 };
  const publicApi: CePublicApi = {
    idcs: async () => (calls.idcs++, (opts.publicApi?.idcs ?? sim.publicApi.idcs)()),
    billingProducts: async (dc) => (calls.feed++, (opts.publicApi?.billingProducts ?? sim.publicApi.billingProducts)(dc)),
    publicTemplates: async () => (calls.templates++, (opts.publicApi?.publicTemplates ?? sim.publicApi.publicTemplates)()),
  };
  const ce = { ...sim.ce, listProducts: async (idc: string) => (calls.products++, sim.ce.listProducts(idc)) };
  const deps: ComputeCatalogDeps = { dataDir: t.ctx.paths.data, log: silentLogger, keys, publicApi, ce, sandbox: sim.sandbox, now: opts.now };
  const catalog = createComputeCatalog(deps);
  await catalog.load();
  return { catalog, keys, calls, deps, sim };
}

describe('signed out (no Compute key)', () => {
  it('serves IDCs, official templates and aggregated offers with no SKU; account sources skipped', async () => {
    const { catalog } = await setup({ key: null });
    const c = await catalog.getCatalog();
    expect(c.scope).toBe('public');
    expect(c.idcs.map((i) => i.id)).toContain('asia-east-taiwan3');
    expect(c.idcs.find((i) => i.id === 'us-denver-1')?.status).toBe('maintenance');
    expect(c.offers.length).toBeGreaterThan(0);
    for (const o of c.offers) {
      expect(o.sku).toBeNull();
      expect(o.entitled).toBeNull();
    }
    const h200 = c.offers.find((o) => o.id === 'container:H200x1:asia-east-taiwan3');
    expect(h200).toMatchObject({ kind: 'container', gpuModel: 'H200', gpuCount: 1, listUsdPerHour: 3.35 });
    const sb = c.offers.filter((o) => o.kind === 'sandbox').map((o) => o.sizeLabel).sort();
    expect(sb).toEqual(['LARGE', 'MEDIUM', 'SMALL']);
    expect(c.templates.every((tp) => tp.official && tp.kind === 'container')).toBe(true);
    expect(c.templates).toHaveLength(4);
    expect(c.sources).toMatchObject({ idcs: { state: 'ok' }, publicProducts: { state: 'ok' }, publicTemplates: { state: 'ok' }, accountProducts: { state: 'skipped' }, sandboxTemplates: { state: 'skipped' } });
    expect(c.idcs.find((i) => i.id === 'asia-east-taiwan3')).toMatchObject({ kinds: ['container'], eipAvailable: true });
    expect(c.idcs.find((i) => i.id === 'us-central-iowa2')).toMatchObject({ kinds: ['sandbox'], eipAvailable: null });
  });

  it('opening an IDC without a key makes no account call', async () => {
    const { catalog, calls } = await setup({ key: null });
    await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    expect(calls.products).toBe(0);
  });

  it('aggregation keeps the lowest price per (kind, gpuModel, gpuCount, idc) and hides the variants', () => {
    const rows = filterPublicProducts({
      products: [
        { instanceType: 'gmi.container.nv.H100x1.a', dataCenter: 'tw1', price: 2_900_000, valid: true, gpuModel: 'H100', attributes: { gpu_count: 1 }, spec: null },
        { instanceType: 'gmi.container.nv.H100x1.b', dataCenter: 'tw1', price: 2_750_000, valid: true, gpuModel: 'H100', attributes: { gpu_count: 1 }, spec: null },
      ],
    });
    const offers = aggregatePublicOffers(rows);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ id: 'container:H100x1:tw1', sku: null, listUsdPerHour: 2.75 });
    expect(JSON.stringify(offers)).not.toMatch(/H100x1\.(a|b)/);
    expect(aggregateOfferId({ kind: 'container', gpuModel: null, gpuCount: 0, idc: 'x', sizeLabel: null })).toBe('container:cpux0:x');
  });
});

describe('with a Compute key', () => {
  it("an opened IDC shows exactly the org's products with joined list prices; other IDCs stay aggregated", async () => {
    const { catalog } = await setup();
    const c = await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    expect(c.scope).toBe('account');
    const tw3 = c.offers.filter((o) => o.idc === 'asia-east-taiwan3');
    expect(tw3.map((o) => o.sku).sort()).toEqual(['gmi.container.nv.H200x1.tw3', 'gmi.container.nv.H200x8.tw3']);
    expect(tw3.find((o) => o.sku === 'gmi.container.nv.H200x8.tw3')).toMatchObject({ entitled: true, listUsdPerHour: 26.8, gpuModel: 'H200', gpuCount: 8 });
    expect(c.offers.find((o) => o.idc === 'asia-east-taiwan1')?.sku).toBeNull();
    expect(c.templates.some((tp) => tp.name === 'team-notebook' && !tp.official && tp.description === null)).toBe(true);
    expect(c.sources.accountProducts.state).toBe('ok');
  });

  it('a SKU with no public price is "price unknown" (null), and the PriceBook says so', async () => {
    const { catalog } = await setup({ flags: ['price_unknown'] });
    const c = await catalog.getCatalog({ idc: 'asia-east-taiwan1' });
    expect(c.offers.find((o) => o.sku === 'gmi.container.nv.H100x1.tw1')?.listUsdPerHour).toBeNull();
    expect(catalog.price('gmi.container.nv.H100x1.tw1', 'asia-east-taiwan1').usdPerHour).toBeNull();
  });

  it('sandbox products of an IDC come from v2, priced from the gmi.sandbox.* SKUs; unavailable ones are not entitled', async () => {
    const { catalog } = await setup();
    const c = await catalog.getCatalog({ idc: 'us-central-iowa2' });
    const sb = c.offers.filter((o) => o.kind === 'sandbox' && o.idc === 'us-central-iowa2');
    expect(sb.map((o) => [o.sku, o.listUsdPerHour, o.entitled])).toEqual(
      expect.arrayContaining([
        ['gmi.sandbox.small', 0.0911, true],
        ['gmi.sandbox.large', 0.36, false],
      ]),
    );
    expect(c.templates.filter((tp) => tp.kind === 'sandbox').map((tp) => tp.idc)).toEqual(['us-central-iowa2', 'us-central-iowa2']);
  });

  it('account sources are re-read only after 5 minutes (or on refresh)', async () => {
    let now = Date.parse('2026-11-02T10:00:00Z');
    const { catalog, calls } = await setup({ now: () => new Date(now) });
    await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    expect(calls.products).toBe(1);
    now += 6 * 60_000;
    await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    expect(calls.products).toBe(2);
    await catalog.getCatalog({ idc: 'asia-east-taiwan3', refresh: true });
    expect(calls.products).toBe(3);
  });

  it('removing the key drops the account data at once', async () => {
    const { catalog, keys } = await setup();
    await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    keys.setKey(null);
    await new Promise((r) => setTimeout(r, 10));
    const c = catalog.snapshot();
    expect(c.scope).toBe('public');
    expect(c.offers.every((o) => o.sku === null)).toBe(true);
    expect(c.sources.accountProducts.state).toBe('skipped');
  });

  it('not entitled: account sources are errors, the public catalog still works', async () => {
    const { catalog } = await setup({ flags: ['not_entitled'] });
    const c = await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    expect(c.sources.accountProducts).toMatchObject({ state: 'error' });
    expect(c.sources.accountProducts.error).toMatch(/does not have access/);
    expect(c.offers.find((o) => o.idc === 'asia-east-taiwan3')?.sku).toBeNull();
  });
});

describe('sources keep their last good data (D7)', () => {
  it('a failing feed after a good one → stale with the old data; never fetched → error', async () => {
    let fail = false;
    const sim = createMockCompute({ flags: new Set(), installTag: 'abcdef', installLabel: 'x' });
    const { catalog } = await setup({
      key: null,
      publicApi: {
        billingProducts: async (dc) => {
          if (fail) throw new GmiError('upstream', 'down');
          return sim.publicApi.billingProducts(dc);
        },
        publicTemplates: async () => {
          throw new GmiError('network', 'offline');
        },
      },
    });
    await catalog.getCatalog();
    fail = true;
    const c = await catalog.getCatalog({ refresh: true });
    expect(c.sources.publicProducts).toMatchObject({ state: 'stale', error: 'down' });
    expect(c.offers.length).toBeGreaterThan(0);
    expect(c.sources.publicTemplates).toMatchObject({ state: 'error', fetchedAt: null });
  });

  it('offline: an unforced refresh is not re-attempted within 60 s; a forced one always is', async () => {
    let now = Date.parse('2026-11-02T10:00:00Z');
    const { catalog, calls } = await setup({
      key: null,
      now: () => new Date(now),
      publicApi: {
        billingProducts: async () => {
          throw new GmiError('network', 'offline');
        },
      },
    });
    await catalog.getCatalog();
    await catalog.getCatalog();
    expect(calls.feed).toBe(1);
    now += 61_000;
    await catalog.getCatalog();
    expect(calls.feed).toBe(2);
    await catalog.getCatalog({ refresh: true });
    expect(calls.feed).toBe(3);
  });

  it('serves the cache at once and refreshes stale feeds in the background', async () => {
    const first = await setup({ key: null });
    await first.catalog.getCatalog();
    const dataDir = first.deps.dataDir;
    // A second run over the same data dir: the cache answers without waiting for the network.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = createComputeCatalog({
      ...first.deps,
      dataDir,
      publicApi: {
        idcs: async () => (await gate, first.sim.publicApi.idcs()),
        billingProducts: async (dc) => (await gate, first.sim.publicApi.billingProducts(dc)),
        publicTemplates: async () => (await gate, first.sim.publicApi.publicTemplates()),
      },
    });
    await slow.load();
    const c = await slow.getCatalog();
    expect(c.offers.length).toBeGreaterThan(0);
    expect(c.sources.publicProducts.state).toBe('stale');
    expect(slow.price('gmi.sandbox.small').source).toBe('cached');
    release();
    await slow.refreshPublic();
    expect(slow.snapshot().sources.publicProducts.state).toBe('ok');
    expect(slow.price('gmi.sandbox.small').source).toBe('public_feed');
  });
});

describe('cache file', () => {
  it('holds no description, credential or customer row, and reads back defensively', async () => {
    const { catalog, deps } = await setup();
    await catalog.getCatalog({ idc: 'asia-east-taiwan3' });
    const text = await readFile(join(deps.dataDir, COMPUTE_DATA_FILES.catalog), 'utf8');
    expect(text).not.toMatch(/"description":"(?!JupyterLab|OpenAI|SGLang|A plain)/);
    expect(text).not.toMatch(/credential|secret|password/i);
    const parsed = readCatalogCache(JSON.parse(text));
    expect(parsed.publicProducts?.items.length).toBeGreaterThan(0);
    expect(readCatalogCache({ version: 99 }).publicProducts).toBeNull();
    expect(readCatalogCache({ version: 1, publicProducts: { at: 'nope', items: [] } }).publicProducts).toBeNull();
    expect(readCatalogCache({ version: 1, publicProducts: { at: '2026-11-02T00:00:00Z', items: [{ sku: 1 }, { sku: 'gmi.sandbox.small', idc: 'x', kind: 'sandbox' }] } }).publicProducts?.items).toHaveLength(1);
    expect(readCatalogCache(null).idcs).toBeNull();
  });
});

describe('PriceBook', () => {
  it('prices by SKU and IDC, EIP SKUs too; unknown SKUs are null', async () => {
    const { catalog } = await setup({ key: null });
    await catalog.getCatalog();
    expect(catalog.price('gmi.container.nv.H200x1.tw3', 'asia-east-taiwan3')).toMatchObject({ usdPerHour: 3.35, source: 'public_feed' });
    expect(catalog.price('gmi.sandbox.small').usdPerHour).toBeCloseTo(0.0911);
    expect(catalog.price('gmi.eip.sole.shared', 'asia-east-taiwan3').usdPerHour).toBe(0.1);
    expect(catalog.price('gmi.container.nv.B200x1.nowhere')).toMatchObject({ usdPerHour: null, fetchedAt: null });
    expect(catalog.eipSku('asia-east-taiwan3')).toEqual({ sku: 'gmi.eip.sole.shared', usdPerHour: 0.1 });
    expect(catalog.eipSku('us-central-iowa2')).toBeNull();
  });

  it('a SKU priced only in other IDCs takes the highest of those prices (a conservative guess)', () => {
    const hits = [
      { idc: 'a', usdPerHour: 1 },
      { idc: 'b', usdPerHour: 3 },
    ];
    expect(pickPrice(hits, 'a')).toBe(1);
    expect(pickPrice(hits, 'c')).toBe(3);
    expect(pickPrice(hits, null)).toBe(3);
    expect(pickPrice([], 'a')).toBeNull();
  });
});
