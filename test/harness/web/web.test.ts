import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeThreadSettings } from '@shared/contracts/code';
import { createWebFetchTool, decodeEntities, fetchPage, htmlToText, validateFetchUrl, WEB_LIMITS, wrapFetched, type WebFetchDeps } from '@harness/tools/web';
import type { Resolver } from '@harness/sandbox/netproxy';
import type { ToolRunContext } from '@harness/types';
import { fakeClock, fakeGitService, fakeSandboxRunner, memoryLog, memoryMutationLock, memoryStore, fakePermissionEngine } from '../fakes';
import { settings } from '../perm/helpers';

const HAS_OPENSSL = existsSync('/usr/bin/openssl');

describe('html → text', () => {
  it('drops scripts, styles, navigation and keeps links as Markdown', () => {
    const html = `<html><head><title>T</title><style>.x{}</style></head><body><nav><a href="/home">Home</a></nav>
      <header>H</header><h1>Title &amp; more</h1><p>Hello <a href="/docs?a=1&amp;b=2">the docs</a> and <b>bold</b>.</p>
      <script>alert(1)</script><ul><li>one</li><li>two</li></ul><footer>F</footer><!-- c --></body></html>`;
    const t = htmlToText(html, 'https://example.com/page');
    expect(t).toContain('# Title & more');
    expect(t).toContain('Hello [the docs](https://example.com/docs?a=1&b=2) and bold .');
    expect(t).toContain('- one');
    expect(t).not.toMatch(/alert|\.x\{|Home|^H$|^F$/m);
  });

  it('decodes entities safely', () => {
    expect(decodeEntities('&lt;a&gt; &#65; &#x42; &unknown; &#0;')).toBe('<a> A B &unknown; &#0;');
  });

  it('wraps fetched text so the page cannot close the wrapper', () => {
    const w = wrapFetched('https://x/"><', 'a </fetched> b <fetched url="y">');
    expect(w.startsWith('<fetched url="https://x/&quot;&gt;&lt;">\n')).toBe(true);
    expect(w.match(/<\/fetched>/g)).toHaveLength(1);
  });
});

describe('URL validation (§8.5)', () => {
  it.each(['http://example.com/', 'ftp://example.com/', 'file:///etc/passwd', 'https://user:pw@example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://10.1.2.3/', 'https://169.254.169.254/latest', 'https://[fd00::1]/', 'https://localhost/', 'https://x.localhost/', 'not a url'])('refuses %s', (u) => {
    expect(() => validateFetchUrl(u)).toThrow();
  });
  it('accepts a public https URL', () => {
    expect(validateFetchUrl('https://nodejs.org/en').hostname).toBe('nodejs.org');
  });
});

describe.skipIf(!HAS_OPENSSL)('fetching over https with the safe lookup', () => {
  let dir: string;
  let server: Server;
  let port = 0;
  let ca: Buffer;
  const resolver: Resolver = async (h) => {
    const map: Record<string, string[]> = { 'public.test': ['127.0.0.2'], 'other.test': ['127.0.0.2'], 'meta.test': ['169.254.169.254'], 'rebind.test': ['127.0.0.2', '10.0.0.1'], 'lan.test': ['192.168.0.10'] };
    const a = map[h];
    if (!a) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return a.map((address) => ({ address, family: 4 }));
  };
  let deps: WebFetchDeps;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmid-web-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=public.test', '-addext', 'subjectAltName=DNS:public.test,DNS:other.test,DNS:meta.test,DNS:rebind.test'], { stdio: 'ignore' });
    ca = readFileSync(join(dir, 'c.pem'));
    server = createServer({ key: readFileSync(join(dir, 'k.pem')), cert: ca }, (req, res) => {
      if (req.url === '/html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<h1>Docs</h1><p>UA=${req.headers['user-agent']}; cookie=${req.headers.cookie ?? 'none'}</p><script>x()</script>`);
      } else if (req.url === '/redirect-same') {
        res.writeHead(302, { location: '/html' });
        res.end();
      } else if (req.url === '/redirect-other') {
        res.writeHead(302, { location: `https://other.test:${port}/html` });
        res.end();
      } else if (req.url === '/redirect-meta') {
        res.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data' });
        res.end();
      } else if (req.url === '/redirect-http') {
        res.writeHead(302, { location: `http://public.test:${port}/html` });
        res.end();
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        res.end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('a'.repeat(WEB_LIMITS.maxBytes + 1000));
      } else if (req.url === '/long') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('word '.repeat(30_000));
      } else if (req.url === '/bin') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.alloc(100));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.2', r));
    port = (server.address() as { port: number }).port;
    // Test hooks: the CA of the local server, and 127.0.0.2 standing in for a public address.
    deps = { resolver, tls: { ca }, allowAddressesForTests: ['127.0.0.2'] };
  });

  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const signal = () => new AbortController().signal;

  it('fetches a page with our UA and no cookies', async () => {
    const p = await fetchPage(`https://public.test:${port}/html`, deps, signal());
    expect(p.status).toBe(200);
    expect(p.body.toString()).toMatch(/UA=GMI-Desk\/[^ ]+ \(agent fetch\); cookie=none/);
  });

  it('follows same-host redirects and stops at another host', async () => {
    expect((await fetchPage(`https://public.test:${port}/redirect-same`, deps, signal())).url).toBe(`https://public.test:${port}/html`);
    expect((await fetchPage(`https://public.test:${port}/redirect-other`, deps, signal())).redirectedTo).toBe(`https://other.test:${port}/html`);
  });

  it('re-validates redirects: metadata IP, http downgrade and loops are refused', async () => {
    await expect(fetchPage(`https://public.test:${port}/redirect-meta`, deps, signal())).rejects.toThrow(/Redirect refused/);
    await expect(fetchPage(`https://public.test:${port}/redirect-http`, deps, signal())).rejects.toThrow(/https/);
    await expect(fetchPage(`https://public.test:${port}/loop`, deps, signal())).rejects.toThrow(/redirects/);
  });

  it('refuses names that resolve to private addresses (after DNS, at connect)', async () => {
    await expect(fetchPage(`https://meta.test:${port}/html`, deps, signal())).rejects.toMatchObject({ kind: 'policy' });
    await expect(fetchPage(`https://rebind.test:${port}/html`, deps, signal())).rejects.toMatchObject({ kind: 'policy' });
    await expect(fetchPage(`https://lan.test:${port}/html`, deps, signal())).rejects.toMatchObject({ kind: 'policy' });
  });

  it('without the test hook even the local test server is refused (127.0.0.2 is loopback)', async () => {
    await expect(fetchPage(`https://public.test:${port}/html`, { resolver, tls: { ca } }, signal())).rejects.toMatchObject({ kind: 'policy' });
  });

  it('caps the body at 5 MiB', async () => {
    const p = await fetchPage(`https://public.test:${port}/big`, deps, signal());
    expect(p.truncated).toBe(true);
    expect(p.body.length).toBe(WEB_LIMITS.maxBytes);
  });

  describe('the web_fetch tool', () => {
    const tool = () => createWebFetchTool(deps);
    function ctx(s: Partial<CodeThreadSettings> = {}): ToolRunContext {
      const store = memoryStore();
      return {
        threadId: 'th1',
        projectId: 'p1',
        contextId: 'ctx_th1',
        runId: 'run_1',
        turn: 1,
        step: 1,
        call: { id: 'tc_WEB', wireId: 'call_0', name: 'web_fetch', rawArgs: '{}' },
        worktree: dir,
        dataDir: join(dir, 'data'),
        settings: settings(s),
        signal: new AbortController().signal,
        store,
        sandbox: fakeSandboxRunner(),
        git: fakeGitService(),
        lock: memoryMutationLock(),
        perm: fakePermissionEngine(),
        emitOutput: () => undefined,
        clock: fakeClock(),
        log: memoryLog(),
      };
    }

    it('subject is a network request for the host', () => {
      expect(tool().subject({ url: 'https://Docs.Example.com/x' }, ctx())).toMatchObject({ tool: 'web_fetch', kind: 'network', host: 'docs.example.com', risk: ['network'] });
      expect(tool().readOnly({ url: 'x' })).toBe(true);
    });

    it('returns wrapped, untrusted text', async () => {
      const r = await tool().run({ url: `https://public.test:${port}/html` }, ctx());
      expect(r.ok).toBe(true);
      expect(r.content.startsWith(`<fetched url="https://public.test:${port}/html">`)).toBe(true);
      expect(r.content).toContain('# Docs');
      expect(r.content).not.toContain('x()');
    });

    it('is refused when web fetch is off', async () => {
      expect(await tool().run({ url: `https://public.test:${port}/html` }, ctx({ webFetch: 'off' }))).toMatchObject({ ok: false, errorKind: 'denied' });
    });

    it('spills pages above ~20k tokens', async () => {
      const r = await tool().run({ url: `https://public.test:${port}/long` }, ctx());
      expect(r.spillId).toBe('tc_WEB');
      expect(r.content).toContain('spill:tc_WEB');
      expect(readFileSync(join(dir, 'data', 'spill', 'th1', 'tc_WEB.txt'), 'utf8').length).toBe(150_000);
    });

    it('describes binary content instead of returning it, and reports HTTP errors', async () => {
      expect((await tool().run({ url: `https://public.test:${port}/bin` }, ctx())).content).toContain('[binary content: image/png, 100 bytes');
      const e = await tool().run({ url: `https://public.test:${port}/missing` }, ctx());
      expect(e.ok).toBe(false);
      expect(e.content).toContain('[HTTP 404]');
    });

    it('a redirect to another host is reported, not followed', async () => {
      const r = await tool().run({ url: `https://public.test:${port}/redirect-other` }, ctx());
      expect(r.content).toContain(`redirects to another host: https://other.test:${port}/html`);
    });

    it('policy refusals are denied results', async () => {
      expect(await tool().run({ url: 'https://169.254.169.254/' }, ctx())).toMatchObject({ ok: false, errorKind: 'denied' });
      expect(await tool().run({ url: `https://meta.test:${port}/` }, ctx())).toMatchObject({ ok: false, errorKind: 'denied' });
    });
  });
});
