/**
 * The global connectivity gate (harness.md §4.6). A DNS failure, ECONNREFUSED or ECONNRESET before any response,
 * or the OS reporting offline, closes it: the scheduler admits nothing (queued(offline)), and no breaker counts and
 * no retry budget is used meanwhile. It reopens after one free probe (HEAD of the API host) succeeds: probes run on
 * a backoff (1 s, doubling, ≤ 30 s) while the OS says it is online, and at once when the machine wakes from sleep.
 * Any HTTP response proves connectivity and reopens it too.
 */
import type { Logger } from '../../core/logger';
import type { ConnectivityDeps, ConnectivityGate, GatewayTimer } from './types';

/** errno values that mean "no network" rather than "this one request failed". */
export const OFFLINE_ERRNOS: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const PROBE_BASE_MS = 1_000;
const PROBE_MAX_MS = 30_000;

export function createConnectivityGate(deps: ConnectivityDeps & { log?: Logger }): ConnectivityGate {
  const { signals, probe, clock, log } = deps;
  const listeners = new Set<(online: boolean) => void>();
  let online = safeIsOnline();
  let disposed = false;
  let probing = false;
  let timer: GatewayTimer | null = null;
  let attempt = 0;

  function safeIsOnline(): boolean {
    try {
      return signals.isOnline() !== false;
    } catch {
      return true;
    }
  }

  const set = (next: boolean, why: string) => {
    if (next === online || disposed) return;
    online = next;
    log?.info(next ? 'gateway: back online' : 'gateway: offline; requests wait', { why });
    if (next) {
      attempt = 0;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    } else {
      scheduleProbe();
    }
    for (const l of [...listeners]) {
      try {
        l(online);
      } catch {
        // one listener must not break the others
      }
    }
  };

  function scheduleProbe(delayMs?: number): void {
    if (disposed || online || timer !== null) return;
    const delay = delayMs ?? Math.min(PROBE_MAX_MS, PROBE_BASE_MS * 2 ** attempt);
    timer = clock.setTimeout(() => {
      timer = null;
      void runProbe();
    }, delay);
  }

  async function runProbe(): Promise<void> {
    if (disposed || online || probing) return;
    attempt += 1;
    if (!safeIsOnline()) return scheduleProbe();
    probing = true;
    let ok = false;
    try {
      ok = await probe();
    } catch {
      ok = false;
    } finally {
      probing = false;
    }
    if (disposed) return;
    if (ok) set(true, 'probe');
    else scheduleProbe();
  }

  const offResume = (() => {
    try {
      return signals.onResume(() => {
        if (online || disposed) return;
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
        attempt = 0;
        void runProbe();
      });
    } catch {
      return () => undefined;
    }
  })();

  if (!online) scheduleProbe();

  return {
    online() {
      // The OS saying "offline" closes the gate even before a request fails.
      if (online && !safeIsOnline()) set(false, 'os offline');
      return online;
    },

    reportNetworkFailure(errno) {
      if (!online) return;
      if ((errno !== null && OFFLINE_ERRNOS.has(errno)) || !safeIsOnline()) set(false, errno ?? 'os offline');
    },

    reportResponse() {
      set(true, 'response');
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      listeners.clear();
      offResume();
    },
  };
}
