// C1-C: sandbox lifecycle (§7.1, §7.3, §7.4) over the real v2 client and a fake fetch. Idempotency-Key = rid, explicit
// timeout, org-visible labels without PII, reconcile only by listing (incl. `deleted`), cold resume, token refresh.
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { createTokenCache, type TokenCache } from '@main/services/compute/sandbox/dataplane';
import {
  SNAPSHOT_SCRUB_COMMAND,
  createSandbox,
  deleteSandbox,
  pauseSandbox,
  reconcileSandbox,
  resumeSandbox,
  sandboxRequest,
  setSandboxTimeout,
  snapshotSandbox,
  type LifecycleDeps,
  type PreparedSandbox,
} from '@main/services/compute/sandbox/lifecycle';
import { json, v2Error } from './fakes';
import { httpEnv, rec, type HttpEnv } from './lifecycle-harness';

let env: HttpEnv;
afterEach(async () => env?.cleanup());

const V2 = 'https://console.gmicloud.ai/api/v2';
const RID = 'cr_00000000-0000-4000-8000-0000000000aa';
const created = { id: 'sbx-1', sandbox_key: 'k1', domain: 'iowa.sandbox.example.invalid', sandbox_access_token: 'sat-secret', traffic_access_token: 'tat-secret' };

function prepared(over: Partial<PreparedSandbox['spec']> = {}): PreparedSandbox {
  return {
    rid: RID,
    name: 'gmid-abcdef-dev-q1w2e3',
    displayName: 'dev',
    spec: {
      kind: 'sandbox',
      displayName: 'dev',
      idc: 'us-central-iowa2',
      product: 'gmi.sandbox.small',
      source: { templateId: 'tpl-python' },
      timeoutSec: 3600,
      onTimeout: 'pause',
      secure: true,
      egress: { mode: 'open' },
      env: [{ name: 'API_TOKEN', value: 'sk-user-secret', secret: true }],
      purpose: 'computer',
      threadId: null,
      lease: { maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 20, extendOnActivity: true, onBudget: 'pause' },
      ...over,
    },
    templateName: 'Python',
    listUsdPerHour: 0.0911,
    approvedMaxLifetimeMin: 480,
    label: '0123456789abcdef',
  };
}

let tokens: TokenCache;
function deps(e: HttpEnv, extra: Partial<LifecycleDeps> = {}): LifecycleDeps {
  tokens = createTokenCache({ connect: (id) => e.sandbox.connect(id) });
  return { sandbox: e.sandbox, tokens, dataPlane: null, registry: e.registry, journal: e.journal, alarms: e.alarms, prices: e.prices, supervisor: e.supervisor, log: silentLogger, sleep: e.sleep.sleep, ...extra };
}
const posts = (e: HttpEnv) => e.fake.requests.filter((r) => r.method === 'POST' && r.url === `${V2}/sandboxes`);

describe('sandbox create', () => {
  it('request: Idempotency-Key = rid, explicit timeout, auto_pause, labels without PII; tokens only in memory', async () => {
    env = await httpEnv([{ match: `${V2}/sandboxes`, method: 'POST', respond: () => json({ request_id: 'r', data: created }, 201) }]);
    const d = deps(env);
    const { record } = await createSandbox(d, prepared(), { now: () => new Date() });
    const req = posts(env)[0];
    expect(req?.headers['idempotency-key']).toBe(RID);
    const body = JSON.parse(req?.body ?? '{}');
    expect(body).toMatchObject({ template_id: 'tpl-python', product: 'gmi.sandbox.small', idc_name: 'us-central-iowa2', timeout: 3600, auto_pause: true, secure: true, env_vars: { API_TOKEN: 'sk-user-secret' } });
    expect(body.metadata).toEqual({ app: 'gmi-desk', inst: '0123456789abcdef', rid: RID, purpose: 'computer' });
    expect(body).not.toHaveProperty('egress_control');
    expect(tokens.peek('sbx-1')?.accessToken).toBe('sat-secret');
    expect(record).toMatchObject({ id: RID, remoteId: 'sbx-1', phase: 'creating', envNames: ['API_TOKEN'], secure: true, egressLocked: false });
    expect(JSON.stringify(env.registry.list()) + JSON.stringify(env.journal.list())).not.toMatch(/sat-secret|tat-secret|sk-user-secret/);
  });

  it('agent egress allowlist → egress_control + allowlist; onTimeout kill → auto_pause false; thread label ≤ 8 chars', () => {
    const body = sandboxRequest(prepared({ purpose: 'agent', onTimeout: 'kill', threadId: '5eed0000-0000-4000-8000-000000000001', egress: { mode: 'allowlist', hostnames: ['pypi.org'], cidrs: [] } }));
    expect(body).toMatchObject({ egress_control: true, egress: { allowed_hostnames: ['pypi.org'], allowed_cidrs: [] }, auto_pause: false });
    expect(body.metadata?.thr).toBe('5eed0000');
    expect(sandboxRequest(prepared({ source: { snapshotId: 'snap-1' } }))).toMatchObject({ snapshot_id: 'snap-1' });
  });

  it('an unclear create (HTML 502) → reconciled by listing metadata[rid] in default + deleted states, never re-POSTed', async () => {
    let listed = 0;
    env = await httpEnv([
      { match: `${V2}/sandboxes`, method: 'POST', respond: () => new Response('<html>502</html>', { status: 502 }) },
      {
        match: /\/api\/v2\/sandboxes\?/,
        method: 'GET',
        respond: (req) => {
          listed += 1;
          const deleted = req.url.includes('state=deleted');
          return json({ request_id: 'r', total: deleted ? 0 : 1, page: 1, page_size: 100, items: deleted ? [] : [{ id: 'sbx-1', state: 'running', metadata: { app: 'gmi-desk', rid: RID } }] });
        },
      },
      { match: `${V2}/sandboxes/sbx-1`, method: 'GET', respond: () => json({ request_id: 'r', data: { id: 'sbx-1', state: 'running', running_at: new Date().toISOString(), end_at: new Date(Date.now() + 3600_000).toISOString() } }) },
    ]);
    const { record, reconciled } = await createSandbox(deps(env), prepared(), { now: () => new Date() });
    expect(record.remoteId).toBeNull();
    expect(await reconciled).toBe('confirmed');
    expect(listed).toBe(2);
    const urls = env.fake.requests.filter((r) => r.method === 'GET' && r.url.includes('/sandboxes?')).map((r) => decodeURIComponent(r.url));
    expect(urls.every((u) => u.includes(`metadata[rid]=${RID}`))).toBe(true);
    expect(urls.some((u) => u.includes('state=deleted'))).toBe(true);
    expect(posts(env)).toHaveLength(1);
    expect(env.registry.get(RID)).toMatchObject({ remoteId: 'sbx-1', phase: 'running' });
  });

  it('Sandbox.IdempotentKeyConsumed → unknown → reconcile; a sandbox created then expired is found deleted and its accrual closes at deletion.requested_at', async () => {
    const requested = new Date(Date.now() - 30 * 60_000).toISOString();
    env = await httpEnv([
      { match: `${V2}/sandboxes`, method: 'POST', respond: () => json(v2Error('Sandbox.IdempotentKeyConsumed'), 409) },
      {
        match: /\/api\/v2\/sandboxes\?/,
        method: 'GET',
        respond: (req) => json({ request_id: 'r', total: 1, page: 1, page_size: 100, items: req.url.includes('state=deleted') ? [{ id: 'sbx-1', state: 'deleted', metadata: { rid: RID } }] : [] }),
      },
      {
        match: `${V2}/sandboxes/sbx-1`,
        method: 'GET',
        respond: () => json({ request_id: 'r', data: { id: 'sbx-1', state: 'deleted', created_at: new Date(Date.now() - 3600_000).toISOString(), running_at: new Date(Date.now() - 3600_000).toISOString(), deletion: { code: 'Sandbox.Expired', initiator: 'lifecycle', message: 'x', requested_at: requested, completed_at: null } } }),
      },
    ]);
    const { reconciled } = await createSandbox(deps(env), prepared(), { now: () => new Date() });
    expect(await reconciled).toBe('confirmed');
    const r = env.registry.get(RID);
    expect(r?.phase).toBe('deleted');
    expect(r?.tombstone).not.toBeNull();
    expect(r?.intervals.at(-1)?.to).toBe(requested);
    expect(r?.reason).toBe('Its time limit ran out.');
    expect(posts(env)).toHaveLength(1);
  });

  it('after a restart (journal `sent`) reconcile only lists; not found anywhere → failed_unknown + alarm, still no POST', async () => {
    env = await httpEnv([{ match: /\/api\/v2\/sandboxes\?/, method: 'GET', respond: () => json({ request_id: 'r', total: 0, page: 1, page_size: 100, items: [] }) }]);
    await env.journal.append({ rid: RID, kind: 'sandbox', backend: 'sandbox_v2', name: 'gmid-x', displayName: 'dev', idc: null, sku: 'gmi.sandbox.small', at: new Date().toISOString(), network: null });
    await env.journal.update(RID, { state: 'sent' });
    expect(await reconcileSandbox(deps(env), RID)).toBe('failed_unknown');
    expect(env.alarms.byKind('create_unknown')[0]).toMatchObject({ resourceId: RID, usdPerHour: 0.0911 });
    expect(env.fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('a definite refusal (quota) → journal failed, mapped error, no record', async () => {
    env = await httpEnv([{ match: `${V2}/sandboxes`, method: 'POST', respond: () => json(v2Error('Resource.QuotaExceeded', 'quota', { quota: 2, used: 2 }), 429) }]);
    await expect(createSandbox(deps(env), prepared(), { now: () => new Date() })).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(env.journal.get(RID)?.state).toBe('failed');
    expect(env.registry.list()).toHaveLength(0);
  });
});

describe('pause, resume, extend, delete, snapshot', () => {
  async function withSandbox(routes: Parameters<typeof httpEnv>[0]) {
    env = await httpEnv(routes);
    await env.registry.add(rec({ id: 'cr_sb', kind: 'sandbox', remoteId: 'sbx-1', phase: 'running', rawState: 'running' }));
    const d = deps(env);
    tokens.put({ ...created, end_at: new Date(Date.now() + 3600_000).toISOString() });
    return d;
  }

  it('pause → 202 pausing applied at once (transitional: fast polling)', async () => {
    const d = await withSandbox([{ match: /\/pause$/, method: 'POST', respond: () => json({ request_id: 'r', data: { id: 'sbx-1', state: 'pausing' } }, 202) }]);
    await pauseSandbox(d, env.registry.get('cr_sb') as never);
    expect(env.registry.get('cr_sb')?.phase).toBe('pausing');
  });

  it('resume sends the timeout, drops the cached token (cold resume) and notes it', async () => {
    const d = await withSandbox([{ match: /\/resume$/, method: 'POST', respond: () => json({ request_id: 'r', data: { id: 'sbx-1', state: 'resuming' } }, 202) }]);
    await env.registry.update('cr_sb', (r) => ({ ...r, phase: 'paused', rawState: 'paused' }));
    await resumeSandbox(d, env.registry.get('cr_sb') as never, 1800);
    expect(JSON.parse(env.fake.requests.at(-1)?.body ?? '{}')).toEqual({ timeout: 1800 });
    expect(tokens.peek('sbx-1')).toBeNull();
    expect(env.registry.get('cr_sb')?.phase).toBe('resuming');
    expect(env.registry.get('cr_sb')?.history[0]?.note).toMatch(/cold resume/);
  });

  it('extend (POST /timeout) stores GMI new_end_at and refreshes the token (re-signed)', async () => {
    const end = new Date(Date.now() + 7200_000).toISOString();
    const d = await withSandbox([{ match: /\/timeout$/, method: 'POST', respond: () => json({ request_id: 'r', data: { id: 'sbx-1', old_end_at: 'x', new_end_at: end } }) }]);
    expect(await setSandboxTimeout(d, env.registry.get('cr_sb') as never, 7200.4)).toBe(end);
    expect(JSON.parse(env.fake.requests.at(-1)?.body ?? '{}')).toEqual({ timeout: 7200 });
    expect(env.registry.get('cr_sb')?.serverEndsAt).toBe(end);
    expect(tokens.peek('sbx-1')).toBeNull();
  });

  it('delete: 200 deleted → tombstone; a 404 counts as deleted (safe to repeat)', async () => {
    const d = await withSandbox([{ match: `${V2}/sandboxes/sbx-1`, method: 'DELETE', respond: () => json(v2Error('Resource.NotFound'), 404) }]);
    await deleteSandbox(d, env.registry.get('cr_sb') as never);
    expect(env.registry.get('cr_sb')?.phase).toBe('deleted');
    expect(env.registry.list()).toHaveLength(0);
  });

  it('snapshot: only while running; the scrub exec runs the fixed command first; labels this install', async () => {
    const execs: Array<{ command: string }> = [];
    const d = await withSandbox([{ match: `${V2}/snapshots`, method: 'POST', respond: (req) => json({ request_id: 'r', data: { snapshot_id: 'snap-1', status: 'creating', ...JSON.parse(req.body ?? '{}') } }) }]);
    d.dataPlane = { exec: async (_id, input) => {
      execs.push({ command: input.command });
      return { request_id: 'r', execution_id: 'e', sandbox_id: 'k1', status: 'succeeded', exit_code: 0, stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false, started_at: null, completed_at: null };
    } };
    const snap = await snapshotSandbox(d, env.registry.get('cr_sb') as never, { name: 'dev-1', scrub: true, label: 'lbl' });
    expect(execs).toEqual([{ command: SNAPSHOT_SCRUB_COMMAND }]);
    expect(JSON.parse(env.fake.requests.at(-1)?.body ?? '{}')).toEqual({ sandbox_id: 'sbx-1', name: 'dev-1', metadata: { app: 'gmi-desk', inst: 'lbl', rid: 'cr_sb' } });
    expect(snap.snapshot_id).toBe('snap-1');
    await env.registry.update('cr_sb', (r) => ({ ...r, phase: 'paused' }));
    await expect(snapshotSandbox(d, env.registry.get('cr_sb') as never, { name: 'x', scrub: false, label: 'lbl' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
