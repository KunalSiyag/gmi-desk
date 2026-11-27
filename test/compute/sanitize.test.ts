// C1-B: the sanitiser rules of compute.md §5.2 — one test per rule.
import { describe, expect, it } from 'vitest';
import type { CeContainer } from '@main/services/compute/ce/dto';
import {
  PUBLIC_ROW_DENY,
  feedPriceIndex,
  filterPublicProducts,
  isPublicSkuAllowed,
  microUsdToUsd,
  publicSkuKind,
  redactContainer,
  redactContainers,
  redactSandboxTemplate,
  redactTemplate,
  scrubForTrace,
} from '@main/services/compute/sanitize';

const row = (over: Record<string, unknown>) => ({
  id: 'x',
  instanceType: 'gmi.container.nv.H200x1.tw3',
  dataCenter: 'asia-east-taiwan3',
  price: 3_350_000,
  valid: true,
  productName: 'Container',
  gpuModel: 'H200',
  attributes: { gpu_count: 1 },
  spec: { name: '1x H200', basic: [{ name: 'CPU', qty: '24' }, { name: 'Memory', qty: '220', unit: 'GiB' }, { name: 'Disk', qty: '2', unit: 'TiB' }] },
  ...over,
});

describe('rule 1: descriptions only filter, never kept', () => {
  it.each([
    ['Acme Corp only'],
    ['for IE team'],
    ['for the research team only'],
    ['internal benchmark'],
    ['load test'],
    ['POC for customer'],
    ['free trial'],
  ])('drops a row whose description is %j', (description) => {
    expect(filterPublicProducts({ products: [row({ description })] })).toEqual([]);
  });

  it('drops a row whose name matches, and every row with valid !== true', () => {
    expect(filterPublicProducts({ products: [row({ instanceType: 'gmi.container.nv.H200x1.internal' })] })).toEqual([]);
    expect(filterPublicProducts({ products: [row({ spec: { name: 'POC box' } })] })).toEqual([]);
    for (const valid of [false, undefined, 'true', 1]) expect(filterPublicProducts({ products: [row({ valid })] })).toEqual([]);
  });

  it('keeps a clean row without its description (not even an empty one)', () => {
    const out = filterPublicProducts({ products: [row({ description: 'General availability, Taiwan' })] });
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('General availability');
    expect(Object.keys(out[0] as object)).not.toContain('description');
    expect(out[0]).toMatchObject({ sku: 'gmi.container.nv.H200x1.tw3', idc: 'asia-east-taiwan3', kind: 'container', usdPerHour: 3.35, gpuModel: 'H200', gpuCount: 1, vcpu: 24, memoryGiB: 220, diskGiB: 2048 });
  });

  it('the deny pattern is exactly the documented one', () => {
    expect(PUBLIC_ROW_DENY.source).toBe('\\bonly\\b|\\bfor\\b.*\\bteam\\b|internal|test|poc|trial');
    expect(PUBLIC_ROW_DENY.flags).toContain('i');
  });
});

describe('rule 2: SKU allowlist', () => {
  it.each([
    ['gmi.container.nv.H200x8.tw3', 'container'],
    ['gmi.container.intel.x4660.large', 'container'],
    ['gmi.container.amd.MI300x1.us', 'container'],
    ['gmi.sandbox.small', 'sandbox'],
    ['gmi.eip.sole.shared', 'eip'],
    ['gmi.sole.shared', 'eip'],
  ])('allows %s', (sku, kind) => {
    expect(isPublicSkuAllowed(sku)).toBe(true);
    expect(publicSkuKind(sku)).toBe(kind);
  });
  it.each([['gmi.bm.nh2.normal'], ['gmi.mgcs.node.h200'], ['acme.container.nv.H200x1'], ['gmi.container.arm.x1'], ['credit'], ['GMI.CONTAINER.NV.H200X1']])('drops %s', (sku) => {
    expect(isPublicSkuAllowed(sku)).toBe(false);
    expect(filterPublicProducts({ products: [row({ instanceType: sku })] })).toEqual([]);
  });
});

describe('feed parsing', () => {
  it('micro-USD → USD; odd prices are unknown, not zero', () => {
    expect(microUsdToUsd(91_100)).toBeCloseTo(0.0911);
    expect(microUsdToUsd(-1)).toBeNull();
    expect(microUsdToUsd('3350000')).toBeNull();
    expect(filterPublicProducts({ products: [row({ price: null })] })[0]?.usdPerHour).toBeNull();
  });
  it('GPU from the SKU when attributes are missing; CPU-only has no GPU; sandbox size from the SKU', () => {
    const [h] = filterPublicProducts({ products: [row({ instanceType: 'gmi.container.nv.H100x8.tw1', attributes: {}, gpuModel: '' })] });
    expect(h).toMatchObject({ gpuModel: 'H100', gpuCount: 8 });
    const [cpu] = filterPublicProducts({ products: [row({ instanceType: 'gmi.container.intel.x4660.large', gpuModel: 'CPU-only', attributes: { gpu_count: 0 } })] });
    expect(cpu).toMatchObject({ gpuModel: null, gpuCount: 0 });
    const [sb] = filterPublicProducts({ products: [row({ instanceType: 'gmi.sandbox.x_small', productName: 'Sandbox', gpuModel: '' })] });
    expect(sb).toMatchObject({ kind: 'sandbox', sizeLabel: 'X_SMALL', gpuCount: 0 });
  });
  it('malformed rows are skipped, not thrown on', () => {
    expect(filterPublicProducts({ products: [null, 3, {}, { instanceType: 'gmi.sandbox.small' }, row({})] })).toHaveLength(1);
    expect(filterPublicProducts(null)).toEqual([]);
    expect(filterPublicProducts([row({})])).toHaveLength(1);
  });
  it('the price index holds only sku / idc / price (for the org\'s own SKUs), never descriptions', () => {
    const index = feedPriceIndex({ products: [row({ instanceType: 'gmi.container.nv.H200x1.acme', description: 'Acme only', price: 3_000_000 })] });
    expect(index.get('gmi.container.nv.H200x1.acme')).toEqual([{ idc: 'asia-east-taiwan3', usdPerHour: 3 }]);
    expect(JSON.stringify([...index])).not.toContain('Acme only');
  });
});

describe('rule 5: templates', () => {
  it('credential removed entirely; description kept only for official templates', () => {
    const official = redactTemplate({ id: 't1', official: true, name: 'JupyterLab', path: 'docker.io/x/y:v2', description: 'Notebook', credential: { username: 'u', secret: 'REGISTRY-PASSWORD' } });
    expect(JSON.stringify(official)).not.toContain('REGISTRY-PASSWORD');
    expect(official).toMatchObject({ official: true, description: 'Notebook', sshReady: true, image: 'docker.io/x/y:v2' });
    expect(official?.defaultPorts.map((p) => p.port)).toEqual([22, 8888]);
    const org = redactTemplate({ id: 't2', official: false, name: 'mine', path: 'r/x:1', description: 'Contains customer notes', credential: { username: 'bot', secret: 'S3CR3T' } });
    expect(org?.description).toBeNull();
    expect(JSON.stringify(org)).not.toMatch(/S3CR3T|customer notes|bot/);
  });
  it('sandbox templates: no description; only ready ones', () => {
    expect(redactSandboxTemplate({ id: 'a', name: 'py', idc_name: 'us-central-iowa2', status: 'ready', description: 'secret plan' })).toMatchObject({ kind: 'sandbox', idc: 'us-central-iowa2', description: null });
    expect(redactSandboxTemplate({ id: 'a', name: 'py', status: 'building' })).toBeNull();
  });
});

describe('rule 6: resource responses', () => {
  const container: CeContainer = {
    id: 'c1',
    name: 'gmid-abcdef-box-q1w2e3',
    idc: 'asia-east-taiwan3',
    product: 'gmi.container.nv.H200x1.tw3',
    templateId: 't1',
    status: 'running',
    reason: '',
    storages: [],
    envs: [
      { name: 'HF_TOKEN', value: 'hf_SECRETVALUE' },
      { name: 'SSH_KEY', value: 'ssh-ed25519 AAAA...' },
    ],
  };
  it('env values are removed; only names remain', () => {
    const safe = redactContainer(container);
    expect(safe.envNames).toEqual(['HF_TOKEN', 'SSH_KEY']);
    expect(JSON.stringify(safe)).not.toMatch(/hf_SECRETVALUE|ssh-ed25519/);
    expect('envs' in safe).toBe(false);
  });
  it('`traces` never survive; malformed list items are dropped', () => {
    const safe = redactContainers([{ ...container, traces: ['internal'] }, null, { id: 3 }]);
    expect(safe).toHaveLength(1);
    expect(JSON.stringify(safe)).not.toContain('internal');
  });
});

describe('trace scrub (§17)', () => {
  it('drops descriptions, credentials, tokens, urlPath and env values; keeps names', () => {
    const scrubbed = scrubForTrace({
      products: [{ instanceType: 'gmi.sandbox.small', description: 'Acme only' }],
      credential: { secret: 'pw' },
      sandbox_access_token: 'sat-123',
      traffic_access_token: 'tat-456',
      connect_url: '/shell/connect',
      urlPath: '/ws?token=abc',
      envs: [{ name: 'A', value: 'v1' }],
      env_vars: { B: 'v2' },
      traces: ['t'],
    });
    const text = JSON.stringify(scrubbed);
    for (const s of ['Acme only', '"pw"', 'sat-123', 'tat-456', '/shell/connect', 'token=abc', 'v1', 'v2', '"t"']) expect(text).not.toContain(s);
    expect(scrubbed).toMatchObject({ envNames: ['A'], env_var_names: ['B'] });
  });
});
