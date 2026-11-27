/**
 * Ref guard (§8.2; defence in depth, common refs are read-only in the sandbox): `for-each-ref` before each run
 * (persisted by the caller in `ref_snapshots`), compared after the run and, for interrupted runs, at host start. Any
 * change outside the thread's own `refs/heads/gmi/<id6>/` (and its per-worktree refs) is reported with the old and new
 * sha; "Restore ref" runs `update-ref <ref> <old>` under the per-repo mutex.
 */
import { GmiError } from '@shared/contracts/errors';
import { assertGitValue, isHexSha } from '@shared/lib/git-safe';
import type { RefChange, ThreadGitRecord } from '../types';
import { threadOpts, type GitCtx } from './context';
import { threadRefPrefix, verifyRecord, verifyThreadRefFiles } from './record';

/** Per-worktree refs live in the thread's own (writable) git dir. */
const PER_WORKTREE = ['refs/worktree/', 'refs/bisect/', 'refs/rewritten/'];

export async function refSnapshot(ctx: GitCtx, r: ThreadGitRecord): Promise<Record<string, string>> {
  await verifyRecord(r);
  const out = await ctx.exec.text(threadOpts(r, ['for-each-ref', '--format=%(objectname) %(refname)'], { maxBytes: 64 * 1024 * 1024 }));
  const refs: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf(' ');
    if (i <= 0) continue;
    const sha = line.slice(0, i);
    const ref = line.slice(i + 1);
    if (isHexSha(sha) && ref.startsWith('refs/')) refs[ref] = sha;
  }
  return refs;
}

/** Changes outside this thread's own refs between `before` and now. */
export function diffRefs(threadId: string, before: Record<string, string>, after: Record<string, string>): RefChange[] {
  const own = threadRefPrefix(threadId);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: RefChange[] = [];
  for (const ref of keys) {
    if (ref.startsWith(own) || PER_WORKTREE.some((p) => ref.startsWith(p))) continue;
    const b = before[ref] ?? null;
    const a = after[ref] ?? null;
    if (a !== b) out.push({ ref, before: b, after: a });
  }
  return out;
}

export async function compareRefs(ctx: GitCtx, r: ThreadGitRecord, before: Record<string, string>): Promise<RefChange[]> {
  return diffRefs(r.threadId, before, await refSnapshot(ctx, r));
}

export async function restoreRef(ctx: GitCtx, r: ThreadGitRecord, ref: string, sha: string): Promise<void> {
  await verifyRecord(r);
  assertGitValue(ref, 'ref');
  if (!ref.startsWith('refs/') || !isHexSha(sha)) throw new GmiError('invalid_input', 'Invalid ref or commit.', { detail: 'git_restore_ref' });
  const fmt = await ctx.exec.raw(threadOpts(r, ['check-ref-format', ref]));
  if (fmt.code !== 0) throw new GmiError('invalid_input', 'Invalid ref name.', { detail: 'git_restore_ref' });
  await ctx.repoMutex.run(r.commonDir, async () => {
    const exists = await ctx.exec.raw(threadOpts(r, ['cat-file', '-e', sha]));
    if (exists.code !== 0) throw new GmiError('not_found', 'The previous commit is no longer in the repository.', { detail: 'git_restore_ref_missing' });
    await verifyThreadRefFiles(r);
    await ctx.exec.run(threadOpts(r, ['update-ref', '--no-deref', '-m', 'gmi-desk: restore ref', ref, sha]));
  });
}
