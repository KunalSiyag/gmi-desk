// C1-C: the resource registry (types.ts `Registry`). Durable writes before resolve, tombstones with closed accrual,
// persisted in-flight executions and actionPending, defensive reading (unknown fields, including anything secret-looking,
// never survive a restart).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { durableWriteFile } from '@main/core/store';
import { closeIntervals, createRegistry, defaultLease, readRecord } from '@main/services/compute/registry';
import { COMPUTE_DATA_FILES, COMPUTE_TIMING } from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { rec } from './lifecycle-harness';

let t: TestContext;
afterEach(async () => t?.cleanup());

const file = () => join(t.ctx.paths.data, COMPUTE_DATA_FILES.registry);
const open = async (write?: typeof durableWriteFile) => {
  const r = createRegistry({ dataDir: t.ctx.paths.data, log: silentLogger, ...(write ? { write } : {}) });
  await r.load();
  return r;
};

describe('registry', () => {
  it('persists every add/update with durableWriteFile before the call resolves', async () => {
    t = await createTestContext();
    const writes: string[] = [];
    const write = vi.fn(async (path: string, data: string | Uint8Array, mode?: number) => {
      writes.push(String(data));
      await durableWriteFile(path, data, mode);
    });
    const r = await open(write as typeof durableWriteFile);
    await r.add(rec({ id: 'cr_a' }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(writes[0]).toContain('cr_a');
    expect(write.mock.calls[0]?.[2]).toBe(0o600);
    await r.update('cr_a', (x) => ({ ...x, displayName: 'renamed' }));
    expect(JSON.parse(await readFile(file(), 'utf8')).records[0].displayName).toBe('renamed');

    const again = await open();
    expect(again.get('cr_a')?.displayName).toBe('renamed');
  });

  it('rejects unknown ids, duplicate adds and id changes', async () => {
    t = await createTestContext();
    const r = await open();
    await expect(r.update('cr_nope', (x) => x)).rejects.toMatchObject({ code: 'not_found' });
    await r.add(rec({ id: 'cr_a' }));
    await expect(r.add(rec({ id: 'cr_a' }))).rejects.toMatchObject({ code: 'internal' });
    await expect(r.update('cr_a', (x) => ({ ...x, id: 'cr_b' }))).rejects.toMatchObject({ code: 'internal' });
  });

  it('tombstone closes open intervals, hides the record from list() and keeps it for accrual', async () => {
    t = await createTestContext();
    const r = await open();
    await r.add(rec({ id: 'cr_a', intervals: [{ from: '2026-11-01T10:00:00.000Z', to: null, usdPerHour: 3.35 }], actionPending: { action: 'delete', dueAt: '2026-11-01T11:00:00.000Z', attempts: 1, lastError: null } }));
    const dead = await r.tombstone('cr_a', '2026-11-01T12:00:00.000Z', 'Deleted.');
    expect(dead.phase).toBe('deleted');
    expect(dead.intervals).toEqual([{ from: '2026-11-01T10:00:00.000Z', to: '2026-11-01T12:00:00.000Z', usdPerHour: 3.35 }]);
    expect(dead.actionPending).toBeNull();
    expect(r.list()).toHaveLength(0);
    expect(r.list({ includeTombstones: true })).toHaveLength(1);
    expect(r.get('cr_a')?.tombstone?.reason).toBe('Deleted.');
  });

  it('drops tombstones older than 90 days at load, keeps younger ones', async () => {
    t = await createTestContext();
    const old = new Date(Date.now() - COMPUTE_TIMING.tombstoneKeepMs - 60_000).toISOString();
    const young = new Date(Date.now() - 60_000).toISOString();
    await writeFile(file(), JSON.stringify({ version: 1, records: [rec({ id: 'cr_old', tombstone: { at: old, reason: 'x' }, phase: 'deleted' }), rec({ id: 'cr_young', tombstone: { at: young, reason: 'x' }, phase: 'deleted' })] }));
    const r = await open();
    expect(r.list({ includeTombstones: true }).map((x) => x.id)).toEqual(['cr_young']);
  });

  it('persists in-flight executions and actionPending; unknown eids are a no-op', async () => {
    t = await createTestContext();
    const r = await open();
    await r.add(rec({ id: 'cr_sb', kind: 'sandbox' }));
    await r.addInflightExec({ eid: 'e1', resourceId: 'cr_sb', origin: 'agent', grantId: 'g1', timeoutSec: 60, startedAt: new Date().toISOString() });
    await r.addInflightExec({ eid: 'e1', resourceId: 'cr_sb', origin: 'agent', grantId: 'g1', timeoutSec: 60, startedAt: new Date().toISOString() });
    await expect(r.addInflightExec({ eid: 'e2', resourceId: 'cr_missing', origin: 'user', grantId: null, timeoutSec: 5, startedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'not_found' });
    await r.setActionPending('cr_sb', { action: 'pause', dueAt: new Date().toISOString(), attempts: 2, lastError: 'upstream' });
    const again = await open();
    expect(again.inflightExecs('cr_sb')).toHaveLength(1);
    expect(again.inflightExecs()[0]).toMatchObject({ eid: 'e1', origin: 'agent', grantId: 'g1' });
    expect(again.get('cr_sb')?.actionPending).toMatchObject({ action: 'pause', attempts: 2 });
    await again.removeInflightExec('e1');
    await again.removeInflightExec('unknown');
    expect(again.inflightExecs()).toEqual([]);
  });

  it('reads defensively: malformed records dropped, unknown fields (secrets) never survive', async () => {
    t = await createTestContext();
    const good = { ...rec({ id: 'cr_ok' }), envValues: { HF_TOKEN: 'hf_secret' }, urlPath: '/shell/abc', token: 'eyJ.secret' };
    await writeFile(file(), JSON.stringify({ version: 1, records: [good, { id: 'cr_bad' }, 42, null] }));
    const r = await open();
    expect(r.list().map((x) => x.id)).toEqual(['cr_ok']);
    await r.update('cr_ok', (x) => x);
    const text = await readFile(file(), 'utf8');
    expect(text).not.toContain('hf_secret');
    expect(text).not.toContain('/shell/abc');
    expect(text).not.toContain('eyJ.secret');
    expect(readRecord({ id: 'x', name: 'n', phase: 'nonsense' })).toBeNull();
  });

  it('a corrupt file is moved aside and the registry starts empty', async () => {
    t = await createTestContext();
    await writeFile(file(), '{not json');
    const r = await open();
    expect(r.list()).toEqual([]);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(t.ctx.paths.data)).some((f) => f.startsWith(`${COMPUTE_DATA_FILES.registry}.corrupt-`))).toBe(true);
  });

  it('notifies listeners after the write, with the changed ids; findByRemote/findByName', async () => {
    t = await createTestContext();
    const r = await open();
    const seen: string[][] = [];
    r.onChange((ids) => seen.push(ids));
    await r.add(rec({ id: 'cr_a', remoteId: 'c-1', name: 'gmid-abcdef-a-q1w2e3' }));
    expect(seen).toEqual([['cr_a']]);
    expect(r.findByRemote('ce', 'c-1')?.id).toBe('cr_a');
    expect(r.findByRemote('sandbox_v2', 'c-1')).toBeNull();
    expect(r.findByName('gmid-abcdef-a-q1w2e3')?.id).toBe('cr_a');
    // Snapshots: mutating a returned object does not change the registry.
    const copy = r.get('cr_a');
    if (copy) copy.displayName = 'hacked';
    expect(r.get('cr_a')?.displayName).toBe('cr_a');
  });

  it('closeIntervals never ends before the start; default leases match the decisions', () => {
    expect(closeIntervals([{ from: '2026-11-01T10:00:00.000Z', to: null, usdPerHour: 1 }], '2026-11-01T09:00:00.000Z')[0]?.to).toBe('2026-11-01T10:00:00.000Z');
    expect(defaultLease('container')).toEqual({ maxLifetimeMin: 240, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' });
    expect(defaultLease('sandbox')).toMatchObject({ maxLifetimeMin: 480, idlePauseMin: 20, extendOnActivity: true, onBudget: 'pause' });
    expect(defaultLease('sandbox', 'agent')).toMatchObject({ idlePauseMin: 10 });
  });
});
