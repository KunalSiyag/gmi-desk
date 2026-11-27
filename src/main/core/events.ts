import type { GmiEventName, GmiEvents } from '@shared/contracts';

export interface EventBus {
  /** Pushes to the renderer and to in-process subscribers. */
  emit<K extends GmiEventName>(name: K, payload: GmiEvents[K]): void;
  /** In-process subscription (main-side). */
  on<K extends GmiEventName>(name: K, listener: (payload: GmiEvents[K]) => void): () => void;
}

export function createEventBus(sendToRenderer: (name: GmiEventName, payload: unknown) => void): EventBus {
  const listeners = new Map<GmiEventName, Set<(payload: unknown) => void>>();
  return {
    emit(name, payload) {
      try {
        sendToRenderer(name, payload);
      } catch {
        // window may be gone during shutdown
      }
      for (const listener of listeners.get(name) ?? []) {
        try {
          listener(payload);
        } catch {
          // a faulty listener must not break emitters
        }
      }
    },
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      const fn = listener as (payload: unknown) => void;
      set.add(fn);
      return () => set.delete(fn);
    },
  };
}
