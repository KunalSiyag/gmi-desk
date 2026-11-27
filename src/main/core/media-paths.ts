import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export const MEDIA_SCHEME = 'gmi-media';
const MEDIA_HOST = 'local';

/** True when `candidate` is inside `root` (after resolving `..` and symlink-free normalisation). */
export function isInsideDir(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  const rel = relative(r, c);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

/** Absolute file path inside the media dir → `gmi-media://local/<relative path>`; null if outside. */
export function toMediaUrl(mediaDir: string, absPath: string): string | null {
  if (!isInsideDir(mediaDir, absPath)) return null;
  const rel = relative(resolve(mediaDir), resolve(absPath));
  if (!rel) return null;
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${rel.split(sep).map(encodeURIComponent).join('/')}`;
}

/** `gmi-media://local/<relative path>` → absolute path inside the media dir; null when invalid. */
export function fromMediaUrl(mediaDir: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== MEDIA_HOST) return null;
  let segments: string[];
  try {
    segments = parsed.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (segments.length === 0 || segments.some((s) => s === '..' || s === '.' || s.includes('/') || s.includes('\\') || s.includes('\0'))) {
    return null;
  }
  const abs = normalize(join(resolve(mediaDir), ...segments));
  return isInsideDir(mediaDir, abs) ? abs : null;
}

/** Safe file name from untrusted text (job ids, model ids, URL tails). */
export function safeFileName(name: string, fallback = 'file'): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}
