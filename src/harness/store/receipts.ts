/**
 * Command receipts (harness.md §5.1, §13.3): commands carry a `commandId`; a command replayed after a restart (or
 * re-sent while the first copy is still running) returns the stored result instead of running again.
 *
 * - `run`: async commands. Duplicates in flight share one execution; the receipt is written when it succeeds.
 *   A failed command writes no receipt, so a replay runs it again (a failure must leave no partial side effect).
 * - `runSync`: commands whose effects are store writes only: the writes and the receipt commit in ONE transaction,
 *   so a crash can never leave the effect without its receipt (exactly once).
 *
 * Results must be JSON-serialisable (`undefined` is stored, and replayed, as `null`). Read-only commands do not
 * need receipts.
 */
import type { Store } from '../types';

export interface ReceiptGuard {
  run<T>(commandId: string, threadId: string | null, fn: () => Promise<T> | T): Promise<T>;
  runSync<T>(commandId: string, threadId: string | null, fn: () => T): T;
  /** Command ids currently executing. */
  inFlight(): string[];
}

export function createReceiptGuard(store: Store): ReceiptGuard {
  const inflight = new Map<string, Promise<unknown>>();

  return {
    run<T>(commandId: string, threadId: string | null, fn: () => Promise<T> | T): Promise<T> {
      const hit = store.receipts.get(commandId);
      if (hit) return Promise.resolve(hit.result as T);
      const running = inflight.get(commandId);
      if (running) return running as Promise<T>;
      const p = (async () => {
        try {
          const result = await fn();
          store.receipts.put(commandId, threadId, result === undefined ? null : result);
          return result;
        } finally {
          inflight.delete(commandId);
        }
      })();
      inflight.set(commandId, p);
      return p;
    },

    runSync<T>(commandId: string, threadId: string | null, fn: () => T): T {
      return store.transaction(() => {
        const hit = store.receipts.get(commandId);
        if (hit) return hit.result as T;
        const result = fn();
        store.receipts.put(commandId, threadId, result === undefined ? null : result);
        return result;
      });
    },

    inFlight: () => [...inflight.keys()],
  };
}
