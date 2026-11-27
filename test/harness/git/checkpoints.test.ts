import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService } from '@harness/git';
import { makeFixture, makeThread, plainEnv, THREAD_B, type Fixture } from './helpers';

let f: Fixture;
afterEach(() => f?.cleanup());

function snap(f: Fixture): string {
  return join(f.dataDir, 'snapshots', `${f.project.id}.git`);
}

describe('checkpoints in the snapshot repo (§7.7)', () => {
  it('creates a bare snapshot repo with alternates and a persistent per-thread index; the user repo is untouched', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const userIndex = statSync(join(r.gitDir, 'index'));
    const userObjects = f.sh(['count-objects', '-v']);
    const userRefs = f.sh(['for-each-ref']);
    writeFileSync(join(r.worktreePath, 'a.txt'), 'changed\n');
    const c = await f.git.checkpoint(r, 1);
    expect(c).toMatchObject({ threadId: r.threadId, turn: 1, filesChanged: 1 });
    expect(c.id).toMatch(/^ckpt_/);
    expect(readFileSync(join(snap(f), 'objects', 'info', 'alternates'), 'utf8')).toBe(`${join(r.commonDir, 'objects')}\n`);
    expect(existsSync(join(snap(f), `index-${r.threadId}`))).toBe(true);
    const ref = execFileSync('git', ['--git-dir', snap(f), 'rev-parse', `refs/checkpoints/${r.threadId}/1`], { env: plainEnv(), encoding: 'utf8' }).trim();
    expect(ref).toBe(c.commitSha);
    // The worktree's own index, the user's objects and refs did not change.
    const after = statSync(join(r.gitDir, 'index'));
    expect(after.mtimeMs).toBe(userIndex.mtimeMs);
    expect(after.size).toBe(userIndex.size);
    expect(f.sh(['count-objects', '-v'])).toBe(userObjects);
    expect(f.sh(['for-each-ref'])).toBe(userRefs);
  });

  it('is idempotent per turn and reuses the tree when nothing changed', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const c0 = await f.git.checkpoint(r, 0);
    expect(c0.filesChanged).toBe(0);
    const again = await f.git.checkpoint(r, 0);
    expect(again).toEqual(c0);
    const c1 = await f.git.checkpoint(r, 1);
    expect(c1.treeSha).toBe(c0.treeSha);
    expect(c1.filesChanged).toBe(0);
    expect(c1.commitSha).not.toBe(c0.commitSha);
  });

  it('a turn that changed files only through bash is restorable; ignored files stay, new tracked files go', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'debug.log'), 'ignored before\n');
    const c1 = await f.git.checkpoint(r, 1);
    // "bash" (no fs tool) edits, deletes, adds, writes ignored files, and replaces a file by a symlink.
    execFileSync('sh', ['-c', 'echo bash-edit > a.txt && rm src/b.txt && mkdir -p deep/er && echo n > deep/er/new.txt && echo x > build.log && mkdir -p build && echo o > build/out.js'], {
      cwd: r.worktreePath,
    });
    symlinkSync('/etc/hostname', join(r.worktreePath, 'link.txt'));
    const res = await f.git.restoreCheckpoint(r, c1);
    expect(res.removed.sort()).toEqual(['deep/er/new.txt', 'link.txt']);
    expect(readFileSync(join(r.worktreePath, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(join(r.worktreePath, 'src/b.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(existsSync(join(r.worktreePath, 'deep'))).toBe(false);
    expect(existsSync(join(r.worktreePath, 'link.txt'))).toBe(false);
    // Ignored files are never deleted.
    expect(readFileSync(join(r.worktreePath, 'build.log'), 'utf8')).toBe('x\n');
    expect(readFileSync(join(r.worktreePath, 'build/out.js'), 'utf8')).toBe('o\n');
    expect(readFileSync(join(r.worktreePath, 'debug.log'), 'utf8')).toBe('ignored before\n');
    // A later checkpoint sees the restored state (no stale index entries).
    const c2 = await f.git.checkpoint(r, 2);
    expect(c2.treeSha).toBe(c1.treeSha);
  });

  it('restores a file the agent replaced by a symlink to a directory, without writing through it', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const c1 = await f.git.checkpoint(r, 1);
    const outside = join(f.dir, 'outside');
    mkdirSync(outside);
    execFileSync('sh', ['-c', 'rm -rf src'], { cwd: r.worktreePath });
    symlinkSync(outside, join(r.worktreePath, 'src'));
    await f.git.checkpoint(r, 2);
    await f.git.restoreCheckpoint(r, c1);
    expect(existsSync(join(outside, 'b.txt'))).toBe(false);
    expect(statSync(join(r.worktreePath, 'src')).isDirectory()).toBe(true);
    expect(() => readlinkSync(join(r.worktreePath, 'src'))).toThrow();
    expect(readFileSync(join(r.worktreePath, 'src/b.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('refuses a restore when objects reached only through the alternate are gone, naming the paths', async () => {
    f = makeFixture({ files: { 'keep.txt': 'k\n' } });
    // A commit on a side branch that the user later drops and prunes.
    f.sh(['checkout', '-q', '-b', 'side']);
    f.write('only-here.txt', 'side content\n');
    f.sh(['add', '-A']);
    f.sh(['commit', '-q', '-m', 'side']);
    f.sh(['checkout', '-q', 'main']);
    const r = await f.git.createWorktree({ threadId: 'c0ffee00-0000-4000-8000-000000000003', project: f.project, strategy: { kind: 'worktree', baseRef: 'side' }, slug: 's' });
    writeFileSync(join(r.worktreePath, 'agent.txt'), 'makes the checkpoint tree new (written to the snapshot repo)\n');
    const c1 = await f.git.checkpoint(r, 1);
    // The blob lives only in the user's store (via the alternate); the user rewrites history and runs gc.
    await f.git.removeWorktree(r, { deleteBranch: true });
    f.sh(['branch', '-D', 'side']);
    f.sh(['reflog', 'expire', '--expire=now', '--all']);
    f.sh(['gc', '-q', '--prune=now']);
    execFileSync('git', ['worktree', 'add', '-q', '--detach', r.worktreePath, 'main'], { cwd: f.root, env: plainEnv() });
    await expect(f.git.restoreCheckpoint({ ...r, gitPointer: readFileSync(join(r.worktreePath, '.git'), 'utf8') }, c1)).rejects.toMatchObject({
      code: 'conflict',
      detail: expect.stringContaining('only-here.txt'),
    });
  });

  it('skips with a warning when the new untracked files exceed the cap', async () => {
    f = makeFixture({ deps: { maxUntrackedBytes: 1024 } });
    const r = await makeThread(f);
    writeFileSync(join(r.worktreePath, 'big.bin'), Buffer.alloc(4096));
    await expect(f.git.checkpoint(r, 1)).rejects.toMatchObject({ code: 'limit_reached', detail: expect.stringMatching(/^checkpoint_untracked_too_large/) });
    unlinkSync(join(r.worktreePath, 'big.bin'));
    await expect(f.git.checkpoint(r, 1)).resolves.toMatchObject({ turn: 1 });
  });

  it('deleteCheckpoints removes the refs and index of one thread and prunes the snapshot repo', async () => {
    f = makeFixture();
    const a = await makeThread(f);
    const b = await makeThread(f, THREAD_B, 'b');
    writeFileSync(join(a.worktreePath, 'only-a.txt'), 'a\n');
    const ca = await f.git.checkpoint(a, 1);
    const cb = await f.git.checkpoint(b, 1);
    await f.git.removeWorktree(a, { deleteBranch: true }); // thread deletion: the worktree goes first
    await f.git.deleteCheckpoints(a);
    const refs = execFileSync('git', ['--git-dir', snap(f), 'for-each-ref', '--format=%(refname)'], { env: plainEnv(), encoding: 'utf8' });
    expect(refs).not.toContain(a.threadId);
    expect(refs).toContain(`refs/checkpoints/${b.threadId}/1`);
    expect(existsSync(join(snap(f), `index-${a.threadId}`))).toBe(false);
    expect(() => execFileSync('git', ['--git-dir', snap(f), 'cat-file', '-e', ca.commitSha], { env: plainEnv(), stdio: 'ignore' })).toThrow();
    await expect(f.git.restoreCheckpoint(b, cb)).resolves.toEqual({ removed: [] });
  });

  it('an unchanged 50k-file worktree checkpoints in under 2 s', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    for (let d = 0; d < 500; d += 1) {
      const dir = join(r.worktreePath, 'many', String(d));
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 100; i += 1) writeFileSync(join(dir, `${i}.txt`), `${d}/${i}\n`);
    }
    const git = createGitService({ dataDir: f.dataDir, log: f.log, maxUntrackedBytes: 512 * 1024 * 1024 });
    await git.checkpoint(r, 0); // the first full hash happens in the background after creation (§7.7)
    const t0 = performance.now();
    const c1 = await git.checkpoint(r, 1);
    const ms = performance.now() - t0;
    expect(c1.filesChanged).toBe(0);
    expect(ms).toBeLessThan(2000);
  }, 120_000);
});
