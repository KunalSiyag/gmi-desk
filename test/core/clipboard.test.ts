// The Electron clipboard operations behind Connect chat (src/main/core/clipboard.ts), with a fake clipboard and a
// fake Linux PRIMARY selection.
import { describe, expect, it } from 'vitest';
import { createClipboardOps, type ClipboardLike } from '@main/core/clipboard';

const KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLWZvci10ZXN0';

function fakeBoard(text: string, opts: { readThrows?: boolean } = {}) {
  const board = {
    text,
    clears: 0,
    async readText() {
      if (opts.readThrows) throw new Error('no clipboard owner');
      return board.text;
    },
    clear() {
      board.clears += 1;
      board.text = '';
    },
  };
  return board;
}

function fakeClipboard(main: ReturnType<typeof fakeBoard>, selection: ReturnType<typeof fakeBoard> | null): ClipboardLike {
  return { readText: () => main.readText(), clear: () => main.clear(), selection };
}

describe('clipboard ops', () => {
  it('reads the clipboard text, and an unreadable clipboard as empty', async () => {
    await expect(createClipboardOps(fakeClipboard(fakeBoard('hello'), null), 'linux').readClipboardText()).resolves.toBe('hello');
    await expect(createClipboardOps(fakeClipboard(fakeBoard('x', { readThrows: true }), null), 'linux').readClipboardText()).resolves.toBe('');
  });

  it('clears the clipboard only when it still holds the key (surrounding whitespace ignored)', async () => {
    const main = fakeBoard(`\n${KEY}  `);
    await expect(createClipboardOps(fakeClipboard(main, null), 'darwin').clearClipboardIfEquals(KEY)).resolves.toBe(true);
    expect(main.clears).toBe(1);
    expect(main.text).toBe('');

    const other = fakeBoard('something else the user copied');
    await expect(createClipboardOps(fakeClipboard(other, null), 'darwin').clearClipboardIfEquals(KEY)).resolves.toBe(false);
    expect(other.clears).toBe(0);
    expect(other.text).toBe('something else the user copied');
  });

  it('never clears for an empty target', async () => {
    const main = fakeBoard('');
    await expect(createClipboardOps(fakeClipboard(main, null), 'linux').clearClipboardIfEquals('   ')).resolves.toBe(false);
    expect(main.clears).toBe(0);
  });

  it('Linux: also clears the PRIMARY selection when it holds the key, but only the main clipboard counts', async () => {
    const main = fakeBoard('unrelated');
    const primary = fakeBoard(KEY);
    await expect(createClipboardOps(fakeClipboard(main, primary), 'linux').clearClipboardIfEquals(KEY)).resolves.toBe(false);
    expect(primary.clears).toBe(1);
    expect(main.clears).toBe(0);

    const both = fakeBoard(KEY);
    const primary2 = fakeBoard(KEY);
    await expect(createClipboardOps(fakeClipboard(both, primary2), 'linux').clearClipboardIfEquals(KEY)).resolves.toBe(true);
    expect(both.clears).toBe(1);
    expect(primary2.clears).toBe(1);
  });

  it('other platforms leave the selection alone', async () => {
    const main = fakeBoard(KEY);
    const primary = fakeBoard(KEY);
    await expect(createClipboardOps(fakeClipboard(main, primary), 'win32').clearClipboardIfEquals(KEY)).resolves.toBe(true);
    expect(primary.clears).toBe(0);
  });

  it('a selection that cannot be read does not stop the main clipboard from being cleared', async () => {
    const main = fakeBoard(KEY);
    const primary = fakeBoard(KEY, { readThrows: true });
    await expect(createClipboardOps(fakeClipboard(main, primary), 'linux').clearClipboardIfEquals(KEY)).resolves.toBe(true);
    expect(primary.clears).toBe(0);

    const unreadable = fakeBoard(KEY, { readThrows: true });
    await expect(createClipboardOps(fakeClipboard(unreadable, null), 'linux').clearClipboardIfEquals(KEY)).resolves.toBe(false);
  });
});
