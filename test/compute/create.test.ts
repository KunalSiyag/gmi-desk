// C1-C: container create + reconcile (§6.2, §11, DC3) over the real CE client and a fake fetch. Exactly one POST, the
// journal is on disk before it, unclear outcomes are reconciled by name and never re-sent; install-tagged names.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { createContainer, reconcileContainer, RECONCILE_DELAYS_MS, type CreateDeps, type PreparedContainer } from '@main/services/compute/ce/create';
import { createJournal } from '@main/services/compute/journal';
import { base32, containerOwnership, displayNameFromRemote, installLabel, installTag, remoteName, slug } from '@main/services/compute/names';
import { COMPUTE_DATA_FILES } from '@main/services/compute/types';
import { TEST_INSTALL_ID } from '../helpers/context';
import { htmlPage, json } from './fakes';
import { httpEnv, type HttpEnv } from './lifecycle-harness';

let env: HttpEnv;
afterEach(async () => env?.cleanup());

const NAME = 'gmid-abcdef-box-q1w2e3';
const LIST = /\/api\/v1\/containers$/;
const container = (over: Record<string, unknown> = {}) => ({ id: 'c-1', name: NAME, idc: 'asia-east-taiwan3', product: 'gmi.container.nv.H200x1.tw3', templateId: 't1', status: 'creating', reason: '', storages: [], createdAt: new Date().toISOString(), ...over });

function prepared(rid = 'cr_00000000-0000-4000-8000-000000000001'): PreparedContainer {
  return {
    rid,
    name: NAME,
    displayName: 'box',
    spec: {
      kind: 'container',
      displayName: 'box',
      idc: 'asia-east-taiwan3',
      sku: 'gmi.container.nv.H200x1.tw3',
      templateId: 't1',
      env: [{ name: 'HF_TOKEN', value: 'hf_secret_value', secret: true }],
      ssh: { mode: 'none' },
      access: { mode: 'none' },
      lease: { maxLifetimeMin: 240, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' },
    },
    templateName: 'Jupyter',
    listUsdPerHour: 3.35,
    sshKeyIds: [],
    network: null,
    approvedMaxLifetimeMin: 240,
  };
}

const deps = (e: HttpEnv): CreateDeps => ({ ce: e.ce, registry: e.registry, journal: e.journal, alarms: e.alarms, prices: e.prices, supervisor: e.supervisor, log: silentLogger, sleep: e.sleep.sleep });
const ctx = { installTag: 'abcdef', now: () => new Date() };
const posts = (e: HttpEnv) => e.fake.requests.filter((r) => r.method === 'POST' && LIST.test(r.url)).length;
const journalOnDisk = async (e: HttpEnv) => JSON.parse(await readFile(join(e.t.ctx.paths.data, COMPUTE_DATA_FILES.journal), 'utf8')).entries as Array<{ rid: string; state: string }>;

describe('create: one POST behind a durable journal', () => {
  it('confirmed: `sent` is on disk before the POST; record added; env values never stored', async () => {
    let stateAtPost: string | null = null;
    env = await httpEnv([
      {
        match: LIST,
        method: 'POST',
        respond: async () => {
          stateAtPost = (await journalOnDisk(env))[0]?.state ?? null;
          return json([{ id: 'c-1' }]);
        },
      },
    ]);
    const { record, reconciled } = await createContainer(deps(env), prepared(), ctx);
    expect(stateAtPost).toBe('sent');
    expect(reconciled).toBeNull();
    expect(posts(env)).toBe(1);
    expect(JSON.parse(env.fake.requests[0]?.body ?? '{}')).toMatchObject({ count: 1, name: NAME, envs: [{ name: 'HF_TOKEN', value: 'hf_secret_value' }] });
    expect(record).toMatchObject({ remoteId: 'c-1', phase: 'creating', managed: true, envNames: ['HF_TOKEN'], installTag: 'abcdef' });
    expect(env.journal.get(record.id)?.state).toBe('confirmed');
    const disk = (await readFile(join(env.t.ctx.paths.data, COMPUTE_DATA_FILES.registry), 'utf8')) + (await readFile(join(env.t.ctx.paths.data, COMPUTE_DATA_FILES.journal), 'utf8'));
    expect(disk).not.toContain('hf_secret_value');
  });

  it('a definite failure (parsed 400) → journal failed, error thrown, no record', async () => {
    env = await httpEnv([{ match: LIST, method: 'POST', respond: () => json({ reason: 'template t1 was not found' }, 404) }]);
    await expect(createContainer(deps(env), prepared(), ctx)).rejects.toMatchObject({ code: 'not_found' });
    expect(env.journal.list()[0]?.state).toBe('failed');
    expect(env.registry.list()).toEqual([]);
    expect(posts(env)).toBe(1);
  });

  it.each([
    ['a network error / timeout', () => Promise.reject(new TypeError('fetch failed'))],
    ['504', () => new Response('gateway timeout', { status: 504 })],
    ['429 from Cloudflare', () => new Response('error code: 1015', { status: 429 })],
    ['an HTML challenge page', () => new Response(htmlPage, { status: 403, headers: { 'content-type': 'text/html' } })],
    ['an odd 200', () => json({ id: 'c-1' })],
    ['409', () => json({ reason: 'busy' }, 409)],
  ])('%s → unknown → reconciled by name, never a second POST', async (_label, respond) => {
    let listed = 0;
    env = await httpEnv([
      { match: LIST, method: 'POST', respond },
      {
        match: LIST,
        method: 'GET',
        respond: () => {
          listed += 1;
          // The container shows up on the second listing (+5 s).
          return json(listed >= 2 ? [container()] : []);
        },
      },
    ]);
    const { record, reconciled } = await createContainer(deps(env), prepared(), ctx);
    expect(record.remoteId).toBeNull();
    expect(env.journal.get(record.id)?.state).toBe('unknown');
    expect(await reconciled).toBe('confirmed');
    expect(env.sleep.delays).toEqual([RECONCILE_DELAYS_MS[1]]);
    expect(env.journal.get(record.id)).toMatchObject({ state: 'confirmed', remoteId: 'c-1' });
    expect(env.registry.get(record.id)).toMatchObject({ remoteId: 'c-1', tombstone: null });
    expect(posts(env)).toBe(1);
  });

  it('never found after +5/+15/+45/+120 s → failed_unknown, create_unknown alarm, record tombstoned, still one POST', async () => {
    env = await httpEnv([
      { match: LIST, method: 'POST', respond: () => new Response('upstream', { status: 502 }) },
      { match: LIST, method: 'GET', respond: () => json([]) },
    ]);
    const { record, reconciled } = await createContainer(deps(env), prepared(), ctx);
    expect(await reconciled).toBe('failed_unknown');
    expect(env.sleep.delays).toEqual([5_000, 15_000, 45_000, 120_000]);
    expect(env.journal.get(record.id)?.state).toBe('failed_unknown');
    expect(env.alarms.byKind('create_unknown')).toHaveLength(1);
    expect(env.alarms.byKind('create_unknown')[0]).toMatchObject({ resourceId: record.id, severity: 'critical', usdPerHour: 3.35 });
    expect(env.registry.list()).toEqual([]);
    expect(posts(env)).toBe(1);
    // Re-checked (sweep) while still missing: stays failed_unknown, nothing is POSTed.
    expect(await reconcileContainer(deps(env), record.id)).toBe('failed_unknown');
    expect(posts(env)).toBe(1);
  });

  it('a late container is adopted by a later reconcile (sweep) under its rid', async () => {
    let appear = false;
    env = await httpEnv([
      { match: LIST, method: 'POST', respond: () => new Response('upstream', { status: 502 }) },
      { match: LIST, method: 'GET', respond: () => json(appear ? [container({ status: 'running' })] : []) },
    ]);
    const { record, reconciled } = await createContainer(deps(env), prepared(), ctx);
    expect(await reconciled).toBe('failed_unknown');
    appear = true;
    expect(await reconcileContainer(deps(env), record.id)).toBe('confirmed');
    expect(env.registry.get(record.id)).toMatchObject({ remoteId: 'c-1', tombstone: null, phase: 'running' });
    expect(env.alarms.byKind('create_unknown')).toHaveLength(0);
    expect(env.alarms.byKind('orphan')[0]).toMatchObject({ resourceId: record.id });
    expect(posts(env)).toBe(1);
  });

  it('crash between the journal and the POST: `intent` at startup → one listing, not found → failed (never sent)', async () => {
    env = await httpEnv([{ match: LIST, method: 'GET', respond: () => json([]) }]);
    await env.journal.append({ rid: 'cr_crash', kind: 'container', backend: 'ce', name: NAME, displayName: 'box', idc: 'asia-east-taiwan3', sku: 'gmi.container.nv.H200x1.tw3', at: new Date().toISOString(), network: null });
    // A new process: a fresh journal instance reads the file.
    const reloaded = createJournal({ dataDir: env.t.ctx.paths.data, log: silentLogger });
    await reloaded.load();
    const d = { ...deps(env), journal: reloaded };
    expect(await reconcileContainer(d, 'cr_crash')).toBe('failed');
    expect(reloaded.get('cr_crash')).toMatchObject({ state: 'failed', error: 'not_sent' });
    expect(env.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('power loss right after the POST (`sent` at startup) → found by name → confirmed and recorded', async () => {
    env = await httpEnv([{ match: LIST, method: 'GET', respond: () => json([container({ status: 'running' })]) }]);
    await env.journal.append({ rid: 'cr_sent', kind: 'container', backend: 'ce', name: NAME, displayName: 'box', idc: 'asia-east-taiwan3', sku: 'gmi.container.nv.H200x1.tw3', at: new Date().toISOString(), network: null });
    await env.journal.update('cr_sent', { state: 'sent' });
    expect(await reconcileContainer(deps(env), 'cr_sent')).toBe('confirmed');
    expect(env.registry.get('cr_sent')).toMatchObject({ remoteId: 'c-1', managed: true, phase: 'running', listUsdPerHour: 3.35 });
    expect(env.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('more than one container with the name (impossible by nonce) → all adopted, critical alarm', async () => {
    env = await httpEnv([{ match: LIST, method: 'GET', respond: () => json([container(), container({ id: 'c-2' })]) }]);
    await env.journal.append({ rid: 'cr_dup', kind: 'container', backend: 'ce', name: NAME, displayName: 'box', idc: 'asia-east-taiwan3', sku: 'gmi.container.nv.H200x1.tw3', at: new Date().toISOString(), network: null });
    await env.journal.update('cr_dup', { state: 'unknown' });
    expect(await reconcileContainer(deps(env), 'cr_dup')).toBe('confirmed');
    expect(env.registry.list().map((r) => r.remoteId).sort()).toEqual(['c-1', 'c-2']);
    expect(env.alarms.byKind('orphan').some((a) => a.severity === 'critical')).toBe(true);
  });

  it('without a key the reconcile stays pending (no listing, nothing marked failed)', async () => {
    env = await httpEnv([]);
    env.keys.setKey(null);
    await env.journal.append({ rid: 'cr_k', kind: 'container', backend: 'ce', name: NAME, displayName: 'box', idc: null, sku: 'x', at: new Date().toISOString(), network: null });
    await env.journal.update('cr_k', { state: 'unknown' });
    expect(await reconcileContainer(deps(env), 'cr_k')).toBe('pending');
    expect(env.journal.get('cr_k')?.state).toBe('unknown');
    expect(env.fake.requests).toHaveLength(0);
  });
});

describe('names (§6.1, §7.1)', () => {
  it('remote names are gmid-<inst6>-<slug ≤ 24>-<nonce6>, inst6 = base32(sha256(installId))', () => {
    const tag = installTag(TEST_INSTALL_ID);
    expect(tag).toMatch(/^[a-z2-7]{6}$/);
    expect(installTag(TEST_INSTALL_ID)).toBe(tag);
    expect(installTag('ffffffffffffffffffffffffffffffff')).not.toBe(tag);
    const name = remoteName(TEST_INSTALL_ID, 'My Training Box: H200 (big run) for the team');
    expect(name).toMatch(new RegExp(`^gmid-${tag}-[a-z0-9-]{1,24}-[a-z2-7]{6}$`));
    expect(name).toMatch(/^([A-Za-z0-9][A-Za-z0-9_\-. ]*)?[A-Za-z0-9]$/);
    expect(remoteName(TEST_INSTALL_ID, 'x')).not.toBe(remoteName(TEST_INSTALL_ID, 'x'));
    expect(slug('  ---  ')).toBe('box');
    expect(slug('Hello World')).toBe('hello-world');
    expect(displayNameFromRemote(`gmid-${tag}-hello-world-abcdef`)).toBe('hello-world');
    expect(base32(new Uint8Array([0xff]))).toBe('74');
  });

  it('ownership: this install / another install / unmanaged; labels are random hex, not PII', () => {
    expect(containerOwnership('gmid-abcdef-x-q1w2e3', 'abcdef')).toBe('this_install');
    expect(containerOwnership('gmid-zzzzzz-x-q1w2e3', 'abcdef')).toBe('other_install');
    expect(containerOwnership('research-box', 'abcdef')).toBe('unmanaged');
    expect(containerOwnership('gmid-ABCDEF-x', 'abcdef')).toBe('unmanaged');
    expect(installLabel(TEST_INSTALL_ID)).toMatch(/^[0-9a-f]{16}$/);
  });
});
