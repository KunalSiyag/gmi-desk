// Port previews (compute.md §8.4, §9.5, §12 T5/T6, §17): the preview manager over `PreviewHost` (core/preview-host.ts).
// C2-C.
//
// - Open: the URL is built in main from GMI's `sandbox_key` / `domain` and the renderer's port and path
//   (`buildPreviewUrl`: the path cannot change the host); the native view is locked to exactly
//   `<port>-<sandbox_key>.<domain>`.
// - Token: only `traffic-access-token`, only for that exact host (the host's injector). `X-Access-Token` (the
//   data-plane token) never reaches a preview. The token lives in main memory only; a refreshed token is pushed with
//   `updateInject` (C2-A calls `accessChanged` after a connect; a cheap periodic `peek` catches the rest).
// - Activity: only input events in the view (`activity`) are reported to the guard as `preview_input`; loads,
//   navigations, HMR and polling traffic never are (§9.5).
// - Blocked navigations, popups and downloads become `blocked` previews the user can open externally (native confirm).
// - Previews close with their session (`closeSession`) and on dispose.
// - Mock mode draws no native view: `createPlaceholderPreviewHost` (the renderer shows a placeholder card, §16).
import { randomBytes } from 'node:crypto';
import { isAllowedExternalUrl } from '@shared/app';
import { GmiError } from '@shared/contracts/errors';
import type { ComputerApi, PreviewBounds, PreviewInfo, PreviewState } from '@shared/contracts/compute';
import {
  buildPreviewUrl,
  isAllowedPreviewNavigation,
  PREVIEW_INJECT_HEADER,
  type PreviewBlockReason,
  type PreviewHost,
  type PreviewHostCreate,
  type PreviewHostEvent,
} from '../../../core/preview-host';
import type { Logger } from '../../../core/logger';
import type { ActivitySink } from '../types';

// ─── Dependencies (provided by the session manager, C2-A) ─────────────────────────────────────────────────────────

/** What the preview manager needs to know about an open computer session. */
export interface PreviewSessionRef {
  sessionId: string;
  resourceId: string;
  /** Previews exist for sandboxes only (CE previews would ride on SSH forwards, C2-E). */
  kind: 'sandbox' | 'container';
  /** The sandbox's `secure` flag: true → a traffic token is required; false → none is sent; null → send if known. */
  secure: boolean | null;
}

/** The part of the data-plane access (`DataPlaneAccess`) a preview needs. SECRET: memory only. */
export interface PreviewAccess {
  sandboxKey: string;
  domain: string;
  /** '' when GMI returned none. */
  trafficToken: string;
}

export interface PreviewManagerDeps {
  host: PreviewHost;
  /** An open (not closed) session, or null. */
  session(sessionId: string): PreviewSessionRef | null;
  /** Current access for the session's sandbox (`TokenCache.get`: cached, refreshed near expiry). */
  access(sessionId: string): Promise<PreviewAccess>;
  /** Cached access without any network call (`TokenCache.peek`); used by the periodic token sync. */
  peekAccess?(sessionId: string): PreviewAccess | null;
  activity: ActivitySink;
  /** Native confirmation (main) and the system browser (https only). */
  platform: {
    confirm(opts: { title: string; message: string; detail?: string; confirmLabel: string; cancelLabel?: string }): Promise<boolean>;
    openExternal(url: string): Promise<void>;
  };
  /** `computer:preview` event to the renderer. */
  emit(info: PreviewInfo): void;
  log: Logger;
  /** Preview ids (tests). Default `pv_` + 8 random bytes hex. */
  newId?: () => string;
  /** Token sync interval (ms); 0 disables the timer. Default 30 s. */
  tokenSyncMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Default 4 per session, 8 in all. */
  maxPerSession?: number;
  maxTotal?: number;
}

export interface PreviewManager {
  open(sessionId: string, port: number, path?: string): Promise<PreviewInfo>;
  setBounds(previewId: string, bounds: PreviewBounds | null): Promise<void>;
  command(previewId: string, command: 'reload' | 'back' | 'forward' | 'stop'): Promise<void>;
  openExternally(previewId: string): Promise<void>;
  close(previewId: string): Promise<void>;
  capture(previewId: string): Promise<string | null>;
  get(previewId: string): PreviewInfo | null;
  list(sessionId?: string): PreviewInfo[];
  /** The session's tokens changed (connect after a 401, resume, extend): re-reads access and updates injectors. */
  accessChanged(sessionId: string): Promise<void>;
  /** The session closed (user close, delete, quit): closes all its previews. */
  closeSession(sessionId: string): void;
  /**
   * The main window's renderer reloaded or crashed: it lost the preview ids and can no longer hide or move the native
   * views, which would stay drawn over the new page. Closes every preview (the manager stays usable).
   */
  closeAll(): void;
  dispose(): void;
}

export const PREVIEW_MAX_PER_SESSION = 4;
export const PREVIEW_MAX_TOTAL = 8;
export const PREVIEW_TOKEN_SYNC_MS = 30_000;
const BOUNDS_MAX = 100_000;
const TITLE_MAX = 200;
const DETAIL_MAX = 300;
const PREVIEW_COMMANDS = new Set(['reload', 'back', 'forward', 'stop']);

type Inject = PreviewHostCreate['inject'];

interface Entry {
  info: PreviewInfo;
  resourceId: string;
  allowedHost: string;
  /** The URL the preview was opened with (external open falls back to it). */
  baseUrl: string;
  secure: boolean | null;
  inject: Inject;
  visible: boolean;
  lastCapture: string | null;
  /** Last blocked top-level target (navigation / popup), offered for external open. */
  blockedUrl: string | null;
  loggedBlocks: Set<string>;
}

const BLOCK_DETAIL: Record<PreviewBlockReason, string> = {
  navigation: 'The page tried to leave the preview address',
  popup: 'The page tried to open a new window',
  download: 'Downloads are blocked in previews; use Files › Download',
  private_network: 'The page tried to reach a private or local address',
  scheme: 'The page used an address type previews do not allow',
};

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}

/** The injector for an access: the traffic token, or null (`secure: false`, or no token on a non-secure sandbox). */
function injectFor(access: PreviewAccess, secure: boolean | null): Inject {
  if (secure === false) return null;
  const token = typeof access.trafficToken === 'string' ? access.trafficToken : '';
  if (!token) {
    if (secure === true) throw new GmiError('unauthorized', 'GMI did not return a preview token for this sandbox. Reconnect and try again.');
    return null;
  }
  return { name: PREVIEW_INJECT_HEADER, value: token };
}

const sameInject = (a: Inject, b: Inject) => (a === null ? b === null : b !== null && a.name === b.name && a.value === b.value);

function checkBounds(bounds: unknown): PreviewBounds | null {
  if (bounds === null) return null;
  if (typeof bounds !== 'object' || bounds === undefined) throw new GmiError('invalid_input', 'Invalid preview bounds.');
  const b = bounds as Record<string, unknown>;
  const vals = [b.x, b.y, b.width, b.height];
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= BOUNDS_MAX)) {
    throw new GmiError('invalid_input', 'Invalid preview bounds.');
  }
  const [x, y, width, height] = vals as number[];
  if (width! < 0 || height! < 0) throw new GmiError('invalid_input', 'Invalid preview bounds.');
  return { x: x!, y: y!, width: width!, height: height! };
}

export function createPreviewManager(deps: PreviewManagerDeps): PreviewManager {
  const { host, log } = deps;
  const newId = deps.newId ?? (() => `pv_${randomBytes(8).toString('hex')}`);
  const maxPerSession = deps.maxPerSession ?? PREVIEW_MAX_PER_SESSION;
  const maxTotal = deps.maxTotal ?? PREVIEW_MAX_TOTAL;
  const entries = new Map<string, Entry>();
  let disposed = false;

  const snapshot = (e: Entry): PreviewInfo => ({ ...e.info });
  const publish = (e: Entry) => {
    try {
      deps.emit(snapshot(e));
    } catch (error) {
      log.warn('preview event failed', { pid: e.info.previewId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const setState = (e: Entry, state: PreviewState, detail: string | null) => {
    if (e.info.state === state && e.info.detail === detail) return;
    e.info.state = state;
    e.info.detail = detail;
    publish(e);
  };

  function onHostEvent(event: PreviewHostEvent): void {
    const e = entries.get(event.id);
    if (!e || e.info.state === 'closed') return;
    switch (event.type) {
      case 'activity':
        // The only preview event that counts as user activity (§9.5).
        deps.activity.record(e.resourceId, { kind: 'preview_input' });
        return;
      case 'state':
        if (event.state === 'loading') {
          e.blockedUrl = null;
          setState(e, 'loading', null);
        } else if (event.state === 'ready') setState(e, 'ready', null);
        else if (event.state === 'failed') setState(e, 'failed', String(event.detail ?? 'The preview could not load.').slice(0, DETAIL_MAX));
        else setState(e, 'failed', 'The preview stopped unexpectedly. Reload to try again.');
        return;
      case 'navigated': {
        const url = isAllowedPreviewNavigation(event.url, e.allowedHost) ? event.url : e.info.url;
        const title = typeof event.title === 'string' && event.title ? event.title.slice(0, TITLE_MAX) : null;
        const changed =
          url !== e.info.url || title !== e.info.title || event.canGoBack !== e.info.canGoBack || event.canGoForward !== e.info.canGoForward;
        e.info.url = url;
        e.info.title = title;
        e.info.canGoBack = Boolean(event.canGoBack);
        e.info.canGoForward = Boolean(event.canGoForward);
        if (changed) publish(e);
        return;
      }
      case 'blocked': {
        const blockedHost = hostOf(event.url);
        const key = `${event.reason}|${blockedHost}`;
        if (!e.loggedBlocks.has(key) && e.loggedBlocks.size < 50) {
          e.loggedBlocks.add(key);
          // Host only: never a full URL with its query (§17).
          log.info('preview.blocked', { pid: e.info.previewId, reason: event.reason, host: blockedHost });
        }
        if (event.reason === 'navigation' || event.reason === 'popup') {
          // Only what main's openExternal accepts (https, no credentials): never offer an open that must fail.
          let target: string | null = null;
          try {
            const u = new URL(event.url);
            if (isAllowedExternalUrl(u.toString())) target = u.toString();
          } catch {
            target = null;
          }
          e.blockedUrl = target;
          const where = blockedHost ? ` (${blockedHost})` : '';
          setState(e, 'blocked', `${BLOCK_DETAIL[event.reason]}${where}.${target ? ' You can open it in your browser.' : ''}`.slice(0, DETAIL_MAX));
        } else if (event.reason === 'download') {
          setState(e, 'blocked', `${BLOCK_DETAIL.download}.`);
        }
        // private_network / scheme: subresource requests the policy cancelled. Logged; the page itself still shows.
        return;
      }
    }
  }
  const unsubscribe = host.onEvent(onHostEvent);

  function requireEntry(previewId: unknown): Entry {
    const e = typeof previewId === 'string' ? entries.get(previewId) : undefined;
    if (!e || e.info.state === 'closed') throw new GmiError('not_found', 'This preview is closed.');
    return e;
  }

  function updateInject(e: Entry, next: Inject): void {
    if (sameInject(e.inject, next)) return;
    host.updateInject(e.info.previewId, next);
    e.inject = next;
  }

  function applyAccess(sessionId: string, access: PreviewAccess): void {
    for (const e of entries.values()) {
      if (e.info.sessionId !== sessionId || e.info.state === 'closed') continue;
      // The sandbox address never changes for a session; a different one means a stale or foreign access.
      const expected = `${e.info.port}-${access.sandboxKey}.${access.domain}`.toLowerCase();
      if (expected !== e.allowedHost) {
        log.warn('preview access does not match the preview host', { pid: e.info.previewId });
        continue;
      }
      let next: Inject;
      try {
        next = injectFor(access, e.secure);
      } catch {
        next = null;
      }
      updateInject(e, next);
    }
  }

  function destroy(e: Entry, emit: boolean): void {
    entries.delete(e.info.previewId);
    try {
      host.destroy(e.info.previewId);
    } catch (error) {
      log.warn('preview destroy failed', { pid: e.info.previewId, error: error instanceof Error ? error.message : String(error) });
    }
    e.inject = null;
    e.lastCapture = null;
    e.info.state = 'closed';
    e.info.detail = null;
    if (emit) publish(e);
  }

  async function syncTokens(): Promise<void> {
    if (!deps.peekAccess) return;
    const sessions = new Set([...entries.values()].map((e) => e.info.sessionId));
    for (const sid of sessions) {
      let access: PreviewAccess | null = null;
      try {
        access = deps.peekAccess(sid);
      } catch {
        access = null;
      }
      if (access) applyAccess(sid, access);
    }
  }

  const syncMs = deps.tokenSyncMs ?? PREVIEW_TOKEN_SYNC_MS;
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let timer: unknown = null;
  const ensureTimer = () => {
    if (timer !== null || syncMs <= 0 || !deps.peekAccess || disposed) return;
    timer = setIntervalFn(() => void syncTokens(), syncMs);
    (timer as { unref?: () => void } | null)?.unref?.();
  };
  const stopTimerIfIdle = () => {
    if (timer !== null && entries.size === 0) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  return {
    async open(sessionId, port, path) {
      if (disposed) throw new GmiError('cancelled', 'GMI Desk is closing.');
      const ref = typeof sessionId === 'string' ? deps.session(sessionId) : null;
      if (!ref) throw new GmiError('not_found', 'This computer is not open.');
      if (ref.kind !== 'sandbox') throw new GmiError('invalid_input', 'Port previews are available for sandboxes only.');
      const access = await deps.access(ref.sessionId);
      // URL and host are built in main; a renderer path or port cannot change the host (§8.4).
      const { url, allowedHost } = buildPreviewUrl({ port, sandboxKey: access.sandboxKey, domain: access.domain, path: path ?? null });
      const inject = injectFor(access, ref.secure);
      // The session may have closed (or the app started closing) while access was fetched.
      if (disposed) throw new GmiError('cancelled', 'GMI Desk is closing.');
      if (!deps.session(ref.sessionId)) throw new GmiError('not_found', 'This computer is not open.');

      for (const e of entries.values()) {
        if (e.info.sessionId === ref.sessionId && e.baseUrl === url && e.info.state !== 'closed') {
          updateInject(e, inject);
          return snapshot(e);
        }
      }
      const open = [...entries.values()];
      if (open.filter((e) => e.info.sessionId === ref.sessionId).length >= maxPerSession || open.length >= maxTotal) {
        throw new GmiError('limit_reached', `At most ${maxPerSession} previews per computer (${maxTotal} in all). Close one first.`);
      }

      const previewId = newId();
      if (entries.has(previewId)) throw new GmiError('internal', 'Preview id collision.');
      const entry: Entry = {
        info: {
          previewId,
          sessionId: ref.sessionId,
          port,
          url,
          title: null,
          state: 'loading',
          detail: null,
          canGoBack: false,
          canGoForward: false,
        },
        resourceId: ref.resourceId,
        allowedHost,
        baseUrl: url,
        secure: ref.secure,
        inject,
        visible: false,
        lastCapture: null,
        blockedUrl: null,
        loggedBlocks: new Set(),
      };
      // Registered before create: the host may emit synchronously.
      entries.set(previewId, entry);
      try {
        host.create({ id: previewId, url, allowedHost, inject });
      } catch (error) {
        entries.delete(previewId);
        stopTimerIfIdle();
        throw error instanceof GmiError ? error : new GmiError('internal', 'The preview could not be created.');
      }
      ensureTimer();
      log.info('preview.open', { pid: previewId, sid: ref.sessionId, port, secure: ref.secure });
      return snapshot(entry);
    },

    async setBounds(previewId, bounds) {
      const rect = checkBounds(bounds);
      const e = typeof previewId === 'string' ? entries.get(previewId) : undefined;
      // Unknown or closed: a late ResizeObserver report after close is harmless.
      if (!e || e.info.state === 'closed') return;
      host.setBounds(previewId, rect);
      e.visible = rect !== null && rect.width > 0 && rect.height > 0;
    },

    async command(previewId, command) {
      if (typeof command !== 'string' || !PREVIEW_COMMANDS.has(command)) throw new GmiError('invalid_input', 'Unknown preview command.');
      const e = requireEntry(previewId);
      if (command === 'reload') {
        // A reload is where an expired token shows: re-read access first (cached unless near expiry).
        try {
          applyAccess(e.info.sessionId, await deps.access(e.info.sessionId));
        } catch (error) {
          log.warn('preview access refresh failed', { pid: e.info.previewId, error: error instanceof GmiError ? error.code : 'error' });
        }
        if (entries.get(e.info.previewId) !== e) throw new GmiError('not_found', 'This preview is closed.');
      }
      host.command(e.info.previewId, command);
    },

    async openExternally(previewId) {
      const e = requireEntry(previewId);
      const blocked = e.info.state === 'blocked' && e.blockedUrl ? e.blockedUrl : null;
      const target = blocked ?? (isAllowedPreviewNavigation(e.info.url, e.allowedHost) ? e.info.url : e.baseUrl);
      const detail = blocked
        ? ['The preview blocked this address. It opens in your browser, outside GMI Desk.']
        : [
            'Your browser opens it without GMI Desk’s preview token.',
            e.inject ? 'This sandbox has secure previews, so your browser will most likely get 401 Unauthorized.' : '',
          ];
      const ok = await deps.platform.confirm({
        title: 'Open in your browser?',
        message: target,
        detail: detail.filter(Boolean).join('\n'),
        confirmLabel: 'Open in browser',
        cancelLabel: 'Cancel',
      });
      if (!ok) throw new GmiError('cancelled', 'Cancelled.');
      await deps.platform.openExternal(target);
    },

    async close(previewId) {
      const e = typeof previewId === 'string' ? entries.get(previewId) : undefined;
      if (!e) return;
      destroy(e, true);
      stopTimerIfIdle();
    },

    async capture(previewId) {
      const e = typeof previewId === 'string' ? entries.get(previewId) : undefined;
      if (!e || e.info.state === 'closed') return null;
      // A hidden view may not paint: hand back the last frame captured while it was visible.
      if (!e.visible) return e.lastCapture;
      const image = await host.capture(e.info.previewId);
      if (entries.get(e.info.previewId) !== e) return null;
      if (image) e.lastCapture = image;
      return image ?? e.lastCapture;
    },

    get(previewId) {
      const e = entries.get(previewId);
      return e ? snapshot(e) : null;
    },

    list(sessionId) {
      return [...entries.values()].filter((e) => sessionId === undefined || e.info.sessionId === sessionId).map(snapshot);
    },

    async accessChanged(sessionId) {
      if (![...entries.values()].some((e) => e.info.sessionId === sessionId)) return;
      applyAccess(sessionId, await deps.access(sessionId));
    },

    closeSession(sessionId) {
      for (const e of [...entries.values()]) if (e.info.sessionId === sessionId) destroy(e, true);
      stopTimerIfIdle();
    },

    closeAll() {
      const n = entries.size;
      for (const e of [...entries.values()]) destroy(e, true);
      stopTimerIfIdle();
      if (n > 0) log.info('preview.closeAll', { count: n });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const e of [...entries.values()]) destroy(e, false);
      if (timer !== null) clearIntervalFn(timer);
      timer = null;
      unsubscribe();
    },
  };
}

/** The `ComputerApi` preview methods over a manager (C2-A's `index.ts` spreads these into the api). */
export function previewApi(
  manager: PreviewManager,
): Pick<ComputerApi, 'openPreview' | 'setPreviewBounds' | 'previewCommand' | 'openPreviewExternally' | 'closePreview' | 'capturePreview'> {
  return {
    openPreview: (sessionId, port, path) => manager.open(sessionId, port, path),
    setPreviewBounds: (previewId, bounds) => manager.setBounds(previewId, bounds),
    previewCommand: (previewId, command) => manager.command(previewId, command),
    openPreviewExternally: (previewId) => manager.openExternally(previewId),
    closePreview: (previewId) => manager.close(previewId),
    capturePreview: (previewId) => manager.capture(previewId),
  };
}

/**
 * Mock mode (§16): no native view and no network. Reports `loading` → `ready` and the URL, so the renderer's
 * placeholder card has a state to show; capture is null (the placeholder is DOM, nothing is covered).
 */
export function createPlaceholderPreviewHost(schedule: (fn: () => void) => void = (fn) => void Promise.resolve().then(fn)): PreviewHost {
  const listeners = new Set<(event: PreviewHostEvent) => void>();
  const live = new Map<string, string>();
  const emit = (event: PreviewHostEvent) => {
    if (!live.has(event.id)) return;
    for (const l of [...listeners]) l(event);
  };
  const load = (id: string) => {
    schedule(() => emit({ id, type: 'state', state: 'loading' }));
    schedule(() => {
      const url = live.get(id);
      if (url === undefined) return;
      emit({ id, type: 'navigated', url, title: null, canGoBack: false, canGoForward: false });
      emit({ id, type: 'state', state: 'ready' });
    });
  };
  return {
    create(opts) {
      if (live.has(opts.id)) throw new GmiError('invalid_input', 'Preview id in use.');
      if (!isAllowedPreviewNavigation(opts.url, opts.allowedHost)) throw new GmiError('invalid_input', 'Preview URL must stay on the preview host.');
      live.set(opts.id, opts.url);
      load(opts.id);
    },
    updateInject: () => undefined,
    setBounds: () => undefined,
    command(id, command) {
      if (command === 'reload' && live.has(id)) load(id);
    },
    capture: async () => null,
    destroy(id) {
      live.delete(id);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      live.clear();
    },
  };
}
