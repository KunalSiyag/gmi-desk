// C1-C: the compute API (service.ts) over the mock simulators, the real catalog, a scriptable guard and FakePlatform.
// Main validates and is authoritative; every billing start or loosening shows a NATIVE confirmation (FakePlatform
// `confirms`); secrets never reach a resource; unmanaged resources are read-only until adopted. Also: the slice entry
// (index.ts) in mock mode never fetches anything.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import type { ContainerCreateSpec, SandboxCreateSpec } from '@shared/contracts/compute';
import { silentLogger } from '@main/core/logger';
import type { AuthService } from '@main/core/services';
import { createMockCompute, mockComputeFlags, mockComputeScenario } from '@main/mock/compute';
import { MOCK_BUDGET } from '@main/mock/usage';
import { createComputeCatalog } from '@main/services/compute/catalog';
import { createUnavailableComputeKeys } from '@main/services/auth/compute-keys';
import { createComputeSlice } from '@main/services/compute';
import { createJournal, type Journal } from '@main/services/compute/journal';
import { installLabel, installTag } from '@main/services/compute/names';
import { createRegistry } from '@main/services/compute/registry';
import { createComputeService, createSecretScreen, type ComputeServiceInstance } from '@main/services/compute/service';
import { createServerClock, createSupervisor } from '@main/services/compute/supervisor';
import { createSweeper } from '@main/services/compute/sweep';
import type { Registry } from '@main/services/compute/types';
import { createBudgetService } from '@main/services/usage/budget';
import { openSpendLedger } from '@main/services/usage/ledger';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeComputeKeys } from './fakes';
import { fakeAlarms, fakeGuard, type FakeAlarms, type FakeGuard } from './lifecycle-harness';

let t: TestContext;
afterEach(async () => t?.cleanup());

const COMPUTE_KEY = 'ck-compute-key-secret-000000000001';
const INFERENCE_KEY = 'ie-inference-key-secret-0000000001';
const ACCESS_TOKEN = 'oat-oauth-access-token-0000000001';

function fakeAuth(): AuthService {
  return { getState: () => ({}) as AuthState, isSignedIn: () => true, onChange: () => () => undefined };
}

interface Env {
  svc: ComputeServiceInstance;
  registry: Registry;
  journal: Journal;
  alarms: FakeAlarms;
  guard: FakeGuard;
  mock: ReturnType<typeof createMockCompute>;
  confirms: () => string[];
  advance(ms: number): void;
  keys: ReturnType<typeof fakeComputeKeys>;
  tag: string;
}

async function setup(flags: string[] = []): Promise<Env> {
  t = await createTestContext({ mock: true });
  await t.ctx.secure.set('inference.key', INFERENCE_KEY);
  await t.ctx.secure.set('oauth.tokens', JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: null, expires_at: null, scope: 'models:read', token_type: 'Bearer' }));
  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const tag = installTag(t.ctx.installId);
  const label = installLabel(t.ctx.installId);
  const mock = createMockCompute({ flags: new Set(flags), installTag: tag, installLabel: label, now });
  const keys = fakeComputeKeys(COMPUTE_KEY);
  const catalog = createComputeCatalog({ dataDir: t.ctx.paths.data, log: silentLogger, keys, publicApi: mock.publicApi, ce: mock.ce, sandbox: mock.sandbox, now });
  await catalog.load();
  const registry = createRegistry({ dataDir: t.ctx.paths.data, log: silentLogger, now });
  const journal = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger, now });
  await Promise.all([registry.load(), journal.load()]);
  const clock = createServerClock(now);
  const supervisor = createSupervisor({ registry, log: silentLogger, keys, ce: mock.ce, sandbox: mock.sandbox, clock });
  const alarms = fakeAlarms(now);
  const guard = fakeGuard(alarms, catalog);
  // Sleeping moves the simulators' clock (no real waiting, no busy loop).
  const sleep = {
    sleep: async (ms: number) => {
      offset += ms;
      await new Promise((r) => setImmediate(r));
    },
  };
  const createDeps = { ce: mock.ce, registry, journal, alarms, prices: catalog, supervisor, log: silentLogger, sleep: sleep.sleep };
  const lifecycleDeps = { sandbox: mock.sandbox, tokens: mock.tokens, dataPlane: mock.dataPlane, registry, journal, alarms, prices: catalog, supervisor, log: silentLogger, sleep: sleep.sleep };
  const sweeper = createSweeper({ ce: mock.ce, sandbox: mock.sandbox, registry, journal, alarms, prices: catalog, supervisor, log: silentLogger, installTag: tag, installLabel: label, createDeps, lifecycleDeps });
  const svc = createComputeService({
    core: { platform: t.platform, log: silentLogger, installId: t.ctx.installId, mock: true, now },
    keys,
    auth: fakeAuth(),
    catalog,
    ce: mock.ce,
    sandbox: mock.sandbox,
    dataPlane: mock.dataPlane,
    tokens: mock.tokens,
    registry,
    journal,
    supervisor,
    guard,
    sweeper,
    secrets: createSecretScreen({ secure: t.ctx.secure, keys, env: {} }),
    detectIp: async () => ({ ip: '203.0.113.7', service: 'api.ipify.org' }),
    sleep: sleep.sleep,
  });
  return {
    svc,
    registry,
    journal,
    alarms,
    guard,
    mock,
    tag,
    keys,
    confirms: () => t.platform.confirms.map((c) => c.title),
    advance(ms) {
      offset += ms;
    },
  };
}

const containerSpec = (over: Partial<ContainerCreateSpec> = {}): ContainerCreateSpec => ({
  kind: 'container',
  displayName: 'train box',
  idc: 'asia-east-taiwan3',
  sku: 'gmi.container.nv.H200x1.tw3',
  templateId: '00000000-0000-4000-8000-00000000a001',
  env: [{ name: 'HF_TOKEN', value: 'hf_user_value', secret: true }, { name: 'MODE', value: 'train', secret: false }],
  ssh: { mode: 'none' },
  access: { mode: 'none' },
  lease: { maxLifetimeMin: 240, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' },
  ...over,
});

const sandboxSpec = (over: Partial<SandboxCreateSpec> = {}): SandboxCreateSpec => ({
  kind: 'sandbox',
  displayName: 'dev box',
  idc: 'us-central-iowa2',
  product: 'gmi.sandbox.small',
  source: { templateId: 'tpl-mock-python' },
  timeoutSec: 3600,
  onTimeout: 'pause',
  secure: true,
  egress: { mode: 'open' },
  purpose: 'computer',
  lease: { maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 20, extendOnActivity: true, onBudget: 'pause' },
  ...over,
});

describe('quoteCreate (validation in main)', () => {
  it('prices the spec, masks secret values and states that the budget will not stop a notify container', async () => {
    const e = await setup();
    const q = await e.svc.api.quoteCreate(containerSpec());
    expect(q.usdPerHour).toBe(3.35);
    expect(q.maxUsd).toBeCloseTo(13.4);
    expect(q.spec.kind === 'container' && q.spec.env).toEqual([
      { name: 'HF_TOKEN', value: '••••', secret: true },
      { name: 'MODE', value: 'train', secret: false },
    ]);
    expect(q.warnings).toContain('Your budget will not stop this container.');
    expect(JSON.stringify(q)).not.toContain('hf_user_value');
    expect(e.guard.assessed[0]).toMatchObject({ action: 'create', kind: 'container', hours: 4, gpu: true });
  });

  it.each([
    ['a bad name', containerSpec({ displayName: '-bad-' })],
    ['a 41-character name', containerSpec({ displayName: 'a'.repeat(41) })],
    ['pause for a container', containerSpec({ lease: { maxLifetimeMin: 240, onExpiry: 'pause', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' } })],
    ['a 5-minute lease', containerSpec({ lease: { maxLifetimeMin: 5, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' } })],
    ['6 ports', containerSpec({ ports: [1, 2, 3, 4, 5, 6].map((p) => ({ containerPort: p, protocol: 'TCP' as const })) })],
    ['port 65535', containerSpec({ ports: [{ containerPort: 65535, protocol: 'TCP' }] })],
    ['a bad env name', containerSpec({ env: [{ name: '1BAD', value: 'x', secret: false }] })],
    ['an env value over 64 KiB', containerSpec({ env: [{ name: 'BIG', value: 'x'.repeat(64 * 1024 + 1), secret: false }] })],
    ['65 env vars', containerSpec({ env: Array.from({ length: 65 }, (_, i) => ({ name: `V${i}`, value: 'x', secret: false })) })],
    ['a SKU the org cannot launch', containerSpec({ sku: 'gmi.container.nv.B200x1.tw3' })],
    ['an unknown template', containerSpec({ templateId: 'nope' })],
    ['an IDC that is full', containerSpec({ idc: 'asia-southeast-singapore2' })],
    ['a reserved CIDR', containerSpec({ access: { mode: 'public', allowCidrs: ['127.0.0.1/32'], tcpPorts: [22] } })],
    ['an IPv6 CIDR', containerSpec({ access: { mode: 'public', allowCidrs: ['2001:db8::/32'], tcpPorts: [22] } })],
    ['an app-made SSH key (not in C1)', containerSpec({ ssh: { mode: 'app_key' } })],
    ['an agent sandbox with open egress', sandboxSpec({ purpose: 'agent' })],
    ['a sandbox timeout of 30 s', sandboxSpec({ timeoutSec: 30 })],
  ])('refuses %s (invalid_input)', async (_label, spec) => {
    const e = await setup();
    await expect(e.svc.api.quoteCreate(spec)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('needs a Compute key (quote, create, snapshots, network)', async () => {
    const e = await setup();
    const q = await e.svc.api.quoteCreate(containerSpec());
    e.keys.setKey(null);
    await expect(e.svc.api.quoteCreate(containerSpec())).rejects.toMatchObject({ code: 'no_compute_key' });
    await expect(e.svc.api.create(q.quoteId)).rejects.toMatchObject({ code: 'no_compute_key' });
    await expect(e.svc.api.listSnapshots()).rejects.toMatchObject({ code: 'no_compute_key' });
    await expect(e.svc.api.getNetwork()).rejects.toMatchObject({ code: 'no_compute_key' });
    expect(e.confirms()).toEqual([]);
  });
});

describe('the secret-substring check (§6.1, T15)', () => {
  it.each([
    ['an env value holding the inference key', containerSpec({ env: [{ name: 'AUTH', value: `Bearer ${INFERENCE_KEY}`, secret: true }] }), 'Variable AUTH'],
    ['the command holding the compute key', containerSpec({ command: `curl -H "Authorization: ${COMPUTE_KEY}" x` }), 'The command'],
    ['an argument holding the OAuth access token', containerSpec({ args: ['--x', `{"token":"${ACCESS_TOKEN}"}`] }), 'Argument 2'],
    ['a sandbox env value holding the key with spaces around', sandboxSpec({ env: [{ name: 'K', value: `  ${INFERENCE_KEY}  `, secret: false }] }), 'Variable K'],
  ])('refuses %s, naming the field, never the value', async (_label, spec, field) => {
    const e = await setup();
    const err = await e.svc.api.quoteCreate(spec).catch((x: unknown) => x);
    expect(err).toMatchObject({ code: 'invalid_input' });
    expect(String((err as Error).message)).toContain(field);
    expect(String((err as Error).message)).not.toMatch(/ie-inference|ck-compute|oat-oauth/);
  });

  it('a JWT-shaped value only warns', async () => {
    const e = await setup();
    const q = await e.svc.api.quoteCreate(containerSpec({ env: [{ name: 'JWT', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4In0.c2lnbmF0dXJlc2ln', secret: true }] }));
    expect(q.warnings.some((w) => w.includes('JWT looks like an access token'))).toBe(true);
  });
});

describe('create (native confirmation, then exactly once)', () => {
  it('confirmed: one native dialog stating price, lease and budget behaviour; the container exists', async () => {
    const e = await setup();
    const before = (await e.mock.ce.listContainers()).length;
    const q = await e.svc.api.quoteCreate(containerSpec());
    const r = await e.svc.api.create(q.quoteId);
    expect(e.confirms()).toEqual(['Create container']);
    const dialog = t.platform.confirms[0];
    expect(dialog?.message).toMatch(/asia-east-taiwan3 · \$3\.35\/h list/);
    expect(r).toMatchObject({ managed: true, kind: 'container', phase: 'creating', displayName: 'train box' });
    expect(r.name).toMatch(new RegExp(`^gmid-${e.tag}-train-box-[a-z2-7]{6}$`));
    expect((await e.mock.ce.listContainers()).length).toBe(before + 1);
    expect(e.journal.get(r.id)?.state).toBe('confirmed');
    // Single use.
    await expect(e.svc.api.create(q.quoteId)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('declined → cancelled, nothing created, no journal entry', async () => {
    const e = await setup();
    t.platform.confirmAnswer = false;
    const before = (await e.mock.ce.listContainers()).length;
    const q = await e.svc.api.quoteCreate(containerSpec());
    await expect(e.svc.api.create(q.quoteId)).rejects.toMatchObject({ code: 'cancelled' });
    expect((await e.mock.ce.listContainers()).length).toBe(before);
    expect(e.journal.list()).toEqual([]);
  });

  it("allowCidrs ['0.0.0.0/0'] without allOpen still needs the native 'open' dialog; a /32 does not", async () => {
    const e = await setup();
    const open = await e.svc.api.quoteCreate(containerSpec({ access: { mode: 'public', allowCidrs: ['0.0.0.0/0'], tcpPorts: [22] } }));
    expect(open.spec.kind === 'container' && open.spec.access).toMatchObject({ mode: 'public', allOpen: true });
    await e.svc.api.create(open.quoteId);
    expect(e.confirms()).toEqual(['Create container', 'Open to the internet?']);
    expect(t.platform.confirms[1]?.message).toMatch(/All Open: anyone on the internet/);
    expect(t.platform.confirms[0]?.message).toBeTruthy();

    t.platform.confirms.length = 0;
    const mine = await e.svc.api.quoteCreate(containerSpec({ displayName: 'ssh box', access: { mode: 'public', allowCidrs: ['203.0.113.7/32'], tcpPorts: [22] } }));
    expect(mine.lines.map((l) => l.usdPerHour)).toEqual([3.35, 0.1]);
    await e.svc.api.create(mine.quoteId);
    expect(e.confirms()).toEqual(['Create container']);
    // The plan is journaled for the saga (CIDRs and ports only).
    const entry = e.journal.list().find((j) => j.displayName === 'ssh box');
    expect(entry?.network).toMatchObject({ cidrs: ['203.0.113.7/32'], tcpPorts: [22], eipSku: 'gmi.eip.sole.shared', state: 'pending' });
  });

  it('declining the open dialog cancels the whole create', async () => {
    const e = await setup();
    const q = await e.svc.api.quoteCreate(containerSpec({ access: { mode: 'public', allowCidrs: ['198.51.100.0/24'], tcpPorts: [22] } }));
    let n = 0;
    t.platform.confirm = async ({ title, message }) => {
      t.platform.confirms.push({ title, message });
      n += 1;
      return n === 1;
    };
    await expect(e.svc.api.create(q.quoteId)).rejects.toMatchObject({ code: 'cancelled' });
    expect(e.journal.list()).toEqual([]);
  });

  it('an insecure sandbox needs its own native dialog', async () => {
    const e = await setup();
    const q = await e.svc.api.quoteCreate(sandboxSpec({ secure: false }));
    await e.svc.api.create(q.quoteId);
    expect(e.confirms()).toEqual(['Create sandbox', 'Previews without a token?']);
  });

  it('a guard refusal (no daily budget, unknown price, over budget) stops create before any dialog', async () => {
    const e = await setup();
    const q = await e.svc.api.quoteCreate(containerSpec());
    e.guard.refusal = { code: 'invalid_input', message: 'Set a daily budget first.' };
    await expect(e.svc.api.create(q.quoteId)).rejects.toMatchObject({ code: 'invalid_input', message: 'Set a daily budget first.' });
    expect(e.confirms()).toEqual([]);
    // The quote itself shows the refusal first.
    const q2 = await e.svc.api.quoteCreate(containerSpec());
    expect(q2.warnings[0]).toBe('Set a daily budget first.');
  });

  it('a quote expires after 5 minutes', async () => {
    const e = await setup();
    const q = await e.svc.api.quoteCreate(containerSpec());
    e.advance(5 * 60_000 + 1);
    await expect(e.svc.api.create(q.quoteId)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(e.confirms()).toEqual([]);
  });

  it('"Try again" after an unclear create lists first, then asks natively before a second one', async () => {
    const e = await setup();
    await e.journal.append({ rid: 'cr_earlier', kind: 'container', backend: 'ce', name: `gmid-${e.tag}-train-box-aaaaaa`, displayName: 'train box', idc: 'asia-east-taiwan3', sku: 'gmi.container.nv.H200x1.tw3', at: new Date().toISOString(), network: null });
    await e.journal.update('cr_earlier', { state: 'failed_unknown' });
    const q = await e.svc.api.quoteCreate(containerSpec());
    const r = await e.svc.api.create(q.quoteId);
    expect(e.confirms()).toEqual(['Create another one?', 'Create container']);
    expect(t.platform.confirms[0]?.message).toContain(`gmid-${e.tag}-train-box-aaaaaa`);
    expect(r.name).not.toBe(`gmid-${e.tag}-train-box-aaaaaa`);
  });
});

describe('lifecycle actions and their native dialogs', () => {
  /** Creates one, then lets the simulator's 3 s `creating` pass and polls (unless `stayCreating`). */
  async function container(e: Env, stayCreating = false) {
    const q = await e.svc.api.quoteCreate(containerSpec());
    const r = await e.svc.api.create(q.quoteId);
    t.platform.confirms.length = 0;
    if (!stayCreating) {
      e.advance(5_000);
      await e.svc.api.refresh();
    }
    return r;
  }
  async function sandbox(e: Env) {
    const q = await e.svc.api.quoteCreate(sandboxSpec());
    const r = await e.svc.api.create(q.quoteId);
    t.platform.confirms.length = 0;
    e.advance(5_000);
    await e.svc.api.refresh();
    expect(e.registry.get(r.id)?.phase).toBe('running');
    return r;
  }

  it('delete: native; refused while creating; the container goes to deleting', async () => {
    const e = await setup();
    const r = await container(e, true);
    await expect(e.svc.api.delete(r.id)).rejects.toMatchObject({ code: 'conflict' });
    e.advance(5_000);
    await e.svc.api.refresh();
    const d = await e.svc.api.delete(r.id);
    expect(e.confirms()).toEqual(['Delete train box?']);
    expect(['deleting', 'deleted']).toContain(d.phase);
    // Teardown polls until GMI answers 404, then the record is a tombstone.
    await e.svc.idle();
    expect(e.registry.get(d.id)?.phase).toBe('deleted');
    expect(e.registry.list().some((x) => x.id === d.id)).toBe(false);
  });

  it('restart: no native dialog (billing does not change)', async () => {
    const e = await setup();
    const r = await container(e);
    const after = await e.svc.api.restart(r.id);
    expect(after.phase).toBe('busy');
    expect(e.confirms()).toEqual([]);
  });

  it('pause: no dialog; resume: native with the price', async () => {
    const e = await setup();
    const r = await sandbox(e);
    expect((await e.svc.api.pause(r.id)).phase).toBe('pausing');
    expect(e.confirms()).toEqual([]);
    e.advance(3_000);
    await e.svc.api.refresh();
    expect(e.registry.get(r.id)?.phase).toBe('paused');
    // Accrual stopped at GMI's paused_at.
    expect(e.registry.get(r.id)?.intervals.at(-1)?.to).not.toBeNull();
    const resumed = await e.svc.api.resume(r.id);
    expect(e.confirms()).toEqual(['Resume dev box?']);
    expect(t.platform.confirms[0]?.message).toMatch(/\$0\.0911\/h list/);
    expect(resumed.phase).toBe('resuming');
  });

  it('a paused sandbox whose lease ended: resume asks for an extend, extend works while paused (no GMI timeout call), then resume', async () => {
    const e = await setup();
    const r = await sandbox(e);
    await e.svc.api.pause(r.id);
    e.advance(3_000);
    await e.svc.api.refresh();
    await e.registry.update(r.id, (x) => ({ ...x, runningSince: new Date(Date.now() - 9 * 3600_000).toISOString() }));
    await expect(e.svc.api.resume(r.id)).rejects.toMatchObject({ code: 'invalid_input' });
    const before = (await e.mock.sandbox.get(e.registry.get(r.id)!.remoteId!)).end_at;
    await e.svc.api.extend(r.id, 60);
    expect((await e.mock.sandbox.get(e.registry.get(r.id)!.remoteId!)).end_at).toBe(before);
    t.platform.confirms.length = 0;
    expect((await e.svc.api.resume(r.id)).phase).toBe('resuming');
  });

  it('extend: inside the approved lease no dialog; beyond it a native one', async () => {
    const e = await setup();
    const r = await container(e);
    await e.registry.update(r.id, (x) => ({ ...x, runningSince: new Date(Date.now() + 5_000).toISOString(), lease: x.lease ? { ...x.lease, maxLifetimeMin: 120 } : x.lease }));
    await e.svc.api.extend(r.id, 60); // 180 ≤ the approved 240
    expect(e.confirms()).toEqual([]);
    expect(e.registry.get(r.id)?.lease?.maxLifetimeMin).toBe(180);
    await e.svc.api.extend(r.id, 120); // 300 > 240
    expect(e.confirms()).toEqual(['Extend train box?']);
    expect(e.registry.get(r.id)).toMatchObject({ approvedMaxLifetimeMin: 300, lease: { maxLifetimeMin: 300 } });
  });

  it('extend of a sandbox also moves the server timeout', async () => {
    const e = await setup();
    const r = await sandbox(e);
    await e.svc.api.extend(r.id, 30);
    expect(e.registry.get(r.id)?.serverEndsAt).not.toBeNull();
  });

  it('setLease: loosening or deleting sooner → native; tightening → none', async () => {
    const e = await setup();
    const r = await container(e);
    await e.svc.api.setLease(r.id, { maxLifetimeMin: 120 });
    expect(e.confirms()).toEqual([]);
    await e.svc.api.setLease(r.id, { maxLifetimeMin: 600 });
    expect(e.confirms()).toEqual(['Change the lease of train box?']);
    t.platform.confirmAnswer = false;
    await expect(e.svc.api.setLease(r.id, { onBudget: 'delete' })).rejects.toMatchObject({ code: 'cancelled' });
    expect(e.registry.get(r.id)?.lease?.onBudget).toBe('notify');
    await expect(e.svc.api.setLease(r.id, { onExpiry: 'pause' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('updateFirewallCidr: a /32 needs no native dialog, broader does; reserved refused', async () => {
    const e = await setup();
    const r = await container(e);
    await e.registry.update(r.id, (x) => ({ ...x, network: { publicIp: null, eip: null, firewalls: [{ id: '00000000-0000-4000-8000-00000000f002', name: 'fw', managed: true, preset: false, rules: [{ protocol: 'tcp', fromPort: 22, toPort: 22, cidr: '203.0.113.7/32' }] }], ports: [], degraded: false } }));
    await e.svc.api.updateFirewallCidr(r.id, '198.51.100.9');
    expect(e.confirms()).toEqual([]);
    await e.svc.api.updateFirewallCidr(r.id, '198.51.100.0/24');
    expect(e.confirms()).toEqual(['Open to the internet?']);
    await expect(e.svc.api.updateFirewallCidr(r.id, '10.0.0.1/33')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('unmanaged resources, adopt, EIPs, alarms', () => {
  it('unmanaged rows are read-only: listed with no capabilities, every mutation refused', async () => {
    const e = await setup(['orphan_other_install', 'org_billing']);
    await e.svc.api.refresh();
    const all = await e.svc.api.listResources({ includeUnmanaged: true });
    const other = all.find((r) => r.id === 'ur_ce_00000000-0000-4000-8000-00000000d003');
    expect(other).toMatchObject({ managed: false, capabilities: { logs: false, restart: false, extend: false } });
    await expect(e.svc.api.delete(other?.id ?? '')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(e.svc.api.restart('ur_ce_00000000-0000-4000-8000-00000000d004')).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await e.svc.api.listResources()).every((r) => r.managed)).toBe(true);
  });

  it("adopt: native ('may belong to a colleague'), then managed with a notify-only lease; untagged ones cannot be adopted", async () => {
    const e = await setup(['orphan_other_install', 'org_billing']);
    await e.svc.api.refresh();
    const adopted = await e.svc.api.adopt('ur_ce_00000000-0000-4000-8000-00000000d003');
    expect(e.confirms()).toEqual(['Adopt gmid-zzzzzz-finetune-x4n2rd?']);
    expect(t.platform.confirms[0]?.message).toMatch(/colleague/);
    expect(adopted).toMatchObject({ managed: true, lease: { onExpiry: 'notify', maxLifetimeMin: 240 } });
    await expect(e.svc.api.adopt('ur_ce_00000000-0000-4000-8000-00000000d004')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(e.svc.api.adopt('cr_whatever')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('releaseEip: native for an EIP this app allocated; unmanaged ones refused without a dialog', async () => {
    const e = await setup(['eip_orphan', 'org_billing']);
    await expect(e.svc.api.releaseEip('00000000-0000-4000-8000-00000000e003')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(e.confirms()).toEqual([]);
    e.alarms.raise({ kind: 'eip_unattached', severity: 'warning', resourceId: '00000000-0000-4000-8000-00000000e002', title: 't', body: 'b', usdPerHour: 0.1, actions: [] });
    await e.svc.api.releaseEip('00000000-0000-4000-8000-00000000e002');
    expect(e.confirms()).toEqual(['Release 203.0.113.24?']);
    expect((await e.mock.ce.listEips()).find((x) => x.id === '00000000-0000-4000-8000-00000000e002')).toBeUndefined();
    expect(e.alarms.byKind('eip_unattached')).toHaveLength(0);
  });

  it('dismissing a create_unknown alarm asks natively and marks the journal entry dismissed', async () => {
    const e = await setup();
    await e.journal.append({ rid: 'cr_u', kind: 'container', backend: 'ce', name: 'gmid-x', displayName: 'x', idc: null, sku: 'gmi.container.nv.H200x1.tw3', at: new Date().toISOString(), network: null });
    await e.journal.update('cr_u', { state: 'failed_unknown' });
    const alarm = e.alarms.raise({ kind: 'create_unknown', severity: 'critical', resourceId: 'cr_u', title: 't', body: 'b', usdPerHour: 3.35, actions: ['dismiss'] });
    const state = await e.svc.api.dismissAlarm(alarm.id);
    expect(e.confirms()).toEqual(['Stop checking for this create?']);
    expect(e.journal.get('cr_u')?.state).toBe('dismissed');
    expect(state.alarms).toEqual([]);
  });

  it('getState: access, health, org banner after a sweep, mock flag', async () => {
    const e = await setup(['org_billing']);
    await e.svc.checkAccess();
    const s = await e.svc.api.sweep();
    expect(s).toMatchObject({ mock: true, dailyBudgetSet: true, access: { containers: 'entitled', sandboxes: 'entitled', key: { status: 'missing' } } });
    expect(s.org?.containers).toBe(3);
    expect(s.lastSweepAt).not.toBeNull();
  });

  it('not_entitled shows in access (403 is not a dead key)', async () => {
    const e = await setup(['not_entitled']);
    await e.svc.checkAccess();
    const s = await e.svc.api.getState();
    expect(s.access).toMatchObject({ containers: 'not_entitled', sandboxes: 'not_entitled' });
  });

  it('openInConsole uses the validated deep link for containers', async () => {
    const e = await setup(['orphan_other_install']);
    await e.svc.api.refresh();
    await e.svc.api.openInConsole('ur_ce_00000000-0000-4000-8000-00000000d003', 'logs');
    expect(t.platform.opened[0]).toMatch(/^https:\/\/console\.gmicloud\.ai\/auth\/sign-in\?callbackUrl=/);
    expect(decodeURIComponent(t.platform.opened[0] ?? '')).toMatch(/00000000-0000-4000-8000-00000000d003\/logs$/);
    await expect(e.svc.api.openInConsole('../../etc', 'detail')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('C1 review fixes (service)', () => {
  /** Captures the detail lines of every native dialog (FakePlatform keeps only title + message). */
  function captureDetails(): string[] {
    const details: string[] = [];
    const orig = t.platform.confirm.bind(t.platform);
    t.platform.confirm = async (o: Parameters<typeof orig>[0]) => {
      details.push(o.detail ?? '');
      return orig(o);
    };
    return details;
  }

  it('agent sandboxes: deny-all egress only; any host or CIDR at create is refused, whoever asks', async () => {
    const e = await setup();
    const agent = (egress: SandboxCreateSpec['egress']) => sandboxSpec({ purpose: 'agent', egress, lease: { maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 10, extendOnActivity: true, onBudget: 'pause' } });
    await expect(e.svc.api.quoteCreate(agent({ mode: 'allowlist', hostnames: ['github.com', 'uploads.github.com'], cidrs: [] }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(e.svc.api.quoteCreate(agent({ mode: 'allowlist', hostnames: [], cidrs: ['0.0.0.0/0'] }))).rejects.toMatchObject({ code: 'invalid_input' });
    const details = captureDetails();
    const q = await e.svc.api.quoteCreate(agent({ mode: 'allowlist', hostnames: [], cidrs: [] }));
    await e.svc.api.create(q.quoteId);
    expect(details[0]).toContain('Egress: all outbound traffic blocked.');
  });

  it('a wide egress CIDR or an upload host gets its own native dialog naming it; the create dialog has an Egress line', async () => {
    const e = await setup();
    const details = captureDetails();
    const q = await e.svc.api.quoteCreate(sandboxSpec({ egress: { mode: 'allowlist', hostnames: ['pypi.org', 'github.com'], cidrs: ['0.0.0.0/0'] } }));
    await e.svc.api.create(q.quoteId);
    expect(e.confirms()).toEqual(['Create sandbox', 'Allow this outbound traffic?']);
    expect(details[0]).toContain('Egress: only pypi.org, github.com, 0.0.0.0/0.');
    expect(details[1]).toContain('0.0.0.0/0');
    expect(details[1]).toContain('github.com');
    // Refusing it creates nothing.
    t.platform.confirms.length = 0;
    const before = (await e.mock.sandbox.listAll({})).length;
    const q2 = await e.svc.api.quoteCreate(sandboxSpec({ egress: { mode: 'allowlist', hostnames: [], cidrs: ['198.51.100.0/24'] } }));
    let n = 0;
    t.platform.confirm = async () => ++n === 1;
    await expect(e.svc.api.create(q2.quoteId)).rejects.toMatchObject({ code: 'cancelled' });
    expect((await e.mock.sandbox.listAll({})).length).toBe(before);
  });

  it("the create dialog lists the template's pre-exposed ports (22, 8888) with the spec's own", async () => {
    const e = await setup();
    const details = captureDetails();
    const q = await e.svc.api.quoteCreate(containerSpec({ ports: [{ containerPort: 7860, protocol: 'TCP' }] }));
    await e.svc.api.create(q.quoteId);
    const line = details[0]?.split('\n').find((l) => l.startsWith('Exposed container ports')) ?? '';
    expect(line).toMatch(/TCP 22\b/);
    expect(line).toMatch(/TCP 8888\b/);
    expect(line).toMatch(/TCP 7860\b/);
  });

  it("releaseEip accepts the owning container's id (older alarms) and resolves both alarm keys; the EIP stops accruing", async () => {
    const e = await setup(['eip_orphan']);
    const at = new Date(Date.now() - 3600_000).toISOString();
    const { blankRecord } = await import('@main/services/compute/registry');
    await e.registry.add(
      blankRecord({ id: 'cr_owner', kind: 'container', backend: 'ce', name: 'gmid-x-old-box-r2k7mz', displayName: 'old-box', managed: true, remoteId: 'gone', eipIntervals: [{ from: at, to: null, usdPerHour: 0.1 }], network: { publicIp: null, eip: { id: '00000000-0000-4000-8000-00000000e002', address: '203.0.113.24', managed: true, status: 'disassociated' }, firewalls: [], ports: [], degraded: true } }, at),
    );
    e.alarms.raise({ kind: 'eip_unattached', severity: 'warning', resourceId: 'cr_owner', title: 't', body: 'b', usdPerHour: 0.1, actions: ['release_eip'] });
    await e.svc.api.releaseEip('cr_owner');
    expect(e.confirms()).toEqual(['Release 203.0.113.24?']);
    expect(e.alarms.byKind('eip_unattached')).toHaveLength(0);
    const rec = e.registry.get('cr_owner');
    expect(rec?.network?.eip?.status).toBe('released');
    expect(rec?.eipIntervals[0]?.to).not.toBeNull();
  });

  it('listVisible (the compute:resources event) carries the unmanaged rows the "show all" list already has', async () => {
    const e = await setup(['orphan_other_install', 'org_billing']);
    await e.svc.api.refresh();
    const all = await e.svc.api.listResources({ includeUnmanaged: true });
    expect(all.some((r) => !r.managed)).toBe(true);
    expect(e.svc.listVisible().map((r) => r.id).sort()).toEqual(all.map((r) => r.id).sort());
  });
});

describe('the slice entry (index.ts) in mock mode', () => {
  it('never fetches; seeds the demo resources; reconciles; serves the API; disposes cleanly', async () => {
    const fetched: string[] = [];
    t = await createTestContext({
      mock: true,
      fetch: async (url) => {
        fetched.push(String(url));
        return new Response('no', { status: 599 });
      },
    });
    const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: () => new Date() });
    const budgets = await createBudgetService({ ctx: t.ctx, ledger });
    const slice = await createComputeSlice(t.ctx, { auth: fakeAuth(), keys: fakeComputeKeys(COMPUTE_KEY), catalog: {} as never, budget: budgets.guard, budgetSources: budgets.sources });
    const state = await slice.api.dismissAlarm('none'); // a mutating call: waits for startup
    expect(state.mock).toBe(true);
    const resources = await slice.api.listResources();
    expect(resources.map((r) => r.id)).toEqual(expect.arrayContaining(['cr_mock_ce1', 'cr_mock_sb1']));
    expect(slice.internals).not.toBeNull();
    expect(typeof slice.quitCheck).toBe('function');
    expect(slice.backends?.mock).not.toBeNull();
    expect(fetched).toEqual([]);
    await slice.dispose();
    budgets.dispose();
    await ledger.flush();
  });

  it('mock mode without a Compute key behaves like real mode: nothing seeded, no alarms; the key seeds the demo', async () => {
    t = await createTestContext({ mock: true });
    const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: () => new Date() });
    const budgets = await createBudgetService({ ctx: t.ctx, ledger });
    const keys = fakeComputeKeys(null);
    const slice = await createComputeSlice(t.ctx, { auth: fakeAuth(), keys, catalog: {} as never, budget: budgets.guard, budgetSources: budgets.sources });
    const state = await slice.api.dismissAlarm('none');
    expect(state.alarms).toEqual([]);
    expect(await slice.api.listResources()).toEqual([]);
    await expect(slice.backends!.ce.listContainers()).rejects.toMatchObject({ code: 'no_compute_key' });
    keys.setKey(COMPUTE_KEY);
    await new Promise((r) => setTimeout(r, 300));
    const after = await slice.api.listResources();
    expect(after.map((r) => r.id)).toEqual(expect.arrayContaining(['cr_mock_ce1', 'cr_mock_sb1']));
    // Seeded after the price feed: the demo container is priced (never "$0.00 so far" on a running H200).
    expect(after.find((r) => r.id === 'cr_mock_ce1')?.listUsdPerHour).not.toBeNull();
    await slice.dispose();
    budgets.dispose();
    await ledger.flush();
  });

  it('mock no_daily_budget / budget_low reach the cost guard (dailyBudgetSet, assessments)', async () => {
    const prev = process.env.GMI_DESK_MOCK_COMPUTE;
    process.env.GMI_DESK_MOCK_COMPUTE = 'no_daily_budget';
    try {
      t = await createTestContext({ mock: true });
      const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: () => new Date() });
      // The usage slice seeds the scenario's budget into the one real budget (services/usage/index.ts).
      const budgets = await createBudgetService({ ctx: t.ctx, ledger, seed: { ...MOCK_BUDGET, ...mockComputeScenario(mockComputeFlags()).budget } });
      const slice = await createComputeSlice(t.ctx, { auth: fakeAuth(), keys: fakeComputeKeys(COMPUTE_KEY), catalog: {} as never, budget: budgets.guard, budgetSources: budgets.sources });
      expect((await slice.api.dismissAlarm('none')).dailyBudgetSet).toBe(false);
      await slice.dispose();
      process.env.GMI_DESK_MOCK_COMPUTE = 'budget_low';
      expect(mockComputeScenario(mockComputeFlags()).budget).toEqual({ dailyUsd: 5, enforce: true });
      budgets.dispose();
      await ledger.flush();
    } finally {
      if (prev === undefined) delete process.env.GMI_DESK_MOCK_COMPUTE;
      else process.env.GMI_DESK_MOCK_COMPUTE = prev;
    }
  });

  it('real mode without a Compute key makes no network call at all (startup, poll, sweep)', async () => {
    const fetched: string[] = [];
    t = await createTestContext({
      fetch: async (url) => {
        fetched.push(String(url));
        throw new Error('no network');
      },
    });
    const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: () => new Date() });
    const budgets = await createBudgetService({ ctx: t.ctx, ledger });
    const slice = await createComputeSlice(t.ctx, { auth: fakeAuth(), keys: createUnavailableComputeKeys(), catalog: {} as never, budget: budgets.guard, budgetSources: budgets.sources });
    const state = await slice.api.dismissAlarm('none');
    expect(state).toMatchObject({ mock: false, org: null, access: { containers: 'unknown' } });
    await expect(slice.api.quoteCreate(containerSpec())).rejects.toMatchObject({ code: 'no_compute_key' });
    await slice.api.refresh();
    await slice.api.sweep();
    expect(await slice.api.listResources()).toEqual([]);
    expect(fetched).toEqual([]);
    await slice.dispose();
    budgets.dispose();
    await ledger.flush();
  });
});
