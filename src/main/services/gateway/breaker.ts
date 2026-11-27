/**
 * Per-model circuit breaker (harness.md §4.6). Counts only 5xx responses and first-byte timeouts from a reachable
 * server (the gateway core records `failure` for exactly those, RetryDecision.countsForBreaker): 5 within 60 s →
 * open for 30 s → half-open (one probe at a time) → closed on success, or open again for twice as long (≤ 5 min).
 * Network-level failures, 4xx and cancellations are `neutral`: they never count and only free a probe slot.
 * "Try anyway" (`force`) turns an open breaker into one half-open probe.
 */
import type { Logger } from '../../core/logger';
import { GATEWAY_LIMITS, type Breaker, type BreakerOutcome, type BreakerState, type GatewayClock, type GatewayTimer } from './types';

interface ModelBreaker {
  failures: number[];
  state: BreakerState;
  reopenAt: number;
  openMs: number;
  probe: boolean;
  /** Who holds the half-open probe (the request id given to tryAcquire); null: an acquire without an owner. */
  probeOwner: string | null;
  timer: GatewayTimer | null;
}

export interface BreakerDeps {
  clock: GatewayClock;
  log?: Logger;
  limits?: Partial<typeof GATEWAY_LIMITS.breaker>;
}

export function createBreaker(deps: BreakerDeps): Breaker {
  const { clock, log } = deps;
  const b = { ...GATEWAY_LIMITS.breaker, ...deps.limits };
  const models = new Map<string, ModelBreaker>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const changed = (key: string, m: ModelBreaker) => {
    log?.debug('gateway.breaker', { model: key, state: m.state, reopenAt: m.state === 'open' ? new Date(m.reopenAt).toISOString() : null });
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // one listener must not break the others
      }
    }
  };

  /** The record, with an elapsed open period turned into half-open. */
  const get = (key: string): ModelBreaker => {
    let m = models.get(key);
    if (!m) {
      m = { failures: [], state: 'closed', reopenAt: 0, openMs: b.openMs, probe: false, probeOwner: null, timer: null };
      models.set(key, m);
    }
    if (m.state === 'open' && clock.now() >= m.reopenAt) {
      m.state = 'half_open';
      m.probe = false;
      m.probeOwner = null;
    }
    return m;
  };

  const clearTimer = (m: ModelBreaker) => {
    if (m.timer !== null) clock.clearTimeout(m.timer);
    m.timer = null;
  };

  const open = (key: string, m: ModelBreaker, openMs: number) => {
    clearTimer(m);
    m.state = 'open';
    m.openMs = openMs;
    m.reopenAt = clock.now() + openMs;
    m.failures = [];
    m.probe = false;
    m.probeOwner = null;
    if (!disposed) {
      // Tell listeners (the scheduler wakes queued requests, the status updates) when it turns half-open.
      m.timer = clock.setTimeout(() => {
        m.timer = null;
        const now = get(key);
        if (now.state === 'half_open') changed(key, now);
      }, openMs);
    }
    changed(key, m);
  };

  return {
    state: (key) => get(key).state,

    tryAcquire(key, opts) {
      const m = get(key);
      if (m.state === 'open' && opts?.force) {
        clearTimer(m);
        m.state = 'half_open';
        m.probe = false;
        m.probeOwner = null;
        changed(key, m);
      }
      if (m.state === 'closed') return true;
      if (m.state === 'half_open' && !m.probe) {
        m.probe = true;
        m.probeOwner = opts?.owner ?? null;
        return true;
      }
      return false;
    },

    record(key, outcome: BreakerOutcome, owner?: string) {
      const m = get(key);
      // Only the probe's own outcome decides half-open: a request admitted before the breaker opened (a long
      // prefill) that settles now must neither close nor reopen it, nor free the probe slot.
      const wasProbe = m.state === 'half_open' && m.probe && (m.probeOwner === null || m.probeOwner === owner);
      if (wasProbe) {
        m.probe = false;
        m.probeOwner = null;
      }
      if (outcome === 'neutral') return;
      if (outcome === 'success') {
        if (wasProbe) {
          m.state = 'closed';
          m.openMs = b.openMs;
          m.failures = [];
          changed(key, m);
        }
        return;
      }
      if (wasProbe) return open(key, m, Math.min(b.maxOpenMs, m.openMs * 2));
      // A failure of a request admitted before the breaker opened (or while half-open, not the probe): only a
      // closed breaker counts it.
      if (m.state !== 'closed') return;
      const now = clock.now();
      m.failures = m.failures.filter((t) => now - t < b.windowMs);
      m.failures.push(now);
      if (m.failures.length >= b.failures) open(key, m, b.openMs);
    },

    snapshot() {
      const out: Array<{ modelKey: string; breaker: BreakerState; reopenAt: string | null }> = [];
      for (const key of models.keys()) {
        const m = get(key);
        if (m.state === 'closed') continue;
        out.push({ modelKey: key, breaker: m.state, reopenAt: m.state === 'open' ? new Date(m.reopenAt).toISOString() : null });
      }
      return out;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      for (const m of models.values()) clearTimer(m);
      listeners.clear();
    },
  };
}
