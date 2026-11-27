// Shared fakes for the compute client tests (C1-B): a recording Compute key provider, big lazy streams, an HTTP stack
// over the fake fetch, and GMI's answer shapes.
import type { ComputeKeyProvider } from '@main/core/services';
import { createHttp, type FetchLike } from '@main/core/http';
import { silentLogger } from '@main/core/logger';
import { createFakeFetch, jsonResponse, type FakeRoute } from '../../helpers/fetch';

export const TEST_COMPUTE_KEY = 'ck-test-key-0000000000000000';

export interface FakeComputeKeys extends ComputeKeyProvider {
  key: string | null;
  reports: Array<{ reason: string; key: string | null; status: number | null }>;
  listeners: Set<() => void>;
  setKey(key: string | null): void;
}

export function fakeComputeKeys(initial: string | null = TEST_COMPUTE_KEY): FakeComputeKeys {
  const keys: FakeComputeKeys = {
    key: initial,
    reports: [],
    listeners: new Set(),
    async getComputeKey() {
      return keys.key;
    },
    async requireComputeKey() {
      if (!keys.key) {
        const { GmiError } = await import('@shared/contracts/errors');
        throw new GmiError('no_compute_key', 'no key');
      }
      return keys.key;
    },
    async reportInvalidComputeKey(reason, key, status) {
      keys.reports.push({ reason, key: key ?? null, status: status ?? null });
    },
    onChange(listener) {
      keys.listeners.add(listener);
      return () => keys.listeners.delete(listener);
    },
    setKey(key) {
      keys.key = key;
      for (const l of [...keys.listeners]) l();
    },
  };
  return keys;
}

/** An HTTP stack (the real ctx.http) over a fake fetch. */
export function fakeHttp(routes: FakeRoute[] = []) {
  const fake = createFakeFetch(routes);
  const http = createHttp({ userAgent: 'GMI-Desk/test', log: silentLogger, fetch: fake.fetch as FetchLike });
  return { http, ...fake };
}

/** A lazily generated body of `total` bytes (pull-based: nothing is buffered ahead). */
export function lazyBody(total: number, chunkSize = 1024 * 1024, fill = 0x61): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, total - sent);
      const chunk = new Uint8Array(n).fill(fill);
      // Mark every line end so a tail has lines.
      for (let i = 99; i < n; i += 100) chunk[i] = 0x0a;
      sent += n;
      controller.enqueue(chunk);
    },
  });
}

export const v2Error = (code: string, message = 'refused', details?: Record<string, unknown>) => ({ code, message, request_id: 'req-test-1', ...(details ? { details } : {}) });

export const htmlPage = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>cloudflare challenge</body></html>';

export const json = jsonResponse;

/** A sleep that resolves at once and records the delays asked for. */
export function instantSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number, signal?: AbortSignal) => {
    delays.push(ms);
    if (signal?.aborted) {
      const { GmiError } = await import('@shared/contracts/errors');
      throw new GmiError('cancelled', 'Cancelled.');
    }
  };
  return { sleep, delays };
}
