import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { ComputeHttpError } from '@main/services/compute/errors';
import { createExecPort, runExec } from '@main/services/compute/computer/session';
import { AGENT_EXEC_SLOTS_MAX, EXEC_SLOTS_PER_SANDBOX, type ExecSlot } from '@main/services/compute/types';
import { RID, SBX, execResult, fakeDataPlane, fakeRegistry, instant, sandboxRecord, until } from './c2a-fakes';

function setup(inflight: Parameters<typeof fakeRegistry>[1] = []) {
  const registry = fakeRegistry([sandboxRecord()], inflight);
  const dp = fakeDataPlane();
  const changes: string[] = [];
  const port = createExecPort({ registry, dataPlane: dp, log: silentLogger, sleep: instant, onChange: (rid) => changes.push(rid) });
  return { registry, dp, port, changes };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ExecPort (§8.1)', () => {
  it('has 10 slots per sandbox; the 11th waits until one is released', async () => {
    const { port } = setup();
    expect(EXEC_SLOTS_PER_SANDBOX).toBe(10);
    const slots: ExecSlot[] = [];
    for (let i = 0; i < 10; i += 1) slots.push(await port.acquire(RID, { priority: 'user' }));
    expect(port.usage(RID)).toMatchObject({ capacity: 10, inUse: 10, waiting: 0 });
    let got: ExecSlot | null = null;
    const pending = port.acquire(RID, { priority: 'user' }).then((s) => (got = s));
    await settle();
    expect(got).toBeNull();
    expect(port.usage(RID).waiting).toBe(1);
    await slots[0]?.release('succeeded');
    await pending;
    expect(got).not.toBeNull();
    expect(port.usage(RID)).toMatchObject({ inUse: 10, waiting: 0 });
  });

  it('serves waiting user requests before agent requests', async () => {
    const { port } = setup();
    const slots: ExecSlot[] = [];
    for (let i = 0; i < 10; i += 1) slots.push(await port.acquire(RID, { priority: 'user' }));
    const order: string[] = [];
    const agent = port.acquire(RID, { priority: 'agent' }).then(() => order.push('agent'));
    const user = port.acquire(RID, { priority: 'user' }).then(() => order.push('user'));
    await settle();
    await slots[0]?.release('succeeded');
    await user;
    expect(order).toEqual(['user']);
    await slots[1]?.release('failed');
    await agent;
    expect(order).toEqual(['user', 'agent']);
  });

  it('caps the agent at 6 slots; the user still gets the rest', async () => {
    const { port } = setup();
    expect(AGENT_EXEC_SLOTS_MAX).toBe(6);
    const agentSlots: ExecSlot[] = [];
    for (let i = 0; i < 6; i += 1) agentSlots.push(await port.acquire(RID, { priority: 'agent' }));
    let seventh = false;
    const pending = port.acquire(RID, { priority: 'agent' }).then(() => (seventh = true));
    await settle();
    expect(seventh).toBe(false);
    // The waiting agent does not block the user.
    for (let i = 0; i < 4; i += 1) await port.acquire(RID, { priority: 'user' });
    expect(port.usage(RID)).toMatchObject({ inUse: 10, agentInUse: 6, waiting: 1 });
    await agentSlots[0]?.release('succeeded');
    await pending;
    expect(seventh).toBe(true);
    expect(port.usage(RID).agentInUse).toBe(6);
  });

  it('rejects with cancelled when the signal aborts while waiting', async () => {
    const { port } = setup();
    for (let i = 0; i < 10; i += 1) await port.acquire(RID, { priority: 'user' });
    const ac = new AbortController();
    const p = port.acquire(RID, { priority: 'user', signal: ac.signal });
    await settle();
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(port.usage(RID).waiting).toBe(0);
  });

  it('refuses resources that are not sandboxes', async () => {
    const registry = fakeRegistry([sandboxRecord(), sandboxRecord({ id: 'cr_ce', backend: 'ce', kind: 'container' })]);
    const port = createExecPort({ registry, dataPlane: fakeDataPlane(), log: silentLogger, sleep: instant });
    await expect(port.acquire('cr_ce', { priority: 'user' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(port.acquire('cr_missing', { priority: 'user' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('bind persists the execution id with its explicit timeout; release forgets it', async () => {
    const { port, registry } = setup();
    const slot = await port.acquire(RID, { priority: 'user' });
    await slot.bind({ eid: 'ex-9', origin: 'user', timeoutSec: 120 });
    expect(registry.added).toEqual([expect.objectContaining({ eid: 'ex-9', resourceId: RID, origin: 'user', grantId: null, timeoutSec: 120 })]);
    await expect(slot.bind({ eid: 'ex-10', origin: 'user', timeoutSec: 1 })).rejects.toBeInstanceOf(GmiError);
    await slot.release('succeeded');
    await slot.release('succeeded');
    expect(registry.removed).toEqual(['ex-9']);
    expect(port.usage(RID).inUse).toBe(0);
  });

  it('a 25 s wait that times out keeps the slot until the execution is terminal', async () => {
    const { port, dp, registry } = setup();
    dp.nextStart.push((eid) => execResult(eid, 'running'));
    dp.polls.set('ex-1', ['running', 'running', 'succeeded']);
    let inUseWhilePolling = -1;
    const origGet = dp.getExecution.bind(dp);
    dp.getExecution = async (sid, eid) => {
      inUseWhilePolling = Math.max(inUseWhilePolling, port.usage(RID).inUse);
      expect(registry.inflight.map((e) => e.eid)).toContain(eid);
      return origGet(sid, eid);
    };
    const r = await runExec(port, dp, { resourceId: RID, sandboxId: SBX, input: { command: 'sleep 60', timeoutSec: 90 }, priority: 'user', origin: 'user', sleep: instant });
    expect(r.status).toBe('succeeded');
    expect(inUseWhilePolling).toBe(1);
    expect(port.usage(RID).inUse).toBe(0);
    expect(registry.inflight).toEqual([]);
    expect(dp.calls.filter((c) => c.startsWith('get:'))).toHaveLength(3);
  });

  it('abort after the POST sends cancel; the slot is released only once the execution is terminal', async () => {
    const { port, dp } = setup();
    dp.nextStart.push((eid) => execResult(eid, 'running'));
    const ac = new AbortController();
    // Running until cancelled, then cancelled.
    let cancelledRemotely = false;
    dp.getExecution = async (_sid, eid) => execResult(eid, cancelledRemotely ? 'cancelled' : 'running');
    const origCancel = dp.cancelExecution.bind(dp);
    dp.cancelExecution = async (sid, eid) => {
      await origCancel(sid, eid);
      expect(port.usage(RID).inUse).toBe(1);
      setTimeout(() => (cancelledRemotely = true), 20);
    };
    const slow = async (_ms: number, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) throw new GmiError('cancelled', 'Cancelled.');
    };
    const p = runExec(port, dp, { resourceId: RID, sandboxId: SBX, input: { command: 'sleep 600', timeoutSec: 900 }, priority: 'user', origin: 'user', signal: ac.signal, sleep: slow });
    await until(() => dp.calls.includes('exec:sleep 600'));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(dp.cancels).toEqual(['ex-1']);
    await until(() => port.usage(RID).inUse === 0, 3000, 'slot release after cancel');
  });

  it('review: a cancel that fails with a network error still frees the slot once the execution ends', async () => {
    const { port, dp } = setup();
    dp.nextStart.push((eid) => execResult(eid, 'running'));
    let ended = false;
    dp.getExecution = async (_sid, eid) => execResult(eid, ended ? 'succeeded' : 'running');
    dp.cancelExecution = async () => {
      throw new GmiError('network', 'down');
    };
    const ac = new AbortController();
    const slow = async (_ms: number, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 2));
      if (signal?.aborted) throw new GmiError('cancelled', 'Cancelled.');
    };
    const p = runExec(port, dp, { resourceId: RID, sandboxId: SBX, input: { command: 'ls', timeoutSec: 60 }, priority: 'user', origin: 'app', signal: ac.signal, sleep: slow });
    await until(() => dp.calls.includes('exec:ls'));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(port.usage(RID).inUse).toBe(1);
    ended = true;
    await until(() => port.usage(RID).inUse === 0, 3000, 'slot release after failed cancel');
  });

  it('review: a cancel answered with 404 frees the slot at once', async () => {
    const { port, dp } = setup();
    dp.nextStart.push((eid) => execResult(eid, 'running'));
    dp.getExecution = async (_sid, eid) => execResult(eid, 'running');
    dp.cancelExecution = async () => {
      throw new GmiError('not_found', 'gone', { status: 404 });
    };
    const ac = new AbortController();
    const slow = async (_ms: number, signal?: AbortSignal) => {
      await new Promise((r) => setTimeout(r, 2));
      if (signal?.aborted) throw new GmiError('cancelled', 'Cancelled.');
    };
    const p = runExec(port, dp, { resourceId: RID, sandboxId: SBX, input: { command: 'ls', timeoutSec: 60 }, priority: 'user', origin: 'app', signal: ac.signal, sleep: slow });
    await until(() => dp.calls.includes('exec:ls'));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await until(() => port.usage(RID).inUse === 0, 3000, 'slot release after 404 cancel');
  });

  it('a request that never started releases with not_started', async () => {
    const { port, dp, registry } = setup();
    dp.nextStart.push(() => new GmiError('network', 'down'));
    await expect(runExec(port, dp, { resourceId: RID, sandboxId: SBX, input: { command: 'true', timeoutSec: 5 }, priority: 'user', origin: 'app', sleep: instant })).rejects.toMatchObject({ code: 'network' });
    expect(port.usage(RID).inUse).toBe(0);
    expect(registry.added).toEqual([]);
  });

  it('a 429 Execution.ConcurrencyLimitExceeded lowers the capacity, backs off and retries', async () => {
    const { port, dp } = setup();
    const held: ExecSlot[] = [];
    for (let i = 0; i < 3; i += 1) held.push(await port.acquire(RID, { priority: 'user' }));
    dp.nextStart.push(
      () =>
        new ComputeHttpError('rate_limited', 'too many', { family: 'dataplane', status: 429, parsed: true, remoteCode: 'Execution.ConcurrencyLimitExceeded' }),
    );
    const delays: number[] = [];
    const run = runExec(port, dp, {
      resourceId: RID,
      sandboxId: SBX,
      input: { command: 'true', timeoutSec: 5 },
      priority: 'user',
      origin: 'app',
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    // GMI allows only what we already hold: the retry waits for one of ours to end.
    await until(() => port.usage(RID).capacity === 3 && port.usage(RID).waiting === 1, 2000, 'lowered capacity');
    expect(delays).toEqual([2000]);
    await held[0]?.release('succeeded');
    const r = await run;
    expect(r.status).toBe('succeeded');
    expect(port.usage(RID)).toMatchObject({ capacity: 3, inUse: 2 });
    port.dispose();
  });

  it('gives up with rate_limited after repeated 429s', async () => {
    const { port, dp } = setup();
    for (let i = 0; i < 4; i += 1) {
      dp.nextStart.push(() => new ComputeHttpError('rate_limited', 'too many', { family: 'dataplane', status: 429, parsed: true, remoteCode: 'Execution.ConcurrencyLimitExceeded' }));
    }
    await expect(runExec(port, dp, { resourceId: RID, sandboxId: SBX, input: { command: 'true', timeoutSec: 5 }, priority: 'user', origin: 'app', sleep: instant })).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(port.usage(RID).inUse).toBe(0);
    port.dispose();
  });

  it('restores lowered capacity step by step', async () => {
    const registry = fakeRegistry();
    const port = createExecPort({ registry, dataPlane: fakeDataPlane(), log: silentLogger, sleep: instant, capacityRestoreMs: 10 });
    port.lowerCapacity(RID, 7);
    expect(port.usage(RID).capacity).toBe(7);
    port.lowerCapacity(RID, 0);
    expect(port.usage(RID).capacity).toBe(1);
    await until(() => port.usage(RID).capacity === 10, 2000, 'capacity restore');
    port.dispose();
  });

  it('reconciles persisted in-flight executions before granting the first slot', async () => {
    const startedAt = new Date().toISOString();
    const { port, dp, registry } = setup([
      { eid: 'old-done', resourceId: RID, origin: 'user', grantId: null, timeoutSec: 60, startedAt },
      { eid: 'old-running', resourceId: RID, origin: 'agent', grantId: 'g1', timeoutSec: 600, startedAt },
      { eid: 'old-gone', resourceId: RID, origin: 'app', grantId: null, timeoutSec: 60, startedAt },
      { eid: 'other', resourceId: 'cr_other', origin: 'app', grantId: null, timeoutSec: 60, startedAt },
    ]);
    dp.polls.set('old-done', ['succeeded']);
    dp.polls.set('old-running', ['running', 'running', 'cancelled']);
    dp.polls.set('old-gone', ['404']);
    const slot = await port.acquire(RID, { priority: 'user' });
    // Polled before the slot was granted; the running one was cancelled.
    const firstAcquireIndex = dp.calls.length;
    expect(dp.calls.slice(0, firstAcquireIndex)).toEqual(expect.arrayContaining(['get:old-done', 'get:old-running', 'get:old-gone', 'cancel:old-running']));
    expect(dp.calls).not.toContain('get:other');
    expect(registry.removed).toEqual(expect.arrayContaining(['old-done', 'old-gone']));
    // The cancelled leftover still holds a slot until it is terminal.
    await until(() => !registry.inflight.some((e) => e.eid === 'old-running'), 2000, 'leftover terminal');
    expect(port.usage(RID).inUse).toBe(1);
    await slot.release('succeeded');
    expect(port.usage(RID).inUse).toBe(0);
    // Once per run.
    const before = dp.calls.length;
    await (await port.acquire(RID, { priority: 'user' })).release('succeeded');
    expect(dp.calls.length).toBe(before);
    port.dispose();
  });

  it('cancel of an unknown execution is a no-op; dispose rejects waiters', async () => {
    const { port, dp } = setup();
    await port.cancel('nope');
    expect(dp.cancels).toEqual([]);
    for (let i = 0; i < 10; i += 1) await port.acquire(RID, { priority: 'user' });
    const p = port.acquire(RID, { priority: 'agent' });
    await settle();
    port.dispose();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    await expect(port.acquire(RID, { priority: 'user' })).rejects.toMatchObject({ code: 'cancelled' });
  });
});
