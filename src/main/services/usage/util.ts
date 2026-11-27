import { access } from 'node:fs/promises';
import { GmiError } from '@shared/contracts/errors';
import { USAGE_MAX_DAYS, USAGE_MIN_DAYS } from '@shared/contracts/usage';

export const DAY_MS = 86_400_000;

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GMI refuses out-of-range periods instead of clamping them, so the app validates first. */
export function assertDays(days: unknown): number {
  if (typeof days !== 'number' || !Number.isInteger(days) || days < USAGE_MIN_DAYS || days > USAGE_MAX_DAYS) {
    throw new GmiError('invalid_input', `The period must be a whole number of days from ${USAGE_MIN_DAYS} to ${USAGE_MAX_DAYS}.`, {
      detail: `got ${String(days)}`,
    });
  }
  return days;
}

/** "36.306068" → 36.306068, 12 → 12; null for absent, empty or non-numeric values (never 0). */
export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Rounds away float noise from sums of money (keeps micro-dollar precision). */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Small TTL cache with in-flight de-duplication: concurrent loads of one key share a single call,
 * failures are never cached.
 */
export interface TtlCache<K, V> {
  get(key: K, load: () => Promise<V>): Promise<V>;
  clear(): void;
}

export function createTtlCache<K, V>(opts: { ttlMs: number; now: () => number; maxEntries?: number }): TtlCache<K, V> {
  const values = new Map<K, { at: number; value: V }>();
  const inflight = new Map<K, Promise<V>>();
  let generation = 0;
  const max = opts.maxEntries ?? 64;

  return {
    async get(key, load) {
      const hit = values.get(key);
      if (hit && opts.now() - hit.at < opts.ttlMs) return hit.value;
      const pending = inflight.get(key);
      if (pending) return pending;
      const startedIn = generation;
      const promise = load()
        .then((value) => {
          // A clear() while loading means the result may belong to a previous session: serve it, don't keep it.
          if (startedIn === generation) {
            values.delete(key);
            values.set(key, { at: opts.now(), value });
            while (values.size > max) {
              const oldest = values.keys().next();
              if (oldest.done) break;
              values.delete(oldest.value);
            }
          }
          return value;
        })
        .finally(() => {
          if (inflight.get(key) === promise) inflight.delete(key);
        });
      inflight.set(key, promise);
      return promise;
    },
    clear() {
      generation += 1;
      values.clear();
      inflight.clear();
    },
  };
}
