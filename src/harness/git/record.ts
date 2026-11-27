/**
 * Thread git records: naming (§12.2 `gmi/<id6>/<slug>`), and the pointer verification git-safe needs before every
 * host git call (§8.2): `<worktree>/.git`, `<git_dir>/gitdir` and `<git_dir>/commondir` must still say what was
 * recorded at creation, otherwise the call is refused with the `git_tampered` notice (SC-1).
 */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GmiError } from '@shared/contracts/errors';
import { isAbsolutePath } from '@shared/lib/git-safe';
import type { ThreadGitRecord } from '../types';

/** Thread ids become ref and file name components: refuse anything else. */
export function assertThreadId(threadId: string): string {
  if (typeof threadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(threadId)) {
    throw new GmiError('invalid_input', 'Invalid thread id.', { detail: 'git_thread_id' });
  }
  return threadId;
}

/** The six-character thread prefix of the branch scheme (`gmi/<id6>/…`). */
export function id6Of(threadId: string): string {
  const id = assertThreadId(threadId).replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 6);
  if (id.length < 6) throw new GmiError('invalid_input', 'Invalid thread id.', { detail: 'git_thread_id' });
  return id;
}

/** `refs/heads/gmi/<id6>/`: the only refs the thread's sandbox can write (§8.3). */
export function threadRefPrefix(threadId: string): string {
  return `refs/heads/gmi/${id6Of(threadId)}/`;
}

/** A branch-name component: lower case, `[a-z0-9._-]`, ≤ 48 characters, never `.lock` / `..` / leading `.` or `-`. */
export function slugify(input: string | null | undefined, fallback = 'work'): string {
  let s = String(input ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, 48)
    .replace(/[-._]+$/, '');
  if (s.endsWith('.lock')) s = s.slice(0, -5).replace(/[-._]+$/, '');
  return s || fallback;
}

export function tampered(what: string): GmiError {
  return new GmiError('permission_denied', 'The git metadata of this thread was changed outside GMI Desk.', { detail: `git_tampered:${what}` });
}

export function isTampered(err: unknown): boolean {
  return err instanceof GmiError && err.code === 'permission_denied' && (err.detail ?? '').startsWith('git_tampered');
}

async function readSmall(path: string): Promise<string | null> {
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.size > 8192) return null;
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function real(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    return s.isDirectory() && (await real(path)) === path;
  } catch {
    return false;
  }
}

/**
 * Pointer verification (§8.2). Throws GmiError('permission_denied', detail `git_tampered:<what>`) when any recorded
 * path or pointer differs. The record's paths are realpaths taken at creation.
 */
export async function verifyRecord(r: ThreadGitRecord): Promise<void> {
  assertThreadId(r.threadId);
  for (const p of [r.worktreePath, r.gitDir, r.commonDir]) if (!isAbsolutePath(p)) throw tampered('record');
  if (!(await isRealDir(r.worktreePath))) throw tampered('worktree');
  if (!(await isRealDir(r.gitDir))) throw tampered('git_dir');
  if (!(await isRealDir(r.commonDir))) throw tampered('common_dir');
  const dotGit = join(r.worktreePath, '.git');

  if (r.gitPointer === null) {
    // `root` thread of a repository whose `.git` is a directory: it must still be that directory.
    if (r.gitDir !== dotGit || r.commonDir !== r.gitDir) throw tampered('record');
    if (!(await isRealDir(dotGit))) throw tampered('pointer');
    return;
  }

  const pointer = await readSmall(dotGit);
  if (pointer === null || pointer !== r.gitPointer) throw tampered('pointer');
  const m = /^gitdir: (.+?)\r?\n?$/.exec(pointer);
  if (!m || (await real(resolve(r.worktreePath, m[1]!))) !== r.gitDir) throw tampered('pointer');

  if (r.gitDir === r.commonDir) return; // `.git` file pointing at a main git dir (separate-git-dir repos, `root`)

  const back = await readSmall(join(r.gitDir, 'gitdir'));
  if (back === null) throw tampered('gitdir');
  const backPath = resolve(r.gitDir, back.replace(/\r?\n$/, ''));
  if (backPath !== dotGit && (await real(backPath)) !== (await real(dotGit))) throw tampered('gitdir');

  const common = await readSmall(join(r.gitDir, 'commondir'));
  if (common === null) throw tampered('commondir');
  if ((await real(resolve(r.gitDir, common.replace(/\r?\n$/, '')))) !== r.commonDir) throw tampered('commondir');
}

/**
 * Sandbox-writable ref and reflog files must be plain files before the host updates or deletes a thread ref (review
 * H2 sandbox lens): git's files backend treats a symlinked loose ref whose link text is a refname as a symbolic ref
 * (a host `update-ref -d` of the thread branch would delete the user's `main`), and it appends reflog lines through
 * symlinks (a host `update-ref -m` would append to any file the user can write). Checks every entry under
 * `refs/heads/gmi/<id6>/` and `logs/refs/heads/gmi/<id6>/` in the common dir, and the thread git dir's `HEAD` and
 * `logs/` tree. Throws `git_tampered:thread_refs` on a symlink or any other non-regular file.
 */
export async function verifyThreadRefFiles(r: Pick<ThreadGitRecord, 'threadId' | 'gitDir' | 'commonDir' | 'refFormat'>): Promise<void> {
  if (r.refFormat !== 'files') return;
  const id6 = id6Of(r.threadId);
  let budget = 20_000;
  const walk = async (dir: string, top: boolean): Promise<void> => {
    let st;
    try {
      st = await lstat(dir);
    } catch {
      return; // absent
    }
    if (!st.isDirectory()) throw tampered('thread_refs');
    if (!top && (await real(dir)) !== dir) throw tampered('thread_refs');
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      budget -= 1;
      if (budget < 0) throw tampered('thread_refs');
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, false);
      else if (!e.isFile()) throw tampered('thread_refs');
    }
  };
  await walk(join(r.commonDir, 'refs', 'heads', 'gmi', id6), true);
  await walk(join(r.commonDir, 'logs', 'refs', 'heads', 'gmi', id6), true);
  if (r.gitDir !== r.commonDir) {
    for (const f of ['HEAD', 'ORIG_HEAD']) {
      try {
        if (!(await lstat(join(r.gitDir, f))).isFile()) throw tampered('thread_refs');
      } catch (err) {
        if (isTampered(err)) throw err;
      }
    }
    await walk(join(r.gitDir, 'logs'), false);
  }
}

/** A loose ref file that the host is about to delete must not be a symlink (symbolic ref) or anything but a file. */
export async function assertPlainRefFile(commonDir: string, ref: string): Promise<void> {
  try {
    const s = await lstat(join(commonDir, ...ref.split('/')));
    if (!s.isFile()) throw tampered('thread_refs');
  } catch (err) {
    if (isTampered(err)) throw err;
  }
}
