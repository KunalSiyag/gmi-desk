// The renderer half of the shell bridge's flow control (compute.md §8.2, DC9), without xterm or React so it can be
// unit-tested with a fake terminal:
// - attach: `terminalAttach` returns the ring buffer and its seq; the replay is written (after a reset when this view
//   already showed output), chunks that raced the attach are buffered and replayed in order, duplicates dropped;
// - ack: every chunk is written with `write(data, cb)`; once xterm has parsed 64 KiB, `terminalAck(seq)` tells main;
// - visibility: reported on start, on every change and on dispose. Main emits nothing while the view is hidden (it
//   keeps reading into its ring and never pauses the socket), so becoming visible again re-attaches;
// - input: split into ≤ 64 KiB invokes on code-point boundaries, sent in order (IPC keeps invoke order; main queues
//   synchronously); resize only while attached and only when the size changed.
import { TERMINAL_INPUT_MAX_BYTES, type ComputerApi, type TerminalChunk } from '@shared/contracts/compute';

/** Ack once this many bytes have been parsed since the last ack (§8.2). */
export const ACK_EVERY_BYTES = 64 * 1024;
/** Chunks kept while an attach is in flight (main sends at most ~512 KiB unacked to a visible view). */
export const PENDING_MAX_CHUNKS = 2048;

/** The part of xterm's Terminal the controller drives. */
export interface TerminalSink {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array | string, callback?: () => void): void;
  /** Full reset (RIS): before a replay into a view that already shows output. */
  reset(): void;
}

export type TerminalPort = Pick<ComputerApi, 'terminalAttach' | 'terminalInput' | 'terminalResize' | 'terminalAck' | 'terminalVisibility'>;

export interface TerminalControllerOptions {
  sessionId: string;
  term: TerminalSink;
  port: TerminalPort;
  /** A failed attach / input / resize (the view shows it; ack and visibility failures are ignored). */
  onError?: (error: unknown, op: 'attach' | 'input' | 'resize') => void;
  /** Attached (true) or not (false): the view enables input only while attached. */
  onAttached?: (attached: boolean) => void;
}

const encoder = new TextEncoder();

/** Splits `data` into pieces of at most `maxBytes` UTF-8 bytes without cutting a code point. */
export function splitUtf8(data: string, maxBytes = TERMINAL_INPUT_MAX_BYTES): string[] {
  if (encoder.encode(data).byteLength <= maxBytes) return data ? [data] : [];
  const out: string[] = [];
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < data.length) {
    const cp = data.codePointAt(i)!;
    const units = cp > 0xffff ? 2 : 1;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) {
      out.push(data.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    i += units;
  }
  if (start < data.length) out.push(data.slice(start));
  return out;
}

export class TerminalController {
  readonly sessionId: string;
  private readonly term: TerminalSink;
  private readonly port: TerminalPort;
  private readonly opts: TerminalControllerOptions;

  private attachedFlag = false;
  private attachInFlight = false;
  /** Bumped by every attach and by dispose: callbacks from an older generation are ignored. */
  private generation = 0;
  private pending: TerminalChunk[] = [];
  /** Highest seq written (or covered by the replay). */
  private lastSeq = -1;
  private parsedSinceAck = 0;
  private lastAckedSeq = -1;
  private wroteOutput = false;
  private visible: boolean | null = null;
  /** Main emitted nothing while hidden: re-attach on the next show. */
  private stale = true;
  private sentSize: { cols: number; rows: number } | null = null;
  private disposed = false;
  /** Main would refuse input now (paused, not connected, attached elsewhere): typing is dropped, not sent. */
  private inputAllowed = true;

  constructor(opts: TerminalControllerOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.term = opts.term;
    this.port = opts.port;
  }

  get attached(): boolean {
    return this.attachedFlag;
  }

  /** An attach is in flight. */
  get attaching(): boolean {
    return this.attachInFlight;
  }

  /** The highest seq this view holds (written or covered by its replay); -1 before the first attach. */
  get seq(): number {
    return this.lastSeq;
  }

  /** Whether typing may reach main (the view also disables xterm's stdin). */
  setInputAllowed(allowed: boolean): void {
    this.inputAllowed = allowed;
  }

  /**
   * Main announced (in `computer:session`) a `lastSeq` past this view's while the view is visible and attached: it
   * missed output (a stale-ack gap) and must attach again for a replay.
   */
  isBehind(sessionLastSeq: number): boolean {
    return !this.disposed && this.visible === true && this.attachedFlag && !this.attachInFlight && sessionLastSeq > this.lastSeq;
  }

  /** Reports the initial visibility and attaches when visible (otherwise on the first show). */
  start(visible: boolean): Promise<void> {
    return this.setVisible(visible);
  }

  /** Visibility changed (tab, window minimised or hidden). Showing again after a hidden period re-attaches. */
  async setVisible(visible: boolean): Promise<void> {
    if (this.disposed) return;
    if (this.visible === visible) return;
    this.visible = visible;
    this.port.terminalVisibility(this.sessionId, visible).catch(() => undefined);
    if (!visible) {
      // Main stops emitting: whatever arrives later is a fresh replay.
      this.stale = true;
      return;
    }
    if (this.stale) await this.attach();
  }

  /** (Re)attaches: writes the replay, then anything that arrived meanwhile. Resolves when done (never rejects). */
  async attach(): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.generation;
    this.attachedFlag = false;
    this.attachInFlight = true;
    this.pending = [];
    this.opts.onAttached?.(false);
    const size = { cols: this.term.cols, rows: this.term.rows };
    let result: { replay: Uint8Array; seq: number };
    try {
      result = await this.port.terminalAttach(this.sessionId, size);
    } catch (error) {
      if (gen === this.generation && !this.disposed) {
        this.attachInFlight = false;
        this.pending = [];
        this.opts.onError?.(error, 'attach');
      }
      return;
    }
    if (gen !== this.generation || this.disposed) return;
    this.attachInFlight = false;
    // Hidden while the attach was in flight: main emits nothing now, so the next show attaches again.
    this.stale = this.visible === false;
    if (this.wroteOutput) this.term.reset();
    // Main resets its unacked count on attach; the replay itself is never acked.
    this.parsedSinceAck = 0;
    this.lastSeq = result.seq;
    this.lastAckedSeq = result.seq;
    this.sentSize = size;
    if (result.replay.byteLength > 0) {
      this.term.write(result.replay);
      this.wroteOutput = true;
    }
    this.attachedFlag = true;
    this.opts.onAttached?.(true);
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.onChunk(chunk);
    // The view may have been resized while the attach was in flight.
    this.resize();
  }

  /** A `computer:terminal` event. */
  onChunk(chunk: TerminalChunk): void {
    if (this.disposed || chunk.sessionId !== this.sessionId) return;
    if (!this.attachedFlag) {
      if (this.attachInFlight && this.pending.length < PENDING_MAX_CHUNKS) this.pending.push(chunk);
      return;
    }
    if (chunk.seq <= this.lastSeq) return;
    this.lastSeq = chunk.seq;
    const gen = this.generation;
    const bytes = chunk.data.byteLength;
    this.wroteOutput = true;
    this.term.write(chunk.data, () => this.parsed(gen, chunk.seq, bytes));
  }

  private parsed(gen: number, seq: number, bytes: number): void {
    if (gen !== this.generation || this.disposed) return;
    this.parsedSinceAck += bytes;
    if (this.parsedSinceAck >= ACK_EVERY_BYTES && seq > this.lastAckedSeq) {
      this.parsedSinceAck = 0;
      this.lastAckedSeq = seq;
      this.port.terminalAck(this.sessionId, seq).catch(() => undefined);
    }
  }

  /** Keyboard input or a paste (xterm's onData). Dropped while not attached (the view disables input then). */
  input(data: string): void {
    if (this.disposed || !this.attachedFlag || !this.inputAllowed || !data) return;
    for (const piece of splitUtf8(data)) {
      this.port.terminalInput(this.sessionId, piece).catch((error: unknown) => this.opts.onError?.(error, 'input'));
    }
  }

  /** The view was fitted: tells main the new size (only while attached, only when it changed). */
  resize(): void {
    if (this.disposed || !this.attachedFlag) return;
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols < 2 || rows < 1) return;
    if (this.sentSize && this.sentSize.cols === cols && this.sentSize.rows === rows) return;
    this.sentSize = { cols, rows };
    this.port.terminalResize(this.sessionId, { cols, rows }).catch((error: unknown) => this.opts.onError?.(error, 'resize'));
  }

  /** Unmount: nobody is watching any more (main stops backpressure and emits nothing). */
  dispose(): void {
    if (this.disposed) return;
    this.generation++;
    if (this.visible !== false) this.port.terminalVisibility(this.sessionId, false).catch(() => undefined);
    this.disposed = true;
    this.attachedFlag = false;
    this.pending = [];
  }
}
