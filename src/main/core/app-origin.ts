import { join, normalize, resolve } from 'node:path';
import { isInsideDir } from './media-paths';

/**
 * The renderer is served from `app://gmi-desk/` (a privileged standard scheme handled in the main process),
 * never from file://. A file:// page gets Electron's extra file privileges and its CSP 'self' matches every
 * local file; app:// confines the page to the built renderer folder, and its URL does not depend on the
 * install path (so a '#' or '?' in that path cannot break the IPC sender check).
 */
export const APP_SCHEME = 'app';
export const APP_HOST = 'gmi-desk';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

/**
 * Maps an `app://gmi-desk/<path>` request to a file inside `rootDir` (the built renderer folder).
 * Null for anything else: another scheme or host, credentials, traversal, encoded separators or NUL bytes.
 * `/` maps to index.html; query strings and fragments are ignored.
 */
export function resolveAppFile(rootDir: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST || parsed.username || parsed.password) return null;
  let segments: string[];
  try {
    segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segments.length === 0) segments = ['index.html'];
  const bad = (s: string) => s === '..' || s === '.' || s.includes('/') || s.includes('\\') || s.includes('\0') || s.includes(':');
  if (segments.some(bad)) return null;
  const root = resolve(rootDir);
  const abs = normalize(join(root, ...segments));
  return abs !== root && isInsideDir(root, abs) ? abs : null;
}

/** `http://127.0.0.1:<port>` / `http://localhost:<port>` origin of a dev server URL; null for anything else. */
function loopbackDevOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.username || u.password || !u.port) return null;
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
  return u.origin;
}

/**
 * The Vite dev server URL to load instead of the built renderer, or null.
 * Ignored in packaged builds, and only a loopback http URL with an explicit port is accepted: the page that
 * loads gets the full IPC API, so it must never be a remote origin.
 */
export function resolveDevServerUrl(raw: string | null | undefined, packaged: boolean): string | null {
  const value = raw?.trim();
  if (packaged || !value) return null;
  return loopbackDevOrigin(value) ? value : null;
}

/**
 * True for URLs that belong to the app itself: `app://gmi-desk/...`, and (only when not packaged) the
 * loopback dev server origin. Used for the IPC sender check and for in-window navigation.
 */
export function makeAppUrlCheck(opts: { devServerUrl: string | null; packaged: boolean }): (url: string) => boolean {
  const devOrigin = !opts.packaged && opts.devServerUrl ? loopbackDevOrigin(opts.devServerUrl) : null;
  return (url: string) => {
    if (typeof url !== 'string') return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol === `${APP_SCHEME}:`) return u.host === APP_HOST && !u.username && !u.password;
    return devOrigin !== null && u.origin === devOrigin;
  };
}
