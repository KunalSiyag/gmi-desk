// C2-B: the exec runner. Slots are held until the execution is terminal; an execution abandoned after GMI named it
// goes to ExecPort.cancel; a 429 lowers the capacity; only user execs are activity; timeouts are explicit.
import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { ComputeHttpError } from '@main/services/compute/errors';
import { createExecRunner, execFailure, plainText, stderrLine } from '@main/services/compute/computer/exec';
import type { DataPlaneApi } from '@main/services/compute/sandbox/dataplane';
import { TARGET, execResult, fakeActivity, fakeExecPort, scriptedDataPlane } from './c2b-harness';

function setup(dp: DataPlaneApi) {
  const port = fakeExecPort();
  const activity = fakeActivity();
  const runner = createExecRunner({ dataPlane: dp, execPort: port, activity, log: silentLogger });
  return { runner, port, activity };
}

describe('exec runner', () => {
  it('binds the slot to the eid and releases it with the terminal status', async () => {
    const dp = scriptedDataPlane(() => execResult({ execution_id: 'exe-a', stdout: 'hi' }));
    const { runner, port } = setup(dp);
    const r = await runner.run(TARGET, { command: 'echo hi', timeoutSec: 30, origin: 'app' });
    expect(r.stdout).toBe('hi');
    expect(port.log).toEqual(['acquire slot-1', 'bind slot-1 exe-a', 'release slot-1 succeeded']);
    expect(port.acquired[0]).toMatchObject({ resourceId: TARGET.resourceId, priority: 'user' });
    expect(port.bound[0]).toMatchObject({ origin: 'app', timeoutSec: 30 });
    expect(dp.inputs[0]?.timeoutSec).toBe(30);
  });

  it('a 25 s wait that times out keeps the slot until the poll sees a terminal status', async () => {
    const order: string[] = [];
    const dp = scriptedDataPlane(() => ({ request_id: 'r', execution_id: 'exe-b', sandbox_id: 'mk', status: 'running' }) as never, {
      async waitExecution(_s, eid) {
        order.push(`wait ${eid}`);
        return execResult({ execution_id: eid, status: 'failed', exit_code: 2 });
      },
    });
    const { runner, port } = setup(dp);
    const r = await runner.run(TARGET, { command: 'sleep 40', timeoutSec: 60, origin: 'user', activity: 'user_exec' });
    expect(r.status).toBe('failed');
    expect(order).toEqual(['wait exe-b']);
    expect(port.log).toEqual(['acquire slot-1', 'bind slot-1 exe-b', 'release slot-1 failed']);
  });

  it('a request that failed before GMI named an execution releases the slot as not_started', async () => {
    const dp = scriptedDataPlane(() => {
      throw new GmiError('network', 'offline');
    });
    const { runner, port } = setup(dp);
    await expect(runner.run(TARGET, { command: 'ls', timeoutSec: 30, origin: 'app' })).rejects.toMatchObject({ code: 'network' });
    expect(port.released).toEqual([{ slotId: 'slot-1', outcome: 'not_started' }]);
    expect(port.cancelled).toEqual([]);
  });

  it('a 429 Execution.ConcurrencyLimitExceeded lowers the capacity to what GMI allowed', async () => {
    const dp = scriptedDataPlane(() => {
      throw new ComputeHttpError('rate_limited', 'too many', { family: 'dataplane', status: 429, parsed: true, remoteCode: 'Execution.ConcurrencyLimitExceeded' });
    });
    const { runner, port } = setup(dp);
    await expect(runner.run(TARGET, { command: 'ls', timeoutSec: 30, origin: 'app' })).rejects.toMatchObject({ status: 429 });
    expect(port.lowered).toEqual([{ resourceId: TARGET.resourceId, observed: 1 }]);
    expect(port.released[0]?.outcome).toBe('not_started');
  });

  it('an abort while polling hands the execution to ExecPort.cancel and keeps the slot', async () => {
    const ac = new AbortController();
    const dp = scriptedDataPlane(() => ({ request_id: 'r', execution_id: 'exe-c', sandbox_id: 'mk', status: 'running' }) as never, {
      async waitExecution() {
        ac.abort();
        throw new GmiError('cancelled', 'Cancelled.');
      },
    });
    const { runner, port } = setup(dp);
    await expect(runner.run(TARGET, { command: 'sleep 99', timeoutSec: 120, origin: 'user', signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(port.cancelled).toEqual(['exe-c']);
    expect(port.released).toEqual([]);
  });

  it('a poll failure also cancels through the port (the execution may still run)', async () => {
    const dp = scriptedDataPlane(() => ({ request_id: 'r', execution_id: 'exe-d', sandbox_id: 'mk', status: 'pending' }) as never, {
      async waitExecution() {
        throw new GmiError('network', 'offline');
      },
    });
    const { runner, port } = setup(dp);
    await expect(runner.run(TARGET, { command: 'x', timeoutSec: 30, origin: 'app' })).rejects.toMatchObject({ code: 'network' });
    expect(port.cancelled).toEqual(['exe-d']);
    expect(port.released).toEqual([]);
  });

  it('an aborted signal never takes a slot', async () => {
    const ac = new AbortController();
    ac.abort();
    const dp = scriptedDataPlane(() => execResult());
    const { runner, port } = setup(dp);
    await expect(runner.run(TARGET, { command: 'x', timeoutSec: 30, origin: 'user', signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(port.acquired).toEqual([]);
    expect(dp.inputs).toEqual([]);
  });

  it('only user execs with an activity kind are activity; app execs never are', async () => {
    const dp = scriptedDataPlane(() => execResult());
    const { runner, activity } = setup(dp);
    await runner.run(TARGET, { command: 'cat /proc/net/tcp', timeoutSec: 10, origin: 'app', activity: 'user_exec' });
    await runner.withSlot(TARGET, { origin: 'app', activity: 'file_op' }, async () => 1);
    expect(activity.records).toEqual([]);
    await runner.run(TARGET, { command: 'ls', timeoutSec: 10, origin: 'user', activity: 'user_exec' });
    await runner.withSlot(TARGET, { origin: 'user', activity: 'transfer' }, async () => 1);
    expect(activity.records).toEqual([
      { resourceId: TARGET.resourceId, activity: { kind: 'user_exec' } },
      { resourceId: TARGET.resourceId, activity: { kind: 'transfer' } },
    ]);
  });

  it('withSlot releases as not_started also when the request fails', async () => {
    const { runner, port } = setup(scriptedDataPlane(() => execResult()));
    await expect(runner.withSlot(TARGET, { origin: 'user' }, async () => Promise.reject(new GmiError('not_found', 'x')))).rejects.toMatchObject({ code: 'not_found' });
    expect(port.released).toEqual([{ slotId: 'slot-1', outcome: 'not_started' }]);
  });
});

describe('exec helpers', () => {
  it('maps shell failures to user-safe errors', () => {
    expect(execFailure(execResult({ status: 'failed', exit_code: 1, stderr: "mv: cannot stat '/x': No such file or directory\n" }), 'Moving').code).toBe('not_found');
    expect(execFailure(execResult({ status: 'failed', exit_code: 1, stderr: 'rm: Permission denied' }), 'Deleting').code).toBe('permission_denied');
    expect(execFailure(execResult({ status: 'failed', exit_code: 1, stderr: 'mkdir: File exists' }), 'x').code).toBe('conflict');
    expect(execFailure(execResult({ status: 'timed_out', exit_code: null }), 'x').code).toBe('timeout');
    expect(execFailure(execResult({ status: 'failed', exit_code: 9, stderr: '' }), 'x')).toMatchObject({ code: 'upstream', detail: 'exit code 9' });
  });

  it('strips ANSI and control characters, keeps tabs and newlines, caps length', () => {
    expect(plainText('\x1b[1;31mred\x1b[0m\tok\n\x07bell')).toBe('red\tok\nbell');
    expect(plainText('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}\n…`);
    expect(stderrLine(execResult({ stderr: '\n\n  first line  \nsecond' }))).toBe('first line');
  });
});
