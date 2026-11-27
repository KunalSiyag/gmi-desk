// C1-B: the v2 data plane. Explicit execution timeout; a wait that times out is polled until terminal; abort cancels;
// single-flight token refresh; upload `[]` is an error; Range resume only on 206.
import { describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import {
  EXEC_POLL_DELAYS_MS,
  TOKEN_REFRESH_BEFORE_MS,
  assertRemotePath,
  createDataPlane,
  createTokenCache,
  dataPlaneAccessFrom,
  validateExecInput,
  type ExecInput,
} from '@main/services/compute/sandbox/dataplane';
import type { V2ConnectResult } from '@main/services/compute/sandbox/dto';
import { fakeHttp, instantSleep, json, v2Error } from './fakes';

const HOST = 'mk1.iowa2.sandbox.example';
let tokenSeq = 0;
const connectResult = (over: Partial<V2ConnectResult> = {}): V2ConnectResult => ({
  id: 'sbx-1',
  sandbox_key: 'mk1',
  domain: 'iowa2.sandbox.example',
  sandbox_access_token: `sat-${++tokenSeq}`,
  traffic_access_token: 'tat',
  end_at: '2099-01-01T00:00:00Z',
  ...over,
});

function setup(routes: Parameters<typeof fakeHttp>[0], opts: { connect?: () => Promise<V2ConnectResult>; now?: () => Date } = {}) {
  const fake = fakeHttp(routes);
  const connects: number[] = [];
  const tokens = createTokenCache({ connect: async () => (connects.push(1), opts.connect ? opts.connect() : connectResult()), now: opts.now });
  const sleeper = instantSleep();
  const dp = createDataPlane({ http: fake.http, log: silentLogger, tokens, sleep: sleeper.sleep });
  return { dp, tokens, connects, sleeper, ...fake };
}

const execBody = (status: string, over: Record<string, unknown> = {}) => ({ request_id: 'req-x', execution_id: 'e1', sandbox_id: 'mk1', status, exit_code: status === 'succeeded' ? 0 : null, stdout: 'out', stderr: '', ...over });

describe('exec', () => {
  it('always sends execution_timeout_seconds, wait=true and a 25 s wait; the token in X-Access-Token', async () => {
    const { dp, requests } = setup([{ match: `${HOST}/executions`, respond: () => json(execBody('succeeded')) }]);
    const r = await dp.exec('sbx-1', { command: 'ls "$GMID_P"', envs: { GMID_P: '/root/app' }, timeoutSec: 30 });
    expect(r).toMatchObject({ status: 'succeeded', exit_code: 0, stdout: 'out' });
    const req = requests[0];
    const url = new URL(req?.url ?? '');
    expect(url.host).toBe(HOST);
    expect(url.searchParams.get('wait')).toBe('true');
    expect(url.searchParams.get('wait_timeout_seconds')).toBe('25');
    expect(req?.headers['x-access-token']).toBe('sat-' + String(tokenSeq));
    expect(req?.headers.authorization).toBeUndefined();
    expect(JSON.parse(req?.body ?? '{}')).toEqual({ action: 'exec', parameters: { command: 'ls "$GMID_P"', envs: { GMID_P: '/root/app' }, execution_timeout_seconds: 30 } });
  });

  it('a wait that times out (202) is polled until terminal; onAccepted fires first with the eid', async () => {
    let polls = 0;
    const events: string[] = [];
    const { dp, requests, sleeper } = setup([
      { match: `${HOST}/executions/e1`, method: 'GET', respond: () => (events.push('poll'), json(execBody(++polls < 3 ? 'running' : 'succeeded'))) },
      { match: `${HOST}/executions`, method: 'POST', respond: () => json(execBody('running'), 202) },
    ]);
    const r = await dp.exec('sbx-1', { command: 'sleep 60', timeoutSec: 120, onAccepted: (eid) => void events.push(`accepted:${eid}`) });
    expect(r.status).toBe('succeeded');
    expect(events).toEqual(['accepted:e1', 'poll', 'poll', 'poll']);
    expect(requests.filter((q) => q.method === 'POST')).toHaveLength(1);
    expect(sleeper.delays).toEqual(EXEC_POLL_DELAYS_MS.slice(0, 3));
  });

  it('aborting while it runs cancels the remote execution', async () => {
    const ac = new AbortController();
    const { dp, requests } = setup([
      { match: `${HOST}/executions/e1/cancel`, method: 'POST', respond: () => json({}, 202) },
      { match: `${HOST}/executions/e1`, method: 'GET', respond: () => (ac.abort(), json(execBody('running'))) },
      { match: `${HOST}/executions`, method: 'POST', respond: () => json(execBody('pending'), 202) },
    ]);
    await expect(dp.exec('sbx-1', { command: 'sleep 600', timeoutSec: 900, signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(requests.some((q) => q.method === 'POST' && q.url.endsWith('/executions/e1/cancel'))).toBe(true);
  });

  it('cancel: 409 AlreadyCompleted is fine; the POST is never retried', async () => {
    const { dp, requests } = setup([{ match: '/cancel', respond: () => json(v2Error('Execution.AlreadyCompleted'), 409) }]);
    await dp.cancelExecution('sbx-1', 'e1');
    const b = setup([{ match: '/cancel', respond: () => json(v2Error('System.Internal'), 503) }]);
    await expect(b.dp.cancelExecution('sbx-1', 'e1')).rejects.toMatchObject({ code: 'upstream' });
    expect(requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it('the exec POST is never retried on 5xx / 429', async () => {
    const { dp, requests } = setup([{ match: '/executions', respond: () => json(v2Error('Execution.ConcurrencyLimitExceeded'), 429) }]);
    await expect(dp.exec('sbx-1', { command: 'true', timeoutSec: 5 })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(requests).toHaveLength(1);
  });

  it('validates input before any request', async () => {
    const { dp, requests } = setup([]);
    const bads: ExecInput[] = [
      { command: 'x', timeoutSec: 0 },
      { command: 'x', timeoutSec: 3601 },
      { command: 'x', timeoutSec: 1.5 },
      { command: '', timeoutSec: 5 },
      { command: 'a\0b', timeoutSec: 5 },
      { command: 'x', timeoutSec: 5, envs: { 'BAD-NAME': '1' } },
      { command: 'x', timeoutSec: 5, envs: { OK: 'x'.repeat(64 * 1024 + 1) } },
      { command: 'x', timeoutSec: 5, cwd: 'relative' },
      { command: 'x'.repeat(128 * 1024 + 1), timeoutSec: 5 },
    ];
    for (const bad of bads) {
      await expect(dp.exec('sbx-1', bad)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(requests).toHaveLength(0);
    expect(() => validateExecInput({ command: 'ok', timeoutSec: 3600 })).not.toThrow();
  });
});

describe('tokens (§7.2)', () => {
  it('a data-plane 401 → one connect, then the request again; concurrent 401s share the connect', async () => {
    let first = true;
    const { dp, connects, requests } = setup([
      {
        match: '/executions',
        respond: (r) => {
          if (r.headers['x-access-token'] === 'sat-stale' || first) {
            return json(v2Error('Auth.Unauthorized'), 401);
          }
          return json(execBody('succeeded'));
        },
      },
    ], {
      connect: async () => {
        const c = connectResult(first ? { sandbox_access_token: 'sat-stale' } : {});
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return c;
      },
    });
    const results = await Promise.all([dp.exec('sbx-1', { command: 'a', timeoutSec: 5 }), dp.exec('sbx-1', { command: 'b', timeoutSec: 5 })]);
    expect(results.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
    expect(connects).toHaveLength(2); // the initial get (shared) + one refresh (shared)
    expect(requests.filter((q) => q.method === 'POST')).toHaveLength(4);
  });

  it('a second 401 after the refresh is an error (no loop)', async () => {
    const { dp, connects } = setup([{ match: '/executions', respond: () => json(v2Error('Auth.Unauthorized'), 401) }]);
    await expect(dp.exec('sbx-1', { command: 'a', timeoutSec: 5 })).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect(connects).toHaveLength(2);
  });

  it('refreshes 60 s before end_at; invalidate forces a new connect; put seeds without a connect', async () => {
    let now = Date.parse('2026-11-02T10:00:00Z');
    const endAt = new Date(now + 10 * 60_000).toISOString();
    const calls: number[] = [];
    const tokens = createTokenCache({ connect: async () => (calls.push(1), connectResult({ end_at: endAt })), now: () => new Date(now) });
    await tokens.get('sbx-1');
    await tokens.get('sbx-1');
    expect(calls).toHaveLength(1);
    now = Date.parse(endAt) - TOKEN_REFRESH_BEFORE_MS + 1;
    await tokens.get('sbx-1');
    expect(calls).toHaveLength(2);
    tokens.invalidate('sbx-1');
    expect(tokens.peek('sbx-1')).toBeNull();
    await tokens.get('sbx-1');
    expect(calls).toHaveLength(3);
    const seeded = tokens.put({ id: 'sbx-9', sandbox_key: 'mk9', domain: 'iowa2.sandbox.example', sandbox_access_token: 's', traffic_access_token: 't' });
    expect(seeded).toMatchObject({ host: 'mk9.iowa2.sandbox.example', endAt: null });
    expect(await tokens.get('sbx-9')).toBe(seeded);
    expect(calls).toHaveLength(3);
  });

  it('a connect that started before invalidate does not repopulate the cache', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tokens = createTokenCache({ connect: async () => (await gate, connectResult()) });
    const pending = tokens.get('sbx-1');
    tokens.invalidate('sbx-1');
    release();
    await pending;
    expect(tokens.peek('sbx-1')).toBeNull();
  });

  it('the host comes only from GMI and is checked', () => {
    const now = new Date();
    expect(() => dataPlaneAccessFrom(connectResult({ domain: 'evil.example/x' }), now)).toThrow();
    expect(() => dataPlaneAccessFrom(connectResult({ sandbox_key: 'a@b' }), now)).toThrow();
    expect(() => dataPlaneAccessFrom(connectResult({ domain: 'localhost' }), now)).toThrow();
    expect(() => dataPlaneAccessFrom(connectResult({ sandbox_access_token: '' }), now)).toThrow();
    expect(dataPlaneAccessFrom(connectResult({ domain: 'IOWA2.Sandbox.Example' }), now).baseUrl).toBe(`https://${HOST}`);
  });
});

describe('files', () => {
  it('write: POST /files?path=<abs>; an empty array is an error', async () => {
    let answer: unknown = [{ path: '/root/a.txt', name: 'a.txt', type: 'file' }];
    const { dp, requests } = setup([{ match: `${HOST}/files`, method: 'POST', respond: () => json(answer) }]);
    expect(await dp.writeFile('sbx-1', '/root/a.txt', 'hello')).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? '').searchParams.get('path')).toBe('/root/a.txt');
    answer = [];
    await expect(dp.writeFile('sbx-1', '/root/a.txt', 'hello')).rejects.toMatchObject({ code: 'upstream', message: 'GMI did not store the file.' });
    expect(requests).toHaveLength(2);
  });

  it('write sends a FormData whose part is named "file"', async () => {
    let form: FormData | null = null;
    const { createHttp } = await import('@main/core/http');
    const http = createHttp({
      userAgent: 't',
      log: silentLogger,
      fetch: async (_url, init) => {
        form = init?.body as FormData;
        return json([{ path: '/root/x', name: 'x', type: 'file' }]);
      },
    });
    const tokens = createTokenCache({ connect: async () => connectResult() });
    const dp = createDataPlane({ http, log: silentLogger, tokens });
    await dp.writeFile('sbx-1', '/root/x', new Uint8Array([1, 2, 3]));
    const f = form as FormData | null;
    expect(f).toBeInstanceOf(FormData);
    const part = f?.get('file');
    expect(part).toBeInstanceOf(Blob);
    expect((part as Blob).size).toBe(3);
  });

  it('paths must be absolute and normalised; uploads over 500 MB are refused', async () => {
    const { dp, requests } = setup([]);
    for (const p of ['relative', '/a/../b', '/a//b', '/a/./b', '/a/', '/a\0b']) {
      await expect(dp.readFile('sbx-1', p)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(() => assertRemotePath('/')).not.toThrow();
    const huge = { size: 500 * 1024 * 1024 + 1 } as Blob;
    Object.setPrototypeOf(huge, Blob.prototype);
    await expect(dp.writeFile('sbx-1', '/root/big', huge)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toHaveLength(0);
  });

  it('read: capped at maxBytes, truncated reported', async () => {
    const { dp } = setup([{ match: '/files', respond: () => new Response(new Uint8Array(5000).fill(65), { status: 200, headers: { 'content-length': '5000' } }) }]);
    const r = await dp.readFile('sbx-1', '/root/big.txt', { maxBytes: 1000 });
    expect(r).toMatchObject({ size: 5000, truncated: true });
    expect(r.bytes.byteLength).toBe(1000);
  });

  it('download resumes only on 206; a 200 to a Range request restarts from zero', async () => {
    const a = setup([{ match: '/files', respond: (r) => (expect(r.headers.range).toBe('bytes=100-'), new Response('rest', { status: 206, headers: { 'content-range': 'bytes 100-103/104', 'accept-ranges': 'bytes' } })) }]);
    expect(await a.dp.download('sbx-1', '/root/f', { offset: 100 })).toMatchObject({ status: 206, resumed: true, totalBytes: 104, acceptRanges: true });
    const b = setup([{ match: '/files', respond: () => new Response('whole', { status: 200, headers: { 'content-length': '5', 'accept-ranges': 'none' } }) }]);
    expect(await b.dp.download('sbx-1', '/root/f', { offset: 100 })).toMatchObject({ status: 200, resumed: false, totalBytes: 5, acceptRanges: false });
    const c = setup([{ match: '/files', respond: (r) => (expect(r.headers.range).toBeUndefined(), new Response('x', { status: 200 })) }]);
    expect((await c.dp.download('sbx-1', '/root/f')).resumed).toBe(false);
  });
});

describe('shell primitives', () => {
  it('POST /shell 202 creating → retried after 1 s until ready', async () => {
    let n = 0;
    const { dp, sleeper } = setup([
      { match: `${HOST}/shell`, method: 'POST', respond: () => (++n < 3 ? json({ request_id: 'r', sandbox_key: 'mk1', status: 'creating', code: 'Shell.Creating' }, 202) : json({ request_id: 'r', sandbox_key: 'mk1', status: 'ready', connect_url: '/shell/connect' })) },
    ]);
    expect(await dp.shellLaunch('sbx-1')).toMatchObject({ status: 'ready', connect_url: '/shell/connect' });
    expect(sleeper.delays).toEqual([1000, 1000]);
  });

  it('resize: a Shell.ResizeFailed 502 is retried once; size validated', async () => {
    let n = 0;
    const { dp, requests } = setup([{ match: '/shell/control', respond: () => (++n === 1 ? json(v2Error('Shell.ResizeFailed'), 502) : json({ request_id: 'r', sandbox_key: 'mk1', status: 'attached' })) }]);
    expect(await dp.shellControl('sbx-1', { action: 'resize', cols: 120, rows: 40 })).toMatchObject({ status: 'attached' });
    expect(requests).toHaveLength(2);
    await expect(dp.shellControl('sbx-1', { action: 'resize', cols: 0, rows: 40 })).rejects.toMatchObject({ code: 'invalid_input' });
    const close = setup([{ match: '/shell/control', respond: () => json(v2Error('Shell.CloseFailed'), 502) }]);
    await expect(close.dp.shellControl('sbx-1', { action: 'close' })).rejects.toMatchObject({ code: 'upstream' });
    expect(close.requests).toHaveLength(1);
  });

  it('the socket target keeps the sandbox host and carries the token in a header', async () => {
    const { dp } = setup([]);
    const s = await dp.shellSocket('sbx-1', '/shell/connect');
    expect(s.url).toBe(`wss://${HOST}/shell/connect`);
    expect(s.headers['X-Access-Token']).toMatch(/^sat-/);
    for (const bad of ['//evil.example/x', 'https://evil.example/', '/../x', '@evil.example']) await expect(dp.shellSocket('sbx-1', bad)).rejects.toMatchObject({ code: 'upstream' });
  });
});
