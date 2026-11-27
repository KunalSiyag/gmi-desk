// C1-C: the supervisor (§6.5, §6.6, §7.4, §9.2). State mapping, billing intervals, polling cadence (fake timers),
// back-off and API health, parking on not_entitled, the per-resource mutex and GMI's clock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyObservation,
  backoffMs,
  cePhase,
  createServerClock,
  isBilled,
  observeContainer,
  observeSandbox,
  v2Phase,
} from '@main/services/compute/supervisor';
import { COMPUTE_TIMING } from '@main/services/compute/types';
import { json } from './fakes';
import { httpEnv, rec, type HttpEnv } from './lifecycle-harness';

let env: HttpEnv | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await env?.cleanup();
  env = null;
});

const CE_LIST = /\/api\/v1\/containers$/;
const SB_LIST = /\/api\/v2\/sandboxes\?/;
const emptyPage = () => json({ request_id: 'r', total: 0, page: 1, page_size: 100, items: [] });
const ceLists = () => env?.fake.requests.filter((r) => r.method === 'GET' && CE_LIST.test(r.url)).length ?? 0;

describe('state mapping', () => {
  it('CE statuses (§6.5)', () => {
    expect(cePhase('creating', null)).toBe('creating');
    expect(cePhase('running', null)).toBe('running');
    expect(cePhase('terminating', 'restart')).toBe('busy');
    expect(cePhase('terminating', 'delete')).toBe('deleting');
    expect(cePhase('terminating', null, 'deleting')).toBe('deleting');
    expect(cePhase('terminating', null)).toBe('busy');
    expect(cePhase('stopped', null)).toBe('unknown');
    expect(cePhase('error', null)).toBe('failed');
    expect(cePhase('zombie', null)).toBe('failed');
    expect(cePhase('brand-new-status', null)).toBe('unknown');
    expect(observeContainer({ id: 'c', name: 'n', idc: 'i', product: 'p', templateId: 't', status: 'stopped', reason: '', storages: [], envNames: [] }, null).reason).toBe('Stopped by GMI.');
    expect(observeContainer({ id: 'c', name: 'n', idc: 'i', product: 'p', templateId: 't', status: 'zombie', reason: '', storages: [], envNames: [] }, null).reason).toMatch(/orphaned/);
  });

  it('v2 states incl. SDK extras (§7.4)', () => {
    const table: Record<string, string> = {
      provisioning: 'creating', running: 'running', updating: 'busy', checkpointing: 'busy', pausing: 'pausing', paused: 'paused', resuming: 'resuming',
      failed: 'failed', deleting: 'deleting', deleted: 'deleted', ready: 'running', active: 'running', error: 'failed', cancelled: 'deleted', whatever: 'unknown',
    };
    for (const [state, phase] of Object.entries(table)) expect(v2Phase(state)).toBe(phase);
    expect(observeSandbox({ id: 's', state: 'paused', pause: { code: 'Sandbox.BillingInsufficientBalance', initiator: 'billing', message: 'm', requested_at: '2026-11-01T10:00:00Z' } } as never)).toMatchObject({ billingInitiated: true, reason: 'GMI paused this because your balance is low.' });
  });

  it('billed phases: CE until deleted; sandboxes not while paused / failed', () => {
    expect(isBilled('container', 'failed')).toBe(true);
    expect(isBilled('container', 'unknown')).toBe(true);
    expect(isBilled('container', 'deleted')).toBe(false);
    expect(isBilled('sandbox', 'paused')).toBe(false);
    expect(isBilled('sandbox', 'failed')).toBe(false);
    expect(isBilled('sandbox', 'creating')).toBe(true);
  });
});

describe('billing intervals (§9.2)', () => {
  const remote = { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: null };

  it('CE: the first interval is backdated to the create request; the lease starts at the first running', () => {
    const r = rec({ id: 'cr_c', phase: 'creating', requestedAt: '2026-11-01T10:00:00.000Z' });
    const a = applyObservation(r, { phase: 'creating', rawState: 'creating', reason: null, remote }, '2026-11-01T10:01:00.000Z');
    expect(a.intervals).toEqual([{ from: '2026-11-01T10:00:00.000Z', to: null, usdPerHour: 3.35 }]);
    expect(a.runningSince).toBeNull();
    const b = applyObservation(a, { phase: 'running', rawState: 'running', reason: null, remote }, '2026-11-01T10:03:00.000Z');
    expect(b.intervals).toHaveLength(1);
    expect(b.runningSince).toBe('2026-11-01T10:03:00.000Z');
    expect(b.history[0]).toMatchObject({ phase: 'running' });
  });

  it('sandbox: opens at running_at, closes at GMI paused_at, reopens at resume, closes at deletion.requested_at', () => {
    let r = rec({ id: 'cr_s', kind: 'sandbox', phase: 'creating' });
    r = applyObservation(r, { phase: 'running', rawState: 'running', reason: null, remote: { ...remote, runningAt: '2026-11-01T10:00:00.000Z' } }, '2026-11-01T10:05:00.000Z');
    expect(r.intervals[0]?.from).toBe('2026-11-01T10:00:00.000Z');
    expect(r.runningSince).toBe('2026-11-01T10:00:00.000Z');
    r = applyObservation(r, { phase: 'paused', rawState: 'paused', reason: null, remote: { ...remote, pausedAt: '2026-11-01T11:00:00.000Z' } }, '2026-11-01T11:10:00.000Z');
    expect(r.intervals[0]?.to).toBe('2026-11-01T11:00:00.000Z');
    expect(r.pausedAt).toBe('2026-11-01T11:00:00.000Z');
    r = applyObservation(r, { phase: 'running', rawState: 'running', reason: null, remote }, '2026-11-01T12:00:00.000Z');
    expect(r.intervals[1]).toEqual({ from: '2026-11-01T12:00:00.000Z', to: null, usdPerHour: 0.0911 });
    expect(r.runningSince).toBe('2026-11-01T10:00:00.000Z');
    r = applyObservation(r, { phase: 'deleting', rawState: 'deleting', reason: null, remote: { ...remote, deletionRequestedAt: '2026-11-01T12:30:00.000Z' } }, '2026-11-01T12:31:00.000Z');
    expect(r.intervals[1]?.to).toBe('2026-11-01T12:30:00.000Z');
    r = applyObservation(r, { phase: 'deleted', rawState: 'deleted', reason: null, remote: { ...remote, deletionRequestedAt: '2026-11-01T12:30:00.000Z' } }, '2026-11-01T12:40:00.000Z');
    expect(r.tombstone).not.toBeNull();
    expect(r.intervals.every((i) => i.to !== null)).toBe(true);
  });

  it('a close never lands after the observation nor before the interval start', () => {
    let r = rec({ id: 'cr_s', kind: 'sandbox', phase: 'running', intervals: [{ from: '2026-11-01T10:00:00.000Z', to: null, usdPerHour: 1 }] });
    r = applyObservation(r, { phase: 'paused', rawState: 'paused', reason: null, remote: { ...remote, pausedAt: '2026-11-01T09:00:00.000Z' } }, '2026-11-01T10:30:00.000Z');
    expect(r.intervals[0]?.to).toBe('2026-11-01T10:00:00.000Z');
  });
});

describe('polling cadence (fake timers)', () => {
  async function steady() {
    vi.useFakeTimers();
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([{ id: 'c-1', name: 'gmid-abcdef-a-q1w2e3', idc: 'x', product: 'p', templateId: 't', status: 'running', reason: '', storages: [] }]) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ], { memory: true });
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1', phase: 'running' }));
    env.supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    return env;
  }

  it('60 s steady, 5 s while watched/transitional, 120 s hidden, 30 s with a computer open', async () => {
    const e = await steady();
    expect(ceLists()).toBe(1);
    expect(e.supervisor.nextDelayMs()).toBe(COMPUTE_TIMING.pollSteadyMs);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(ceLists()).toBe(4);

    e.supervisor.setHints({ windowHidden: true });
    expect(e.supervisor.nextDelayMs()).toBe(COMPUTE_TIMING.pollHiddenMs);
    e.supervisor.setHints({ windowHidden: false, computerOpen: true });
    expect(e.supervisor.nextDelayMs()).toBe(COMPUTE_TIMING.pollComputerOpenMs);

    await e.registry.update('cr_a', (r) => ({ ...r, phase: 'creating' }));
    e.supervisor.watch('cr_a');
    expect(e.supervisor.nextDelayMs()).toBe(COMPUTE_TIMING.pollTransitionalMs);
    const before = ceLists();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ceLists()).toBe(before + 1);
    // The poll saw `running`: back to the computer-open cadence.
    expect(e.supervisor.nextDelayMs()).toBe(COMPUTE_TIMING.pollComputerOpenMs);
  });

  it('nothing while suspended; an immediate poll on resume', async () => {
    const e = await steady();
    e.supervisor.setHints({ suspended: true });
    expect(e.supervisor.nextDelayMs()).toBeNull();
    const before = ceLists();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(ceLists()).toBe(before);
    e.supervisor.setHints({ suspended: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(ceLists()).toBe(before + 1);
  });

  it('no Compute key → no request at all', async () => {
    vi.useFakeTimers();
    env = await httpEnv([], { memory: true });
    env.keys.setKey(null);
    env.supervisor.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(env.fake.requests).toHaveLength(0);
  });
});

describe('errors: back-off and health', () => {
  it('backoffMs: 2 s doubling to 5 min, jittered 50–100 %, Retry-After honoured', () => {
    expect(backoffMs(1, () => 1)).toBe(2_000);
    expect(backoffMs(1, () => 0)).toBe(1_000);
    expect(backoffMs(4, () => 1)).toBe(16_000);
    expect(backoffMs(30, () => 1)).toBe(5 * 60_000);
    expect(backoffMs(1, () => 1, 90)).toBe(90_000);
  });

  it('5xx: degraded after 5 consecutive failures, down after 30 min, ok again on success', async () => {
    vi.useFakeTimers();
    let fail = true;
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => (fail ? new Response('<html>503</html>', { status: 503 }) : json([])) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ], { memory: true });
    const s = env.supervisor;
    // ctx.http retries GETs with its own timers: advance them while each poll runs.
    const poll = async () => {
      const p = s.pollNow();
      await vi.advanceTimersByTimeAsync(30_000);
      await p;
    };
    for (let i = 0; i < 5; i += 1) {
      await poll();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }
    expect(s.health().ce).toBe('degraded');
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await poll();
    expect(s.health().ce).toBe('down');
    expect(s.health().sandbox).toBe('ok');
    fail = false;
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    await poll();
    expect(s.health().ce).toBe('ok');
  });

  it('a 429 with Retry-After: no CE request before it passes (the sandbox backend keeps polling)', async () => {
    vi.useFakeTimers();
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => new Response('slow down', { status: 429, headers: { 'retry-after': '600' } }) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ], { memory: true });
    const poll = async () => {
      const p = env?.supervisor.pollNow();
      await vi.advanceTimersByTimeAsync(30_000);
      await p;
    };
    await poll();
    const after = ceLists();
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      await poll();
    }
    expect(ceLists()).toBe(after);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await poll();
    expect(ceLists()).toBeGreaterThan(after);
  });

  it('not_entitled parks the backend until the key changes', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json({ reason: 'access denied: tenant has no permission to do the operation' }, 403) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    await env.supervisor.pollNow();
    await env.supervisor.pollNow();
    expect(ceLists()).toBe(1);
    expect(env.supervisor.health().ce).toBe('unknown');
    expect(env.keys.reports).toHaveLength(0); // a 403 is never a dead key
    env.supervisor.resetBackends();
    await env.supervisor.pollNow();
    expect(ceLists()).toBe(2);
  });
});

describe('reconcile by polling', () => {
  it('a managed container missing from the list → tombstone, accrual closed at the last-seen time', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([]) },
      { match: /\/api\/v1\/containers\/c-1$/, method: 'GET', respond: () => json({ reason: 'not found' }, 404) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    const seen = new Date(Date.now() - 60_000).toISOString();
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1', lastSeenAt: seen, intervals: [{ from: new Date(Date.now() - 3600_000).toISOString(), to: null, usdPerHour: 3.35 }] }));
    const transitions: string[] = [];
    env.supervisor.onTransition((t) => transitions.push(`${t.from}->${t.to}`));
    await env.supervisor.pollNow();
    const r = env.registry.get('cr_a');
    expect(r?.tombstone).not.toBeNull();
    expect(r?.intervals[0]?.to).toBe(seen);
    expect(transitions).toEqual(['null->deleted']);
  });

  it('missing from one list but the detail GET answers: never tombstoned (only a 404 deletes, §6.5)', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([]) },
      { match: /\/api\/v1\/containers\/c-1$/, method: 'GET', respond: () => json({ id: 'c-1', name: 'gmid-abcdef-cr_a-q1w2e3', status: 'running', idc: 'x', product: 'p' }) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1', intervals: [{ from: new Date(Date.now() - 3600_000).toISOString(), to: null, usdPerHour: 3.35 }] }));
    await env.supervisor.pollNow();
    expect(env.registry.get('cr_a')).toMatchObject({ tombstone: null, phase: 'running' });
    expect(env.registry.get('cr_a')?.intervals[0]?.to).toBeNull();
  });

  it('a detail GET that fails (not a 404) leaves the record alone', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([]) },
      { match: /\/api\/v1\/containers\/c-1$/, method: 'GET', respond: () => json({ reason: 'busy' }, 503) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1' }));
    await env.supervisor.pollNow();
    expect(env.registry.get('cr_a')?.tombstone).toBeNull();
  });

  it('an odd 200 (not an array) is a poll failure, not an empty org: nothing is tombstoned', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json({ unexpected: true }) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1' }));
    await env.supervisor.pollNow();
    expect(env.registry.get('cr_a')?.tombstone).toBeNull();
    expect(env.fake.requests.some((r) => /containers\/c-1$/.test(r.url))).toBe(false);
  });

  it('a tombstoned container that GMI lists again is revived (lease, budget and quit apply again)', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([{ id: 'c-1', name: 'gmid-abcdef-cr_a-q1w2e3', status: 'running', idc: 'x', product: 'p' }]) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1', intervals: [{ from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() - 600_000).toISOString(), usdPerHour: 3.35 }], tombstone: { at: new Date(Date.now() - 600_000).toISOString(), reason: 'Gone from GMI.' } }));
    expect(env.registry.list().some((r) => r.id === 'cr_a')).toBe(false);
    await env.supervisor.pollNow();
    const r = env.registry.get('cr_a');
    expect(r?.tombstone).toBeNull();
    expect(r?.intervals.at(-1)?.to).toBeNull();
    expect(env.registry.list().some((x) => x.id === 'cr_a')).toBe(true);
  });

  it('a record created before the price feed loaded gets its price when the next interval opens', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([{ id: 'c-1', name: 'gmid-abcdef-cr_a-q1w2e3', status: 'running', idc: 'x', product: 'p' }]) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    const { createSupervisor } = await import('@main/services/compute/supervisor');
    const { silentLogger } = await import('@main/core/logger');
    const sup = createSupervisor({ registry: env.registry, log: silentLogger, keys: env.keys as never, ce: env.ce, sandbox: env.sandbox, clock: env.clock, prices: { price: () => ({ usdPerHour: 3.35, fetchedAt: null, source: 'public_feed' }) } });
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1', listUsdPerHour: null, phase: 'creating', rawState: 'creating' }));
    await sup.pollNow();
    expect(env.registry.get('cr_a')).toMatchObject({ listUsdPerHour: 3.35 });
    expect(env.registry.get('cr_a')?.intervals[0]?.usdPerHour).toBe(3.35);
    await sup.stop();
  });

  it('a freshly created container that is not listed yet is left alone (< 2 min)', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([]) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    await env.registry.add(rec({ id: 'cr_a', remoteId: 'c-1', phase: 'creating', requestedAt: new Date().toISOString() }));
    await env.supervisor.pollNow();
    expect(env.registry.get('cr_a')?.tombstone).toBeNull();
  });

  it('a sandbox missing from the default list gets one detail GET; 404 → deleted', async () => {
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([]) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
      { match: /\/sandboxes\/sbx-1$/, method: 'GET', respond: () => json({ code: 'Resource.NotFound', message: 'gone', request_id: 'r' }, 404) },
    ]);
    await env.registry.add(rec({ id: 'cr_s', kind: 'sandbox', remoteId: 'sbx-1' }));
    await env.supervisor.pollNow();
    expect(env.registry.get('cr_s')?.phase).toBe('deleted');
    expect(env.supervisor.freshSince('cr_s')).not.toBeNull();
  });
});

describe('per-resource mutex', () => {
  it('one mutation at a time per resource (later callers wait); pendingAction while it runs; other ids run in parallel', async () => {
    env = await httpEnv([]);
    const s = env.supervisor;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = s.withResourceLock('cr_a', 'delete', async () => {
      order.push('a1 start');
      await gate;
      order.push('a1 end');
      return 1;
    });
    const second = s.withResourceLock('cr_a', 'pause', async () => {
      order.push('a2');
      return 2;
    });
    const other = s.withResourceLock('cr_b', 'restart', async () => {
      order.push('b');
      return 3;
    });
    await other;
    await Promise.resolve();
    expect(s.pendingAction('cr_a')).toBe('delete');
    expect(order).toEqual(['a1 start', 'b']);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(['a1 start', 'b', 'a1 end', 'a2']);
    expect(s.pendingAction('cr_a')).toBeNull();
  });

  it('a failing mutation releases the lock', async () => {
    env = await httpEnv([]);
    await expect(env.supervisor.withResourceLock('cr_a', 'delete', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await env.supervisor.withResourceLock('cr_a', 'pause', async () => 'ok')).toBe('ok');
  });
});

describe("GMI's clock (§6.6)", () => {
  it('unverified until a Date header; skew > 2 min → server time; small skew → local time', () => {
    let local = Date.parse('2026-11-02T10:00:00.000Z');
    const clock = createServerClock(() => new Date(local));
    expect(clock.verified()).toBe(false);
    expect(clock.skewMs()).toBeNull();
    clock.observe(new Date(local + 30_000));
    expect(clock.verified()).toBe(true);
    expect(clock.now().getTime()).toBe(local);
    clock.observe(new Date(local + 30 * 24 * 3600_000 * -1));
    expect(clock.now().getTime()).toBe(local - 30 * 24 * 3600_000);
    local += 1000;
    expect(clock.now().getTime()).toBe(local - 30 * 24 * 3600_000);
  });

  it('the clients feed it from the HTTP Date header', async () => {
    const server = new Date(Date.now() + 10 * 60_000);
    env = await httpEnv([
      { match: CE_LIST, method: 'GET', respond: () => json([], 200, { date: server.toUTCString() }) },
      { match: SB_LIST, method: 'GET', respond: emptyPage },
    ]);
    await env.supervisor.pollNow();
    expect(env.clock.verified()).toBe(true);
    expect(Math.abs(env.clock.now().getTime() - server.getTime())).toBeLessThan(5_000);
  });
});
