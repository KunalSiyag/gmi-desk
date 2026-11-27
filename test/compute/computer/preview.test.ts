// C2-C: the preview manager over a fake PreviewHost (compute.md §8.4, §9.5, §12 T5/T6, §17). URL built in main and
// host-locked; exact-host `traffic-access-token` injection only, `X-Access-Token` never; token refresh → updateInject;
// only input events count as activity; blocked events; external open behind a native confirm; previews close with the
// session.
import { describe, expect, it, vi } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { PreviewInfo } from '@shared/contracts/compute';
import type { Logger } from '@main/core/logger';
import {
  previewRequestHeaders,
  shouldInjectPreviewToken,
  type PreviewHost,
  type PreviewHostCreate,
  type PreviewHostEvent,
} from '@main/core/preview-host';
import {
  createPlaceholderPreviewHost,
  createPreviewManager,
  previewApi,
  type PreviewAccess,
  type PreviewManagerDeps,
  type PreviewSessionRef,
} from '@main/services/compute/computer/preview';
import type { ComputeActivity } from '@main/services/compute/types';

const KEY = 'sbx0abc123';
const DOMAIN = 'sandbox.gmi.example';
const HOST = `8000-${KEY}.${DOMAIN}`;
const SAT = 'sat-data-plane-SECRET';

class FakeHost implements PreviewHost {
  calls: Array<{ op: string; args: unknown[] }> = [];
  created = new Map<string, PreviewHostCreate>();
  injects = new Map<string, PreviewHostCreate['inject']>();
  bounds = new Map<string, unknown>();
  destroyed: string[] = [];
  captureResult: string | null = 'data:image/png;base64,AAAA';
  throwOnCreate: Error | null = null;
  private listeners = new Set<(e: PreviewHostEvent) => void>();

  create(opts: PreviewHostCreate) {
    this.calls.push({ op: 'create', args: [opts] });
    if (this.throwOnCreate) throw this.throwOnCreate;
    this.created.set(opts.id, opts);
    this.injects.set(opts.id, opts.inject);
  }
  updateInject(id: string, inject: PreviewHostCreate['inject']) {
    this.calls.push({ op: 'updateInject', args: [id, inject] });
    this.injects.set(id, inject);
  }
  setBounds(id: string, b: unknown) {
    this.calls.push({ op: 'setBounds', args: [id, b] });
    this.bounds.set(id, b);
  }
  command(id: string, c: string) {
    this.calls.push({ op: 'command', args: [id, c] });
  }
  async capture(id: string) {
    this.calls.push({ op: 'capture', args: [id] });
    return this.captureResult;
  }
  destroy(id: string) {
    this.calls.push({ op: 'destroy', args: [id] });
    this.destroyed.push(id);
  }
  onEvent(l: (e: PreviewHostEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  dispose() {}
  fire(e: PreviewHostEvent) {
    for (const l of [...this.listeners]) l(e);
  }
  get listenerCount() {
    return this.listeners.size;
  }
}

function logger() {
  const lines: Array<{ level: string; message: string; meta: unknown }> = [];
  const log: Logger = {
    debug: (message, meta) => lines.push({ level: 'debug', message, meta }),
    info: (message, meta) => lines.push({ level: 'info', message, meta }),
    warn: (message, meta) => lines.push({ level: 'warn', message, meta }),
    error: (message, meta) => lines.push({ level: 'error', message, meta }),
    child: () => log,
  };
  return { log, lines };
}

interface SetupOpts {
  sessions?: PreviewSessionRef[];
  secure?: boolean | null;
  confirm?: boolean;
  tokenSyncMs?: number;
}

function setup(opts: SetupOpts = {}) {
  const host = new FakeHost();
  const { log, lines } = logger();
  const sessions = new Map<string, PreviewSessionRef>();
  for (const s of opts.sessions ?? [{ sessionId: 's1', resourceId: 'cr_1', kind: 'sandbox', secure: opts.secure === undefined ? true : opts.secure }]) {
    sessions.set(s.sessionId, s);
  }
  const accessBySession = new Map<string, PreviewAccess & { accessToken: string }>();
  for (const sid of sessions.keys()) accessBySession.set(sid, { sandboxKey: KEY, domain: DOMAIN, trafficToken: 'tat-1', accessToken: SAT });
  const activity: Array<{ rid: string; a: ComputeActivity }> = [];
  const events: PreviewInfo[] = [];
  const confirms: Array<{ title: string; message: string; detail?: string }> = [];
  const opened: string[] = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  let idSeq = 0;
  const accessCalls: string[] = [];
  const deps: PreviewManagerDeps = {
    host,
    session: (sid) => sessions.get(sid) ?? null,
    access: async (sid) => {
      accessCalls.push(sid);
      const a = accessBySession.get(sid);
      if (!a) throw new GmiError('not_found', 'no access');
      return a;
    },
    peekAccess: (sid) => accessBySession.get(sid) ?? null,
    activity: { record: (rid, a) => activity.push({ rid, a }) },
    platform: {
      confirm: async (c) => {
        confirms.push(c);
        return opts.confirm ?? true;
      },
      openExternal: async (url) => {
        opened.push(url);
      },
    },
    emit: (info) => events.push(info),
    log,
    newId: () => `pv_${++idSeq}`,
    tokenSyncMs: opts.tokenSyncMs ?? 30_000,
    setInterval: (fn, ms) => {
      const h = { fn, ms };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => {
      const i = intervals.indexOf(h as (typeof intervals)[number]);
      if (i >= 0) intervals.splice(i, 1);
    },
  };
  const mgr = createPreviewManager(deps);
  return { mgr, host, sessions, accessBySession, activity, events, confirms, opened, intervals, lines, accessCalls, deps };
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(GmiError);
  await p.catch((e: GmiError) => expect(e.code).toBe(code));
}

describe('open: URL built in main, host-locked', () => {
  it('builds https://<port>-<key>.<domain><path> and locks the view to exactly that host', async () => {
    const t = setup();
    const info = await t.mgr.open('s1', 8000, '/app?x=1');
    expect(info).toMatchObject({ previewId: 'pv_1', sessionId: 's1', port: 8000, url: `https://${HOST}/app?x=1`, state: 'loading' });
    const c = t.host.created.get('pv_1')!;
    expect(c.url).toBe(`https://${HOST}/app?x=1`);
    expect(c.allowedHost).toBe(HOST);
    expect(c.inject).toEqual({ name: 'traffic-access-token', value: 'tat-1' });
  });

  it('defaults the path to /', async () => {
    const t = setup();
    expect((await t.mgr.open('s1', 3000)).url).toBe(`https://3000-${KEY}.${DOMAIN}/`);
  });

  it.each(['@evil.example/', '.evil.example/', '//evil.example/', '/\\evil.example/', 'evil.example', '\\\\evil.example', ' /x', '/x\n', '/x\u0000'])(
    'a renderer path %j can never change the host',
    async (path) => {
      const t = setup();
      let info: PreviewInfo | null = null;
      try {
        info = await t.mgr.open('s1', 8000, path);
      } catch (error) {
        expect((error as GmiError).code).toBe('invalid_input');
      }
      for (const c of t.host.created.values()) {
        expect(new URL(c.url).host).toBe(HOST);
        expect(c.allowedHost).toBe(HOST);
      }
      if (info) expect(new URL(info.url).host).toBe(HOST);
    },
  );

  it.each(['/%2F%2Fevil.example/', '/..//evil.example', '/@evil.example', '/a#@evil.example'])('path %j stays on the preview host', async (path) => {
    const t = setup();
    const info = await t.mgr.open('s1', 8000, path);
    expect(new URL(info.url).host).toBe(HOST);
    expect(new URL(t.host.created.get(info.previewId)!.url).host).toBe(HOST);
  });

  it.each([0, -1, 65536, 80.5, Number.NaN, '8000' as unknown as number])('port %j is refused', async (port) => {
    const t = setup();
    await rejectsWith(t.mgr.open('s1', port), 'invalid_input');
    expect(t.host.calls).toHaveLength(0);
  });

  it('unknown session → not_found; containers → invalid_input; nothing created', async () => {
    const t = setup({ sessions: [{ sessionId: 'c1', resourceId: 'cr_c', kind: 'container', secure: null }] });
    await rejectsWith(t.mgr.open('nope', 8000), 'not_found');
    await rejectsWith(t.mgr.open('c1', 8000), 'invalid_input');
    expect(t.host.calls).toHaveLength(0);
  });

  it('a session that closes while access is fetched gets no preview', async () => {
    const t = setup();
    const access = t.deps.access;
    t.deps.access = async (sid) => {
      const a = await access(sid);
      t.sessions.delete(sid);
      return a;
    };
    const mgr = createPreviewManager(t.deps);
    await rejectsWith(mgr.open('s1', 8000), 'not_found');
    expect(t.host.created.size).toBe(0);
  });

  it('the same URL in the same session returns the open preview; limits per session and in all', async () => {
    const t = setup({
      sessions: [
        { sessionId: 's1', resourceId: 'cr_1', kind: 'sandbox', secure: true },
        { sessionId: 's2', resourceId: 'cr_2', kind: 'sandbox', secure: true },
        { sessionId: 's3', resourceId: 'cr_3', kind: 'sandbox', secure: true },
      ],
    });
    const a = await t.mgr.open('s1', 8000, '/');
    expect((await t.mgr.open('s1', 8000, '/')).previewId).toBe(a.previewId);
    expect(t.host.created.size).toBe(1);
    for (const port of [8001, 8002, 8003]) await t.mgr.open('s1', port);
    await rejectsWith(t.mgr.open('s1', 8004), 'limit_reached');
    for (const port of [8000, 8001, 8002, 8003]) await t.mgr.open('s2', port);
    await rejectsWith(t.mgr.open('s3', 8000), 'limit_reached');
  });

  it('a host refusal leaves nothing behind', async () => {
    const t = setup();
    t.host.throwOnCreate = new GmiError('invalid_input', 'bad');
    await rejectsWith(t.mgr.open('s1', 8000), 'invalid_input');
    expect(t.mgr.list()).toEqual([]);
    expect(t.intervals).toHaveLength(0);
  });
});

describe('token injection (T6)', () => {
  it('injects only traffic-access-token, only on the exact preview host; X-Access-Token never appears', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000, '/');
    const c = t.host.created.get('pv_1')!;
    const everything = JSON.stringify(t.host.calls);
    expect(everything.toLowerCase()).not.toContain('x-access-token');
    expect(everything).not.toContain(SAT);
    // The injector the host runs with this exact config:
    const h = (url: string) => previewRequestHeaders(url, { Accept: '*/*' }, c.allowedHost, c.inject);
    expect(h(`https://${HOST}/api`)).toEqual({ Accept: '*/*', 'traffic-access-token': 'tat-1' });
    expect(h(`wss://${HOST}/hmr`)['traffic-access-token']).toBe('tat-1');
    for (const other of [
      `https://${KEY}.${DOMAIN}/`, // the data-plane host
      `https://8001-${KEY}.${DOMAIN}/`, // another port
      `https://${HOST}.evil.example/`,
      `https://x.${HOST}/`,
      `http://${HOST}/`, // no TLS
      `https://${HOST}:8443/`,
      'https://evil.example/',
    ]) {
      expect(shouldInjectPreviewToken(other, c.allowedHost)).toBe(false);
      expect(h(other)).toEqual({ Accept: '*/*' });
    }
    for (const v of Object.values(h(`https://${HOST}/`))) expect(v).not.toBe(SAT);
  });

  it('secure:false sends no token; secure:null sends one only when GMI gave one', async () => {
    const off = setup({ secure: false });
    await off.mgr.open('s1', 8000);
    expect(off.host.created.get('pv_1')!.inject).toBeNull();

    const unknown = setup({ secure: null });
    unknown.accessBySession.get('s1')!.trafficToken = '';
    await unknown.mgr.open('s1', 8000);
    expect(unknown.host.created.get('pv_1')!.inject).toBeNull();
  });

  it('secure:true without a traffic token is refused before any view exists', async () => {
    const t = setup({ secure: true });
    t.accessBySession.get('s1')!.trafficToken = '';
    await rejectsWith(t.mgr.open('s1', 8000), 'unauthorized');
    expect(t.host.calls).toHaveLength(0);
  });

  it('accessChanged pushes a refreshed token with updateInject, once per change', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    await t.mgr.open('s1', 8001);
    await t.mgr.accessChanged('s1');
    expect(t.host.calls.filter((c) => c.op === 'updateInject')).toHaveLength(0);
    t.accessBySession.get('s1')!.trafficToken = 'tat-2';
    await t.mgr.accessChanged('s1');
    const updates = t.host.calls.filter((c) => c.op === 'updateInject');
    expect(updates.map((u) => u.args)).toEqual([
      ['pv_1', { name: 'traffic-access-token', value: 'tat-2' }],
      ['pv_2', { name: 'traffic-access-token', value: 'tat-2' }],
    ]);
    expect(JSON.stringify(updates).toLowerCase()).not.toContain('x-access-token');
  });

  it('the periodic sync reads the cache (no connect) and updates changed tokens', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    expect(t.intervals).toHaveLength(1);
    const before = t.accessCalls.length;
    t.accessBySession.get('s1')!.trafficToken = 'tat-3';
    t.intervals[0]!.fn();
    await Promise.resolve();
    expect(t.host.injects.get('pv_1')).toEqual({ name: 'traffic-access-token', value: 'tat-3' });
    expect(t.accessCalls.length).toBe(before);
  });

  it('an access for another sandbox address never re-targets a preview', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.accessBySession.set('s1', { sandboxKey: 'other1', domain: DOMAIN, trafficToken: 'tat-x', accessToken: SAT });
    await t.mgr.accessChanged('s1');
    expect(t.host.injects.get('pv_1')).toEqual({ name: 'traffic-access-token', value: 'tat-1' });
  });

  it('reload re-reads access before reloading', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.accessBySession.get('s1')!.trafficToken = 'tat-4';
    await t.mgr.command('pv_1', 'reload');
    const ops = t.host.calls.map((c) => c.op);
    expect(ops.slice(-2)).toEqual(['updateInject', 'command']);
    expect(t.host.injects.get('pv_1')!.value).toBe('tat-4');
  });
});

describe('activity (§9.5)', () => {
  it('only input events in the view count, as preview_input for the resource', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.host.fire({ id: 'pv_1', type: 'state', state: 'loading' });
    t.host.fire({ id: 'pv_1', type: 'navigated', url: `https://${HOST}/x`, title: 'X', canGoBack: true, canGoForward: false });
    t.host.fire({ id: 'pv_1', type: 'state', state: 'ready' });
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'https://evil.example/', reason: 'navigation' });
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'http://127.0.0.1:5199/@vite/client', reason: 'private_network' });
    expect(t.activity).toEqual([]);
    t.host.fire({ id: 'pv_1', type: 'activity' });
    t.host.fire({ id: 'pv_1', type: 'activity' });
    expect(t.activity).toEqual([
      { rid: 'cr_1', a: { kind: 'preview_input' } },
      { rid: 'cr_1', a: { kind: 'preview_input' } },
    ]);
  });

  it('events of unknown or closed previews are ignored', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    await t.mgr.close('pv_1');
    t.host.fire({ id: 'pv_1', type: 'activity' });
    t.host.fire({ id: 'pv_9', type: 'activity' });
    expect(t.activity).toEqual([]);
  });
});

describe('host events → PreviewInfo', () => {
  it('state, navigation and title are published; off-host URLs are not adopted', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.host.fire({ id: 'pv_1', type: 'state', state: 'ready' });
    t.host.fire({ id: 'pv_1', type: 'navigated', url: `https://${HOST}/docs`, title: 'Docs', canGoBack: true, canGoForward: false });
    expect(t.mgr.get('pv_1')).toMatchObject({ state: 'ready', url: `https://${HOST}/docs`, title: 'Docs', canGoBack: true });
    t.host.fire({ id: 'pv_1', type: 'navigated', url: 'https://evil.example/', title: 'x'.repeat(500), canGoBack: true, canGoForward: true });
    const info = t.mgr.get('pv_1')!;
    expect(info.url).toBe(`https://${HOST}/docs`);
    expect(info.title!.length).toBe(200);
    t.host.fire({ id: 'pv_1', type: 'state', state: 'failed', detail: 'ERR_CONNECTION_REFUSED' });
    expect(t.mgr.get('pv_1')).toMatchObject({ state: 'failed', detail: 'ERR_CONNECTION_REFUSED' });
    t.host.fire({ id: 'pv_1', type: 'state', state: 'crashed', detail: 'oom' });
    expect(t.mgr.get('pv_1')!.state).toBe('failed');
    expect(t.events.map((e) => e.state)).toContain('ready');
  });

  it('a blocked navigation becomes state blocked; logs carry the host only, once per host', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'https://accounts.example/login?token=abc', reason: 'navigation' });
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'https://accounts.example/other?token=abc', reason: 'navigation' });
    const info = t.mgr.get('pv_1')!;
    expect(info.state).toBe('blocked');
    expect(info.detail).toContain('accounts.example');
    const blockedLogs = t.lines.filter((l) => l.message === 'preview.blocked');
    expect(blockedLogs).toHaveLength(1);
    expect(blockedLogs[0]!.meta).toEqual({ pid: 'pv_1', reason: 'navigation', host: 'accounts.example' });
    expect(JSON.stringify(t.lines)).not.toContain('token=abc');
    expect(t.events.at(-1)!.state).toBe('blocked');
    // A new load clears it.
    t.host.fire({ id: 'pv_1', type: 'state', state: 'loading' });
    expect(t.mgr.get('pv_1')).toMatchObject({ state: 'loading', detail: null });
  });

  it('popups and downloads are blocked states; private-network subresource blocks only log', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.host.fire({ id: 'pv_1', type: 'state', state: 'ready' });
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'http://192.168.1.1/admin', reason: 'private_network' });
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'file:///etc/passwd', reason: 'scheme' });
    expect(t.mgr.get('pv_1')!.state).toBe('ready');
    expect(t.lines.filter((l) => l.message === 'preview.blocked').map((l) => (l.meta as { reason: string }).reason)).toEqual([
      'private_network',
      'scheme',
    ]);
    t.host.fire({ id: 'pv_1', type: 'blocked', url: `https://${HOST}/big.zip`, reason: 'download' });
    expect(t.mgr.get('pv_1')!.detail).toContain('Files › Download');
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'https://ads.example/pop', reason: 'popup' });
    expect(t.mgr.get('pv_1')).toMatchObject({ state: 'blocked' });
  });
});

describe('bounds, commands, capture', () => {
  it('bounds are validated and forwarded; null hides; late reports after close are ignored', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    await t.mgr.setBounds('pv_1', { x: 10, y: 20, width: 300, height: 200 });
    expect(t.host.bounds.get('pv_1')).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    await t.mgr.setBounds('pv_1', null);
    expect(t.host.bounds.get('pv_1')).toBeNull();
    for (const bad of [{ x: Number.NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: -1, height: 1 }, { x: 0, y: 0, width: 1e9, height: 1 }, 'big', undefined]) {
      await rejectsWith(t.mgr.setBounds('pv_1', bad as never), 'invalid_input');
    }
    await t.mgr.close('pv_1');
    const n = t.host.calls.length;
    await t.mgr.setBounds('pv_1', { x: 0, y: 0, width: 1, height: 1 });
    expect(t.host.calls.length).toBe(n);
  });

  it('commands are validated; unknown previews are not_found', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    for (const c of ['back', 'forward', 'stop'] as const) await t.mgr.command('pv_1', c);
    expect(t.host.calls.filter((c) => c.op === 'command').map((c) => c.args[1])).toEqual(['back', 'forward', 'stop']);
    await rejectsWith(t.mgr.command('pv_1', 'navigate' as never), 'invalid_input');
    await rejectsWith(t.mgr.command('pv_9', 'reload'), 'not_found');
  });

  it('capture returns the live frame while visible and the last frame while hidden', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    expect(await t.mgr.capture('pv_1')).toBeNull(); // never shown yet
    await t.mgr.setBounds('pv_1', { x: 0, y: 0, width: 100, height: 100 });
    expect(await t.mgr.capture('pv_1')).toBe('data:image/png;base64,AAAA');
    await t.mgr.setBounds('pv_1', null);
    t.host.captureResult = null;
    const n = t.host.calls.filter((c) => c.op === 'capture').length;
    expect(await t.mgr.capture('pv_1')).toBe('data:image/png;base64,AAAA');
    expect(t.host.calls.filter((c) => c.op === 'capture').length).toBe(n);
    expect(await t.mgr.capture('pv_9')).toBeNull();
  });
});

describe('open externally (native confirm)', () => {
  it('needs a confirm; declined → cancelled and nothing opens', async () => {
    const t = setup({ confirm: false });
    await t.mgr.open('s1', 8000, '/app');
    await rejectsWith(t.mgr.openExternally('pv_1'), 'cancelled');
    expect(t.confirms).toHaveLength(1);
    expect(t.opened).toEqual([]);
  });

  it('confirmed → the current preview URL (no token in it); the dialog says secure previews get 401', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000, '/app');
    t.host.fire({ id: 'pv_1', type: 'navigated', url: `https://${HOST}/page2`, title: null, canGoBack: true, canGoForward: false });
    await t.mgr.openExternally('pv_1');
    expect(t.opened).toEqual([`https://${HOST}/page2`]);
    expect(t.confirms[0]!.message).toBe(`https://${HOST}/page2`);
    expect(t.confirms[0]!.detail).toContain('401');
    expect(t.opened[0]).not.toContain('tat-1');
  });

  it('without a token the dialog does not warn about 401', async () => {
    const t = setup({ secure: false });
    await t.mgr.open('s1', 8000);
    await t.mgr.openExternally('pv_1');
    expect(t.confirms[0]!.detail).not.toContain('401');
  });

  it('a blocked navigation target is what opens externally (after the confirm shows it)', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'https://docs.example/guide', reason: 'navigation' });
    await t.mgr.openExternally('pv_1');
    expect(t.confirms[0]!.message).toBe('https://docs.example/guide');
    expect(t.opened).toEqual(['https://docs.example/guide']);
  });

  it('review: an http target is never offered (main opens https only); external open falls back to the preview', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'http://plain.example/x', reason: 'navigation' });
    expect(t.mgr.get('pv_1')).toMatchObject({ state: 'blocked' });
    expect(t.mgr.get('pv_1')!.detail).not.toContain('open it in your browser');
    await t.mgr.openExternally('pv_1');
    expect(t.confirms[0]!.message).toBe(`https://${HOST}/`);
    expect(t.opened).toEqual([`https://${HOST}/`]);
  });

  it('a non-web blocked target falls back to the preview URL', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.host.fire({ id: 'pv_1', type: 'blocked', url: 'javascript:alert(1)', reason: 'navigation' });
    await t.mgr.openExternally('pv_1');
    expect(t.opened).toEqual([`https://${HOST}/`]);
  });

  it('a closed preview cannot be opened', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    await t.mgr.close('pv_1');
    await rejectsWith(t.mgr.openExternally('pv_1'), 'not_found');
    expect(t.confirms).toEqual([]);
  });
});

describe('lifecycle: previews close with the session', () => {
  it('review: closeAll (renderer reload / crash) destroys every native view and publishes closed; the manager stays usable', async () => {
    const t = setup({
      sessions: [
        { sessionId: 's1', resourceId: 'cr_1', kind: 'sandbox', secure: true },
        { sessionId: 's2', resourceId: 'cr_2', kind: 'sandbox', secure: true },
      ],
    });
    await t.mgr.open('s1', 8000);
    await t.mgr.open('s2', 3000);
    t.mgr.closeAll();
    expect(t.host.destroyed.sort()).toEqual(['pv_1', 'pv_2']);
    expect(t.mgr.list()).toEqual([]);
    expect(t.events.filter((e) => e.state === 'closed').map((e) => e.previewId).sort()).toEqual(['pv_1', 'pv_2']);
    expect(t.intervals).toEqual([]);
    expect((await t.mgr.open('s1', 8000)).previewId).toBe('pv_3');
  });


  it('closeSession destroys that session’s previews only and publishes closed', async () => {
    const t = setup({
      sessions: [
        { sessionId: 's1', resourceId: 'cr_1', kind: 'sandbox', secure: true },
        { sessionId: 's2', resourceId: 'cr_2', kind: 'sandbox', secure: true },
      ],
    });
    await t.mgr.open('s1', 8000);
    await t.mgr.open('s1', 8001);
    await t.mgr.open('s2', 8000);
    t.mgr.closeSession('s1');
    expect(t.host.destroyed.sort()).toEqual(['pv_1', 'pv_2']);
    expect(t.mgr.list().map((p) => p.previewId)).toEqual(['pv_3']);
    expect(t.events.filter((e) => e.state === 'closed').map((e) => e.previewId).sort()).toEqual(['pv_1', 'pv_2']);
    expect(t.intervals).toHaveLength(1);
    t.mgr.closeSession('s2');
    expect(t.intervals).toHaveLength(0); // the token sync stops with the last preview
  });

  it('close is idempotent', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    await t.mgr.close('pv_1');
    await t.mgr.close('pv_1');
    await t.mgr.close('nope');
    expect(t.host.destroyed).toEqual(['pv_1']);
  });

  it('dispose destroys everything, stops listening and refuses new previews', async () => {
    const t = setup();
    await t.mgr.open('s1', 8000);
    t.mgr.dispose();
    expect(t.host.destroyed).toEqual(['pv_1']);
    expect(t.host.listenerCount).toBe(0);
    expect(t.intervals).toHaveLength(0);
    await rejectsWith(t.mgr.open('s1', 8001), 'cancelled');
  });
});

describe('previewApi and the mock placeholder host', () => {
  it('maps the ComputerApi preview methods onto the manager', async () => {
    const t = setup();
    const api = previewApi(t.mgr);
    const info = await api.openPreview('s1', 8000, '/');
    await api.setPreviewBounds(info.previewId, { x: 0, y: 0, width: 10, height: 10 });
    await api.previewCommand(info.previewId, 'stop');
    expect(await api.capturePreview(info.previewId)).toBe('data:image/png;base64,AAAA');
    await api.openPreviewExternally(info.previewId);
    await api.closePreview(info.previewId);
    expect(t.mgr.list()).toEqual([]);
  });

  it('the placeholder host reports loading → ready without any native view or network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const t = setup();
    const placeholder = createPlaceholderPreviewHost();
    const mgr = createPreviewManager({ ...t.deps, host: placeholder });
    const info = await mgr.open('s1', 8000, '/');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mgr.get(info.previewId)).toMatchObject({ state: 'ready', url: `https://${HOST}/` });
    expect(await mgr.capture(info.previewId)).toBeNull();
    expect(() => placeholder.create({ id: 'x', url: 'https://evil.example/', allowedHost: HOST, inject: null })).toThrow(GmiError);
    await mgr.close(info.previewId);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
