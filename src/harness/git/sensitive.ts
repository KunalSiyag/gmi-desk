/**
 * Execution-sensitive and instruction files (§8.2.6): `.husky/**`, `.git/hooks/**`, the in-repo `core.hooksPath`
 * dir, `.github/workflows/**`, `.envrc`, `.vscode/{settings,tasks,launch}.json`, `package.json#scripts`, `Makefile`,
 * `*.sh` at the repo root, and `AGENTS.md`, `CLAUDE.md`, `.gmi-desk/**`, `.mcp.json`.
 *
 * The host hashes all of them, tracked and ignored (husky's `_/` is gitignored), before and after every sandboxed
 * run; any change raises an `execution_sensitive` notice. `listSensitivePaths` gives the existing ones the sandbox
 * mounts read-only (all except package.json, Makefile and *.sh, which builds legitimately rewrite).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ThreadGitRecord } from '../types';
import { threadOpts, type GitCtx } from './context';

export const SENSITIVE_FILES = ['.envrc', '.vscode/settings.json', '.vscode/tasks.json', '.vscode/launch.json', 'Makefile', 'AGENTS.md', 'CLAUDE.md', '.mcp.json'] as const;
export const SENSITIVE_DIRS = ['.husky', '.github/workflows', '.gmi-desk'] as const;
/** Sensitive, but writable in the sandbox (hashed only). */
const WRITABLE_SENSITIVE = new Set(['Makefile']);

const MAX_FILES = 5000;
const MAX_HASH_BYTES = 32 * 1024 * 1024;

/** Whether a worktree-relative path (forward slashes) is execution-sensitive or an instruction file. */
export function isSensitivePath(rel: string, hooksPath: string | null = null): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (hooksPath) {
    const hp = hooksPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (hp && (p === hp || p.startsWith(`${hp}/`))) return true;
  }
  if ((SENSITIVE_FILES as readonly string[]).includes(p)) return true;
  if (SENSITIVE_DIRS.some((d) => p === d || p.startsWith(`${d}/`))) return true;
  if (p.startsWith('.git/hooks/')) return true;
  if (!p.includes('/') && p.endsWith('.sh')) return true;
  return false;
}

/** Whether the `scripts` of two package.json texts differ (unparsable counts as changed). */
export function scriptsChanged(before: string | null, after: string | null): boolean {
  return scriptsKey(before) !== scriptsKey(after);
}

function scriptsKey(text: string | null): string {
  if (text === null) return 'absent';
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    return canonical(parsed?.scripts ?? null);
  } catch {
    return `unparsable:${createHash('sha256').update(text).digest('hex')}`;
  }
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

async function hashFile(abs: string): Promise<string | null> {
  let s;
  try {
    s = await lstat(abs);
  } catch {
    return null;
  }
  if (s.isSymbolicLink()) return `link:${createHash('sha256').update(await readlink(abs).catch(() => '')).digest('hex')}`;
  if (!s.isFile()) return `type:${s.mode.toString(8)}`;
  if (s.size > MAX_HASH_BYTES) return `big:${s.size}:${s.mtimeMs}:${s.mode.toString(8)}`;
  return new Promise((resolveHash) => {
    const h = createHash('sha256');
    h.update(`mode:${(s.mode & 0o111) !== 0 ? 'x' : '-'}\0`);
    createReadStream(abs)
      .on('data', (c) => h.update(c))
      .on('error', () => resolveHash(`unreadable:${s.size}`))
      .on('end', () => resolveHash(h.digest('hex')));
  });
}

/** Regular files and symlinks under `dir` (symlinked dirs not followed), relative to `base`. */
async function walk(dir: string, base: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await walk(abs, base, out);
    else out.push(relative(base, abs).split(sep).join('/'));
  }
}

/** The in-repo `core.hooksPath` dir (relative to the worktree), when the repo config sets one inside the worktree. */
export async function hooksPathDir(ctx: GitCtx, r: ThreadGitRecord): Promise<string | null> {
  try {
    const res = await ctx.exec.raw(threadOpts(r, ['config', '--local', '--get', 'core.hooksPath'], { okCodes: [0, 1] }));
    const v = res.stdout.toString('utf8').trim();
    if (res.code !== 0 || !v) return null;
    const abs = isAbsolute(v) ? v : resolve(r.worktreePath, v);
    const rel = relative(r.worktreePath, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel.split(sep).join('/');
  } catch {
    return null;
  }
}

/**
 * sha256 of every execution-sensitive and instruction path (tracked and ignored). Fixed top-level files are always
 * present as keys (null = absent); files under the sensitive dirs appear while they exist. `package.json#scripts`
 * hashes only the scripts field. Hooks of the common dir appear as `.git/hooks/<name>`.
 */
export async function sensitiveHashes(ctx: GitCtx, r: ThreadGitRecord): Promise<Record<string, string | null>> {
  const wt = r.worktreePath;
  const out: Record<string, string | null> = {};
  for (const f of SENSITIVE_FILES) out[f] = await hashFile(join(wt, f));
  try {
    const text = await readFile(join(wt, 'package.json'), 'utf8');
    out['package.json#scripts'] = createHash('sha256').update(scriptsKey(text)).digest('hex');
  } catch {
    out['package.json#scripts'] = null;
  }
  try {
    for (const e of await readdir(wt, { withFileTypes: true })) {
      if (e.name.endsWith('.sh') && !e.isDirectory()) out[e.name] = await hashFile(join(wt, e.name));
    }
  } catch {
    /* worktree unreadable: the verify step reports it */
  }
  const dirs: string[] = [...SENSITIVE_DIRS];
  const hp = await hooksPathDir(ctx, r);
  if (hp && !dirs.includes(hp)) dirs.push(hp);
  const files: string[] = [];
  for (const d of dirs) await walk(join(wt, d), wt, files);
  for (const rel of files) out[rel] = await hashFile(join(wt, rel));
  const hooks: string[] = [];
  await walk(join(r.commonDir, 'hooks'), join(r.commonDir, 'hooks'), hooks);
  for (const rel of hooks) out[`.git/hooks/${rel}`] = await hashFile(join(r.commonDir, 'hooks', rel));
  return out;
}

/** Keys whose hash differs between two `sensitiveHashes` results (added, removed or changed). */
export function changedSensitive(before: Record<string, string | null>, after: Record<string, string | null>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => (before[k] ?? null) !== (after[k] ?? null)).sort();
}

/** Existing sensitive paths (absolute) the sandbox mounts read-only (§8.2.6): not package.json, Makefile or *.sh. */
export async function listSensitivePaths(ctx: GitCtx, r: ThreadGitRecord): Promise<string[]> {
  const wt = r.worktreePath;
  const candidates: string[] = [...SENSITIVE_FILES.filter((f) => !WRITABLE_SENSITIVE.has(f)), ...SENSITIVE_DIRS];
  const hp = await hooksPathDir(ctx, r);
  if (hp) candidates.push(hp);
  const found: string[] = [];
  for (const c of candidates) {
    try {
      const s = await lstat(join(wt, c));
      if (s.isFile() || s.isDirectory()) found.push(join(wt, c));
    } catch {
      /* absent */
    }
  }
  return found;
}
