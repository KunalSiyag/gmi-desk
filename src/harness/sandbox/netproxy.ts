/**
 * Network policy shared by web_fetch and the shell's CONNECT proxy (harness.md §8.3, §8.5, H-T9, SC-8).
 *
 * - `blockedAddressReason(ip)`: the SSRF table (IPv4 and IPv6): loopback, RFC 1918, link-local (incl.
 *   169.254.169.254), CGNAT, multicast, reserved and documentation ranges, IPv6 ULA / link-local / site-local, and
 *   IPv4 embedded in IPv6 (mapped, compatible, NAT64, 6to4, Teredo) checked as IPv4.
 * - `createSafeLookup()`: a `lookup` for net/https that resolves itself and refuses when ANY resolved address is
 *   blocked, so the connect address is the checked address (no DNS rebinding between check and connect). IP literals
 *   never reach `lookup` in Node, so every caller also runs `checkHost()` first.
 * - `createNetProxy()`: an HTTP CONNECT (and absolute-form HTTP) proxy on a Unix socket in a private 0700 directory,
 *   bind-mounted read-only into the sandbox at /run/gmid-proxy, where the in-sandbox forwarder relays to it.
 */
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { createServer, connect as netConnect, isIP, type Server, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { HostLog } from '../types';
import { FORWARDER_NAME, PROXY_SOCKET_NAME } from './profiles';
import { FORWARDER_SOURCE } from './forwarder';

// ─── The IP table ─────────────────────────────────────────────────────────────────────────────────────────────

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const V4_BLOCKS: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private (RFC 1918)'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private (RFC 1918)'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay'],
  ['192.168.0.0', 16, 'private (RFC 1918)'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved / broadcast'],
];

function v4Reason(ip: string): string | null {
  const n = v4ToInt(ip);
  if (n === null) return 'invalid address';
  for (const [base, bits, why] of V4_BLOCKS) {
    const b = v4ToInt(base) as number;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return why;
  }
  return null;
}

/** Parses an IPv6 address (with optional embedded IPv4 and zone) into 8 16-bit groups. */
export function parseIpv6(input: string): number[] | null {
  let ip = input.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(':');
  if (ip.slice(lastColon + 1).includes('.')) {
    const n = v4ToInt(ip.slice(lastColon + 1));
    if (n === null) return null;
    tail = [Math.floor(n / 65536), n % 65536];
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else groups = head;
  if (groups.length !== 8) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

function v6Reason(ip: string): string | null {
  const parsed = parseIpv6(ip);
  if (!parsed) return 'invalid address';
  const g = parsed as [number, number, number, number, number, number, number, number];
  const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return 'unspecified';
  if (zeros(0, 7) && g[7] === 1) return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d → check the IPv4.
  if (zeros(0, 5) && g[5] === 0xffff) return v4Reason(v4of(g[6], g[7])) ?? null;
  if (zeros(0, 6)) return 'IPv4-compatible (deprecated)';
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48.
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Reason(v4of(g[6], g[7])) ?? (g[2] === 1 ? 'local NAT64' : null);
  if (g[0] === 0x0100 && zeros(1, 4)) return 'discard prefix';
  if (g[0] === 0x2001 && g[1] === 0) return 'Teredo';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return 'ORCHID';
  if (g[0] === 0x2002) return v4Reason(v4of(g[1], g[2])) ?? null; // 6to4 embeds an IPv4
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique local (ULA)';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/** Canonical text of an IP (lower-case, compressed IPv6) so it compares equal to os.networkInterfaces() output. */
export function canonicalIp(ip: string): string {
  const bare = bareIp(ip);
  if (isIP(bare) === 6) {
    try {
      return new URL(`http://[${bare}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
      return bare.toLowerCase();
    }
  }
  return bare;
}

/** This machine's own addresses (every interface, IPv4 and IPv6), cached for a few seconds. */
let localCache: { at: number; set: Set<string> } | null = null;
export const LOCAL_ADDRESS_TTL_MS = 5_000;
export function localInterfaceAddresses(now: number = Date.now()): Set<string> {
  if (localCache && now - localCache.at < LOCAL_ADDRESS_TTL_MS) return localCache.set;
  const set = new Set<string>();
  try {
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) set.add(canonicalIp(a.address));
  } catch {
    // No interface list: the table alone decides.
  }
  localCache = { at: now, set };
  return set;
}

/**
 * Why connecting to this IP is refused, or null when it is a public unicast address that is not this machine's
 * own (review H2: a global IPv6 of the host's own interface reached services bound to the wildcard address).
 */
export function blockedAddressReason(ip: string): string | null {
  const family = isIP(bareIp(ip));
  const table = family === 4 ? v4Reason(ip) : family === 6 ? v6Reason(ip) : 'not an IP address';
  if (table) return table;
  const own = localInterfaceAddresses();
  const c = canonicalIp(ip);
  if (own.has(c)) return 'an address of this computer';
  // IPv4-mapped / NAT64 / 6to4 forms of an own IPv4.
  if (family === 6) {
    const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(c);
    if (m && own.has(m[1] as string)) return 'an address of this computer';
  }
  return null;
}

/** The address part of an IP literal (no brackets, no zone). */
function bareIp(ip: string): string {
  return ip.replace(/^\[|\]$/g, '').split('%')[0] ?? '';
}

// ─── Host checks and lookup ───────────────────────────────────────────────────────────────────────────────────

export class NetPolicyError extends Error {
  constructor(
    message: string,
    readonly reason: 'blocked_address' | 'host_policy' | 'invalid_host' | 'dns',
  ) {
    super(message);
    this.name = 'NetPolicyError';
  }
}

export type HostPolicy = (host: string) => boolean;
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

const HOSTNAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$/;

/** Validates a host name or IP literal; IP literals are checked against the table here (Node skips `lookup` for them). */
export function checkHost(host: string, policy?: HostPolicy): void {
  const h = host.replace(/^\[|\]$/g, '');
  if (h.length === 0 || h.includes('\0')) throw new NetPolicyError('Invalid host.', 'invalid_host');
  if (isIP(bareIp(h))) {
    const why = blockedAddressReason(h);
    if (why) throw new NetPolicyError(`Address ${h} is not allowed (${why}).`, 'blocked_address');
  } else if (!HOSTNAME.test(h)) throw new NetPolicyError('Invalid host name.', 'invalid_host');
  else if (/^localhost\.?$|\.localhost\.?$/i.test(h)) throw new NetPolicyError('localhost is not allowed.', 'blocked_address');
  if (policy && !policy(h.toLowerCase())) throw new NetPolicyError(`Host ${h} is not allowed by the project's host policy.`, 'host_policy');
}

/** Resolves and returns only if every address is public. */
export async function resolvePublic(host: string, resolver: Resolver = defaultResolver): Promise<LookupAddress[]> {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIP(bareIp(h))) {
    checkHost(h);
    return [{ address: h, family: isIP(bareIp(h)) }];
  }
  let addrs: LookupAddress[];
  try {
    addrs = await resolver(h);
  } catch (e) {
    throw new NetPolicyError(`Could not resolve ${h} (${(e as NodeJS.ErrnoException).code ?? 'error'}).`, 'dns');
  }
  if (addrs.length === 0) throw new NetPolicyError(`Could not resolve ${h}.`, 'dns');
  for (const a of addrs) {
    const why = blockedAddressReason(a.address);
    if (why) throw new NetPolicyError(`${h} resolves to ${a.address}, which is not allowed (${why}).`, 'blocked_address');
  }
  return addrs;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `lookup` option for net/tls/https: the result IS the connect address, so a rebinding resolver cannot slip past. */
export function createSafeLookup(resolver: Resolver = defaultResolver) {
  return (hostname: string, options: { all?: boolean } | number | LookupCallback, cb?: LookupCallback): void => {
    const callback = (typeof options === 'function' ? options : cb) as LookupCallback;
    const all = typeof options === 'object' && options !== null && options.all === true;
    resolvePublic(hostname, resolver).then(
      (addrs) => {
        const first = addrs[0] as LookupAddress;
        if (all) callback(null, addrs);
        else callback(null, first.address, first.family);
      },
      (err: Error) => callback(Object.assign(err, { code: 'EGMIDBLOCKED' }) as NodeJS.ErrnoException, all ? [] : '', 0),
    );
  };
}

// ─── The CONNECT proxy ────────────────────────────────────────────────────────────────────────────────────────

export interface NetProxyOptions {
  /** Private directory (created 0700); holds `proxy.sock` and the forwarder script. */
  dir: string;
  log: HostLog;
  resolver?: Resolver;
  hostPolicy?: HostPolicy;
  /** Test hook only: replaces the address check (the production proxy never sets it). */
  addressCheck?: (ip: string) => string | null;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
}

export interface NetProxy {
  readonly dir: string;
  readonly socketPath: string;
  /** Connections refused by policy since start (for tests and diagnostics). */
  readonly refused: number;
  close(): Promise<void>;
}

const MAX_HEAD = 16 * 1024;

function parseTarget(target: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[0-9A-Fa-f:.%]+\]|[^:/\s]+)(?::(\d{1,5}))?$/.exec(target);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host: (m[1] ?? '').replace(/^\[|\]$/g, ''), port };
}

export async function createNetProxy(opts: NetProxyOptions): Promise<NetProxy> {
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  chmodSync(opts.dir, 0o700);
  const socketPath = join(opts.dir, PROXY_SOCKET_NAME);
  rmSync(socketPath, { force: true });
  writeFileSync(join(opts.dir, FORWARDER_NAME), FORWARDER_SOURCE, { mode: 0o644 });
  const resolver = opts.resolver ?? defaultResolver;
  const check = opts.addressCheck ?? blockedAddressReason;
  const connectTimeout = opts.connectTimeoutMs ?? 15_000;
  const idle = opts.idleTimeoutMs ?? 5 * 60_000;
  const sockets = new Set<Socket>();
  let refused = 0;
  const log = opts.log;

  async function resolveTarget(host: string): Promise<string> {
    checkHostShape(host);
    if (opts.hostPolicy && !opts.hostPolicy(host.toLowerCase())) throw new NetPolicyError('host policy', 'host_policy');
    const literal = isIP(bareIp(host)) ? [{ address: host, family: isIP(bareIp(host)) }] : null;
    let addrs: LookupAddress[];
    if (literal) addrs = literal;
    else {
      try {
        addrs = await resolver(host);
      } catch {
        throw new NetPolicyError('dns', 'dns');
      }
    }
    if (addrs.length === 0) throw new NetPolicyError('dns', 'dns');
    for (const a of addrs) if (check(a.address)) throw new NetPolicyError('blocked', 'blocked_address');
    return (addrs[0] as LookupAddress).address;
  }

  function checkHostShape(host: string): void {
    if (!host || host.includes('\0') || host.length > 253) throw new NetPolicyError('invalid', 'invalid_host');
    if (!isIP(bareIp(host)) && !HOSTNAME.test(host)) throw new NetPolicyError('invalid', 'invalid_host');
    if (!isIP(host) && /^localhost\.?$|\.localhost\.?$/i.test(host)) throw new NetPolicyError('blocked', 'blocked_address');
  }

  function refuse(client: Socket, status: string, why: string): void {
    refused += 1;
    log.info('proxy refused', { reason: why });
    client.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${why.length + 1}\r\n\r\n${why}\n`);
  }

  function relay(client: Socket, ip: string, port: number, onConnect: (upstream: Socket) => void): void {
    const upstream = netConnect({ host: ip, port });
    let connected = false;
    sockets.add(upstream);
    upstream.setTimeout(connectTimeout);
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(idle);
      onConnect(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!client.destroyed && !connected) refuse(client, '502 Bad Gateway', 'upstream connection failed');
      else client.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      if (connected && !client.writableEnded) client.end();
    });
    client.on('close', () => upstream.destroy());
  }

  const server: Server = createServer((client) => {
    if (sockets.size >= (opts.maxConnections ?? 256)) {
      client.destroy();
      return;
    }
    sockets.add(client);
    client.setTimeout(idle, () => client.destroy());
    client.on('error', () => client.destroy());
    client.on('close', () => sockets.delete(client));
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_HEAD) refuse(client, '431 Request Header Fields Too Large', 'header too large');
        return;
      }
      client.off('data', onData);
      client.pause();
      const headText = head.subarray(0, end).toString('latin1');
      const rest = head.subarray(end + 4);
      const [requestLine = '', ...headerLines] = headText.split('\r\n');
      const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
      if (!m) return refuse(client, '400 Bad Request', 'bad request');
      const method = m[1] ?? '';
      const target = m[2] ?? '';
      if (method === 'CONNECT') {
        const t = parseTarget(target, 443);
        if (!t) return refuse(client, '400 Bad Request', 'bad CONNECT target');
        resolveTarget(t.host).then(
          (ip) =>
            relay(client, ip, t.port, (up) => {
              client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              if (rest.length) up.write(rest);
              client.resume();
            }),
          (e: NetPolicyError) => refuse(client, '403 Forbidden', `refused by GMI Desk network policy (${e.reason})`),
        );
        return;
      }
      // Absolute-form plain HTTP (HTTP_PROXY for http:// URLs).
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        return refuse(client, '400 Bad Request', 'absolute URL required');
      }
      if (url.protocol !== 'http:') return refuse(client, '400 Bad Request', 'only http:// in absolute form; use CONNECT for https');
      const t = parseTarget(url.host, 80);
      if (!t) return refuse(client, '400 Bad Request', 'bad host');
      const headers = headerLines.filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive)\s*:/i.test(l));
      const outHead = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n${[...headers, 'Connection: close'].join('\r\n')}\r\n\r\n`;
      resolveTarget(t.host).then(
        (ip) =>
          relay(client, ip, t.port, (up) => {
            up.write(outHead, 'latin1');
            if (rest.length) up.write(rest);
            client.resume();
          }),
        (e: NetPolicyError) => refuse(client, '403 Forbidden', `refused by GMI Desk network policy (${e.reason})`),
      );
    };
    client.on('data', onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  server.on('error', (e) => log.warn('proxy error', { code: (e as NodeJS.ErrnoException).code ?? null }));

  return {
    dir: opts.dir,
    socketPath,
    get refused() {
      return refused;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}
