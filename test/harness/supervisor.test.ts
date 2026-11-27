// H2-0: main's harness bridge — the supervisor (src/main/services/harness/supervisor.ts) driving the REAL host
// message handling (src/harness/host.ts) over an in-memory "utilityProcess" with structured clone; the bridge
// (gw.request ownership, abortOwner on exit, runs, RPC router), the approval broker (allowedDecisions, native
// dialogs, one-shot tokens, expiry, dialog hygiene), the view-only fallback on a real node:sqlite file, the stdio
// drain, and the slice registration with its dev-only Diagnostics check.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalDecision, ApprovalRequest } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayRequest } from '@shared/contracts/gateway';
import { listDiagnosticsActions, type GmiGateway } from '@main/core/services';
import { silentLogger, type Logger } from '@main/core/logger';
import { createHost, memoryJournalIo, type Host } from '@harness/host';
import { createInlineWorker } from '@harness/worker';
import type { HostToMain, MainToHost } from '@harness/protocol';
import type { CreateHostRuntime, HostRuntime, MainLink } from '@harness/types';
import {
  allowedDecisionsFor,
  confirmationFor,
  createApprovalBroker,
  createHarnessService,
  drainToLog,
  openReadOnlyHarnessDb,
  sanitizeDialogText,
  withinSuggested,
  APPROVAL_LIMITS,
  SUPERVISOR_LIMITS,
  type HarnessService,
  type HostProcess,
  type HostSpawner,
} from '@main/services/harness';
import { HARNESS_DIAGNOSTICS_ID, setupHarnessSlice } from '@main/slices/harness';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeClock, replyEvents, scriptedGateway, type FakeClock, type ScriptedGateway } from '../gateway/fakes';
import { sampleApproval, sampleRequest } from './fakes';

const THREAD = 'c0de0000-0000-4000-8000-000000000001';

const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
};

// ─── An in-memory utilityProcess running the real host ───────────────────────────────────────────────────────

interface FakeProc extends HostProcess {
  host: Host;
  env: Record<string, string>;
  exited: boolean;
  /** Stops answering anything (a hung event loop). */
  freeze(): void;
  /** Crashes with this exit code. */
  crash(code?: number): void;
  /** Sends a raw message to main as if the host had. */
  inject(raw: unknown): void;
  stderrStream: PassThrough;
  received: MainToHost[];
}

interface RuntimeControl {
  /** The host-side link of the latest host (to drive streams, approvals and RPCs as the loop would). */
  link: MainLink | null;
  /** Resolve to let the runtime finish starting. Default: start immediately. */
  startGate: Promise<void> | null;
  startFails: boolean;
  handle(cmd: Parameters<HostRuntime['handle']>[0]): Promise<unknown>;
}

function runtimeControl(): RuntimeControl & { factory: CreateHostRuntime } {
  const control: RuntimeControl & { factory: CreateHostRuntime } = {
    link: null,
    startGate: null,
    startFails: false,
    handle: async (cmd) => (cmd.op === 'run.send' || cmd.op === 'run.resume' ? { runId: 'run_1', turn: 1, budgetWarning: null } : { op: cmd.op }),
    factory: (deps) => {
      control.link = deps.link;
      return {
        async start(_init, io) {
          io.phase('migrating');
          if (control.startGate) await control.startGate;
          if (control.startFails) throw new GmiError('internal', 'boom');
          await io.recovering(null);
          return { sandbox: { kind: 'none', ok: false, detail: 'fake', network: 'none' }, git: { ok: true, version: '2.43.0' }, ripgrep: true };
        },
        handle: (cmd) => control.handle(cmd),
        shutdown: async () => undefined,
      };
    },
  };
  return control;
}

function fakeSpawner(clock: FakeClock, control: ReturnType<typeof runtimeControl>): HostSpawner & { procs: FakeProc[] } {
  const procs: FakeProc[] = [];
  const spawner = (async ({ env }: { env: Record<string, string> }) => {
    const toMain: Array<(data: unknown) => void> = [];
    const backlog: unknown[] = [];
    const exitListeners: Array<(code: number) => void> = [];
    let frozen = false;
    const deliverToMain = (data: unknown) => {
      if (toMain.length === 0) backlog.push(data);
      else for (const l of toMain) l(data);
    };
    const proc = {} as FakeProc;
    const exit = (code: number) => {
      if (proc.exited) return;
      proc.exited = true;
      queueMicrotask(() => {
        for (const l of exitListeners) l(code);
      });
    };
    const stderr = new PassThrough();
    Object.assign(proc, {
      pid: 1000 + procs.length,
      env,
      exited: false,
      received: [] as MainToHost[],
      stdout: new PassThrough(),
      stderr,
      stderrStream: stderr,
      postMessage(message: MainToHost) {
        if (proc.exited) throw new Error('port closed');
        const copy = structuredClone(message);
        proc.received.push(copy);
        queueMicrotask(() => {
          if (!frozen && !proc.exited) proc.host.receive(copy);
        });
      },
      onMessage(listener: (data: unknown) => void) {
        toMain.push(listener);
        for (const m of backlog.splice(0)) listener(m);
      },
      onExit(listener: (code: number) => void) {
        exitListeners.push(listener);
      },
      kill() {
        exit(-9);
      },
      freeze() {
        frozen = true;
      },
      crash(code = 1) {
        exit(code);
      },
      inject(raw: unknown) {
        deliverToMain(raw);
      },
    });
    proc.host = createHost({
      send: (msg: HostToMain) => {
        if (frozen || proc.exited) return;
        const copy = structuredClone(msg);
        queueMicrotask(() => deliverToMain(copy));
      },
      clock,
      worker: createInlineWorker(),
      createRuntime: control.factory,
      journal: () => memoryJournalIo(),
      exit,
      version: '0.0.0-test',
    });
    procs.push(proc);
    return proc;
  }) as unknown as HostSpawner & { procs: FakeProc[] };
  spawner.procs = procs;
  return spawner;
}

interface Rig {
  t: TestContext;
  clock: FakeClock;
  control: ReturnType<typeof runtimeControl>;
  spawn: ReturnType<typeof fakeSpawner>;
  gateway: ScriptedGateway;
  service: HarnessService;
  logs: Array<{ level: string; message: string; meta?: unknown }>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.service.approvals.dispose();
    await r.t.cleanup();
  }
});

function recordingLogger(sink: Rig['logs']): Logger {
  const make = (): Logger => ({
    debug: (message, meta) => void sink.push({ level: 'debug', message, meta }),
    info: (message, meta) => void sink.push({ level: 'info', message, meta }),
    warn: (message, meta) => void sink.push({ level: 'warn', message, meta }),
    error: (message, meta) => void sink.push({ level: 'error', message, meta }),
    child: () => make(),
  });
  return make();
}

async function rig(opts: { gateway?: ScriptedGateway } = {}): Promise<Rig> {
  const t = await createTestContext({ mock: true });
  const logs: Rig['logs'] = [];
  t.ctx.log = recordingLogger(logs);
  const clock = fakeClock();
  const control = runtimeControl();
  const spawn = fakeSpawner(clock, control);
  const gateway = opts.gateway ?? scriptedGateway();
  const service = createHarnessService(t.ctx, { gateway, spawn, clock });
  const r = { t, clock, control, spawn, gateway, service, logs };
  rigs.push(r);
  return r;
}

const proc = (r: Rig, i = -1) => r.spawn.procs.at(i) as FakeProc;

// ─── Supervisor ──────────────────────────────────────────────────────────────────────────────────────────────

describe('supervisor: lazy start, init, ready', () => {
  it('starts nothing until asked; then spawns with the scrubbed env, sends init and becomes ready', async () => {
    const r = await rig();
    expect(r.spawn.procs).toHaveLength(0);
    expect(r.service.supervisor.info().hostState).toBe('stopped');
    const states: string[] = [];
    r.service.supervisor.onState((i) => states.push(i.hostState));
    await r.service.supervisor.ready();
    expect(states).toEqual(['starting', 'ready']);
    const p = proc(r);
    expect(p.received[0]).toMatchObject({ t: 'init', protocol: 1, installId: r.t.ctx.installId, platform: process.platform, settings: { mock: true } });
    expect((p.received[0] as { dataDir: string }).dataDir).toBe(join(r.t.ctx.paths.data, 'harness'));
    expect(Object.keys(p.env).some((k) => /KEY|TOKEN|SECRET/.test(k))).toBe(false);
    expect(r.service.supervisor.info()).toMatchObject({ hostState: 'ready', viewOnly: false, git: { ok: true }, ripgrep: true, version: '0.0.0-test' });
    expect(await r.service.supervisor.ping()).toMatchObject({ phase: 'ready' });
  });

  it('commands round-trip; a failed command rejects with the host error; command ids are idempotent while pending', async () => {
    const r = await rig();
    r.control.handle = async (cmd) => {
      if (cmd.op === 'thread.delete') throw new GmiError('not_found', 'No such thread.');
      return { op: cmd.op };
    };
    expect(await r.service.supervisor.command({ op: 'sandbox.selftest' })).toEqual({ op: 'sandbox.selftest' });
    await expect(r.service.supervisor.command({ op: 'thread.delete', threadId: THREAD })).rejects.toMatchObject({ code: 'not_found', message: 'No such thread.' });
    let release!: () => void;
    r.control.handle = () => new Promise((res) => (release = () => res({ once: true })));
    const a = r.service.supervisor.command({ op: 'query', name: 'threads', args: null }, { commandId: 'cmd_same' });
    const b = r.service.supervisor.command({ op: 'query', name: 'threads', args: null }, { commandId: 'cmd_same' });
    await flush();
    release();
    expect(await a).toEqual({ once: true });
    expect(await b).toEqual({ once: true });
    expect(proc(r).received.filter((m) => m.t === 'cmd' && m.id === 'cmd_same')).toHaveLength(1);
  });
});

describe('supervisor: watchdog, restarts, crash loop, quit', () => {
  it('the liveness watchdog is armed only after ready: a slow start is not killed while heartbeats arrive', async () => {
    const r = await rig();
    let open!: () => void;
    r.control.startGate = new Promise((res) => (open = res));
    void r.service.supervisor.ready();
    await flush();
    // 2 minutes of migration: pongs (phase 'migrating') keep arriving, nothing is killed.
    for (let i = 0; i < 24; i += 1) {
      r.clock.advance(SUPERVISOR_LIMITS.pingIntervalMs);
      await flush();
    }
    expect(r.spawn.procs).toHaveLength(1);
    expect(r.service.supervisor.info()).toMatchObject({ hostState: 'starting', phase: 'migrating' });
    open();
    await flush();
    expect(r.service.supervisor.info().hostState).toBe('ready');
  });

  it('a host that stops answering during startup is killed only after the 5-minute startup budget', async () => {
    const r = await rig();
    r.control.startGate = new Promise(() => undefined);
    void r.service.supervisor.ready().catch(() => undefined);
    await flush();
    proc(r).freeze();
    r.clock.advance(SUPERVISOR_LIMITS.pongTimeoutMs * 4);
    await flush();
    expect(proc(r).exited).toBe(false);
    for (let i = 0; i < 62 && !proc(r, 0).exited; i += 1) {
      r.clock.advance(SUPERVISOR_LIMITS.pingIntervalMs);
      await flush();
    }
    expect(proc(r, 0).exited).toBe(true);
    expect(r.service.supervisor.info().hostState).toBe('restarting');
  });

  it('after ready: no pong for 15 s → kill, then restart with backoff 1 s', async () => {
    const r = await rig();
    await r.service.supervisor.ready();
    proc(r).freeze();
    let elapsed = 0;
    while (!proc(r, 0).exited && elapsed < 60_000) {
      r.clock.advance(SUPERVISOR_LIMITS.pingIntervalMs);
      elapsed += SUPERVISOR_LIMITS.pingIntervalMs;
      await flush();
    }
    expect(elapsed).toBe(20_000); // pings at 5, 10, 15 s unanswered; at 20 s the last pong is > 15 s old
    expect(r.logs.some((l) => l.message === 'killing the harness host' && (l.meta as { reason: string }).reason === 'no pong for 15 s')).toBe(true);
    expect(r.service.supervisor.info().hostState).toBe('restarting');
    r.clock.advance(999);
    await flush();
    expect(r.spawn.procs).toHaveLength(1);
    r.clock.advance(1);
    await flush();
    expect(r.spawn.procs).toHaveLength(2);
    expect(r.service.supervisor.info()).toMatchObject({ hostState: 'ready', restarts: 1 });
  });

  it('crash loop: backoff 1, 2, 4, 8 s, then `crashed` after 5 crashes in 5 min; Restart runtime recovers', async () => {
    const r = await rig();
    r.control.startFails = true;
    const ready = r.service.supervisor.ready().then(
      () => 'ready',
      (e: unknown) => e,
    );
    const spawnTimes: number[] = [];
    const start = r.clock.now();
    for (let i = 0; i < 40 && r.service.supervisor.info().hostState !== 'crashed'; i += 1) {
      await flush();
      if (spawnTimes.length < r.spawn.procs.length) spawnTimes.push(r.clock.now() - start);
      r.clock.advance(500);
    }
    expect(spawnTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    expect(r.service.supervisor.info()).toMatchObject({ hostState: 'crashed', viewOnly: true, lastExitCode: 1 });
    expect(await ready).toMatchObject({ code: 'internal' });
    await expect(r.service.supervisor.command({ op: 'sandbox.selftest' })).rejects.toMatchObject({ code: 'internal' });

    r.control.startFails = false;
    await r.service.supervisor.restart();
    expect(r.service.supervisor.info()).toMatchObject({ hostState: 'ready', viewOnly: false });
  });

  it('stop: shutdown with grace, host exits, state stopped; a host that ignores it is killed after 3 s', async () => {
    const r = await rig();
    await r.service.supervisor.ready();
    const stopped = r.service.supervisor.stop();
    await flush();
    expect(proc(r).received.at(-1)).toEqual({ t: 'shutdown', graceMs: 2_500 });
    await stopped;
    expect(r.service.supervisor.info().hostState).toBe('stopped');

    const r2 = await rig();
    await r2.service.supervisor.ready();
    proc(r2).freeze();
    const stopping = r2.service.supervisor.stop();
    await flush();
    expect(proc(r2).exited).toBe(false);
    r2.clock.advance(SUPERVISOR_LIMITS.shutdownKillAfterMs);
    await flush();
    await stopping;
    expect(proc(r2).exited).toBe(true);
    expect(r2.service.supervisor.info().hostState).toBe('stopped');
  });

  it('drops invalid host messages with a warning and keeps running', async () => {
    const r = await rig();
    await r.service.supervisor.ready();
    proc(r).inject({ t: 'event', event: { threadId: THREAD, seq: 'x' } });
    proc(r).inject({ t: 'spawn', argv: ['sh'] });
    proc(r).inject('garbage');
    await flush();
    expect(r.logs.filter((l) => l.message === 'dropped an invalid message from the harness host')).toHaveLength(3);
    expect(r.t.emitted.filter((e) => e.name === 'code:event')).toHaveLength(0);
    expect(r.service.supervisor.info().hostState).toBe('ready');
  });
});

describe('bridge: gateway requests, runs, events, RPC', () => {
  it('runs the host request through the gateway with the supervisor-assigned owner; events come back batched and in order', async () => {
    const r = await rig();
    r.gateway.script.push(replyEvents('Hello agent', { chunk: 3 }));
    await r.service.supervisor.command({ op: 'run.send', threadId: THREAD, text: 'go' });
    expect([...r.gateway.runs.values()]).toEqual([{ threadId: THREAD, turnId: `${THREAD}:1`, runId: 'run_1' }]);
    const link = r.control.link as MainLink;
    const req = sampleRequest({ scope: { threadId: THREAD, turnId: `${THREAD}:1`, runId: 'run_1', step: 0 } });
    const events: GatewayEvent[] = [];
    const done = (async () => {
      for await (const e of link.gateway.stream(req, new AbortController().signal)) events.push(e);
    })();
    await flush(30);
    r.clock.advance(50);
    await flush(30);
    await done;
    expect(r.gateway.requests).toHaveLength(1);
    expect(r.gateway.requests[0]?.owner).toEqual({ hostId: r.service.supervisor.info().hostId });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hello agent');
    expect(events.at(-1)?.type).toBe('finish');
    const batches = proc(r).received.filter((m) => m.t === 'gw.events');
    expect(batches.length).toBeLessThan(events.length);
  });

  it('killing the host mid-stream aborts its upstream request (abortOwner), closes its runs and withdraws its approvals', async () => {
    const aborted: string[] = [];
    const base = scriptedGateway();
    const gateway: ScriptedGateway = {
      ...base,
      async *stream(req: GatewayRequest, signal: AbortSignal, owner?: { hostId: string } | null) {
        base.requests.push({ req, owner: owner ?? null });
        yield { type: 'started', attempt: 1, model: 'm', api: 'chat' } as GatewayEvent;
        await new Promise<void>((res) => signal.addEventListener('abort', () => res(), { once: true }));
        aborted.push(req.requestId);
      },
      abortOwner(hostId: string) {
        aborted.push(`owner:${hostId}`);
        base.abortOwner(hostId);
      },
    };
    const r = await rig({ gateway });
    await r.service.supervisor.command({ op: 'run.send', threadId: THREAD, text: 'go' });
    const hostId = r.service.supervisor.info().hostId as string;
    const link = r.control.link as MainLink;
    const iter = link.gateway.stream(sampleRequest({ scope: { threadId: THREAD, turnId: `${THREAD}:1`, runId: 'run_1', step: 0 } }), new AbortController().signal)[Symbol.asyncIterator]();
    void iter.next();
    void link.approvals.request(sampleApproval(), new AbortController().signal).catch(() => undefined);
    await flush(30);
    expect(r.service.approvals.listPending()).toHaveLength(1);
    let release!: () => void;
    r.control.handle = () => new Promise(() => (release = () => undefined));
    const pendingCmd = r.service.supervisor.command({ op: 'query', name: 'threads', args: null }).catch((e: unknown) => e);
    await flush();
    void release;

    proc(r).crash(139);
    await flush(30);
    expect(aborted).toContain(`owner:${hostId}`);
    expect(aborted).toContain('req_1');
    expect(r.gateway.runs.size).toBe(0);
    expect(r.service.approvals.listPending()).toHaveLength(0);
    expect(r.t.emitted.filter((e) => e.name === 'code:approval').map((e) => (e.payload as { resolved: boolean }).resolved)).toEqual([false, true]);
    expect(await pendingCmd).toMatchObject({ code: 'internal' });
    expect(r.service.supervisor.info()).toMatchObject({ hostState: 'restarting', lastExitCode: 139 });
  });

  it('run.ended and run.interrupt close the run in the gateway; gw.cancel aborts the upstream request', async () => {
    const r = await rig();
    await r.service.supervisor.command({ op: 'run.send', threadId: THREAD, text: 'go' });
    expect(r.gateway.runs.has('run_1')).toBe(true);
    await r.service.supervisor.command({ op: 'run.interrupt', threadId: THREAD });
    expect(r.gateway.runs.size).toBe(0);
    await r.service.supervisor.command({ op: 'run.resume', threadId: THREAD });
    expect(r.gateway.runs.has('run_1')).toBe(true);
    r.control.link?.events.runEnded(THREAD, 'run_1');
    await flush();
    expect(r.gateway.runs.size).toBe(0);
  });

  it('forwards thread events and thread lists to the renderer', async () => {
    const r = await rig();
    await r.service.supervisor.ready();
    r.control.link?.events.event({ threadId: THREAD, seq: null, type: 'delta', itemId: 'msg_1', field: 'text', text: 'hi', offset: 0 });
    r.control.link?.events.threads([]);
    await flush();
    expect(r.t.emitted.filter((e) => e.name === 'code:event' || e.name === 'code:threads').map((e) => e.name)).toEqual(['code:event', 'code:threads']);
  });

  it('RPC router: dialog.confirm shows a structured native dialog; unknown handlers answer not_implemented', async () => {
    const r = await rig();
    await r.service.supervisor.ready();
    const link = r.control.link as MainLink;
    r.t.platform.confirmAnswer = false;
    expect(await link.rpc.call('dialog.confirm', { kind: 'destructive', subject: { tool: 'bash', command: 'rm -rf build\n‮evil', risk: ['destructive'] } })).toEqual({ confirmed: false });
    expect(r.t.platform.confirms.at(-1)).toEqual({ title: 'Run a destructive command?', message: 'The agent wants to run a command that can delete or overwrite data.' });
    await expect(link.rpc.call('mcp.gmi.call', { tool: 'search_models', args: {}, requestId: null })).rejects.toMatchObject({ code: 'not_implemented' });
    r.service.setRpcHandlers({ 'mcp.gmi.call': async (params) => ({ echoed: params.tool }) });
    expect(await link.rpc.call('mcp.gmi.call', { tool: 'search_models', args: {}, requestId: null })).toEqual({ echoed: 'search_models' });
  });
});

// ─── Approval broker ─────────────────────────────────────────────────────────────────────────────────────────

interface BrokerRig {
  broker: ReturnType<typeof createApprovalBroker>;
  clock: FakeClock;
  delivered: Array<{ hostId: string; requestId: string; decision: ApprovalDecision }>;
  emitted: Array<{ request: ApprovalRequest; resolved: boolean }>;
  dialogs: Array<{ title: string; message: string; detail?: string }>;
  notes: string[];
  answer: { value: boolean };
  focused: { value: boolean };
}

function brokerRig(): BrokerRig {
  const clock = fakeClock();
  const delivered: BrokerRig['delivered'] = [];
  const emitted: BrokerRig['emitted'] = [];
  const dialogs: BrokerRig['dialogs'] = [];
  const notes: string[] = [];
  const answer = { value: true };
  const focused = { value: true };
  const broker = createApprovalBroker({
    platform: {
      confirm: async (o) => {
        dialogs.push({ title: o.title, message: o.message, detail: o.detail });
        return answer.value;
      },
      notify: (o) => void notes.push(o.body),
      isAppFocused: () => focused.value,
    },
    emit: (p) => void emitted.push(structuredClone(p)),
    deliver: (hostId, requestId, decision) => void delivered.push({ hostId, requestId, decision }),
    clock,
    log: silentLogger,
  });
  return { broker, clock, delivered, emitted, dialogs, notes, answer, focused };
}

describe('approval broker (§9.4, §10.3, H-T7, H-T17)', () => {
  it('main decides allowedDecisions, whatever the host sent', () => {
    expect(allowedDecisionsFor({ kind: 'command', tool: 'bash', risk: [] })).toEqual(['allow_once', 'allow_thread', 'allow_always', 'deny', 'cancel_run']);
    expect(allowedDecisionsFor({ kind: 'mcp', tool: 'mcp__gmi__submit_generation', risk: [] })).toEqual(['allow_once', 'deny', 'cancel_run']);
    expect(allowedDecisionsFor({ kind: 'mcp', tool: 'mcp__gmi__upload_media', risk: [] })).toEqual(['allow_once', 'deny', 'cancel_run']);
    expect(allowedDecisionsFor({ kind: 'compute', tool: 'sandbox_create', risk: [] }, false)).toEqual(['deny', 'cancel_run']);
    expect(allowedDecisionsFor({ kind: 'mcp', tool: 'mcp__x__buy', risk: ['costs_money'] })).toEqual(['allow_once', 'deny', 'cancel_run']);
    expect(allowedDecisionsFor({ kind: 'command', tool: 'bash', risk: ['local_network'] })).toEqual(['allow_once', 'deny', 'cancel_run']);
    expect(allowedDecisionsFor({ kind: 'command', tool: 'bash', risk: ['destructive'] })).toEqual(['allow_once', 'deny', 'cancel_run']);
    expect(allowedDecisionsFor({ kind: 'question', tool: 'question', risk: [] })).toEqual(['answer', 'deny', 'cancel_run']);

    const b = brokerRig();
    const shown = b.broker.submit('h1', sampleApproval({ tool: 'mcp__gmi__submit_generation', kind: 'mcp', detail: { args: '{"model":"x"}' }, allowedDecisions: ['allow_always'] }));
    expect(shown?.allowedDecisions).toEqual(['allow_once', 'deny', 'cancel_run']);
    expect(shown?.expiresAt).toBe(new Date(b.clock.now() + APPROVAL_LIMITS.ttlMs).toISOString());
    expect(b.emitted).toEqual([{ request: shown, resolved: false }]);
  });

  it('refuses decisions outside allowedDecisions, and "Always" rules for another or a wildcard tool', async () => {
    const b = brokerRig();
    b.broker.submit('h1', sampleApproval({ tool: 'mcp__gmi__submit_generation', kind: 'mcp', detail: { args: '{}' } }));
    await expect(b.broker.respond('apr_1', { kind: 'allow_thread' })).rejects.toMatchObject({ code: 'invalid_input' });
    b.broker.submit('h1', sampleApproval({ requestId: 'apr_2' }));
    await expect(b.broker.respond('apr_2', { kind: 'allow_always', rule: { tool: 'bash*', pattern: 'npm test', effect: 'allow', scope: 'project' } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(b.broker.respond('apr_2', { kind: 'allow_always', rule: { tool: 'edit', pattern: 'npm test', effect: 'allow', scope: 'project' } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(b.broker.respond('nope', { kind: 'deny' })).rejects.toMatchObject({ code: 'not_found' });
    expect(b.delivered).toEqual([]);
  });

  it('native dialogs: broader rules, standing network/MCP grants, high-risk requests; declining keeps it pending', async () => {
    const npm = sampleApproval();
    expect(confirmationFor(npm, { kind: 'allow_once' })).toBeNull();
    expect(confirmationFor(npm, { kind: 'allow_thread' })).toBeNull();
    expect(confirmationFor(npm, { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm test -- --watch=false', effect: 'allow', scope: 'project' } })).toBeNull();
    expect(confirmationFor(npm, { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm', effect: 'allow', scope: 'project' } })).not.toBeNull();
    expect(confirmationFor(npm, { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm test*', effect: 'allow', scope: 'global' } })).not.toBeNull();
    expect(confirmationFor(npm, { kind: 'allow_always', rule: { tool: 'bash', pattern: null, effect: 'allow', scope: 'thread' } })).not.toBeNull();
    expect(confirmationFor(npm, { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm', effect: 'deny', scope: 'project' } })).toBeNull();
    const web = sampleApproval({ kind: 'network', tool: 'web_fetch', detail: { host: 'example.com' }, suggestedRule: { tool: 'web_fetch', pattern: 'example.com', effect: 'allow', scope: 'thread' } });
    expect(confirmationFor(web, { kind: 'allow_thread' })).not.toBeNull();
    expect(confirmationFor(web, { kind: 'allow_always', rule: { tool: 'web_fetch', pattern: 'example.com', effect: 'allow', scope: 'thread' } })).not.toBeNull();
    expect(confirmationFor(sampleApproval({ risk: ['unsandboxed'] }), { kind: 'allow_once' })).not.toBeNull();
    expect(confirmationFor(npm, { kind: 'allow_once', sensitiveWrites: true })).not.toBeNull();
    expect(withinSuggested({ pattern: 'npm test' }, null)).toBe(false);

    const b = brokerRig();
    b.broker.submit('h1', web);
    b.answer.value = false;
    await expect(b.broker.respond('apr_1', { kind: 'allow_thread' })).rejects.toMatchObject({ code: 'cancelled' });
    expect(b.broker.listPending()).toHaveLength(1);
    b.answer.value = true;
    await b.broker.respond('apr_1', { kind: 'allow_thread' });
    expect(b.dialogs).toHaveLength(2);
    expect(b.delivered).toEqual([{ hostId: 'h1', requestId: 'apr_1', decision: { kind: 'allow_thread' } }]);
    expect(b.emitted.at(-1)?.resolved).toBe(true);
  });

  it('one-shot tokens: minted on allow_once for paid tools, bound to the request and canonical args, consumed once', async () => {
    const b = brokerRig();
    b.broker.submit('h1', sampleApproval({ kind: 'mcp', tool: 'mcp__gmi__submit_generation', detail: { args: JSON.stringify({ model: 'img', prompt: 'a cat' }) } }));
    expect(b.broker.consumeToken({ requestId: 'apr_1', tool: 'submit_generation', args: { model: 'img', prompt: 'a cat' } })).toBe(false); // not decided yet
    await b.broker.respond('apr_1', { kind: 'allow_once' });
    expect(b.broker.consumeToken({ requestId: 'apr_1', tool: 'submit_generation', args: { model: 'img', prompt: 'a dog' } })).toBe(false);
    expect(b.broker.consumeToken({ requestId: 'apr_1', tool: 'upload_media', args: { prompt: 'a cat', model: 'img' } })).toBe(false);
    expect(b.broker.consumeToken({ requestId: 'apr_1', tool: 'submit_generation', args: { prompt: 'a cat', model: 'img' } })).toBe(true);
    expect(b.broker.consumeToken({ requestId: 'apr_1', tool: 'submit_generation', args: { prompt: 'a cat', model: 'img' } })).toBe(false);

    b.broker.submit('h1', sampleApproval({ requestId: 'apr_2', kind: 'mcp', tool: 'mcp__gmi__submit_generation', detail: { args: '{}' } }));
    await b.broker.respond('apr_2', { kind: 'allow_once' });
    b.clock.advance(APPROVAL_LIMITS.tokenTtlMs + 1);
    expect(b.broker.consumeToken({ requestId: 'apr_2', tool: 'mcp__gmi__submit_generation', args: {} })).toBe(false);

    b.broker.submit('h1', sampleApproval({ requestId: 'apr_3', kind: 'mcp', tool: 'mcp__gmi__submit_generation', detail: { args: '{}' } }));
    await b.broker.respond('apr_3', { kind: 'deny' });
    expect(b.broker.consumeToken({ requestId: 'apr_3', tool: 'submit_generation', args: {} })).toBe(false);
  });

  it('expires after 24 h as a deny with "no answer"; notifies when unfocused, throttled per thread', () => {
    const b = brokerRig();
    b.focused.value = false;
    b.broker.submit('h1', sampleApproval());
    b.broker.submit('h1', sampleApproval({ requestId: 'apr_2' }));
    expect(b.notes).toHaveLength(1);
    b.clock.advance(APPROVAL_LIMITS.ttlMs);
    expect(b.delivered.map((d) => d.decision)).toEqual([
      { kind: 'deny', feedback: 'No answer within 24 hours.' },
      { kind: 'deny', feedback: 'No answer within 24 hours.' },
    ]);
    expect(b.broker.listPending()).toEqual([]);
    b.broker.submit('h1', sampleApproval({ requestId: 'apr_3' }));
    expect(b.notes).toHaveLength(2);
  });

  it('withdraw only from the owning host; dropHost withdraws a dead host; a second answer while deciding conflicts', async () => {
    const b = brokerRig();
    b.broker.submit('h1', sampleApproval());
    b.broker.withdraw('apr_1', 'h2');
    expect(b.broker.listPending()).toHaveLength(1);
    b.broker.submit('h2', sampleApproval({ requestId: 'apr_2', risk: ['unsandboxed'] }));
    let answer!: (v: boolean) => void;
    const slow = createApprovalBroker({
      platform: { confirm: () => new Promise((res) => (answer = res)), notify: () => undefined, isAppFocused: () => true },
      emit: () => undefined,
      deliver: () => undefined,
      clock: b.clock,
      log: silentLogger,
    });
    slow.submit('h1', sampleApproval({ risk: ['unsandboxed'] }));
    const first = slow.respond('apr_1', { kind: 'allow_once' });
    await expect(slow.respond('apr_1', { kind: 'deny' })).rejects.toMatchObject({ code: 'conflict' });
    answer(true);
    await first;
    slow.dispose();
    b.broker.dropHost('h1');
    expect(b.broker.listPending().map((p) => p.requestId)).toEqual(['apr_2']);
    expect(b.delivered).toEqual([]);
  });

  it('dialog text is built from fields: control, bidi and zero-width characters stripped; command ≤ 2 KiB; ≤ 20 paths', async () => {
    expect(sanitizeDialogText('rm -rf x\n\r\t‮gnp.exe​⁦y\u0007')).toBe('rm -rf x gnp.exe y');
    expect(sanitizeDialogText('a'.repeat(5_000), 2_048)).toHaveLength(2_048);
    const b = brokerRig();
    await b.broker.confirmStructured('sensitive_write', {
      tool: 'bash',
      command: `npm run x\nOK to continue? Click Allow‮${'z'.repeat(5_000)}`,
      cwd: '/work',
      paths: Array.from({ length: 30 }, (_, i) => `/work/.husky/${i}‏`),
      risk: ['execution_sensitive'],
    });
    const d = b.dialogs[0] as { title: string; detail: string };
    expect(d.title).toBe('Allow writes to sensitive files?');
    const command = d.detail.split('\n').find((l) => l.startsWith('Command: ')) as string;
    expect(command.length).toBeLessThanOrEqual('Command: '.length + 2_048);
    expect(command).not.toMatch(/[‮\n]/);
    expect(d.detail.split('\n').filter((l) => l.startsWith('  /work/.husky/'))).toHaveLength(20);
    expect(d.detail).toContain('… and 10 more');
    expect(d.detail).not.toMatch(/[‏‮]/);
  });

  it('end to end: a host approval reaches the renderer with main-filled decisions; the answer reaches the host', async () => {
    const r = await rig();
    await r.service.supervisor.ready();
    const decision = r.control.link?.approvals.request(sampleApproval({ allowedDecisions: ['allow_always'] }), new AbortController().signal);
    await flush();
    const shown = r.t.emitted.find((e) => e.name === 'code:approval')?.payload as { request: ApprovalRequest };
    expect(shown.request.allowedDecisions).toEqual(['allow_once', 'allow_thread', 'allow_always', 'deny', 'cancel_run']);
    await r.service.approvals.respond('apr_1', { kind: 'allow_once' });
    expect(await decision).toEqual({ kind: 'allow_once' });
  });
});

// ─── stdio drain ──────────────────────────────────────────────────────────────────────────────────────────────

describe('stdio drain (§5.1): a chatty host never blocks', () => {
  it('drains 10 MB of stderr completely, logging at most 50 lines per second plus a dropped count', async () => {
    const clock = fakeClock();
    const lines: string[] = [];
    const warns: unknown[] = [];
    const line = `${'e'.repeat(99)}\n`;
    const chunk = line.repeat(655); // ≈ 64 KiB
    let produced = 0;
    const stream = Readable.from(
      (function* () {
        while (produced < 10 * 1024 * 1024) {
          produced += chunk.length;
          yield chunk;
        }
      })(),
    );
    const ended = new Promise<void>((res) => stream.on('end', () => res()));
    drainToLog(stream, { info: (_m, meta) => void lines.push((meta as { line: string }).line), warn: (_m, meta) => void warns.push(meta) }, clock, 'stderr');
    await ended;
    expect(produced).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    expect(lines).toHaveLength(SUPERVISOR_LIMITS.stdioLinesPerSecond);
    clock.advance(1_000);
    stream.emit('data', 'next\n');
    expect(warns).toHaveLength(1);
    expect((warns[0] as { dropped: number }).dropped).toBeGreaterThan(100_000);
    expect(lines.at(-1)).toBe('next');
  });

  it('through the supervisor: a host flooding stderr with no newlines keeps working', async () => {
    const r = await rig();
    await r.service.supervisor.ready();
    const stderr = proc(r).stderrStream;
    let blocked = 0;
    for (let i = 0; i < 160; i += 1) if (!stderr.write('x'.repeat(65_536))) blocked += 1;
    await flush(5);
    expect(await r.service.supervisor.ping()).toMatchObject({ phase: 'ready' });
    expect(stderr.writableLength).toBe(0);
    expect(blocked).toBeLessThan(160);
    expect(r.logs.filter((l) => l.message === 'harness stderr').length).toBeLessThanOrEqual(SUPERVISOR_LIMITS.stdioLinesPerSecond);
  });
});

// ─── View-only fallback ──────────────────────────────────────────────────────────────────────────────────────

describe('view-only fallback (§5.1, §17)', () => {
  async function seedDb(file: string) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, thread_seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
        context_id TEXT NOT NULL, run_id TEXT, turn INTEGER, step INTEGER, type TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(thread_id, thread_seq));
      CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT, strategy TEXT, branch TEXT, base_ref TEXT, base_sha TEXT, worktree_path TEXT,
        git_dir TEXT, common_dir TEXT, git_pointer TEXT, object_dir TEXT, setup_state TEXT, settings TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT,
        cost_usd REAL NOT NULL DEFAULT 0, tokens TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, instructions_hash TEXT, env_block TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE approvals (request_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, tool_call_id TEXT, kind TEXT, request TEXT NOT NULL, decision TEXT, decided_at TEXT);
      CREATE TABLE checkpoints (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn INTEGER NOT NULL, commit_sha TEXT NOT NULL, tree_sha TEXT NOT NULL, files_changed INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE todos (context_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, items TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, context_id TEXT NOT NULL, ord INTEGER NOT NULL, in_context INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE compactions (id TEXT PRIMARY KEY, thread_id TEXT);
    `);
    const settings = JSON.stringify({ model: 'zai-org/GLM-5.3', mode: 'auto' });
    db.prepare("INSERT INTO threads (id, project_id, title, strategy, branch, settings, status, status_reason, cost_usd, tokens, archived, created_at, updated_at) VALUES (?, 'p1', 'Fix', 'worktree', 'gmi/c0de00/fix', ?, 'interrupted', 'host restart', 0.25, ?, 0, '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z')").run(
      THREAD,
      settings,
      JSON.stringify({ input: 10, cached: 5, output: 2, reasoning: 0 }),
    );
    db.prepare("INSERT INTO threads (id, project_id, title, strategy, settings, status, tokens, archived, created_at, updated_at) VALUES ('t2', 'p2', 'Old', 'root', '{}', 'completed', '{}', 1, '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z')").run();
    db.prepare("INSERT INTO approvals (request_id, thread_id, request, decision) VALUES ('apr_1', ?, '{}', NULL)").run(THREAD);
    db.prepare("INSERT INTO checkpoints VALUES ('ckpt_1', ?, 1, 'c', 't', 3, '2026-11-02T10:05:00Z')").run(THREAD);
    db.prepare('INSERT INTO todos VALUES (?, ?, ?, NULL)').run(`ctx_${THREAD}`, THREAD, JSON.stringify([{ id: '1', text: 'tests', status: 'in_progress' }]));
    const insert = db.prepare("INSERT INTO events (thread_id, thread_seq, event_id, context_id, type, at, payload) VALUES (?, ?, ?, 'ctx', ?, 'now', ?)");
    const tool = (status: string) => ({ kind: 'tool', id: 'tc_1', seq: 0, turn: 1, step: 0, toolCallId: 'tc_1', tool: 'bash', title: 'npm test', argsPreview: '{}', status, output: null, durationMs: null, at: 'now' });
    insert.run(THREAD, 1, 'e1', 'item', JSON.stringify({ type: 'item', item: { kind: 'user', id: 'msg_1', seq: 0, turn: 1, text: 'go', steering: false, at: 'now' } }));
    insert.run(THREAD, 2, 'e2', 'tool.started', JSON.stringify({ internal: true }));
    insert.run(THREAD, 3, 'e3', 'item', JSON.stringify({ type: 'item', item: tool('running') }));
    insert.run(THREAD, 4, 'e4', 'item', JSON.stringify({ type: 'item', item: { kind: 'evil', html: '<img onerror>' } }));
    insert.run(THREAD, 5, 'e5', 'item', JSON.stringify({ type: 'item', item: tool('succeeded') }));
    db.close();
  }

  it('serves threads, a thread and the timeline read-only from the host database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gmi-desk-h20-viewonly-'));
    try {
      const file = join(dir, 'harness.sqlite');
      await expect(openReadOnlyHarnessDb(file)).rejects.toMatchObject({ code: 'not_found' });
      await seedDb(file);
      const db = await openReadOnlyHarnessDb(file);
      try {
        expect(db.listThreads().map((t) => t.id)).toEqual([THREAD, 't2']);
        expect(db.listThreads({ archived: false })).toHaveLength(1);
        expect(db.listThreads({ projectId: 'p2' })[0]).toMatchObject({ id: 't2', strategy: 'root', archived: true, status: 'completed' });
        const thread = db.getThread(THREAD);
        expect(thread).toMatchObject({
          status: 'interrupted',
          statusReason: 'host restart',
          pendingApprovals: 1,
          model: 'zai-org/GLM-5.3',
          mode: 'auto',
          costUsd: 0.25,
          tokens: { input: 10, cached: 5, output: 2, reasoning: 0 },
          checkpoints: [{ id: 'ckpt_1', turn: 1, filesChanged: 3 }],
          todo: [{ id: '1', text: 'tests', status: 'in_progress' }],
          lastSeq: 5,
          meter: { estimated: true, windowTokens: 160_000 },
        });
        expect(() => db.getThread('missing')).toThrow(GmiError);
        const all = db.getTimeline(THREAD);
        expect(all.items.map((i) => [i.id, i.seq])).toEqual([
          ['msg_1', 1],
          ['tc_1', 5],
        ]);
        expect(all.items[1]).toMatchObject({ status: 'succeeded' });
        expect(all).toMatchObject({ hasMore: false, lastSeq: 5 });
        const page = db.getTimeline(THREAD, { afterSeq: 0, limit: 1 });
        expect(page).toMatchObject({ hasMore: true, items: [{ id: 'msg_1' }] });
        const before = db.getTimeline(THREAD, { beforeSeq: 5, limit: 2 });
        expect(before.items.map((i) => i.id)).toEqual(['tc_1']);
        expect(before.hasMore).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the supervisor opens it only while crashed', async () => {
    const r = await rig();
    expect(await r.service.supervisor.viewOnlyDb()).toBeNull();
    r.control.startFails = true;
    void r.service.supervisor.ready().catch(() => undefined);
    for (let i = 0; i < 40 && r.service.supervisor.info().hostState !== 'crashed'; i += 1) {
      await flush();
      r.clock.advance(1_000);
    }
    expect(r.service.supervisor.info().hostState).toBe('crashed');
    await expect(r.service.supervisor.viewOnlyDb()).rejects.toMatchObject({ code: 'not_found' });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(r.t.ctx.paths.data, 'harness'), { recursive: true });
    await seedDb(join(r.t.ctx.paths.data, 'harness', 'harness.sqlite'));
    const db = await r.service.supervisor.viewOnlyDb();
    expect(db?.listThreads().map((t) => t.id)).toContain(THREAD);
  });
});

// ─── Slice ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('slice registration (src/main/slices/harness.ts)', () => {
  it('registers no IPC namespace, starts nothing, adds the dev-only Diagnostics check and stops the host at quit', async () => {
    const t = await createTestContext({ mock: true });
    try {
      const clock = fakeClock();
      const control = runtimeControl();
      const spawn = fakeSpawner(clock, control);
      const disposers: Array<() => void | Promise<void>> = [];
      const registered: string[] = [];
      const gateway = scriptedGateway() as GmiGateway;
      const deps = { gateway, mcp: { callTool: async () => ({}) as never }, auth: {} as never, budget: {} as never, compute: {} as never };
      const slice = await setupHarnessSlice(t.ctx, deps, { registerApi: (ns) => void registered.push(ns), onDispose: (d) => void disposers.push(d) }, { spawn, clock, diagnostics: true });
      expect(registered).toEqual([]);
      expect(spawn.procs).toHaveLength(0);
      const action = listDiagnosticsActions().find((a) => a.id === HARNESS_DIAGNOSTICS_ID);
      expect(action).toMatchObject({ paid: false, label: 'Agent runtime check' });
      const report = await action?.run();
      expect(report).toMatch(/^Agent runtime ready \(protocol 1, version 0\.0\.0-test\), ping \d+ ms\. Sandbox: none \(unavailable: fake\)\. Git: 2\.43\.0\. Ripgrep: yes\./);
      expect(slice.supervisor.info().hostState).toBe('ready');
      for (const d of disposers) await d();
      expect(slice.supervisor.info().hostState).toBe('stopped');
      expect(listDiagnosticsActions().some((a) => a.id === HARNESS_DIAGNOSTICS_ID)).toBe(false);

      const quiet = await setupHarnessSlice(t.ctx, deps, { registerApi: () => undefined, onDispose: () => undefined }, { spawn, clock });
      expect(quiet.supervisor.info().hostState).toBe('stopped');
      expect(listDiagnosticsActions().some((a) => a.id === HARNESS_DIAGNOSTICS_ID)).toBe(false);
    } finally {
      await t.cleanup();
    }
  });
});
