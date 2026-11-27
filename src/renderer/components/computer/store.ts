// The dock's own UI state (compute.md §8.6): the tab per resource, open previews, transfers, the Files selection.
// Width, open/closed and the resource per page live in lib/store (`useUi().dock`).
import { useSyncExternalStore } from 'react';
import { create, type StoreApi } from 'zustand';
import type { PreviewInfo, TransferInfo } from '@shared/contracts/compute';

/** `preview:<previewId>` for a preview tab. */
export type DockTab = 'terminal' | 'files' | 'ports' | 'logs' | `preview:${string}`;

export const previewTab = (previewId: string): DockTab => `preview:${previewId}`;
export const previewIdOf = (tab: DockTab): string | null => (tab.startsWith('preview:') ? tab.slice('preview:'.length) : null);

/** Finished transfers kept in the list. */
export const TRANSFERS_KEPT = 20;

interface ComputerUiState {
  tabs: Record<string, DockTab>;
  setTab: (resourceId: string, tab: DockTab) => void;
  previews: Record<string, PreviewInfo>;
  upsertPreview: (preview: PreviewInfo) => void;
  /**
   * An `openPreview` result: added only when not known yet. Its `computer:preview` events can arrive before the invoke
   * resolves, and the (older) result must not overwrite them (it would stay "loading").
   */
  addPreview: (preview: PreviewInfo) => void;
  removePreview: (previewId: string) => void;
  /** Transfers in arrival order (the newest last). */
  transfers: TransferInfo[];
  upsertTransfer: (transfer: TransferInfo) => void;
  clearFinishedTransfers: (sessionId: string) => void;
  /** Files tab: the selected entry per session (a file opens the preview, a directory is the upload target). */
  selected: Record<string, { path: string; type: 'file' | 'dir' }>;
  select: (sessionId: string, entry: { path: string; type: 'file' | 'dir' } | null) => void;
  /** Expanded directories per session. */
  expanded: Record<string, string[]>;
  toggleExpanded: (sessionId: string, path: string, open?: boolean) => void;
  /** A tab asked for through navigation params (`computer=<tab>`), applied once the dock shows a resource. */
  requestedTab: 'terminal' | 'files' | 'ports' | 'logs' | 'preview' | null;
  /** With `computer=preview`: `computerPort=<n>` opens a preview of that port when none is open (deep links, screenshots). */
  requestedPort: number | null;
  /** The narrow-window sheet is moving: native preview views stay hidden meanwhile (§8.6). */
  sheetMoving: boolean;
  setSheetMoving: (moving: boolean) => void;
  /**
   * The next sheet opens without its slide-in: it was opened from the keyboard (⌘/Ctrl+J, or Enter/Space on the
   * top-bar button). Read once when the sheet mounts, then reset, so a later pointer open slides again.
   */
  sheetInstant: boolean;
  setSheetInstant: (instant: boolean) => void;
}

const finished = (t: TransferInfo) => t.state === 'done' || t.state === 'failed' || t.state === 'cancelled';

export const useComputerUi = create<ComputerUiState>((set) => ({
  tabs: {},
  setTab: (resourceId, tab) => set((s) => ({ tabs: { ...s.tabs, [resourceId]: tab } })),
  previews: {},
  addPreview: (preview) =>
    set((s) => (s.previews[preview.previewId] || preview.state === 'closed' ? s : { previews: { ...s.previews, [preview.previewId]: preview } })),
  upsertPreview: (preview) =>
    set((s) => {
      if (preview.state === 'closed') {
        if (!s.previews[preview.previewId]) return s;
        const { [preview.previewId]: _gone, ...rest } = s.previews;
        return { previews: rest };
      }
      return { previews: { ...s.previews, [preview.previewId]: preview } };
    }),
  removePreview: (previewId) =>
    set((s) => {
      const { [previewId]: _gone, ...rest } = s.previews;
      return { previews: rest };
    }),
  transfers: [],
  upsertTransfer: (transfer) =>
    set((s) => {
      const i = s.transfers.findIndex((t) => t.transferId === transfer.transferId);
      const next = i === -1 ? [...s.transfers, transfer] : s.transfers.map((t, j) => (j === i ? transfer : t));
      // Keep every active transfer and only the most recent finished ones.
      const done = next.filter(finished);
      const drop = new Set(done.slice(0, Math.max(0, done.length - TRANSFERS_KEPT)).map((t) => t.transferId));
      return { transfers: drop.size ? next.filter((t) => !drop.has(t.transferId)) : next };
    }),
  clearFinishedTransfers: (sessionId) => set((s) => ({ transfers: s.transfers.filter((t) => t.sessionId !== sessionId || !finished(t)) })),
  selected: {},
  select: (sessionId, entry) =>
    set((s) => {
      if (entry) return { selected: { ...s.selected, [sessionId]: entry } };
      const { [sessionId]: _gone, ...rest } = s.selected;
      return { selected: rest };
    }),
  expanded: {},
  toggleExpanded: (sessionId, path, open) =>
    set((s) => {
      const current = s.expanded[sessionId] ?? [];
      const isOpen = current.includes(path);
      const want = open ?? !isOpen;
      if (want === isOpen) return s;
      return { expanded: { ...s.expanded, [sessionId]: want ? [...current, path] : current.filter((p) => p !== path) } };
    }),
  requestedTab: null,
  requestedPort: null,
  sheetMoving: false,
  setSheetMoving: (sheetMoving) => set({ sheetMoving }),
  sheetInstant: false,
  setSheetInstant: (sheetInstant) => set({ sheetInstant }),
}));

/**
 * Reads a zustand store like its hook, but with the current state as the server snapshot too, so react-dom/server
 * markup tests render the state they set (zustand's own hook renders the initial state there).
 */
export function useStoreNow<T, U>(store: Pick<StoreApi<T>, 'subscribe' | 'getState'>, selector: (state: T) => U): U {
  const read = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, read, read);
}
