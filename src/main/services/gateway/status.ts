/**
 * GatewayStatus (harness.md §13.2) from the scheduler, breakers, connectivity gate and meter, with change
 * notifications throttled to one per GATEWAY_LIMITS.statusMinIntervalMs (trailing: the listener always gets the
 * state after the last change).
 */
import type { GatewayModelState, GatewayStatus } from '@shared/contracts/gateway';
import { GATEWAY_LIMITS, type GatewayStatusDeps, type GatewayStatusTracker, type GatewayTimer } from './types';

export function createStatusTracker(deps: GatewayStatusDeps & { minIntervalMs?: number }): GatewayStatusTracker {
  const { scheduler, breaker, connectivity, meter, clock } = deps;
  const interval = deps.minIntervalMs ?? GATEWAY_LIMITS.statusMinIntervalMs;
  const listeners = new Set<(status: GatewayStatus) => void>();
  let timer: GatewayTimer | null = null;
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const snapshot = (): GatewayStatus => {
    const stats = scheduler.stats();
    const models = new Map<string, GatewayModelState>();
    for (const b of breaker.snapshot()) models.set(b.modelKey, { model: b.modelKey, breaker: b.breaker, reopenAt: b.reopenAt, inFlight: 0 });
    for (const [model, n] of Object.entries(stats.inFlightByModel)) {
      if (!(n > 0)) continue;
      const m = models.get(model) ?? { model, breaker: 'closed' as const, reopenAt: null, inFlight: 0 };
      m.inFlight = n;
      models.set(model, m);
    }
    return {
      online: connectivity.online(),
      tpmLimit: stats.tpmLimit,
      tpmEffective: stats.tpmEffective,
      tpmUsedLastMinute: stats.tpmUsedLastMinute,
      queued: stats.queued,
      inFlight: stats.inFlight,
      models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)),
      cacheHitRatio24h: meter.cacheHitRatio24h(),
      last429At: stats.last429At === null ? null : new Date(stats.last429At).toISOString(),
      updatedAt: new Date(clock.now()).toISOString(),
    };
  };

  const emit = () => {
    timer = null;
    if (disposed || listeners.size === 0) return;
    lastEmitAt = clock.now();
    const status = snapshot();
    for (const l of [...listeners]) {
      try {
        l(status);
      } catch {
        // one listener must not break the others
      }
    }
  };

  return {
    snapshot,
    changed() {
      if (disposed || timer !== null) return;
      timer = clock.setTimeout(emit, Math.max(0, lastEmitAt + interval - clock.now()));
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
    },
  };
}
