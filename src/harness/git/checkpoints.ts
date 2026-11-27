/**
 * Checkpoints in a separate snapshot repo (§7.7, DH11): `<data>/harness/snapshots/<projectId>.git`, bare, ours, never
 * mounted in a sandbox. `objects/info/alternates` points at the project's common object store (read only), so
 * committed blobs are not copied. Each thread has a persistent index there (`index-<threadId>`), so a checkpoint only
 * re-hashes files whose stat data changed. The worktree's own index (agent-writable) is never used.
 *
 * Refs in the snapshot repo:
 *   refs/checkpoints/<thread>/<turn>   one commit per checkpointed turn
 *   refs/checkpoints/<thread>/head     the latest checkpoint (parent of the next one)
 *   refs/gmi-index/<thread>            the tree of the latest `add -A` (keeps index-only blobs reachable for gc)
 */
import { lstat, mkdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { GmiError } from '@shared/contracts/errors';
import { isHexSha } from '@shared/lib/git-safe';
import { newId, type CheckpointRow, type ThreadGitRecord } from '../types';
import { snapOpts, snapshotIndexOf, snapshotRepoOf, type GitCtx } from './context';
import { splitZ, type GitRunOptions } from './exec';
import { assertThreadId, verifyRecord } from './record';

export const DEFAULT_MAX_UNTRACKED_BYTES = 50 * 1024 * 1024;

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Creates the bare snapshot repo of the project (once) and points its alternates at the common object store. */
export async function ensureSnapshot(ctx: GitCtx, r: ThreadGitRecord): Promise<string> {
  const snap = snapshotRepoOf(ctx, r.projectId);
  if (!(await exists(join(snap, 'HEAD')))) {
    await mkdir(dirname(snap), { recursive: true, mode: 0o700 });
    await ctx.exec.run({ profile: 'strict', gitDir: null, cwd: dirname(snap), args: ['init', '-q', '--bare', '--template='], paths: [snap] });
  }
  const alternates = join(snap, 'objects', 'info', 'alternates');
  const want = `${join(r.commonDir, 'objects')}\n`;
  const have = await readFile(alternates, 'utf8').catch(() => null);
  if (have !== want) {
    await mkdir(dirname(alternates), { recursive: true });
    await writeFile(alternates, want, { mode: 0o600 });
  }
  return snap;
}

function relSafe(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return false;
  return !normalize(rel).split(sep).includes('..');
}

/** Sum of the sizes of files the next `add -A` would add (untracked in the thread's snapshot index). */
async function untrackedBytes(ctx: GitCtx, r: ThreadGitRecord, cap: number): Promise<number> {
  const out = await ctx.exec.run(snapOpts(ctx, r, ['ls-files', '-z', '--others', '--exclude-standard'], { maxBytes: 128 * 1024 * 1024 }));
  let total = 0;
  for (const rel of splitZ(out.stdout)) {
    if (!relSafe(rel)) continue;
    try {
      const s = await lstat(join(r.worktreePath, rel));
      if (s.isFile()) total += s.size;
    } catch {
      /* raced away */
    }
    if (total > cap) break;
  }
  return total;
}

/**
 * Marks every gitlink (mode 160000) of the index skip-worktree before an `add -A` (review H2, sandbox lens). For a
 * gitlink entry, `add -A` runs `git status` INSIDE the nested repo (is_submodule_modified), which reads that repo's
 * agent-written config and runs its filters on the host, outside the sandbox. A skip-worktree entry is never compared
 * with the work tree. A nested repo that is not in the index yet is added as a gitlink without any child process and
 * shielded by the next call. Neither `ls-files -s` nor `update-index --skip-worktree` looks at the work tree.
 */
export async function shieldGitlinks(ctx: GitCtx, opts: (args: string[], extra?: Partial<GitRunOptions>) => GitRunOptions): Promise<number> {
  const listing = await ctx.exec.raw(opts(['ls-files', '-s', '-z'], { maxBytes: 256 * 1024 * 1024 }));
  if (listing.code !== 0) return 0;
  const links: string[] = [];
  for (const rec of splitZ(listing.stdout)) {
    const m = /^160000 [0-9a-f]+ \d+\t(.+)$/s.exec(rec);
    if (m) links.push(m[1]!);
  }
  if (!links.length) return 0;
  await ctx.exec.run(opts(['update-index', '-z', '--skip-worktree', '--stdin'], { stdin: `${links.join('\0')}\0` }));
  return links.length;
}

/** `add -A` into the thread's snapshot index and `write-tree`; resets the index once if it references lost objects. */
async function addAll(ctx: GitCtx, r: ThreadGitRecord, opts: { cap: number | null }): Promise<string> {
  if (opts.cap !== null) {
    const bytes = await untrackedBytes(ctx, r, opts.cap);
    if (bytes > opts.cap) {
      throw new GmiError('limit_reached', 'The new untracked files are too large to checkpoint.', { detail: `checkpoint_untracked_too_large:${bytes}` });
    }
  }
  const attempt = async (): Promise<string | null> => {
    await shieldGitlinks(ctx, (args, extra) => snapOpts(ctx, r, args, extra));
    const add = await ctx.exec.raw(snapOpts(ctx, r, ['add', '-A'], { timeoutMs: 10 * 60_000 }));
    if (add.code !== 0) return null;
    const tree = await ctx.exec.raw(snapOpts(ctx, r, ['write-tree']));
    const sha = tree.stdout.toString('utf8').trim();
    return tree.code === 0 && isHexSha(sha) ? sha : null;
  };
  let tree = await attempt();
  if (!tree) {
    // The index can reference blobs that vanished (the user rewrote history and ran gc): rebuild it from scratch.
    await unlink(snapshotIndexOf(ctx, r)).catch(() => undefined);
    tree = await attempt();
  }
  if (!tree) throw new GmiError('internal', 'The worktree could not be snapshotted.', { detail: 'checkpoint_add' });
  await ctx.exec.run(snapOpts(ctx, r, ['update-ref', `refs/gmi-index/${r.threadId}`, tree]));
  return tree;
}

/** The tree of the worktree as it is now (for review diffs), from the thread's snapshot index. */
export async function currentTree(ctx: GitCtx, r: ThreadGitRecord): Promise<string> {
  await verifyRecord(r);
  const snap = snapshotRepoOf(ctx, r.projectId);
  return ctx.snapMutex.run(snap, async () => {
    await ensureSnapshot(ctx, r);
    return addAll(ctx, r, { cap: ctx.maxUntrackedBytes });
  });
}

async function resolve(ctx: GitCtx, r: ThreadGitRecord, rev: string): Promise<string | null> {
  const res = await ctx.exec.raw(snapOpts(ctx, r, ['rev-parse', '--verify', '-q', rev]));
  const sha = res.stdout.toString('utf8').trim();
  return res.code === 0 && isHexSha(sha) ? sha : null;
}

async function countChanged(ctx: GitCtx, r: ThreadGitRecord, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  const out = await ctx.exec.raw(snapOpts(ctx, r, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', from, to], { maxBytes: 64 * 1024 * 1024 }));
  return out.code === 0 ? splitZ(out.stdout).length : 0;
}

async function rowFromCommit(ctx: GitCtx, r: ThreadGitRecord, turn: number, commit: string): Promise<CheckpointRow> {
  const body = await ctx.exec.text(snapOpts(ctx, r, ['cat-file', 'commit', commit]));
  const tree = /^tree ([0-9a-f]+)$/m.exec(body)?.[1] ?? '';
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(body)?.[1]?.trim() ?? null;
  return {
    id: field('Checkpoint-Id') ?? newId('ckpt'),
    threadId: r.threadId,
    turn,
    commitSha: commit,
    treeSha: tree,
    filesChanged: Number(field('Files-Changed') ?? 0) || 0,
    createdAt: field('Created-At') ?? new Date(ctx.clock.now()).toISOString(),
  };
}

export async function checkpoint(ctx: GitCtx, r: ThreadGitRecord, turn: number): Promise<CheckpointRow> {
  await verifyRecord(r);
  assertThreadId(r.threadId);
  if (!Number.isInteger(turn) || turn < 0) throw new GmiError('invalid_input', 'Invalid turn.', { detail: 'checkpoint_turn' });
  const snap = snapshotRepoOf(ctx, r.projectId);
  return ctx.snapMutex.run(snap, async () => {
    await ensureSnapshot(ctx, r);
    const turnRef = `refs/checkpoints/${r.threadId}/${turn}`;
    const headRef = `refs/checkpoints/${r.threadId}/head`;
    const existing = await resolve(ctx, r, `${turnRef}^{commit}`);
    if (existing) return rowFromCommit(ctx, r, turn, existing);

    const tree = await addAll(ctx, r, { cap: ctx.maxUntrackedBytes });
    const prev = await resolve(ctx, r, `${headRef}^{commit}`);
    let filesChanged = 0;
    if (prev) {
      const prevTree = await resolve(ctx, r, `${prev}^{tree}`);
      filesChanged = prevTree ? await countChanged(ctx, r, prevTree, tree) : 0;
    } else if (isHexSha(r.baseSha) && (await resolve(ctx, r, `${r.baseSha}^{tree}`))) {
      filesChanged = await countChanged(ctx, r, `${r.baseSha}^{tree}`, tree);
    }
    const id = newId('ckpt', ctx.clock.now());
    const createdAt = new Date(ctx.clock.now()).toISOString();
    const message = `gmi-desk checkpoint ${r.threadId}/${turn}\n\nCheckpoint-Id: ${id}\nFiles-Changed: ${filesChanged}\nCreated-At: ${createdAt}\n`;
    const commit = (await ctx.exec.text(snapOpts(ctx, r, ['commit-tree', tree, ...(prev ? ['-p', prev] : [])], { stdin: message }))).trim();
    if (!isHexSha(commit)) throw new GmiError('internal', 'The checkpoint commit failed.', { detail: 'checkpoint_commit' });
    await ctx.exec.run(snapOpts(ctx, r, ['update-ref', turnRef, commit, '0'.repeat(commit.length)]));
    await ctx.exec.run(snapOpts(ctx, r, ['update-ref', headRef, commit]));
    return { id, threadId: r.threadId, turn, commitSha: commit, treeSha: tree, filesChanged, createdAt };
  });
}

/** Paths of blobs in `tree` that no object store reachable from the snapshot repo has. */
async function missingBlobs(ctx: GitCtx, r: ThreadGitRecord, tree: string): Promise<string[]> {
  const listing = await ctx.exec.raw(snapOpts(ctx, r, ['ls-tree', '-r', '-z', '--full-tree', tree], { maxBytes: 256 * 1024 * 1024 }));
  if (listing.code !== 0) return ['(tree)'];
  const entries: Array<{ sha: string; path: string }> = [];
  for (const rec of splitZ(listing.stdout)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(rec);
    if (m && m[2] === 'blob') entries.push({ sha: m[3]!, path: m[4]! });
  }
  if (!entries.length) return [];
  const check = await ctx.exec.run(snapOpts(ctx, r, ['cat-file', '--batch-check=%(objectname)'], { stdin: `${entries.map((e) => e.sha).join('\n')}\n`, maxBytes: 256 * 1024 * 1024 }));
  const lines = check.stdout.toString('utf8').split('\n');
  const missing: string[] = [];
  entries.forEach((e, i) => {
    if (lines[i] === `${e.sha} missing`) missing.push(e.path);
  });
  return missing;
}

export async function restoreCheckpoint(ctx: GitCtx, r: ThreadGitRecord, ckpt: CheckpointRow): Promise<{ removed: string[] }> {
  await verifyRecord(r);
  if (ckpt.threadId !== r.threadId || !isHexSha(ckpt.commitSha)) throw new GmiError('invalid_input', 'The checkpoint belongs to another thread.', { detail: 'checkpoint_thread' });
  const snap = snapshotRepoOf(ctx, r.projectId);
  return ctx.snapMutex.run(snap, async () => {
    await ensureSnapshot(ctx, r);
    const commitOk = await ctx.exec.raw(snapOpts(ctx, r, ['cat-file', '-e', `${ckpt.commitSha}^{commit}`]));
    if (commitOk.code !== 0) throw new GmiError('not_found', 'The checkpoint no longer exists.', { detail: 'checkpoint_missing' });
    const tree = await resolve(ctx, r, `${ckpt.commitSha}^{tree}`);
    if (!tree) throw new GmiError('conflict', 'Some files of this checkpoint are no longer in the repository.', { detail: 'checkpoint_objects_missing:(tree)' });
    const missing = await missingBlobs(ctx, r, tree);
    if (missing.length) {
      throw new GmiError('conflict', 'Some files of this checkpoint are no longer in the repository.', { detail: `checkpoint_objects_missing:${missing.slice(0, 20).join(', ')}` });
    }
    // The current state (also kept as a safety commit), then the files that are new since the checkpoint.
    const now = await addAll(ctx, r, { cap: null });
    const safety = (await ctx.exec.text(snapOpts(ctx, r, ['commit-tree', now], { stdin: `gmi-desk pre-restore ${r.threadId}\n` }))).trim();
    if (isHexSha(safety)) await ctx.exec.run(snapOpts(ctx, r, ['update-ref', `refs/checkpoints/${r.threadId}/pre-restore`, safety]));
    const added = splitZ(
      (await ctx.exec.run(snapOpts(ctx, r, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=A', '--no-ext-diff', '--no-textconv', tree, now], { maxBytes: 64 * 1024 * 1024 }))).stdout,
    ).filter(relSafe);
    let ignored = new Set<string>();
    if (added.length) {
      const res = await ctx.exec.raw(snapOpts(ctx, r, ['check-ignore', '-z', '--stdin', '--no-index'], { stdin: `${added.join('\0')}\0`, okCodes: [0, 1] }));
      ignored = new Set(splitZ(res.stdout));
    }
    const removed: string[] = [];
    for (const rel of added) {
      if (ignored.has(rel)) continue;
      const abs = join(r.worktreePath, rel);
      try {
        const s = await lstat(abs);
        if (s.isDirectory()) continue;
        await unlink(abs);
        removed.push(rel);
        let dir = dirname(abs);
        while (dir.startsWith(r.worktreePath + sep) && dir !== r.worktreePath) {
          try {
            await rmdir(dir);
          } catch {
            break;
          }
          dir = dirname(dir);
        }
      } catch {
        /* already gone */
      }
    }
    await ctx.exec.run(snapOpts(ctx, r, ['read-tree', tree]));
    await ctx.exec.run(snapOpts(ctx, r, ['checkout-index', '-a', '-f', '-u'], { timeoutMs: 10 * 60_000 }));
    await ctx.exec.run(snapOpts(ctx, r, ['update-ref', `refs/gmi-index/${r.threadId}`, tree]));
    return { removed };
  });
}

/** Deletes the thread's checkpoint refs and index, then `gc --prune=now` on the snapshot repo (ours, never the user's). */
export async function deleteCheckpoints(ctx: GitCtx, r: ThreadGitRecord): Promise<void> {
  assertThreadId(r.threadId);
  const snap = snapshotRepoOf(ctx, r.projectId);
  if (!(await exists(join(snap, 'HEAD')))) return;
  // The worktree may already be gone (thread deletion): no work tree here.
  const bare = { workTree: null, cwd: snap };
  await ctx.snapMutex.run(snap, async () => {
    const refs = await ctx.exec.text(snapOpts(ctx, r, ['for-each-ref', '--format=%(refname)', `refs/checkpoints/${r.threadId}/`, `refs/gmi-index/${r.threadId}`], bare));
    const lines = refs
      .split('\n')
      .filter((l) => l.startsWith(`refs/checkpoints/${r.threadId}/`) || l === `refs/gmi-index/${r.threadId}`)
      .map((l) => `delete ${l}`);
    if (lines.length) await ctx.exec.run(snapOpts(ctx, r, ['update-ref', '--stdin'], { ...bare, stdin: `${lines.join('\n')}\n` }));
    await rm(snapshotIndexOf(ctx, r), { force: true });
    await ctx.exec.run(snapOpts(ctx, r, ['gc', '--prune=now', '--quiet'], { ...bare, timeoutMs: 10 * 60_000 }));
  });
}
