// Electron main entry for the PreviewHost smoke test (bundled and started by preview-host.smoke.mjs; not vitest).
//
// Real Chromium checks the unit tests cannot make (compute.md §8.4, §12 T5):
//  1. `app://` (the renderer's own scheme, handled on the default session as in src/main/index.ts) is not handled in
//     a preview partition: isProtocolHandled is false there, and a fetch from the preview page fails.
//  2. DNS rebinding / local network access is blocked: the preview page (served as a public address via CSP
//     `treat-as-public-address`) fetches a public-looking host name that the test resolver maps to 127.0.0.1. The
//     request must never reach the loopback server. A control partition with the same page, no request filter and
//     every permission denied shows what Chromium alone does: in Electron 45 the request goes through (Local Network
//     Access is not enforced), which is why preview-host.ts resolves names itself.
//     Test seam: the preview host itself is served from 127.0.0.1 here, so its name (only) is reported to the
//     host's resolution check as a public address; every other name goes through the real resolver.
//  3. Direct loopback / private fetches are cancelled by the webRequest filter (private_network).
//  4. `traffic-access-token` reaches only the preview host; `X-Access-Token` never; navigation off-host is blocked.
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { app, BrowserWindow, protocol, session, WebContentsView } from 'electron';
import { createElectronPreviewHost, PREVIEW_PARTITION_PREFIX, type PreviewHostEvent } from '../../src/main/core/preview-host';
import type { Logger } from '../../src/main/core/logger';

const certDir = process.env.SMOKE_CERT_DIR ?? '';
/** The result JSON is written here (stdout can be cut off by app.exit). */
const resultFile = process.env.SMOKE_RESULT_FILE ?? '';
const PREVIEW_NAME = '8443-sbxsmoke.smoke-preview.example';
const REBIND_NAME = 'rebind.smoke-attacker.example';
/** Resolves to a public (documentation) address that never answers: a foreign top-level load must not commit. */
const ELSEWHERE_NAME = 'elsewhere.smoke-attacker.example';

app.commandLine.appendSwitch(
  'host-resolver-rules',
  `MAP ${PREVIEW_NAME} 127.0.0.1, MAP ${REBIND_NAME} 127.0.0.1, MAP ${ELSEWHERE_NAME} 203.0.113.1`,
);
// Self-signed test certificate for the two local HTTPS servers.
app.commandLine.appendSwitch('ignore-certificate-errors');
// As src/main/index.ts: both app schemes privileged, handled on the default session only.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'gmi-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

interface Hit {
  path: string;
  headers: IncomingHttpHeaders;
}

function listen(handler: (path: string, headers: IncomingHttpHeaders) => { status: number; headers: Record<string, string>; body: string }) {
  const hits: Hit[] = [];
  const server: Server = createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (req, res) => {
    const path = req.url ?? '/';
    hits.push({ path, headers: req.headers });
    const out = handler(path, req.headers);
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
  return new Promise<{ port: number; hits: Hit[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, hits, close: () => server.close() }));
  });
}

const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m, meta) => console.error('[warn]', m, meta ?? ''),
  error: (m, meta) => console.error('[error]', m, meta ?? ''),
  child: () => log,
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><title>preview</title><body>preview page</body>`;

/** Runs in the preview page: each probe resolves to 'ok:<status>' or 'error:<name>'. */
function probeScript(rebindPort: number): string {
  return `(async () => {
    const probe = (url) => fetch(url, { cache: 'no-store' }).then((r) => 'ok:' + r.status, (e) => 'error:' + (e && e.name));
    return {
      appScheme: await probe('app://gmi-desk/probe'),
      mediaScheme: await probe('gmi-media://local/x.png'),
      rebind: await probe('https://${REBIND_NAME}:${rebindPort}/lna'),
      loopback: await probe('https://127.0.0.1:${rebindPort}/direct'),
      localhost: await probe('https://localhost:${rebindPort}/direct'),
      sameHost: await probe('/same'),
    };
  })()`;
}

async function main(): Promise<void> {
  await app.whenReady();
  const results: Record<string, unknown> = {};
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail: unknown) => {
    results[name] = { ok, detail };
    if (!ok) failures.push(name);
  };

  // The real app's handler for its own scheme lives on the default session only.
  protocol.handle('app', () => new Response('APP-OK', { headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } }));
  protocol.handle('gmi-media', () => new Response('MEDIA-OK', { headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } }));

  const previewSrv = await listen(() => ({
    status: 200,
    headers: { 'content-type': 'text/html', 'content-security-policy': 'treat-as-public-address' },
    body: PAGE,
  }));
  const loopbackSrv = await listen(() => ({
    status: 200,
    headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'access-control-allow-private-network': 'true' },
    body: 'LOOPBACK-REACHED',
  }));
  const allowedHost = `${PREVIEW_NAME}:${previewSrv.port}`;
  const previewUrl = `https://${allowedHost}/`;

  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { offscreen: true } });
  const partitions: string[] = [];
  const host = createElectronPreviewHost({
    electron: {
      WebContentsView,
      session: {
        fromPartition(partition, options) {
          partitions.push(partition);
          const ses = session.fromPartition(partition, options);
          // Test seam (see header): only the preview host's own name is answered as public.
          const realResolve = ses.resolveHost.bind(ses);
          ses.resolveHost = (name, opts) =>
            name === PREVIEW_NAME ? Promise.resolve({ endpoints: [{ address: '203.0.113.80', family: 'ipv4' as const }] }) : realResolve(name, opts);
          return ses;
        },
      },
    },
    getWindow: () => win,
    devTools: false,
    log,
  });
  const events: PreviewHostEvent[] = [];
  host.onEvent((e) => events.push(e));

  host.create({ id: 'smoke', url: previewUrl, allowedHost, inject: { name: 'traffic-access-token', value: 'smoke-traffic-token' } });
  host.setBounds('smoke', { x: 0, y: 0, width: 800, height: 600 });
  for (let i = 0; i < 100 && !events.some((e) => e.id === 'smoke' && e.type === 'state' && e.state !== 'loading'); i++) await delay(100);

  const partition = partitions[0] ?? '';
  check('partition is in-memory', partition.startsWith(PREVIEW_PARTITION_PREFIX) && !partition.startsWith('persist:'), partition);
  const previewSession = session.fromPartition(partition);
  check('app:// handled on the default session', session.defaultSession.protocol.isProtocolHandled('app'), true);
  check('app:// not handled in the preview partition', !previewSession.protocol.isProtocolHandled('app'), previewSession.protocol.isProtocolHandled('app'));
  check(
    'gmi-media:// handled on the default session only',
    session.defaultSession.protocol.isProtocolHandled('gmi-media') && !previewSession.protocol.isProtocolHandled('gmi-media'),
    null,
  );
  check('preview loaded', events.some((e) => e.type === 'state' && e.state === 'ready'), events.filter((e) => e.type === 'state'));

  const view = win.contentView.children.find((v): v is WebContentsView => v instanceof WebContentsView);
  if (!view) throw new Error('preview view not attached to the window');
  const probes = (await view.webContents.executeJavaScript(probeScript(loopbackSrv.port))) as Record<string, string>;
  const loopbackHits = loopbackSrv.hits.map((h) => h.path);
  check('fetch app:// from the preview fails', probes.appScheme?.startsWith('error:') === true, probes.appScheme);
  check('fetch gmi-media:// from the preview fails', probes.mediaScheme?.startsWith('error:') === true, probes.mediaScheme);
  check('rebind name → 127.0.0.1 never reaches loopback (local network access blocked)', probes.rebind?.startsWith('error:') === true && !loopbackHits.includes('/lna'), {
    probe: probes.rebind,
    loopbackHits,
  });
  check('direct 127.0.0.1 fetch is cancelled', probes.loopback?.startsWith('error:') === true && !loopbackHits.includes('/direct'), probes.loopback);
  check('localhost fetch is cancelled', probes.localhost?.startsWith('error:') === true, probes.localhost);
  check('same-host fetch works', probes.sameHost === 'ok:200', probes.sameHost);
  check(
    'webRequest reported the private-network blocks',
    events.some((e) => e.type === 'blocked' && e.reason === 'private_network'),
    events.filter((e) => e.type === 'blocked'),
  );

  const previewHits = previewSrv.hits;
  check(
    'traffic-access-token on every preview-host request, X-Access-Token never',
    previewHits.length >= 2 && previewHits.every((h) => h.headers['traffic-access-token'] === 'smoke-traffic-token' && !('x-access-token' in h.headers)),
    previewHits.map((h) => ({ path: h.path, token: h.headers['traffic-access-token'] ? 'present' : 'absent', xAccess: 'x-access-token' in h.headers })),
  );

  // Navigation off the host (page-initiated) is blocked and reported; the loopback server sees nothing.
  const before = events.length;
  await view.webContents.executeJavaScript(`location.href = 'https://${REBIND_NAME}:${loopbackSrv.port}/navigated'`);
  await delay(800);
  check(
    'off-host navigation blocked',
    events.slice(before).some((e) => e.type === 'blocked' && e.reason === 'navigation') && !loopbackSrv.hits.some((h) => h.path === '/navigated'),
    events.slice(before),
  );
  // A load started from main (not page-initiated: will-navigate does not fire) to another host is stopped.
  const beforeMain = events.length;
  void view.webContents.loadURL(`https://${ELSEWHERE_NAME}/`).catch(() => undefined);
  await delay(800);
  check(
    'main-started off-host load stopped (did-start-navigation)',
    events.slice(beforeMain).some((e) => e.type === 'blocked' && e.reason === 'navigation') && !view.webContents.getURL().includes(ELSEWHERE_NAME),
    { events: events.slice(beforeMain), url: view.webContents.getURL() },
  );
  check('popup denied', (await view.webContents.executeJavaScript(`window.open('https://example.com/') === null`)) === true, null);

  // Control: same page in a partition with no request filter and every permission denied (Chromium alone).
  const control = session.fromPartition(`gmi-smoke-control-${Date.now()}`);
  control.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  control.setPermissionCheckHandler(() => false);
  const controlView = new WebContentsView({ webPreferences: { session: control, sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(controlView);
  controlView.setBounds({ x: 0, y: 0, width: 400, height: 300 });
  await controlView.webContents.loadURL(previewUrl);
  const controlProbes = (await controlView.webContents.executeJavaScript(probeScript(loopbackSrv.port))) as Record<string, string>;
  results.control = {
    note: 'no request filter, permissions denied: what Chromium alone allows (informational)',
    probes: controlProbes,
    lnaEnforcedByChromium: !loopbackSrv.hits.some((h) => h.path === '/lna'),
    loopbackHits: loopbackSrv.hits.map((h) => h.path),
  };

  const previewContents = view.webContents;
  host.destroy('smoke');
  for (let i = 0; i < 20 && !previewContents.isDestroyed(); i++) await delay(50);
  check('destroy closes the view', previewContents.isDestroyed() && !win.contentView.children.includes(view), null);
  previewSrv.close();
  loopbackSrv.close();
  writeFileSync(resultFile, JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, failures, results }));
  app.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  writeFileSync(resultFile, JSON.stringify({ failures: ['smoke crashed'], error: String((error as Error)?.stack ?? error) }));
  app.exit(2);
});
