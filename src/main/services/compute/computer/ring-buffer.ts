// The terminal's output ring (compute.md §8.1–8.2, T20): the newest 1 MiB of PTY bytes of one session, kept in main
// so a remount, a renderer reload or a reconnect can replay the screen. Owned by C2-A.
//
// Fixed memory: one preallocated buffer, the oldest bytes are overwritten. A push larger than the capacity keeps only
// its tail. Terminal bytes are never logged (§17).

/** Bytes of terminal output each session keeps (§8.1, §18). */
export const TERMINAL_RING_BYTES = 1024 * 1024;

export class ByteRing {
  private readonly buf: Uint8Array;
  /** Next write position. */
  private head = 0;
  private used = 0;
  private written = 0;

  constructor(readonly capacity: number = TERMINAL_RING_BYTES) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('ring capacity must be a positive integer');
    this.buf = new Uint8Array(capacity);
  }

  /** Bytes currently held (≤ capacity). */
  get size(): number {
    return this.used;
  }

  /** Every byte ever pushed (including those overwritten since). */
  get totalWritten(): number {
    return this.written;
  }

  /** Bytes pushed but no longer held. */
  get dropped(): number {
    return this.written - this.used;
  }

  push(bytes: Uint8Array): void {
    const n = bytes.byteLength;
    if (n === 0) return;
    this.written += n;
    const cap = this.capacity;
    // Only the last `cap` bytes of a large push can survive.
    const src = n > cap ? bytes.subarray(n - cap) : bytes;
    const len = src.byteLength;
    const first = Math.min(len, cap - this.head);
    this.buf.set(src.subarray(0, first), this.head);
    if (first < len) this.buf.set(src.subarray(first), 0);
    this.head = (this.head + len) % cap;
    this.used = Math.min(cap, this.used + len);
  }

  /** A copy of the held bytes, oldest first. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.used);
    if (this.used === 0) return out;
    const start = (this.head - this.used + this.capacity) % this.capacity;
    const first = Math.min(this.used, this.capacity - start);
    out.set(this.buf.subarray(start, start + first), 0);
    if (first < this.used) out.set(this.buf.subarray(0, this.used - first), first);
    return out;
  }

  clear(): void {
    this.head = 0;
    this.used = 0;
  }
}
