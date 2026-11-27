/**
 * Host-start recovery (§5.1, §12.2, §17):
 * - threads whose setup was in progress (`creating` / `setting_up`, from `setupStateOf`; without it every record
 *   passed is treated as in progress) are reconciled against `git worktree list --porcelain`: a complete worktree →
 *   `ready` (the caller marks setup `failed` with "Re-run setup" when a setup command was due); a half-made one is
 *   rolled back (that worktree only, and our branch only while it still points at the base) → `rolled_back`;
 *   anything else → `failed`. Threads that are `ready` are never rolled back.
 * - stale lock files of ours are removed, others reported (locks.ts);
 * - the persisted ref-guard snapshot of each interrupted run is compared (refguard.ts).
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { GmiError } from '@shared/contracts/errors';
import type { GitRecoveryReport, ThreadGitRecord } from '../types';
import type { GitCtx } from './context';
import { clearStaleLocks } from './locks';
import { isTampered, verifyRecord } from './record';
import { compareRefs } from './refguard';
import { listWorktrees, rollbackWorktree } from './worktrees';

async function isFile(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isFile();
  } catch {
    return false;
  }
}

export async function recover(
  ctx: GitCtx,
  records: ThreadGitRecord[],
  interrupted: Array<{ runId: string; threadId: string; refs: Record<string, string> }>,
): Promise<GitRecoveryReport> {
  const report: GitRecoveryReport = { reconciled: [], removedLocks: [], reportedLocks: [], movedRefs: [] };
  const seenReported = new Set<string>();

  for (const r of records) {
    const state = ctx.setupStateOf ? ctx.setupStateOf(r.threadId) : 'creating';
    if (state === 'creating' || state === 'setting_up') {
      try {
        report.reconciled.push({ threadId: r.threadId, outcome: await reconcile(ctx, r) });
      } catch (err) {
        ctx.log.warn('worktree reconcile failed', { thread: r.threadId, code: err instanceof GmiError ? err.code : 'internal' });
        report.reconciled.push({ threadId: r.threadId, outcome: 'failed' });
      }
    }
    try {
      const locks = await clearStaleLocks(r, ctx.procs);
      report.removedLocks.push(...locks.removed);
      for (const l of locks.reported) {
        if (!seenReported.has(l)) {
          seenReported.add(l);
          report.reportedLocks.push(l);
        }
      }
    } catch (err) {
      ctx.log.warn('stale lock scan failed', { thread: r.threadId, code: err instanceof GmiError ? err.code : 'internal' });
    }
  }

  for (const run of interrupted) {
    const r = records.find((x) => x.threadId === run.threadId);
    if (!r) continue;
    try {
      const changes = await compareRefs(ctx, r, run.refs);
      if (changes.length) report.movedRefs.push({ threadId: run.threadId, runId: run.runId, changes });
    } catch (err) {
      ctx.log.warn('ref guard check failed', { thread: run.threadId, code: err instanceof GmiError ? err.code : 'internal', tampered: isTampered(err) });
    }
  }
  return report;
}

async function reconcile(ctx: GitCtx, r: ThreadGitRecord): Promise<'ready' | 'rolled_back' | 'failed'> {
  if (r.strategy !== 'worktree') {
    try {
      await verifyRecord(r);
      return 'ready';
    } catch {
      return 'failed';
    }
  }
  const known = await listWorktrees(ctx, r.commonDir, r.threadId);
  const listed = known.find((w) => w.path === r.worktreePath);
  const complete = listed !== undefined && (await isFile(join(r.worktreePath, '.git'))) && (await isFile(join(r.gitDir, 'HEAD')));
  if (complete) {
    try {
      await verifyRecord(r);
      return 'ready';
    } catch (err) {
      if (isTampered(err)) return 'failed';
      throw err;
    }
  }
  if (!r.branch) return 'failed';
  await ctx.repoMutex.run(r.commonDir, () => rollbackWorktree(ctx, { commonDir: r.commonDir, threadId: r.threadId, root: r.projectRoot }, r.worktreePath, r.branch!, r.baseSha));
  return 'rolled_back';
}
