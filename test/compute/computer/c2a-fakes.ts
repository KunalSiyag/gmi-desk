// Shared fakes for the C2-A tests (computer session, exec port, shell): an in-memory registry, a scripted data plane,
// a recording supervisor and activity sink.
import { GmiError } from '@shared/contracts/errors';
import type { DataPlaneAccess, DataPlaneApi, TokenCache } from '@main/services/compute/sandbox/dataplane';
import type { V2ExecResult, V2ShellControlRequest } from '@main/services/compute/sandbox/dto';
import { blankRecord } from '@main/services/compute/registry';
import type { ActivitySink, ComputeActivity, ComputeRecord, InflightExec, PhaseTransition, Registry } from '@main/services/compute/types';

export const RID = 'cr_test_sb1';
export const SBX = 'sbx-test-0001';

export function sandboxRecord(overrides: Partial<ComputeRecord> = {}): ComputeRecord {
  return blankRecord(
    {
      id: RID,
      kind: 'sandbox',
      backend: 'sandbox_v2',
      name: 'sandbox-test',
      displayName: 'python-dev',
      managed: true,
      remoteId: SBX,
      phase: 'running',
      ...overrides,
    },
    '2026-11-02T10:00:00.000Z',
  );
}

export type FakeRegistry = Pick<Registry, 'get' | 'inflightExecs' | 'addInflightExec' | 'removeInflightExec'> & {
  records: Map<string, ComputeRecord>;
  inflight: InflightExec[];
  added: InflightExec[];
  removed: string[];
};

export function fakeRegistry(records: ComputeRecord[] = [sandboxRecord()], inflight: InflightExec[] = []): FakeRegistry {
  const reg: FakeRegistry = {
    records: new Map(records.map((r) => [r.id, r])),
    inflight: [...inflight],
    added: [],
    removed: [],
    get: (id) => reg.records.get(id) ?? null,
    inflightExecs: (rid) => reg.inflight.filter((e) => !rid || e.resourceId === rid).map((e) => ({ ...e })),
    async addInflightExec(e) {
      reg.added.push(e);
      reg.inflight.push(e);
    },
    async removeInflightExec(eid) {
      reg.removed.push(eid);
      reg.inflight = reg.inflight.filter((e) => e.eid !== eid);
    },
  };
  return reg;
}

export const execResult = (eid: string, status: string, stdout = ''): V2ExecResult => ({
  request_id: 'req-test',
  execution_id: eid,
  sandbox_id: SBX,
  status,
  exit_code: status === 'succeeded' ? 0 : null,
  stdout,
  stderr: '',
  stdout_truncated: false,
  stderr_truncated: false,
  started_at: null,
  completed_at: null,
});

export interface FakeDataPlane extends DataPlaneApi {
  calls: string[];
  controls: V2ShellControlRequest[];
  cancels: string[];
  /** Status sequence per eid for getExecution (the last repeats). */
  polls: Map<string, string[]>;
  /** What the next startExec answers (default: succeeded with `homeLine`). */
  nextStart: Array<(eid: string) => V2ExecResult | Error>;
  launches: number;
  launchError: Array<Error | null>;
  refreshes: number;
  refreshError: Error | null;
  connectError: Error | null;
  socketUrl: string;
  homeLine: string;
}

const access = (): DataPlaneAccess => ({
  sandboxId: SBX,
  sandboxKey: 'tk0001',
  domain: 'sandbox.test',
  host: 'tk0001.sandbox.test',
  baseUrl: 'https://tk0001.sandbox.test',
  accessToken: 'dp-token-not-a-secret',
  trafficToken: 'traffic-token-not-a-secret',
  endAt: null,
  fetchedAt: '2026-11-02T10:00:00.000Z',
});

export function fakeDataPlane(): FakeDataPlane {
  let n = 0;
  const tokens: TokenCache = {
    async get() {
      dp.calls.push('connect');
      if (dp.connectError) throw dp.connectError;
      return access();
    },
    async refresh() {
      dp.refreshes += 1;
      dp.calls.push('refresh');
      if (dp.refreshError) throw dp.refreshError;
      return access();
    },
    invalidate: () => {
      dp.calls.push('invalidate');
    },
    peek: () => access(),
    put: () => access(),
    clear: () => undefined,
  };
  const dp: FakeDataPlane = {
    calls: [],
    controls: [],
    cancels: [],
    polls: new Map(),
    nextStart: [],
    launches: 0,
    launchError: [],
    refreshes: 0,
    refreshError: null,
    connectError: null,
    socketUrl: 'ws://127.0.0.1:1/shell/connect',
    homeLine: '/root\troot',
    tokens,
    async startExec(_sid, input) {
      n += 1;
      const eid = `ex-${n}`;
      dp.calls.push(`exec:${input.command.slice(0, 20)}`);
      const next = dp.nextStart.shift();
      const r = next ? next(eid) : execResult(eid, 'succeeded', dp.homeLine);
      if (r instanceof Error) throw r;
      if (input.onAccepted) await input.onAccepted(r.execution_id);
      return r;
    },
    async getExecution(_sid, eid) {
      dp.calls.push(`get:${eid}`);
      const list = dp.polls.get(eid) ?? ['succeeded'];
      const status = list.length > 1 ? (list.shift() as string) : (list[0] as string);
      if (status === '404') throw new GmiError('not_found', 'gone', { status: 404 });
      return execResult(eid, status);
    },
    async waitExecution() {
      throw new Error('not used');
    },
    async exec() {
      throw new Error('not used');
    },
    async cancelExecution(_sid, eid) {
      dp.cancels.push(eid);
      dp.calls.push(`cancel:${eid}`);
    },
    async readFile() {
      throw new Error('not used');
    },
    async writeFile() {
      throw new Error('not used');
    },
    async download() {
      throw new Error('not used');
    },
    async shellLaunch() {
      dp.launches += 1;
      dp.calls.push('launch');
      const e = dp.launchError.shift();
      if (e) throw e;
      return { request_id: 'req', sandbox_key: 'tk0001', status: 'ready', connect_url: '/shell/connect' };
    },
    async shellControl(_sid, req) {
      dp.controls.push(req);
      dp.calls.push(`control:${req.action}`);
      return { request_id: 'req', sandbox_key: 'tk0001', status: 'attached' };
    },
    async shellSocket() {
      return { url: dp.socketUrl, headers: { 'X-Access-Token': 'dp-token-not-a-secret' } };
    },
  };
  return dp;
}

export function fakeSupervisor() {
  const listeners = new Set<(t: PhaseTransition) => void>();
  const sup = {
    watched: [] as string[],
    hints: [] as Array<Record<string, boolean>>,
    onTransition(l: (t: PhaseTransition) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    watch(id: string) {
      sup.watched.push(id);
    },
    setHints(h: Record<string, boolean>) {
      sup.hints.push(h);
    },
    emit(from: PhaseTransition['from'], to: PhaseTransition['to'], resourceId = RID) {
      for (const l of [...listeners]) {
        l({
          resourceId,
          kind: 'sandbox',
          backend: 'sandbox_v2',
          from,
          to,
          rawState: null,
          at: '2026-11-02T10:00:00.000Z',
          remote: { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: null },
          source: 'poll',
        });
      }
    },
  };
  return sup;
}

export function fakeActivity(): ActivitySink & { records: Array<{ rid: string; activity: ComputeActivity }> } {
  const sink = {
    records: [] as Array<{ rid: string; activity: ComputeActivity }>,
    record(rid: string, activity: ComputeActivity) {
      sink.records.push({ rid, activity });
    },
  };
  return sink;
}

/** A sleep that takes no time but yields one macrotask (so polling loops never starve timers). */
export const instant = async (_ms: number, signal?: AbortSignal) => {
  await new Promise((r) => setImmediate(r));
  if (signal?.aborted) throw new GmiError('cancelled', 'Cancelled.');
};

/** Waits until `fn` is true (real timers), failing after `ms`. */
export async function until(fn: () => boolean, ms = 15_000, label = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
