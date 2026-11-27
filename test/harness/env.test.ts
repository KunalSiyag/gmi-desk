// H2-0: the harness host's spawn environment is an allowlist (harness.md §5.1, H-T2): no `*_KEY`, `*_TOKEN`,
// `*SECRET*`, no NODE_OPTIONS / LD_PRELOAD / ELECTRON_* that could change what the host runs.
import { afterEach, describe, expect, it } from 'vitest';
import { buildHostEnv, HOST_ENV_ALLOWLIST, sanitizePath, createHarnessService, type HostProcess, type HostSpawner } from '@main/services/harness';
import { createTestContext } from '../helpers/context';
import { fakeClock, scriptedGateway } from '../gateway/fakes';

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

describe('host env allowlist', () => {
  const source: Record<string, string | undefined> = {
    PATH: '/usr/local/bin:.:bin:/usr/bin::./node_modules/.bin:/home/u/.nvm/versions/node/v22/bin',
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'Europe/Berlin',
    USER: 'u',
    SHELL: '/bin/bash',
    XDG_CONFIG_HOME: '/home/u/.config',
    XDG_DATA_HOME: '/home/u/.local/share',
    XDG_CACHE_HOME: '/home/u/.cache',
    XDG_STATE_HOME: '/home/u/.local/state',
    XDG_RUNTIME_DIR: '/run/user/1000',
    GMI_DESK_LOG_LEVEL: 'debug',
    GMI_API_KEY: 'eyJhbGciOiJIUzI1NiJ9.fake.fake',
    OPENAI_API_KEY: 'sk-fake',
    ANTHROPIC_API_KEY: 'sk-ant-fake',
    AWS_SECRET_ACCESS_KEY: 'fake',
    AWS_ACCESS_KEY_ID: 'fake',
    GITHUB_TOKEN: 'ghp_fake',
    GH_TOKEN: 'ghp_fake',
    NPM_TOKEN: 'fake',
    DATABASE_PASSWORD: 'fake',
    SSH_AUTH_SOCK: '/run/user/1000/ssh-agent',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    NODE_OPTIONS: '--require /tmp/evil.js',
    LD_PRELOAD: '/tmp/evil.so',
    ELECTRON_RUN_AS_NODE: '1',
    GMI_DESK_MOCK: '1',
    GMI_DESK_USER_DATA: '/tmp/x',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5199',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    TERM: 'xterm-256color',
    EMPTY: undefined,
  };

  it('passes exactly the allowlisted names', () => {
    const env = buildHostEnv(source);
    expect(Object.keys(env).sort()).toEqual(
      ['GMI_DESK_LOG_LEVEL', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TZ', 'USER', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].sort(),
    );
    expect(Object.keys(env).filter((k) => SECRETISH.test(k))).toEqual([]);
    expect(Object.values(env).some((v) => v.includes('fake'))).toBe(false);
  });

  it('drops relative and empty PATH entries', () => {
    expect(buildHostEnv(source).PATH).toBe('/usr/local/bin:/usr/bin:/home/u/.nvm/versions/node/v22/bin');
    expect(sanitizePath('.:/a::b/c:/d', ':')).toBe('/a:/d');
    expect(sanitizePath('C:\\Windows;.;tools;D:/bin', ';')).toBe('C:\\Windows;D:/bin');
  });

  it('drops values with NUL bytes or absurd lengths', () => {
    expect(buildHostEnv({ HOME: '/home/u\0/x', LANG: 'x'.repeat(40_000), USER: 'u' })).toEqual({ USER: 'u' });
  });

  it('the allowlist itself contains nothing secret-shaped', () => {
    for (const name of HOST_ENV_ALLOWLIST) expect(SECRETISH.test(name)).toBe(false);
  });

  it("this machine's real environment yields no secret-shaped name", () => {
    const env = buildHostEnv(process.env);
    for (const name of Object.keys(env)) {
      expect((HOST_ENV_ALLOWLIST as readonly string[]).includes(name) || /^XDG_[A-Z]+_HOME$/.test(name)).toBe(true);
      expect(SECRETISH.test(name)).toBe(false);
    }
  });
});

describe('the supervisor spawns the host with that env', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('GMI_API_KEY and other keys in main’s env never reach the child', async () => {
    process.env.GMI_API_KEY = 'eyJ.test-only.not-a-key';
    process.env.SOME_SERVICE_TOKEN = 'test-only';
    process.env.NODE_OPTIONS = '--inspect';
    const t = await createTestContext({ mock: true });
    try {
      const envs: Array<Record<string, string>> = [];
      const spawn: HostSpawner = async ({ env }) => {
        envs.push(env);
        const proc: HostProcess = {
          pid: 1,
          postMessage: () => undefined,
          onMessage: () => undefined,
          onExit: () => undefined,
          stdout: null,
          stderr: null,
          kill: () => undefined,
        };
        return proc;
      };
      const clock = fakeClock();
      const service = createHarnessService(t.ctx, { gateway: scriptedGateway(), spawn, clock });
      void service.supervisor.ready().catch(() => undefined);
      await new Promise((r) => setImmediate(r));
      expect(envs).toHaveLength(1);
      const env = envs[0] as Record<string, string>;
      expect(env.GMI_API_KEY).toBeUndefined();
      expect(env.SOME_SERVICE_TOKEN).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(Object.keys(env).filter((k) => /_KEY$|_TOKEN$|SECRET/.test(k))).toEqual([]);
      service.approvals.dispose();
    } finally {
      await t.cleanup();
    }
  });
});
