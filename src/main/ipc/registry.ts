import { invokeChannel, METHOD_NAME_PATTERN, type GmiApi, type GmiNamespace } from '@shared/contracts';
import { GmiError, toGmiError, type GmiErrorCode, type IpcResult } from '@shared/contracts/errors';
import type { Logger } from '../core/logger';

export interface IpcEventLike {
  senderFrame?: { url: string } | null;
}

/** The subset of Electron's ipcMain the registry needs (so it can be tested without Electron). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/** Public method names of a handler object (own and prototype methods). */
export function methodNames(impl: object): string[] {
  const names = new Set<string>();
  let proto: object | null = impl;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === 'function' && METHOD_NAME_PATTERN.test(key)) names.add(key);
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...names];
}

/** Expected outcomes the user acts on: not logged as warnings. */
export const QUIET_CODES: ReadonlySet<GmiErrorCode> = new Set<GmiErrorCode>([
  'not_signed_in',
  'no_api_key',
  'cancelled',
  'not_found',
  'invalid_input',
  'budget_exceeded',
  'confirmation_required',
  'no_compute_key',
  'not_entitled',
  'permission_denied',
  'limit_reached',
]);

/**
 * Exposes every method of `impl` as `gmi:invoke:<ns>:<method>`. Handlers never throw across IPC:
 * they resolve to IpcResult so the renderer gets the GmiError code intact.
 */
export function registerApi<N extends GmiNamespace>(
  ipc: IpcMainLike,
  ns: N,
  impl: GmiApi[N],
  opts: { log: Logger; isTrustedSender: (event: IpcEventLike) => boolean },
): () => void {
  const channels: string[] = [];
  const log = opts.log.child('ipc');
  for (const method of methodNames(impl as object)) {
    const channel = invokeChannel(ns, method);
    const fn = (impl as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
    if (!fn) continue;
    ipc.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!opts.isTrustedSender(event)) {
        log.warn(`rejected ${ns}.${method} from untrusted frame`, { url: event.senderFrame?.url ?? null });
        return { ok: false, error: new GmiError('unauthorized', 'Untrusted sender.').toShape() };
      }
      try {
        const data = await fn.apply(impl, args);
        return { ok: true, data };
      } catch (error) {
        const err = toGmiError(error);
        if (err.code === 'internal' || err.code === 'not_implemented') log.error(`${ns}.${method} failed`, error);
        else if (!QUIET_CODES.has(err.code)) log.warn(`${ns}.${method}: ${err.code} ${err.message}`);
        return { ok: false, error: err.toShape() };
      }
    });
    channels.push(channel);
  }
  return () => {
    for (const channel of channels) ipc.removeHandler(channel);
  };
}

/**
 * An API object whose every method rejects with GmiError('not_implemented') (registration stubs in
 * src/main/slices/ until the slice that owns the namespace replaces them). `methods` comes from the contract's
 * method list (e.g. COMPUTE_API_METHODS), so the IPC channels match the interface exactly.
 */
export function createNotImplementedApi<T extends object>(label: string, methods: readonly (keyof T & string)[]): T {
  const api: Record<string, () => Promise<never>> = {};
  for (const method of methods) {
    api[method] = async () => {
      throw new GmiError('not_implemented', `${label} is not available yet.`);
    };
  }
  return api as unknown as T;
}
