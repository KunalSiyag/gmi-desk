import { describe, expect, it } from 'vitest';
import {
  assertGitValue,
  buildGitInvocation,
  execCapableKeys,
  GIT_SAFE_CONFIG,
  neutralizeDrivers,
  parseGitPointer,
  type GitSafeOptions,
} from '@shared/lib/git-safe';

const baseEnv = {
  PATH: '/usr/bin:.:relative/bin:/bin',
  HOME: '/home/u',
  USER: 'u',
  GIT_DIR: '/evil',
  GIT_EXTERNAL_DIFF: 'evil',
  GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
  GIT_SSH_COMMAND: 'evil',
  GMI_API_KEY: 'secret',
  SSH_AUTH_SOCK: '/run/user/1000/ssh',
  XDG_CONFIG_HOME: '/home/u/.config',
};

function build(over: Partial<GitSafeOptions> = {}) {
  return buildGitInvocation({ profile: 'strict', gitDir: '/repo/.git/worktrees/w', commonDir: '/repo/.git', workTree: '/wt', args: ['status'], baseEnv, ...over });
}

describe('git-safe argv (§8.2)', () => {
  it('passes the recorded paths explicitly and every safe -c before the subcommand', () => {
    const { argv } = build({ paths: ['a.txt'] });
    expect(argv.slice(0, 3)).toEqual(['--no-pager', '--git-dir=/repo/.git/worktrees/w', '--work-tree=/wt']);
    const sub = argv.indexOf('status');
    const cs = argv.slice(3, sub).filter((a) => a !== '-c');
    expect(cs).toEqual([...GIT_SAFE_CONFIG]);
    for (const kv of [
      'core.fsmonitor=false',
      'core.hooksPath=/dev/null',
      'core.attributesFile=/dev/null',
      'diff.external=',
      'core.pager=cat',
      'commit.gpgSign=false',
      'tag.gpgSign=false',
      'gpg.program=false',
      'credential.helper=',
      'protocol.file.allow=never',
      'core.sshCommand=false',
      'gc.auto=0',
    ]) {
      expect(cs).toContain(kv);
    }
    expect(argv.slice(sub)).toEqual(['status', '--', 'a.txt']);
  });

  it('strict: env is an allowlist with global and system config off and literal pathspecs; no inherited GIT_*', () => {
    const { env } = build();
    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_COMMON_DIR: '/repo/.git',
      GIT_AUTHOR_NAME: 'GMI Desk',
      LC_ALL: 'C',
    });
    for (const k of ['GIT_DIR', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GMI_API_KEY', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME']) expect(env[k]).toBeUndefined();
  });

  it('repo and user profiles keep the global config; only user keeps signing (and its agent sockets)', () => {
    const repo = build({ profile: 'repo' });
    expect(repo.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(repo.env.XDG_CONFIG_HOME).toBe('/home/u/.config');
    expect(repo.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(repo.argv).toContain('commit.gpgSign=false');
    const user = build({ profile: 'user' });
    expect(user.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(user.env.SSH_AUTH_SOCK).toBe('/run/user/1000/ssh');
    expect(user.argv).not.toContain('commit.gpgSign=false');
    expect(user.argv).not.toContain('gpg.program=false');
    expect(user.argv).toContain('core.hooksPath=/dev/null');
    expect(user.env.GIT_AUTHOR_NAME).toBeUndefined();
  });

  it('never turns values into options', () => {
    expect(() => build({ paths: ['--output=/tmp/x'] })).toThrow(/cannot start with/);
    expect(() => build({ paths: ['a\0b'] })).toThrow();
    expect(() => assertGitValue('--upload-pack=x')).toThrow();
    expect(() => assertGitValue('main\nrefs')).toThrow();
    expect(assertGitValue('main')).toBe('main');
    expect(() => build({ gitDir: 'relative/.git' })).toThrow(/not absolute/);
    expect(() => build({ workTree: '/wt\n' })).toThrow();
    expect(() => build({ alternates: ['/a:b'] })).toThrow();
  });

  it('carries index, object dirs and extra config through env (any characters are safe there)', () => {
    const { env, argv } = build({ indexFile: '/snap/index-t', objectDir: '/o', alternates: ['/repo/.git/objects'], config: [['filter.we"ird=name.clean', '']] });
    expect(env).toMatchObject({ GIT_INDEX_FILE: '/snap/index-t', GIT_OBJECT_DIRECTORY: '/o', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/repo/.git/objects', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.we"ird=name.clean', GIT_CONFIG_VALUE_0: '' });
    expect(argv.join(' ')).not.toContain('we"ird');
    expect(() => build({ config: [['not a key', 'x']] })).toThrow();
  });

  it('neutralises every filter and diff driver named in the repo config', () => {
    expect(neutralizeDrivers(['filter.lfs.clean', 'filter.lfs.smudge', 'filter.a.b.process', 'diff.x.textconv', 'diff.external', 'core.pager'])).toEqual([
      ['filter.lfs.clean', ''],
      ['filter.lfs.smudge', ''],
      ['filter.lfs.process', ''],
      ['filter.lfs.required', 'false'],
      ['filter.a.b.clean', ''],
      ['filter.a.b.smudge', ''],
      ['filter.a.b.process', ''],
      ['filter.a.b.required', 'false'],
      ['diff.x.textconv', ''],
      ['diff.x.command', ''],
    ]);
  });

  it('lists exec-capable repo-local keys and parses pointer files', () => {
    expect(
      execCapableKeys(['user.name', 'filter.lfs.clean', 'diff.x.textconv', 'merge.ours.driver', 'core.pager', 'core.sshCommand', 'gpg.format', 'credential.helper', 'include.path', 'includeIf.gitdir:/x/.path', 'core.autocrlf']),
    ).toEqual(['core.pager', 'core.sshcommand', 'credential.helper', 'diff.x.textconv', 'filter.lfs.clean', 'gpg.format', 'include.path', 'includeif.gitdir:/x/.path', 'merge.ours.driver']);
    expect(parseGitPointer('gitdir: /repo/.git/worktrees/w\n')).toBe('/repo/.git/worktrees/w');
    expect(parseGitPointer('ref: refs/heads/main\n')).toBeNull();
  });
});
