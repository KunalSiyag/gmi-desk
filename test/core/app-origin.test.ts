// The renderer's origin (app://gmi-desk/), the IPC sender check, dev server URL validation and the packaged-mode
// environment rule (findings foundation-2, foundation-5, foundation-8).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_INDEX_URL, makeAppUrlCheck, resolveAppFile, resolveDevServerUrl } from '@main/core/app-origin';
import { DEV_ENV_VARS, stripDevEnv } from '@main/core/dev-env';

describe('resolveAppFile', () => {
  const root = '/opt/GMI Desk/resources/app/dist/renderer';

  it('maps app://gmi-desk/ paths to files inside the renderer folder', () => {
    expect(resolveAppFile(root, APP_INDEX_URL)).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://gmi-desk/')).toBe(join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://gmi-desk/assets/index-abc.js?v=1#x')).toBe(join(root, 'assets', 'index-abc.js'));
    expect(resolveAppFile(root, 'app://gmi-desk/assets/inter%20latin.woff2')).toBe(join(root, 'assets', 'inter latin.woff2'));
  });

  it('works for install paths with #, ?, %, spaces and non-ASCII characters', () => {
    for (const dir of ['/home/u/C#dev/gmi-desk/dist/renderer', '/home/u/what?/dist/renderer', '/home/u/100%done/dist/renderer', '/Users/zoë/Apps/GMI Desk/dist/renderer']) {
      expect(resolveAppFile(dir, APP_INDEX_URL)).toBe(join(dir, 'index.html'));
    }
  });

  it('refuses traversal, encoded separators, other hosts and schemes', () => {
    expect(resolveAppFile(root, 'app://gmi-desk/../../../../etc/passwd')).toBe(join(root, 'etc', 'passwd')); // URL parsing collapses dot segments
    expect(resolveAppFile(root, 'app://gmi-desk/..%2F..%2Fsecure%2Finference.key.bin')).toBeNull();
    expect(resolveAppFile(root, 'app://gmi-desk/%2E%2E/x')).toBe(join(root, 'x')); // likewise for encoded dots
    expect(resolveAppFile(root, 'app://gmi-desk/a%5C..%5C..%5Cx')).toBeNull();
    expect(resolveAppFile(root, 'app://gmi-desk/x%00.js')).toBeNull();
    expect(resolveAppFile(root, 'app://gmi-desk/index.html:stream')).toBeNull();
    expect(resolveAppFile(root, 'app://gmi-desk/%E0%A4%A')).toBeNull(); // malformed escape
    expect(resolveAppFile(root, 'app://other/index.html')).toBeNull();
    expect(resolveAppFile(root, 'app://user:pw@gmi-desk/index.html')).toBeNull();
    expect(resolveAppFile(root, pathToFileURL(join(root, 'index.html')).href)).toBeNull();
    expect(resolveAppFile(root, 'not a url')).toBeNull();
  });
});

describe('makeAppUrlCheck', () => {
  it('trusts exactly the app:// origin in production, whatever the install path', () => {
    const check = makeAppUrlCheck({ devServerUrl: null, packaged: true });
    expect(check(APP_INDEX_URL)).toBe(true);
    expect(check('app://gmi-desk/index.html#/chat')).toBe(true);
    expect(check('app://gmi-desk/assets/x.js')).toBe(true);
    // file:// pages (any path, any host) are no longer the app.
    expect(check(pathToFileURL('/home/u/C#dev/gmi-desk/dist/renderer/index.html').href)).toBe(false);
    expect(check('file:///opt/app/dist/renderer/index.html')).toBe(false);
    expect(check('file://evil.host/opt/app/dist/renderer/index.html')).toBe(false);
    expect(check('app://other/index.html')).toBe(false);
    expect(check('app://user@gmi-desk/index.html')).toBe(false);
    expect(check('https://gmi-desk/index.html')).toBe(false);
    expect(check('http://127.0.0.1:5199/')).toBe(false);
    expect(check('')).toBe(false);
  });

  it('trusts the loopback dev server only when not packaged', () => {
    const dev = makeAppUrlCheck({ devServerUrl: 'http://127.0.0.1:5199/', packaged: false });
    expect(dev('http://127.0.0.1:5199/')).toBe(true);
    expect(dev('http://127.0.0.1:5199/src/main.tsx')).toBe(true);
    expect(dev('http://127.0.0.1:5200/')).toBe(false);
    expect(dev('http://localhost:5199/')).toBe(false);
    expect(dev(APP_INDEX_URL)).toBe(true);
    expect(makeAppUrlCheck({ devServerUrl: 'http://127.0.0.1:5199/', packaged: true })('http://127.0.0.1:5199/')).toBe(false);
    // A remote "dev server" never gets IPC trust.
    const remote = makeAppUrlCheck({ devServerUrl: 'https://attacker.example/', packaged: false });
    expect(remote('https://attacker.example/')).toBe(false);
  });
});

describe('resolveDevServerUrl', () => {
  it('accepts loopback http URLs with a port, in unpackaged runs only', () => {
    expect(resolveDevServerUrl('http://127.0.0.1:5199/', false)).toBe('http://127.0.0.1:5199/');
    expect(resolveDevServerUrl(' http://localhost:5173 ', false)).toBe('http://localhost:5173');
    expect(resolveDevServerUrl('http://127.0.0.1:5199/', true)).toBeNull();
    expect(resolveDevServerUrl(undefined, false)).toBeNull();
    expect(resolveDevServerUrl('', false)).toBeNull();
  });

  it('rejects remote, https, credentialed and port-less URLs', () => {
    for (const raw of [
      'https://attacker.example/',
      'http://attacker.example:5199/',
      'https://127.0.0.1:5199/',
      'http://127.0.0.1/',
      'http://user:pw@127.0.0.1:5199/',
      'http://127.0.0.1.attacker.example:5199/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(resolveDevServerUrl(raw, false), raw).toBeNull();
    }
  });
});

describe('stripDevEnv', () => {
  it('removes every developer override in packaged builds and reports the names', () => {
    const env: Record<string, string | undefined> = {
      VITE_DEV_SERVER_URL: 'https://attacker.example/',
      GMI_DESK_MOCK: '1',
      GMI_DESK_USER_DATA: '/tmp/other',
      GMI_DESK_SHOTS: '/tmp/shots',
      GMI_DESK_DEVTOOLS: '1',
      GMI_API_KEY: 'sk-test',
      GMI_DESK_LOG_LEVEL: 'debug',
      PATH: '/usr/bin',
    };
    const removed = stripDevEnv(env, true);
    expect(removed.sort()).toEqual(['GMI_API_KEY', 'GMI_DESK_DEVTOOLS', 'GMI_DESK_MOCK', 'GMI_DESK_SHOTS', 'GMI_DESK_USER_DATA', 'VITE_DEV_SERVER_URL']);
    for (const name of DEV_ENV_VARS) expect(env[name]).toBeUndefined();
    expect(env).toEqual({ GMI_DESK_LOG_LEVEL: 'debug', PATH: '/usr/bin' });
  });

  it('leaves the environment alone when not packaged', () => {
    const env = { VITE_DEV_SERVER_URL: 'http://127.0.0.1:5199/', GMI_DESK_MOCK: '1' };
    expect(stripDevEnv(env, false)).toEqual([]);
    expect(env).toEqual({ VITE_DEV_SERVER_URL: 'http://127.0.0.1:5199/', GMI_DESK_MOCK: '1' });
  });
});
