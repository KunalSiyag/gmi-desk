/**
 * The host's GitService (harness.md §7.7, §8.2, §8.3, §12.2; H2-G). Every git call goes through git-safe
 * (`@shared/lib/git-safe` + exec.ts) with paths from the thread's record, verified before each call.
 *
 * Beyond the frozen `GitService` interface it exposes `applyPatch` (apply_patch, H2-D), `execCapableConfig`
 * (main's pre-commit/merge confirmation), `listSensitivePaths` (the sandbox's read-only binds, H2-E) and
 * `clearStaleLocks` (before a host git write while no sandboxed command of the thread runs).
 */
import type { CheckpointRow, GitService, HostClock, HostLog, Store, ThreadGitRecord, ThreadSetupState, Worker } from '../types';
import { checkpoint, DEFAULT_MAX_UNTRACKED_BYTES, deleteCheckpoints, restoreCheckpoint } from './checkpoints';
import { applyPatch, commit, execCapableConfig, merge } from './commit';
import { newCtx, type GitCtx } from './context';
import { diffList, discard, exportPatch, fileDiff, statusShort } from './diff';
import { GitExec } from './exec';
import { clearStaleLocks } from './locks';
import { importObjects } from './objects';
import { verifyRecord } from './record';
import { recover } from './recover';
import { compareRefs, refSnapshot, restoreRef } from './refguard';
import { hooksPathDir, listSensitivePaths, sensitiveHashes } from './sensitive';
import { createWorktree, removeWorktree, sandboxMounts } from './worktrees';

export interface GitServiceDeps {
  /** `init.dataDir` (`<userData>/data/harness`): snapshot repos and thread object dirs live under it. */
  dataDir: string;
  log: HostLog;
  clock?: HostClock;
  /** `store.gitProcs`: pids of our git processes (stale-lock detection). */
  procs?: Pick<Store['gitProcs'], 'add' | 'remove' | 'list'> | null;
  /** Setup state per thread (`store.threads.get(id)?.setupState`), used by `recover`. */
  setupStateOf?: ((threadId: string) => ThreadSetupState | null) | null;
  /** Large diffs are parsed here (§5.1). */
  worker?: Worker | null;
  /** Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  gitBinary?: string;
  /** §7.7: default 50 MB. */
  maxUntrackedBytes?: number;
  timeoutMs?: number;
}

export interface GitServiceExtras {
  applyPatch(record: ThreadGitRecord, patch: string, opts?: { check?: boolean }): Promise<{ ok: boolean; error: string | null }>;
  execCapableConfig(record: ThreadGitRecord): Promise<string[]>;
  listSensitivePaths(record: ThreadGitRecord): Promise<string[]>;
  clearStaleLocks(record: ThreadGitRecord): Promise<{ removed: string[]; reported: string[] }>;
  /** The in-repo `core.hooksPath` dir relative to the worktree (execution-sensitive, §8.2.6), or null. */
  hooksPath(record: ThreadGitRecord): Promise<string | null>;
}

const systemClock: HostClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export function createGitService(deps: GitServiceDeps): GitService & GitServiceExtras {
  const log = deps.log.child('git');
  const ctx: GitCtx = newCtx({
    dataDir: deps.dataDir,
    exec: new GitExec({ log, procs: deps.procs ?? null, env: deps.env, gitBinary: deps.gitBinary, timeoutMs: deps.timeoutMs }),
    log,
    clock: deps.clock ?? systemClock,
    procs: deps.procs ?? null,
    setupStateOf: deps.setupStateOf ?? null,
    worker: deps.worker ?? null,
    maxUntrackedBytes: deps.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES,
  });
  const imp = (r: ThreadGitRecord) => importObjects(ctx, r);
  return {
    version: () => ctx.exec.version(),
    createWorktree: (input) => createWorktree(ctx, input),
    removeWorktree: (record, opts) => removeWorktree(ctx, record, opts, imp),
    verify: (record) => verifyRecord(record),
    sandboxMounts: (record) => sandboxMounts(ctx, record),
    importObjects: imp,
    checkpoint: (record, turn) => checkpoint(ctx, record, turn),
    restoreCheckpoint: (record, ckpt: CheckpointRow) => restoreCheckpoint(ctx, record, ckpt),
    deleteCheckpoints: (record) => deleteCheckpoints(ctx, record),
    diff: async (record, opts) => (await diffList(ctx, record, opts)).files,
    fileDiff: (record, path, opts) => fileDiff(ctx, record, path, opts),
    discard: (record, path) => discard(ctx, record, path),
    commit: (record, message) => commit(ctx, record, message),
    merge: (record, method) => merge(ctx, record, method),
    exportPatch: (record) => exportPatch(ctx, record),
    statusShort: (record) => statusShort(ctx, record),
    refSnapshot: (record) => refSnapshot(ctx, record),
    compareRefs: (record, before) => compareRefs(ctx, record, before),
    restoreRef: (record, ref, sha) => restoreRef(ctx, record, ref, sha),
    sensitiveHashes: (record) => sensitiveHashes(ctx, record),
    recover: (records, interrupted) => recover(ctx, records, interrupted),
    applyPatch: (record, patch, opts) => applyPatch(ctx, record, patch, opts),
    execCapableConfig: (record) => execCapableConfig(ctx, record),
    listSensitivePaths: (record) => listSensitivePaths(ctx, record),
    clearStaleLocks: (record) => clearStaleLocks(record, ctx.procs),
    hooksPath: (record) => hooksPathDir(ctx, record),
  };
}

export { orderGitMounts, branchFor, worktreePathFor } from './worktrees';
export { changedSensitive, isSensitivePath } from './sensitive';
export { parseUnifiedDiff, parseDiffLists } from './diff';
export { diffRefs } from './refguard';
export { id6Of, threadRefPrefix, isTampered } from './record';
