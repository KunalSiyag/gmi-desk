import { describe, expect, it } from 'vitest';
import { ByteRing, TERMINAL_RING_BYTES } from '@main/services/compute/computer/ring-buffer';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('ByteRing (§8.1: 1 MiB terminal ring)', () => {
  it('defaults to 1 MiB', () => {
    expect(new ByteRing().capacity).toBe(TERMINAL_RING_BYTES);
    expect(TERMINAL_RING_BYTES).toBe(1024 * 1024);
  });

  it('keeps everything below capacity, oldest first', () => {
    const r = new ByteRing(16);
    r.push(bytes('hello '));
    r.push(bytes('world'));
    expect(text(r.snapshot())).toBe('hello world');
    expect(r.size).toBe(11);
    expect(r.dropped).toBe(0);
  });

  it('drops the oldest bytes when it wraps', () => {
    const r = new ByteRing(8);
    r.push(bytes('abcdef'));
    r.push(bytes('ghij'));
    expect(text(r.snapshot())).toBe('cdefghij');
    expect(r.totalWritten).toBe(10);
    expect(r.dropped).toBe(2);
    r.push(bytes('k'));
    expect(text(r.snapshot())).toBe('defghijk');
  });

  it('keeps only the tail of a push larger than the capacity', () => {
    const r = new ByteRing(4);
    r.push(bytes('xy'));
    r.push(bytes('0123456789'));
    expect(text(r.snapshot())).toBe('6789');
    expect(r.size).toBe(4);
  });

  it('wraps exactly at the boundary and survives many pushes', () => {
    const r = new ByteRing(5);
    let all = '';
    for (let i = 0; i < 200; i += 1) {
      const s = String.fromCharCode(97 + (i % 26)).repeat((i % 7) + 1);
      all += s;
      r.push(bytes(s));
      expect(text(r.snapshot())).toBe(all.slice(-5));
    }
  });

  it('snapshot is a copy, empty pushes are ignored, clear empties it', () => {
    const r = new ByteRing(4);
    r.push(bytes('ab'));
    const snap = r.snapshot();
    snap[0] = 0x7a;
    expect(text(r.snapshot())).toBe('ab');
    r.push(new Uint8Array(0));
    expect(r.size).toBe(2);
    r.clear();
    expect(r.size).toBe(0);
    expect(r.snapshot().byteLength).toBe(0);
  });

  it('memory stays bounded with 10 MB pushed', () => {
    const r = new ByteRing();
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    for (let i = 0; i < 160; i += 1) r.push(chunk);
    expect(r.size).toBe(TERMINAL_RING_BYTES);
    expect(r.totalWritten).toBe(160 * 64 * 1024);
  });

  it('rejects a bad capacity', () => {
    expect(() => new ByteRing(0)).toThrow();
    expect(() => new ByteRing(1.5)).toThrow();
  });
});
