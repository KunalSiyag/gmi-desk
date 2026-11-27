/**
 * Review actions (§12.3) and `git apply` for apply_patch (§8.1).
 *
 * - commit: the thread's objects are imported first; the tree comes from a temporary index seeded from the branch tip
 *   (never the worktree's agent-writable index); `commit-tree` + a compare-and-swap `update-ref` on the thread's
 *   branch. Profile `user`: the user's global config (LFS, signing) is kept by design.
 * - merge: into the base branch checked out in the project root, which must be clean; on conflict `merge --abort`.
 * - apply: `git apply` (strict) in the worktree, patch on stdin; refuses paths outside the worktree and symlinks.
 * - execCapableConfig: repo-local config keys that can run code, for main's confirmation before commit and merge.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GmiError } from '@shared/contracts/errors';
import { execCapableKeys, isHexSha } from '@shared/lib/git-safe';
import type { ThreadGitRecord } from '../types';
import { commonOpts, snapshotRepoOf, threadOpts, type GitCtx } from './context';
import type { GitRunOptions } from './exec';
import { importObjects, readRef } from './objects';
import { ensureSnapshot, shieldGitlinks } from './checkpoints';
import { verifyRecord, verifyThreadRefFiles } from './record';

function cleanMessage(message: string): string {
  const m = String(message ?? '')
    .replace(/\0/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!m) throw new GmiError('invalid_input', 'The commit message is empty.', { detail: 'git_commit_message' });
  if (m.length > 64 * 1024) throw new GmiError('invalid_input', 'The commit message is too long.', { detail: 'git_commit_message' });
  return `${m}\n`;
}

function userOpts(r: ThreadGitRecord, args: string[], extra: Partial<GitRunOptions> = {}): GitRunOptions {
  return { ...threadOpts(r, args), profile: 'user', neutralizeFrom: null, ...extra };
}

export async function commit(ctx: GitCtx, r: ThreadGitRecord, message: string): Promise<{ sha: string }> {
  await verifyRecord(r);
  const msg = cleanMessage(message);
  if (!r.branch) throw new GmiError('invalid_input', 'This thread has no branch to commit to.', { detail: 'git_no_branch' });
  const branchRef = `refs/heads/${r.branch}`;
  await importObjects(ctx, r);
  const head = await ctx.exec.raw(threadOpts(r, ['symbolic-ref', '-q', 'HEAD']));
  if (head.stdout.toString('utf8').trim() !== branchRef) {
    throw new GmiError('conflict', "The worktree is not on the thread's branch.", { detail: 'git_head_moved' });
  }
  await ensureSnapshot(ctx, r);
  const tmp = await mkdtemp(join(snapshotRepoOf(ctx, r.projectId), 'tmp-commit-'));
  const indexFile = join(tmp, 'index');
  try {
    return await ctx.repoMutex.run(r.commonDir, async () => {
      const tip = await readRef(ctx, r, branchRef);
      if (tip) await ctx.exec.run(userOpts(r, ['read-tree', tip], { indexFile }));
      // Gitlinks (nested repos the agent made or committed) must never be stat'ed by `add -A` (§8.2, review H2).
      await shieldGitlinks(ctx, (args, extra) => userOpts(r, args, { indexFile, ...extra }));
      await ctx.exec.run(userOpts(r, ['add', '-A'], { indexFile, timeoutMs: 10 * 60_000 }));
      const tree = (await ctx.exec.text(userOpts(r, ['write-tree'], { indexFile }))).trim();
      if (tip) {
        const tipTree = (await ctx.exec.text(threadOpts(r, ['rev-parse', `${tip}^{tree}`]))).trim();
        if (tipTree === tree) throw new GmiError('invalid_input', 'There is nothing to commit.', { detail: 'git_nothing_to_commit' });
      }
      const made = await ctx.exec.raw(userOpts(r, ['commit-tree', tree, ...(tip ? ['-p', tip] : [])], { stdin: msg }));
      const sha = made.stdout.toString('utf8').trim();
      if (made.code !== 0 || !isHexSha(sha)) {
        if (/tell me who you are|empty ident|user\.email/i.test(made.stderr)) {
          throw new GmiError('invalid_input', 'Set your git user.name and user.email first.', { detail: 'git_identity_missing' });
        }
        throw new GmiError('internal', 'The commit failed.', { detail: `git_commit:${made.stderr.split('\n')[0]?.slice(0, 200) ?? ''}` });
      }
      // Reflogs and the branch ref are sandbox-writable: refuse symlinks (writes through them reach host files), and
      // never dereference the branch (a symlink symref would move another branch).
      await verifyThreadRefFiles(r);
      await ctx.exec.run(threadOpts(r, ['update-ref', '--no-deref', '-m', 'gmi-desk: commit', branchRef, sha, tip ?? '0'.repeat(sha.length)]));
      // The worktree's own index now matches the new commit (stat data refreshed).
      await ctx.exec.run(threadOpts(r, ['read-tree', sha]));
      await ctx.exec.raw(threadOpts(r, ['update-index', '-q', '--refresh']));
      return { sha };
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function merge(ctx: GitCtx, r: ThreadGitRecord, method: 'merge' | 'squash'): Promise<{ sha: string }> {
  await verifyRecord(r);
  if (r.strategy !== 'worktree' || !r.branch || !r.baseRef) throw new GmiError('invalid_input', 'Only worktree threads can be merged.', { detail: 'git_merge_strategy' });
  const baseBranch = r.baseRef.startsWith('refs/heads/') ? r.baseRef : `refs/heads/${r.baseRef}`;
  await importObjects(ctx, r);
  // The project root's git dir (`.git` dir or pointer), resolved by git in the user's root, which is not agent-writable.
  const rootGitDir = (
    await ctx.exec.text({ profile: 'strict', gitDir: null, cwd: r.projectRoot, ceiling: dirname(r.projectRoot), args: ['rev-parse', '--path-format=absolute', '--git-dir'] })
  ).trim();
  const rootOpts = (args: string[], extra: Partial<GitRunOptions> = {}): GitRunOptions => ({
    profile: 'user',
    gitDir: rootGitDir,
    commonDir: r.commonDir,
    workTree: r.projectRoot,
    cwd: r.projectRoot,
    threadId: r.threadId,
    args,
    ...extra,
  });
  const head = (await ctx.exec.raw(rootOpts(['symbolic-ref', '-q', 'HEAD']))).stdout.toString('utf8').trim();
  if (head !== baseBranch) throw new GmiError('conflict', `Check out ${r.baseRef} in the project folder first.`, { detail: 'git_merge_base_not_checked_out' });
  const dirty = await ctx.exec.text(rootOpts(['status', '--porcelain', '--untracked-files=no']));
  if (dirty.trim()) throw new GmiError('conflict', 'The project folder has uncommitted changes.', { detail: 'git_merge_dirty' });
  return ctx.repoMutex.run(r.commonDir, async () => {
    const branchRef = `refs/heads/${r.branch}`;
    const res =
      method === 'squash'
        ? await ctx.exec.raw(rootOpts(['merge', '--squash', '--no-edit', branchRef], { timeoutMs: 10 * 60_000 }))
        : await ctx.exec.raw(rootOpts(['merge', '--no-ff', '--no-edit', '-m', `Merge ${r.branch}`, branchRef], { timeoutMs: 10 * 60_000 }));
    if (res.code !== 0) {
      await ctx.exec.raw(rootOpts(method === 'squash' ? ['reset', '--merge'] : ['merge', '--abort']));
      throw new GmiError('conflict', 'The merge has conflicts. Nothing was changed.', { detail: 'git_merge_conflict' });
    }
    if (method === 'squash') {
      const staged = await ctx.exec.raw(rootOpts(['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv']));
      if (staged.code !== 0) await ctx.exec.run(rootOpts(['commit', '--no-verify', '-F', '-'], { stdin: `Squashed ${r.branch}\n` }));
    }
    const sha = (await ctx.exec.text(rootOpts(['rev-parse', 'HEAD']))).trim();
    if (!isHexSha(sha)) throw new GmiError('internal', 'The merge result could not be read.', { detail: 'git_merge' });
    return { sha };
  });
}

/** `git apply` in the worktree (strict). `check` runs `--check` only. */
export async function applyPatch(ctx: GitCtx, r: ThreadGitRecord, patch: string, opts: { check?: boolean } = {}): Promise<{ ok: boolean; error: string | null }> {
  await verifyRecord(r);
  if (patch.length > 8 * 1024 * 1024) return { ok: false, error: 'The patch is too large.' };
  const res = await ctx.exec.raw(threadOpts(r, ['apply', ...(opts.check ? ['--check'] : []), '--whitespace=nowarn', '--recount', '-'], { stdin: patch }));
  return res.code === 0 ? { ok: true, error: null } : { ok: false, error: res.stderr.split('\n').filter(Boolean).slice(0, 6).join('\n').slice(0, 1000) || 'git apply failed' };
}

/** Repo-local (and worktree-local) config keys that can run code (§8.2), for main's confirmation before commit/merge. */
export async function execCapableConfig(ctx: GitCtx, r: ThreadGitRecord): Promise<string[]> {
  const res = await ctx.exec.raw(commonOpts(r, ['config', '--local', '--name-only', '--list'], 'strict', { okCodes: [0, 1] }));
  return execCapableKeys(res.stdout.toString('utf8').split('\n'));
}
