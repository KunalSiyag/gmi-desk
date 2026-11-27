/**
 * SC-1 proof of concept (harness.md §16 Git, §26 SC-1, H-T5): the sandbox can write the worktree, so it can rewrite
 * `<worktree>/.git` to point at a git dir it made, whose config defines a `filter.x.clean` driver, and add a
 * `.gitattributes` that selects it. A host git call that discovers the git dir runs that driver on the host. git-safe
 * passes the recorded paths explicitly and verifies the pointer files first, so every host call refuses and nothing
 * runs; the same for diff.external, core.pager, textconv and core.fsmonitor. The repo's own (user-written) config is
 * neutralised too, so an agent-written `.gitattributes` cannot select a driver defined there.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadGitRecord } from '@harness/types';
import { makeFixture, makeThread, marker, plainEnv, type Fixture } from './helpers';

let f: Fixture;
afterEach(() => f?.cleanup());

const HOSTILE_KINDS = ['filter', 'external', 'pager', 'textconv', 'fsmonitor'] as const;

/** Config lines that run `touch <marker-kind>` from each execution point. */
function hostileConfig(f: Fixture): string {
  const t = (k: string) => `touch ${marker(f, k)}`;
  return [
    '[filter "x"]',
    `\tclean = ${t('filter')}`,
    `\tsmudge = ${t('filter')}`,
    '[diff "x"]',
    `\ttextconv = sh -c '${t('textconv')}; cat "$1"' -`,
    '[diff]',
    `\texternal = ${t('external')}`,
    '[core]',
    `\tpager = ${t('pager')}`,
    `\tfsmonitor = ${t('fsmonitor')}`,
    '',
  ].join('\n');
}

function markers(f: Fixture): string[] {
  return HOSTILE_KINDS.filter((k) => existsSync(marker(f, k)));
}

/** What a sandboxed command can do: make a git dir in the worktree and point `.git` at it. */
function redirectGitDir(f: Fixture, r: ThreadGitRecord): string {
  const evil = join(r.worktreePath, '.evil');
  execFileSync('git', ['init', '-q', '--bare', evil], { env: plainEnv() });
  writeFileSync(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${hostileConfig(f)}`);
  writeFileSync(join(r.worktreePath, '.git'), `gitdir: ${evil}\n`);
  writeFileSync(join(r.worktreePath, '.gitattributes'), '* filter=x diff=x\n');
  writeFileSync(join(r.worktreePath, 'a.txt'), 'changed by the agent\n');
  return evil;
}

/** Every host git entry point that takes the thread's record. */
function hostCalls(f: Fixture, r: ThreadGitRecord): Array<[string, () => Promise<unknown>]> {
  return [
    ['checkpoint', () => f.git.checkpoint(r, 1)],
    ['diff', () => f.git.diff(r)],
    ['fileDiff', () => f.git.fileDiff(r, 'a.txt')],
    ['exportPatch', () => f.git.exportPatch(r)],
    ['discard', () => f.git.discard(r, 'a.txt')],
    ['apply', () => f.git.applyPatch(r, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-alpha\n+beta\n')],
    ['refSnapshot', () => f.git.refSnapshot(r)],
    ['compareRefs', () => f.git.compareRefs(r, {})],
    ['restoreRef', () => f.git.restoreRef(r, 'refs/heads/main', r.baseSha!)],
    ['statusShort', () => f.git.statusShort(r)],
    ['importObjects', () => f.git.importObjects(r)],
    ['sandboxMounts', () => f.git.sandboxMounts(r)],
    ['commit', () => f.git.commit(r, 'msg')],
    ['merge', () => f.git.merge(r, 'merge')],
    ['verify', () => f.git.verify(r)],
  ];
}

describe('SC-1: redirected .git + filter driver', () => {
  it('the attack is real: a host call that discovers the git dir runs the driver (the old flags)', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    redirectGitDir(f, r);
    // The pre-review host call (§8.2 "Why"): discovery through the worktree's `.git`, a temp index, a few -c flags.
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'add', '-A'], {
      cwd: r.worktreePath,
      env: plainEnv({ GIT_INDEX_FILE: join(f.dir, 'tmp-index') }),
      stdio: 'ignore',
    });
    expect(markers(f)).toContain('filter');
  });

  it('every host call refuses with git_tampered and nothing runs', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    await f.git.checkpoint(r, 0); // the snapshot repo exists already: the refusal is not an init failure
    redirectGitDir(f, r);
    for (const [name, call] of hostCalls(f, r)) {
      await expect(call(), name).rejects.toMatchObject({ code: 'permission_denied', detail: expect.stringMatching(/^git_tampered/) });
    }
    expect(markers(f)).toEqual([]);
    // Nothing was written to the user's repo either.
    expect(f.sh(['status', '--porcelain'])).toBe('');
  });

  it('also refuses when gitdir or commondir of the thread were rewritten, or .git became a symlink', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const evil = join(f.dir, 'evil.git');
    execFileSync('git', ['init', '-q', '--bare', evil], { env: plainEnv() });
    writeFileSync(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n${hostileConfig(f)}`);
    writeFileSync(join(r.worktreePath, '.gitattributes'), '* filter=x diff=x\n');

    const commondir = join(r.gitDir, 'commondir');
    const original = readFileSync(commondir, 'utf8');
    writeFileSync(commondir, `${evil}\n`);
    await expect(f.git.checkpoint(r, 1)).rejects.toMatchObject({ detail: 'git_tampered:commondir' });
    await expect(f.git.diff(r)).rejects.toMatchObject({ detail: 'git_tampered:commondir' });
    writeFileSync(commondir, original);

    const gitdir = join(r.gitDir, 'gitdir');
    const back = readFileSync(gitdir, 'utf8');
    writeFileSync(gitdir, `${join(f.dir, 'elsewhere', '.git')}\n`);
    await expect(f.git.refSnapshot(r)).rejects.toMatchObject({ detail: 'git_tampered:gitdir' });
    writeFileSync(gitdir, back);

    const pointer = join(r.worktreePath, '.git');
    const content = readFileSync(pointer, 'utf8');
    unlinkSync(pointer);
    mkdirSync(join(f.dir, 'p'), { recursive: true });
    writeFileSync(join(f.dir, 'p', 'pointer'), content);
    symlinkSync(join(f.dir, 'p', 'pointer'), pointer);
    await expect(f.git.statusShort(r)).rejects.toMatchObject({ detail: 'git_tampered:pointer' });
    expect(markers(f)).toEqual([]);
  });
});

describe('drivers defined in the repo config cannot be selected by an agent-written .gitattributes', () => {
  it('checkpoint, diff, file diff, export, status, apply and the ref guard run no filter, textconv, external diff, pager or fsmonitor', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    // The user's repo config defines drivers (as LFS-like setups do); the agent selects them for every file.
    writeFileSync(join(r.commonDir, 'config'), `${readFileSync(join(r.commonDir, 'config'), 'utf8')}${hostileConfig(f)}`);
    writeFileSync(join(r.worktreePath, '.gitattributes'), '* filter=x diff=x\n');
    writeFileSync(join(r.worktreePath, 'a.txt'), 'changed\n');
    writeFileSync(join(r.worktreePath, 'new.txt'), 'new\n');

    const ckpt = await f.git.checkpoint(r, 1);
    expect(ckpt.filesChanged).toBe(3);
    const files = await f.git.diff(r);
    expect(files.map((x) => x.path).sort()).toEqual(['.gitattributes', 'a.txt', 'new.txt']);
    const one = await f.git.fileDiff(r, 'a.txt');
    expect(one.hunks?.[0]?.lines.map((l) => `${l.type}:${l.text}`)).toEqual(['del:alpha', 'add:changed']);
    expect(await f.git.exportPatch(r)).toContain('+changed');
    expect(await f.git.statusShort(r)).toContain('a.txt');
    expect((await f.git.applyPatch(r, '--- a/new.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-new\n+newer\n')).ok).toBe(true);
    await f.git.refSnapshot(r);
    await f.git.restoreCheckpoint(r, ckpt);
    expect(markers(f)).toEqual([]);
  });

  it('the same calls without git-safe would have run them (control)', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.commonDir, 'config'), `${readFileSync(join(r.commonDir, 'config'), 'utf8')}${hostileConfig(f)}`);
    writeFileSync(join(r.worktreePath, '.gitattributes'), '* filter=x diff=x\n');
    writeFileSync(join(r.worktreePath, 'a.txt'), 'changed\n');
    execFileSync('git', ['status', '--short'], { cwd: r.worktreePath, env: plainEnv(), stdio: 'ignore' });
    expect(markers(f)).toEqual(expect.arrayContaining(['fsmonitor']));
  });

  it('checkpoint, diff, apply, status and the ref guard do not read the global config (GIT_CONFIG_GLOBAL=/dev/null)', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    // Drivers in the user's global config (e.g. a filter the user defined for something else).
    writeFileSync(join(f.dir, 'home', '.gitconfig'), `[user]\n\tname = U\n\temail = u@example.invalid\n${hostileConfig(f)}`);
    writeFileSync(join(r.worktreePath, '.gitattributes'), '* filter=x diff=x\n');
    writeFileSync(join(r.worktreePath, 'a.txt'), 'changed\n');
    await f.git.checkpoint(r, 1);
    await f.git.fileDiff(r, 'a.txt');
    await f.git.exportPatch(r);
    await f.git.statusShort(r);
    await f.git.refSnapshot(r);
    await f.git.applyPatch(r, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-changed\n+again\n');
    expect(markers(f)).toEqual([]);
  });
});
