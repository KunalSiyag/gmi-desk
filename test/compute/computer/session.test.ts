// Computer sessions (compute.md §8.1, §8.7, §9.5) and the computer service entry (index.ts), incl. mock mode on the
// simulator's fake PTY.
import { afterEach, describe, expect, it } from 'vitest';
import type { ComputerSessionInfo, TerminalChunk } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createComputerService, createMockShellOpener } from '@main/services/compute/computer';
import { createExecPort, createSessionManager, SESSION_HOME_COMMAND, type SessionManager } from '@main/services/compute/computer/session';
import { ShellHandshakeError, type ShellSocketHandlers, type ShellSocketOpener } from '@main/services/compute/computer/shell-v2';
import { createMockCompute } from '@main/mock/compute';
import type { ComputeInternals } from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../../helpers/context';
import { RID, SBX, fakeActivity, fakeDataPlane, fakeRegistry, fakeSupervisor, instant, sandboxRecord, until } from './c2a-fakes';

// ─── An in-memory shell socket ─────────────────────────────────────────────────────────────────────────────────────

function memoryOpener() {
  const o = {
    plan: [] as Array<'ok' | Error>,
    sockets: [] as Array<{ sent: string[]; handlers: ShellSocketHandlers; closed: boolean; paused: boolean }>,
    open: (async (_target, handlers, signal) => {
      if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
      const next = o.plan.shift() ?? 'ok';
      if (next instanceof Error) throw next;
      const s = { sent: [] as string[], handlers, closed: false, paused: false };
      o.sockets.push(s);
      return {
        send: (b: Uint8Array) => s.sent.push(new TextDecoder().decode(b)),
        pause: () => (s.paused = true),
        resume: () => (s.paused = false),
        close: () => (s.closed = true),
      };
    }) as ShellSocketOpener,
    last: () => o.sockets.at(-1) as (typeof o.sockets)[number],
  };
  return o;
}

interface Rig {
  sessions: SessionManager;
  dp: ReturnType<typeof fakeDataPlane>;
  registry: ReturnType<typeof fakeRegistry>;
  supervisor: ReturnType<typeof fakeSupervisor>;
  activity: ReturnType<typeof fakeActivity>;
  opener: ReturnType<typeof memoryOpener>;
  infos: ComputerSessionInfo[];
  chunks: TerminalChunk[];
  confirms: Array<{ title: string }>;
  confirmAnswer: { value: boolean };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function rig(opts: { records?: Parameters<typeof fakeRegistry>[0]; warmMs?: number } = {}): Rig {
  const registry = fakeRegistry(opts.records ?? [sandboxRecord()]);
  const dp = fakeDataPlane();
  const supervisor = fakeSupervisor();
  const activity = fakeActivity();
  const opener = memoryOpener();
  const infos: ComputerSessionInfo[] = [];
  const chunks: TerminalChunk[] = [];
  const confirms: Array<{ title: string }> = [];
  const confirmAnswer = { value: true };
  const execPort = createExecPort({ registry, dataPlane: dp, log: silentLogger, sleep: instant });
  const sessions = createSessionManager({
    registry,
    supervisor,
    activity,
    dataPlane: dp,
    execPort,
    openShell: opener.open,
    log: silentLogger,
    emitSession: (i) => infos.push(i),
    emitTerminal: (c) => chunks.push(c),
    confirm: async (o) => {
      confirms.push({ title: o.title });
      return confirmAnswer.value;
    },
    warmMs: opts.warmMs ?? 60_000,
    sleep: instant,
    shell: { delay: instant, random: () => 0.5 },
  });
  cleanups.push(() => sessions.dispose());
  return { sessions, dp, registry, supervisor, activity, opener, infos, chunks, confirms, confirmAnswer };
}

describe('SessionManager (§8.1)', () => {
  it('open: connect, then one exec for $HOME and the user → ready', async () => {
    const r = rig();
    r.dp.homeLine = '/home/dev\tdev';
    const info = await r.sessions.open(RID);
    expect(info).toMatchObject({ resourceId: RID, state: 'ready', home: '/home/dev', user: 'dev', coldResumed: false, execInUse: 0 });
    expect(info.sessionId).toMatch(/^cs_[0-9a-f-]{36}$/);
    expect(info.terminal).toEqual({ state: 'none', cols: 80, rows: 24, lastSeq: 0 });
    expect(r.dp.calls.slice(0, 2)).toEqual(['connect', `exec:${SESSION_HOME_COMMAND.slice(0, 20)}`]);
    // The home exec is an app exec: persisted with its origin, never activity.
    expect(r.registry.added[0]).toMatchObject({ origin: 'app', timeoutSec: 30 });
    expect(r.activity.records).toEqual([]);
    expect(r.infos.map((i) => i.state)).toEqual(['connecting', 'ready']);
    expect(r.supervisor.hints.at(-1)).toEqual({ computerOpen: true });
  });

  it('one session per resource: opening again returns the same session', async () => {
    const r = rig();
    const a = await r.sessions.open(RID);
    const b = await r.sessions.open(RID);
    expect(b.sessionId).toBe(a.sessionId);
    expect(r.dp.calls.filter((c) => c === 'connect')).toHaveLength(1);
  });

  it('ignores a bad $HOME / user line', async () => {
    const r = rig();
    r.dp.homeLine = 'relative\tbad user;rm';
    expect(await r.sessions.open(RID)).toMatchObject({ state: 'ready', home: null, user: null });
  });

  it('refuses bad ids, unknown, deleted, unmanaged and container resources', async () => {
    const r = rig({
      records: [
        sandboxRecord(),
        sandboxRecord({ id: 'cr_other', managed: false }),
        sandboxRecord({ id: 'cr_ce', backend: 'ce', kind: 'container' }),
        sandboxRecord({ id: 'cr_gone', phase: 'deleted' }),
        sandboxRecord({ id: 'cr_new', remoteId: null }),
      ],
    });
    await expect(r.sessions.open('../x')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(r.sessions.open('cr_missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(r.sessions.open('cr_gone')).rejects.toMatchObject({ code: 'not_found' });
    await expect(r.sessions.open('cr_other')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(r.sessions.open('cr_ce')).rejects.toMatchObject({ code: 'not_implemented' });
    await expect(r.sessions.open('cr_new')).rejects.toMatchObject({ code: 'conflict' });
    expect(() => r.sessions.info('cs_nope')).toThrow(GmiError);
  });

  it('a paused sandbox opens as paused (no connect); a resume makes it ready with coldResumed', async () => {
    const r = rig({ records: [sandboxRecord({ phase: 'paused' })] });
    const info = await r.sessions.open(RID);
    expect(info.state).toBe('paused');
    expect(r.dp.calls).toEqual([]);
    expect(() => r.sessions.terminalInput(info.sessionId, 'x')).toThrow(/paused/);
    r.supervisor.emit('paused', 'resuming');
    expect(r.sessions.info(info.sessionId).state).toBe('connecting');
    r.supervisor.emit('resuming', 'running');
    await until(() => r.sessions.info(info.sessionId).state === 'ready');
    expect(r.sessions.info(info.sessionId).coldResumed).toBe(true);
    expect(r.dp.calls).toContain('invalidate');
  });

  it('pausing suspends the shell; running again reattaches it', async () => {
    const r = rig();
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
    r.supervisor.emit('running', 'pausing');
    expect(r.sessions.info(sessionId)).toMatchObject({ state: 'paused', terminal: { state: 'none' } });
    expect(r.opener.last().closed).toBe(true);
    r.supervisor.emit('pausing', 'paused');
    r.supervisor.emit('paused', 'running');
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
    expect(r.opener.sockets).toHaveLength(2);
    expect(r.sessions.info(sessionId).coldResumed).toBe(true);
  });

  it('connect 409 (paused / transitional) waits for the supervisor', async () => {
    const r = rig();
    r.dp.connectError = new GmiError('conflict', 'not running', { status: 409 });
    const info = await r.sessions.open(RID);
    expect(info.state).toBe('connecting');
    expect(r.supervisor.watched).toEqual([RID]);
    r.dp.connectError = null;
    r.supervisor.emit('creating', 'running');
    await until(() => r.sessions.info(info.sessionId).state === 'ready');
  });

  it('deletion closes the session at once', async () => {
    const r = rig();
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
    r.supervisor.emit('running', 'deleting');
    expect(r.infos.at(-1)).toMatchObject({ sessionId, state: 'closed', reason: 'This sandbox was deleted.' });
    expect(() => r.sessions.info(sessionId)).toThrow(/closed/);
    expect(r.opener.last().closed).toBe(true);
    expect(r.supervisor.hints.at(-1)).toEqual({ computerOpen: false });
  });

  it('close starts the warm period; reopening within it keeps the session and its screen', async () => {
    const r = rig({ warmMs: 80 });
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
    r.opener.last().handlers.onData(new TextEncoder().encode('kept'));
    await r.sessions.release(sessionId);
    await new Promise((res) => setTimeout(res, 30));
    const again = await r.sessions.open(RID);
    expect(again.sessionId).toBe(sessionId);
    await new Promise((res) => setTimeout(res, 120));
    expect(r.sessions.info(sessionId).state).toBe('ready');
    expect(new TextDecoder().decode(r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 }).replay)).toContain('kept');
    // Without a reopen it closes.
    await r.sessions.release(sessionId);
    await until(() => r.infos.at(-1)?.state === 'closed', 2000, 'warm close');
  });

  it('terminal input is user activity (output is not), in order, at most 64 KiB per call', async () => {
    const r = rig();
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
    for (let i = 0; i < 20; i += 1) r.sessions.terminalInput(sessionId, String(i));
    expect(r.opener.last().sent.join('')).toBe(Array.from({ length: 20 }, (_, i) => String(i)).join(''));
    expect(r.activity.records).toHaveLength(20);
    expect(r.activity.records[0]).toEqual({ rid: RID, activity: { kind: 'terminal_input' } });
    r.opener.last().handlers.onData(new TextEncoder().encode('lots of output'));
    expect(r.activity.records).toHaveLength(20);
    expect(() => r.sessions.terminalInput(sessionId, 'x'.repeat(64 * 1024 + 1))).toThrow(/64 KiB/);
    expect(() => r.sessions.terminalInput(sessionId, 'é'.repeat(33 * 1024))).toThrow(/64 KiB/);
    expect(() => r.sessions.terminalInput(sessionId, 42 as unknown as string)).toThrow(GmiError);
  });

  it('emits output as computer:terminal chunks only while visible; acks free the flow', async () => {
    const r = rig();
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
    r.opener.last().handlers.onData(new TextEncoder().encode('hidden'));
    await new Promise((res) => setTimeout(res, 30));
    expect(r.chunks).toEqual([]);
    r.sessions.terminalVisibility(sessionId, true);
    // A gap happened: the view sees lastSeq ahead and reattaches.
    expect(r.infos.at(-1)?.terminal.lastSeq).toBe(1);
    const { replay, seq } = r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    expect(new TextDecoder().decode(replay)).toContain('hidden');
    r.opener.last().handlers.onData(new TextEncoder().encode('shown'));
    await until(() => r.chunks.length === 1);
    expect(r.chunks[0]).toMatchObject({ sessionId, seq: seq + 1 });
    expect(new TextDecoder().decode(r.chunks[0]?.data)).toBe('shown');
    r.sessions.terminalAck(sessionId, seq + 1);
    expect(() => r.sessions.terminalAck(sessionId, -1)).toThrow(GmiError);
    expect(() => r.sessions.terminalVisibility(sessionId, 'yes' as unknown as boolean)).toThrow(GmiError);
  });

  it('take over needs the native confirmation; cancelled → nothing is closed', async () => {
    const r = rig();
    r.opener.plan.push(new ShellHandshakeError(409));
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached_elsewhere');
    r.confirmAnswer.value = false;
    await expect(r.sessions.terminalTakeOver(sessionId)).rejects.toMatchObject({ code: 'cancelled' });
    expect(r.confirms).toHaveLength(1);
    expect(r.dp.controls).toEqual([]);
    r.confirmAnswer.value = true;
    await r.sessions.terminalTakeOver(sessionId);
    expect(r.confirms).toHaveLength(2);
    expect(r.dp.controls[0]).toEqual({ action: 'close' });
    expect(r.sessions.info(sessionId).terminal.state).toBe('attached');
    // The app never sends `exit`.
    expect(r.opener.sockets.flatMap((s) => s.sent).join('')).not.toContain('exit');
  });

  it('a second 401 at the handshake makes the session unavailable; open again reconnects', async () => {
    const r = rig();
    r.opener.plan.push(new ShellHandshakeError(401), new ShellHandshakeError(401));
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).state === 'unavailable');
    expect(r.dp.refreshes).toBe(1);
    expect(() => r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 })).toThrow(GmiError);
    await r.sessions.open(RID);
    expect(r.sessions.info(sessionId).state).toBe('ready');
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
  });

  it('review: a view refused while unavailable gets its shell on Reconnect without attaching again', async () => {
    const r = rig();
    r.dp.connectError = new GmiError('network', 'down');
    const info = await r.sessions.open(RID);
    expect(info.state).toBe('unavailable');
    // The view mounts anyway; its attach is refused.
    expect(() => r.sessions.terminalAttach(info.sessionId, { cols: 80, rows: 24 })).toThrow(GmiError);
    r.dp.connectError = null;
    await r.sessions.open(RID);
    await until(() => r.sessions.info(info.sessionId).terminal.state === 'attached', 2000, 'shell after reconnect');
  });

  it('review: viewsGone (renderer reload / crash) starts the warm period in main; a reopen keeps the session', async () => {
    const r = rig({ warmMs: 60 });
    const a = await r.sessions.open(RID);
    r.sessions.viewsGone();
    await new Promise((res) => setTimeout(res, 20));
    // The reloaded renderer opens the dock again: kept.
    await r.sessions.open(RID);
    await new Promise((res) => setTimeout(res, 90));
    expect(r.sessions.info(a.sessionId).state).toBe('ready');
    // Nobody comes back: closed after the warm period, no renderer timer needed.
    r.sessions.viewsGone();
    await until(() => r.infos.at(-1)?.state === 'closed', 2000, 'warm close after viewsGone');
    expect(r.supervisor.hints.at(-1)).toEqual({ computerOpen: false });
  });

  it('a reconnecting shell shows as a reconnecting session', async () => {
    const r = rig();
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.terminalAttach(sessionId, { cols: 80, rows: 24 });
    await until(() => r.sessions.info(sessionId).terminal.state === 'attached');
    r.opener.last().handlers.onClose({ code: 1006, cause: 'remote' });
    expect(r.infos.some((i) => i.state === 'reconnecting')).toBe(true);
    await until(() => r.sessions.info(sessionId).state === 'ready' && r.sessions.info(sessionId).terminal.state === 'attached');
    expect(r.sessions.diagnostics()).toEqual([
      expect.objectContaining({ sessionId, state: 'ready', terminal: 'attached', reconnects: 1, unackedBytes: 0, flowPaused: false, exec: expect.objectContaining({ capacity: 10, inUse: 0 }) }),
    ]);
  });

  it('closing the session cancels its in-flight execs (abort) and notifies listeners', async () => {
    const r = rig();
    const { sessionId } = await r.sessions.open(RID);
    const handle = r.sessions.handle(sessionId, { requireReady: true });
    expect(handle).toMatchObject({ sessionId, resourceId: RID, sandboxId: SBX, home: '/root', user: 'root' });
    const closed: string[] = [];
    r.sessions.onClose((id) => closed.push(id));
    r.sessions.closeNow(sessionId, null);
    expect(handle.signal.aborted).toBe(true);
    expect(closed).toEqual([sessionId]);
    expect(() => r.sessions.handle(sessionId)).toThrow(GmiError);
  });

  it('records user activity for parts (file ops, transfers, services)', async () => {
    const r = rig();
    const { sessionId } = await r.sessions.open(RID);
    r.sessions.recordActivity(sessionId, 'file_op');
    expect(r.activity.records).toEqual([{ rid: RID, activity: { kind: 'file_op' } }]);
  });
});

// ─── The service entry (index.ts) and mock mode ────────────────────────────────────────────────────────────────────

describe('createComputerService', () => {
  let t: TestContext | null = null;
  afterEach(async () => {
    await t?.cleanup();
    t = null;
  });

  function mockWiring(flags: string[] = []) {
    const mock = createMockCompute({ flags: new Set(flags), installTag: 'abc123', installLabel: '0123456789abcdef' });
    const registry = fakeRegistry([sandboxRecord({ remoteId: 'sbx-mock-0001' })]);
    const supervisor = fakeSupervisor();
    const activity = fakeActivity();
    const internals = { registry, supervisor, guard: { activity } } as unknown as ComputeInternals;
    const backends = { publicApi: mock.publicApi, ce: mock.ce, sandbox: mock.sandbox, dataPlane: mock.dataPlane, tokens: mock.tokens, mock };
    return { mock, registry, supervisor, activity, internals, backends };
  }

  it('answers not_implemented when the compute slice gave no internals', async () => {
    t = await createTestContext({ mock: true });
    const svc = createComputerService(t.ctx, { compute: { internals: null } });
    await expect(svc.api.open(RID)).rejects.toMatchObject({ code: 'not_implemented' });
    expect(svc.sessions).toBeNull();
    await svc.dispose();
  });

  it('mock mode: the terminal runs on the fake PTY through the same bridge and flow', async () => {
    t = await createTestContext({ mock: true });
    const w = mockWiring();
    const svc = createComputerService(t.ctx, { compute: { internals: w.internals, backends: w.backends } });
    cleanups.push(() => svc.dispose());
    const info = await svc.api.open(RID);
    expect(info).toMatchObject({ state: 'ready', home: '/root', user: 'root' });
    await svc.api.terminalVisibility(info.sessionId, true);
    await svc.api.terminalAttach(info.sessionId, { cols: 80, rows: 24 });
    const terminal = () =>
      t!.emitted
        .filter((e) => e.name === 'computer:terminal')
        .map((e) => new TextDecoder().decode((e.payload as TerminalChunk).data))
        .join('');
    await until(() => terminal().includes('# '), 2000, 'prompt');
    await svc.api.terminalInput(info.sessionId, 'echo hello-gmi\r');
    await until(() => terminal().includes('hello-gmi\r\n'), 2000, 'echo output');
    expect(t.emitted.some((e) => e.name === 'computer:session')).toBe(true);
    expect(w.activity.records.some((x) => x.activity.kind === 'terminal_input')).toBe(true);
    const got = await svc.api.getSession(info.sessionId);
    expect(got.terminal.state).toBe('attached');
    await svc.api.close(info.sessionId);
  });

  it('mock shell_busy → attached_elsewhere; take over asks natively first', async () => {
    t = await createTestContext({ mock: true });
    const w = mockWiring(['shell_busy']);
    const svc = createComputerService(t.ctx, { compute: { internals: w.internals, backends: w.backends } });
    cleanups.push(() => svc.dispose());
    const info = await svc.api.open(RID);
    await svc.api.terminalAttach(info.sessionId, { cols: 80, rows: 24 });
    await until(() => svc.sessions?.info(info.sessionId).terminal.state === 'attached_elsewhere', 2000, 'attached elsewhere');
    t.platform.confirmAnswer = false;
    await expect(svc.api.terminalTakeOver(info.sessionId)).rejects.toMatchObject({ code: 'cancelled' });
    expect(t.platform.confirms.map((c) => c.title)).toEqual(['Take over the terminal?']);
  });

  it('review: mock shell_busy → confirmed Take over → attached (the other demo shell is gone)', async () => {
    t = await createTestContext({ mock: true });
    const w = mockWiring(['shell_busy']);
    const svc = createComputerService(t.ctx, { compute: { internals: w.internals, backends: w.backends } });
    cleanups.push(() => svc.dispose());
    const info = await svc.api.open(RID);
    await svc.api.terminalAttach(info.sessionId, { cols: 80, rows: 24 });
    await until(() => svc.sessions?.info(info.sessionId).terminal.state === 'attached_elsewhere', 2000, 'attached elsewhere');
    t.platform.confirmAnswer = true;
    await svc.api.terminalTakeOver(info.sessionId);
    expect(svc.sessions?.info(info.sessionId).terminal.state).toBe('attached');
  });

  it('serves non-terminal methods from parts (session methods stay C2-A’s), else not_implemented', async () => {
    t = await createTestContext({ mock: true });
    const w = mockWiring();
    let disposedPart = false;
    const svc = createComputerService(t.ctx, {
      compute: { internals: w.internals, backends: w.backends },
      parts: [
        (c) => {
          expect(c.sessions).toBeTruthy();
          expect(c.execPort).toBeTruthy();
          return {
            api: { listPorts: async () => [{ port: 8000, address: '0.0.0.0', process: 'python3', previewable: true }], open: async () => ({}) } as never,
            dispose: () => {
              disposedPart = true;
            },
          };
        },
      ],
    });
    expect(await svc.api.listPorts('cs_x')).toHaveLength(1);
    await expect(svc.api.listDir('cs_x', '/')).rejects.toMatchObject({ code: 'not_implemented' });
    // A part cannot replace open().
    expect((await svc.api.open(RID)).state).toBe('ready');
    await svc.dispose();
    expect(disposedPart).toBe(true);
  });

  it('createMockShellOpener maps a busy PTY to a 409 handshake', async () => {
    const opener = createMockShellOpener({
      openPty: () => {
        throw new GmiError('conflict', 'busy', { status: 409 });
      },
    });
    await expect(opener({ sandboxId: 'x', connectUrl: '/shell/connect' }, { onData: () => undefined, onClose: () => undefined }, new AbortController().signal)).rejects.toBeInstanceOf(
      ShellHandshakeError,
    );
  });
});
