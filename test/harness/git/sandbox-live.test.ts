/**
 * Live check of GitService.sandboxMounts under bubblewrap (§8.3, §16 Sandbox "git"), run only where bwrap works.
 * The argv here is a minimal stand-in for H2-E's builder: allowlisted root, no network, private /tmp, /run and HOME,
 * the worktree writable, then the git mounts in `orderGitMounts` order. Every path it binds is a throwaway dir under
 * os.tmpdir() made by the test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { orderGitMounts } from '@harness/git';
import type { SandboxGitMounts, ThreadGitRecord } from '@harness/types';
import { makeFixture, makeThread, THREAD_B, type Fixture } from './helpers';

function linkOrBind(p: string): string[] {
  if (!existsSync(p)) return [];
  return lstatSync(p).isSymbolicLink() ? ['--symlink', `usr${p}`, p] : ['--ro-bind', p, p];
}

function argv(r: ThreadGitRecord, m: SandboxGitMounts, script: string): string[] {
  const out = ['--die-with-parent', '--new-session', '--unshare-all', '--ro-bind', '/usr', '/usr'];
  for (const p of ['/bin', '/sbin', '/lib', '/lib64']) out.push(...linkOrBind(p));
  out.push('--ro-bind', '/etc', '/etc', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--dir', '/tmp/home');
  out.push('--bind', r.worktreePath, r.worktreePath);
  for (const x of orderGitMounts(m)) out.push(x.mode === 'ro' ? '--ro-bind' : '--bind', x.path, x.path);
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/home',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.invalid',
    ...m.env,
  };
  out.push('--clearenv');
  for (const [k, v] of Object.entries(env)) out.push('--setenv', k, v);
  out.push('--chdir', r.worktreePath, '--', '/bin/bash', '--noprofile', '--norc', '-c', script);
  return out;
}

function run(r: ThreadGitRecord, m: SandboxGitMounts, script: string): { code: number | null; out: string } {
  const res = spawnSync('bwrap', argv(r, m, script), { encoding: 'utf8', timeout: 30_000 });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const bwrapWorks = (() => {
  const res = spawnSync('bwrap', ['--die-with-parent', '--unshare-all', '--ro-bind', '/usr', '/usr', ...linkOrBind('/bin'), ...linkOrBind('/lib'), ...linkOrBind('/lib64'), '/bin/true'], { timeout: 10_000 });
  return res.status === 0;
})();

let f: Fixture;
afterEach(() => f?.cleanup());

describe.skipIf(!bwrapWorks)('git inside the sandbox with sandboxMounts (live bwrap)', () => {
  it('commits on its own branch only; pointer files, other refs, objects and other threads are read-only', async () => {
    f = makeFixture();
    const r = await makeThread(f);
    const other = await makeThread(f, THREAD_B, 'other');
    const m = await f.git.sandboxMounts(r);
    const pointer = readFileSync(join(r.worktreePath, '.git'), 'utf8');

    const ok = run(r, m, 'echo agent > agent.txt && git add agent.txt && git commit -q -m "agent commit" && git log -1 --format=%s');
    expect(ok.out).toContain('agent commit');
    expect(ok.code).toBe(0);

    const attempts: Array<[string, string]> = [
      ['rewrite .git', `echo "gitdir: /tmp/evil" > .git`],
      ['rewrite gitdir', `echo /tmp/evil > ${join(r.gitDir, 'gitdir')}`],
      ['rewrite commondir', `echo /tmp/evil > ${join(r.gitDir, 'commondir')}`],
      ['move main', 'git branch -f main HEAD'],
      ['delete objects', `rm -rf ${join(r.commonDir, 'objects')}/info`],
      ['unlock another thread', `git worktree unlock ${other.worktreePath}`],
      ['remove another thread', `git worktree remove --force --force ${other.worktreePath}`],
      ['write config', `git config core.fsmonitor "touch /tmp/x"`],
      ['other thread ref', `git update-ref refs/heads/${other.branch} HEAD`],
      ['hooks', `echo x > ${join(r.commonDir, 'hooks', 'pre-commit')}`],
    ];
    for (const [name, script] of attempts) {
      const res = run(r, m, script);
      expect(res.code, `${name}: ${res.out}`).not.toBe(0);
    }
    run(r, m, 'git worktree prune'); // may "succeed" as a no-op: B is locked and the common dir is read-only
    expect(existsSync(other.gitDir)).toBe(true);
    expect(readFileSync(join(r.worktreePath, '.git'), 'utf8')).toBe(pointer);
    expect(f.sh(['rev-parse', 'main']).trim()).toBe(r.baseSha);
    expect(f.sh(['rev-parse', `refs/heads/${other.branch}`]).trim()).toBe(r.baseSha);
    expect(f.sh(['worktree', 'list', '--porcelain'])).toContain(other.worktreePath);
    await expect(f.git.verify(r)).resolves.toBeUndefined();
    await expect(f.git.verify(other)).resolves.toBeUndefined();

    // The commit's objects went to the thread object dir; the host imports them, verified.
    const tip = f.sh(['rev-parse', `refs/heads/${r.branch}`]).trim();
    expect(() => f.sh(['cat-file', '-e', tip])).toThrow();
    expect((await f.git.importObjects(r)).imported).toBe(3);
    expect(f.sh(['log', '-1', '--format=%s', tip]).trim()).toBe('agent commit');
    f.sh(['fsck', '--no-dangling', '--connectivity-only']);
  });

  it('`git worktree prune` in thread A leaves thread B working', async () => {
    f = makeFixture();
    const a = await makeThread(f);
    const b = await makeThread(f, THREAD_B, 'b');
    const ma = await f.git.sandboxMounts(a);
    run(a, ma, 'git worktree prune');
    const mb = await f.git.sandboxMounts(b);
    const res = run(b, mb, 'echo b > b.txt && git add b.txt && git commit -q -m b && git status --short');
    expect(res.code, res.out).toBe(0);
  });
});
