// C2-D: the terminal's flow control and visibility reporting (compute.md §8.2) against a fake xterm and a fake port.
// The fake xterm parses asynchronously: write callbacks fire only when the test calls `parse()`, as xterm does after
// its parser has consumed the data.
import { describe, expect, it } from 'vitest';
import { TERMINAL_INPUT_MAX_BYTES, type TerminalChunk } from '@shared/contracts/compute';
import { ACK_EVERY_BYTES, splitUtf8, TerminalController, type TerminalPort, type TerminalSink } from '@renderer/components/computer/terminal-controller';

class FakeTerm implements TerminalSink {
  cols = 80;
  rows = 24;
  written: Array<string> = [];
  resets = 0;
  private callbacks: Array<() => void> = [];
  write(data: Uint8Array | string, callback?: () => void): void {
    this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (callback) this.callbacks.push(callback);
  }
  reset(): void {
    this.resets++;
    this.written.push('<reset>');
  }
  /** xterm finished parsing everything written so far. */
  parse(): void {
    const cbs = this.callbacks;
    this.callbacks = [];
    for (const cb of cbs) cb();
  }
  get screen(): string {
    return this.written.join('');
  }
}

type Call = [string, ...unknown[]];

class FakePort implements TerminalPort {
  calls: Call[] = [];
  replay = 'previous output\r\n';
  seq = 10;
  attachError: unknown = null;
  private gates: Array<() => void> = [];
  /** When true, attaches wait for `release()`. */
  hold = false;
  async terminalAttach(sessionId: string, size: { cols: number; rows: number }) {
    this.calls.push(['attach', sessionId, size]);
    if (this.hold) await new Promise<void>((resolve) => this.gates.push(resolve));
    if (this.attachError) throw this.attachError;
    return { replay: new TextEncoder().encode(this.replay), seq: this.seq };
  }
  release(): void {
    const gates = this.gates;
    this.gates = [];
    for (const g of gates) g();
  }
  async terminalInput(sessionId: string, data: string) {
    this.calls.push(['input', sessionId, data]);
  }
  async terminalResize(sessionId: string, size: { cols: number; rows: number }) {
    this.calls.push(['resize', sessionId, size]);
  }
  async terminalAck(sessionId: string, seq: number) {
    this.calls.push(['ack', sessionId, seq]);
  }
  async terminalVisibility(sessionId: string, visible: boolean) {
    this.calls.push(['visibility', sessionId, visible]);
  }
  of(kind: string): Call[] {
    return this.calls.filter((c) => c[0] === kind);
  }
}

const chunk = (seq: number, text: string, sessionId = 's1'): TerminalChunk => ({ sessionId, seq, data: new TextEncoder().encode(text) });
const bytes = (seq: number, size: number, sessionId = 's1'): TerminalChunk => ({ sessionId, seq, data: new Uint8Array(size).fill(0x61) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(opts: { errors?: Array<[unknown, string]>; attached?: boolean[] } = {}) {
  const term = new FakeTerm();
  const port = new FakePort();
  const ctrl = new TerminalController({
    sessionId: 's1',
    term,
    port,
    onError: (error, op) => opts.errors?.push([error, op]),
    onAttached: (a) => opts.attached?.push(a),
  });
  return { term, port, ctrl };
}

describe('attach and replay', () => {
  it('start(visible) reports visibility first, then attaches with the view size and writes the replay', async () => {
    const attached: boolean[] = [];
    const { term, port, ctrl } = setup({ attached });
    await ctrl.start(true);
    expect(port.calls.map((c) => c[0])).toEqual(['visibility', 'attach']);
    expect(port.of('visibility')[0]).toEqual(['visibility', 's1', true]);
    expect(port.of('attach')[0]).toEqual(['attach', 's1', { cols: 80, rows: 24 }]);
    expect(term.screen).toBe('previous output\r\n');
    expect(term.resets).toBe(0);
    expect(ctrl.attached).toBe(true);
    expect(attached).toEqual([false, true]);
  });

  it('started hidden: reports invisible and attaches only on the first show', async () => {
    const { port, ctrl } = setup();
    await ctrl.start(false);
    expect(port.of('attach')).toHaveLength(0);
    expect(port.of('visibility')).toEqual([['visibility', 's1', false]]);
    await ctrl.setVisible(true);
    expect(port.of('attach')).toHaveLength(1);
  });

  it('chunks that race the attach are kept and written after the replay; those inside the replay are dropped', async () => {
    const { term, port, ctrl } = setup();
    port.hold = true;
    const started = ctrl.start(true);
    await flush();
    expect(ctrl.attaching).toBe(true);
    ctrl.onChunk(chunk(9, 'old-9 '));
    ctrl.onChunk(chunk(10, 'old-10 '));
    ctrl.onChunk(chunk(11, 'new-11 '));
    ctrl.onChunk(chunk(12, 'new-12'));
    expect(term.written).toHaveLength(0);
    port.release();
    await started;
    expect(term.screen).toBe('previous output\r\nnew-11 new-12');
  });

  it('drops duplicates and chunks of other sessions', async () => {
    const { term, ctrl } = setup();
    await ctrl.start(true);
    ctrl.onChunk(chunk(11, 'a'));
    ctrl.onChunk(chunk(11, 'a-again'));
    ctrl.onChunk(chunk(12, 'b', 'other'));
    ctrl.onChunk(chunk(12, 'b'));
    expect(term.screen).toBe('previous output\r\nab');
  });

  it('nothing is written before an attach (main emits nothing to a hidden view anyway)', () => {
    const { term, ctrl } = setup();
    ctrl.onChunk(chunk(11, 'x'));
    expect(term.written).toHaveLength(0);
  });

  it('a failed attach reports the error and leaves the view detached; a later attach works', async () => {
    const errors: Array<[unknown, string]> = [];
    const { port, ctrl } = setup({ errors });
    port.attachError = new Error('409 attached elsewhere');
    await ctrl.start(true);
    expect(errors).toEqual([[port.attachError, 'attach']]);
    expect(ctrl.attached).toBe(false);
    port.attachError = null;
    await ctrl.attach();
    expect(ctrl.attached).toBe(true);
  });
});

describe('ack loop', () => {
  it('acks only after xterm has parsed 64 KiB, with the seq of the last parsed chunk', async () => {
    const { term, port, ctrl } = setup();
    await ctrl.start(true);
    const quarter = ACK_EVERY_BYTES / 4;
    for (let seq = 11; seq <= 14; seq++) ctrl.onChunk(bytes(seq, quarter));
    // Written, not parsed yet: no ack.
    expect(port.of('ack')).toHaveLength(0);
    term.parse();
    expect(port.of('ack')).toEqual([['ack', 's1', 14]]);
  });

  it('acks every 64 KiB, not for every chunk, and never for the replay', async () => {
    const { term, port, ctrl } = setup();
    port.replay = 'x'.repeat(ACK_EVERY_BYTES * 2);
    await ctrl.start(true);
    term.parse();
    expect(port.of('ack')).toHaveLength(0);
    let seq = 10;
    for (let i = 0; i < 20; i++) ctrl.onChunk(bytes(++seq, 16 * 1024));
    term.parse();
    // 20 × 16 KiB = 320 KiB → 5 acks (at seq 14, 18, 22, 26, 30).
    expect(port.of('ack').map((c) => c[2])).toEqual([14, 18, 22, 26, 30]);
  });

  it('a big burst stays bounded: unacked bytes never exceed 64 KiB + one chunk once xterm keeps up', async () => {
    const { term, port, ctrl } = setup();
    await ctrl.start(true);
    let seq = 10;
    let sent = 0;
    let acked = 0;
    for (let i = 0; i < 200; i++) {
      ctrl.onChunk(bytes(++seq, 10_000));
      sent += 10_000;
      term.parse();
      const acks = port.of('ack');
      if (acks.length) acked = (Number(acks.at(-1)![2]) - 10) * 10_000;
      expect(sent - acked).toBeLessThan(ACK_EVERY_BYTES + 10_000);
    }
  });

  it('a re-attach starts the count from zero and ignores parse callbacks of the old generation', async () => {
    const { term, port, ctrl } = setup();
    await ctrl.start(true);
    ctrl.onChunk(bytes(11, ACK_EVERY_BYTES));
    port.seq = 50;
    await ctrl.attach();
    term.parse(); // the old chunk's callback fires late
    expect(port.of('ack')).toHaveLength(0);
    ctrl.onChunk(bytes(51, ACK_EVERY_BYTES));
    term.parse();
    expect(port.of('ack')).toEqual([['ack', 's1', 51]]);
  });
});

describe('visibility', () => {
  it('reports each change once; hiding then showing re-attaches with a reset (main emitted nothing meanwhile)', async () => {
    const { term, port, ctrl } = setup();
    await ctrl.start(true);
    ctrl.onChunk(chunk(11, 'live'));
    await ctrl.setVisible(true); // no change: nothing reported
    await ctrl.setVisible(false);
    await ctrl.setVisible(false);
    port.replay = 'ring after hide';
    port.seq = 40;
    await ctrl.setVisible(true);
    expect(port.of('visibility').map((c) => c[2])).toEqual([true, false, true]);
    expect(port.of('attach')).toHaveLength(2);
    expect(term.resets).toBe(1);
    expect(term.screen.endsWith('<reset>ring after hide')).toBe(true);
    ctrl.onChunk(chunk(40, 'dup'));
    ctrl.onChunk(chunk(41, '!'));
    expect(term.screen.endsWith('ring after hide!')).toBe(true);
  });

  it('hidden while the attach is in flight: the next show attaches again', async () => {
    const { port, ctrl } = setup();
    port.hold = true;
    const started = ctrl.start(true);
    await flush();
    await ctrl.setVisible(false);
    port.release();
    await started;
    port.hold = false;
    await ctrl.setVisible(true);
    expect(port.of('attach')).toHaveLength(2);
  });

  it('dispose reports invisible, stops writing and acking', async () => {
    const { term, port, ctrl } = setup();
    await ctrl.start(true);
    ctrl.onChunk(bytes(11, ACK_EVERY_BYTES));
    ctrl.dispose();
    term.parse();
    ctrl.onChunk(chunk(12, 'late'));
    ctrl.input('ls\r');
    expect(port.of('visibility').at(-1)).toEqual(['visibility', 's1', false]);
    expect(port.of('ack')).toHaveLength(0);
    expect(port.of('input')).toHaveLength(0);
    expect(term.screen).not.toContain('late');
    ctrl.dispose();
    expect(port.of('visibility').filter((c) => c[2] === false)).toHaveLength(1);
  });
});

describe('input and resize', () => {
  it('input is dropped until attached, then sent in order', async () => {
    const { port, ctrl } = setup();
    ctrl.input('early');
    await ctrl.start(true);
    ctrl.input('l');
    ctrl.input('s');
    ctrl.input('\r');
    expect(port.of('input').map((c) => c[2])).toEqual(['l', 's', '\r']);
  });

  it('a large paste is split into ≤ 64 KiB invokes, in order, never cutting a character', async () => {
    const { port, ctrl } = setup();
    await ctrl.start(true);
    const paste = `${'a'.repeat(TERMINAL_INPUT_MAX_BYTES - 1)}😀${'é'.repeat(40_000)}\x1b[201~`;
    ctrl.input(paste);
    const pieces = port.of('input').map((c) => String(c[2]));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(paste);
    for (const p of pieces) expect(new TextEncoder().encode(p).byteLength).toBeLessThanOrEqual(TERMINAL_INPUT_MAX_BYTES);
    // The emoji (4 bytes) did not fit after 65,535 bytes: it starts the second piece.
    expect(pieces[1]!.startsWith('😀')).toBe(true);
  });

  it('resize only while attached and only when the size changed', async () => {
    const { term, port, ctrl } = setup();
    ctrl.resize();
    expect(port.of('resize')).toHaveLength(0);
    await ctrl.start(true);
    ctrl.resize(); // same size as the attach
    expect(port.of('resize')).toHaveLength(0);
    term.cols = 120;
    term.rows = 30;
    ctrl.resize();
    ctrl.resize();
    expect(port.of('resize')).toEqual([['resize', 's1', { cols: 120, rows: 30 }]]);
  });

  it('a resize during the attach is sent once the attach lands', async () => {
    const { term, port, ctrl } = setup();
    port.hold = true;
    const started = ctrl.start(true);
    await flush();
    term.cols = 100;
    ctrl.resize();
    port.release();
    await started;
    expect(port.of('resize')).toEqual([['resize', 's1', { cols: 100, rows: 24 }]]);
  });
});

describe('splitUtf8', () => {
  it('keeps short input whole and empty input empty', () => {
    expect(splitUtf8('ls -la\r')).toEqual(['ls -la\r']);
    expect(splitUtf8('')).toEqual([]);
  });

  it('splits on code points by UTF-8 size', () => {
    expect(splitUtf8('aé😀b', 3)).toEqual(['aé', '😀', 'b']);
    expect(splitUtf8('😀😀', 4)).toEqual(['😀', '😀']);
    expect(splitUtf8('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });
});

describe('review fixes', () => {
  it('drops input while main would refuse it (paused, attached elsewhere); sends it again once allowed', async () => {
    const { port, ctrl } = setup();
    await ctrl.start(true);
    ctrl.setInputAllowed(false);
    ctrl.input('ls\r');
    expect(port.of('input')).toEqual([]);
    ctrl.setInputAllowed(true);
    ctrl.input('ls\r');
    expect(port.of('input')).toEqual([['input', 's1', 'ls\r']]);
  });

  it('isBehind: a visible, attached view whose seq is below the session lastSeq (stale-ack gap) must reattach', async () => {
    const { term, port, ctrl } = setup();
    await ctrl.start(true);
    expect(ctrl.seq).toBe(10);
    expect(ctrl.isBehind(10)).toBe(false);
    ctrl.onChunk(chunk(11, 'x'));
    expect(ctrl.isBehind(11)).toBe(false);
    // Main marked a gap (seq 12) and emitted nothing more: the view is behind.
    expect(ctrl.isBehind(12)).toBe(true);
    port.seq = 12;
    await ctrl.attach();
    expect(ctrl.isBehind(12)).toBe(false);
    expect(term.resets).toBe(1);
    await ctrl.setVisible(false);
    expect(ctrl.isBehind(99)).toBe(false);
  });
});
