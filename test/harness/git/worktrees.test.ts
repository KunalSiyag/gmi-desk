import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { branchFor, orderGitMounts, worktreePathFor } from '@harness/git';
import { memoryStore } from '../fakes';
import { agentGit, makeFixture, makeThread, THREAD_A, THREAD_B, type Fixture } from './helpers';

let f: Fixture;
afterEach(() => f?.cleanup());

describe('createWorktree (§12.2)', () => {
  it('creates a locked worktree on gmi/<id6>/<slug> and records realpaths for git-safe', async () => {
    f = makeFixture();
    const r = await makeThread(f, THREAD_A, 'Fix the Bug!');
    expect(r.branch).toBe('gmi/a1b2c3/fix-the-bug');
    expect(r.worktreePath).toBe(worktreePathFor(f.worktreeDir, THREAD_A, 'Fix the Bug!'));
    expect(r.commonDir).toBe(join(f.root, '.git'));
    expect(r.gitDir.startsWith(join(f.root, '.git', 'worktrees'))).toBe(true);
    expect(r.gitPointer).toBe(readFileSync(join(r.worktreePath, '.git'), 'utf8'));
    expect(r.baseSha).toBe(f.sh(['rev-parse', 'main']).trim());
    expect(r.baseRef).toBe('main');
    expect(r.objectDir).toBe(join(f.dataDir, 'objects', THREAD_A));
    expect(existsSync(join(r.gitDir, 'locked'))).toBe(true);
    const list = f.sh(['worktree', 'list', '--porcelain']);
    expect(list).toContain(`worktree ${r.worktreePath}`);
    expect(list).toMatch(/locked/);
    expect(readFileSync(join(r.worktreePath, 'a.txt'), 'utf8')).toBe('alpha\n');
    await expect(f.git.verify(r)).resolves.toBeUndefined();
  });

  it('honours a user-chosen branch name inside the thread prefix and validates the base ref', async () => {
    f = makeFixture();
    const r = await f.git.createWorktree({ threadId: THREAD_A, project: f.project, strategy: { kind: 'worktree', baseRef: 'main', branch: 'My Feature' }, slug: 'x' });
    expect(r.branch).toBe('gmi/a1b2c3/my-feature');
    expect(branchFor(THREAD_A, 'x', '../../evil.lock')).toBe('gmi/a1b2c3/evil');
    await expect(f.git.createWorktree({ threadId: THREAD_B, project: f.project, strategy: { kind: 'worktree', baseRef: '--upload-pack=touch x' }, slug: 'y' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(f.git.createWorktree({ threadId: THREAD_B, project: f.project, strategy: { kind: 'worktree', baseRef: 'no-such-branch' }, slug: 'y' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses worktree folders at home, at the filesystem root or inside userData', async () => {
    f = makeFixture();
    for (const worktreeDir of ['/', join(f.dataDir, 'wt')]) {
      await expect(f.git.createWorktree({ threadId: THREAD_A, project: { ...f.project, worktreeDir }, strategy: { kind: 'worktree', baseRef: 'main' }, slug: 's' })).rejects.toMatchObject({
        detail: 'git_worktree_dir',
      });
    }
  });

  it('records root and existing_worktree threads (git metadata read-only in the sandbox)', async () => {
    f = makeFixture();
    const root = await f.git.createWorktree({ threadId: THREAD_A, project: f.project, strategy: { kind: 'root' }, slug: 's' });
    expect(root).toMatchObject({ strategy: 'root', worktreePath: f.root, gitDir: join(f.root, '.git'), gitPointer: null, branch: 'main', baseRef: 'main' });
    const rootMounts = await f.git.sandboxMounts(root);
    expect(rootMounts.perThreadRefs).toBe(false);
    expect(rootMounts.writable).toEqual([root.objectDir]);
    expect(rootMounts.readOnly).toContain(join(f.root, '.git'));

    const other = join(f.dir, 'other-wt');
    f.sh(['worktree', 'add', '-q', '-b', 'side', other, 'main']);
    const existing = await f.git.createWorktree({ threadId: THREAD_B, project: f.project, strategy: { kind: 'existing_worktree', path: other }, slug: 's' });
    expect(existing).toMatchObject({ strategy: 'existing_worktree', worktreePath: other, branch: 'side' });
    const m = await f.git.sandboxMounts(existing);
    expect(m.perThreadRefs).toBe(false);
    expect(m.writable).toEqual([existing.objectDir]);
    await expect(f.git.createWorktree({ threadId: THREAD_B, project: f.project, strategy: { kind: 'existing_worktree', path: f.root }, slug: 's' })).rejects.toBeInstanceOf(GmiError);
  });
});

describe('sandboxMounts (§8.3)', () => {
  it('mounts the common dir and pointer files read-only, the thread metadata, refs and object dir writable', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const m = await f.git.sandboxMounts(r);
    const refs = join(r.commonDir, 'refs', 'heads', 'gmi', 'a1b2c3');
    const logs = join(r.commonDir, 'logs', 'refs', 'heads', 'gmi', 'a1b2c3');
    expect(m.perThreadRefs).toBe(true);
    expect(m.writable).toEqual([r.gitDir, refs, logs, r.objectDir]);
    expect(m.readOnly).toEqual(
      expect.arrayContaining([r.commonDir, join(r.worktreePath, '.git'), join(r.gitDir, 'gitdir'), join(r.gitDir, 'commondir'), join(r.gitDir, 'config.worktree'), join(r.gitDir, 'locked')]),
    );
    expect(statSync(join(r.gitDir, 'config.worktree')).size).toBe(0);
    expect(statSync(refs).isDirectory() && statSync(logs).isDirectory()).toBe(true);
    expect(m.env).toEqual({
      GIT_OBJECT_DIRECTORY: r.objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(r.commonDir, 'objects'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_CONFIG_VALUE_0: '0',
    });
    // Bind order: the common dir before the writable worktree metadata, the pointer files after it.
    const order = orderGitMounts(m).map((x) => x.path);
    expect(order.indexOf(r.commonDir)).toBeLessThan(order.indexOf(r.gitDir));
    expect(order.indexOf(r.gitDir)).toBeLessThan(order.indexOf(join(r.gitDir, 'gitdir')));
  });

  it('re-creates the ref dirs a `git pack-refs` removed', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    f.sh(['pack-refs', '--all', '--prune']);
    rmSync(join(r.commonDir, 'refs', 'heads', 'gmi'), { recursive: true, force: true });
    await f.git.sandboxMounts(r);
    expect(existsSync(join(r.commonDir, 'refs', 'heads', 'gmi', 'a1b2c3'))).toBe(true);
  });

  it('keeps all git metadata read-only for reftable repositories', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const m = await f.git.sandboxMounts({ ...r, refFormat: 'reftable' });
    expect(m.perThreadRefs).toBe(false);
    expect(m.writable).toEqual([r.objectDir]);
  });
});

describe('importObjects (§8.3)', () => {
  it('imports the agent commit from the thread object dir into the common store, verified', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'new.txt'), 'agent work\n');
    agentGit(f, r, ['add', 'new.txt']);
    agentGit(f, r, ['commit', '-q', '-m', 'agent commit']);
    const tip = f.sh(['rev-parse', `refs/heads/${r.branch}`]).trim();
    expect(() => f.sh(['cat-file', '-e', tip])).toThrow(); // only in the thread object dir
    const res = await f.git.importObjects(r);
    expect(res.imported).toBe(3); // commit, tree, blob
    expect(() => f.sh(['cat-file', '-e', tip])).not.toThrow();
    f.sh(['fsck', '--no-dangling', '--connectivity-only']);
    expect((await f.git.importObjects(r)).imported).toBe(0); // unchanged tip
  });

  it('refuses a branch whose objects are missing', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'n.txt'), 'x\n');
    agentGit(f, r, ['add', 'n.txt']);
    agentGit(f, r, ['commit', '-q', '-m', 'c']);
    rmSync(r.objectDir!, { recursive: true, force: true });
    mkdirSync(r.objectDir!, { recursive: true });
    await expect(f.git.importObjects(r)).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('removeWorktree (§12.2)', () => {
  it('unlocks and removes only that worktree; never a blanket prune', async () => {
    f = makeFixture();
    const a = await makeThread(f, THREAD_A, 'a');
    const b = await makeThread(f, THREAD_B, 'b');
    // Thread B's folder looks missing (as from inside another sandbox): a prune would drop it.
    const hidden = `${b.worktreePath}.moved`;
    f.sh(['worktree', 'unlock', b.worktreePath]);
    rmSync(hidden, { recursive: true, force: true });
    const { renameSync } = await import('node:fs');
    renameSync(b.worktreePath, hidden);
    await f.git.removeWorktree(a, { deleteBranch: true });
    expect(existsSync(a.worktreePath)).toBe(false);
    expect(f.sh(['branch', '--list', a.branch!]).trim()).toBe('');
    expect(existsSync(a.objectDir!)).toBe(false);
    const list = f.sh(['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(a.worktreePath);
    expect(list).toContain(b.worktreePath); // still registered: no prune ran
    renameSync(hidden, b.worktreePath);
  });

  it('keeps the branch and imports its objects when the branch is kept', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'k.txt'), 'keep\n');
    agentGit(f, r, ['add', 'k.txt']);
    agentGit(f, r, ['commit', '-q', '-m', 'keep me']);
    await f.git.removeWorktree(r, { deleteBranch: false });
    expect(f.sh(['log', '-1', '--format=%s', r.branch!]).trim()).toBe('keep me');
    f.sh(['fsck', '--no-dangling', '--connectivity-only']);
  });
});

describe('recover (§5.1, §12.2)', () => {
  it('rolls back a worktree half-made when the host crashed during setup, keeps a complete one, never touches ready threads', async () => {
    f = makeFixture();
    const store = memoryStore();
    const half = await makeThread(f, THREAD_A, 'half');
    const done = await makeThread(f, THREAD_B, 'done');
    // Crash mid-creation: the checkout never finished (pointer file missing).
    rmSync(join(half.worktreePath, '.git'));
    const states: Record<string, 'creating' | 'setting_up' | 'ready'> = { [THREAD_A]: 'setting_up', [THREAD_B]: 'creating' };
    const git = (await import('@harness/git')).createGitService({ dataDir: f.dataDir, log: f.log, procs: store.gitProcs, setupStateOf: (id) => states[id] ?? null });
    const report = await git.recover([half, done], []);
    expect(report.reconciled).toEqual([
      { threadId: THREAD_A, outcome: 'rolled_back' },
      { threadId: THREAD_B, outcome: 'ready' },
    ]);
    expect(f.sh(['worktree', 'list', '--porcelain'])).not.toContain(half.worktreePath);
    expect(f.sh(['branch', '--list', half.branch!]).trim()).toBe('');
    // A ready thread whose folder vanished is not rolled back (it gets "Recreate worktree" instead).
    states[THREAD_B] = 'ready';
    rmSync(join(done.worktreePath, '.git'));
    const again = await git.recover([done], []);
    expect(again.reconciled).toEqual([]);
    expect(f.sh(['branch', '--list', done.branch!]).trim()).toContain(done.branch!);
  });

  it('removes stale lock files of ours and only reports others', async () => {
    f = makeFixture();
    const store = memoryStore();
    const r = await makeThread(f);
    await f.git.sandboxMounts(r);
    const own = [join(r.gitDir, 'index.lock'), join(r.commonDir, 'refs', 'heads', 'gmi', 'a1b2c3', 'task.lock')];
    const foreign = [join(r.commonDir, 'index.lock'), join(r.commonDir, 'refs', 'heads', 'main.lock')];
    for (const p of [...own, ...foreign]) writeFileSync(p, '');
    store.gitProcs.add(999_999_999, THREAD_A); // dead pid
    const git = (await import('@harness/git')).createGitService({ dataDir: f.dataDir, log: f.log, procs: store.gitProcs, setupStateOf: () => 'ready' });
    const report = await git.recover([r], []);
    expect(report.removedLocks.sort()).toEqual(own.sort());
    expect(report.reportedLocks.sort()).toEqual(foreign.sort());
    for (const p of own) expect(existsSync(p)).toBe(false);
    for (const p of foreign) expect(lstatSync(p).isFile()).toBe(true);
  });

  it('keeps our lock files while a git process of ours is alive', async () => {
    f = makeFixture();
    const store = memoryStore();
    const r = await makeThread(f);
    writeFileSync(join(r.gitDir, 'index.lock'), '');
    store.gitProcs.add(process.pid, THREAD_A);
    const git = (await import('@harness/git')).createGitService({ dataDir: f.dataDir, log: f.log, procs: store.gitProcs, setupStateOf: () => 'ready' });
    const report = await git.recover([r], []);
    expect(report.removedLocks).toEqual([]);
    expect(report.reportedLocks).toContain(join(r.gitDir, 'index.lock'));
  });
});
