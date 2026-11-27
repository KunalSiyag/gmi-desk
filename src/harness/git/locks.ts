/**
 * The per-repo mutex (§12.2: every write to shared repo state — worktree add / remove / unlock, branch create and
 * delete, update-ref, object import, merge, ref restore) and stale git lock files.
 *
 * Stale locks: `*.lock` files in the thread's git dir (its `index.lock`, `HEAD.lock` …) and under
 * `refs/heads/gmi/<id6>/` (and its reflog dir) are removed when no git process of ours is alive (`git_procs`).
 * Lock files elsewhere in the common dir are only reported. Call `clearStaleLocks` at host start, or before a host
 * git write while no sandboxed command of that thread runs (a running sandbox may hold `index.lock` legitimately).
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Store, ThreadGitRecord } from '../types';
import { id6Of } from './record';

/** FIFO async mutex per key (repo common dir, snapshot repo). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}

export type ProcList = Pick<Store['gitProcs'], 'list'>;

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
}

/** True when a git process we started (for this thread, or for no thread) is still alive. */
export function ourGitAlive(procs: ProcList | null | undefined, threadId: string | null): boolean {
  if (!procs) return false;
  try {
    return procs.list().some((p) => (threadId === null || p.threadId === null || p.threadId === threadId) && pidAlive(p.pid));
  } catch {
    return true; // cannot tell: never remove
  }
}

/** `*.lock` regular files under `dir` (depth-limited, symlinks not followed, at most `max`). */
export async function findLocks(dir: string, opts: { depth?: number; max?: number; skip?: (path: string) => boolean } = {}): Promise<string[]> {
  const depth = opts.depth ?? 6;
  const max = opts.max ?? 2000;
  const found: string[] = [];
  let visited = 0;
  const walk = async (d: string, level: number): Promise<void> => {
    if (found.length >= max || visited > 20_000) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited += 1;
      const p = join(d, e.name);
      if (opts.skip?.(p)) continue;
      if (e.isDirectory()) {
        if (level < depth && e.name !== 'objects') await walk(p, level + 1);
      } else if (e.isFile() && e.name.endsWith('.lock')) {
        found.push(p);
        if (found.length >= max) return;
      }
    }
  };
  await walk(dir, 0);
  return found;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

/** The directories whose lock files belong to this thread (removable when stale). */
export function ownLockDirs(r: ThreadGitRecord): string[] {
  const dirs: string[] = [];
  if (r.gitDir !== r.commonDir) dirs.push(r.gitDir);
  if (r.strategy === 'worktree' && r.refFormat === 'files') {
    const id6 = id6Of(r.threadId);
    dirs.push(join(r.commonDir, 'refs', 'heads', 'gmi', id6), join(r.commonDir, 'logs', 'refs', 'heads', 'gmi', id6));
  }
  return dirs;
}

/**
 * Removes this thread's stale lock files and reports other lock files of the common dir. Nothing is removed while a
 * git process of ours for this thread is alive.
 */
export async function clearStaleLocks(r: ThreadGitRecord, procs: ProcList | null | undefined): Promise<{ removed: string[]; reported: string[] }> {
  const own = ownLockDirs(r);
  const removed: string[] = [];
  const reported: string[] = [];
  const alive = ourGitAlive(procs, r.threadId);
  for (const dir of own) {
    for (const lock of await findLocks(dir)) {
      if (alive) {
        reported.push(lock);
        continue;
      }
      try {
        const s = await lstat(lock);
        if (!s.isFile()) continue;
        await unlink(lock);
        removed.push(lock);
      } catch {
        reported.push(lock);
      }
    }
  }
  for (const lock of await findLocks(r.commonDir, { depth: 6, skip: (p) => own.some((d) => inside(p, d)) || inside(p, join(r.commonDir, 'objects')) })) {
    reported.push(lock);
  }
  return { removed, reported };
}
