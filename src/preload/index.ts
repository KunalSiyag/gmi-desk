import { contextBridge, ipcRenderer } from 'electron';
import {
  API_NAMESPACES,
  EVENT_NAMES,
  IPC_EVENT_CHANNEL,
  METHOD_NAME_PATTERN,
  invokeChannel,
  type GmiBridge,
  type GmiEventName,
  type GmiNamespace,
} from '../shared/contracts';

const namespaces = new Set<string>(API_NAMESPACES);
const eventNames = new Set<string>(EVENT_NAMES);
const listeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on(IPC_EVENT_CHANNEL, (_event, name: unknown, payload: unknown) => {
  if (typeof name !== 'string') return;
  for (const listener of listeners.get(name) ?? []) {
    try {
      listener(payload);
    } catch (error) {
      console.error(`[gmi] listener for ${name} failed`, error);
    }
  }
});

const bridge: GmiBridge = {
  invoke(ns: GmiNamespace, method: string, args: unknown[]) {
    if (!namespaces.has(ns) || typeof method !== 'string' || !METHOD_NAME_PATTERN.test(method)) {
      return Promise.resolve({ ok: false, error: { code: 'invalid_input', message: `Unknown API ${String(ns)}.${String(method)}` } });
    }
    return ipcRenderer.invoke(invokeChannel(ns, method), ...(Array.isArray(args) ? args : []));
  },
  on(event: GmiEventName, listener: (payload: unknown) => void) {
    if (!eventNames.has(event) || typeof listener !== 'function') {
      throw new Error(`Unknown event ${String(event)}`);
    }
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('gmi', bridge);
