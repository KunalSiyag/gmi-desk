import { describe, expect, it } from 'vitest';
import { buildSandboxEnv, cleanPath, SANDBOX_PROXY_URL } from '@harness/sandbox/env';

const HOST = {
  PATH: '/home/u/.local/bin:.:bin:/usr/bin::/bin',
  HOME: '/home/u',
  USER: 'u',
  LOGNAME: 'u',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  GMI_API_KEY: 'eyJ.secret',
  OPENAI_API_KEY: 'sk-x',
  AWS_SECRET_ACCESS_KEY: 'x',
  GITHUB_TOKEN: 'ghp_x',
  SSH_AUTH_SOCK: '/run/user/1000/ssh',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  LD_PRELOAD: '/tmp/evil.so',
  NODE_OPTIONS: '--require /tmp/evil.js',
  BASH_ENV: '/tmp/evil.sh',
  MY_FLAG: '1',
  MY_TOKEN: 't',
};

describe('sandbox env (§8.4)', () => {
  it('is an allowlist: nothing else of the host env passes', () => {
    const env = buildSandboxEnv({ hostEnv: HOST, home: '/home/u', cacheDir: null, network: 'off' });
    expect(Object.keys(env).sort()).toEqual(['CI', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'NO_COLOR', 'PAGER', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'USER']);
    expect(env.PATH).toBe('/home/u/.local/bin:/usr/bin:/bin');
    expect(env.TERM).toBe('dumb');
    expect(env.SHELL).toBe('/bin/bash');
    expect(Object.keys(env).some((k) => /KEY|TOKEN|SECRET|SSH_AUTH|DBUS|DOCKER|LD_|NODE_OPTIONS|BASH_ENV/.test(k))).toBe(false);
  });

  it('sets the caches, git env and author', () => {
    const env = buildSandboxEnv({
      hostEnv: HOST,
      home: '/home/u',
      cacheDir: '/data/cache/th1',
      gitEnv: { GIT_OBJECT_DIRECTORY: '/data/objects/th1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0', NOT_GIT: 'x' },
      gitAuthor: { name: 'Ada', email: 'ada@example.com' },
      network: 'off',
    });
    expect(env).toMatchObject({
      XDG_CACHE_HOME: '/home/u/.cache',
      npm_config_cache: '/home/u/.npm',
      PIP_CACHE_DIR: '/home/u/.cache/pip',
      GIT_OBJECT_DIRECTORY: '/data/objects/th1',
      GIT_CONFIG_KEY_0: 'gc.auto',
      GIT_AUTHOR_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
    expect(env.NOT_GIT).toBeUndefined();
  });

  it('sets the proxy variables only for the proxy, with NO_PROXY empty', () => {
    const on = buildSandboxEnv({ hostEnv: HOST, home: '/home/u', cacheDir: null, network: 'proxy' });
    for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) expect(on[n]).toBe(SANDBOX_PROXY_URL);
    expect(on.NO_PROXY).toBe('');
    const shared = buildSandboxEnv({ hostEnv: HOST, home: '/home/u', cacheDir: null, network: 'shared' });
    expect(shared.HTTP_PROXY).toBeUndefined();
  });

  it('project names pass; secret-like names only when main confirmed them; dangerous names never', () => {
    const env = buildSandboxEnv({ hostEnv: HOST, home: '/home/u', cacheDir: null, network: 'off', projectNames: ['MY_FLAG', 'MY_TOKEN', 'GMI_API_KEY', 'LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'bad-name', 'MISSING'] });
    expect(env.MY_FLAG).toBe('1');
    expect(env.MY_TOKEN).toBeUndefined();
    expect(env.GMI_API_KEY).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
    const confirmed = buildSandboxEnv({ hostEnv: HOST, home: '/home/u', cacheDir: null, network: 'off', projectNames: ['MY_TOKEN'], confirmedSecretNames: ['MY_TOKEN'] });
    expect(confirmed.MY_TOKEN).toBe('t');
  });

  it('cleanPath drops relative and empty entries', () => {
    expect(cleanPath('.:/a::b/c:/d')).toBe('/a:/d');
  });
});
