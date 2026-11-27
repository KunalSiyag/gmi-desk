// Remote (sandbox) POSIX paths for the Files tab (compute.md §8.3, AB §15.10). Main validates every path again; the
// renderer checks first so a bad name never becomes a request and the user sees why at once.

/** Longest path main accepts (bytes, UTF-8). */
export const REMOTE_PATH_MAX_BYTES = 4096;

const encoder = new TextEncoder();

/**
 * Absolute, POSIX-normalised (`//` and `.` segments collapsed, no trailing slash except the root), no NUL, no `..`
 * segment, at most 4,096 bytes. Null when the path breaks a rule.
 */
export function normalizeRemotePath(path: string): string | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return null;
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    parts.push(segment);
  }
  const out = `/${parts.join('/')}`;
  return encoder.encode(out).byteLength > REMOTE_PATH_MAX_BYTES ? null : out;
}

/** Why a new file or folder name is refused, or null when it is fine. */
export function entryNameError(name: string): string | null {
  if (!name.trim()) return 'Enter a name.';
  if (name !== name.trim()) return 'Names cannot start or end with a space.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  if (name.includes('/')) return 'Names cannot contain “/”.';
  // C0 controls, NUL and DEL: invisible in listings and unsafe in shells.
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Names cannot contain control characters.';
  if (encoder.encode(name).byteLength > 255) return 'Names are at most 255 bytes.';
  return null;
}

/** `dir` + `name` as a normalised absolute path; null when either is invalid. */
export function joinRemote(dir: string, name: string): string | null {
  if (entryNameError(name)) return null;
  const base = normalizeRemotePath(dir);
  if (!base) return null;
  return normalizeRemotePath(base === '/' ? `/${name}` : `${base}/${name}`);
}

/** Parent directory ("/" for the root and its children). */
export function parentOf(path: string): string {
  const norm = normalizeRemotePath(path) ?? '/';
  const i = norm.lastIndexOf('/');
  return i <= 0 ? '/' : norm.slice(0, i);
}

/** Last segment ("/" for the root). */
export function baseName(path: string): string {
  const norm = normalizeRemotePath(path) ?? path;
  if (norm === '/') return '/';
  return norm.slice(norm.lastIndexOf('/') + 1);
}

/** `~` for the home directory and paths below it, for compact display. */
export function displayPath(path: string, home: string | null): string {
  if (home && home !== '/' && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/** True when `path` is `dir` itself or inside it. */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || (dir === '/' ? path.startsWith('/') : path.startsWith(`${dir}/`));
}
