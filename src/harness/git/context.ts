/**
 * Shared state of the git service: the exec, the mutexes and the option builders for the three kinds of host git
 * calls (thread repo, project repo, snapshot repo).
 */
import { join } from 'node:path';
import type { GitIdentity, GitSafeProfile } from '@shared/lib/git-safe';
import { harnessPaths, type HostClock, type HostLog, type ProjectRow, type Store, type ThreadGitRecord, type ThreadSetupState, type Worker } from '../types';
import type { GitExec, GitRunOptions } from './exec';
import { KeyedMutex } from './locks';
import { assertThreadId } from './record';

export interface GitCtx {
  exec: GitExec;
  log: HostLog;
  clock: HostClock;
  paths: ReturnType<typeof harnessPaths>;
  /** Per common dir (§12.2). */
  repoMutex: KeyedMutex;
  /** Per snapshot repo (checkpoints, review diffs, gc). */
  snapMutex: KeyedMutex;
  procs: Pick<Store['gitProcs'], 'add' | 'remove' | 'list'> | null;
  setupStateOf: ((threadId: string) => ThreadSetupState | null) | null;
  worker: Worker | null;
  /** §7.7: a checkpoint is skipped when the new untracked files exceed this (default 50 MB). */
  maxUntrackedBytes: number;
  /** Branch tip last imported per thread (in memory; an optimisation only). */
  lastImported: Map<string, string>;
  /** Resolved project repos, by project id. */
  projects: Map<string, ProjectRepo>;
}

export interface ProjectRepo {
  root: string;
  gitDir: string;
  commonDir: string;
}

export function newCtx(input: Omit<GitCtx, 'repoMutex' | 'snapMutex' | 'lastImported' | 'projects' | 'paths'> & { dataDir: string }): GitCtx {
  const { dataDir, ...rest } = input;
  return { ...rest, paths: harnessPaths(dataDir), repoMutex: new KeyedMutex(), snapMutex: new KeyedMutex(), lastImported: new Map(), projects: new Map() };
}

type Extra = Partial<Omit<GitRunOptions, 'args'>>;

/** A strict call in the thread's repo, with the recorded paths and the repo's drivers neutralised. */
export function threadOpts(r: ThreadGitRecord, args: string[], extra: Extra = {}): GitRunOptions {
  return {
    profile: 'strict',
    gitDir: r.gitDir,
    commonDir: r.commonDir,
    workTree: r.worktreePath,
    cwd: r.worktreePath,
    neutralizeFrom: { gitDir: r.gitDir, commonDir: r.commonDir },
    threadId: r.threadId,
    args,
    ...extra,
  };
}

/** A call on the project's common dir (no work tree): worktree management, refs, objects. */
export function commonOpts(r: Pick<ThreadGitRecord, 'commonDir' | 'threadId'>, args: string[], profile: GitSafeProfile = 'strict', extra: Extra = {}): GitRunOptions {
  return {
    profile,
    gitDir: r.commonDir,
    commonDir: r.commonDir,
    cwd: r.commonDir,
    neutralizeFrom: profile === 'strict' ? { gitDir: r.commonDir, commonDir: r.commonDir } : null,
    threadId: r.threadId,
    args,
    ...extra,
  };
}

export function snapshotRepoOf(ctx: GitCtx, projectId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) throw new Error('invalid project id');
  return ctx.paths.snapshotRepo(projectId);
}

export function snapshotIndexOf(ctx: GitCtx, r: ThreadGitRecord): string {
  return join(snapshotRepoOf(ctx, r.projectId), `index-${assertThreadId(r.threadId)}`);
}

export function gitDate(ms: number): string {
  return `@${Math.floor(ms / 1000)} +0000`;
}

/**
 * A strict call in the snapshot repo with the thread's persistent index and the worktree as work tree (§7.7). The
 * snapshot repo's config is ours (no drivers); the user's `info/exclude` is honoured through core.excludesFile.
 */
export function snapOpts(ctx: GitCtx, r: ThreadGitRecord, args: string[], extra: Extra = {}): GitRunOptions {
  const snap = snapshotRepoOf(ctx, r.projectId);
  const identity: GitIdentity = { name: 'GMI Desk', email: 'gmi-desk@localhost', date: gitDate(ctx.clock.now()) };
  return {
    profile: 'strict',
    gitDir: snap,
    commonDir: snap,
    workTree: r.worktreePath,
    cwd: r.worktreePath,
    indexFile: snapshotIndexOf(ctx, r),
    config: [['core.excludesFile', join(r.commonDir, 'info', 'exclude')]],
    identity,
    threadId: r.threadId,
    args,
    ...extra,
  };
}

export type { ProjectRow };
