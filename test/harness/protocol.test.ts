// H2-0: the main ↔ host protocol (src/harness/protocol.ts), the host's message handling and quarantine journal
// (src/harness/host.ts), its links to main (src/harness/gateway-client.ts) and the worker (src/harness/worker.ts),
// plus the acceptance "harness.cjs builds" (the built bundle also serves as the worker thread).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import type { ApprovalRequest, CodeThreadEvent, CodeThreadSummary } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayRequest } from '@shared/contracts/gateway';
import {
  canonicalJson,
  decodeHostToMain,
  decodeMainToHost,
  HARNESS_PROTOCOL,
  MAX_MESSAGE_BYTES,
  messageBytes,
  runStartedResult,
  turnIdOf,
  type HarnessCommand,
  type HostToMain,
  type MainToHost,
} from '@harness/protocol';
import { createHost, fileJournalIo, memoryJournalIo, openRecoveryJournal, QUARANTINE_AFTER_CRASHES } from '@harness/host';
import { createMainLink, createPortLog, safeMeta } from '@harness/gateway-client';
import { createInlineWorker, createThreadWorker } from '@harness/worker';
import { contextIdOf, harnessPaths, newId, newUlid, type CreateHostRuntime, type HostRuntime } from '@harness/types';
import { fakeClock, memoryLog, sampleApproval, sampleRequest, sampleSummary } from './fakes';

// ─── Samples ──────────────────────────────────────────────────────────────────────────────────────────────────

const T = '2026-11-02T10:00:00.000Z';
const THREAD = 'c0de0000-0000-4000-8000-000000000001';

const ITEM_EVENT: CodeThreadEvent = { threadId: THREAD, seq: 3, type: 'item', item: { kind: 'user', id: 'msg_1', seq: 3, turn: 1, text: 'hi', steering: false, at: T } };

const VALID_HOST_TO_MAIN: HostToMain[] = [
  { t: 'ready', protocol: 1, version: '0.1.0', sandbox: { kind: 'bwrap', ok: true, detail: null, network: 'proxy' }, git: { ok: true, version: '2.43.0' }, ripgrep: true },
  { t: 'cmd.result', id: 'cmd_1', ok: true, data: { runId: 'run_1', turn: 1 } },
  { t: 'cmd.result', id: 'cmd_1', ok: false, error: { code: 'not_found', message: 'Thread not found.' } },
  { t: 'gw.request', reqId: 'req_1', req: sampleRequest() },
  { t: 'gw.cancel', reqId: 'req_1' },
  { t: 'rpc', id: 'rpc_1', call: { method: 'dialog.confirm', params: { kind: 'destructive', subject: { tool: 'bash', command: 'rm -rf build', risk: ['destructive'] } } } },
  { t: 'rpc', id: 'rpc_2', call: { method: 'mcp.gmi.call', params: { tool: 'search_models', args: { q: 'glm' }, requestId: null } } },
  { t: 'event', event: ITEM_EVENT },
  { t: 'event', event: { threadId: THREAD, seq: null, type: 'delta', itemId: 'msg_2', field: 'text', text: 'Hel', offset: 0 } },
  { t: 'event', event: { threadId: THREAD, seq: 4, type: 'status', status: 'running', reason: null, queuePosition: null, queueReason: null } },
  { t: 'threads', threads: [sampleSummary()] },
  { t: 'approval.request', request: sampleApproval() },
  { t: 'approval.withdrawn', requestId: 'apr_1' },
  { t: 'run.ended', threadId: THREAD, runId: 'run_1' },
  { t: 'log', level: 'info', scope: 'loop', message: 'run.transition', meta: { from: 'idle', to: 'running' } },
  { t: 'pong', at: 1, phase: 'migrating' },
];

const COMMANDS: HarnessCommand[] = [
  {
    op: 'project.add',
    project: {
      id: 'p1',
      name: 'demo',
      rootPath: '/home/u/demo',
      defaultBranch: 'main',
      trust: { state: 'trusted', configHash: 'abc', trustedAt: T },
      worktreeDir: '/home/u/.local/share/gmi/wt',
      setupCommand: null,
      addedAt: T,
      threadCount: 0,
    },
  },
  { op: 'project.update', project: { id: 'p1', name: 'demo', rootPath: '/home/u/demo', defaultBranch: null, trust: { state: 'changed', configHash: null, trustedAt: null }, worktreeDir: '/w', setupCommand: 'npm ci', addedAt: T, threadCount: 2 } },
  { op: 'project.remove', projectId: 'p1', removeWorktrees: false },
  { op: 'thread.create', projectId: 'p1', init: { strategy: { kind: 'worktree', baseRef: 'main' }, settings: { mode: 'auto', budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 30 } } } },
  { op: 'thread.update', threadId: THREAD, patch: { title: 'x', settings: { maxContextTokens: null } } },
  { op: 'thread.archive', threadId: THREAD, removeWorktree: true, deleteBranch: false },
  { op: 'thread.delete', threadId: THREAD },
  { op: 'run.send', threadId: THREAD, text: 'Fix it' },
  { op: 'run.steer', threadId: THREAD, text: 'Also docs' },
  { op: 'run.interrupt', threadId: THREAD },
  { op: 'run.resume', threadId: THREAD },
  { op: 'query', name: 'timeline', args: { threadId: THREAD, afterSeq: 3 } },
  { op: 'git', name: 'commit', args: { message: 'x' } },
  { op: 'rules.delete', ruleId: 'rule_1' },
  {
    op: 'mcp.upsert',
    server: {
      id: 'mcp_1',
      name: 'Files',
      scope: 'global',
      projectId: null,
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.0.0'], envNames: [], cwd: null, network: false },
      enabled: true,
      toolPolicy: {},
      trustHash: null,
      toolHashes: null,
      resolvedVersion: null,
    },
  },
  { op: 'mcp.remove', serverId: 'mcp_1' },
  { op: 'sandbox.selftest' },
];

const VALID_MAIN_TO_HOST: MainToHost[] = [
  { t: 'init', protocol: 1, dataDir: '/tmp/x/data/harness', installId: '0123', settings: { mock: true, logLevel: 'info' }, platform: 'linux' },
  ...COMMANDS.map((cmd, i): MainToHost => ({ t: 'cmd', id: `cmd_${i}`, cmd })),
  { t: 'gw.events', reqId: 'req_1', events: [{ type: 'text', text: 'hi' }, { type: 'finish', reason: 'stop', raw: null }] },
  { t: 'rpc.result', id: 'rpc_1', ok: true, data: { confirmed: true } },
  { t: 'rpc.result', id: 'rpc_1', ok: false, error: { code: 'not_implemented', message: 'later' } },
  { t: 'approval.decision', requestId: 'apr_1', decision: { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm test', effect: 'allow', scope: 'project' } } },
  { t: 'ping', at: 5 },
  { t: 'shutdown', graceMs: 2_500 },
];

// ─── Protocol ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('protocol: zod validation on both sides', () => {
  it.each(VALID_HOST_TO_MAIN.map((m) => [m.t, m] as const))('main accepts a valid %s', (_t, msg) => {
    const r = decodeHostToMain(structuredClone(msg));
    expect(r.ok).toBe(true);
  });

  it.each(VALID_MAIN_TO_HOST.map((m) => [m.t === 'cmd' ? `cmd ${m.cmd.op}` : m.t, m] as const))('the host accepts a valid %s', (_t, msg) => {
    const r = decodeMainToHost(structuredClone(msg));
    expect(r.ok).toBe(true);
  });

  it('every command op has a valid sample', () => {
    expect(new Set(COMMANDS.map((c) => c.op)).size).toBe(17);
  });

  it('rejects unknown, malformed and non-object messages', () => {
    const bad: unknown[] = [
      null,
      'ready',
      [],
      { t: 'eval', code: 'process.exit()' },
      { t: 'ready', protocol: 2, version: 'x', sandbox: { kind: 'none', ok: false, detail: null, network: 'none' }, git: { ok: false, version: null }, ripgrep: false },
      { t: 'cmd.result', id: 'c', ok: false, error: { code: 'pwned', message: 'x' } },
      { t: 'event', event: { ...ITEM_EVENT, seq: -1 } },
      { t: 'event', event: { threadId: THREAD, seq: 4, type: 'delta', itemId: 'x', field: 'text', text: '', offset: 0 } },
      { t: 'event', event: { threadId: '../../etc', seq: 1, type: 'todo', todo: [] } },
      { t: 'approval.request', request: { ...sampleApproval(), risk: ['root'] } },
      { t: 'rpc', id: 'r', call: { method: 'secrets.dump', params: {} } },
      { t: 'rpc', id: 'r', call: { method: 'mcp.gmi.call', params: { tool: 'delete_everything', args: {}, requestId: null } } },
      { t: 'rpc', id: 'r', call: { method: 'dialog.confirm', params: { kind: 'loosen', subject: { tool: 'bash', risk: [] } } } },
      { t: 'gw.request', reqId: 'r', req: { ...sampleRequest(), messages: [] } },
      { t: 'gw.request', reqId: 'r', req: { ...sampleRequest(), target: { model: 'a', router: 'cost' } } },
      { t: 'log', level: 'fatal', scope: 'x', message: 'x' },
      { t: 'pong', at: 'now', phase: 'ready' },
    ];
    for (const raw of bad) expect(decodeHostToMain(raw).ok, JSON.stringify(raw)).toBe(false);
    const badToHost: unknown[] = [
      { t: 'cmd', id: 'c', cmd: { op: 'run.exec', threadId: THREAD } },
      { t: 'cmd', id: 'c', cmd: { op: 'run.send', threadId: THREAD, text: '' } },
      { t: 'cmd', id: 'c', cmd: { op: 'query', name: 'secrets', args: null } },
      { t: 'cmd', id: 'has spaces', cmd: { op: 'run.interrupt', threadId: THREAD } },
      { t: 'init', protocol: 2, dataDir: '/x', installId: 'i', settings: {}, platform: 'linux' },
      { t: 'gw.events', reqId: 'r', events: [{ type: 'usage' }] },
      { t: 'approval.decision', requestId: 'a', decision: { kind: 'allow_forever' } },
      { t: 'shutdown', graceMs: -1 },
    ];
    for (const raw of badToHost) expect(decodeMainToHost(raw).ok, JSON.stringify(raw)).toBe(false);
  });

  it('rejects oversized messages (4 MiB cap) before parsing them', () => {
    const big = { t: 'log', level: 'info', scope: 's', message: 'x', meta: { blob: 'a'.repeat(MAX_MESSAGE_BYTES) } };
    const r = decodeHostToMain(big);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? '' : r.reason).toMatch(/too large/);
    expect(decodeMainToHost({ t: 'gw.events', reqId: 'r', events: [{ type: 'text', text: 'b'.repeat(MAX_MESSAGE_BYTES) }] }).ok).toBe(false);
    expect(messageBytes({ a: 'é' })).toBe(Buffer.byteLength('{"a":"é"}'));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageBytes(cyclic)).toBe(Number.POSITIVE_INFINITY);
  });

  it('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('reads run.send / run.resume results (RunStartedResult)', () => {
    expect(runStartedResult({ runId: 'run_1', turn: 2, budgetWarning: 'low' })).toEqual({ runId: 'run_1', turn: 2, budgetWarning: 'low' });
    expect(runStartedResult({ runId: 'run 1', turn: 2 })).toBeNull();
    expect(runStartedResult({ runId: 'run_1', turn: -1 })).toBeNull();
    expect(runStartedResult(null)).toBeNull();
    expect(turnIdOf(THREAD, 3)).toBe(`${THREAD}:3`);
  });

  it('conventions: ids, context ids and data paths', () => {
    const a = newUlid(Date.parse(T));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newUlid(Date.parse(T) + 1) > a).toBe(true);
    expect(newId('tc')).toMatch(/^tc_[0-9A-Z]{26}$/);
    expect(contextIdOf(THREAD)).toBe(`ctx_${THREAD}`);
    const p = harnessPaths('/u/data/harness');
    expect(p.db).toBe('/u/data/harness/harness.sqlite');
    expect(p.spillFile('t', 'tc_1')).toBe('/u/data/harness/spill/t/tc_1.txt');
    expect(p.snapshotRepo('p')).toBe('/u/data/harness/snapshots/p.git');
  });
});

// ─── Host ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface HostHarness {
  sent: HostToMain[];
  exits: number[];
  host: ReturnType<typeof createHost>;
  runtime: HostRuntime & { handled: Array<{ cmd: HarnessCommand; commandId: string }>; started: Promise<void>; finishStart(): void; shutdowns: number[]; skip: readonly string[] };
  journal: ReturnType<typeof memoryJournalIo>;
  clock: ReturnType<typeof fakeClock>;
  flush(): Promise<void>;
}

function hostHarness(opts: { handle?: (cmd: HarnessCommand) => Promise<unknown>; journal?: Parameters<typeof memoryJournalIo>[0]; startFails?: boolean } = {}): HostHarness {
  const sent: HostToMain[] = [];
  const exits: number[] = [];
  const clock = fakeClock();
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const runtime = {
    handled: [] as Array<{ cmd: HarnessCommand; commandId: string }>,
    shutdowns: [] as number[],
    skip: [] as readonly string[],
    started: gate,
    finishStart: () => finish(),
    async start(_init, io) {
      runtime.skip = io.skipThreads;
      io.phase('migrating');
      await gate;
      if (opts.startFails) throw new GmiError('internal', 'migration failed');
      io.phase('recovering');
      await io.recovering('t-a');
      await io.recovering(null);
      return { sandbox: { kind: 'bwrap', ok: true, detail: null, network: 'proxy' }, git: { ok: true, version: '2.43.0' }, ripgrep: true };
    },
    async handle(cmd, ctx) {
      runtime.handled.push({ cmd, commandId: ctx.commandId });
      return opts.handle ? opts.handle(cmd) : { ok: cmd.op };
    },
    async shutdown(graceMs) {
      runtime.shutdowns.push(graceMs);
    },
  } satisfies HostRuntime & Record<string, unknown>;
  const createRuntime: CreateHostRuntime = () => runtime;
  const journal = memoryJournalIo(opts.journal ?? null);
  const host = createHost({
    send: (m) => void sent.push(structuredClone(m)),
    clock,
    worker: createInlineWorker(),
    createRuntime,
    journal: () => journal,
    exit: (code) => void exits.push(code),
    version: '9.9.9',
  });
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  };
  return { sent, exits, host, runtime, journal, clock, flush };
}

const INIT: MainToHost = { t: 'init', protocol: HARNESS_PROTOCOL, dataDir: '/tmp/never-used', installId: 'i', settings: { mock: true }, platform: 'linux' };

describe('host: init, heartbeats, commands, shutdown', () => {
  it('answers pings with its phase while starting, then sends ready', async () => {
    const h = hostHarness();
    h.host.receive({ t: 'ping', at: 1 });
    expect(h.sent.at(-1)).toEqual({ t: 'pong', at: 1, phase: 'starting' });
    h.host.receive(INIT);
    await h.flush();
    h.host.receive({ t: 'ping', at: 2 });
    expect(h.sent.at(-1)).toEqual({ t: 'pong', at: 2, phase: 'migrating' });
    h.runtime.finishStart();
    await h.flush();
    expect(h.sent.find((m) => m.t === 'ready')).toEqual({
      t: 'ready',
      protocol: 1,
      version: '9.9.9',
      sandbox: { kind: 'bwrap', ok: true, detail: null, network: 'proxy' },
      git: { ok: true, version: '2.43.0' },
      ripgrep: true,
    });
    h.host.receive({ t: 'ping', at: 3 });
    expect(h.sent.at(-1)).toEqual({ t: 'pong', at: 3, phase: 'ready' });
    // Every message the host sent is valid for main.
    for (const m of h.sent) expect(decodeHostToMain(m).ok).toBe(true);
  });

  it('refuses commands before ready, runs them after, and reports errors as GmiError shapes', async () => {
    const h = hostHarness({ handle: async (cmd) => (cmd.op === 'thread.delete' ? Promise.reject(new GmiError('not_found', 'No thread.')) : { runId: 'run_1', turn: 1 }) });
    h.host.receive(INIT);
    h.host.receive({ t: 'cmd', id: 'cmd_a', cmd: { op: 'run.send', threadId: THREAD, text: 'go' } });
    expect(h.sent.at(-1)).toMatchObject({ t: 'cmd.result', id: 'cmd_a', ok: false, error: { code: 'internal' } });
    h.runtime.finishStart();
    await h.flush();
    h.host.receive({ t: 'cmd', id: 'cmd_b', cmd: { op: 'run.send', threadId: THREAD, text: 'go' } });
    h.host.receive({ t: 'cmd', id: 'cmd_b', cmd: { op: 'run.send', threadId: THREAD, text: 'go' } }); // in flight: once
    h.host.receive({ t: 'cmd', id: 'cmd_c', cmd: { op: 'thread.delete', threadId: THREAD } });
    await h.flush();
    expect(h.runtime.handled.map((x) => x.commandId)).toEqual(['cmd_b', 'cmd_c']);
    expect(h.sent.filter((m) => m.t === 'cmd.result' && m.id === 'cmd_b')).toEqual([{ t: 'cmd.result', id: 'cmd_b', ok: true, data: { runId: 'run_1', turn: 1 } }]);
    expect(h.sent.find((m) => m.t === 'cmd.result' && m.id === 'cmd_c')).toMatchObject({ ok: false, error: { code: 'not_found', message: 'No thread.' } });
  });

  it('drops invalid messages from main with a log line, and ignores a second init', async () => {
    const h = hostHarness();
    h.host.receive({ t: 'cmd', id: 'x', cmd: { op: 'shell', command: 'id' } });
    h.host.receive({ t: 'ping', at: 'soon' });
    const logs = h.sent.filter((m) => m.t === 'log');
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ level: 'warn', message: 'dropped an invalid message from main' });
    expect(h.sent.some((m) => m.t === 'cmd.result')).toBe(false);
    h.host.receive(INIT);
    h.host.receive(INIT);
    expect(h.sent.at(-1)).toMatchObject({ t: 'log', message: 'ignored a second init' });
  });

  it('exits with 1 when the runtime cannot start', async () => {
    const h = hostHarness({ startFails: true });
    h.host.receive(INIT);
    h.runtime.finishStart();
    await h.flush();
    expect(h.exits).toEqual([1]);
    expect(h.sent.some((m) => m.t === 'ready')).toBe(false);
  });

  it('shutdown: runtime shutdown within the grace, pending link calls fail, then exit 0', async () => {
    const h = hostHarness();
    h.host.receive(INIT);
    h.runtime.finishStart();
    await h.flush();
    h.host.receive({ t: 'shutdown', graceMs: 2_500 });
    await h.flush();
    expect(h.runtime.shutdowns).toEqual([2_500]);
    expect(h.exits).toEqual([0]);
    h.host.receive({ t: 'cmd', id: 'late', cmd: { op: 'thread.delete', threadId: THREAD } });
    expect(h.sent.at(-1)).toMatchObject({ t: 'cmd.result', id: 'late', ok: false });
  });
});

describe('host: quarantine after two recovery crashes (§5.1)', () => {
  it('a thread that crashed recovery twice is skipped; one crash is not enough; a finished recovery clears the slate', async () => {
    const io = memoryJournalIo({ current: 't-bad', crashes: { 't-bad': 1, 't-once': 0 } });
    const first = await openRecoveryJournal(io);
    expect(first.skipThreads).toEqual(['t-bad']);
    expect(io.state).toEqual({ current: null, crashes: { 't-bad': QUARANTINE_AFTER_CRASHES, 't-once': 0 } });

    const once = memoryJournalIo({ current: 't-once', crashes: {} });
    expect((await openRecoveryJournal(once)).skipThreads).toEqual([]);

    await first.recovering('t-next');
    expect(io.state?.current).toBe('t-next');
    await first.recovering(null);
    expect(io.state).toEqual({ current: null, crashes: {} });
  });

  it('end to end: the host passes quarantined threads to the runtime', async () => {
    const h = hostHarness({ journal: { current: 't-bad', crashes: { 't-bad': 1 } } });
    h.host.receive(INIT);
    await h.flush();
    expect(h.runtime.skip).toEqual(['t-bad']);
    h.runtime.finishStart();
    await h.flush();
    expect(h.journal.state).toEqual({ current: null, crashes: {} });
  });

  it('the file journal is durable JSON (0600) and tolerates garbage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gmi-desk-h20-journal-'));
    try {
      const io = fileJournalIo(join(dir, 'sub', 'recovery.json'));
      expect(await io.read()).toBeNull();
      await io.write({ current: 't', crashes: { t: 1 } });
      expect(await io.read()).toEqual({ current: 't', crashes: { t: 1 } });
      const { stat, writeFile } = await import('node:fs/promises');
      expect((await stat(join(dir, 'sub', 'recovery.json'))).mode & 0o777).toBe(0o600);
      await writeFile(join(dir, 'sub', 'recovery.json'), '{not json');
      expect(await io.read()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── Links to main ────────────────────────────────────────────────────────────────────────────────────────────

function linkHarness() {
  const sent: HostToMain[] = [];
  const clock = fakeClock();
  const link = createMainLink({ send: (m) => void sent.push(structuredClone(m)), clock, log: memoryLog() });
  return { sent, clock, link };
}

async function collect(iter: AsyncIterable<GatewayEvent>): Promise<GatewayEvent[]> {
  const out: GatewayEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('gateway client: gw.request → gw.events, cancel, unknown ids', () => {
  it('streams batched events until the terminal one', async () => {
    const { sent, link } = linkHarness();
    const done = collect(link.gateway.stream(sampleRequest(), new AbortController().signal));
    expect(sent[0]).toMatchObject({ t: 'gw.request', reqId: 'req_1' });
    link.handle({ t: 'gw.events', reqId: 'other', events: [{ type: 'text', text: 'not mine' }] });
    link.handle({ t: 'gw.events', reqId: 'req_1', events: [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }] });
    link.handle({ t: 'gw.events', reqId: 'req_1', events: [{ type: 'finish', reason: 'stop', raw: null }, { type: 'text', text: 'after the end' }] });
    expect(await done).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'finish', reason: 'stop', raw: null }]);
    expect(sent.some((m) => m.t === 'gw.cancel')).toBe(false);
  });

  it('abort sends gw.cancel and throws cancelled; early break also cancels upstream', async () => {
    const { sent, link } = linkHarness();
    const ac = new AbortController();
    const done = collect(link.gateway.stream(sampleRequest(), ac.signal)).catch((e: unknown) => e);
    link.handle({ t: 'gw.events', reqId: 'req_1', events: [{ type: 'text', text: 'x' }] });
    await Promise.resolve();
    ac.abort();
    expect(await done).toMatchObject({ code: 'cancelled' });
    expect(sent.at(-1)).toEqual({ t: 'gw.cancel', reqId: 'req_1' });

    const stream = link.gateway.stream(sampleRequest({ requestId: 'req_2' }), new AbortController().signal)[Symbol.asyncIterator]();
    const first = stream.next();
    link.handle({ t: 'gw.events', reqId: 'req_2', events: [{ type: 'text', text: 'a' }] });
    await first;
    await stream.return?.();
    expect(sent.at(-1)).toEqual({ t: 'gw.cancel', reqId: 'req_2' });
  });

  it('a request over 4 MiB becomes context_overflow without being sent; duplicate ids are refused', async () => {
    const { sent, link } = linkHarness();
    const huge = sampleRequest({ messages: [{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_BYTES) }] });
    expect(await collect(link.gateway.stream(huge, new AbortController().signal))).toEqual([
      { type: 'error', error: { code: 'context_overflow', message: 'The request is larger than 4 MiB.' }, afterOutput: false },
    ]);
    expect(sent).toHaveLength(0);
    const a = link.gateway.stream(sampleRequest(), new AbortController().signal)[Symbol.asyncIterator]();
    const pendingA = a.next();
    await expect(collect(link.gateway.stream(sampleRequest(), new AbortController().signal))).rejects.toMatchObject({ code: 'invalid_input' });
    link.failAll(new GmiError('cancelled', 'gone'));
    await expect(pendingA).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('rpc and approvals clients', () => {
  it('rpc: result, error, timeout and abort', async () => {
    const { sent, link, clock } = linkHarness();
    const ok = link.rpc.call('dialog.confirm', { kind: 'trust', subject: { tool: 'mcp__x__y', risk: [] } });
    const okMsg = sent.at(-1) as Extract<HostToMain, { t: 'rpc' }>;
    expect(decodeHostToMain(okMsg).ok).toBe(true);
    link.handle({ t: 'rpc.result', id: okMsg.id, ok: true, data: { confirmed: false } });
    expect(await ok).toEqual({ confirmed: false });

    const err = link.rpc.call('mcp.oauth.token', { serverId: 'gh' });
    link.handle({ t: 'rpc.result', id: (sent.at(-1) as { id: string }).id, ok: false, error: { code: 'not_implemented', message: 'later' } });
    await expect(err).rejects.toMatchObject({ code: 'not_implemented', message: 'later' });

    const slow = link.rpc.call('secrets.mcpEnv', { serverId: 'gh' });
    clock.advance(60_001);
    await expect(slow).rejects.toMatchObject({ code: 'timeout' });

    const ac = new AbortController();
    const aborted = link.rpc.call('secrets.mcpEnv', { serverId: 'gh' }, { signal: ac.signal });
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' });
    expect(clock.pendingTimers()).toBe(0);
  });

  it('approvals: the host cannot pick allowedDecisions; decision resolves; abort withdraws', async () => {
    const { sent, link } = linkHarness();
    const decided = link.approvals.request(sampleApproval({ allowedDecisions: ['allow_always'] }), new AbortController().signal);
    expect(sent.at(-1)).toMatchObject({ t: 'approval.request', request: { requestId: 'apr_1', allowedDecisions: [] } });
    expect(link.approvals.pending()).toEqual(['apr_1']);
    link.handle({ t: 'approval.decision', requestId: 'apr_1', decision: { kind: 'deny', feedback: 'no' } });
    expect(await decided).toEqual({ kind: 'deny', feedback: 'no' });

    const ac = new AbortController();
    const withdrawn = link.approvals.request(sampleApproval({ requestId: 'apr_2' }), ac.signal);
    ac.abort();
    await expect(withdrawn).rejects.toMatchObject({ code: 'cancelled' });
    expect(sent.at(-1)).toEqual({ t: 'approval.withdrawn', requestId: 'apr_2' });
    expect(link.approvals.pending()).toEqual([]);
  });

  it('events: item, threads and run.ended go to main as validated messages', () => {
    const { sent, link } = linkHarness();
    link.events.event(ITEM_EVENT);
    link.events.threads([sampleSummary()]);
    link.events.runEnded(THREAD, 'run_1');
    expect(sent.map((m) => m.t)).toEqual(['event', 'threads', 'run.ended']);
    for (const m of sent) expect(decodeHostToMain(m).ok).toBe(true);
  });

  it('host logs: flat safe meta only, rate-limited with a dropped count', () => {
    expect(safeMeta({ id: 'a', n: 1, ok: true, nested: { secret: 'x' }, list: [1], long: 'y'.repeat(300) })).toEqual({ id: 'a', n: 1, ok: true, long: `${'y'.repeat(256)}…` });
    const sent: HostToMain[] = [];
    const clock = fakeClock();
    const log = createPortLog((m) => void sent.push(m), clock, 'harness', 3);
    for (let i = 0; i < 10; i += 1) log.child('loop').info('tick', { i });
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ t: 'log', scope: 'harness.loop', message: 'tick' });
    clock.advance(1_000);
    log.info('next');
    expect(sent.slice(3).map((m) => (m as { message: string }).message)).toEqual(['host log lines dropped (rate limit)', 'next']);
    expect(sent[3]).toMatchObject({ meta: { dropped: 7 } });
  });
});

// ─── Worker and the built bundle ──────────────────────────────────────────────────────────────────────────────

describe('worker', () => {
  it('inline: echo, sha256, unknown job, abort', async () => {
    const w = createInlineWorker();
    expect(await w.run('echo', { a: 1 })).toEqual({ a: 1 });
    expect(await w.run('sha256', { text: 'abc' })).toBe(createHash('sha256').update('abc').digest('hex'));
    await expect(w.run('nope' as 'echo', null)).rejects.toMatchObject({ code: 'not_implemented' });
    const ac = new AbortController();
    ac.abort();
    await expect(w.run('echo', 1, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await w.close();
    await expect(w.run('echo', 1)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('harness.cjs builds (platform node, electron external) and runs as its own worker thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gmi-desk-h20-build-'));
    try {
      const buildScript: string = pathToFileURL(resolve('scripts/build-electron.mjs')).href;
      const { electronBuildOptions } = (await import(/* @vite-ignore */ buildScript)) as { electronBuildOptions(o: { outDir: string }): esbuild.BuildOptions[] };
      const hostConfig = electronBuildOptions({ outDir: dir }).find((c) => String(c.outfile).endsWith('harness.cjs'));
      expect(hostConfig).toBeDefined();
      await esbuild.build({ ...hostConfig, logLevel: 'silent' });
      const file = join(dir, 'dist-electron', 'harness.cjs');
      const worker = createThreadWorker({ file, log: memoryLog() });
      try {
        expect(await worker.run('sha256', { text: 'x'.repeat(2_000_000) })).toBe(createHash('sha256').update('x'.repeat(2_000_000)).digest('hex'));
        expect(await worker.run('echo', { nested: [1, 'two'] })).toEqual({ nested: [1, 'two'] });
        await expect(worker.run('missing' as 'echo', null)).rejects.toMatchObject({ code: 'not_implemented' });
      } finally {
        await worker.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
