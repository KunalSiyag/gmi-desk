import type { GmiApi, GmiBridge, GmiEventName, GmiEvents, GmiNamespace } from '@shared/contracts';
import { GmiError } from '@shared/contracts/errors';

declare global {
  interface Window {
    gmi?: GmiBridge;
  }
}

function bridge(): GmiBridge {
  const b = window.gmi;
  if (!b) throw new GmiError('internal', 'The app bridge is unavailable (preload failed to load).');
  return b;
}

const namespaceCache = new Map<string, unknown>();

function makeNamespace(ns: GmiNamespace): unknown {
  const cached = namespaceCache.get(ns);
  if (cached) return cached;
  const proxy = new Proxy(
    {},
    {
      get(_target, method) {
        // `then` must be undefined or `await gmi.chat` would treat the namespace as a thenable.
        if (typeof method !== 'string' || method === 'then') return undefined;
        return async (...args: unknown[]) => {
          const result = await bridge().invoke(ns, method, args);
          if (result.ok) return result.data;
          throw GmiError.fromShape(result.error);
        };
      },
    },
  );
  namespaceCache.set(ns, proxy);
  return proxy;
}

/**
 * Typed client for the main process: `await gmi.catalog.getSnapshot()`.
 * Failures reject with a GmiError carrying a stable `code`.
 */
export const gmi = new Proxy({} as GmiApi, {
  get(_target, ns) {
    if (typeof ns !== 'string' || ns === 'then') return undefined;
    return makeNamespace(ns as GmiNamespace);
  },
});

/** Subscribes to a main-process event; returns an unsubscribe function. */
export function onGmiEvent<K extends GmiEventName>(name: K, listener: (payload: GmiEvents[K]) => void): () => void {
  const b = window.gmi;
  if (!b) return () => undefined;
  return b.on(name, listener as (payload: unknown) => void);
}

export const isMac = () => window.gmi?.platform === 'darwin';
