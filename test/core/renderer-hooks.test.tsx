// Event subscriptions made by the shared renderer hooks (findings foundation-31 and foundation-22).
// Effects do not run in a server render, so this file runs `useEffect` bodies synchronously to observe
// which main-process events each hook subscribes to.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GmiBridge, GmiEventName } from '@shared/contracts';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: (effect: () => void | (() => void)) => void effect() };
});

import { BALANCE_REFRESH_DEBOUNCE_MS, useBalanceRefresh, useCatalog } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';

let listeners: Map<string, Array<(payload: unknown) => void>>;

beforeEach(() => {
  listeners = new Map();
  const bridge: GmiBridge = {
    invoke: async () => ({ ok: true, data: null }),
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => undefined;
    },
    platform: 'linux',
  };
  (globalThis as { window?: unknown }).window = { gmi: bridge };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

const emit = (name: GmiEventName, payload: unknown) => {
  for (const l of listeners.get(name) ?? []) l(payload);
};

function render(node: React.ReactNode, client = new QueryClient()) {
  renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return client;
}

describe('useCatalog (foundation-31)', () => {
  it('does not subscribe to catalog:updated per consumer', () => {
    function Consumer() {
      useCatalog();
      return null;
    }
    render(
      <>
        <Consumer />
        <Consumer />
        <Consumer />
        <Consumer />
        <Consumer />
      </>,
    );
    // App owns the single listener; five consumers used to mean five snapshot fetches per event.
    expect(listeners.get('catalog:updated') ?? []).toHaveLength(0);
  });
});

describe('useBalanceRefresh (foundation-22)', () => {
  function Host() {
    useBalanceRefresh();
    return null;
  }

  it('refreshes the account summary after spend events and finished media jobs, debounced', async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(<Host />, client);
    expect(listeners.get('usage:budget')).toHaveLength(1);
    expect(listeners.get('media:job')).toHaveLength(1);

    emit('usage:budget', {});
    emit('media:job', { id: 'j1', status: 'success' });
    emit('usage:budget', {});
    await vi.advanceTimersByTimeAsync(BALANCE_REFRESH_DEBOUNCE_MS + 10);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.accountSummaryAll });

    // Jobs still running do not touch the balance.
    emit('media:job', { id: 'j2', status: 'processing' });
    await vi.advanceTimersByTimeAsync(BALANCE_REFRESH_DEBOUNCE_MS + 10);
    expect(invalidate).toHaveBeenCalledTimes(1);

    emit('media:job', { id: 'j2', status: 'failed' });
    await vi.advanceTimersByTimeAsync(BALANCE_REFRESH_DEBOUNCE_MS + 10);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
