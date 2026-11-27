// C1-C: public access (§6.3). CIDR rules enforced in main, the EIP/firewall saga (checked by GET, never retried, a
// failure leaves the container and raises an alarm), and the teardown order.
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { checkAccess, checkCidr, inboundRules, replaceFirewallCidr, runNetworkSaga, teardownContainer, type NetworkDeps } from '@main/services/compute/ce/network';
import { json } from './fakes';
import { httpEnv, rec, type HttpEnv } from './lifecycle-harness';

let env: HttpEnv;
afterEach(async () => env?.cleanup());

describe('CIDR rules', () => {
  it('a /32 is not open; anything broader is open; 0.0.0.0/0 is All Open', () => {
    expect(checkCidr('203.0.113.7')).toEqual({ cidr: '203.0.113.7/32', prefix: 32, open: false, allOpen: false });
    expect(checkCidr(' 203.0.113.0/24 ')).toMatchObject({ open: true, allOpen: false });
    expect(checkCidr('0.0.0.0/0')).toMatchObject({ open: true, allOpen: true });
  });

  it.each(['127.0.0.1/32', '169.254.10.1', '224.0.0.0/4', '240.0.0.1', '0.1.2.3/32', '0.0.0.0/8', '10.0.0.1/33', '256.1.1.1', '::1', '2001:db8::/32', '203.0.113.7/24', '01.2.3.4', 'example.com'])(
    '%s is refused',
    (cidr) => {
      expect(() => checkCidr(cidr)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    },
  );

  it("['0.0.0.0/0'] is open even when the renderer says allOpen: false (the flag is ignored)", () => {
    expect(checkAccess(['0.0.0.0/0'])).toMatchObject({ open: true, allOpen: true });
    expect(checkAccess(['203.0.113.7/32'])).toMatchObject({ open: false });
    expect(() => checkAccess([])).toThrow();
  });

  it('one TCP rule per (CIDR, port)', () => {
    expect(inboundRules(['203.0.113.7/32'], [22, 8888])).toEqual([
      { protocol: 'tcp', portRange: { min: 22, max: 22 }, remoteIpPrefix: '203.0.113.7/32' },
      { protocol: 'tcp', portRange: { min: 8888, max: 8888 }, remoteIpPrefix: '203.0.113.7/32' },
    ]);
  });
});

const B = 'https://console.gmicloud.ai/api/v1';
const NAME = 'gmid-abcdef-cr_box-q1w2e3';

async function setup(routes: Parameters<typeof httpEnv>[0]) {
  env = await httpEnv(routes);
  await env.registry.add(rec({ id: 'cr_box', remoteId: 'c-1', name: NAME, phase: 'running' }));
  await env.journal.append({ rid: 'cr_box', kind: 'container', backend: 'ce', name: NAME, displayName: 'box', idc: 'asia-east-taiwan3', sku: 'gmi.container.nv.H200x1.tw3', at: new Date().toISOString(), network: { cidrs: ['203.0.113.7/32'], tcpPorts: [22], eipSku: 'gmi.eip.sole.shared', state: 'pending', step: 1 } });
  await env.journal.update('cr_box', { state: 'confirmed', remoteId: 'c-1' });
  const deps: NetworkDeps = { ce: env.ce, registry: env.registry, journal: env.journal, alarms: env.alarms, prices: env.prices, log: silentLogger, sleep: env.sleep.sleep };
  return deps;
}

const calls = () => env.fake.requests.map((r) => `${r.method} ${r.url.replace(B, '').replace(/\?.*$/, '')}`);

describe('saga', () => {
  it('allocates, associates, creates and associates in order; plan done; managed ids recorded', async () => {
    const eips: Array<Record<string, unknown>> = [];
    const deps = await setup([
      { match: `${B}/elastic-ips`, method: 'GET', respond: () => json(eips) },
      {
        match: `${B}/elastic-ips`,
        method: 'POST',
        respond: (req) => {
          if (req.url.endsWith('/associate')) {
            Object.assign(eips[0] ?? {}, { instanceID: 'c-1', status: 'associated' });
            return json({});
          }
          eips.push({ id: 'e-1', name: `${NAME}-eip`, ipAddress: '203.0.113.10', status: 'disassociated', idc: 'asia-east-taiwan3', product: 'gmi.eip.sole.shared' });
          return json([{ id: 'e-1' }]);
        },
      },
      { match: `${B}/firewalls`, method: 'GET', respond: () => json([]) },
      { match: /\/firewalls\/fw-1\/associate$/, method: 'POST', respond: () => json({}) },
      { match: `${B}/firewalls`, method: 'POST', respond: (req) => json({ id: 'fw-1', ...JSON.parse(req.body ?? '{}'), assoContainers: [] }) },
    ]);
    expect(await runNetworkSaga(deps, 'cr_box')).toBe('done');
    expect(calls()).toEqual([
      'GET /elastic-ips',
      'POST /elastic-ips',
      'GET /elastic-ips',
      'POST /elastic-ips/e-1/associate',
      'GET /firewalls',
      'POST /firewalls',
      'POST /firewalls/fw-1/associate',
    ]);
    const fwBody = JSON.parse(env.fake.requests.find((r) => r.method === 'POST' && r.url.endsWith('/firewalls'))?.body ?? '{}');
    expect(fwBody).toMatchObject({ name: `${NAME}-fw`, inboundRules: [{ protocol: 'tcp', portRange: { min: 22, max: 22 }, remoteIpPrefix: '203.0.113.7/32' }] });
    const r = env.registry.get('cr_box');
    expect(r?.network?.eip).toMatchObject({ id: 'e-1', managed: true, status: 'associated', address: '203.0.113.10' });
    expect(r?.network?.firewalls[0]).toMatchObject({ id: 'fw-1', managed: true });
    expect(env.journal.get('cr_box')?.network).toMatchObject({ state: 'done', step: 5 });
  });

  it('an EIP that a previous attempt allocated is reused (checked by name first): no second allocate', async () => {
    const deps = await setup([
      { match: `${B}/elastic-ips`, method: 'GET', respond: () => json([{ id: 'e-old', name: `${NAME}-eip`, ipAddress: '203.0.113.10', status: 'associated', instanceID: 'c-1', idc: 'x', product: 'gmi.eip.sole.shared' }]) },
      { match: `${B}/firewalls`, method: 'GET', respond: () => json([{ id: 'fw-old', name: `${NAME}-fw`, idc: 'x', inboundRules: [], assoContainers: ['c-1'] }]) },
    ]);
    expect(await runNetworkSaga(deps, 'cr_box')).toBe('done');
    expect(env.fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('a failure at step 3 → container kept, network degraded, eip_unattached alarm with the price; never retried', async () => {
    const deps = await setup([
      { match: `${B}/elastic-ips`, method: 'GET', respond: () => json([{ id: 'e-1', name: `${NAME}-eip`, ipAddress: '203.0.113.10', status: 'disassociated', idc: 'x', product: 'gmi.eip.sole.shared' }]) },
      { match: /associate$/, method: 'POST', respond: () => json({ reason: 'internal' }, 500) },
    ]);
    expect(await runNetworkSaga(deps, 'cr_box')).toBe('degraded');
    expect(env.registry.get('cr_box')?.network?.degraded).toBe(true);
    expect(env.registry.get('cr_box')?.phase).toBe('running');
    // Keyed by the EIP (as the sweep's alarm), so Release acts on the EIP and one EIP is one alarm.
    expect(env.alarms.byKind('eip_unattached')[0]).toMatchObject({ resourceId: 'e-1', usdPerHour: 0.1 });
    expect(env.alarms.byKind('eip_unattached')[0]?.actions).toContain('release_eip');
    expect(env.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(env.fake.requests.some((r) => r.method === 'DELETE')).toBe(false);
    // Not pending any more: a second run does nothing.
    expect(await runNetworkSaga(deps, 'cr_box')).toBe('degraded');
    expect(env.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('a failure at step 5 → degraded + alarm, the EIP stays attached', async () => {
    const deps = await setup([
      { match: `${B}/elastic-ips`, method: 'GET', respond: () => json([{ id: 'e-1', name: `${NAME}-eip`, ipAddress: '203.0.113.10', status: 'associated', instanceID: 'c-1', idc: 'x', product: 'gmi.eip.sole.shared' }]) },
      { match: `${B}/firewalls`, method: 'GET', respond: () => json([{ id: 'fw-1', name: `${NAME}-fw`, idc: 'x', inboundRules: [], assoContainers: [] }]) },
      { match: /\/firewalls\/fw-1\/associate$/, method: 'POST', respond: () => new Response('<html>bad gateway</html>', { status: 502 }) },
    ]);
    expect(await runNetworkSaga(deps, 'cr_box')).toBe('degraded');
    expect(env.alarms.byKind('api_unavailable')[0]).toMatchObject({ resourceId: 'cr_box', severity: 'warning' });
    expect(env.journal.get('cr_box')?.network).toMatchObject({ state: 'degraded', step: 4 });
  });

  it('waits for running: nothing happens while the container is creating', async () => {
    const deps = await setup([]);
    await env.registry.update('cr_box', (r) => ({ ...r, phase: 'creating' }));
    expect(await runNetworkSaga(deps, 'cr_box')).toBe('pending');
    expect(env.fake.requests).toHaveLength(0);
  });
});

describe('teardown', () => {
  it('order: disassociate firewall → disassociate EIP → DELETE → poll until 404 → release EIP → delete firewall', async () => {
    let gets = 0;
    const deps = await setup([
      { match: /\/containers\/c-1$/, method: 'GET', respond: () => (++gets < 3 ? json({ id: 'c-1', name: NAME, status: 'terminating', storages: [] }) : json({ reason: 'container not found' }, 404)) },
      { match: /\/containers\/c-1$/, method: 'DELETE', respond: () => json({ result: 'ok' }) },
      { match: `${B}/firewalls`, method: 'GET', respond: () => json([{ id: 'fw-1', name: `${NAME}-fw`, idc: 'x', inboundRules: [], assoContainers: [], assoInstances: [] }]) },
      { match: /./, method: 'POST', respond: () => json({}) },
      { match: /./, method: 'DELETE', respond: () => json({}) },
    ]);
    await env.registry.update('cr_box', (r) => ({
      ...r,
      network: { publicIp: '203.0.113.10', eip: { id: 'e-1', address: '203.0.113.10', managed: true, status: 'associated' }, firewalls: [{ id: 'fw-1', name: `${NAME}-fw`, managed: true, preset: false, rules: [] }], ports: [], degraded: false },
    }));
    const { settled } = await teardownContainer(deps, env.registry.get('cr_box') as never, { releaseEip: true, deleteFirewall: true });
    await settled;
    expect(calls()).toEqual([
      'POST /firewalls/fw-1/disassociate',
      'POST /elastic-ips/e-1/disassociate',
      'DELETE /containers/c-1',
      'GET /containers/c-1',
      'GET /containers/c-1',
      'GET /containers/c-1',
      'DELETE /elastic-ips/e-1',
      'GET /firewalls',
      'DELETE /firewalls/fw-1',
    ]);
    expect(env.sleep.delays).toEqual([5_000, 5_000]);
    expect(env.registry.get('cr_box')?.network?.eip?.status).toBe('released');
  });

  it('without "release": the managed EIP is kept (no release call); unmanaged firewalls are never touched', async () => {
    const deps = await setup([
      { match: /\/containers\/c-1$/, method: 'GET', respond: () => json({ reason: 'not found' }, 404) },
      { match: /./, method: 'POST', respond: () => json({}) },
      { match: /./, method: 'DELETE', respond: () => json({}) },
    ]);
    await env.registry.update('cr_box', (r) => ({
      ...r,
      network: { publicIp: null, eip: { id: 'e-1', address: null, managed: true, status: 'associated' }, firewalls: [{ id: 'fw-preset', name: 'All Open', managed: false, preset: true, rules: [] }], ports: [], degraded: false },
    }));
    const { settled } = await teardownContainer(deps, env.registry.get('cr_box') as never, { releaseEip: false, deleteFirewall: true });
    await settled;
    expect(calls()).toEqual(['POST /elastic-ips/e-1/disassociate', 'DELETE /containers/c-1', 'GET /containers/c-1']);
  });

  it('"Update to my IP" replaces the source CIDR of the managed firewall rules (PUT keeps name and ports)', async () => {
    await setup([
      { match: `${B}/firewalls`, method: 'GET', respond: () => json([{ id: 'fw-1', name: `${NAME}-fw`, idc: 'x', inboundRules: [{ protocol: 'tcp', portRange: { min: 22, max: 22 }, remoteIpPrefix: '198.51.100.4/32' }] }]) },
      { match: /\/firewalls\/fw-1$/, method: 'PUT', respond: () => json({}) },
    ]);
    await env.registry.update('cr_box', (r) => ({ ...r, network: { publicIp: null, eip: null, firewalls: [{ id: 'fw-1', name: `${NAME}-fw`, managed: true, preset: false, rules: [] }], ports: [], degraded: false } }));
    const updated = await replaceFirewallCidr({ ce: env.ce, registry: env.registry }, env.registry.get('cr_box') as never, '203.0.113.7/32');
    const put = env.fake.requests.find((r) => r.method === 'PUT');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ name: `${NAME}-fw`, inboundRules: [{ protocol: 'tcp', portRange: { min: 22, max: 22 }, remoteIpPrefix: '203.0.113.7/32' }] });
    expect(updated.network?.firewalls[0]?.rules[0]).toMatchObject({ cidr: '203.0.113.7/32', fromPort: 22 });
  });
});
