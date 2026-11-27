import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockedAddressReason, checkHost, createNetProxy, createSafeLookup, parseIpv6, resolvePublic, type NetProxy, type Resolver } from '@harness/sandbox/netproxy';
import { memoryLog } from '../fakes';

// The SSRF IP table shared by web_fetch and the shell proxy (§8.5, H-T9).
const BLOCKED: string[] = [
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.127.255.254',
  '127.0.0.1',
  '127.1.2.3',
  '169.254.169.254',
  '169.254.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.8',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '::127.0.0.1',
  '64:ff9b::7f00:1',
  '64:ff9b::a9fe:a9fe',
  '64:ff9b:1::1',
  '100::1',
  '2001::1',
  '2001:db8::1',
  '2001:10::1',
  '2002:7f00:1::1',
  '2002:c0a8:101::1',
  'fc00::1',
  'fd00::1',
  'fdff:ffff::1',
  'fe80::1',
  'fe80::1%eth0',
  'febf::1',
  'fec0::1',
  'ff02::1',
  'ff0e::1',
];
const ALLOWED: string[] = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '192.169.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8'];

describe('SSRF IP table', () => {
  it.each(BLOCKED)('blocks %s', (ip) => {
    expect(blockedAddressReason(ip)).not.toBeNull();
  });
  it.each(ALLOWED)('allows %s', (ip) => {
    expect(blockedAddressReason(ip)).toBeNull();
  });
  it('treats non-IPs as blocked', () => {
    expect(blockedAddressReason('example.com')).not.toBeNull();
    expect(blockedAddressReason('1.2.3')).not.toBeNull();
    expect(blockedAddressReason('1.2.3.256')).not.toBeNull();
  });
  it('parses IPv6 forms', () => {
    expect(parseIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIpv6('[fe80::1%eth0]')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIpv6('1::2::3')).toBeNull();
  });
});

const fakeResolver = (map: Record<string, string[]>): Resolver => async (h) => {
  const a = map[h.toLowerCase()];
  if (!a) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('host checks and the safe lookup', () => {
  const resolver = fakeResolver({ 'public.test': ['93.184.216.34'], 'rebind.test': ['93.184.216.34', '127.0.0.1'], 'meta.test': ['169.254.169.254'], 'ula.test': ['fd00::1'] });

  it('checkHost refuses IP literals in blocked ranges and localhost names', () => {
    for (const h of ['127.0.0.1', '[::1]', '10.0.0.1', '169.254.169.254', 'fd00::1', 'localhost', 'a.localhost', '']) expect(() => checkHost(h), h).toThrow();
    expect(() => checkHost('example.com')).not.toThrow();
    expect(() => checkHost('8.8.8.8')).not.toThrow();
    expect(() => checkHost('bad_host!')).toThrow();
    expect(() => checkHost('example.com', (h) => h !== 'example.com')).toThrow(/host policy/);
  });

  it('resolvePublic refuses when ANY address is blocked (DNS rebinding)', async () => {
    await expect(resolvePublic('public.test', resolver)).resolves.toHaveLength(1);
    await expect(resolvePublic('rebind.test', resolver)).rejects.toThrow(/127\.0\.0\.1/);
    await expect(resolvePublic('meta.test', resolver)).rejects.toThrow(/169\.254/);
    await expect(resolvePublic('ula.test', resolver)).rejects.toThrow(/ULA/);
    await expect(resolvePublic('nx.test', resolver)).rejects.toThrow(/resolve/);
  });

  it('the lookup answers single and all forms, and errors for blocked names', async () => {
    const lookup = createSafeLookup(resolver);
    const one = await new Promise<[unknown, unknown, unknown]>((r) => lookup('public.test', {}, (e, a, f) => r([e, a, f])));
    expect(one).toEqual([null, '93.184.216.34', 4]);
    const all = await new Promise<[unknown, unknown]>((r) => lookup('public.test', { all: true }, (e, a) => r([e, a])));
    expect(all[1]).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const bad = await new Promise<NodeJS.ErrnoException | null>((r) => lookup('rebind.test', {}, (e) => r(e)));
    expect(bad?.code).toBe('EGMIDBLOCKED');
  });
});

/** Sends raw bytes to the proxy's Unix socket and collects the reply. */
function talk(socketPath: string, data: string): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(socketPath);
    let out = '';
    s.on('data', (c) => (out += c.toString('latin1')));
    s.on('close', () => resolve(out));
    s.on('error', () => resolve(out));
    s.write(data);
    setTimeout(() => s.end(), 1500);
  });
}

describe('CONNECT proxy (unit, no sandbox)', () => {
  let dir: string;
  let proxy: NetProxy;
  let upstream: Server;
  let port = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gmid-proxy-'));
    upstream = createServer((c) => {
      c.once('data', (d) => {
        const first = d.toString('latin1').split('\r\n')[0] ?? '';
        c.end(`HTTP/1.1 200 OK\r\nContent-Length: ${first.length}\r\nConnection: close\r\n\r\n${first}`);
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.2', r));
    port = (upstream.address() as { port: number }).port;
    proxy = await createNetProxy({
      dir: join(dir, 'proxy'),
      log: memoryLog(),
      resolver: fakeResolver({ 'public.test': ['127.0.0.2'], 'meta.test': ['169.254.169.254'], 'lan.test': ['192.168.1.1'], 'ula.test': ['fd00::1'], 'rebind.test': ['127.0.0.2', '127.0.0.1'] }),
      // Test hook: only 127.0.0.2 stands in for a public address; everything else uses the real table.
      addressCheck: (ip) => (ip === '127.0.0.2' ? null : blockedAddressReason(ip)),
    });
  });
  afterAll(async () => {
    await proxy.close();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lives in a private 0700 directory with a 0600 socket and the forwarder script', () => {
    expect(statSync(join(dir, 'proxy')).mode & 0o777).toBe(0o700);
    expect(statSync(proxy.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'proxy', 'forwarder.cjs')).isFile()).toBe(true);
  });

  it('relays an absolute-form HTTP request to an allowed host, in origin form', async () => {
    const out = await talk(proxy.socketPath, `GET http://public.test:${port}/hello?x=1 HTTP/1.1\r\nHost: public.test\r\nProxy-Connection: keep-alive\r\n\r\n`);
    expect(out).toContain('200 OK');
    expect(out).toContain('GET /hello?x=1 HTTP/1.1');
  });

  it('opens a CONNECT tunnel to an allowed host', async () => {
    const out = await talk(proxy.socketPath, `CONNECT public.test:${port} HTTP/1.1\r\nHost: public.test\r\n\r\nGET /tunnel HTTP/1.1\r\n\r\n`);
    expect(out).toContain('200 Connection Established');
    expect(out).toContain('GET /tunnel HTTP/1.1');
  });

  it.each([
    ['CONNECT 127.0.0.1:443', 'loopback literal'],
    ['CONNECT [::1]:443', 'IPv6 loopback literal'],
    ['CONNECT 10.0.0.1:443', 'RFC 1918 literal'],
    ['CONNECT 169.254.169.254:80', 'metadata literal'],
    ['CONNECT [fd00::1]:443', 'ULA literal'],
    ['CONNECT meta.test:80', 'name → metadata'],
    ['CONNECT lan.test:443', 'name → LAN'],
    ['CONNECT ula.test:443', 'name → ULA'],
    ['CONNECT rebind.test:443', 'name → one public + one loopback'],
    ['CONNECT localhost:443', 'localhost'],
    ['GET http://127.0.0.1:5199/', 'absolute-form loopback (the Vite dev server)'],
    ['GET http://169.254.169.254/latest/meta-data/', 'absolute-form metadata'],
  ])('refuses %s (%s)', async (line) => {
    const out = await talk(proxy.socketPath, `${line} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(out).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(out).toContain('network policy');
  });

  it('rejects malformed requests', async () => {
    expect(await talk(proxy.socketPath, 'HELLO\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
    expect(await talk(proxy.socketPath, 'GET /relative HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 400/);
    expect(await talk(proxy.socketPath, `GET https://public.test:${port}/ HTTP/1.1\r\n\r\n`)).toMatch(/^HTTP\/1\.1 400/);
    expect(await talk(proxy.socketPath, `GET http://x/${'a'.repeat(20_000)}`)).toMatch(/^HTTP\/1\.1 431/);
  });

  it('counts refusals', () => {
    expect(proxy.refused).toBeGreaterThan(5);
  });
});
