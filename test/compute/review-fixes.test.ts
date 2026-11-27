// C1 integrator: regression tests for the C1 review findings that are not covered in the area files (alarms,
// accrual, guard, sweep, reconcile, CE / v2 clients, errors, the mock wiring).
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import type { AppContext } from '@main/core/context';
import { createMockCompute } from '@main/mock/compute';
import { accruedBetween, backfillPrice, burnUsdPerHour, remainingLeaseHours } from '@main/services/compute/accrual';
import { createAlarmCenter } from '@main/services/compute/alarms';
import { createCeClient } from '@main/services/compute/ce/client';
import { reconcileContainer } from '@main/services/compute/ce/create';
import { computeErrorFrom } from '@main/services/compute/errors';
import { createJournal } from '@main/services/compute/journal';
import { keyGated } from '@main/services/compute/mock-wiring';
import { installLabel, installTag } from '@main/services/compute/names';
import { committedUsd } from '@main/services/compute/pricing';
import { blankRecord, createRegistry, defaultLease } from '@main/services/compute/registry';
import { createSandboxClient } from '@main/services/compute/sandbox/client';
import { reconcileSandbox } from '@main/services/compute/sandbox/lifecycle';
import { createServerClock, createSupervisor } from '@main/services/compute/supervisor';
import { createSweeper } from '@main/services/compute/sweep';
import type { ComputeRecord } from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeComputeKeys, fakeHttp, json, v2Error } from './fakes';
import { record } from './guard-harness';
import { fakeAlarms, fakePrices } from './lifecycle-harness';

let t: TestContext | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('alarms: a dismissal does not hide an escalation (§9.6)', () => {
  function center() {
    const notes: string[] = [];
    const ctx = { platform: { notify: (n: { title: string }) => notes.push(n.title), focusApp() {} }, events: { emit() {} }, log: silentLogger, now: () => new Date() } as unknown as Pick<AppContext, 'platform' | 'events' | 'log' | 'now'>;
    return { c: createAlarmCenter({ ctx }), notes };
  }

  it('dismissed T−15 warning → the critical "lease ended, still billing" alarm is listed and notified', () => {
    const { c, notes } = center();
    const a = c.raise({ kind: 'lease_expiring', severity: 'warning', resourceId: 'cr_1', title: 'ends in 15', body: 'b', usdPerHour: 3, actions: ['extend'] });
    c.dismiss(a.id);
    expect(c.list()).toHaveLength(0);
    c.raise({ kind: 'lease_expiring', severity: 'critical', resourceId: 'cr_1', title: 'lease ended, still billing', body: 'b2', usdPerHour: 3, actions: ['delete'] });
    expect(notes).toEqual(['ends in 15', 'lease ended, still billing']);
    expect(c.list().map((x) => x.title)).toEqual(['lease ended, still billing']);
  });

  it('a forced step with new content (T−5 after a dismissed T−15) comes back; the same content stays dismissed', () => {
    const { c, notes } = center();
    const a = c.raise({ kind: 'lease_expiring', severity: 'warning', resourceId: 'cr_1', title: 'ends in 15', body: 'b', usdPerHour: 3, actions: [] }, { notify: 'force' });
    c.dismiss(a.id);
    c.raise({ kind: 'lease_expiring', severity: 'warning', resourceId: 'cr_1', title: 'ends in 15', body: 'b', usdPerHour: 3, actions: [] });
    expect(c.list()).toHaveLength(0);
    c.raise({ kind: 'lease_expiring', severity: 'warning', resourceId: 'cr_1', title: 'ends in 5', body: 'b', usdPerHour: 3, actions: [] }, { notify: 'force' });
    expect(notes).toEqual(['ends in 15', 'ends in 5']);
    expect(c.list()).toHaveLength(1);
  });

  it('a budget warning dismissed stays dismissed while it repeats with new figures (auto)', () => {
    const { c } = center();
    const a = c.raise({ kind: 'budget_warning', severity: 'warning', resourceId: null, title: '80 %', body: 'b', usdPerHour: null, actions: [] });
    c.dismiss(a.id);
    c.raise({ kind: 'budget_warning', severity: 'warning', resourceId: null, title: '85 %', body: 'b', usdPerHour: null, actions: [] });
    expect(c.list()).toHaveLength(0);
  });
});

describe('committed burn and accrual (§9.2, §9.3)', () => {
  const now = Date.now();
  const running = (over: Partial<ComputeRecord>) =>
    record({ id: 'c', kind: 'container', listUsdPerHour: 26.8, runningSince: iso(now - 5 * HOUR), intervals: [{ from: iso(now - 5 * HOUR), to: null, usdPerHour: 26.8 }], ...over });

  it('a notify lease (also a container "pause") never stops billing: counts 24 h, also past its end', () => {
    const notify = running({ lease: { ...defaultLease('container'), onExpiry: 'notify' } });
    expect(remainingLeaseHours(notify, now)).toBe(24);
    expect(committedUsd([notify], new Date(now))).toBeCloseTo(26.8 * 24);
    const pause = running({ lease: { ...defaultLease('container'), onExpiry: 'pause' } });
    expect(remainingLeaseHours(pause, now)).toBe(24);
    // A delete lease past its end still counts 0 (the guard deletes it).
    expect(remainingLeaseHours(running({ lease: defaultLease('container') }), now)).toBe(0);
  });

  it('a managed EIP accrues from allocation until released, also after its container is deleted', () => {
    const rec = running({
      lease: defaultLease('container'),
      intervals: [{ from: iso(now - 2 * HOUR), to: iso(now - HOUR), usdPerHour: 3 }],
      eipIntervals: [{ from: iso(now - 2 * HOUR), to: null, usdPerHour: 0.1 }],
      tombstone: { at: iso(now - HOUR), reason: 'Deleted.' },
      phase: 'deleted',
    });
    expect(accruedBetween(rec, Number.NEGATIVE_INFINITY, now, now)).toBeCloseTo(3 + 0.2);
    expect(burnUsdPerHour([rec])).toBeCloseTo(0.1);
    expect(committedUsd([rec], new Date(now))).toBeCloseTo(0.1 * 24);
    const released = { ...rec, eipIntervals: [{ from: iso(now - 2 * HOUR), to: iso(now - HOUR), usdPerHour: 0.1 }] };
    expect(burnUsdPerHour([released])).toBe(0);
  });

  it('backfillPrice fills an unknown list price and every null-priced interval; nothing when the price is still unknown', () => {
    const rec = running({ listUsdPerHour: null, intervals: [{ from: iso(now - HOUR), to: null, usdPerHour: null }], sku: 'gmi.container.test' });
    expect(backfillPrice(rec, fakePrices({ 'gmi.container.test': 3.35 }))).toMatchObject({ listUsdPerHour: 3.35, intervals: [{ usdPerHour: 3.35 }] });
    expect(backfillPrice(rec, fakePrices({}))).toBeNull();
    expect(backfillPrice(running({}), fakePrices({ 'gmi.container.test': 9 }))).toBeNull();
  });
});

describe('guard: agent tool calls fail closed without H4 (§9.5)', () => {
  it('without isRunActive an agent_tool activity never resets the idle clock', async () => {
    const { guardHarness } = await import('./guard-harness');
    const now = new Date('2026-11-02T10:00:00Z');
    const h = await guardHarness({ now, records: [record({ id: 's1', lease: defaultLease('sandbox'), runningSince: now.toISOString() })] });
    try {
      h.guard.activity.record('s1', { kind: 'agent_tool', runId: 'run-1' });
      expect(h.guard.lastActivityAt('s1')).toBeNull();
      h.guard.activity.record('s1', { kind: 'terminal_input' });
      expect(h.guard.lastActivityAt('s1')).toBe(now.toISOString());
    } finally {
      await h.cleanup();
    }
  });
});

describe('sweep and reconcile: no billing resource of this install goes untracked', () => {
  async function env(flags: string[]) {
    t = await createTestContext();
    const tag = installTag(t.ctx.installId);
    const label = installLabel(t.ctx.installId);
    const mock = createMockCompute({ flags: new Set(flags), installTag: tag, installLabel: label });
    const registry = createRegistry({ dataDir: t.ctx.paths.data, log: silentLogger });
    const journal = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger });
    await Promise.all([registry.load(), journal.load()]);
    const keys = fakeComputeKeys();
    const supervisor = createSupervisor({ registry, log: silentLogger, keys, ce: mock.ce, sandbox: mock.sandbox, clock: createServerClock() });
    const alarms = fakeAlarms();
    const prices = fakePrices();
    const createDeps = { ce: mock.ce, registry, journal, alarms, prices, supervisor, log: silentLogger, sleep: async () => undefined };
    const lifecycleDeps = { sandbox: mock.sandbox, tokens: mock.tokens, dataPlane: mock.dataPlane, registry, journal, alarms, prices, supervisor, log: silentLogger, sleep: async () => undefined };
    const sweeper = createSweeper({ ce: mock.ce, sandbox: mock.sandbox, registry, journal, alarms, prices, supervisor, log: silentLogger, installTag: tag, installLabel: label, createDeps, lifecycleDeps });
    return { mock, registry, journal, alarms, supervisor, sweeper, createDeps, lifecycleDeps, tag };
  }

  it('a tombstoned container that the sweep finds listed is revived', async () => {
    const e = await env(['orphan']);
    const c = (await e.mock.ce.listContainers()).find((x) => x.name.startsWith(`gmid-${e.tag}-cpu-scratch`));
    expect(c).toBeDefined();
    const at = iso(Date.now() - HOUR);
    await e.registry.add(blankRecord({ id: 'cr_scratch', kind: 'container', backend: 'ce', name: c!.name, displayName: 'cpu-scratch', managed: true, remoteId: c!.id, tombstone: { at, reason: 'Gone from GMI.' }, phase: 'deleted' }, at));
    await e.sweeper.run();
    expect(e.registry.get('cr_scratch')?.tombstone).toBeNull();
    expect(e.registry.list().filter((r) => r.remoteId === c!.id)).toHaveLength(1);
  });

  it.each(['confirmed', 'dismissed'] as const)('a listed container whose journal entry is %s (no record) is adopted under the journal rid', async (state) => {
    const e = await env(['orphan']);
    const c = (await e.mock.ce.listContainers()).find((x) => x.name.startsWith(`gmid-${e.tag}-cpu-scratch`))!;
    await e.journal.append({ rid: 'cr_journal', kind: 'container', backend: 'ce', name: c.name, displayName: 'cpu-scratch', idc: c.idc, sku: c.product, at: new Date().toISOString(), network: null });
    await e.journal.update('cr_journal', { state, remoteId: state === 'confirmed' ? c.id : null });
    const res = await e.sweeper.run();
    expect(res?.adopted).toContain('cr_journal');
    expect(e.registry.get('cr_journal')).toMatchObject({ managed: true, remoteId: c.id, lease: { onExpiry: 'delete' } });
  });

  it('reconcileContainer: a confirmed entry with no record lists again and records it; with a record it is a no-op', async () => {
    const e = await env(['orphan']);
    const c = (await e.mock.ce.listContainers()).find((x) => x.name.startsWith(`gmid-${e.tag}-cpu-scratch`))!;
    await e.journal.append({ rid: 'cr_crash', kind: 'container', backend: 'ce', name: c.name, displayName: 'cpu-scratch', idc: c.idc, sku: c.product, at: new Date().toISOString(), network: null });
    await e.journal.update('cr_crash', { state: 'confirmed', remoteId: c.id });
    expect(await reconcileContainer(e.createDeps, 'cr_crash')).toBe('confirmed');
    expect(e.registry.get('cr_crash')).toMatchObject({ remoteId: c.id, lease: defaultLease('container') });
    expect(e.alarms.byKind('create_unknown')).toHaveLength(0);
  });

  it('reconcileSandbox: a sandbox found for an entry without a record gets the default lease, purpose and install tag', async () => {
    const e = await env([]);
    const listed = await e.mock.sandbox.listAll({ metadata: { app: 'gmi-desk' } });
    const s = listed.find((x) => x.metadata?.rid === 'cr_mock_sb1')!;
    await e.journal.append({ rid: 'cr_mock_sb1', kind: 'sandbox', backend: 'sandbox_v2', name: 'sandbox-x', displayName: 'python-dev', idc: s.idc_name ?? null, sku: 'gmi.sandbox.small', at: new Date().toISOString(), network: null });
    await e.journal.update('cr_mock_sb1', { state: 'unknown' });
    expect(await reconcileSandbox(e.lifecycleDeps, 'cr_mock_sb1')).toBe('confirmed');
    const rec = e.registry.get('cr_mock_sb1');
    expect(rec).toMatchObject({ lease: defaultLease('sandbox', 'computer'), approvedMaxLifetimeMin: 480, purpose: 'computer', installTag: s.metadata?.inst });
    expect(rec?.leaseChangedAt).not.toBeNull();
  });
});

describe('clients and error mapping', () => {
  it('GET /containers answering a non-array 200 is a failure (upstream), never an empty org', async () => {
    const fake = fakeHttp([{ match: '/api/v1/containers', method: 'GET', respond: () => json({ data: [] }) }]);
    const ce = createCeClient({ http: fake.http, log: silentLogger, keys: fakeComputeKeys() });
    await expect(ce.listContainers()).rejects.toMatchObject({ code: 'upstream' });
  });

  it('a 429 on a compute GET is not retried within seconds (Retry-After goes to the supervisor)', async () => {
    const fake = fakeHttp([{ match: '/api/v1/containers', method: 'GET', respond: () => new Response(JSON.stringify({ reason: 'slow down' }), { status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } }) }]);
    const ce = createCeClient({ http: fake.http, log: silentLogger, keys: fakeComputeKeys() });
    const err = await ce.listContainers().catch((x: unknown) => x);
    expect(err).toMatchObject({ code: 'rate_limited', retryAfterSec: 60 });
    expect(fake.requests).toHaveLength(1);
  });

  it('logs: a timeout while a Range-less 200 streams keeps the tail read so far (truncated, no auto-poll)', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('line one\nline two\nline three\n'));
      },
      pull(controller) {
        controller.error(new DOMException('The operation timed out.', 'TimeoutError'));
      },
    });
    const fake = fakeHttp([{ match: /\/logs$/, method: 'GET', respond: () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }) }]);
    const ce = createCeClient({ http: fake.http, log: silentLogger, keys: fakeComputeKeys() });
    const out = await ce.getLogs('c-1');
    expect(out).toMatchObject({ truncated: true, autoPoll: false, rangeSupported: false, totalBytes: null });
    expect(out.text).toContain('line three');
  });

  it('v2 Auth.Forbidden on an object is a permission refusal, not "not entitled"; on the list probe it is not_entitled', async () => {
    const body = JSON.stringify(v2Error('Auth.Forbidden', 'forbidden'));
    const e = computeErrorFrom({ family: 'v2', status: 403, body });
    expect(e.code).toBe('unauthorized');
    expect(e.message).toMatch(/creator or an organization owner/);
    expect(computeErrorFrom({ family: 'ce', status: 403, body: JSON.stringify({ reason: 'access denied: tenant has no permission to do the operation' }) }).code).toBe('not_entitled');

    const fake = fakeHttp([
      { match: /\/api\/v2\/sandboxes\?/, method: 'GET', respond: () => json(v2Error('Auth.Forbidden', 'forbidden'), 403) },
      { match: /\/api\/v2\/snapshots\/snap-1$/, method: 'DELETE', respond: () => json(v2Error('Auth.Forbidden', 'forbidden'), 403) },
    ]);
    const sb = createSandboxClient({ http: fake.http, log: silentLogger, keys: fakeComputeKeys() });
    await expect(sb.list()).rejects.toMatchObject({ code: 'not_entitled' });
    await expect(sb.deleteSnapshot('snap-1')).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('"Detect my IP" disclosure', () => {
  it("the wizard names the same echo service main calls (renderer and main constants stay equal)", async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { PUBLIC_IP_SERVICE } = await import('@main/services/compute');
    const src = await readFile(fileURLToPath(new URL('../../src/renderer/pages/compute/launch/AccessStep.tsx', import.meta.url)), 'utf8');
    expect(src).toContain(`export const DETECT_SERVICE = '${PUBLIC_IP_SERVICE}';`);
  });
});

describe('mock wiring', () => {
  it('keyGated: every simulated call first requires the Compute key', async () => {
    const keys = fakeComputeKeys(null);
    const api = keyGated({ list: async () => ['x'], value: 3 }, keys);
    expect(api.value).toBe(3);
    await expect(api.list()).rejects.toMatchObject({ code: 'no_compute_key' });
    keys.setKey('k-test-0000000000000');
    await expect(api.list()).resolves.toEqual(['x']);
  });
});
