import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { renderCallbackPage, startLoopbackServer, type LoopbackServer } from '@main/services/auth/loopback';
import { ISSUER } from './helpers';

const open: LoopbackServer[] = [];

async function start(opts: Partial<Parameters<typeof startLoopbackServer>[0]> = {}) {
  const lb = await startLoopbackServer({ expectedState: 'state-123', issuer: ISSUER, appName: 'GMI Desk', timeoutMs: 5_000, ...opts });
  open.push(lb);
  return lb;
}

const pending = Symbol('pending');
async function settledWithin<T>(promise: Promise<T>, ms = 60): Promise<T | typeof pending> {
  return Promise.race([promise, new Promise<typeof pending>((r) => setTimeout(() => r(pending), ms))]);
}

function rawGet(port: number, path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((lb) => lb.close()));
});

describe('loopback redirect server', () => {
  it('binds 127.0.0.1 and serves one successful callback, then closes', async () => {
    const lb = await start();
    expect(lb.redirectUri).toBe(`http://127.0.0.1:${lb.port}/callback`);
    const response = fetch(`${lb.redirectUri}?code=auth-code&state=state-123&iss=${encodeURIComponent(ISSUER)}`);
    await expect(lb.code).resolves.toBe('auth-code');
    await lb.finish({ ok: true });
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Signed in to GMI.');
    expect(html).toContain('You can close this tab and return to GMI Desk.');
    expect(html).not.toMatch(/<script|https?:\/\/(?!127\.0\.0\.1)/i);
    await expect(fetch(lb.redirectUri)).rejects.toThrow();
  });

  it('shows the failure page when the token exchange fails', async () => {
    const lb = await start();
    const response = fetch(`${lb.redirectUri}?code=c&state=state-123`);
    await lb.code;
    await lb.finish({ ok: false, message: 'GMI did not accept the sign-in.' });
    const res = await response;
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Sign-in failed.');
    expect(html).toContain('GMI did not accept the sign-in.');
  });

  it('refuses a mismatched state but keeps waiting for the real callback', async () => {
    const lb = await start();
    const bad = await fetch(`${lb.redirectUri}?code=evil&state=wrong`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('does not match');
    const missing = await fetch(`${lb.redirectUri}?code=evil`);
    expect(missing.status).toBe(400);
    expect(await settledWithin(lb.code)).toBe(pending);

    const good = fetch(`${lb.redirectUri}?code=real&state=state-123`);
    await expect(lb.code).resolves.toBe('real');
    await lb.finish({ ok: true });
    expect((await good).status).toBe(200);
  });

  it('rejects with the mapped error when GMI redirects with an error', async () => {
    const lb = await start();
    const res = await fetch(`${lb.redirectUri}?error=access_denied&error_description=User%20denied&state=state-123`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Sign-in was declined in the browser.');
    await expect(lb.code).rejects.toMatchObject({ code: 'cancelled', message: 'Sign-in was declined in the browser.' });

    const lb2 = await start();
    void fetch(`${lb2.redirectUri}?error=server_error&state=state-123`).catch(() => undefined);
    await expect(lb2.code).rejects.toMatchObject({ code: 'upstream' });
  });

  it('rejects a callback whose iss is not the expected issuer (mix-up defence)', async () => {
    const lb = await start();
    const res = await fetch(`${lb.redirectUri}?code=c&state=state-123&iss=${encodeURIComponent('https://evil.example')}`);
    expect(res.status).toBe(400);
    await expect(lb.code).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('answers 404 for other paths, 405 for other methods and 400 for foreign Host headers', async () => {
    const lb = await start();
    expect((await fetch(`http://127.0.0.1:${lb.port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${lb.port}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${lb.port}/callback/../admin`)).status).toBe(404);
    const post = await fetch(`${lb.redirectUri}?code=c&state=state-123`, { method: 'POST' });
    expect(post.status).toBe(405);
    const rebinding = await rawGet(lb.port, '/callback?code=c&state=state-123', `attacker.example:${lb.port}`);
    expect(rebinding.status).toBe(400);
    expect(await settledWithin(lb.code)).toBe(pending);
  });

  it('times out', async () => {
    const lb = await start({ timeoutMs: 40 });
    await expect(lb.code).rejects.toMatchObject({ code: 'timeout' });
    await expect(fetch(lb.redirectUri)).rejects.toThrow();
  });

  it('is cancelled by its abort signal and by close()', async () => {
    const controller = new AbortController();
    const lb = await start({ signal: controller.signal });
    controller.abort();
    await expect(lb.code).rejects.toMatchObject({ code: 'cancelled' });

    const lb2 = await start();
    await lb2.close();
    await expect(lb2.code).rejects.toMatchObject({ code: 'cancelled' });
    await expect(fetch(lb2.redirectUri)).rejects.toThrow();
  });

  it('reuses the preferred port when free and falls back when it is taken', async () => {
    const first = await start();
    const port = first.port;
    await first.close();
    const again = await start({ preferredPort: port });
    expect(again.port).toBe(port);
    await again.close();

    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as AddressInfo).port;
    try {
      const lb = await start({ preferredPort: taken });
      expect(lb.port).not.toBe(taken);
      expect(lb.port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('escapes messages in the callback page', () => {
    const html = renderCallbackPage('error', 'GMI Desk', '<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
