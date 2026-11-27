// Shared fakes for the C2-B tests (exec, files, transfers, ports, services): a recording ExecPort, a recording
// ActivitySink, a scripted data plane, and a stack over the C1-B mock simulator (its fake filesystem and shell).
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createMockCompute } from '@main/mock/compute';
import { createExecRunner, type ComputerTarget } from '@main/services/compute/computer/exec';
import type { DataPlaneApi, ExecInput } from '@main/services/compute/sandbox/dataplane';
import type { V2ExecAccepted, V2ExecResult } from '@main/services/compute/sandbox/dto';
import type { ActivitySink, ComputeActivity, ExecPort, ExecReleaseOutcome, ExecSlot } from '@main/services/compute/types';

/** The demo sandbox of the mock simulator (fixture `sandboxes.json`, running). */
export const TARGET: ComputerTarget = { sessionId: 'cs_test_1', resourceId: 'cr_mock_sb1', sandboxId: 'sbx-mock-0001' };

export interface FakeExecPort extends ExecPort {
  log: string[];
  acquired: Array<{ slotId: string; resourceId: string; priority: string }>;
  bound: Array<{ slotId: string; eid: string; origin: string; timeoutSec: number }>;
  released: Array<{ slotId: string; outcome: ExecReleaseOutcome }>;
  cancelled: string[];
  lowered: Array<{ resourceId: string; observed: number }>;
  inUse: number;
}

export function fakeExecPort(): FakeExecPort {
  let n = 0;
  const port: FakeExecPort = {
    log: [],
    acquired: [],
    bound: [],
    released: [],
    cancelled: [],
    lowered: [],
    inUse: 0,
    async acquire(resourceId, opts) {
      if (opts.signal?.aborted) throw new GmiError('cancelled', 'Cancelled.');
      const slotId = `slot-${++n}`;
      port.inUse += 1;
      port.acquired.push({ slotId, resourceId, priority: opts.priority });
      port.log.push(`acquire ${slotId}`);
      let released = false;
      const slot: ExecSlot = {
        slotId,
        resourceId,
        priority: opts.priority,
        async bind(exec) {
          port.bound.push({ slotId, eid: exec.eid, origin: exec.origin, timeoutSec: exec.timeoutSec });
          port.log.push(`bind ${slotId} ${exec.eid}`);
        },
        async release(outcome) {
          if (released) return;
          released = true;
          port.inUse -= 1;
          port.released.push({ slotId, outcome });
          port.log.push(`release ${slotId} ${outcome}`);
        },
      };
      return slot;
    },
    async cancel(eid) {
      port.cancelled.push(eid);
      port.log.push(`cancel ${eid}`);
    },
    lowerCapacity(resourceId, observed) {
      port.lowered.push({ resourceId, observed });
    },
    usage() {
      return { capacity: 10, inUse: port.inUse, agentInUse: 0, waiting: 0 };
    },
  };
  return port;
}

export function fakeActivity(): ActivitySink & { records: Array<{ resourceId: string; activity: ComputeActivity }> } {
  const records: Array<{ resourceId: string; activity: ComputeActivity }> = [];
  return {
    records,
    record(resourceId, activity) {
      records.push({ resourceId, activity });
    },
  };
}

export const execResult = (over: Partial<V2ExecResult> = {}): V2ExecResult => ({
  request_id: 'req-test',
  execution_id: 'exe-1',
  sandbox_id: 'mk0001',
  status: 'succeeded',
  exit_code: 0,
  stdout: '',
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  started_at: null,
  completed_at: null,
  ...over,
});

const notScripted = async (): Promise<never> => {
  throw new Error('not scripted');
};

/**
 * A data plane whose `startExec` answers from `respond(input)` (calling `onAccepted` first, like the real one), and
 * whose other methods throw unless overridden. Records every exec input.
 */
export function scriptedDataPlane(
  respond: (input: ExecInput, index: number) => V2ExecResult | V2ExecAccepted | Promise<V2ExecResult | V2ExecAccepted>,
  over: Partial<DataPlaneApi> = {},
): DataPlaneApi & { inputs: ExecInput[] } {
  const inputs: ExecInput[] = [];
  let eidSeq = 0;
  const dp = {
    inputs,
    tokens: undefined as unknown as DataPlaneApi['tokens'],
    async startExec(_sandboxId: string, input: ExecInput) {
      inputs.push(input);
      const r = await respond(input, inputs.length - 1);
      const eid = r.execution_id || `exe-${++eidSeq}`;
      if (input.onAccepted) await input.onAccepted(eid);
      return { ...r, execution_id: eid };
    },
    exec: notScripted,
    getExecution: notScripted,
    waitExecution: notScripted,
    cancelExecution: notScripted,
    readFile: notScripted,
    writeFile: notScripted,
    download: notScripted,
    shellLaunch: notScripted,
    shellControl: notScripted,
    shellSocket: notScripted,
    ...over,
  } as DataPlaneApi & { inputs: ExecInput[] };
  return dp;
}

/** The mock simulator's data plane with a runner over a fake port: commands really run on the fake machine. */
export function mockStack(flags: string[] = []) {
  const mock = createMockCompute({ flags: new Set(flags), installTag: 'abcdef', installLabel: '0123456789abcdef' });
  const port = fakeExecPort();
  const activity = fakeActivity();
  const runner = createExecRunner({ dataPlane: mock.dataPlane, execPort: port, activity, log: silentLogger });
  return { mock, dataPlane: mock.dataPlane, port, activity, runner };
}
