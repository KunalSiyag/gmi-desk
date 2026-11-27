/**
 * Throwaway git repos for the live sandbox tests. Everything lives under a directory the test created in
 * os.tmpdir(); nothing points at the real project, the user's home or another repo.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxGitMounts } from '@harness/types';

export const HAS_BWRAP = process.platform === 'linux' && existsSync('/usr/bin/bwrap') && canUseUserNs();

function canUseUserNs(): boolean {
  try {
    execFileSync('/usr/bin/bwrap', ['--unshare-all', '--unshare-user', '--disable-userns', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--', '/usr/bin/true'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** Host-side git for the fixtures (never inside the real project). */
export function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: { ...GIT_ENV, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface ThreadFixture {
  id6: string;
  name: string;
  worktree: string;
  gitDir: string;
  objectDir: string;
  branch: string;
  mounts: SandboxGitMounts;
}

export interface RepoFixture {
  root: string;
  repo: string;
  common: string;
  dataDir: string;
  addThread(id6: string, opts?: { lock?: boolean }): ThreadFixture;
}

/** A repo with a commit, a `.env`, AGENTS.md and a husky hook. */
export function makeRepo(prefix = 'gmid-h2e-'): RepoFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'be nice\n');
  mkdirSync(join(repo, '.husky'));
  writeFileSync(join(repo, '.husky', 'pre-commit'), '#!/bin/sh\necho hook\n');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  const common = join(repo, '.git');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  return {
    root,
    repo,
    common,
    dataDir,
    addThread(id6, opts = {}) {
      const name = `wt-${id6}`;
      const worktree = join(root, name);
      const branch = `gmi/${id6}/task`;
      git(repo, ['worktree', 'add', '-q', ...(opts.lock === false ? [] : ['--lock']), '-b', branch, worktree, 'main']);
      writeFileSync(join(worktree, '.env'), 'SECRET_VALUE=hunter2\n');
      const gitDir = join(common, 'worktrees', name);
      writeFileSync(join(gitDir, 'config.worktree'), '');
      mkdirSync(join(common, 'refs', 'heads', 'gmi', id6), { recursive: true });
      mkdirSync(join(common, 'logs', 'refs', 'heads', 'gmi', id6), { recursive: true });
      const objectDir = join(dataDir, 'objects', id6);
      mkdirSync(join(objectDir, 'info'), { recursive: true });
      mkdirSync(join(objectDir, 'pack'), { recursive: true });
      // What GitService.sandboxMounts() returns for a worktree thread (§8.3), built here because H2-G is a sibling.
      const mounts: SandboxGitMounts = {
        readOnly: [join(worktree, '.git'), common, join(gitDir, 'gitdir'), join(gitDir, 'commondir'), join(gitDir, 'config.worktree')],
        writable: [gitDir, join(common, 'refs', 'heads', 'gmi', id6), join(common, 'logs', 'refs', 'heads', 'gmi', id6), objectDir],
        env: { GIT_OBJECT_DIRECTORY: objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, 'objects'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0' },
        perThreadRefs: true,
      };
      return { id6, name, worktree, gitDir, objectDir, branch, mounts };
    },
  };
}
