// Terminal output flow control (compute.md §8.2, DC9). Owned by C2-A.
//
// Every output byte goes into the session's 1 MiB ring first. Bytes reach the renderer as `computer:terminal` chunks
// only while a view is watching: visible (reported by `terminalVisibility`) and in sync (it attached since the last
// gap). Chunks are batched every 16 ms or 64 KiB.
//
// Backpressure only while someone is watching: more than 512 KiB emitted but not acked → pause the socket; below
// 128 KiB → resume. Nobody watching (dock closed, warm period, window hidden, renderer reloading) → keep reading into
// the ring, emit nothing, never pause: a remote build never stalls because nobody looks. A renderer that stops acking
// (reload, crash) for 5 s while the socket is paused counts as not watching.
//
// `seq` numbers batches. When output is dropped because nobody watches, `seq` still advances once (a gap marker): a
// view that becomes visible again and sees `lastSeq` ahead of its own calls `terminalAttach` for a replay.
import { ByteRing } from './ring-buffer';

export const TERMINAL_FLOW = {
  /** Batch window of `computer:terminal` events. */
  batchMs: 16,
  /** Largest chunk per event. */
  batchBytes: 64 * 1024,
  /** Pause the socket above this many unacked bytes (visible only). */
  highWaterBytes: 512 * 1024,
  /** Resume below this. */
  lowWaterBytes: 128 * 1024,
  /** A paused flow without any ack for this long treats the view as gone (renderer reload or crash). */
  staleAckMs: 5_000,
} as const;

export type TerminalFlowOptions = { -readonly [K in keyof typeof TERMINAL_FLOW]: number };

export interface FlowTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: FlowTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface TerminalFlowDeps {
  /** One batch for the renderer (≤ batchBytes). */
  emit(chunk: { seq: number; data: Uint8Array }): void;
  /** Socket backpressure (ws.pause / ws.resume). Called only on changes. */
  setPaused(paused: boolean): void;
  /**
   * The view that was watching fell out of sync without being told (stale acks), or a view that was written off as
   * gone acked again: the session re-emits `computer:session` so the view sees `lastSeq` ahead and reattaches.
   */
  onGap?(): void;
  ring?: ByteRing;
  options?: Partial<TerminalFlowOptions>;
  timers?: FlowTimers;
}

export interface TerminalFlowStats {
  seq: number;
  unacked: number;
  paused: boolean;
  visible: boolean;
  /** The view holds everything up to `seq` (false after a gap until the next attach). */
  synced: boolean;
  ringBytes: number;
  emittedBytes: number;
}

export class TerminalFlow {
  readonly ring: ByteRing;
  private readonly opt: TerminalFlowOptions;
  private readonly timers: FlowTimers;
  private seq = 0;
  private visible = false;
  private synced = false;
  private paused = false;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private batchTimer: unknown = null;
  private staleTimer: unknown = null;
  /** Bytes emitted since the last attach, and the cumulative count at each emitted seq (for acks). */
  private emitted = 0;
  private acked = 0;
  private marks: Array<{ seq: number; cum: number }> = [];
  private disposed = false;
  /** The stale-ack timer marked the view gone (it never said so itself). */
  private staleGone = false;

  constructor(private readonly deps: TerminalFlowDeps) {
    this.ring = deps.ring ?? new ByteRing();
    this.opt = { ...TERMINAL_FLOW, ...deps.options };
    this.timers = deps.timers ?? defaultTimers;
  }

  /** Output from the PTY. Always kept in the ring; emitted only while watched. */
  push(bytes: Uint8Array): void {
    if (this.disposed || bytes.byteLength === 0) return;
    this.ring.push(bytes);
    if (!this.watching()) {
      this.markGap();
      return;
    }
    this.pending.push(bytes);
    this.pendingBytes += bytes.byteLength;
    if (this.pendingBytes >= this.opt.batchBytes) this.flush();
    else if (this.batchTimer === null) this.batchTimer = this.timers.setTimeout(() => this.flush(), this.opt.batchMs);
  }

  /** A view (re)attached: it gets the ring as replay and is in sync at `seq`. Resets the unacked count. */
  attach(): { replay: Uint8Array; seq: number } {
    this.clearBatch();
    this.emitted = 0;
    this.acked = 0;
    this.marks = [];
    this.synced = true;
    this.staleGone = false;
    this.update();
    return { replay: this.ring.snapshot(), seq: this.seq };
  }

  /** The renderer has written everything up to `seq`. */
  ack(seq: number): void {
    if (this.disposed || !Number.isInteger(seq)) return;
    let cum: number | null = null;
    while (this.marks.length > 0 && (this.marks[0] as { seq: number }).seq <= seq) cum = (this.marks.shift() as { cum: number }).cum;
    if (cum !== null) this.acked = Math.max(this.acked, cum);
    if (this.staleGone) {
      // It was only slow (throttled timers in an occluded window): it is still showing the terminal, out of sync.
      this.staleGone = false;
      this.visible = true;
      this.gap();
    }
    this.armStale();
    this.update();
  }

  setVisible(visible: boolean): void {
    if (this.disposed) return;
    if (!visible && this.visible && this.pendingBytes > 0) {
      // Already in the ring; the view misses it until it reattaches.
      this.clearBatch();
      this.markGap();
    }
    this.visible = visible;
    this.staleGone = false;
    this.update();
  }

  stats(): TerminalFlowStats {
    return {
      seq: this.seq,
      unacked: this.emitted - this.acked,
      paused: this.paused,
      visible: this.visible,
      synced: this.synced,
      ringBytes: this.ring.size,
      emittedBytes: this.emitted,
    };
  }

  /** The last seq (emitted or gap). */
  get lastSeq(): number {
    return this.seq;
  }

  dispose(): void {
    this.disposed = true;
    this.clearBatch();
    if (this.staleTimer !== null) this.timers.clearTimeout(this.staleTimer);
    this.staleTimer = null;
    if (this.paused) {
      this.paused = false;
      this.deps.setPaused(false);
    }
  }

  // ─── internals ───

  private watching(): boolean {
    return this.visible && this.synced;
  }

  private markGap(): void {
    if (this.synced) {
      this.synced = false;
      this.seq += 1;
    }
  }

  private gap(): void {
    try {
      this.deps.onGap?.();
    } catch {
      // listeners never break the flow
    }
  }

  private clearBatch(): void {
    if (this.batchTimer !== null) this.timers.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.pending = [];
    this.pendingBytes = 0;
  }

  private flush(): void {
    if (this.batchTimer !== null) this.timers.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (this.pendingBytes === 0 || this.disposed) return;
    const all = concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    if (!this.watching()) {
      this.markGap();
      return;
    }
    for (let off = 0; off < all.byteLength; off += this.opt.batchBytes) {
      // A plain copy (never a view into a ws Buffer that might be reused).
      const data = new Uint8Array(all.subarray(off, Math.min(all.byteLength, off + this.opt.batchBytes)));
      this.seq += 1;
      this.emitted += data.byteLength;
      this.marks.push({ seq: this.seq, cum: this.emitted });
      this.deps.emit({ seq: this.seq, data });
    }
    this.update();
  }

  /** Applies the pause rule: only while watched, with hysteresis. */
  private update(): void {
    if (this.disposed) return;
    const unacked = this.emitted - this.acked;
    let want = this.paused;
    if (!this.watching()) want = false;
    else if (!this.paused && unacked > this.opt.highWaterBytes) want = true;
    else if (this.paused && unacked < this.opt.lowWaterBytes) want = false;
    if (want !== this.paused) {
      this.paused = want;
      this.deps.setPaused(want);
      if (want) this.armStale();
    }
    if (!this.paused && this.staleTimer !== null) {
      this.timers.clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private armStale(): void {
    if (this.staleTimer !== null) this.timers.clearTimeout(this.staleTimer);
    this.staleTimer = null;
    if (!this.paused) return;
    this.staleTimer = this.timers.setTimeout(() => {
      this.staleTimer = null;
      // No ack for a while with the socket paused: the view is gone (reload, crash). Stop emitting, never stall.
      if (this.paused) {
        this.visible = false;
        this.staleGone = true;
        this.markGap();
        this.update();
        this.gap();
      }
    }, this.opt.staleAckMs);
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
