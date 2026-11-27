/**
 * Path policy for every file tool and every apply_patch target (harness.md §8.2, threat H-T4).
 *
 *   1. reject NUL, a leading `~`, URLs;
 *   2. resolve relative to the worktree root (`path.resolve`);
 *   3. realpath of the deepest existing ancestor + the remaining segments must be inside realpath(worktree) (or a
 *      read-only extra root) — a prefix check with the separator, case-folded on darwin and win32. Dangling symlinks
 *      are refused (their target is unknown);
 *   4. writes: the final component is opened with O_NOFOLLOW, data goes to `<dir>/.gmid-tmp-<rand>` and is renamed
 *      into place; a regular file with nlink > 1 needs approval (risk `outside_worktree`: a hard link may point
 *      outside);
 *   5. hard denies (no rule or mode overrides them): writes to `.git/**` and the `.git` pointer file; reads and
 *      writes of secret files; anything under the app's userData, ~/.ssh, ~/.gnupg, ~/.aws, ~/.config/gh,
 *      ~/.factory, ~/.claude.json;
 *   6. execution-sensitive and instruction files are flagged (`execution_sensitive`): fs edits always ask.
 *
 * The checks are synchronous (a tool's `subject()` is synchronous); the IO helpers re-verify at use time (an
 * opened file's real path is read back from /proc/self/fd on Linux) so a swap after the check is caught. The
 * permission engine (H2-E) calls `hardDenyReason` on a subject's paths for its step 1 (§9.1).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PathOp = 'read' | 'write';

export interface PathPolicyOptions {
  /** The thread's worktree (or the project root for `root` threads). Must exist. */
  worktree: string;
  /** Read-only roots besides the worktree (never writable). */
  extraReadRoots?: readonly string[];
  /** The app's userData: everything under it is denied (spill files are read through `spill:<id>`, §8.7). */
  userDataDir?: string | null;
  /** Defaults to os.homedir(). */
  home?: string;
  /** Defaults to process.platform (case folding on darwin and win32). */
  platform?: NodeJS.Platform;
  /** The in-repo `core.hooksPath` directory, relative to the worktree (execution-sensitive, §8.2.6). */
  hooksPath?: string | null;
}

export type PathDenyCode = 'invalid' | 'outside' | 'secret' | 'git_metadata' | 'protected' | 'symlink';

/** `always`: an execution-sensitive or instruction file. `package_json`: sensitive only when `scripts` changes. */
export type Sensitivity = 'always' | 'package_json' | null;

export interface ResolvedPath {
  input: string;
  /** Lexical absolute path (`path.resolve(worktree, input)`). */
  abs: string;
  /** realpath of the deepest existing ancestor + the remaining segments. All IO uses this path. */
  real: string;
  /** Relative to realpath(worktree) with `/` separators ('' = the root); for an extra root, relative to it. */
  rel: string;
  root: 'worktree' | 'extra';
  /** The realpath of that root. */
  rootReal: string;
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  nlink: number;
  sensitivity: Sensitivity;
}

export type PathCheck = { ok: true; path: ResolvedPath } | { ok: false; code: PathDenyCode; reason: string; abs: string | null };

export class PathPolicyError extends Error {
  readonly code: PathDenyCode;
  constructor(code: PathDenyCode, message: string) {
    super(message);
    this.name = 'PathPolicyError';
    this.code = code;
  }
}

// ─── Lists ────────────────────────────────────────────────────────────────────────────────────────────────────

/** §8.2.5 secret files (reads and writes), matched on the final component, case-insensitively. As rg globs: */
export const SECRET_FILE_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
  '**/.pypirc',
  '**/.git-credentials',
] as const;

const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/;

/** True for a secret file name (§8.2.5). `.env.example|.sample|.template` are allowed. */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase();
  if (n === '.env') return true;
  if (n.startsWith('.env.')) return !ENV_TEMPLATE.test(n);
  if (n.endsWith('.pem') || n.endsWith('.key')) return true;
  if (n.startsWith('id_rsa') || n.startsWith('id_ed25519')) return true;
  return n === '.npmrc' || n === '.netrc' || n === '.pypirc' || n === '.git-credentials';
}

/** Home-relative paths that are always denied (ground rule 3). */
export const PROTECTED_HOME_PATHS = ['.ssh', '.gnupg', '.aws', '.config/gh', '.factory', '.claude.json'] as const;

/**
 * §8.2.6 execution-sensitive and instruction paths, relative to the worktree, as globs (for H2-E's read-only binds
 * and H2-G's hashes). The fs tools are stricter: AGENTS.md, CLAUDE.md, Makefile, .envrc and .vscode files are
 * flagged at any depth.
 */
export const EXECUTION_SENSITIVE_GLOBS = [
  '.husky/**',
  '.git/hooks/**',
  '.github/workflows/**',
  '.envrc',
  '.vscode/settings.json',
  '.vscode/tasks.json',
  '.vscode/launch.json',
  'package.json',
  'Makefile',
  '*.sh',
  'AGENTS.md',
  'CLAUDE.md',
  '.gmi-desk/**',
  '.mcp.json',
] as const;

/** Classifies a worktree-relative path (`/` separators). Case-insensitive (more denial is the safe side). */
export function sensitivityOf(rel: string, hooksPath?: string | null): Sensitivity {
  if (!rel) return null;
  const segs = rel.toLowerCase().split('/').filter(Boolean);
  const name = segs[segs.length - 1] ?? '';
  const first = segs[0] ?? '';
  if (hooksPath) {
    const hp = hooksPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
    if (hp && !hp.startsWith('/') && !hp.split('/').includes('..') && (rel.toLowerCase() === hp || rel.toLowerCase().startsWith(`${hp}/`))) return 'always';
  }
  if (first === '.husky' || first === '.gmi-desk') return 'always';
  if (first === '.git' && segs[1] === 'hooks') return 'always';
  if (first === '.github' && segs[1] === 'workflows' && segs.length > 2) return 'always';
  if (name === '.envrc' || name === 'agents.md' || name === 'claude.md' || name === '.mcp.json') return 'always';
  if (name === 'makefile' || name === 'gnumakefile') return 'always';
  if (segs.length >= 2 && segs[segs.length - 2] === '.vscode' && (name === 'settings.json' || name === 'tasks.json' || name === 'launch.json')) return 'always';
  if (segs.length === 1 && name.endsWith('.sh')) return 'always';
  if (name === 'package.json') return 'package_json';
  return null;
}

/** package.json is execution-sensitive when its `scripts` change (or either side cannot be parsed). */
export function packageScriptsChanged(before: string | null, after: string | null): boolean {
  const scripts = (text: string | null): string | null | undefined => {
    if (text === null) return null;
    try {
      const v = JSON.parse(text) as unknown;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
      const s = (v as Record<string, unknown>).scripts;
      return s === undefined ? null : JSON.stringify(s);
    } catch {
      return undefined;
    }
  };
  const a = scripts(before);
  const b = scripts(after);
  if (a === undefined || b === undefined) return true;
  return a !== b;
}

// ─── Containment ──────────────────────────────────────────────────────────────────────────────────────────────

function fold(p: string, platform: NodeJS.Platform): string {
  return platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p;
}

/** `p` equals `root` or is below it (separator prefix check; case-folded on darwin and win32). */
export function isInside(root: string, p: string, platform: NodeJS.Platform = process.platform): boolean {
  const sep = platform === 'win32' ? '\\' : '/';
  const r = fold(root, platform);
  const q = fold(p, platform);
  if (q === r) return true;
  const prefix = r.endsWith(sep) || r.endsWith('/') ? r : r + sep;
  return q.startsWith(prefix);
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Step 1 of §8.2. Returns a reason or null. */
export function rejectInput(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return 'A path is required.';
  if (input.length > 4096) return 'The path is too long.';
  if (input.includes('\0')) return 'The path contains a NUL byte.';
  if (input.startsWith('~')) return 'Paths starting with ~ are not accepted; use a path relative to the worktree.';
  if (URL_RE.test(input) || /^file:/i.test(input)) return 'URLs are not file paths.';
  return null;
}

interface DeepReal {
  real: string;
  exists: boolean;
}

/** realpath of the deepest existing ancestor + the remaining segments. Throws PathPolicyError on a dangling link. */
function realpathDeep(abs: string): DeepReal {
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const r = fs.realpathSync.native(cur);
      return { real: rest.length ? path.join(r, ...rest) : r, exists: rest.length === 0 };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // An entry that exists (lstat) but cannot be resolved is a dangling or looping symlink: its target is unknown.
        let entryExists = false;
        try {
          fs.lstatSync(cur);
          entryExists = true;
        } catch {
          entryExists = false;
        }
        if (entryExists && code === 'ENOENT') throw new PathPolicyError('symlink', 'The path goes through a symbolic link whose target does not exist.');
        if (entryExists && code === 'ENOTDIR') throw new PathPolicyError('invalid', 'A component of the path is not a directory.');
        const parent = path.dirname(cur);
        if (parent === cur) throw new PathPolicyError('invalid', 'The path cannot be resolved.');
        rest.unshift(path.basename(cur));
        cur = parent;
        continue;
      }
      if (code === 'ELOOP') throw new PathPolicyError('symlink', 'The path has a symbolic link loop.');
      throw new PathPolicyError('invalid', `The path cannot be resolved (${code ?? 'error'}).`);
    }
  }
}

function safeReal(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function protectedRoots(opts: PathPolicyOptions): string[] {
  const home = opts.home ?? os.homedir();
  const out: string[] = [];
  const add = (p: string) => {
    out.push(path.resolve(p));
    const r = safeReal(p);
    if (r !== path.resolve(p)) out.push(r);
  };
  if (opts.userDataDir) add(opts.userDataDir);
  for (const rel of PROTECTED_HOME_PATHS) add(path.join(home, rel));
  return out;
}

/**
 * §8.2.5 hard deny for an absolute path (lexical or real). Used by the tools and by the permission engine's step 1.
 * `worktree` is needed for the `.git` write rule.
 */
export function hardDenyReason(absPath: string, op: PathOp, opts: PathPolicyOptions): { code: PathDenyCode; reason: string } | null {
  const platform = opts.platform ?? process.platform;
  const candidates = new Set([path.resolve(absPath)]);
  try {
    candidates.add(realpathDeep(path.resolve(absPath)).real);
  } catch {
    // Unresolvable: judged on the lexical path only.
  }
  for (const p of candidates) {
    if (isSecretName(path.basename(p))) return { code: 'secret', reason: 'Secret files (.env, keys, credentials) are never read or written by the agent.' };
    for (const root of protectedRoots(opts)) {
      if (isInside(root, p, platform)) return { code: 'protected', reason: 'This location holds credentials or app data and is never accessible to the agent.' };
    }
  }
  if (op === 'write') {
    const wtLex = path.resolve(opts.worktree);
    const wtReal = safeReal(opts.worktree);
    for (const p of candidates) {
      for (const root of [wtLex, wtReal]) {
        if (!isInside(root, p, platform)) continue;
        // Case-insensitive on every platform: `.GIT` is not metadata on Linux, but refusing it is the safe side.
        const segs = toPosix(path.relative(root, p)).toLowerCase().split('/');
        if (segs.includes('.git')) return { code: 'git_metadata', reason: 'Git metadata (.git) is never written by the file tools.' };
      }
    }
  }
  return null;
}

/** Steps 1–3, 5 and the classification of 4 and 6. Never throws. */
export function checkPath(input: string, op: PathOp, opts: PathPolicyOptions): PathCheck {
  const bad = rejectInput(input);
  if (bad) return { ok: false, code: 'invalid', reason: bad, abs: null };
  const platform = opts.platform ?? process.platform;
  let wtReal: string;
  try {
    wtReal = fs.realpathSync.native(opts.worktree);
  } catch {
    return { ok: false, code: 'invalid', reason: 'The worktree does not exist.', abs: null };
  }
  const abs = path.resolve(opts.worktree, input);
  let deep: DeepReal;
  try {
    deep = realpathDeep(abs);
  } catch (err) {
    if (err instanceof PathPolicyError) return { ok: false, code: err.code, reason: err.message, abs };
    return { ok: false, code: 'invalid', reason: 'The path cannot be resolved.', abs };
  }
  let root: ResolvedPath['root'];
  let rootReal: string;
  if (isInside(wtReal, deep.real, platform)) {
    root = 'worktree';
    rootReal = wtReal;
  } else {
    const extra = (opts.extraReadRoots ?? []).map(safeReal).find((r) => isInside(r, deep.real, platform));
    if (!extra) return { ok: false, code: 'outside', reason: 'The path is outside the worktree.', abs };
    if (op === 'write') return { ok: false, code: 'outside', reason: 'This location is read-only.', abs };
    root = 'extra';
    rootReal = extra;
  }
  const deny = hardDenyReason(abs, op, opts) ?? hardDenyReason(deep.real, op, opts);
  if (deny) return { ok: false, ...deny, abs };

  let isDirectory = false;
  let isFile = false;
  let nlink = 0;
  if (deep.exists) {
    try {
      const st = fs.statSync(deep.real);
      isDirectory = st.isDirectory();
      isFile = st.isFile();
      nlink = st.nlink;
    } catch {
      return { ok: false, code: 'invalid', reason: 'The path cannot be read.', abs };
    }
  }
  const rel = toPosix(path.relative(rootReal, deep.real));
  let sensitivity: Sensitivity = null;
  if (root === 'worktree') {
    const lexRel = isInside(path.resolve(opts.worktree), abs, platform) ? toPosix(path.relative(path.resolve(opts.worktree), abs)) : null;
    const a = sensitivityOf(rel, opts.hooksPath);
    const b = lexRel === null ? null : sensitivityOf(lexRel, opts.hooksPath);
    sensitivity = a === 'always' || b === 'always' ? 'always' : (a ?? b);
  }
  return { ok: true, path: { input, abs, real: deep.real, rel, root, rootReal, exists: deep.exists, isDirectory, isFile, nlink, sensitivity } };
}

/** checkPath that throws PathPolicyError. */
export function resolvePath(input: string, op: PathOp, opts: PathPolicyOptions): ResolvedPath {
  const r = checkPath(input, op, opts);
  if (!r.ok) throw new PathPolicyError(r.code, r.reason);
  return r.path;
}

// ─── IO with re-verification (the race window after the check) ──────────────────────────────────────────────

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** Review H2: a FIFO opened without O_NONBLOCK parks a libuv thread forever; regular files ignore the flag. */
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/** Where an open fd really points (Linux /proc), else a realpath of the path. */
function fdRealPath(fd: number, fallback: string): string | null {
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      // fall through
    }
  }
  try {
    return fs.realpathSync.native(fallback);
  } catch {
    return null;
  }
}

function assertStillInside(p: ResolvedPath, actual: string | null, opts: PathPolicyOptions): void {
  const platform = opts.platform ?? process.platform;
  if (actual === null || fold(actual, platform) !== fold(p.real, platform) || !isInside(p.rootReal, actual, platform)) {
    throw new PathPolicyError('symlink', 'The path changed while it was being opened (a symbolic link was swapped in).');
  }
}

function openErr(err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ELOOP' || code === 'EMLINK') throw new PathPolicyError('symlink', 'The file was replaced by a symbolic link; refusing to follow it.');
  if (code === 'ENOENT') throw new PathPolicyError('invalid', 'The file does not exist.');
  if (code === 'EISDIR') throw new PathPolicyError('invalid', 'The path is a directory.');
  throw err;
}

export interface ReadResult {
  data: Buffer;
  size: number;
  mtimeMs: number;
  nlink: number;
}

/** Reads a checked file: O_NOFOLLOW on the final component, regular files only, the real fd path re-verified. */
export async function readChecked(p: ResolvedPath, opts: PathPolicyOptions, maxBytes: number): Promise<ReadResult> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(p.real, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    openErr(err);
  }
  try {
    assertStillInside(p, fdRealPath(fh.fd, p.real), opts);
    const st = await fh.stat();
    if (!st.isFile()) throw new PathPolicyError('invalid', st.isDirectory() ? 'The path is a directory.' : 'Not a regular file.');
    if (st.size > maxBytes) throw new PathPolicyError('invalid', `The file is too large (${st.size} bytes; limit ${maxBytes}).`);
    const data = await fh.readFile();
    return { data, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink };
  } finally {
    await fh.close();
  }
}

/** Synchronous variant (permission subjects). Returns null when the file does not exist or cannot be read. */
export function readCheckedSync(p: ResolvedPath, opts: PathPolicyOptions, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(p.real, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    assertStillInside(p, fdRealPath(fd, p.real), opts);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface WriteOptions {
  /** Approved: a regular file with nlink > 1 may be replaced (the rename breaks the link; the other name keeps the old content). */
  allowHardLink?: boolean;
  /** The target must not exist (create only). */
  createOnly?: boolean;
}

/** mkdir -p for the missing segments below the deepest existing ancestor, each re-verified inside the root. */
function ensureDir(dir: string, p: ResolvedPath, opts: PathPolicyOptions): void {
  const platform = opts.platform ?? process.platform;
  const missing: string[] = [];
  let cur = dir;
  for (;;) {
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) {
        const r = fs.realpathSync.native(cur);
        if (!isInside(p.rootReal, r, platform)) throw new PathPolicyError('symlink', 'A directory of the path is a symbolic link out of the worktree.');
        if (!fs.statSync(r).isDirectory()) throw new PathPolicyError('invalid', 'A component of the path is not a directory.');
      } else if (!st.isDirectory()) {
        throw new PathPolicyError('invalid', 'A component of the path is not a directory.');
      }
      break;
    } catch (err) {
      if (err instanceof PathPolicyError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      missing.unshift(cur);
      const parent = path.dirname(cur);
      if (parent === cur) throw new PathPolicyError('invalid', 'The path cannot be created.');
      cur = parent;
    }
  }
  for (const d of missing) {
    try {
      fs.mkdirSync(d, { mode: 0o755 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const r = fs.realpathSync.native(d);
    if (fold(r, platform) !== fold(d, platform) || !isInside(p.rootReal, r, platform)) throw new PathPolicyError('symlink', 'A directory of the path was replaced while it was being created.');
  }
}

/**
 * §8.2.4: atomic write of a checked path. The final component is opened with O_NOFOLLOW (a symlink swapped in is
 * refused), the data goes to `<dir>/.gmid-tmp-<rand>` (O_EXCL|O_NOFOLLOW, fsynced), the directory's realpath is
 * re-verified and the temp file renamed into place. Returns the sha256 of the data.
 */
export async function writeAtomic(p: ResolvedPath, data: string | Buffer, opts: PathPolicyOptions, wopts: WriteOptions = {}): Promise<string> {
  if (p.root !== 'worktree') throw new PathPolicyError('outside', 'This location is read-only.');
  const platform = opts.platform ?? process.platform;
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const dir = path.dirname(p.real);
  ensureDir(dir, p, opts);

  let mode = 0o644;
  let existed = false;
  try {
    const fd = fs.openSync(p.real, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new PathPolicyError('invalid', st.isDirectory() ? 'The path is a directory.' : 'Not a regular file.');
      if (st.nlink > 1 && !wopts.allowHardLink) throw new PathPolicyError('outside', 'The file has other hard links (one may point outside the worktree); approval is needed.');
      mode = st.mode & 0o7777;
      existed = true;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err instanceof PathPolicyError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new PathPolicyError('symlink', 'The file was replaced by a symbolic link; refusing to write through it.');
    if (code !== 'ENOENT') throw err;
  }
  if (existed && wopts.createOnly) throw new PathPolicyError('invalid', 'The file already exists.');

  const tmp = path.join(dir, `.gmid-tmp-${randomBytes(8).toString('hex')}`);
  const fh = await fs.promises.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, mode);
  let renamed = false;
  try {
    await fh.writeFile(buf);
    if (existed) await fh.chmod(mode);
    await fh.sync();
    await fh.close();
    // Re-verify the directory (an intermediate directory swapped for a symlink after the check).
    const dirReal = fs.realpathSync.native(dir);
    if (fold(dirReal, platform) !== fold(dir, platform) || !isInside(p.rootReal, dirReal, platform)) {
      throw new PathPolicyError('symlink', 'A directory of the path changed while writing (a symbolic link was swapped in).');
    }
    try {
      const st = fs.lstatSync(p.real);
      if (st.isSymbolicLink()) throw new PathPolicyError('symlink', 'The file was replaced by a symbolic link; refusing to write through it.');
      if (st.isFile() && st.nlink > 1 && !wopts.allowHardLink) throw new PathPolicyError('outside', 'The file has other hard links (one may point outside the worktree); approval is needed.');
      if (wopts.createOnly) throw new PathPolicyError('invalid', 'The file already exists.');
    } catch (err) {
      if (err instanceof PathPolicyError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    fs.renameSync(tmp, p.real);
    renamed = true;
  } finally {
    if (!renamed) {
      await fh.close().catch(() => undefined);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  }
  return sha256(buf);
}

/** Deletes a checked regular file (apply_patch deletes and moves). The final component is not followed. */
export async function unlinkChecked(p: ResolvedPath, opts: PathPolicyOptions): Promise<void> {
  if (p.root !== 'worktree') throw new PathPolicyError('outside', 'This location is read-only.');
  const platform = opts.platform ?? process.platform;
  const dir = path.dirname(p.real);
  const dirReal = fs.realpathSync.native(dir);
  if (fold(dirReal, platform) !== fold(dir, platform) || !isInside(p.rootReal, dirReal, platform)) {
    throw new PathPolicyError('symlink', 'A directory of the path changed (a symbolic link was swapped in).');
  }
  const st = fs.lstatSync(p.real);
  if (!st.isFile() && !st.isSymbolicLink()) throw new PathPolicyError('invalid', 'Not a regular file.');
  fs.unlinkSync(p.real);
}

// ─── Discovery for the sandbox (H2-E) and sensitive hashes (H2-G) ────────────────────────────────────────────

const SENSITIVE_ROOT_ENTRIES = ['.husky', '.github/workflows', '.envrc', '.vscode/settings.json', '.vscode/tasks.json', '.vscode/launch.json', 'package.json', 'Makefile', 'AGENTS.md', 'CLAUDE.md', '.gmi-desk', '.mcp.json'];

/**
 * Existing execution-sensitive and instruction paths at the worktree root (absolute), as §8.2.6 lists them:
 * the sandbox `--ro-binds` them (H2-E skips package.json, Makefile and *.sh) and H2-G hashes them.
 * Symlinks are not followed (a link is reported as itself).
 */
export function findSensitivePaths(worktree: string, hooksPath?: string | null): string[] {
  const out: string[] = [];
  const exists = (p: string) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  for (const rel of SENSITIVE_ROOT_ENTRIES) {
    const p = path.join(worktree, rel);
    if (exists(p)) out.push(p);
  }
  try {
    for (const e of fs.readdirSync(worktree, { withFileTypes: true })) {
      if (e.name.toLowerCase().endsWith('.sh') && (e.isFile() || e.isSymbolicLink())) out.push(path.join(worktree, e.name));
    }
  } catch {
    // unreadable root: nothing to add
  }
  if (hooksPath && !path.isAbsolute(hooksPath) && !hooksPath.split(/[\\/]/).includes('..')) {
    const p = path.join(worktree, hooksPath);
    if (exists(p)) out.push(p);
  }
  return [...new Set(out)].sort();
}

/**
 * Secret files in the worktree (absolute), for the sandbox's `/dev/null` masks (§8.3). A bounded walk that skips
 * `.git`, `node_modules` and symlinks.
 */
export function findSecretFiles(worktree: string, opts: { maxEntries?: number; maxDepth?: number } = {}): string[] {
  const maxEntries = opts.maxEntries ?? 50_000;
  const maxDepth = opts.maxDepth ?? 12;
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen += 1;
      if (seen > maxEntries) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        walk(p, depth + 1);
      } else if (e.isFile() && isSecretName(e.name)) {
        out.push(p);
      }
    }
  };
  walk(worktree, 0);
  return out.sort();
}
