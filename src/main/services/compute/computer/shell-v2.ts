// The shell bridge for Sandbox API v2 (compute.md §8.2, §8.7, T20). Owned by C2-A.
//
// Protocol [V]: POST /shell (202 → retry, inside the data plane) → `wss://{sandbox_key}.{domain}/shell/connect` with
// `X-Access-Token`, opened by `ws` in main. Frames are binary only: raw input up, raw output down. The bridge never
// sends a text frame (a text frame drops the connection [V]) and never sends `exit` (it kills the session for good on
// gateway A [V]). Resize goes through POST /shell/control, debounced to 150 ms, only while attached.
//
// States: none → connecting → attached; a close we did not ask for → reconnecting (backoff 0.5, 1, 2, 4, 8 … 30 s,
// jittered) → connecting. 409 at the handshake → attached_elsewhere (after a drop: retried for 60 s first). 401 at the
// handshake → one token refresh → connecting; again → unavailable. A paused sandbox suspends the bridge (the session
// resumes it once the supervisor sees it running).
//
// `ws` options: no permessage-deflate and `maxPayload` 1 MiB, so a hostile sandbox cannot push a 100 MiB frame or a
// deflate bomb into main's memory; no redirects; 10 s handshake timeout. Keepalive: ping every 25 s, a pong missing for
// 60 s terminates the socket (→ reconnecting).
//
// Never logged: the socket URL, headers, tokens, terminal bytes (§17).
// @ts-ignore -- `ws` ships no types and `@types/ws` is not installed yet (C2-0 report); the shape used is `WsLike`.
import { WebSocket as WsWebSocket } from 'ws';
import type { TerminalState } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../../core/logger';
import type { DataPlaneApi } from '../sandbox/dataplane';
import type { TerminalFlow } from './flow';

// ─── Constants ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The `ws` client options of §8.2 (exported for the tests). */
export const SHELL_WS_OPTIONS = {
  perMessageDeflate: false,
  maxPayload: 1 << 20,
  handshakeTimeout: 10_000,
  followRedirects: false,
} as const;

export const SHELL_TIMING = {
  resizeDebounceMs: 150,
  /** Reconnect backoff; the last value repeats. Each delay is jittered by ±25 %, capped at 30 s. */
  backoffMs: [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as readonly number[],
  backoffMaxMs: 30_000,
  /** After a drop, a 409 at the handshake is retried this long before showing attached_elsewhere (§8.7). */
  staleAttachRetryMs: 60_000,
  /** After Take over or a resume, a 409 is retried this long: the old attachment may linger a moment [U] (§8.7). */
  afterCloseRetryMs: 10_000,
  /** A socket that stayed up this long resets the reconnect backoff; a shorter one keeps it growing (§8.2). */
  stableSocketMs: 10_000,
  pingMs: 25_000,
  pongTimeoutMs: 60_000,
};

export type ShellTiming = typeof SHELL_TIMING;

/** Input queued while (re)connecting, at most. */
export const SHELL_INPUT_QUEUE_MAX = 256 * 1024;

/** DECSTR: the ring may start inside an escape sequence or the alternate screen (§8.2). */
export const SOFT_RESET = new Uint8Array([0x1b, 0x5b, 0x21, 0x70]);

// ─── Socket abstraction (ws in real mode, the fake PTY in mock mode) ───────────────────────────────────────────────

/** One attachment to the remote PTY. */
export interface ShellSocket {
  /** Sends raw bytes as ONE binary frame. */
  send(bytes: Uint8Array): void;
  pause(): void;
  resume(): void;
  /** Closes from our side; `onClose` is not called for it. Never sends `exit`. */
  close(): void;
}

export interface ShellSocketHandlers {
  onData(bytes: Uint8Array): void;
  /** The socket closed without us asking (remote close, network drop, oversized frame, missed pong). */
  onClose(info: { code: number; cause: 'remote' | 'too_big' | 'pong_timeout' | 'error' }): void;
}

export type ShellSocketOpener = (
  target: { sandboxId: string; connectUrl: string },
  handlers: ShellSocketHandlers,
  signal: AbortSignal,
) => Promise<ShellSocket>;

/** A refused WebSocket handshake (HTTP status of the upgrade response). */
export class ShellHandshakeError extends GmiError {
  constructor(status: number) {
    super(
      status === 409 ? 'conflict' : status === 401 ? 'unauthorized' : 'upstream',
      status === 409 ? 'Another client is attached to this shell.' : `The sandbox refused the terminal connection (${status}).`,
      { status },
    );
    this.name = 'ShellHandshakeError';
  }
}

/** The subset of a `ws` WebSocket this module uses. */
interface WsLike {
  binaryType: string;
  readonly readyState: number;
  readonly isPaused: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  send(data: Uint8Array, opts: { binary: boolean }, cb?: (err?: Error) => void): void;
  ping(): void;
  pause(): void;
  resume(): void;
  close(code?: number): void;
  terminate(): void;
}
export type WsCtor = new (url: string, opts: Record<string, unknown>) => WsLike;

const WS_OPEN = 1;

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return new Uint8Array(0);
}

/**
 * Opens the shell over `ws` (§8.2): target URL and the `X-Access-Token` header come from the data plane, which
 * checked the host. `WebSocketImpl` is injectable for tests; defaults to the `ws` package.
 */
export function createWsShellOpener(deps: {
  dataPlane: Pick<DataPlaneApi, 'shellSocket'>;
  WebSocketImpl?: WsCtor;
  timing?: Partial<Pick<ShellTiming, 'pingMs' | 'pongTimeoutMs'>>;
  now?: () => number;
}): ShellSocketOpener {
  const Ws = deps.WebSocketImpl ?? (WsWebSocket as unknown as WsCtor);
  const pingMs = deps.timing?.pingMs ?? SHELL_TIMING.pingMs;
  const pongTimeoutMs = deps.timing?.pongTimeoutMs ?? SHELL_TIMING.pongTimeoutMs;
  const now = deps.now ?? Date.now;

  return async (target, handlers, signal) => {
    if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
    const { url, headers } = await deps.dataPlane.shellSocket(target.sandboxId, target.connectUrl);
    if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
    return new Promise<ShellSocket>((resolve, reject) => {
      const ws = new Ws(url, { ...SHELL_WS_OPTIONS, headers });
      ws.binaryType = 'nodebuffer';
      let opened = false;
      let settled = false;
      let closedByUs = false;
      let cause: 'remote' | 'too_big' | 'pong_timeout' | 'error' = 'remote';
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let lastPong = now();

      const fail = (error: GmiError) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      const onAbort = () => {
        closedByUs = true;
        ws.terminate();
        fail(new GmiError('cancelled', 'Cancelled.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      ws.on('unexpected-response', ((_req: unknown, res: { statusCode?: number; resume?: () => void }) => {
        res.resume?.();
        closedByUs = true;
        ws.terminate();
        fail(new ShellHandshakeError(res.statusCode ?? 0));
      }) as (...args: never[]) => void);

      ws.on('open', () => {
        opened = true;
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        lastPong = now();
        keepalive = setInterval(() => {
          if (now() - lastPong >= pongTimeoutMs) {
            cause = 'pong_timeout';
            ws.terminate();
            return;
          }
          try {
            ws.ping();
          } catch {
            // closing
          }
        }, pingMs);
        (keepalive as { unref?: () => void }).unref?.();
        resolve({
          send(bytes) {
            if (ws.readyState !== WS_OPEN) return;
            // Binary only: a text frame drops the connection [V].
            ws.send(bytes, { binary: true });
          },
          pause: () => ws.pause(),
          resume: () => ws.resume(),
          close() {
            closedByUs = true;
            if (keepalive) clearInterval(keepalive);
            ws.close(1000);
            // A server that never answers the close frame must not keep the socket.
            const t = setTimeout(() => ws.terminate(), 2_000);
            (t as { unref?: () => void }).unref?.();
          },
        });
      });

      ws.on('pong', () => {
        lastPong = now();
      });

      ws.on('message', ((data: unknown) => {
        if (closedByUs) return;
        handlers.onData(toBytes(data));
      }) as (...args: never[]) => void);

      ws.on('error', ((err: { code?: string }) => {
        if (err?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') cause = 'too_big';
        else if (cause === 'remote') cause = 'error';
        if (!opened) fail(new GmiError('network', 'Could not reach the sandbox terminal.'));
      }) as (...args: never[]) => void);

      ws.on('close', ((code: number) => {
        if (keepalive) clearInterval(keepalive);
        if (!opened) {
          fail(new GmiError('network', 'Could not reach the sandbox terminal.'));
          return;
        }
        if (!closedByUs) handlers.onClose({ code, cause });
      }) as (...args: never[]) => void);
    });
  };
}

// ─── The bridge ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ShellBridgeDeps {
  sessionId: string;
  sandboxId: string;
  dataPlane: Pick<DataPlaneApi, 'shellLaunch' | 'shellControl' | 'tokens'>;
  open: ShellSocketOpener;
  flow: TerminalFlow;
  log: Logger;
  /** Every terminal state change (`code`: a short machine reason, never a secret). */
  onState?(state: TerminalState, code: string | null): void;
  /** The data plane refused us for good (second 401, 403, 404): the session becomes `unavailable`. */
  onUnavailable?(reason: string): void;
  timing?: Partial<ShellTiming>;
  /** Abortable sleep (tests record the backoff). */
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface ShellBridgeInfo {
  state: TerminalState;
  cols: number;
  rows: number;
  lastSeq: number;
}

const encoder = new TextEncoder();

const defaultDelay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new GmiError('cancelled', 'Cancelled.'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (t as { unref?: () => void }).unref?.();
    const onAbort = () => {
      clearTimeout(t);
      reject(new GmiError('cancelled', 'Cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const validSize = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;

export function assertTerminalSize(size: { cols: number; rows: number }): void {
  if (!size || !validSize(size.cols) || !validSize(size.rows)) throw new GmiError('invalid_input', 'Terminal size must be 1–1000 columns and rows.');
}

/** initial: a fresh start (409 → attached_elsewhere at once); after_close: Take over / resume (409 retried briefly). */
type LoopMode = 'initial' | 'after_close' | 'reconnect';

export class ShellBridge {
  private state: TerminalState = 'none';
  private cols = 80;
  private rows = 24;
  private socket: ShellSocket | null = null;
  private loop: AbortController | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private fifo: Uint8Array[] = [];
  private fifoBytes = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedWanted = false;
  /** The user wants a shell (attached once): a resume after a pause reattaches. */
  private wanted = false;
  private suspended = false;
  private disposed = false;
  /** Sockets that dropped soon after they opened, in a row: the reconnect backoff starts from here. */
  private dropStreak = 0;
  private readonly timing: ShellTiming;
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log: Logger;
  /** Sockets lost and reconnected (Diagnostics: "ws reconnects"). */
  reconnects = 0;

  constructor(private readonly deps: ShellBridgeDeps) {
    this.timing = { ...SHELL_TIMING, ...deps.timing };
    this.delay = deps.delay ?? defaultDelay;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.log = deps.log;
  }

  info(): ShellBridgeInfo {
    return { state: this.state, cols: this.cols, rows: this.rows, lastSeq: this.deps.flow.lastSeq };
  }

  get terminalState(): TerminalState {
    return this.state;
  }

  /** A view asked for the terminal while it could not start (session unavailable): a later resume starts it. */
  want(): void {
    if (!this.disposed) this.wanted = true;
  }

  /** Resolves when the current connect loop has settled (attached, attached_elsewhere, closed or suspended). */
  settled(): Promise<void> {
    return this.loopDone;
  }

  /**
   * `terminalAttach`: starts or rejoins the shell, returns the replay (soft reset + ring) and its seq. On a rejoin of
   * a live shell, a resize nudge (cols − 1, then cols) makes full-screen programs redraw.
   */
  attach(size: { cols: number; rows: number }): { replay: Uint8Array; seq: number } {
    this.assertOpen();
    assertTerminalSize(size);
    const resized = size.cols !== this.cols || size.rows !== this.rows;
    this.cols = size.cols;
    this.rows = size.rows;
    this.wanted = true;
    const { replay, seq } = this.deps.flow.attach();
    if (this.state === 'attached') {
      if (resized) this.cancelResize();
      void this.nudge();
    } else if (!this.suspended && (this.state === 'none' || this.state === 'closed' || this.state === 'attached_elsewhere')) {
      this.startLoop('initial');
    }
    const out = new Uint8Array(SOFT_RESET.byteLength + replay.byteLength);
    out.set(SOFT_RESET, 0);
    out.set(replay, SOFT_RESET.byteLength);
    return { replay: out, seq };
  }

  /**
   * `terminalInput`: SYNCHRONOUS so that invokes are never reordered. The bytes join the FIFO before anything awaits
   * and are sent in order as binary frames.
   */
  write(data: string): void {
    this.assertOpen();
    if (this.state !== 'attached' && this.state !== 'connecting' && this.state !== 'reconnecting') {
      throw new GmiError('conflict', 'The terminal is not connected.');
    }
    const bytes = encoder.encode(data);
    if (bytes.byteLength === 0) return;
    if (this.state !== 'attached' && this.fifoBytes + bytes.byteLength > SHELL_INPUT_QUEUE_MAX) {
      throw new GmiError('conflict', 'The terminal is reconnecting; input was not sent.');
    }
    this.fifo.push(bytes);
    this.fifoBytes += bytes.byteLength;
    this.drain();
  }

  /** Debounced resize (150 ms), sent only while attached. */
  resize(size: { cols: number; rows: number }): void {
    this.assertOpen();
    assertTerminalSize(size);
    this.cols = size.cols;
    this.rows = size.rows;
    this.cancelResize();
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      void this.sendResize(this.cols, this.rows);
    }, this.timing.resizeDebounceMs);
    (this.resizeTimer as { unref?: () => void }).unref?.();
  }

  /** Flow control → socket backpressure (also applied to every new socket). */
  setPaused(paused: boolean): void {
    this.pausedWanted = paused;
    if (!this.socket) return;
    if (paused) this.socket.pause();
    else this.socket.resume();
  }

  /**
   * "Take over" (the caller showed the native confirmation): POST /shell/control {close} — irrevocable, it kills the
   * other attachment's PTY [V] — then a new shell.
   */
  async takeOver(): Promise<void> {
    this.assertOpen();
    this.stopLoop();
    this.dropSocket();
    this.wanted = true;
    this.setState('connecting', 'take_over');
    try {
      await this.deps.dataPlane.shellControl(this.deps.sandboxId, { action: 'close' });
    } catch (error) {
      // Nothing attached any more (409 Shell.NotAttached) is fine; anything else is reported.
      if (!(error instanceof GmiError && error.status === 409)) {
        this.setState('attached_elsewhere', error instanceof GmiError ? error.code : 'internal');
        throw error;
      }
    }
    if (this.disposed) return;
    this.dropStreak = 0;
    this.startLoop('after_close');
    await this.loopDone;
  }

  /** The sandbox is pausing or paused: drop the socket, wait for `resume()`. The PTY's fate is GMI's. */
  suspend(): void {
    if (this.disposed) return;
    this.suspended = true;
    this.stopLoop();
    this.dropSocket();
    if (this.state !== 'none' && this.state !== 'closed') this.setState('none', 'paused');
  }

  /** Running again (resume, a fresh token): reattach when a view wanted the shell. */
  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    // Our own socket was dropped by `suspend()`: its attachment may linger for a moment, so 409 is retried briefly.
    if (this.wanted && this.state !== 'attached' && this.state !== 'connecting' && this.state !== 'reconnecting') this.startLoop('after_close');
  }

  /** Closes the bridge for good (session close, resource deleted, quit). Never sends `exit` or a control close. */
  dispose(): void {
    if (this.disposed) return;
    this.stopLoop();
    this.dropSocket();
    this.cancelResize();
    this.fifo = [];
    this.fifoBytes = 0;
    this.setState('closed', 'disposed');
    this.disposed = true;
  }

  // ─── internals ───

  private assertOpen(): void {
    if (this.disposed) throw new GmiError('not_found', 'This computer session is closed.');
  }

  private setState(next: TerminalState, code: string | null): void {
    if (this.disposed || next === this.state) return;
    const from = this.state;
    this.state = next;
    // Input typed for a shell we no longer reach must never land in the next one (after Take over or Reconnect).
    if (next === 'attached_elsewhere' || next === 'closed') {
      this.fifo = [];
      this.fifoBytes = 0;
    }
    this.log.info('shell.state', { sid: this.deps.sessionId, from, to: next, code });
    this.deps.onState?.(next, code);
  }

  private cancelResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
  }

  private async sendResize(cols: number, rows: number): Promise<void> {
    if (this.state !== 'attached' || this.disposed) return;
    try {
      await this.deps.dataPlane.shellControl(this.deps.sandboxId, { action: 'resize', cols, rows });
    } catch (error) {
      this.log.warn('shell resize failed', { sid: this.deps.sessionId, code: error instanceof GmiError ? error.code : 'internal', status: error instanceof GmiError ? error.status : null });
    }
  }

  private async nudge(): Promise<void> {
    const { cols, rows } = this;
    const other = cols > 1 ? cols - 1 : cols + 1;
    await this.sendResize(other, rows);
    await this.sendResize(this.cols, this.rows);
  }

  private drain(): void {
    if (!this.socket || this.state !== 'attached') return;
    while (this.fifo.length > 0) {
      const bytes = this.fifo.shift() as Uint8Array;
      this.fifoBytes -= bytes.byteLength;
      this.socket.send(bytes);
    }
  }

  private dropSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (s) {
      try {
        s.close();
      } catch {
        // already closed
      }
    }
  }

  private stopLoop(): void {
    this.loop?.abort();
    this.loop = null;
  }

  private startLoop(mode: LoopMode, startAttempt = 0): void {
    this.stopLoop();
    const ac = new AbortController();
    this.loop = ac;
    this.loopDone = this.connectLoop(mode, ac.signal, startAttempt).catch((error: unknown) => {
      this.log.warn('shell loop failed', { sid: this.deps.sessionId, code: error instanceof GmiError ? error.code : 'internal' });
    });
  }

  private backoffDelay(attempt: number): number {
    const list = this.timing.backoffMs;
    const base = list[Math.min(attempt, list.length - 1)] as number;
    const jittered = base * (0.75 + 0.5 * this.random());
    return Math.min(this.timing.backoffMaxMs, Math.round(jittered));
  }

  private async connectLoop(mode: LoopMode, signal: AbortSignal, startAttempt: number): Promise<void> {
    let attempt = startAttempt;
    /** Connect without a backoff first: a fresh start, or the one reattach after a token refresh. */
    let immediate = mode !== 'reconnect';
    let first409At: number | null = null;
    let refreshed401 = false;
    for (;;) {
      if (signal.aborted || this.disposed) return;
      if (!immediate) {
        this.setState('reconnecting', null);
        try {
          await this.delay(this.backoffDelay(attempt), signal);
        } catch {
          return;
        }
        attempt += 1;
        if (signal.aborted || this.disposed) return;
      }
      immediate = false;
      this.setState('connecting', null);
      try {
        const launch = await this.deps.dataPlane.shellLaunch(this.deps.sandboxId, { signal });
        if (signal.aborted) return;
        // Output (and even a close) can arrive before we adopt the socket (the opener resolves a tick later): keep it.
        const conn: { adopted: boolean; early: Uint8Array[]; earlyClose: { code: number; cause: string } | null } = { adopted: false, early: [], earlyClose: null };
        let adoptedAt = this.now();
        const onLost = (info: { code: number; cause: string }) => {
          this.socket = null;
          this.log.info('shell socket closed', { sid: this.deps.sessionId, code: info.code, cause: info.cause });
          if (this.disposed || this.suspended) return;
          this.reconnects += 1;
          // A gateway that accepts and drops at once must not be hammered: the backoff keeps growing until a socket
          // stays up for `stableSocketMs`.
          this.dropStreak = this.now() - adoptedAt >= this.timing.stableSocketMs ? 0 : this.dropStreak + 1;
          this.startLoop('reconnect', this.dropStreak);
        };
        let adoptedSocket: ShellSocket | null = null;
        const socket: ShellSocket = await this.deps.open(
          { sandboxId: this.deps.sandboxId, connectUrl: launch.connect_url },
          {
            onData: (bytes) => {
              if (conn.adopted) {
                if (this.socket === adoptedSocket) this.deps.flow.push(bytes);
              } else if (!signal.aborted) conn.early.push(bytes);
            },
            onClose: (info) => {
              if (!conn.adopted) {
                conn.earlyClose = info;
                return;
              }
              if (this.socket === adoptedSocket) onLost(info);
            },
          },
          signal,
        );
        if (signal.aborted || this.disposed) {
          socket.close();
          return;
        }
        adoptedSocket = socket;
        adoptedAt = this.now();
        conn.adopted = true;
        this.socket = socket;
        if (this.pausedWanted) socket.pause();
        for (const bytes of conn.early.splice(0)) this.deps.flow.push(bytes);
        if (conn.earlyClose) {
          onLost(conn.earlyClose);
          return;
        }
        this.setState('attached', null);
        // The PTY gets our size at once (the debounce is for drags).
        void this.sendResize(this.cols, this.rows);
        this.drain();
        return;
      } catch (error) {
        if (signal.aborted || this.disposed) return;
        const status = error instanceof GmiError ? error.status : null;
        if (error instanceof ShellHandshakeError && status === 409) {
          if (mode === 'initial') {
            this.setState('attached_elsewhere', 'Shell.AlreadyAttached');
            return;
          }
          // After a drop the old attachment may linger until the server notices [U]: retry for 60 s (10 s after
          // Take over or a resume).
          first409At ??= this.now();
          const limit = mode === 'after_close' ? this.timing.afterCloseRetryMs : this.timing.staleAttachRetryMs;
          if (this.now() - first409At >= limit) {
            this.setState('attached_elsewhere', 'Shell.AlreadyAttached');
            return;
          }
        } else if (error instanceof ShellHandshakeError && status === 401) {
          // One token refresh and one immediate reattach per 401 burst; a second 401 → unavailable.
          if (refreshed401) return this.unavailable('The sandbox refused the terminal token.');
          refreshed401 = true;
          try {
            await this.deps.dataPlane.tokens.refresh(this.deps.sandboxId);
            immediate = true;
          } catch (refreshError) {
            if (isFatal(refreshError)) return this.unavailable(messageOf(refreshError));
          }
        } else if (isFatal(error)) {
          return this.unavailable(messageOf(error));
        }
      }
    }
  }

  private unavailable(reason: string): void {
    this.dropSocket();
    this.setState('closed', 'unavailable');
    this.deps.onUnavailable?.(reason);
  }
}

/** Errors that no retry can fix: the session becomes `unavailable` (Reconnect in the UI). */
function isFatal(error: unknown): boolean {
  if (!(error instanceof GmiError)) return false;
  if (['no_compute_key', 'invalid_compute_key', 'not_entitled', 'not_found', 'invalid_input', 'unauthorized'].includes(error.code)) return true;
  const s = error.status;
  if (error instanceof ShellHandshakeError) return s === 403 || s === 404 || (s !== null && s >= 300 && s < 400);
  return s === 401 || s === 403 || s === 404;
}

function messageOf(error: unknown): string {
  return error instanceof GmiError ? error.message : 'The sandbox terminal is not available.';
}
