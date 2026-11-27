// PreviewHost policy (compute.md §8.4, §12 T5/T6): URL builder, host lock, private-network block, exact-host token
// injection, plus the Electron glue against a fake Electron (partition, webPreferences, permission and popup denial,
// navigation lock incl. did-start-navigation, inject updates, activity from input only). The real-Electron checks
// (app:// not handled in the preview partition, Local Network Access denied) are in preview-host.smoke.mjs.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import {
  buildPreviewUrl,
  checkPreviewPath,
  clampPreviewBounds,
  createElectronPreviewHost,
  scalePreviewBounds,
  hostnameToResolve,
  isAllowedPreviewNavigation,
  isPrivateHostname,
  isValidPreviewPort,
  PREVIEW_PARTITION_PREFIX,
  previewHostFor,
  previewRequestDecision,
  previewRequestHeaders,
  resolvedEndpointsArePublic,
  shouldInjectPreviewToken,
  type PreviewElectron,
  type PreviewHostEvent,
} from '@main/core/preview-host';
import type { Logger } from '@main/core/logger';

const KEY = 'sbx0abc123';
const DOMAIN = 'sandbox.gmi.example';
const HOST = `8000-${KEY}.${DOMAIN}`;
const INJECT = { name: 'traffic-access-token' as const, value: 'tt-secret' };

const invalidInput = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GmiError);
    expect((error as GmiError).code).toBe('invalid_input');
    return;
  }
  throw new Error('expected invalid_input');
};

describe('preview URL builder', () => {
  it('builds https://{port}-{sandbox_key}.{domain}{path} in lower case', () => {
    expect(buildPreviewUrl({ port: 8000, sandboxKey: KEY, domain: DOMAIN, path: '/app?x=1#h' })).toEqual({
      url: `https://${HOST}/app?x=1#h`,
      allowedHost: HOST,
    });
    expect(buildPreviewUrl({ port: 3000, sandboxKey: 'SBX0ABC', domain: 'Sandbox.GMI.example' }).url).toBe('https://3000-sbx0abc.sandbox.gmi.example/');
  });

  it('port range: integers 1..65535 only', () => {
    for (const ok of [1, 80, 8000, 65535]) expect(isValidPreviewPort(ok)).toBe(true);
    for (const bad of [0, -1, 65536, 80.5, Number.NaN, Number.POSITIVE_INFINITY, '80' as unknown as number]) {
      expect(isValidPreviewPort(bad)).toBe(false);
      invalidInput(() => previewHostFor(bad, KEY, DOMAIN));
    }
  });

  it('rejects malformed sandbox keys and domains (never composed by the app)', () => {
    for (const key of ['', '-abc', 'abc-', 'a.b', 'a/b', 'a@b', 'x'.repeat(64), 'a b']) invalidInput(() => previewHostFor(80, key, DOMAIN));
    for (const domain of ['', 'localhost', 'evil.example/', 'a..b', '.example.com', 'example.com.', 'ex ample.com', 'a@b.com']) {
      invalidInput(() => previewHostFor(80, KEY, domain));
    }
    // The first label ({port}-{key}) must stay a DNS label (≤ 63 characters).
    invalidInput(() => previewHostFor(65535, 'k'.repeat(60), DOMAIN));
  });

  it('paths that would change the host are refused or stay on the host', () => {
    for (const bad of ['@evil.example/', '.evil.example/', '//evil.example/', '/\\evil.example/', '\\\\evil.example', 'evil', 'https://evil.example/']) {
      invalidInput(() => buildPreviewUrl({ port: 8000, sandboxKey: KEY, domain: DOMAIN, path: bad }));
    }
    for (const okPath of ['/@evil.example/', '/.evil.example/', '/%2F%2Fevil.example', '/a/../../b', '/?next=//evil.example']) {
      const { url } = buildPreviewUrl({ port: 8000, sandboxKey: KEY, domain: DOMAIN, path: okPath });
      expect(new URL(url).host).toBe(HOST);
    }
  });

  it('path rules: control characters, NUL and length', () => {
    expect(checkPreviewPath(undefined)).toBe('/');
    expect(checkPreviewPath('')).toBe('/');
    for (const bad of ['/a\u0000b', '/a\nb', '/a\tb', '/a\u007fb', `/${'a'.repeat(2048)}`, 42 as unknown as string]) invalidInput(() => checkPreviewPath(bad));
    expect(checkPreviewPath(`/${'a'.repeat(2047)}`)).toHaveLength(2048);
  });
});

describe('top-level navigation lock (exact host)', () => {
  it('allows https on exactly the preview host', () => {
    expect(isAllowedPreviewNavigation(`https://${HOST}/x?y=1`, HOST)).toBe(true);
    expect(isAllowedPreviewNavigation(`https://${HOST.toUpperCase()}/`, HOST)).toBe(true);
    expect(isAllowedPreviewNavigation(`https://${HOST}:443/`, HOST)).toBe(true);
  });

  it('blocks other hosts, ports, schemes and credentials', () => {
    for (const url of [
      `http://${HOST}/`,
      `https://${HOST}:8443/`,
      `https://evil.example/`,
      `https://${HOST}.evil.example/`,
      `https://x.${HOST}/`,
      `https://9000-${KEY}.${DOMAIN}/`,
      `https://${KEY}.${DOMAIN}/`, // the data-plane host itself
      `https://user:pw@${HOST}/`,
      `https://${HOST}@evil.example/`,
      `wss://${HOST}/`,
      'app://gmi-desk/index.html',
      'gmi-media://local/x.png',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'about:blank',
      'not a url',
    ]) {
      expect(isAllowedPreviewNavigation(url, HOST), url).toBe(false);
    }
  });
});

describe('private network block', () => {
  it('IPv4: loopback, RFC 1918, CGNAT, link-local, this-network, multicast, broadcast', () => {
    for (const h of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
      '192.0.0.8',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
    for (const h of ['8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1', '1.1.1.1']) {
      expect(isPrivateHostname(h), h).toBe(false);
    }
  });

  it('IPv6: loopback, unspecified, ULA, link-local, site-local, multicast, IPv4-mapped / compatible / NAT64 / 6to4', () => {
    for (const h of [
      '[::1]',
      '::1',
      '[::]',
      '[fc00::1]',
      '[fd12:3456:789a::1]',
      '[fe80::1]',
      '[febf::1]',
      '[fec0::1]',
      '[ff02::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[::ffff:10.1.2.3]',
      '[::ffff:a9fe:a9fe]',
      '[::127.0.0.1]',
      '[64:ff9b::192.168.0.1]',
      '[2002:c0a8:0101::1]',
      '[0:0:0:0:0:0:0:1]',
      '[::1%25eth0]',
      '[zzzz::1]',
      '[1:2:3:4:5:6:7:8:9]',
    ]) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
    for (const h of ['[2606:4700::1111]', '[2001:db8::1]', '[::ffff:8.8.8.8]', '[64:ff9b::8.8.8.8]', '[2002:0808:0808::1]']) {
      expect(isPrivateHostname(h), h).toBe(false);
    }
  });

  it('names: localhost, .local, .internal and other LAN suffixes, single labels; public names pass', () => {
    for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'nas.lan', 'router.home.arpa', 'box.localdomain', 'intranet', '']) {
      expect(isPrivateHostname(h), h).toBe(true);
    }
    for (const h of [HOST, 'pypi.org', 'example.com', 'local.example.com', 'internal.example.com']) expect(isPrivateHostname(h), h).toBe(false);
  });

  it('alternative IPv4 spellings are normalised by URL parsing before the check', () => {
    for (const raw of ['http://0x7f.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://0/']) {
      expect(previewRequestDecision(raw), raw).toEqual({ cancel: true, reason: 'private_network' });
    }
  });

  it('request filter: http(s)/ws(s) to public hosts pass; other schemes and private hosts are cancelled', () => {
    for (const ok of [`https://${HOST}/`, `wss://${HOST}/hmr`, 'https://cdn.example.com/x.js', 'http://example.com/', 'ws://example.com/', 'blob:https://x.example/uuid', 'data:text/plain,hi', 'about:blank']) {
      expect(previewRequestDecision(ok), ok).toEqual({ cancel: false });
    }
    for (const scheme of ['app://gmi-desk/index.html', 'gmi-media://local/a.png', 'file:///etc/passwd', 'chrome://gpu', 'devtools://devtools/x', 'ftp://example.com/', 'not a url']) {
      expect(previewRequestDecision(scheme), scheme).toEqual({ cancel: true, reason: 'scheme' });
    }
    for (const priv of ['http://localhost:5199/', 'http://127.0.0.1:5199/@vite/client', 'ws://127.0.0.1:5199/', 'https://192.168.1.1/', 'http://printer.local/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8080/']) {
      expect(previewRequestDecision(priv), priv).toEqual({ cancel: true, reason: 'private_network' });
    }
  });
});

describe('DNS-rebinding check (Electron 45 does not enforce Local Network Access)', () => {
  it('names on network schemes are resolved; IP literals and inert schemes are not', () => {
    expect(hostnameToResolve(`https://${HOST}/x`)).toBe(HOST);
    expect(hostnameToResolve('wss://Rebind.Attacker.example/')).toBe('rebind.attacker.example');
    for (const raw of ['https://8.8.8.8/', 'https://[2606:4700::1111]/', 'data:text/plain,x', 'blob:https://x.example/1', 'about:blank', 'nope']) {
      expect(hostnameToResolve(raw), raw).toBeNull();
    }
  });

  it('every resolved address must be public; one private answer or no answer refuses', () => {
    expect(resolvedEndpointsArePublic(['203.0.113.10'])).toBe(true);
    expect(resolvedEndpointsArePublic(['203.0.113.10', '2606:4700::1111'])).toBe(true);
    expect(resolvedEndpointsArePublic(['127.0.0.1'])).toBe(false);
    expect(resolvedEndpointsArePublic(['203.0.113.10', '192.168.1.5'])).toBe(false);
    expect(resolvedEndpointsArePublic(['::1'])).toBe(false);
    expect(resolvedEndpointsArePublic(['::ffff:127.0.0.1'])).toBe(false);
    expect(resolvedEndpointsArePublic(['fe80::1'])).toBe(false);
    expect(resolvedEndpointsArePublic([])).toBe(false);
    expect(resolvedEndpointsArePublic([''])).toBe(false);
  });
});

describe('token injection (exact host only, never X-Access-Token)', () => {
  it('injects traffic-access-token on https/wss to exactly the preview host', () => {
    expect(previewRequestHeaders(`https://${HOST}/api`, { Accept: '*/*' }, HOST, INJECT)).toEqual({ Accept: '*/*', 'traffic-access-token': 'tt-secret' });
    expect(previewRequestHeaders(`wss://${HOST}/hmr`, {}, HOST, INJECT)).toEqual({ 'traffic-access-token': 'tt-secret' });
  });

  it('never on another host, a sub/superdomain, another port, or cleartext', () => {
    for (const url of [
      'https://evil.example/',
      `https://${HOST}.evil.example/`,
      `https://a.${HOST}/`,
      `https://${KEY}.${DOMAIN}/`,
      `https://${HOST}:8443/`,
      `http://${HOST}/`,
      `ws://${HOST}/`,
      `https://evil.example/@${HOST}/`,
      `https://${HOST}@evil.example/`,
    ]) {
      expect(shouldInjectPreviewToken(url, HOST), url).toBe(false);
      expect(previewRequestHeaders(url, {}, HOST, INJECT), url).toEqual({});
    }
  });

  it('a page-set copy is replaced on the host and removed elsewhere; X-Access-Token is never added', () => {
    const headers = { 'Traffic-Access-Token': 'page-value', 'X-Other': '1' };
    expect(previewRequestHeaders(`https://${HOST}/`, headers, HOST, INJECT)).toEqual({ 'X-Other': '1', 'traffic-access-token': 'tt-secret' });
    expect(previewRequestHeaders('https://evil.example/', headers, HOST, INJECT)).toEqual({ 'X-Other': '1' });
    const out = previewRequestHeaders(`https://${HOST}/`, {}, HOST, INJECT);
    expect(Object.keys(out).map((k) => k.toLowerCase())).not.toContain('x-access-token');
    // No inject (secure: false sandbox) → nothing added.
    expect(previewRequestHeaders(`https://${HOST}/`, {}, HOST, null)).toEqual({});
    expect(previewRequestHeaders(`https://${HOST}/`, {}, HOST, { name: 'traffic-access-token', value: '' })).toEqual({});
  });
});

describe('bounds', () => {
  it('rounds, clamps to the content area and refuses non-finite values', () => {
    expect(clampPreviewBounds({ x: 10.4, y: 20.6, width: 300.5, height: 200 }, { width: 1360, height: 880 })).toEqual({ x: 10, y: 21, width: 301, height: 200 });
    expect(clampPreviewBounds({ x: -50, y: -5, width: 99999, height: 99999 }, { width: 1360, height: 880 })).toEqual({ x: 0, y: 0, width: 1360, height: 880 });
    expect(clampPreviewBounds({ x: 2000, y: 0, width: 100, height: 100 }, { width: 1360, height: 880 })).toEqual({ x: 1360, y: 0, width: 0, height: 100 });
    expect(clampPreviewBounds({ x: Number.NaN, y: 0, width: 1, height: 1 }, { width: 10, height: 10 })).toBeNull();
  });

  it('review: scales CSS px to DIP by the main page zoom (edges, not sizes)', () => {
    expect(scalePreviewBounds({ x: 100, y: 100, width: 400, height: 300 }, 1.25)).toEqual({ x: 125, y: 125, width: 500, height: 375 });
    expect(scalePreviewBounds({ x: 100, y: 100, width: 400, height: 300 }, 0.8)).toEqual({ x: 80, y: 80, width: 320, height: 240 });
    expect(scalePreviewBounds({ x: 1, y: 1, width: 1, height: 1 }, 1.5)).toEqual({ x: 2, y: 2, width: 1, height: 1 });
    const b = { x: 10, y: 20, width: 30, height: 40 };
    expect(scalePreviewBounds(b, 1)).toBe(b);
    expect(scalePreviewBounds(b, Number.NaN)).toBe(b);
    expect(scalePreviewBounds(b, 0)).toBe(b);
  });
});

// ─── Electron glue against a fake Electron ─────────────────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

class FakeEvent {
  defaultPrevented = false;
  constructor(readonly props: Record<string, unknown> = {}) {
    Object.assign(this, props);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

function fakeElectron() {
  const sessions: Array<{ partition: string; options: unknown; s: ReturnType<typeof makeSession> }> = [];
  const views: FakeView[] = [];

  function makeSession() {
    const emitter = new EventEmitter();
    const s = {
      beforeRequest: null as Handler | null,
      beforeSendHeaders: null as Handler | null,
      permissionRequest: null as Handler | null,
      permissionCheck: null as Handler | null,
      devicePermission: null as Handler | null,
      cleared: 0,
      resolves: [] as string[],
      dns: new Map<string, string[] | Error>(),
      async resolveHost(name: string) {
        s.resolves.push(name);
        const answer = s.dns.get(name) ?? ['203.0.113.10'];
        if (answer instanceof Error) throw answer;
        return { endpoints: answer.map((address) => ({ address, family: address.includes(':') ? 'ipv6' : 'ipv4' })) };
      },
      webRequest: {
        onBeforeRequest(h: Handler | null) {
          s.beforeRequest = h;
        },
        onBeforeSendHeaders(h: Handler | null) {
          s.beforeSendHeaders = h;
        },
      },
      setPermissionRequestHandler(h: Handler) {
        s.permissionRequest = h;
      },
      setPermissionCheckHandler(h: Handler) {
        s.permissionCheck = h;
      },
      setDevicePermissionHandler(h: Handler) {
        s.devicePermission = h;
      },
      on: (name: string, h: Handler) => emitter.on(name, h),
      emit: (name: string, ...args: unknown[]) => emitter.emit(name, ...args),
      clearStorageData: async () => {
        s.cleared++;
      },
      clearCache: async () => undefined,
    };
    return s;
  }

  class FakeContents extends EventEmitter {
    destroyed = false;
    url = '';
    title = '';
    loads: string[] = [];
    stops = 0;
    reloads = 0;
    openHandler: Handler | null = null;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => undefined, goForward: () => undefined };
    isDestroyed = () => this.destroyed;
    setWindowOpenHandler(h: Handler) {
      this.openHandler = h;
    }
    async loadURL(url: string) {
      this.loads.push(url);
    }
    getURL = () => this.url;
    getTitle = () => this.title;
    stop() {
      this.stops++;
    }
    reload() {
      this.reloads++;
    }
    close() {
      this.destroyed = true;
    }
    async capturePage() {
      return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,AAAA' };
    }
  }

  class FakeView {
    webContents = new FakeContents();
    visible = true;
    bounds: unknown = null;
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      views.push(this);
    }
    setVisible(v: boolean) {
      this.visible = v;
    }
    setBounds(b: unknown) {
      this.bounds = b;
    }
  }

  const electron = {
    WebContentsView: FakeView,
    session: {
      fromPartition(partition: string, options?: unknown) {
        const s = makeSession();
        sessions.push({ partition, options, s });
        return s;
      },
    },
  } as unknown as PreviewElectron;

  return { electron, sessions, views };
}

function fakeWindow() {
  const zoomRef = { value: 1 };
  const emitter = new EventEmitter();
  const children: unknown[] = [];
  return {
    children,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getContentSize: () => [1360, 880],
    webContents: {
      getZoomFactor(): number {
        return zoomRef.value;
      },
    },
    contentView: {
      addChildView: (v: unknown) => children.push(v),
      removeChildView: (v: unknown) => children.splice(children.indexOf(v), 1),
    },
    once: (name: string, h: Handler) => emitter.once(name, h),
    emit: (name: string) => emitter.emit(name),
    setZoom: (z: number) => (zoomRef.value = z),
  };
}

const silentLog: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => silentLog };

function setup() {
  const fake = fakeElectron();
  const win = fakeWindow();
  let clock = 0;
  const host = createElectronPreviewHost({
    electron: fake.electron,
    getWindow: () => win as never,
    devTools: false,
    log: silentLog,
    randomId: () => 'r1',
    now: () => clock,
  });
  const events: PreviewHostEvent[] = [];
  host.onEvent((e) => events.push(e));
  const url = `https://${HOST}/`;
  host.create({ id: 'p1', url, allowedHost: HOST, inject: INJECT });
  const view = fake.views[0]!;
  const session = fake.sessions[0]!;
  const beforeRequest = (reqUrl: string) =>
    new Promise<unknown>((resolve) => {
      session.s.beforeRequest!({ url: reqUrl }, resolve);
    });
  return { host, fake, win, view, wc: view.webContents, session, events, url, beforeRequest, tick: (ms: number) => (clock += ms) };
}

const nextTurn = () => new Promise((r) => setImmediate(r));

describe('Electron glue (fake Electron)', () => {
  it('one in-memory partition per preview, hardened webPreferences, no preload', () => {
    const { session, view, wc, url } = setup();
    expect(session.partition).toBe(`${PREVIEW_PARTITION_PREFIX}r1`);
    expect(session.partition.startsWith('persist:')).toBe(false);
    const prefs = view.options.webPreferences;
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false });
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs.session).toBe(session.s);
    expect(wc.loads).toEqual([url]);
    expect(view.visible).toBe(false);
  });

  it('create refuses URLs off the allowed host, non-https, private hosts and duplicate ids', () => {
    const { host } = setup();
    invalidInput(() => host.create({ id: 'p1', url: `https://${HOST}/`, allowedHost: HOST, inject: null }));
    invalidInput(() => host.create({ id: 'p2', url: 'https://evil.example/', allowedHost: HOST, inject: null }));
    invalidInput(() => host.create({ id: 'p3', url: `http://${HOST}/`, allowedHost: HOST, inject: null }));
    invalidInput(() => host.create({ id: 'p4', url: 'https://127.0.0.1/', allowedHost: '127.0.0.1', inject: null }));
    invalidInput(() => host.create({ id: 'p5', url: 'https://printer.local/', allowedHost: 'printer.local', inject: null }));
  });

  it('every permission is denied (incl. Local Network Access) and devices too', () => {
    const { session } = setup();
    let granted: unknown = 'unset';
    session.s.permissionRequest!(null, 'local-network-access', (v: unknown) => (granted = v));
    expect(granted).toBe(false);
    session.s.permissionRequest!(null, 'media', (v: unknown) => (granted = v));
    expect(granted).toBe(false);
    expect(session.s.permissionCheck!(null, 'local-network-access')).toBe(false);
    expect(session.s.devicePermission!({})).toBe(false);
  });

  it('webRequest: private hosts and odd schemes are cancelled and reported; token only on the exact host', async () => {
    const { session, events, beforeRequest } = setup();
    let result: unknown;
    expect(await beforeRequest('http://127.0.0.1:5199/')).toEqual({ cancel: true });
    expect(await beforeRequest('app://gmi-desk/index.html')).toEqual({ cancel: true });
    expect(await beforeRequest(`https://${HOST}/x`)).toEqual({});
    expect(events.filter((e) => e.type === 'blocked').map((e) => (e as { reason: string }).reason)).toEqual(['private_network', 'scheme']);

    session.s.beforeSendHeaders!({ url: `https://${HOST}/x`, requestHeaders: {} }, (r: unknown) => (result = r));
    expect(result).toEqual({ requestHeaders: { 'traffic-access-token': 'tt-secret' } });
    session.s.beforeSendHeaders!({ url: 'https://cdn.example.com/x', requestHeaders: {} }, (r: unknown) => (result = r));
    expect(result).toEqual({ requestHeaders: {} });
  });

  it('updateInject swaps the token (refresh) or stops injecting', () => {
    const { host, session } = setup();
    let result: unknown;
    host.updateInject('p1', { name: 'traffic-access-token', value: 'tt-new' });
    session.s.beforeSendHeaders!({ url: `https://${HOST}/`, requestHeaders: {} }, (r: unknown) => (result = r));
    expect(result).toEqual({ requestHeaders: { 'traffic-access-token': 'tt-new' } });
    host.updateInject('p1', null);
    session.s.beforeSendHeaders!({ url: `https://${HOST}/`, requestHeaders: {} }, (r: unknown) => (result = r));
    expect(result).toEqual({ requestHeaders: {} });
  });

  it('DNS rebinding: a public name resolving to a private address is cancelled; resolver errors fail closed', async () => {
    const { session, events, beforeRequest, tick } = setup();
    session.s.dns.set('rebind.attacker.example', ['127.0.0.1']);
    session.s.dns.set('mixed.attacker.example', ['203.0.113.7', '10.0.0.8']);
    session.s.dns.set('v6.attacker.example', ['::ffff:7f00:1']);
    session.s.dns.set('gone.attacker.example', new Error('ERR_NAME_NOT_RESOLVED'));
    for (const name of ['rebind', 'mixed', 'v6', 'gone']) expect(await beforeRequest(`https://${name}.attacker.example/x`), name).toEqual({ cancel: true });
    expect(await beforeRequest('https://cdn.example.com/a.js')).toEqual({});
    expect(events.filter((e) => e.type === 'blocked').every((e) => (e as { reason: string }).reason === 'private_network')).toBe(true);
    // The answer is memoised for 2 s per preview, then asked again (a later rebind is caught).
    await beforeRequest('https://cdn.example.com/b.js');
    expect(session.s.resolves.filter((n) => n === 'cdn.example.com')).toHaveLength(1);
    session.s.dns.set('cdn.example.com', ['192.168.0.9']);
    tick(2_000);
    expect(await beforeRequest('https://cdn.example.com/c.js')).toEqual({ cancel: true });
  });

  it('navigation lock: will-navigate, will-redirect and did-start-navigation (main-started loads)', async () => {
    const { wc, events } = setup();
    const ok = new FakeEvent({ url: `https://${HOST}/next` });
    wc.emit('will-navigate', ok);
    expect(ok.defaultPrevented).toBe(false);
    const bad = new FakeEvent({ url: 'https://evil.example/' });
    wc.emit('will-navigate', bad);
    expect(bad.defaultPrevented).toBe(true);
    const redirect = new FakeEvent({ url: 'https://redirect.example/', isMainFrame: true });
    wc.emit('will-redirect', redirect);
    expect(redirect.defaultPrevented).toBe(true);
    const subRedirect = new FakeEvent({ url: 'https://cdn.example.com/', isMainFrame: false });
    wc.emit('will-redirect', subRedirect);
    expect(subRedirect.defaultPrevented).toBe(false);
    // The stop runs on the next turn: a synchronous stop() inside did-start-navigation crashes Electron 45.
    wc.emit('did-start-navigation', new FakeEvent({ url: 'app://gmi-desk/index.html', isMainFrame: true, isSameDocument: false }));
    expect(wc.stops).toBe(0);
    await nextTurn();
    expect(wc.stops).toBe(1);
    wc.emit('did-start-navigation', new FakeEvent({ url: 'https://ads.example/', isMainFrame: false, isSameDocument: false }));
    await nextTurn();
    expect(wc.stops).toBe(1);
    // A committed foreign document is replaced by a blank page.
    wc.emit('did-navigate', new FakeEvent(), 'https://committed.example/');
    expect(wc.loads.at(-1)).toBe('about:blank');
    const blocked = events.filter((e) => e.type === 'blocked' && e.reason === 'navigation');
    expect(blocked).toHaveLength(4);
  });

  it('one blocked navigation seen by several events is reported once', () => {
    const { wc, events, tick } = setup();
    wc.emit('did-start-navigation', new FakeEvent({ url: 'https://evil.example/', isMainFrame: true, isSameDocument: false }));
    wc.emit('will-navigate', new FakeEvent({ url: 'https://evil.example/' }));
    expect(events.filter((e) => e.type === 'blocked')).toHaveLength(1);
    tick(1_000);
    wc.emit('will-navigate', new FakeEvent({ url: 'https://evil.example/' }));
    expect(events.filter((e) => e.type === 'blocked')).toHaveLength(2);
  });

  it('popups are denied and reported; downloads are cancelled and reported', () => {
    const { wc, session, events } = setup();
    expect(wc.openHandler!({ url: 'https://evil.example/?q=secret' })).toEqual({ action: 'deny' });
    const dl = new FakeEvent();
    session.s.emit('will-download', dl, { getURL: () => `https://${HOST}/file.bin?token=x` });
    expect(dl.defaultPrevented).toBe(true);
    expect(events.filter((e) => e.type === 'blocked')).toEqual([
      { id: 'p1', type: 'blocked', url: 'https://evil.example/', reason: 'popup' },
      { id: 'p1', type: 'blocked', url: `https://${HOST}/file.bin`, reason: 'download' },
    ]);
  });

  it('activity only from input events, throttled; page loads are not activity', () => {
    const { wc, events, tick } = setup();
    wc.emit('did-start-loading');
    wc.emit('did-stop-loading');
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(0);
    wc.emit('before-input-event', new FakeEvent(), {});
    wc.emit('before-input-event', new FakeEvent(), {});
    tick(1_000);
    wc.emit('before-input-event', new FakeEvent(), {});
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state)).toEqual(['loading', 'ready']);
  });

  it('bounds attach the view to the window, null hides it; destroy closes and clears the partition', async () => {
    const { host, win, view, wc, session } = setup();
    host.setBounds('p1', { x: 900, y: 52, width: 460, height: 700 });
    expect(win.children).toEqual([view]);
    expect(view.bounds).toEqual({ x: 900, y: 52, width: 460, height: 700 });
    expect(view.visible).toBe(true);
    host.setBounds('p1', null);
    expect(view.visible).toBe(false);
    expect(await host.capture('p1')).toMatch(/^data:image\/png/);
    host.destroy('p1');
    expect(win.children).toEqual([]);
    expect(wc.destroyed).toBe(true);
    expect(session.s.beforeRequest).toBeNull();
    expect(session.s.cleared).toBe(1);
    expect(await host.capture('p1')).toBeNull();
  });

  it('review: at 125 % app zoom the view lands on its slot (DIP), clamped to the content area', () => {
    const { host, win, view } = setup();
    win.setZoom(1.25);
    host.setBounds('p1', { x: 200, y: 100, width: 400, height: 300 });
    expect(view.bounds).toEqual({ x: 250, y: 125, width: 500, height: 375 });
    host.setBounds('p1', { x: 1000, y: 600, width: 360, height: 280 });
    expect(view.bounds).toEqual({ x: 1250, y: 750, width: 110, height: 130 });
    win.setZoom(0.8);
    host.setBounds('p1', { x: 200, y: 100, width: 400, height: 300 });
    expect(view.bounds).toEqual({ x: 160, y: 80, width: 320, height: 240 });
  });

  it('review: client certificates are never sent and HTTP auth is cancelled', () => {
    const { wc } = setup();
    const certEvent = new FakeEvent();
    const certCalls: unknown[][] = [];
    wc.emit('select-client-certificate', certEvent, 'https://corp.example/', [{ subjectName: 'CN=user' }], (...args: unknown[]) => certCalls.push(args));
    expect(certEvent.defaultPrevented).toBe(true);
    expect(certCalls).toEqual([[]]);
    const loginEvent = new FakeEvent();
    const loginCalls: unknown[][] = [];
    wc.emit('login', loginEvent, { url: 'https://corp.example/' }, { isProxy: false }, (...args: unknown[]) => loginCalls.push(args));
    expect(loginEvent.defaultPrevented).toBe(true);
    expect(loginCalls).toEqual([[]]);
  });

  it('closing the window tears the preview down and reports it', () => {
    const { host, win, wc, events } = setup();
    host.setBounds('p1', { x: 0, y: 0, width: 100, height: 100 });
    win.destroyed = true;
    win.emit('closed');
    expect(wc.destroyed).toBe(true);
    expect(events.at(-1)).toEqual({ id: 'p1', type: 'state', state: 'failed', detail: 'The window was closed.' });
  });
});
