/**
 * Per-job status polling with exponential backoff. The slice supplies `refresh` (one get_generation round-trip that
 * updates the ledger and emits events); this module only decides when to call it and when to give up.
 */
import type { Logger } from '../../core/logger';

export type PollStopReason = 'done' | 'expired' | 'error' | 'stopped';

export interface PollerDeps {
  /** Refreshes one job from GMI. Resolves true when polling should stop (terminal status). Throws to back off. */
  refresh(jobId: string): Promise<boolean>;
  /** Normal interval between polls for this job. */
  intervalMs(jobId: string): number;
  /** True when the job is too old to keep polling (checked before every poll). */
  expired(jobId: string): boolean;
  /** After a failed refresh: keep retrying with backoff (default) or stop. */
  onError?(jobId: string, error: unknown, consecutiveFailures: number): 'retry' | 'stop';
  onStop?(jobId: string, reason: PollStopReason): void;
  /** Ceiling for the backoff delay. Default 60s. */
  maxBackoffMs?: number;
  log?: Logger;
}

export interface Poller {
  /** Starts polling a job (no-op when already polling; `delayMs` then reschedules an idle job sooner). */
  start(jobId: string, opts?: { delayMs?: number }): void;
  stop(jobId: string): void;
  isPolling(jobId: string): boolean;
  active(): string[];
  /** Stops everything; later calls are ignored. */
  dispose(): void;
}

interface Entry {
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  running: boolean;
  stopped: boolean;
}

export function createPoller(deps: PollerDeps): Poller {
  const entries = new Map<string, Entry>();
  const maxBackoff = deps.maxBackoffMs ?? 60_000;
  let disposed = false;

  const finish = (jobId: string, reason: PollStopReason) => {
    const entry = entries.get(jobId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.stopped = true;
    entries.delete(jobId);
    try {
      deps.onStop?.(jobId, reason);
    } catch (error) {
      deps.log?.warn('poll stop handler failed', error);
    }
  };

  const schedule = (jobId: string, entry: Entry, delayMs: number) => {
    if (disposed || entry.stopped) return;
    const timer = setTimeout(() => void tick(jobId, entry), Math.max(0, delayMs));
    (timer as { unref?: () => void }).unref?.();
    entry.timer = timer;
  };

  const tick = async (jobId: string, entry: Entry) => {
    entry.timer = null;
    if (disposed || entry.stopped) return;
    if (deps.expired(jobId)) {
      finish(jobId, 'expired');
      return;
    }
    entry.running = true;
    let done = false;
    try {
      done = await deps.refresh(jobId);
    } catch (error) {
      entry.running = false;
      if (disposed || entry.stopped) return;
      entry.failures += 1;
      const decision = deps.onError?.(jobId, error, entry.failures) ?? 'retry';
      if (decision === 'stop') {
        finish(jobId, 'error');
        return;
      }
      const backoff = Math.min(maxBackoff, deps.intervalMs(jobId) * 2 ** entry.failures);
      deps.log?.debug(`poll ${jobId} failed (${entry.failures}x); next in ${backoff}ms`);
      schedule(jobId, entry, backoff);
      return;
    }
    entry.running = false;
    if (disposed || entry.stopped) return;
    if (done) {
      finish(jobId, 'done');
      return;
    }
    entry.failures = 0;
    schedule(jobId, entry, deps.intervalMs(jobId));
  };

  return {
    start(jobId, opts = {}) {
      if (disposed) return;
      const existing = entries.get(jobId);
      if (existing) {
        if (opts.delayMs !== undefined && existing.timer && !existing.running) {
          clearTimeout(existing.timer);
          schedule(jobId, existing, opts.delayMs);
        }
        return;
      }
      const entry: Entry = { timer: null, failures: 0, running: false, stopped: false };
      entries.set(jobId, entry);
      schedule(jobId, entry, opts.delayMs ?? deps.intervalMs(jobId));
    },
    stop(jobId) {
      finish(jobId, 'stopped');
    },
    isPolling: (jobId) => entries.has(jobId),
    active: () => [...entries.keys()],
    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        entry.stopped = true;
      }
      entries.clear();
    },
  };
}
