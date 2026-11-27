import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_FLOW, TerminalFlow } from '@main/services/compute/computer/flow';

const KiB = 1024;

function setup(opts: { visible?: boolean; attach?: boolean } = {}) {
  const chunks: Array<{ seq: number; data: Uint8Array }> = [];
  const pauses: boolean[] = [];
  const flow = new TerminalFlow({ emit: (c) => chunks.push(c), setPaused: (p) => pauses.push(p) });
  if (opts.attach !== false) flow.attach();
  if (opts.visible !== false) flow.setVisible(true);
  return { flow, chunks, pauses };
}

const block = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);

describe('TerminalFlow (§8.2, DC9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the documented thresholds', () => {
    expect(TERMINAL_FLOW).toMatchObject({ batchMs: 16, batchBytes: 64 * KiB, highWaterBytes: 512 * KiB, lowWaterBytes: 128 * KiB });
  });

  it('batches output every 16 ms', () => {
    const { flow, chunks } = setup();
    flow.push(new TextEncoder().encode('a'));
    flow.push(new TextEncoder().encode('b'));
    expect(chunks).toHaveLength(0);
    vi.advanceTimersByTime(15);
    expect(chunks).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0]?.data)).toBe('ab');
    expect(chunks[0]?.seq).toBe(1);
  });

  it('flushes at once at 64 KiB and never emits a chunk above 64 KiB', () => {
    const { flow, chunks } = setup();
    flow.push(block(200 * KiB));
    expect(chunks.map((c) => c.data.byteLength)).toEqual([64 * KiB, 64 * KiB, 64 * KiB, 8 * KiB]);
    expect(chunks.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
  });

  it('emits plain Uint8Array copies', () => {
    const { flow, chunks } = setup();
    const src = Buffer.from('hello');
    flow.push(src);
    vi.advanceTimersByTime(16);
    src[0] = 0x7a;
    expect(new TextDecoder().decode(chunks[0]?.data)).toBe('hello');
    expect(Buffer.isBuffer(chunks[0]?.data)).toBe(false);
  });

  it('pauses above 512 KiB unacked and resumes below 128 KiB, only while visible', () => {
    const { flow, chunks, pauses } = setup();
    for (let i = 0; i < 8; i += 1) flow.push(block(64 * KiB));
    expect(flow.stats().unacked).toBe(512 * KiB);
    expect(pauses).toEqual([]);
    flow.push(block(64 * KiB));
    expect(pauses).toEqual([true]);
    expect(flow.stats().paused).toBe(true);
    // Ack down to 192 KiB unacked: still paused (hysteresis).
    flow.ack(6);
    expect(flow.stats().unacked).toBe(192 * KiB);
    expect(pauses).toEqual([true]);
    flow.ack(7);
    expect(flow.stats().unacked).toBe(128 * KiB);
    expect(pauses).toEqual([true]);
    flow.ack(8);
    expect(flow.stats().unacked).toBe(64 * KiB);
    expect(pauses).toEqual([true, false]);
    expect(chunks).toHaveLength(9);
  });

  it('acks of unknown or future seqs never go below zero', () => {
    const { flow } = setup();
    flow.push(block(10));
    vi.advanceTimersByTime(16);
    flow.ack(999);
    expect(flow.stats().unacked).toBe(0);
    flow.ack(-1);
    flow.ack(1.5);
    expect(flow.stats().unacked).toBe(0);
  });

  it('nobody watching: emits nothing, never pauses, the ring keeps the newest 1 MiB of 10 MB', () => {
    const { flow, chunks, pauses } = setup({ visible: false });
    for (let i = 0; i < 160; i += 1) flow.push(block(64 * KiB, i % 256));
    vi.advanceTimersByTime(1000);
    expect(chunks).toHaveLength(0);
    expect(pauses).toEqual([]);
    expect(flow.stats().paused).toBe(false);
    expect(flow.ring.size).toBe(1024 * KiB);
    const snap = flow.ring.snapshot();
    expect(snap[snap.byteLength - 1]).toBe(159);
  });

  it('becoming hidden while paused resumes the socket', () => {
    const { flow, pauses } = setup();
    flow.push(block(600 * KiB));
    expect(pauses).toEqual([true]);
    flow.setVisible(false);
    expect(pauses).toEqual([true, false]);
    flow.push(block(600 * KiB));
    expect(pauses).toEqual([true, false]);
  });

  it('attach resets the unacked count, returns the ring as replay and its seq', () => {
    const { flow, pauses } = setup();
    flow.push(block(600 * KiB));
    expect(flow.stats().paused).toBe(true);
    const { replay, seq } = flow.attach();
    expect(flow.stats().unacked).toBe(0);
    expect(pauses).toEqual([true, false]);
    expect(replay.byteLength).toBe(600 * KiB);
    expect(seq).toBe(flow.lastSeq);
    flow.push(block(1));
    vi.advanceTimersByTime(16);
    expect(flow.lastSeq).toBe(seq + 1);
  });

  it('marks a gap when output is dropped, so a returning view knows to reattach', () => {
    const { flow, chunks } = setup();
    flow.push(block(10));
    vi.advanceTimersByTime(16);
    expect(flow.lastSeq).toBe(1);
    flow.setVisible(false);
    flow.push(block(10));
    flow.push(block(10));
    expect(flow.lastSeq).toBe(2);
    flow.setVisible(true);
    expect(flow.stats().synced).toBe(false);
    // Not synced: still nothing is emitted until the view reattaches.
    flow.push(block(10));
    vi.advanceTimersByTime(16);
    expect(chunks).toHaveLength(1);
    const { replay, seq } = flow.attach();
    expect(seq).toBe(2);
    expect(replay.byteLength).toBe(40);
    flow.push(block(5));
    vi.advanceTimersByTime(16);
    expect(chunks.at(-1)?.seq).toBe(3);
  });

  it('a pending batch is dropped (gap) when the view hides before the flush', () => {
    const { flow, chunks } = setup();
    flow.push(block(10));
    flow.setVisible(false);
    vi.advanceTimersByTime(50);
    expect(chunks).toHaveLength(0);
    expect(flow.lastSeq).toBe(1);
    expect(flow.ring.size).toBe(10);
  });

  it('a renderer that stops acking while paused is treated as gone after 5 s (reload)', () => {
    const { flow, pauses } = setup();
    flow.push(block(600 * KiB));
    expect(pauses).toEqual([true]);
    vi.advanceTimersByTime(TERMINAL_FLOW.staleAckMs - 1);
    expect(flow.stats().paused).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pauses).toEqual([true, false]);
    expect(flow.stats().visible).toBe(false);
    // The reloaded renderer attaches again: replay + in sync.
    flow.setVisible(true);
    const { replay } = flow.attach();
    expect(replay.byteLength).toBe(600 * KiB);
    expect(flow.stats()).toMatchObject({ paused: false, unacked: 0, synced: true });
  });

  it('review: a stale timeout tells the session (onGap); a late ack restores the view, which then reattaches', () => {
    const chunks: Array<{ seq: number; data: Uint8Array }> = [];
    let gaps = 0;
    const flow = new TerminalFlow({ emit: (c) => chunks.push(c), setPaused: () => undefined, onGap: () => (gaps += 1) });
    flow.attach();
    flow.setVisible(true);
    flow.push(block(600 * KiB));
    vi.advanceTimersByTime(TERMINAL_FLOW.staleAckMs);
    expect(gaps).toBe(1);
    const seqAtGap = flow.lastSeq;
    // The slow renderer catches up: main must not stay silent, it tells the view it is behind.
    flow.ack(chunks.at(-1)?.seq ?? 0);
    expect(gaps).toBe(2);
    expect(flow.stats()).toMatchObject({ visible: true, synced: false });
    flow.push(block(10));
    vi.advanceTimersByTime(50);
    expect(flow.lastSeq).toBeGreaterThanOrEqual(seqAtGap);
    // Its reattach brings it back in sync; output flows again.
    const before = chunks.length;
    flow.attach();
    flow.push(block(10));
    vi.advanceTimersByTime(50);
    expect(chunks.length).toBe(before + 1);
  });

  it('acks keep a slow renderer from being declared gone', () => {
    const { flow } = setup();
    flow.push(block(600 * KiB));
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(4000);
      flow.ack(1 + i);
    }
    expect(flow.stats().visible).toBe(true);
  });

  it('dispose resumes and stops emitting', () => {
    const { flow, chunks, pauses } = setup();
    flow.push(block(600 * KiB));
    flow.dispose();
    expect(pauses).toEqual([true, false]);
    const n = chunks.length;
    flow.push(block(10));
    vi.advanceTimersByTime(100);
    expect(chunks).toHaveLength(n);
  });
});
