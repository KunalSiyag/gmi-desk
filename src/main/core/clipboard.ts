/**
 * The clipboard operations Connect chat needs (Platform.readClipboardText / clearClipboardIfEquals), over Electron's
 * async clipboard API. Kept apart from src/main/index.ts so tests exercise the real code with a fake clipboard.
 */
import type { Platform } from './context';

/** The part of Electron's `clipboard` used here (Electron 45: async reads; `selection` = Linux PRIMARY). */
export interface ClipboardLike {
  readText(): Promise<string>;
  clear(): void;
  readonly selection?: Pick<ClipboardLike, 'readText' | 'clear'> | null;
}

export function createClipboardOps(
  clipboard: ClipboardLike,
  platform: NodeJS.Platform = process.platform,
): Pick<Platform, 'readClipboardText' | 'clearClipboardIfEquals'> {
  return {
    async readClipboardText() {
      try {
        return (await clipboard.readText()) ?? '';
      } catch {
        return '';
      }
    },

    /**
     * Clears the clipboard only when it still holds `text` (surrounding whitespace ignored). Linux also has the
     * PRIMARY selection (select-to-copy): it is cleared too when it holds the key, but only the main clipboard
     * counts for the result ("We cleared it from your clipboard").
     */
    async clearClipboardIfEquals(text) {
      const target = text.trim();
      if (!target) return false;
      let cleared = false;
      const boards: Array<{ board: Pick<ClipboardLike, 'readText' | 'clear'>; main: boolean }> = [{ board: clipboard, main: true }];
      if (platform === 'linux' && clipboard.selection) boards.push({ board: clipboard.selection, main: false });
      for (const { board, main } of boards) {
        try {
          if (((await board.readText()) ?? '').trim() === target) {
            board.clear();
            cleared = cleared || main;
          }
        } catch {
          // best effort
        }
      }
      return cleared;
    },
  };
}
