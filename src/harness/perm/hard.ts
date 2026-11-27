/**
 * Hard denies (harness.md §8.2.5, §9.1 step 1): not overridable by any rule or mode.
 * - writes to `.git/**` and to the worktree's `.git` file;
 * - reads and writes of secret files (`.env*` except examples, keys, credentials files);
 * - anything under the app's userData, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.factory`, `~/.claude.json`.
 *
 * The same secret-name test picks the worktree files the sandbox masks with `/dev/null` (§8.3).
 */
import { isAbsolute, relative, sep } from 'node:path';

const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.env']);
const ENV_EXAMPLE = /^\.env\.(?:example|sample|template)$/i;

/**
 * True for file names whose contents are secrets (§8.2.5). Always case-insensitive (review H2: `PRIVATE.KEY`,
 * `.ENV` were neither masked nor hard-denied on Linux while the fs tools denied them); the same test as
 * sandbox/paths.ts `isSecretName`. `_caseFold` is kept for callers; it no longer changes anything.
 */
export function isSecretFileName(name: string, _caseFold = true): boolean {
  const n = name.toLowerCase();
  if (SECRET_NAMES.has(n)) return true;
  if (n.startsWith('.env.')) return !ENV_EXAMPLE.test(n);
  if (n.endsWith('.pem') || n.endsWith('.key')) return true;
  if (n.startsWith('id_rsa') || n.startsWith('id_ed25519')) return true;
  return false;
}

export interface HardDenyEnv {
  home: string;
  /** The app's userData (`~/.config/GMI Desk`), never readable by any tool. */
  userData: string | null;
  platform: NodeJS.Platform;
}

function protectedRoots(env: HardDenyEnv): string[] {
  const h = env.home.replace(/[\\/]+$/, '');
  const roots = [`${h}/.ssh`, `${h}/.gnupg`, `${h}/.aws`, `${h}/.config/gh`, `${h}/.factory`, `${h}/.claude.json`];
  if (env.userData) roots.push(env.userData.replace(/[\\/]+$/, ''));
  return roots;
}

function under(path: string, root: string, fold: boolean): boolean {
  const p = fold ? path.toLowerCase() : path;
  const r = fold ? root.toLowerCase() : root;
  if (p === r) return true;
  const rel = relative(r, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Why `path` is hard-denied for this access, or null. `path` is absolute and already policy-resolved (realpath by
 * the tool, §8.2). `worktree` locates the `.git` pointer.
 */
export function hardDenyReason(path: string, access: 'read' | 'write', env: HardDenyEnv, worktree: string | null): string | null {
  const fold = env.platform === 'darwin' || env.platform === 'win32';
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const name = segments[segments.length - 1] ?? '';
  if (isSecretFileName(name, fold)) return 'secret file';
  for (const root of protectedRoots(env)) if (under(path, root, fold)) return 'protected location';
  if (access === 'write') {
    const rel = worktree && under(path, worktree, fold) ? relative(worktree, path).split(sep) : segments;
    if (rel.some((s) => (fold ? s.toLowerCase() : s) === '.git')) return 'git metadata';
  }
  return null;
}
