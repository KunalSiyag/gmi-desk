// The v2 shell bridge against a real `ws` WebSocketServer on 127.0.0.1 (compute.md §8.2, §8.7, T20).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore -- `ws` ships no types and `@types/ws` is not installed yet (C2-0 report).
import { WebSocketServer } from 'ws';
import type { TerminalState } from '@shared/contracts/compute';
import { silentLogger } from '@main/core/logger';
import { TerminalFlow } from '@main/services/compute/computer/flow';
import {
  SHELL_TIMING,
  SHELL_WS_OPTIONS,
  SOFT_RESET,
  ShellBridge,
  createWsShellOpener,
  type ShellSocketOpener,
} from '@main/services/compute/computer/shell-v2';
import { SBX, fakeDataPlane, until, type FakeDataPlane } from './c2a-fakes';

const KiB = 1024;

// ─── A scripted shell server ───────────────────────────────────────────────────────────────────────────────────────

interface ServerConn {
  ws: {
    send(data: Uint8Array | string, opts?: { binary?: boolean }, cb?: () => void): void;
    close(code?: number): void;
    terminate(): void;
    on(event: string, l: (...args: never[]) => void): void;
    readyState: number;
  };
  frames: Array<{ data: Buffer; isBinary: boolean }>;
  closeCode: number | null;
  headers: IncomingMessage['headers'];
}

type Plan = 'ok' | number;

async function startShellServer(opts: { autoPong?: boolean; greeting?: Uint8Array } = {}) {
  const plan: Plan[] = [];
  const conns: ServerConn[] = [];
  const upgrades: Array<{ headers: IncomingMessage['headers']; answer: Plan }> = [];
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true, autoPong: opts.autoPong ?? true, maxPayload: 64 * 1024 * 1024 });
  const server: Server = createServer();
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const answer = plan.length > 0 ? (plan.shift() as Plan) : 'ok';
    upgrades.push({ headers: req.headers, answer });
    if (answer !== 'ok') {
      const body = answer === 409 ? JSON.stringify({ code: 'Shell.AlreadyAttached', message: 'attached' }) : '';
      socket.write(`HTTP/1.1 ${answer} X\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: ServerConn['ws']) => {
      const conn: ServerConn = { ws, frames: [], closeCode: null, headers: req.headers };
      ws.on('message', ((data: Buffer, isBinary: boolean) => conn.frames.push({ data, isBinary })) as (...args: never[]) => void);
      ws.on('close', ((code: number) => (conn.closeCode = code)) as (...args: never[]) => void);
      conns.push(conn);
      // Output right at connect: it can reach the client before the bridge adopted the socket.
      if (opts.greeting) ws.send(opts.greeting, { binary: true });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/shell/connect`,
    plan,
    conns,
    upgrades,
    last: () => conns.at(-1) as ServerConn,
    async close() {
      for (const c of conns) c.ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

type ShellServer = Awaited<ReturnType<typeof startShellServer>>;

// ─── Bridge under test ─────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  dp: FakeDataPlane;
  bridge: ShellBridge;
  flow: TerminalFlow;
  states: TerminalState[];
  unavailable: string[];
  chunks: Array<{ seq: number; data: Uint8Array }>;
  delays: number[];
  pauses: boolean[];
  clock: { t: number };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rig(opts: { random?: number; timing?: Partial<typeof SHELL_TIMING>; autoPong?: boolean; greeting?: Uint8Array; ping?: { pingMs: number; pongTimeoutMs: number } } = {}) {
  const srv = await startShellServer({ autoPong: opts.autoPong, greeting: opts.greeting });
  cleanups.push(() => srv.close());
  const dp = fakeDataPlane();
  dp.socketUrl = srv.url;
  const states: TerminalState[] = [];
  const unavailable: string[] = [];
  const chunks: Rig['chunks'] = [];
  const delays: number[] = [];
  const pauses: boolean[] = [];
  const clock = { t: 1_000_000 };
  const real = createWsShellOpener({ dataPlane: dp, timing: opts.ping });
  // Spy on socket backpressure.
  const open: ShellSocketOpener = async (target, handlers, signal) => {
    const s = await real(target, handlers, signal);
    return {
      send: (b) => s.send(b),
      close: () => s.close(),
      pause: () => {
        pauses.push(true);
        s.pause();
      },
      resume: () => {
        pauses.push(false);
        s.resume();
      },
    };
  };
  let bridge: ShellBridge | null = null;
  const flow = new TerminalFlow({ emit: (c) => chunks.push(c), setPaused: (p) => bridge?.setPaused(p) });
  bridge = new ShellBridge({
    sessionId: 'cs_test',
    sandboxId: SBX,
    dataPlane: dp,
    open,
    flow,
    log: silentLogger,
    onState: (s) => states.push(s),
    onUnavailable: (r) => unavailable.push(r),
    timing: { resizeDebounceMs: 150, ...opts.timing },
    random: () => opts.random ?? 0.5,
    now: () => clock.t,
    delay: async (ms, signal) => {
      delays.push(ms);
      clock.t += ms;
      await new Promise((r) => setImmediate(r));
      if (signal.aborted) throw new Error('aborted');
    },
  });
  const b = bridge;
  cleanups.push(() => {
    b.dispose();
    flow.dispose();
  });
  return { srv, rig: { dp, bridge: b, flow, states, unavailable, chunks, delays, pauses, clock } satisfies Rig };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function attached(srv: ShellServer, r: Rig, conns = 1) {
  await until(() => r.bridge.terminalState === 'attached' && srv.conns.length >= conns, 3000, 'attached');
}

describe('ShellBridge over ws (§8.2)', () => {
  it('uses the hardened ws options: no permessage-deflate, 1 MiB frames, no redirects, token in a header', async () => {
    expect(SHELL_WS_OPTIONS).toEqual({ perMessageDeflate: false, maxPayload: 1 << 20, handshakeTimeout: 10_000, followRedirects: false });
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 100, rows: 30 });
    await attached(srv, r);
    const h = srv.upgrades[0]?.headers ?? {};
    expect(h['x-access-token']).toBe('dp-token-not-a-secret');
    expect(h['sec-websocket-extensions']).toBeUndefined();
    expect(r.states).toEqual(['connecting', 'attached']);
    // The PTY gets our size at once.
    await until(() => r.dp.controls.length > 0);
    expect(r.dp.controls[0]).toEqual({ action: 'resize', cols: 100, rows: 30 });
  });

  it('sends input as binary frames only, in order (never a text frame)', async () => {
    const { srv, rig: r } = await rig();
    // Typed while connecting: queued, then sent in order.
    r.bridge.attach({ cols: 80, rows: 24 });
    r.bridge.write('echo 1');
    await attached(srv, r);
    r.bridge.write('\r');
    r.bridge.write('héllo ✓\r');
    for (let i = 0; i < 50; i += 1) r.bridge.write(String(i % 10));
    await until(() => srv.last().frames.length >= 53);
    const frames = srv.last().frames;
    expect(frames.every((f) => f.isBinary)).toBe(true);
    expect(frames.map((f) => f.data.toString('utf8')).join('')).toBe(`echo 1\rhéllo ✓\r${Array.from({ length: 50 }, (_, i) => i % 10).join('')}`);
  });

  it('refuses input when not connected and caps the reconnect queue', async () => {
    const { rig: r } = await rig();
    expect(() => r.bridge.write('x')).toThrow(/not connected/);
    r.dp.launchError.push(...Array.from({ length: 50 }, () => new Error('down')));
    r.bridge.attach({ cols: 80, rows: 24 });
    r.bridge.write('a'.repeat(200 * KiB));
    expect(() => r.bridge.write('b'.repeat(100 * KiB))).toThrow(/reconnecting/);
  });

  it('keeps output that arrives in the same tick as the handshake (prompt on connect)', async () => {
    const { srv, rig: r } = await rig({ greeting: enc('root@sbx:~# ') });
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    await until(() => r.flow.ring.totalWritten === 12, 2000, 'greeting');
    expect(dec(r.flow.ring.snapshot())).toBe('root@sbx:~# ');
  });

  it('debounces resize to 150 ms and sends it only while attached', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.resize({ cols: 90, rows: 20 });
    await sleep(200);
    expect(r.dp.controls).toEqual([]);
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    await until(() => r.dp.controls.length === 1);
    r.bridge.resize({ cols: 81, rows: 24 });
    r.bridge.resize({ cols: 82, rows: 25 });
    r.bridge.resize({ cols: 83, rows: 26 });
    await sleep(60);
    expect(r.dp.controls).toHaveLength(1);
    await sleep(160);
    expect(r.dp.controls).toEqual([
      { action: 'resize', cols: 80, rows: 24 },
      { action: 'resize', cols: 83, rows: 26 },
    ]);
    expect(() => r.bridge.resize({ cols: 0, rows: 10 })).toThrow();
    expect(() => r.bridge.resize({ cols: 1001, rows: 10 })).toThrow();
  });

  it('a 409 at the handshake → attached_elsewhere; take over → control close, then a new shell', async () => {
    const { srv, rig: r } = await rig();
    srv.plan.push(409);
    r.bridge.attach({ cols: 80, rows: 24 });
    await r.bridge.settled();
    expect(r.bridge.terminalState).toBe('attached_elsewhere');
    expect(r.dp.controls).toEqual([]);
    await r.bridge.takeOver();
    expect(r.dp.controls[0]).toEqual({ action: 'close' });
    await attached(srv, r);
    expect(r.states).toEqual(['connecting', 'attached_elsewhere', 'connecting', 'attached']);
  });

  it('review: after Take over a lingering 409 is retried briefly instead of showing attached_elsewhere again', async () => {
    const { srv, rig: r } = await rig();
    srv.plan.push(409);
    r.bridge.attach({ cols: 80, rows: 24 });
    await r.bridge.settled();
    expect(r.bridge.terminalState).toBe('attached_elsewhere');
    srv.plan.push(409, 409);
    await r.bridge.takeOver();
    await attached(srv, r);
    expect(r.delays).toEqual([500, 1000]);
    // Gives up after afterCloseRetryMs (10 s), not the 60 s of a drop.
    srv.plan.push(...Array.from({ length: 20 }, () => 409));
    r.bridge.suspend();
    r.bridge.resume();
    await until(() => r.bridge.terminalState === 'attached_elsewhere', 5000, 'gives up after 10 s');
    expect(r.delays.slice(2)).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it('review: input queued while connecting is dropped when the shell turns out to be attached elsewhere', async () => {
    const { srv, rig: r } = await rig();
    srv.plan.push(409);
    r.bridge.attach({ cols: 80, rows: 24 });
    r.bridge.write('rm -rf build\r');
    await r.bridge.settled();
    expect(r.bridge.terminalState).toBe('attached_elsewhere');
    await r.bridge.takeOver();
    await attached(srv, r);
    r.bridge.write('ls\r');
    await until(() => srv.last().frames.length >= 1, 2000, 'frame');
    await sleep(30);
    expect(srv.last().frames.map((f) => f.data.toString())).toEqual(['ls\r']);
  });

  it('a 401 at the handshake → one token refresh → reattach', async () => {
    const { srv, rig: r } = await rig();
    srv.plan.push(401);
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    expect(r.dp.refreshes).toBe(1);
    expect(r.delays).toEqual([]);
    expect(srv.upgrades.map((u) => u.answer)).toEqual([401, 'ok']);
  });

  it('a second 401 in a row → unavailable (no loop)', async () => {
    const { srv, rig: r } = await rig();
    srv.plan.push(401, 401);
    r.bridge.attach({ cols: 80, rows: 24 });
    await r.bridge.settled();
    expect(r.bridge.terminalState).toBe('closed');
    expect(r.unavailable).toHaveLength(1);
    expect(r.dp.refreshes).toBe(1);
    expect(srv.upgrades).toHaveLength(2);
    // "Reconnect": attaching again starts over.
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
  });

  it('reconnects with the backoff schedule 0.5, 1, 2, 4, 8, 16, 30, 30 s after a drop', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    srv.plan.push(500, 502, 503, 500, 500, 500, 500);
    r.clock.t += 60_000; // the socket was up a while: the backoff starts at 0.5 s
    srv.last().ws.close(1011);
    await until(() => srv.conns.length === 2 && r.bridge.terminalState === 'attached', 5000, 'reattached');
    expect(r.delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(r.states.filter((s) => s === 'reconnecting').length).toBeGreaterThan(0);
    expect(r.bridge.reconnects).toBe(1);
  });

  it('review: a socket that drops right after the handshake keeps the backoff growing (0.5 → 1 → 2 …)', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    // Every new socket is closed by the server as soon as it opens.
    let drops = 0;
    const kill = setInterval(() => {
      const c = srv.last();
      if (c && c.closeCode === null && c.ws.readyState === 1 && r.bridge.terminalState === 'attached' && drops < 4) {
        drops += 1;
        c.ws.close(1011);
      }
    }, 2);
    cleanups.push(() => clearInterval(kill));
    await until(() => drops >= 4 && r.delays.length >= 4, 5000, 'four quick drops');
    clearInterval(kill);
    expect(r.delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
  });

  it('review: a socket that stayed up resets the backoff to 0.5 s', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    srv.last().ws.close(1011);
    await until(() => srv.conns.length === 2 && r.bridge.terminalState === 'attached', 5000, 'reattached once');
    r.clock.t += SHELL_TIMING.stableSocketMs;
    srv.last().ws.close(1011);
    await until(() => srv.conns.length === 3 && r.bridge.terminalState === 'attached', 5000, 'reattached twice');
    expect(r.delays).toEqual([1000, 500]);
  });

  it('jitters each delay by ±25 % and never above 30 s', async () => {
    const { srv, rig: r } = await rig({ random: 1 });
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    srv.plan.push(500, 500, 500, 500, 500, 500, 500);
    r.clock.t += 60_000; // the socket was up a while: the backoff starts at 0.5 s
    srv.last().ws.close(1011);
    await until(() => srv.conns.length === 2 && r.bridge.terminalState === 'attached', 5000, 'reattached');
    expect(r.delays).toEqual([625, 1250, 2500, 5000, 10000, 20000, 30000, 30000]);
  });

  it('after a drop, a 409 is retried for 60 s before attached_elsewhere (stale attachment)', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    srv.plan.push(...Array.from({ length: 20 }, () => 409));
    r.clock.t += 60_000; // the socket was up a while: the backoff starts at 0.5 s
    srv.last().ws.close(1001);
    await until(() => r.bridge.terminalState === 'attached_elsewhere', 5000, 'attached_elsewhere');
    // First 409 after 0.5 s; then 1+2+4+8+16+30 = 61 s more → past 60 s.
    expect(r.delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it('pauses the socket at 512 KiB unacked while visible, resumes below 128 KiB', async () => {
    const { srv, rig: r } = await rig();
    r.flow.setVisible(true);
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    for (let i = 0; i < 10; i += 1) srv.last().ws.send(new Uint8Array(64 * KiB).fill(0x41 + i), { binary: true });
    await until(() => r.pauses.includes(true), 3000, 'pause');
    expect(r.flow.stats().unacked).toBeGreaterThan(512 * KiB);
    const seq = r.flow.lastSeq;
    r.flow.ack(seq);
    expect(r.pauses).toEqual([true, false]);
    // Everything arrives once resumed.
    await until(() => r.flow.ring.totalWritten === 640 * KiB, 3000, 'all output');
  });

  it('a closed dock with 10 MB of output never pauses the ws and emits nothing', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    r.flow.setVisible(false);
    await attached(srv, r);
    for (let i = 0; i < 160; i += 1) srv.last().ws.send(new Uint8Array(64 * KiB).fill(i % 256), { binary: true });
    await until(() => r.flow.ring.totalWritten === 160 * 64 * KiB, 10_000, '10 MB');
    expect(r.pauses).toEqual([]);
    expect(r.chunks).toEqual([]);
    expect(r.flow.ring.size).toBe(1024 * KiB);
  });

  it('a renderer reload mid-stream (no more acks), then attach: the ws resumes and the replay holds the ring', async () => {
    const { srv, rig: r } = await rig();
    r.flow.setVisible(true);
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    srv.last().ws.send(enc('$ cat big.log\r\n'), { binary: true });
    for (let i = 0; i < 12; i += 1) srv.last().ws.send(new Uint8Array(64 * KiB).fill(0x61), { binary: true });
    await until(() => r.pauses.includes(true), 3000, 'pause');
    // The reloaded renderer mounts and attaches again.
    r.flow.setVisible(true);
    const { replay, seq } = r.bridge.attach({ cols: 80, rows: 24 });
    expect(r.pauses.at(-1)).toBe(false);
    expect(Array.from(replay.subarray(0, SOFT_RESET.byteLength))).toEqual(Array.from(SOFT_RESET));
    expect(dec(replay.subarray(SOFT_RESET.byteLength, SOFT_RESET.byteLength + 15))).toBe('$ cat big.log\r\n');
    expect(seq).toBe(r.flow.lastSeq);
    await until(() => r.flow.ring.totalWritten === 15 + 12 * 64 * KiB, 3000, 'rest of the stream');
  });

  it('refuses an oversized frame (1 MiB max): closes with 1009, keeps none of it, reconnects', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    const first = srv.last();
    first.ws.send(enc('ok\r\n'), { binary: true });
    await until(() => r.flow.ring.totalWritten === 4);
    first.ws.send(new Uint8Array(2 * 1024 * KiB).fill(0x42), { binary: true });
    await until(() => first.closeCode !== null, 3000, 'close');
    expect(first.closeCode).toBe(1009);
    expect(r.flow.ring.totalWritten).toBe(4);
    await until(() => srv.conns.length === 2 && r.bridge.terminalState === 'attached', 3000, 'reconnected');
  });

  it('replays after a reattach and nudges the size (cols − 1, then cols) so full-screen programs redraw', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 120, rows: 40 });
    await attached(srv, r);
    srv.last().ws.send(enc('hello from before\r\n'), { binary: true });
    await until(() => r.flow.ring.totalWritten > 0);
    srv.last().ws.close(1001);
    await until(() => srv.conns.length === 2 && r.bridge.terminalState === 'attached', 3000, 'reconnected');
    await until(() => r.dp.controls.length === 2);
    const before = r.dp.controls.length;
    const { replay } = r.bridge.attach({ cols: 120, rows: 40 });
    expect(dec(replay)).toContain('hello from before');
    await until(() => r.dp.controls.length === before + 2);
    expect(r.dp.controls.slice(before)).toEqual([
      { action: 'resize', cols: 119, rows: 40 },
      { action: 'resize', cols: 120, rows: 40 },
    ]);
  });

  it('never sends exit: dispose closes the socket (1000) without a control close or any input', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    await until(() => r.dp.controls.length === 1);
    r.bridge.dispose();
    await until(() => srv.last().closeCode !== null, 3000, 'close');
    expect(srv.last().closeCode).toBe(1000);
    expect(srv.last().frames).toEqual([]);
    expect(r.dp.controls.every((c) => c.action === 'resize')).toBe(true);
    expect(r.bridge.terminalState).toBe('closed');
    expect(() => r.bridge.write('x')).toThrow();
    // No reconnect after our own close.
    await sleep(50);
    expect(srv.conns).toHaveLength(1);
  });

  it('suspend drops the socket without reconnecting; resume reattaches', async () => {
    const { srv, rig: r } = await rig();
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    r.bridge.suspend();
    expect(r.bridge.terminalState).toBe('none');
    await sleep(50);
    expect(srv.conns).toHaveLength(1);
    r.bridge.resume();
    await attached(srv, r, 2);
  });

  it('a missing pong for the timeout terminates the socket and reconnects', async () => {
    const { srv, rig: r } = await rig({ autoPong: false, ping: { pingMs: 20, pongTimeoutMs: 80 } });
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    await until(() => srv.conns.length >= 2, 3000, 'reconnect after missed pong');
  });

  it('keeps a socket whose pongs arrive', async () => {
    const { srv, rig: r } = await rig({ ping: { pingMs: 20, pongTimeoutMs: 80 } });
    r.bridge.attach({ cols: 80, rows: 24 });
    await attached(srv, r);
    await sleep(300);
    expect(srv.conns).toHaveLength(1);
    expect(r.bridge.terminalState).toBe('attached');
  });

  it('a launch that keeps failing backs off; a 404 makes the terminal unavailable', async () => {
    const { rig: r } = await rig();
    const { GmiError } = await import('@shared/contracts/errors');
    r.dp.launchError.push(new GmiError('network', 'down'), new GmiError('not_found', 'gone', { status: 404 }));
    r.bridge.attach({ cols: 80, rows: 24 });
    await until(() => r.unavailable.length === 1, 3000, 'unavailable');
    expect(r.delays).toEqual([500]);
    expect(r.bridge.terminalState).toBe('closed');
  });
});
