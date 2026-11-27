/**
 * Worktrees (§12.2) and the sandbox's git mounts (§8.3).
 *
 * - `worktree`: `git worktree add --lock -b gmi/<id6>/<slug> <dir> <baseSha>` under the per-repo mutex; the git dir,
 *   common dir, `.git` pointer and object dir are recorded (realpaths) for git-safe. A failure after the add rolls
 *   the worktree and the branch back.
 * - `existing_worktree`: an existing linked worktree of the project; git metadata read-only in the sandbox.
 * - `root`: the project root itself; git metadata read-only in the sandbox.
 * Removal unlocks and removes that one worktree; a blanket `git worktree prune` is never run.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ThreadStrategy } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import { assertGitValue, isHexSha, parseGitPointer } from '@shared/lib/git-safe';
import type { ProjectRow, SandboxGitMounts, ThreadGitRecord } from '../types';
import { commonOpts, type GitCtx, type ProjectRepo } from './context';
import { assertPlainRefFile, id6Of, slugify, threadRefPrefix, verifyRecord, verifyThreadRefFiles } from './record';

async function real(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Resolves (and caches) the project's git dir and common dir; the root must be the repo's top level. */
export async function resolveProject(ctx: GitCtx, project: ProjectRow): Promise<ProjectRepo> {
  const cached = ctx.projects.get(project.id);
  if (cached && cached.root === project.rootPath) return cached;
  const root = await real(project.rootPath);
  if (!root || !isAbsolute(project.rootPath)) throw new GmiError('not_found', 'The project folder does not exist.', { detail: 'git_project_root' });
  const out = await ctx.exec.text({
    profile: 'strict',
    gitDir: null,
    cwd: root,
    ceiling: dirname(root),
    args: ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
    timeoutMs: 15_000,
  });
  const [top, gitDirRaw, commonRaw] = out.split('\n');
  if (!top || !gitDirRaw || !commonRaw || (await real(top)) !== root) {
    throw new GmiError('invalid_input', 'The project folder is not the top of a git repository.', { detail: 'git_not_toplevel' });
  }
  const gitDir = await real(gitDirRaw);
  const commonDir = await real(commonRaw);
  if (!gitDir || !commonDir) throw new GmiError('internal', 'The git directory could not be resolved.', { detail: 'git_resolve' });
  const repo: ProjectRepo = { root, gitDir, commonDir };
  ctx.projects.set(project.id, repo);
  return repo;
}

/** §12.1: absolute, not a filesystem root, not home, not inside userData or a `.git` directory. */
async function checkWorktreeDir(ctx: GitCtx, dir: string): Promise<string> {
  if (!isAbsolute(dir) || resolve(dir) === resolve('/') || /[\0\r\n]/.test(dir)) throw new GmiError('invalid_input', 'Invalid worktree folder.', { detail: 'git_worktree_dir' });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const r = await real(dir);
  if (!r) throw new GmiError('invalid_input', 'Invalid worktree folder.', { detail: 'git_worktree_dir' });
  const home = await real(homedir());
  const userData = await real(dirname(dirname(ctx.paths.root)));
  if (r === '/' || (home && r === home) || (userData && within(r, userData)) || r.split(sep).includes('.git')) {
    throw new GmiError('invalid_input', 'The worktree folder is not allowed.', { detail: 'git_worktree_dir' });
  }
  return r;
}

async function revParse(ctx: GitCtx, repo: ProjectRepo, threadId: string, rev: string): Promise<string | null> {
  const res = await ctx.exec.raw(commonOpts({ commonDir: repo.commonDir, threadId }, ['rev-parse', '--verify', '-q', rev], 'repo'));
  const sha = res.stdout.toString('utf8').trim();
  return res.code === 0 && isHexSha(sha) ? sha : null;
}

async function currentBranch(ctx: GitCtx, gitDir: string, commonDir: string, threadId: string): Promise<string | null> {
  const res = await ctx.exec.raw({ profile: 'strict', gitDir, commonDir, cwd: gitDir, threadId, args: ['symbolic-ref', '-q', 'HEAD'] });
  const ref = res.stdout.toString('utf8').trim();
  return res.code === 0 && ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

async function headSha(ctx: GitCtx, gitDir: string, commonDir: string, threadId: string): Promise<string | null> {
  const res = await ctx.exec.raw({ profile: 'strict', gitDir, commonDir, cwd: gitDir, threadId, args: ['rev-parse', '--verify', '-q', 'HEAD^{commit}'] });
  const sha = res.stdout.toString('utf8').trim();
  return res.code === 0 && isHexSha(sha) ? sha : null;
}

/** Reads `<dir>/.git` as a pointer file and returns `{pointer, gitDir}` (realpath). */
async function readPointer(dir: string): Promise<{ pointer: string; gitDir: string } | null> {
  const p = join(dir, '.git');
  try {
    const s = await lstat(p);
    if (!s.isFile() || s.size > 8192) return null;
    const pointer = await readFile(p, 'utf8');
    const target = parseGitPointer(pointer);
    if (!target) return null;
    const gitDir = await real(resolve(dir, target));
    return gitDir ? { pointer, gitDir } : null;
  } catch {
    return null;
  }
}

async function ensureObjectDir(ctx: GitCtx, threadId: string): Promise<string> {
  const dir = ctx.paths.objectDir(threadId);
  await mkdir(join(dir, 'info'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'pack'), { recursive: true, mode: 0o700 });
  return (await real(dir)) ?? dir;
}

/** The branch a `worktree` thread gets: `gmi/<id6>/<slug or user-chosen name>` (§12.2). */
export function branchFor(threadId: string, slug: string, userBranch?: string | null): string {
  return `gmi/${id6Of(threadId)}/${slugify(userBranch ?? slug)}`;
}

/** Where a `worktree` thread's worktree goes (callers may persist it before creating, for recovery). */
export function worktreePathFor(worktreeDir: string, threadId: string, slug: string): string {
  return join(worktreeDir, `${slugify(slug)}-${id6Of(threadId)}`);
}

export interface CreateWorktreeInput {
  threadId: string;
  project: ProjectRow;
  strategy: ThreadStrategy;
  slug: string;
}

export async function createWorktree(ctx: GitCtx, input: CreateWorktreeInput): Promise<ThreadGitRecord> {
  const { threadId, project, strategy } = input;
  const id6 = id6Of(threadId);
  const repo = await resolveProject(ctx, project);
  const base: Omit<ThreadGitRecord, 'strategy' | 'worktreePath' | 'gitDir' | 'gitPointer' | 'branch' | 'baseRef' | 'baseSha'> = {
    threadId,
    projectId: project.id,
    projectRoot: repo.root,
    commonDir: repo.commonDir,
    objectDir: null,
    refFormat: project.refFormat,
  };

  if (strategy.kind === 'root') {
    const pointer = await readPointer(repo.root);
    const record: ThreadGitRecord = {
      ...base,
      strategy: 'root',
      worktreePath: repo.root,
      gitDir: pointer ? pointer.gitDir : repo.gitDir,
      gitPointer: pointer ? pointer.pointer : null,
      branch: await currentBranch(ctx, repo.gitDir, repo.commonDir, threadId),
      baseRef: null,
      baseSha: await headSha(ctx, repo.gitDir, repo.commonDir, threadId),
      objectDir: await ensureObjectDir(ctx, threadId),
    };
    record.baseRef = record.branch;
    await verifyRecord(record);
    return record;
  }

  if (strategy.kind === 'existing_worktree') {
    const dir = await real(strategy.path);
    if (!dir || dir === repo.root) throw new GmiError('invalid_input', 'Choose a linked worktree of this project.', { detail: 'git_existing_worktree' });
    const pointer = await readPointer(dir);
    if (!pointer) throw new GmiError('invalid_input', 'The folder is not a linked git worktree.', { detail: 'git_existing_worktree' });
    const commonRaw = await readFile(join(pointer.gitDir, 'commondir'), 'utf8').catch(() => null);
    const common = commonRaw === null ? null : await real(resolve(pointer.gitDir, commonRaw.replace(/\r?\n$/, '')));
    if (common !== repo.commonDir) throw new GmiError('invalid_input', 'The worktree belongs to another repository.', { detail: 'git_existing_worktree' });
    const branch = await currentBranch(ctx, pointer.gitDir, repo.commonDir, threadId);
    const record: ThreadGitRecord = {
      ...base,
      strategy: 'existing_worktree',
      worktreePath: dir,
      gitDir: pointer.gitDir,
      gitPointer: pointer.pointer,
      branch,
      baseRef: branch,
      baseSha: await headSha(ctx, pointer.gitDir, repo.commonDir, threadId),
      objectDir: await ensureObjectDir(ctx, threadId),
    };
    await verifyRecord(record);
    return record;
  }

  // strategy.kind === 'worktree'
  let baseRef = strategy.baseRef.trim();
  if (baseRef === '-') baseRef = '@{-1}';
  assertGitValue(baseRef, 'base ref');
  const baseSha = await revParse(ctx, repo, threadId, `${baseRef}^{commit}`);
  if (!baseSha) throw new GmiError('not_found', 'The base branch or commit was not found.', { detail: 'git_base_ref' });
  const branch = branchFor(threadId, input.slug, strategy.branch);
  const worktreeDir = await checkWorktreeDir(ctx, project.worktreeDir);
  const path = worktreePathFor(worktreeDir, threadId, input.slug);
  if (await real(path)) throw new GmiError('conflict', 'A worktree folder for this thread already exists.', { detail: 'git_worktree_exists' });

  return ctx.repoMutex.run(repo.commonDir, async () => {
    const prefix = threadRefPrefix(threadId);
    const taken = await ctx.exec.text(commonOpts({ commonDir: repo.commonDir, threadId }, ['for-each-ref', '--count=1', '--format=%(refname)', prefix], 'repo'));
    if (taken.trim()) throw new GmiError('conflict', 'Another thread uses the same branch prefix.', { detail: 'git_branch_prefix' });
    await ctx.exec.run(
      commonOpts({ commonDir: repo.commonDir, threadId }, ['worktree', 'add', '--lock', '--reason', `gmi-desk thread ${threadId}`, '-b', branch], 'repo', {
        paths: [path, baseSha],
        cwd: repo.root,
        timeoutMs: 10 * 60_000,
      }),
    );
    try {
      const wt = await real(path);
      const pointer = wt ? await readPointer(wt) : null;
      if (!wt || !pointer) throw new GmiError('internal', 'The new worktree is incomplete.', { detail: 'git_worktree_incomplete' });
      const record: ThreadGitRecord = {
        ...base,
        strategy: 'worktree',
        worktreePath: wt,
        gitDir: pointer.gitDir,
        gitPointer: pointer.pointer,
        branch,
        baseRef,
        baseSha,
        objectDir: await ensureObjectDir(ctx, threadId),
      };
      if (!within(pointer.gitDir, join(repo.commonDir, 'worktrees'))) throw new GmiError('internal', 'Unexpected worktree git dir.', { detail: 'git_worktree_incomplete' });
      await verifyRecord(record);
      return record;
    } catch (err) {
      await rollbackWorktree(ctx, { commonDir: repo.commonDir, threadId, root: repo.root }, path, branch, baseSha).catch((e: unknown) =>
        ctx.log.warn('worktree rollback failed', { code: e instanceof GmiError ? e.code : 'internal' }),
      );
      throw err;
    }
  });
}

/** Worktree paths git knows (`git worktree list --porcelain`), realpaths. */
export async function listWorktrees(ctx: GitCtx, commonDir: string, threadId: string | null): Promise<Array<{ path: string; locked: boolean; prunable: boolean }>> {
  const out = await ctx.exec.text(commonOpts({ commonDir, threadId: threadId ?? '' }, ['worktree', 'list', '--porcelain', '-z'], 'strict', { threadId }));
  const items: Array<{ path: string; locked: boolean; prunable: boolean }> = [];
  let cur: { path: string; locked: boolean; prunable: boolean } | null = null;
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) items.push(cur);
      cur = null;
      continue;
    }
    if (field.startsWith('worktree ')) cur = { path: field.slice(9), locked: false, prunable: false };
    else if (cur && (field === 'locked' || field.startsWith('locked '))) cur.locked = true;
    else if (cur && (field === 'prunable' || field.startsWith('prunable '))) cur.prunable = true;
  }
  if (cur) items.push(cur);
  return items;
}

/** The `<common>/worktrees/<name>` entry whose `gitdir` points at `<path>/.git`. */
async function adminDirOf(commonDir: string, path: string): Promise<string | null> {
  const base = join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return null;
  }
  for (const name of names) {
    const content = await readFile(join(base, name, 'gitdir'), 'utf8').catch(() => null);
    if (content !== null && resolve(base, name, content.replace(/\r?\n$/, '')) === join(path, '.git')) return join(base, name);
  }
  return null;
}

/** Removes that one worktree (never a blanket prune) and, when it still points at `baseSha`, our branch. */
export async function rollbackWorktree(ctx: GitCtx, repo: { commonDir: string; threadId: string; root?: string }, path: string, branch: string, baseSha: string | null): Promise<void> {
  const known = await listWorktrees(ctx, repo.commonDir, repo.threadId);
  const resolved = (await real(path)) ?? path;
  if (known.some((w) => w.path === resolved || w.path === path)) {
    await ctx.exec.raw(commonOpts(repo, ['worktree', 'unlock'], 'repo', { paths: [resolved] }));
    const removed = await ctx.exec.raw(commonOpts(repo, ['worktree', 'remove', '--force'], 'repo', { paths: [resolved], cwd: repo.root ?? repo.commonDir }));
    if (removed.code !== 0) {
      // git refuses to remove a worktree whose checkout never finished (no `.git` file): remove that one entry and
      // its folder ourselves, as `worktree prune` would for this entry only.
      const admin = await adminDirOf(repo.commonDir, resolved);
      if (!admin) throw new GmiError('internal', 'The half-made worktree could not be removed.', { detail: 'git_rollback' });
      await rm(resolved, { recursive: true, force: true });
      await rm(admin, { recursive: true, force: true });
    }
  }
  const ref = `refs/heads/${branch}`;
  if (baseSha && isHexSha(baseSha)) {
    // The setup command ran in the exec sandbox, which can replace the branch with a symlink symref to `main`:
    // never dereference (--no-deref), and refuse a non-file ref outright.
    await assertPlainRefFile(repo.commonDir, ref);
    await ctx.exec.raw(commonOpts(repo, ['update-ref', '--no-deref', '-d', ref, baseSha], 'repo'));
  }
}

export async function removeWorktree(ctx: GitCtx, r: ThreadGitRecord, opts: { deleteBranch: boolean }, importObjects: (r: ThreadGitRecord) => Promise<unknown>): Promise<void> {
  if (r.strategy === 'worktree') {
    if (!opts.deleteBranch && r.objectDir) await importObjects(r);
    await ctx.repoMutex.run(r.commonDir, async () => {
      const known = await listWorktrees(ctx, r.commonDir, r.threadId);
      if (known.some((w) => w.path === r.worktreePath)) {
        await ctx.exec.raw(commonOpts(r, ['worktree', 'unlock'], 'repo', { paths: [r.worktreePath] }));
        await ctx.exec.run(commonOpts(r, ['worktree', 'remove', '--force'], 'repo', { paths: [r.worktreePath], cwd: r.projectRoot }));
      } else {
        ctx.log.warn('worktree not registered; folder left in place', { thread: r.threadId });
      }
      if (opts.deleteBranch && r.branch && r.branch.startsWith(`gmi/${id6Of(r.threadId)}/`)) {
        // The thread's ref and reflog dirs are sandbox-writable: a symlinked ref is a symbolic ref git would follow
        // (deleting the user's branch) and a symlinked reflog would be written through.
        await verifyThreadRefFiles(r);
        await assertPlainRefFile(r.commonDir, `refs/heads/${r.branch}`);
        await ctx.exec.raw(commonOpts(r, ['update-ref', '--no-deref', '-d', `refs/heads/${r.branch}`], 'repo'));
      }
      if (r.refFormat === 'files') {
        for (const d of [join(r.commonDir, 'refs', 'heads', 'gmi', id6Of(r.threadId)), join(r.commonDir, 'logs', 'refs', 'heads', 'gmi', id6Of(r.threadId))]) {
          await rmdir(d).catch(() => undefined);
        }
      }
    });
  }
  if (r.objectDir && (opts.deleteBranch || r.strategy !== 'worktree')) {
    const expected = ctx.paths.objectDir(r.threadId);
    const resolved = (await real(expected)) ?? expected;
    if (r.objectDir === resolved || r.objectDir === expected) await rm(r.objectDir, { recursive: true, force: true });
  }
  ctx.lastImported.delete(r.threadId);
}

/**
 * §8.3 mounts: read-only common dir and pointer files, writable worktree metadata, own ref dirs and object dir.
 * Creates what bwrap needs to exist (ref dirs, an empty `config.worktree`, the object dir) under the per-repo mutex.
 * Apply with `orderGitMounts` (shorter paths first), so nested read-only files win over writable parents.
 */
export async function sandboxMounts(ctx: GitCtx, r: ThreadGitRecord): Promise<SandboxGitMounts> {
  await verifyRecord(r);
  const objectDir = r.objectDir ?? (await ensureObjectDir(ctx, r.threadId));
  await mkdir(join(objectDir, 'info'), { recursive: true, mode: 0o700 });
  await mkdir(join(objectDir, 'pack'), { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    GIT_OBJECT_DIRECTORY: objectDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(r.commonDir, 'objects'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
  };
  const perThreadRefs = r.strategy === 'worktree' && r.refFormat === 'files' && r.gitDir !== r.commonDir;
  const readOnly = [r.commonDir];
  if (r.gitPointer !== null) readOnly.push(join(r.worktreePath, '.git'));
  if (!perThreadRefs) {
    if (!within(r.gitDir, r.commonDir)) readOnly.push(r.gitDir);
    return { readOnly, writable: [objectDir], env, perThreadRefs: false };
  }
  const id6 = id6Of(r.threadId);
  const refsDir = join(r.commonDir, 'refs', 'heads', 'gmi', id6);
  const logsDir = join(r.commonDir, 'logs', 'refs', 'heads', 'gmi', id6);
  await ctx.repoMutex.run(r.commonDir, async () => {
    await mkdir(refsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    const cw = join(r.gitDir, 'config.worktree');
    try {
      const s = await lstat(cw);
      if (!s.isFile()) throw new GmiError('permission_denied', 'Unexpected config.worktree.', { detail: 'git_tampered:config_worktree' });
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      await writeFile(cw, '', { flag: 'wx', mode: 0o644 });
    }
  });
  for (const f of ['gitdir', 'commondir', 'config.worktree', 'locked']) {
    const p = join(r.gitDir, f);
    try {
      if ((await lstat(p)).isFile()) readOnly.push(p);
    } catch {
      /* absent */
    }
  }
  return { readOnly, writable: [r.gitDir, refsDir, logsDir, objectDir], env, perThreadRefs: true };
}

/** The mounts in bind order: shorter paths first, so a nested read-only file overrides its writable parent. */
export function orderGitMounts(m: SandboxGitMounts): Array<{ path: string; mode: 'ro' | 'rw' }> {
  const all = [...m.readOnly.map((path) => ({ path, mode: 'ro' as const })), ...m.writable.map((path) => ({ path, mode: 'rw' as const }))];
  const depth = (p: string) => p.split(sep).filter(Boolean).length;
  return all.map((m2, i) => ({ ...m2, i })).sort((a, b) => depth(a.path) - depth(b.path) || a.i - b.i).map(({ path, mode }) => ({ path, mode }));
}

