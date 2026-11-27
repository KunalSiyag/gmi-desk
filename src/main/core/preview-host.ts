// Port previews in isolated native views (compute.md §8.4, §12 T5/T6, §13.2 `core/preview-host.ts`). C2-0.
//
// Two halves:
// - The policy, as pure functions (unit-tested without Electron): the preview URL builder, the exact-host navigation
//   lock, the request filter (scheme block, loopback / private / link-local / `.local` / `.internal` block) and the
//   exact-host `traffic-access-token` injection. `X-Access-Token` is never added.
// - The Electron glue (`createElectronPreviewHost`): one `WebContentsView` per preview with its own in-memory
//   partition (`gmi-preview-<random>`, no `persist:`), so the app's `app://` / `gmi-media://` handlers (registered on
//   the default session only) do not exist there; no preload, sandboxed, every permission denied, popups denied,
//   downloads cancelled. Only input events count as activity.
// - DNS rebinding (a public name answering with 127.0.0.1 or a LAN address): the design relied on Chromium's Local
//   Network Access denial, but Electron 45 does not enforce LNA (the smoke test shows a public-address page reaching a
//   loopback server with every permission denied). Main therefore resolves each request's host name through the
//   preview session's resolver and cancels private answers. Residual: a TTL-0 record that changes between that check
//   and Chromium's own lookup.
// Electron is injected (`PreviewElectron`), so this module imports Electron types only.
import { randomBytes } from 'node:crypto';
import type { BrowserWindow, Certificate, Session, WebContents, WebContentsView } from 'electron';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from './logger';

// ─── Interface (compute.md §13.2) ──────────────────────────────────────────────────────────────────────────────────

export interface PreviewHostCreate {
  id: string;
  url: string;
  /** Exact host allowed for top-level navigation. */
  allowedHost: string;
  /** Header added only to requests whose host equals allowedHost. */
  inject: { name: 'traffic-access-token'; value: string } | null;
}

export type PreviewBlockReason = 'navigation' | 'popup' | 'download' | 'private_network' | 'scheme';

export type PreviewHostEvent =
  | { id: string; type: 'state'; state: 'loading' | 'ready' | 'failed' | 'crashed'; detail?: string | null }
  | { id: string; type: 'navigated'; url: string; title: string | null; canGoBack: boolean; canGoForward: boolean }
  | { id: string; type: 'blocked'; url: string; reason: PreviewBlockReason }
  | { id: string; type: 'activity' };

export interface PreviewHostBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewHost {
  /** Throws GmiError('invalid_input') when `url` is not an https URL on exactly `allowedHost`, or the id is in use. */
  create(opts: PreviewHostCreate): void;
  /** Replaces the injected header (token refresh); null stops injecting. */
  updateInject(id: string, inject: PreviewHostCreate['inject']): void;
  /** Window content coordinates (CSS px of the main window); null hides the view. */
  setBounds(id: string, bounds: PreviewHostBounds | null): void;
  command(id: string, command: 'reload' | 'back' | 'forward' | 'stop'): void;
  /** PNG data URL of the view's current frame, or null (unknown id, nothing painted yet). */
  capture(id: string): Promise<string | null>;
  destroy(id: string): void;
  onEvent(listener: (event: PreviewHostEvent) => void): () => void;
  /** Destroys every preview (quit, or the main window closed). Additive to §13.2. */
  dispose(): void;
}

// ─── Policy (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The only header ever injected into preview requests; `X-Access-Token` never is (T6). */
export const PREVIEW_INJECT_HEADER = 'traffic-access-token';
/** Partition prefix of preview sessions. Never `persist:`: in-memory, nothing written to the profile. */
export const PREVIEW_PARTITION_PREFIX = 'gmi-preview-';
export const PREVIEW_PATH_MAX = 2048;

const SANDBOX_KEY = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN = /^(?=.{3,200}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const DNS_LABEL_MAX = 63;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function invalid(message: string): GmiError {
  return new GmiError('invalid_input', message);
}

export function isValidPreviewPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * `{port}-{sandbox_key}.{domain}` (lower case), checked: `sandbox_key` and `domain` come from GMI's create / connect
 * result and are never composed by the app; the first label must stay a valid DNS label.
 */
export function previewHostFor(port: number, sandboxKey: string, domain: string): string {
  if (!isValidPreviewPort(port)) throw invalid('Preview port must be a whole number from 1 to 65535.');
  if (typeof sandboxKey !== 'string' || !SANDBOX_KEY.test(sandboxKey)) throw invalid('Invalid sandbox address.');
  if (typeof domain !== 'string' || !DOMAIN.test(domain)) throw invalid('Invalid sandbox address.');
  const label = `${port}-${sandboxKey}`.toLowerCase();
  if (label.length > DNS_LABEL_MAX) throw invalid('Invalid sandbox address.');
  const host = `${label}.${domain.toLowerCase()}`;
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}/`);
  } catch {
    throw invalid('Invalid sandbox address.');
  }
  if (parsed.host !== host) throw invalid('Invalid sandbox address.');
  return host;
}

/**
 * Checks a renderer-supplied preview path: starts with `/` but not `//`, no backslash (WHATWG URL parsing reads
 * `/\host` as `//host` for https), no control characters or NUL, at most 2,048 characters.
 */
export function checkPreviewPath(path: unknown): string {
  if (path === undefined || path === null || path === '') return '/';
  if (typeof path !== 'string') throw invalid('Preview path must be text.');
  if (path.length > PREVIEW_PATH_MAX) throw invalid('Preview path is too long.');
  if (!path.startsWith('/') || path.startsWith('//')) throw invalid('Preview path must start with a single "/".');
  if (path.includes('\\')) throw invalid('Preview path must not contain "\\".');
  if (CONTROL_CHARS.test(path)) throw invalid('Preview path must not contain control characters.');
  return path;
}

/**
 * Builds a preview URL in main: `new URL(path, 'https://' + allowedHost)`, then requires `url.host === allowedHost`
 * (so a path such as `@evil.example/` or `/\evil.example` can never change the host) and no credentials.
 */
export function buildPreviewUrl(opts: { port: number; sandboxKey: string; domain: string; path?: string | null }): {
  url: string;
  allowedHost: string;
} {
  const allowedHost = previewHostFor(opts.port, opts.sandboxKey, opts.domain);
  const path = checkPreviewPath(opts.path);
  const url = new URL(path, `https://${allowedHost}`);
  if (url.protocol !== 'https:' || url.host !== allowedHost || url.username || url.password) {
    throw invalid('Preview path must stay on the sandbox host.');
  }
  return { url: url.toString(), allowedHost };
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Top-level navigation lock: https only, exactly `allowedHost` (no other port), no credentials in the URL. */
export function isAllowedPreviewNavigation(raw: string, allowedHost: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  return url.protocol === 'https:' && url.host === allowedHost.toLowerCase() && !url.username && !url.password;
}

// IPv4 / IPv6 classification. URL parsing has already normalised `0x7f.1`, `2130706433`, `[::ffff:127.0.0.1]` etc.,
// but the parsers below also accept the raw dotted forms.

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Loopback, private, CGNAT, link-local, "this network", benchmark, multicast, reserved and broadcast ranges. */
export function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this network, RFC 1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/** Eight 16-bit groups, or null when unparseable. Accepts `::` compression and a dotted IPv4 tail. */
function parseIpv6(host: string): number[] | null {
  if (host.includes('%')) return null; // zone ids never appear in URLs we accept
  const lastColon = host.lastIndexOf(':');
  if (lastColon === -1) return null;
  let text = host;
  let tail: number[] = [];
  const last = host.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    // "::ffff:1.2.3.4" → "::ffff", "::1.2.3.4" → "::", "1:2:3:4:5:6:1.2.3.4" → "1:2:3:4:5:6".
    text = host.slice(0, lastColon + 1);
    if (!text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
  }
  if (known !== 8) return null;
  return [...head, ...tail];
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

/** Loopback, unspecified, ULA, link-local, site-local, multicast, and IPv4-embedding forms of private IPv4. */
export function isPrivateIpv6(groups: readonly number[]): boolean {
  const g = groups;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(8)) return true; // ::
  if (zeroUpTo(7) && g[7] === 1) return true; // ::1
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), 64:ff9b::a.b.c.d (NAT64): judge the embedded IPv4.
  if (zeroUpTo(5) && (g[5] === 0xffff || g[5] === 0)) return isPrivateIpv4(v4From(g[6]!, g[7]!));
  if (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateIpv4(v4From(g[6]!, g[7]!));
  if (first === 0x2002) return isPrivateIpv4(v4From(g[1]!, g[2]!)); // 6to4
  return false;
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa'];

/**
 * True for host names a preview must never reach: loopback / private / link-local IPs, `localhost`, `.local`,
 * `.internal` and similar LAN suffixes, single-label names (resolved through the LAN's search domains), and
 * anything unparseable (fail closed). Accepts `URL.hostname` (IPv6 in brackets) or a bare host.
 */
export function isPrivateHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return true;
  if (host.startsWith('[') || host.includes(':')) {
    const groups = parseIpv6(host.replace(/^\[|\]$/g, ''));
    return groups ? isPrivateIpv6(groups) : true;
  }
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);
  if (/^[\d.]+$/.test(host)) return true; // numeric but not a valid dotted quad: never a public name
  if (host === 'localhost' || host === 'local' || host === 'internal') return true;
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (!host.includes('.')) return true;
  return false;
}

/** Schemes a preview may request. `blob:`, `data:` and `about:` never leave the renderer and stay allowed. */
const NETWORK_SCHEMES = new Set(['https:', 'http:', 'wss:', 'ws:']);
const INERT_SCHEMES = new Set(['blob:', 'data:', 'about:']);

export type PreviewRequestDecision = { cancel: false } | { cancel: true; reason: 'scheme' | 'private_network' };

/** `session.webRequest.onBeforeRequest` policy for every request a preview makes (any frame, any resource type). */
export function previewRequestDecision(raw: string): PreviewRequestDecision {
  const url = parseUrl(raw);
  if (!url) return { cancel: true, reason: 'scheme' };
  if (INERT_SCHEMES.has(url.protocol)) return { cancel: false };
  if (!NETWORK_SCHEMES.has(url.protocol)) return { cancel: true, reason: 'scheme' };
  if (isPrivateHostname(url.hostname)) return { cancel: true, reason: 'private_network' };
  return { cancel: false };
}

/**
 * The host name main must resolve before a request goes out (DNS-rebinding check): network schemes with a name
 * host. Null for IP literals (already judged by `previewRequestDecision`) and inert schemes.
 */
export function hostnameToResolve(raw: string): string | null {
  const url = parseUrl(raw);
  if (!url || !NETWORK_SCHEMES.has(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.startsWith('[') || parseIpv4(host)) return null;
  return host;
}

/** A resolved name is usable only when every address is public (one private answer is enough to refuse). */
export function resolvedEndpointsArePublic(addresses: readonly string[]): boolean {
  if (addresses.length === 0) return false;
  return addresses.every((a) => typeof a === 'string' && a.length > 0 && !isPrivateHostname(a));
}

/** True when the token may ride on this request: TLS (https / wss) to exactly `allowedHost`. */
export function shouldInjectPreviewToken(raw: string, allowedHost: string): boolean {
  const url = parseUrl(raw);
  if (!url) return false;
  return (url.protocol === 'https:' || url.protocol === 'wss:') && url.host === allowedHost.toLowerCase();
}

/**
 * `session.webRequest.onBeforeSendHeaders` policy: returns the headers to send. Adds `traffic-access-token` only on
 * the exact preview host (replacing any page-set copy); elsewhere a page-set copy is removed too. Never adds
 * `X-Access-Token`.
 */
export function previewRequestHeaders(
  raw: string,
  headers: Record<string, string>,
  allowedHost: string,
  inject: PreviewHostCreate['inject'],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== PREVIEW_INJECT_HEADER) out[k] = v;
  }
  if (inject && inject.name === PREVIEW_INJECT_HEADER && inject.value && shouldInjectPreviewToken(raw, allowedHost)) {
    out[PREVIEW_INJECT_HEADER] = inject.value;
  }
  return out;
}

/**
 * The renderer reports its slot in CSS pixels (getBoundingClientRect); a WebContentsView is placed in DIP. With the
 * app zoomed (View › Zoom, core/app-menu.ts) they differ by the main page's zoom factor: without this the view would
 * cover the "untrusted content" strip (zoom > 1) or spill over other app UI (zoom < 1).
 */
export function scalePreviewBounds(bounds: PreviewHostBounds, zoom: number): PreviewHostBounds {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (z === 1) return bounds;
  // Edges are scaled, not sizes, so the view never grows past the slot's far edge through rounding.
  const x = Math.round(bounds.x * z);
  const y = Math.round(bounds.y * z);
  return { x, y, width: Math.round((bounds.x + bounds.width) * z) - x, height: Math.round((bounds.y + bounds.height) * z) - y };
}

/** Bounds the renderer may set: finite, rounded, non-negative, clamped to the window's content area. */
export function clampPreviewBounds(
  bounds: PreviewHostBounds,
  content: { width: number; height: number },
): PreviewHostBounds | null {
  const vals = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const x = Math.max(0, Math.min(Math.round(bounds.x), content.width));
  const y = Math.max(0, Math.min(Math.round(bounds.y), content.height));
  const width = Math.max(0, Math.min(Math.round(bounds.width), content.width - x));
  const height = Math.max(0, Math.min(Math.round(bounds.height), content.height - y));
  return { x, y, width, height };
}

// ─── Electron glue ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The Electron pieces the host needs (injected by `slices/computer.ts`; fakes in tests). */
export interface PreviewElectron {
  WebContentsView: typeof WebContentsView;
  session: { fromPartition(partition: string, options?: { cache: boolean }): Session };
}

export interface ElectronPreviewHostOptions {
  electron: PreviewElectron;
  /** The window previews are drawn in; null while there is none (macOS after the last window closed). */
  getWindow: () => BrowserWindow | null;
  /** DevTools for preview views: development only. */
  devTools: boolean;
  log: Logger;
  /** Partition suffix (tests). Default: 16 random bytes, hex. */
  randomId?: () => string;
  /** Minimum gap between two `activity` events of one preview (ms). Default 1,000. */
  activityThrottleMs?: number;
  now?: () => number;
}

interface Entry {
  id: string;
  allowedHost: string;
  inject: PreviewHostCreate['inject'];
  partition: string;
  session: Session;
  view: WebContentsView;
  window: BrowserWindow | null;
  lastActivity: number;
  failed: boolean;
  lastBlocked: { url: string; at: number } | null;
  resolved: Map<string, { at: number; result: Promise<boolean> }>;
}

const RESOLVE_MEMO_MS = 2_000;

/** User-safe host of a URL for blocked-event details (never a query string or token). */
function safeUrlForEvent(raw: string): string {
  const url = parseUrl(raw);
  if (!url) return raw.slice(0, 200);
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') {
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500);
  }
  return `${url.protocol}${url.host ? `//${url.host}` : ''}`.slice(0, 200);
}

export function createElectronPreviewHost(opts: ElectronPreviewHostOptions): PreviewHost {
  const { electron, log } = opts;
  const randomId = opts.randomId ?? (() => randomBytes(16).toString('hex'));
  const throttleMs = opts.activityThrottleMs ?? 1_000;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: PreviewHostEvent) => void>();

  const emit = (event: PreviewHostEvent) => {
    for (const l of [...listeners]) {
      try {
        l(event);
      } catch (error) {
        log.warn('preview event listener failed', { error: String(error) });
      }
    }
  };

  const alive = (wc: WebContents) => !wc.isDestroyed();

  function configureSession(entry: Entry): void {
    const ses = entry.session;
    const cancel = (url: string, reason: 'scheme' | 'private_network', callback: (r: { cancel?: boolean }) => void) => {
      if (entries.get(entry.id) === entry) emit({ id: entry.id, type: 'blocked', url: safeUrlForEvent(url), reason });
      callback({ cancel: true });
    };
    ses.webRequest.onBeforeRequest((details, callback) => {
      const decision = previewRequestDecision(details.url);
      if (decision.cancel) {
        cancel(details.url, decision.reason, callback);
        return;
      }
      const name = hostnameToResolve(details.url);
      if (!name) {
        callback({});
        return;
      }
      // DNS rebinding: a public name that resolves to a private address. Electron 45 does not enforce Chromium's
      // Local Network Access (verified by the smoke test), so main resolves the name through the preview session's
      // own resolver (same cache Chromium connects with) and cancels private answers. Fails closed.
      resolvesPublic(entry, name).then(
        (ok) => (ok ? callback({}) : cancel(details.url, 'private_network', callback)),
        () => cancel(details.url, 'private_network', callback),
      );
    });
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: previewRequestHeaders(details.url, details.requestHeaders, entry.allowedHost, entry.inject) });
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event, item) => {
      event.preventDefault();
      emit({ id: entry.id, type: 'blocked', url: safeUrlForEvent(item.getURL()), reason: 'download' });
    });
  }

  function navigated(entry: Entry): void {
    const wc = entry.view.webContents;
    if (!alive(wc)) return;
    const url = wc.getURL();
    if (!isAllowedPreviewNavigation(url, entry.allowedHost)) return;
    emit({
      id: entry.id,
      type: 'navigated',
      url: safeUrlForEvent(url) + (parseUrl(url)?.search ?? ''),
      title: wc.getTitle().slice(0, 200) || null,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  }

  /** Resolution memo per preview (2 s): a page with hundreds of modules does not resolve once per request. */
  function resolvesPublic(entry: Entry, name: string): Promise<boolean> {
    const hit = entry.resolved.get(name);
    if (hit && now() - hit.at < RESOLVE_MEMO_MS) return hit.result;
    const result = entry.session
      .resolveHost(name, { cacheUsage: 'allowed' })
      .then((r) => resolvedEndpointsArePublic(r.endpoints.map((e) => e.address)));
    entry.resolved.set(name, { at: now(), result });
    if (entry.resolved.size > 256) entry.resolved.delete(entry.resolved.keys().next().value as string);
    return result;
  }

  function blockTopLevel(entry: Entry, url: string): void {
    // will-navigate, did-start-navigation and did-navigate can all see one blocked navigation: report it once.
    const safe = safeUrlForEvent(url);
    const t = now();
    if (entry.lastBlocked && entry.lastBlocked.url === safe && t - entry.lastBlocked.at < 1_000) return;
    entry.lastBlocked = { url: safe, at: t };
    log.info('preview navigation blocked', { id: entry.id, url: safe });
    emit({ id: entry.id, type: 'blocked', url: safe, reason: 'navigation' });
  }

  function wireContents(entry: Entry): void {
    const wc = entry.view.webContents;
    const allowed = (url: string) => isAllowedPreviewNavigation(url, entry.allowedHost);

    wc.setWindowOpenHandler(({ url }) => {
      emit({ id: entry.id, type: 'blocked', url: safeUrlForEvent(url), reason: 'popup' });
      return { action: 'deny' };
    });
    wc.on('will-attach-webview', (event) => event.preventDefault());
    // TLS client certificates: Electron's default (event not prevented) sends the FIRST certificate in the user's
    // store to any host that asks, so a hostile page could make the user identify themselves to a server of its
    // choice. Continue without a certificate, always.
    wc.on('select-client-certificate', (event, _url, _list, callback) => {
      event.preventDefault();
      (callback as (certificate?: Certificate) => void)();
    });
    // HTTP auth prompts: cancelled explicitly, so an app-level 'login' handler added later can never answer them.
    wc.on('login', (event, _details, _authInfo, callback) => {
      event.preventDefault();
      (callback as (username?: string, password?: string) => void)();
    });
    wc.on('will-navigate', (event) => {
      if (allowed(event.url)) return;
      event.preventDefault();
      blockTopLevel(entry, event.url);
    });
    wc.on('will-redirect', (event) => {
      if (!event.isMainFrame || allowed(event.url)) return;
      event.preventDefault();
      blockTopLevel(entry, event.url);
    });
    // Loads started from main (loadURL, reload, history) never fire will-navigate: check them here too.
    // It also fires before will-navigate for page-initiated ones. A synchronous stop() inside this event crashes
    // Electron 45's main process (found by the smoke test), so the stop runs on the next turn.
    wc.on('did-start-navigation', (event) => {
      if (!event.isMainFrame || event.isSameDocument || allowed(event.url) || event.url === 'about:blank') return;
      blockTopLevel(entry, event.url);
      setImmediate(() => {
        if (alive(wc)) wc.stop();
      });
    });
    // Last line: a committed top-level document on any other host is replaced by a blank page.
    wc.on('did-navigate', (_event, url) => {
      if (allowed(url) || url === 'about:blank') {
        navigated(entry);
        return;
      }
      blockTopLevel(entry, url);
      void wc.loadURL('about:blank').catch(() => undefined);
    });
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) navigated(entry);
    });
    wc.on('page-title-updated', () => navigated(entry));
    wc.on('did-start-loading', () => {
      entry.failed = false;
      emit({ id: entry.id, type: 'state', state: 'loading' });
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      // -3 = ERR_ABORTED (a stop, or a navigation we blocked).
      if (!isMainFrame || errorCode === -3) return;
      entry.failed = true;
      emit({ id: entry.id, type: 'state', state: 'failed', detail: String(errorDescription || `Load failed (${errorCode})`).slice(0, 200) });
    });
    wc.on('did-stop-loading', () => {
      if (!entry.failed) emit({ id: entry.id, type: 'state', state: 'ready' });
    });
    wc.on('render-process-gone', (_event, details) => {
      emit({ id: entry.id, type: 'state', state: 'crashed', detail: details.reason });
    });
    // Activity is user input only (§9.5): HMR, polling and other background traffic never count.
    wc.on('before-input-event', () => {
      const t = now();
      if (t - entry.lastActivity < throttleMs) return;
      entry.lastActivity = t;
      emit({ id: entry.id, type: 'activity' });
    });
  }

  function detach(entry: Entry): void {
    const win = entry.window;
    entry.window = null;
    if (!win || win.isDestroyed()) return;
    try {
      win.contentView.removeChildView(entry.view);
    } catch {
      // already removed
    }
  }

  function destroyEntry(entry: Entry): void {
    entries.delete(entry.id);
    detach(entry);
    const ses = entry.session;
    try {
      ses.webRequest.onBeforeRequest(null);
      ses.webRequest.onBeforeSendHeaders(null);
    } catch {
      // session gone
    }
    const wc = entry.view.webContents;
    if (alive(wc)) wc.close();
    // The partition is in memory; drop whatever the page stored while the process lives on.
    void ses.clearStorageData().catch(() => undefined);
    void ses.clearCache().catch(() => undefined);
  }

  return {
    create(create) {
      if (typeof create.id !== 'string' || !create.id || entries.has(create.id)) throw invalid('Invalid or duplicate preview id.');
      const allowedHost = String(create.allowedHost ?? '').toLowerCase();
      if (!allowedHost || !isAllowedPreviewNavigation(create.url, allowedHost)) {
        throw invalid('Preview URL must be https on exactly the sandbox host.');
      }
      if (isPrivateHostname(new URL(create.url).hostname)) throw invalid('Preview host must be public.');
      const partition = `${PREVIEW_PARTITION_PREFIX}${randomId()}`;
      const session = electron.session.fromPartition(partition, { cache: false });
      const view = new electron.WebContentsView({
        webPreferences: {
          session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          devTools: opts.devTools,
          spellcheck: false,
          safeDialogs: true,
          navigateOnDragDrop: false,
          autoplayPolicy: 'user-gesture-required',
        },
      });
      const entry: Entry = {
        id: create.id,
        allowedHost,
        inject: create.inject,
        partition,
        session,
        view,
        window: null,
        lastActivity: Number.NEGATIVE_INFINITY,
        failed: false,
        lastBlocked: null,
        resolved: new Map(),
      };
      entries.set(entry.id, entry);
      configureSession(entry);
      wireContents(entry);
      view.setVisible(false);
      void view.webContents.loadURL(create.url).catch((error: unknown) => {
        // did-fail-load reports the user-facing state; this only keeps the rejection handled.
        log.debug('preview load rejected', { id: entry.id, error: String(error) });
      });
    },

    updateInject(id, inject) {
      const entry = entries.get(id);
      if (entry) entry.inject = inject;
    },

    setBounds(id, bounds) {
      const entry = entries.get(id);
      if (!entry) return;
      if (bounds === null) {
        entry.view.setVisible(false);
        return;
      }
      const win = opts.getWindow();
      if (!win || win.isDestroyed()) {
        detach(entry);
        return;
      }
      if (entry.window !== win) {
        detach(entry);
        win.contentView.addChildView(entry.view);
        entry.window = win;
        // The window took the view with it: the preview is gone (the manager reopens it on demand).
        win.once('closed', () => {
          if (entries.get(entry.id) !== entry || entry.window !== win) return;
          entry.window = null;
          destroyEntry(entry);
          emit({ id: entry.id, type: 'state', state: 'failed', detail: 'The window was closed.' });
        });
      }
      const [width = 0, height = 0] = win.getContentSize();
      let zoom = 1;
      try {
        zoom = win.webContents?.getZoomFactor?.() ?? 1;
      } catch {
        zoom = 1;
      }
      const finite = [bounds.x, bounds.y, bounds.width, bounds.height].every((v) => typeof v === 'number' && Number.isFinite(v));
      const rect = finite ? clampPreviewBounds(scalePreviewBounds(bounds, zoom), { width, height }) : null;
      if (!rect || rect.width === 0 || rect.height === 0) {
        entry.view.setVisible(false);
        return;
      }
      entry.view.setBounds(rect);
      entry.view.setVisible(true);
    },

    command(id, command) {
      const entry = entries.get(id);
      if (!entry) return;
      const wc = entry.view.webContents;
      if (!alive(wc)) return;
      if (command === 'reload') wc.reload();
      else if (command === 'stop') wc.stop();
      else if (command === 'back') {
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      } else if (command === 'forward') {
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      }
    },

    async capture(id) {
      const entry = entries.get(id);
      if (!entry || !alive(entry.view.webContents)) return null;
      try {
        const image = await entry.view.webContents.capturePage();
        return image.isEmpty() ? null : image.toDataURL();
      } catch {
        return null;
      }
    },

    destroy(id) {
      const entry = entries.get(id);
      if (entry) destroyEntry(entry);
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      for (const entry of [...entries.values()]) destroyEntry(entry);
      listeners.clear();
    },
  };
}
