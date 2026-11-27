// C1-C: the orphan sweep (§7.5) against the mock simulators (GMI_DESK_MOCK_COMPUTE flags). This install's resources are
// adopted with an alarm; another install's are only reported (read-only, Adopt needs a native dialog elsewhere); untagged
// resources are never touched; EIP alarms; the org-wide banner; a late container is adopted under its journal rid.
import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createMockCompute } from '@main/mock/compute';
import { createJournal, type Journal } from '@main/services/compute/journal';
import { installLabel, installTag } from '@main/services/compute/names';
import { createRegistry } from '@main/services/compute/registry';
import { createServerClock, createSupervisor } from '@main/services/compute/supervisor';
import { createSweeper, type Sweeper } from '@main/services/compute/sweep';
import type { Registry } from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeComputeKeys } from './fakes';
import { fakeAlarms, fakePrices, type FakeAlarms } from './lifecycle-harness';

let t: TestContext;
afterEach(async () => t?.cleanup());

const MUTATING = /^(create|delete|restart|associate|disassociate|allocate|release|update|pause|resume|setTimeout|connect)/i;

function recording<T extends object>(target: T, calls: string[]): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const v = Reflect.get(obj, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(obj, args);
      };
    },
  });
}

interface Env {
  sweeper: Sweeper;
  registry: Registry;
  journal: Journal;
  alarms: FakeAlarms;
  calls: string[];
  mock: ReturnType<typeof createMockCompute>;
  tag: string;
}

async function setup(flags: string[]): Promise<Env> {
  t = await createTestContext();
  const tag = installTag(t.ctx.installId);
  const label = installLabel(t.ctx.installId);
  const mock = createMockCompute({ flags: new Set(flags), installTag: tag, installLabel: label });
  const calls: string[] = [];
  const ce = recording(mock.ce, calls);
  const sandbox = recording(mock.sandbox, calls);
  const registry = createRegistry({ dataDir: t.ctx.paths.data, log: silentLogger });
  const journal = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger });
  await Promise.all([registry.load(), journal.load()]);
  const clock = createServerClock();
  const keys = fakeComputeKeys();
  const supervisor = createSupervisor({ registry, log: silentLogger, keys, ce, sandbox, clock });
  const alarms = fakeAlarms();
  const prices = fakePrices();
  const createDeps = { ce, registry, journal, alarms, prices, supervisor, log: silentLogger };
  const lifecycleDeps = { sandbox, tokens: null, dataPlane: null, registry, journal, alarms, prices, supervisor, log: silentLogger };
  const sweeper = createSweeper({ ce, sandbox, registry, journal, alarms, prices, supervisor, log: silentLogger, installTag: tag, installLabel: label, createDeps, lifecycleDeps });
  return { sweeper, registry, journal, alarms, calls, mock, tag };
}

describe('sweep', () => {
  it("adopts this install's resources with an orphan alarm and the default lease starting now", async () => {
    const e = await setup(['orphan']);
    const res = await e.sweeper.run();
    const managed = e.registry.list();
    expect(managed.map((r) => r.remoteId).sort()).toEqual(['00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000d002', 'sbx-mock-0001', 'sbx-mock-0003'].sort());
    expect(res?.adopted).toHaveLength(4);
    const scratch = e.registry.findByRemote('ce', '00000000-0000-4000-8000-00000000d002');
    expect(scratch).toMatchObject({ managed: true, installTag: e.tag, lease: { maxLifetimeMin: 240, onExpiry: 'delete' }, listUsdPerHour: 0.5 });
    // Running for 26 h already: the lease starts at adoption, so nothing is deleted at once.
    expect(Date.now() - Date.parse(scratch?.runningSince ?? '')).toBeLessThan(60_000);
    const agentBox = e.registry.findByRemote('sandbox_v2', 'sbx-mock-0003');
    expect(agentBox).toMatchObject({ id: 'cr_mock_sb3', purpose: 'agent', sku: 'gmi.sandbox.medium', lease: { idlePauseMin: 10 } });
    const orphanAlarms = e.alarms.byKind('orphan');
    expect(orphanAlarms).toHaveLength(4);
    expect(orphanAlarms.find((a) => a.resourceId === 'cr_mock_sb3')?.actions).toEqual(['open', 'pause', 'delete', 'dismiss']);
    // The price is the alarm's own field (shown beside the title) and in the body for desktop notifications.
    const scratchAlarm = orphanAlarms.find((a) => a.resourceId === scratch?.id);
    expect(scratchAlarm?.usdPerHour).toBe(0.5);
    expect(scratchAlarm?.title).not.toMatch(/\$/);
    expect(scratchAlarm?.body).toMatch(/\$0\.50\/h/);
    // Accrual: the adopted container bills from now on (an open interval).
    expect(scratch?.intervals.at(-1)?.to).toBeNull();
    // A second sweep adopts nothing new.
    expect((await e.sweeper.run())?.adopted).toEqual([]);
    expect(e.calls.filter((c) => MUTATING.test(c))).toEqual([]);
  });

  it("another install's gmid- container → read-only warning (Open in console, Adopt); never adopted or touched", async () => {
    const e = await setup(['orphan_other_install', 'org_billing']);
    const res = await e.sweeper.run();
    expect(res?.otherInstall).toEqual(['ur_ce_00000000-0000-4000-8000-00000000d003']);
    const alarm = e.alarms.list().find((a) => a.resourceId === 'ur_ce_00000000-0000-4000-8000-00000000d003');
    expect(alarm).toMatchObject({ kind: 'orphan', severity: 'warning', usdPerHour: 2.5 });
    expect(alarm?.actions).toEqual(['open_console', 'adopt', 'dismiss']);
    expect(e.registry.findByRemote('ce', '00000000-0000-4000-8000-00000000d003')).toBeNull();
    // Untagged org containers (research-box, eval-runner): no record, no alarm.
    expect(e.registry.findByRemote('ce', '00000000-0000-4000-8000-00000000d004')).toBeNull();
    expect(e.registry.findByRemote('ce', '00000000-0000-4000-8000-00000000d005')).toBeNull();
    expect(e.alarms.list().some((a) => a.resourceId?.includes('d004') || a.resourceId?.includes('d005'))).toBe(false);
    expect(e.calls.filter((c) => MUTATING.test(c))).toEqual([]);
  });

  it('a disassociated EIP → eip_unattached with its hourly price; Release only when this install allocated it', async () => {
    const e = await setup(['eip_orphan']);
    const res = await e.sweeper.run();
    expect(res?.eipsUnattached).toEqual(['00000000-0000-4000-8000-00000000e002']);
    const alarm = e.alarms.byKind('eip_unattached')[0];
    expect(alarm).toMatchObject({ resourceId: '00000000-0000-4000-8000-00000000e002', usdPerHour: 0.1 });
    expect(alarm?.actions).toContain('release_eip');
    expect(e.calls.filter((c) => MUTATING.test(c))).toEqual([]);
  });

  it('the org-wide banner counts every billed container and EIP the key sees (list $/h)', async () => {
    const e = await setup(['org_billing', 'orphan_other_install', 'eip_orphan']);
    const res = await e.sweeper.run();
    // d001 3.35 + d003 2.5 + d004 26.8 + d005 0.5; EIPs e001, e002, e003 at 0.1.
    expect(res?.org).toEqual({ containers: 4, eips: 3, usdPerHour: 33.45 });
  });

  it('paused for more than 24 h → paused_long once a day', async () => {
    const e = await setup(['paused']);
    await e.sweeper.run();
    expect(e.alarms.byKind('paused_long').map((a) => a.resourceId)).toEqual(['cr_mock_sb2']);
    const raised = e.alarms.raised.filter((a) => a.kind === 'paused_long').length;
    await e.sweeper.run();
    expect(e.alarms.raised.filter((a) => a.kind === 'paused_long').length).toBe(raised);
  });

  it('a late container (journal failed_unknown) is adopted under its journal rid on a later sweep', async () => {
    const e = await setup([]);
    const name = `gmid-${e.tag}-late-box-q1w2e3`;
    await e.journal.append({ rid: 'cr_late', kind: 'container', backend: 'ce', name, displayName: 'late box', idc: 'asia-east-taiwan3', sku: 'gmi.container.nv.H200x1.tw3', at: new Date().toISOString(), network: null });
    await e.journal.update('cr_late', { state: 'failed_unknown' });
    e.alarms.raise({ kind: 'create_unknown', severity: 'critical', resourceId: 'cr_late', title: 't', body: 'b', usdPerHour: 3.35, actions: ['dismiss'] });
    await e.sweeper.run();
    expect(e.journal.get('cr_late')?.state).toBe('failed_unknown');
    // GMI creates it late (the simulator stands in for GMI here).
    await e.mock.ce.createContainer({ count: 1, name, idc: 'asia-east-taiwan3', product: 'gmi.container.nv.H200x1.tw3', templateId: '00000000-0000-4000-8000-00000000a001' });
    const res = await e.sweeper.run();
    expect(e.journal.get('cr_late')?.state).toBe('confirmed');
    expect(e.registry.get('cr_late')).toMatchObject({ managed: true, name });
    expect(e.alarms.byKind('create_unknown')).toHaveLength(0);
    // Not adopted a second time as an anonymous orphan.
    expect(res?.adopted.some((id) => e.registry.get(id)?.name === name)).toBe(false);
    expect(e.registry.list().filter((r) => r.name === name)).toHaveLength(1);
  });

  it('without a key the sweep does nothing (no adoption, no banner)', async () => {
    const e = await setup([]);
    const keyless = createSupervisor({ registry: e.registry, log: silentLogger, keys: fakeComputeKeys(null), ce: e.mock.ce, sandbox: e.mock.sandbox, clock: createServerClock() });
    // The mock simulators ignore keys; the real clients throw no_compute_key, which the sweep treats as "skip".
    const failing = createSweeper({
      ce: { listContainers: async () => Promise.reject(new GmiError('no_compute_key', 'no key')), listEips: async () => Promise.reject(new Error('x')) } as never,
      sandbox: { listAll: async () => Promise.reject(new Error('x')), get: async () => Promise.reject(new Error('x')) } as never,
      registry: e.registry,
      journal: e.journal,
      alarms: e.alarms,
      prices: fakePrices(),
      supervisor: keyless,
      log: silentLogger,
      installTag: e.tag,
      installLabel: 'x',
      createDeps: { ce: { listContainers: async () => [], createContainer: async () => Promise.reject(new Error('never')) } as never, registry: e.registry, journal: e.journal, alarms: e.alarms, prices: fakePrices(), supervisor: keyless, log: silentLogger },
      lifecycleDeps: null,
    });
    const res = await failing.run();
    expect(res?.org ?? null).toBeNull();
    expect(e.registry.list()).toEqual([]);
  });
});
