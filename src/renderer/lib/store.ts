import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { PageId } from '@shared/contracts/app';
import type { KeyTarget } from '@shared/contracts/auth';
import { focusedElement } from './focus';

/** Pages that can show the computer dock (compute.md §8.6). */
export const DOCK_PAGES = ['chat', 'code', 'compute'] as const satisfies readonly PageId[];
export type DockPageId = (typeof DOCK_PAGES)[number];

/** The computer dock on one page: open or not, its width (px) and the resource it shows. */
export interface DockState {
  open: boolean;
  width: number;
  resourceId: string | null;
}

export const DOCK_WIDTH = { min: 360, max: 960, default: 480 } as const;

export function isDockPage(page: PageId): page is DockPageId {
  return (DOCK_PAGES as readonly PageId[]).includes(page);
}

function clampDockWidth(width: unknown, fallback: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return fallback;
  return Math.round(Math.min(DOCK_WIDTH.max, Math.max(DOCK_WIDTH.min, width)));
}

const closedDock = (): DockState => ({ open: false, width: DOCK_WIDTH.default, resourceId: null });

interface UiState {
  page: PageId;
  params: Record<string, string>;
  /** Bumped on every navigate() so pages can react to repeated navigation with the same params. */
  navSeq: number;
  paletteOpen: boolean;
  /** Element that had focus when the palette opened; focus returns there when it is dismissed. */
  paletteOpener: HTMLElement | null;
  welcomeDismissed: boolean;
  /** A Connect dialog (components/connect) is open. Mounted once in App. */
  connectOpen: boolean;
  /** Which key the open (or last opened) Connect dialog is about. */
  connectTarget: KeyTarget;
  navigate: (page: PageId, params?: Record<string, string>) => void;
  setParams: (params: Record<string, string>) => void;
  setPaletteOpen: (open: boolean) => void;
  dismissWelcome: () => void;
  /**
   * Opens the Connect dialog from anywhere ("Add API key", "Connect chat", key errors...): `'compute'` for the Compute
   * key, anything else (nothing, or a click event when used directly as an onClick handler) for the inference key.
   */
  openConnect: (target?: KeyTarget | object) => void;
  setConnectOpen: (open: boolean) => void;
  /**
   * How many in-page "Waiting for the browser sign-in" action rows (SignInPendingActions outside the top bar, e.g.
   * RequireAuth's gate) are mounted. While > 0 the top bar does not repeat its own "Open again / Cancel" cluster.
   */
  pendingSignInRows: number;
  /** Counts one mounted in-page pending-sign-in row; returns the function that uncounts it (call from an effect). */
  registerPendingSignInRow: () => () => void;
  /**
   * How many in-page "Sign in" calls to action are mounted (RequireAuth's gate, the Models signed-out banner). While
   * > 0 the top bar does not repeat its own "Sign in" button.
   */
  signInCtas: number;
  /** Counts one mounted in-page sign-in CTA; returns the function that uncounts it (call from a layout effect). */
  registerSignInCta: () => () => void;
  /**
   * How many overlays (dialogs, popovers, menus, the palette) are open. While > 0 native views drawn over the page
   * (the computer's preview WebContentsView) are hidden behind a captured image (compute.md §8.4).
   */
  overlayCount: number;
  /** Counts one open overlay; returns the function that uncounts it (idempotent). */
  pushOverlay: () => () => void;
  /** Uncounts one overlay (prefer the function pushOverlay returned). */
  popOverlay: () => void;
  /** The computer dock, per page that can show it. */
  dock: Record<DockPageId, DockState>;
  /** Updates one page's dock (width clamped to DOCK_WIDTH). */
  setDock: (page: DockPageId, patch: Partial<DockState>) => void;
}

/**
 * `connect=1` in navigation params (any page, e.g. screenshots: `settings?connect=1`) opens the Connect chat dialog
 * (`connect=success` too: in mock mode it previews the success moment); any other navigation (a notification click,
 * "Start chatting") closes it.
 */
export const CONNECT_PARAM = 'connect';

const WELCOME_KEY = 'gmi.welcomeDismissed';

function readWelcomeDismissed(): boolean {
  try {
    return localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return false;
  }
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  params: {},
  navSeq: 0,
  paletteOpen: false,
  paletteOpener: null,
  welcomeDismissed: readWelcomeDismissed(),
  connectOpen: false,
  connectTarget: 'inference',
  navigate: (page, params = {}) =>
    set((s) => {
      const connect = params[CONNECT_PARAM];
      // connect=compute (or compute-success) previews the Connect Compute dialog the same way.
      const compute = connect === 'compute' || connect === 'compute-success';
      return {
        page,
        params,
        navSeq: s.navSeq + 1,
        paletteOpen: false,
        connectOpen: connect === '1' || connect === 'success' || compute,
        connectTarget: compute ? 'compute' : 'inference',
      };
    }),
  setParams: (params) => set({ params }),
  // Opening records the focused element first (the composer, a search box, the sidebar button...).
  setPaletteOpen: (paletteOpen) =>
    set((s) => (paletteOpen && !s.paletteOpen ? { paletteOpen, paletteOpener: focusedElement() } : { paletteOpen })),
  dismissWelcome: () => {
    try {
      localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      // storage may be unavailable
    }
    set({ welcomeDismissed: true });
  },
  openConnect: (target) => set({ connectOpen: true, connectTarget: target === 'compute' ? 'compute' : 'inference', paletteOpen: false }),
  setConnectOpen: (connectOpen) => set({ connectOpen }),
  pendingSignInRows: 0,
  registerPendingSignInRow: () => {
    set((s) => ({ pendingSignInRows: s.pendingSignInRows + 1 }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => ({ pendingSignInRows: Math.max(0, s.pendingSignInRows - 1) }));
    };
  },
  signInCtas: 0,
  registerSignInCta: () => {
    set((s) => ({ signInCtas: s.signInCtas + 1 }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => ({ signInCtas: Math.max(0, s.signInCtas - 1) }));
    };
  },
  overlayCount: 0,
  pushOverlay: () => {
    set((s) => ({ overlayCount: s.overlayCount + 1 }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) }));
    };
  },
  popOverlay: () => set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
  dock: { chat: closedDock(), code: closedDock(), compute: closedDock() },
  setDock: (page, patch) =>
    set((s) => {
      const current = s.dock[page];
      const next: DockState = {
        open: typeof patch.open === 'boolean' ? patch.open : current.open,
        width: patch.width === undefined ? current.width : clampDockWidth(patch.width, current.width),
        resourceId: patch.resourceId === undefined ? current.resourceId : patch.resourceId,
      };
      return { dock: { ...s.dock, [page]: next } };
    }),
}));

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  shortcut?: string;
  keywords?: string[];
  run: () => void | Promise<void>;
}

interface CommandState {
  commands: Map<string, PaletteCommand[]>;
  register: (owner: string, commands: PaletteCommand[]) => () => void;
}

/** Pages register contextual commands for the command palette (⌘/Ctrl+K). */
export const useCommandRegistry = create<CommandState>((set) => ({
  commands: new Map(),
  register: (owner, commands) => {
    set((s) => {
      const next = new Map(s.commands);
      next.set(owner, commands);
      return { commands: next };
    });
    return () =>
      set((s) => {
        const next = new Map(s.commands);
        next.delete(owner);
        return { commands: next };
      });
  },
}));
