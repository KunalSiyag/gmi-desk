/**
 * Throwaway git fixtures for the H2-G tests. Every repo, worktree and data dir lives in a fresh directory under
 * os.tmpdir() created here and removed by `cleanup()`; nothing points at a real project or the user's home.
 * "User" and "agent" actions are plain git runs with an isolated config (no global or system config).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitService, type GitServiceDeps } from '@harness/git';
import type { ProjectRow, ThreadGitRecord } from '@harness/types';
import { memoryLog } from '../fakes';

export const THREAD_A = 'a1b2c3d4-0000-4000-8000-000000000001';
export const THREAD_B = 'b5c6d7e8-0000-4000-8000-000000000002';

export interface Fixture {
  dir: string;
  root: string;
  dataDir: string;
  worktreeDir: string;
  project: ProjectRow;
  git: ReturnType<typeof createGitService>;
  log: ReturnType<typeof memoryLog>;
  /** Plain git as the user / the agent would run it (isolated config; never the host's git-safe). */
  sh(args: string[], opts?: { cwd?: string; env?: Record<string, string>; input?: string }): string;
  write(rel: string, content: string, base?: string): void;
  cleanup(): void;
}

export function plainEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent-gmi-desk-test-home',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'user@example.invalid',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'user@example.invalid',
    LC_ALL: 'C',
    ...extra,
  };
}

/** A repo with one commit on `main` (a.txt, src/b.txt, .gitignore ignoring *.log and build/). */
export function makeFixture(opts: { files?: Record<string, string>; deps?: Partial<GitServiceDeps> } = {}): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gmi-desk-git-test-')));
  const root = join(dir, 'repo');
  const dataDir = join(dir, 'userData', 'data', 'harness');
  const worktreeDir = join(dir, 'worktrees', 'repo-0000abcd');
  mkdirSync(root, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const sh: Fixture['sh'] = (args, o = {}) =>
    execFileSync('git', args, { cwd: o.cwd ?? root, env: plainEnv(o.env), input: o.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const write: Fixture['write'] = (rel, content, base = root) => {
    const p = join(base, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  };
  sh(['init', '-q', '-b', 'main']);
  const files = opts.files ?? { 'a.txt': 'alpha\n', 'src/b.txt': 'one\ntwo\nthree\n', '.gitignore': '*.log\nbuild/\n' };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'init']);
  const project: ProjectRow = {
    id: 'proj_test_1',
    rootPath: root,
    name: 'repo',
    defaultBranch: 'main',
    worktreeDir,
    setupCommand: null,
    trustState: 'trusted',
    trustHash: null,
    trustedAt: null,
    refFormat: 'files',
    addedAt: '2026-11-02T10:00:00.000Z',
  };
  // The "user's" global config (identity for Review commits); strict calls never read it.
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Test User\n\temail = user@example.invalid\n');
  const log = memoryLog();
  const git = createGitService({ dataDir, log, env: { PATH: process.env.PATH, HOME: home }, ...opts.deps });
  return {
    dir,
    root,
    dataDir,
    worktreeDir,
    project,
    git,
    log,
    sh,
    write,
    cleanup() {
      if (dir.startsWith(realpathSync(tmpdir())) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function makeThread(f: Fixture, threadId = THREAD_A, slug = 'task'): Promise<ThreadGitRecord> {
  return f.git.createWorktree({ threadId, project: f.project, strategy: { kind: 'worktree', baseRef: 'main' }, slug });
}

/** Runs git the way the agent does inside its sandbox: own object dir, the common store as alternate. */
export function agentGit(f: Fixture, r: ThreadGitRecord, args: string[]): string {
  return f.sh(args, {
    cwd: r.worktreePath,
    env: { GIT_OBJECT_DIRECTORY: r.objectDir!, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(r.commonDir, 'objects'), GIT_AUTHOR_NAME: 'Agent', GIT_COMMITTER_NAME: 'Agent' },
  });
}

/** A marker file path under the fixture dir that a hostile driver would create. */
export function marker(f: Fixture, name: string): string {
  return join(f.dir, `PWNED-${name}`);
}
