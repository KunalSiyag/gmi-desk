// Listening-port detection for the computer's Ports tab (compute.md §8.4, §9.5; C2-B).
//
// - One exec: `cat /proc/net/tcp /proc/net/tcp6` (works in every image), then `ss -ltnpH` only when `ss` exists, for
//   process names. Rows with `st == 0A` (LISTEN) are kept; `previewable` = port above 0 and not bound to loopback only.
// - The scan is app-originated: it never counts as activity, so an open Ports tab cannot keep a sandbox alive.
// - Detection runs only while the Ports tab is visible and the window is not hidden. The renderer polls `listPorts`
//   every 5 s while the tab is visible; main adds the floor: calls are coalesced (one scan in flight per session),
//   answered from a cache younger than 4 s, and served from the cache without an exec while the window is hidden.
import type { PortInfo } from '@shared/contracts/compute';
import type { Logger } from '../../../core/logger';
import type { ComputerTarget, ExecRunner } from './exec';

export const PORT_SCAN_TIMEOUT_SEC = 10;
/** The renderer's cadence while the Ports tab is visible (§8.4). */
export const PORT_SCAN_INTERVAL_MS = 5_000;
/** Calls closer together than this are answered from the last scan. */
export const PORT_SCAN_MIN_INTERVAL_MS = 4_000;

const SS_MARKER = '--GMID-SS--';
export const PORT_SCAN_COMMAND = `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; echo ${SS_MARKER}; command -v ss >/dev/null 2>&1 && ss -ltnpH 2>/dev/null`;

/** TCP state LISTEN in /proc/net/tcp. */
const TCP_LISTEN = '0A';

export interface ListenSocket {
  address: string;
  port: number;
  loopback: boolean;
}

/** `0100007F` → `127.0.0.1` (the kernel prints the address in host byte order: little-endian on x86/arm). */
function ipv4FromHex(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
  const n = Number.parseInt(hex, 16);
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff].join('.');
}

/** 32 hex digits = four 32-bit words, each in host byte order. */
function ipv6FromHex(hex: string): string | null {
  if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return null;
  const bytes: number[] = [];
  for (let w = 0; w < 4; w += 1) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let b = 3; b >= 0; b -= 1) bytes.push(Number.parseInt(word.slice(b * 2, b * 2 + 2), 16));
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] as number) << 8) | (bytes[i + 1] as number)).toString(16));
  // v4-mapped (::ffff:a.b.c.d)
  if (groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') return `::ffff:${bytes.slice(12).join('.')}`;
  // Compress the longest run of zero groups.
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j += 1;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

export function isLoopback(address: string): boolean {
  return /^127\./.test(address) || address === '::1' || /^::ffff:127\./.test(address);
}

/**
 * Parses `/proc/net/tcp` and `/proc/net/tcp6` text (one or both, headers included) into LISTEN sockets. The family
 * comes from the address width (8 or 32 hex digits). Malformed rows are skipped.
 */
export function parseProcNetTcp(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const raw of text.split('\n')) {
    const cols = raw.trim().split(/\s+/);
    // sl local_address rem_address st …
    if (cols.length < 4 || !/^\d+:$/.test(cols[0] ?? '')) continue;
    if ((cols[3] ?? '').toUpperCase() !== TCP_LISTEN) continue;
    const [addrHex = '', portHex = ''] = (cols[1] ?? '').split(':');
    if (!/^[0-9A-Fa-f]{1,4}$/.test(portHex)) continue;
    const port = Number.parseInt(portHex, 16);
    const address = addrHex.length === 8 ? ipv4FromHex(addrHex) : addrHex.length === 32 ? ipv6FromHex(addrHex) : null;
    if (address === null || !Number.isInteger(port) || port < 0 || port > 65535) continue;
    out.push({ address, port, loopback: isLoopback(address) });
  }
  return out;
}

/** Process names by port from `ss -ltnpH` (`… 0.0.0.0:8000 0.0.0.0:* users:(("python3",pid=12,fd=3))`). */
export function parseSsProcesses(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    // State Recv-Q Send-Q Local Peer [Process]; some versions omit State with -l.
    const local = cols.find((c, i) => i >= 2 && /:\d+$/.test(c) && i < cols.length - 1) ?? '';
    const port = Number(/:(\d+)$/.exec(local)?.[1] ?? NaN);
    const name = /users:\(\("([^"]{1,64})"/.exec(line)?.[1];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !name) continue;
    if (!names.has(port)) names.set(port, name.replace(/[\u0000-\u001f\u007f]/g, ''));
  }
  return names;
}

/** Merges sockets by port: previewable when any bind is not loopback; the shown address prefers a public bind. */
export function toPortInfos(sockets: ListenSocket[], processes: Map<number, string> = new Map()): PortInfo[] {
  const byPort = new Map<number, ListenSocket[]>();
  for (const s of sockets) {
    const list = byPort.get(s.port) ?? [];
    list.push(s);
    byPort.set(s.port, list);
  }
  return [...byPort.entries()]
    .sort(([a], [b]) => a - b)
    .map(([port, list]) => {
      const open = list.find((s) => !s.loopback);
      return {
        port,
        address: (open ?? (list[0] as ListenSocket)).address,
        process: processes.get(port) ?? null,
        previewable: port > 0 && open !== undefined,
      };
    });
}

/** Parses the whole scan output (`/proc/net/tcp*`, the marker, then `ss` when present). */
export function parsePortScan(stdout: string): PortInfo[] {
  const i = stdout.indexOf(SS_MARKER);
  const proc = i >= 0 ? stdout.slice(0, i) : stdout;
  const ss = i >= 0 ? stdout.slice(i + SS_MARKER.length) : '';
  return toPortInfos(parseProcNetTcp(proc), parseSsProcesses(ss));
}

export interface PortScanner {
  /** One scan now (an app exec, never activity). Used by `listPorts` and the service start wait. */
  scan(target: ComputerTarget, opts?: { signal?: AbortSignal }): Promise<PortInfo[]>;
  /** The Ports tab's poll: coalesced, cached for 4 s, and exec-free while the window is hidden. */
  listPorts(target: ComputerTarget): Promise<PortInfo[]>;
  forget(sessionId: string): void;
}

export interface PortScannerDeps {
  runner: ExecRunner;
  log: Logger;
  /** True while the main window is hidden or minimised (no scans then). */
  windowHidden?: () => boolean;
  nowMs?: () => number;
}

export function createPortScanner(deps: PortScannerDeps): PortScanner {
  const log = deps.log.child('computer.ports');
  const nowMs = deps.nowMs ?? (() => Date.now());
  const cache = new Map<string, { at: number; ports: PortInfo[] }>();
  const inflight = new Map<string, Promise<PortInfo[]>>();

  async function scan(target: ComputerTarget, opts: { signal?: AbortSignal } = {}): Promise<PortInfo[]> {
    const result = await deps.runner.run(target, { command: PORT_SCAN_COMMAND, timeoutSec: PORT_SCAN_TIMEOUT_SEC, origin: 'app', signal: opts.signal });
    // `cat` exits 1 when tcp6 is missing (IPv6 off): whatever it printed still counts.
    const ports = parsePortScan(result.stdout ?? '');
    cache.set(target.sessionId, { at: nowMs(), ports });
    return ports;
  }

  return {
    scan,
    listPorts(target) {
      const cached = cache.get(target.sessionId);
      if (cached && (deps.windowHidden?.() || nowMs() - cached.at < PORT_SCAN_MIN_INTERVAL_MS)) return Promise.resolve(cached.ports.map((p) => ({ ...p })));
      if (!cached && deps.windowHidden?.()) return Promise.resolve([]);
      const running = inflight.get(target.sessionId);
      if (running) return running;
      const p = scan(target)
        .catch((error: unknown) => {
          log.debug('port scan failed');
          throw error;
        })
        .finally(() => inflight.delete(target.sessionId));
      inflight.set(target.sessionId, p);
      return p;
    },
    forget(sessionId) {
      cache.delete(sessionId);
      inflight.delete(sessionId);
    },
  };
}
