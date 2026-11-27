// C1-B: the dev trace (§17). A recorded create and connect response holds no token value; data-plane bodies are never
// traced; the trace is off unless GMI_DESK_TRACE=1.
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createCeClient } from '@main/services/compute/ce/client';
import { createDataPlane, createTokenCache } from '@main/services/compute/sandbox/dataplane';
import { createSandboxClient } from '@main/services/compute/sandbox/client';
import { createComputeTrace, traceEnabled, traceLine } from '@main/services/compute/sanitize';
import { silentLogger } from '@main/core/logger';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeComputeKeys, fakeHttp, json } from './fakes';

const SAT = 'sat-SECRET-0123456789abcdef';
const TAT = 'tat-SECRET-fedcba9876543210';
const ENV_SECRET = 'env-SECRET-value-xyz';
const URL_PATH_SECRET = '/terminal?token=urlpath-SECRET-1';
const STDOUT_SECRET = 'stdout-SECRET-contents';

let t: TestContext | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function setup() {
  t = await createTestContext();
  const trace = createComputeTrace({ logsDir: t.ctx.paths.logs, enabled: true, now: () => new Date('2026-11-02T10:00:00Z') });
  if (!trace) throw new Error('trace should be on');
  const created = { id: 'sbx-1', sandbox_key: 'mk1', domain: 'iowa2.sandbox.example', sandbox_access_token: SAT, traffic_access_token: TAT };
  const fake = fakeHttp([
    { match: /\/api\/v2\/sandboxes$/, method: 'POST', respond: () => json({ request_id: 'req-create', data: created }, 201) },
    { match: /\/sandboxes\/sbx-1\/connect$/, respond: () => json({ request_id: 'req-connect', data: { ...created, end_at: '2026-11-02T11:00:00Z' } }) },
    { match: /\/api\/v1\/containers$/, method: 'GET', respond: () => json([{ id: 'c1', name: 'n', idc: 'i', product: 'p', templateId: 't', status: 'running', reason: '', storages: [], envs: [{ name: 'HF_TOKEN', value: ENV_SECRET }] }]) },
    { match: /\/containers\/c1\/shell$/, respond: () => json({ urlPath: URL_PATH_SECRET }) },
    { match: /mk1\.iowa2\.sandbox\.example\/executions/, respond: () => json({ request_id: 'req-exec', execution_id: 'e1', sandbox_id: 'mk1', status: 'succeeded', exit_code: 0, stdout: STDOUT_SECRET, stderr: '' }) },
  ]);
  const keys = fakeComputeKeys();
  const sandbox = createSandboxClient({ http: fake.http, log: silentLogger, keys, trace });
  const ce = createCeClient({ http: fake.http, log: silentLogger, keys, trace });
  const tokens = createTokenCache({ connect: (id) => sandbox.connect(id) });
  const dp = createDataPlane({ http: fake.http, log: silentLogger, tokens, trace });
  return { trace, sandbox, ce, dp, fake };
}

describe('compute trace', () => {
  it('a recorded create and connect contain no token value', async () => {
    const { trace, sandbox } = await setup();
    const out = await sandbox.create({ template_id: 'tpl', timeout: 300, env_vars: { API: ENV_SECRET } }, { idempotencyKey: 'cr_0123456789abcdef' });
    expect(out.outcome).toBe('confirmed');
    await sandbox.connect('sbx-1');
    await trace.flush();
    const text = await readFile(trace.file, 'utf8');
    expect(text).toContain('req-create');
    expect(text).toContain('req-connect');
    expect(text).toContain('"sandbox_key":"mk1"');
    for (const secret of [SAT, TAT, ENV_SECRET]) expect(text).not.toContain(secret);
    expect(trace.file).toMatch(/trace-compute-20261102\.jsonl$/);
  });

  it('CE env values and the shell urlPath never reach the trace', async () => {
    const { trace, ce } = await setup();
    await ce.listContainers();
    const shell = await ce.containerShell('c1');
    expect(shell.urlPath).toBe(URL_PATH_SECRET);
    await trace.flush();
    const text = await readFile(trace.file, 'utf8');
    expect(text).not.toContain(ENV_SECRET);
    expect(text).not.toContain('urlpath-SECRET');
    expect(text).toContain('HF_TOKEN');
  });

  it('data-plane bodies are never traced: status, sizes, request ids only', async () => {
    const { trace, dp } = await setup();
    const r = await dp.exec('sbx-1', { command: 'echo', timeoutSec: 30 });
    expect(r.stdout).toBe(STDOUT_SECRET);
    await trace.flush();
    const lines = (await readFile(trace.file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const dpLine = lines.find((l) => l.api === 'dataplane');
    expect(dpLine).toMatchObject({ method: 'POST', path: '/executions', status: 200 });
    expect(dpLine?.body).toBeUndefined();
    expect(JSON.stringify(lines)).not.toContain(STDOUT_SECRET);
    expect(JSON.stringify(lines)).not.toContain(SAT);
    // The data-plane host (sandbox key + domain) is never written either: paths only.
    expect(JSON.stringify(lines.filter((l) => l.api === 'dataplane'))).not.toContain('iowa2.sandbox.example');
  });

  it('traceLine drops a body passed for the data plane and strips query strings', () => {
    const line = JSON.parse(traceLine({ api: 'dataplane', method: 'GET', path: '/files?path=/root/x', status: 200, requestId: 'r', bytes: 3, ms: 1, body: { secret: 'x' } }, new Date(0)));
    expect(line.body).toBeUndefined();
    expect(line.path).toBe('/files');
  });

  it('is off unless GMI_DESK_TRACE=1', async () => {
    t = await createTestContext();
    expect(traceEnabled({})).toBe(false);
    expect(traceEnabled({ GMI_DESK_TRACE: '1' })).toBe(true);
    expect(traceEnabled({ GMI_DESK_TRACE: 'true' })).toBe(false);
    expect(createComputeTrace({ logsDir: t.ctx.paths.logs, enabled: false })).toBeNull();
  });
});
