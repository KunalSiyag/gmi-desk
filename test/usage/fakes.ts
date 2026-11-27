import type { AuthState } from '@shared/contracts/auth';
import { GmiError } from '@shared/contracts/errors';
import type { AuthService, GmiToolName, McpCallOptions, McpGateway } from '@main/core/services';

export interface McpCall {
  name: GmiToolName;
  args: Record<string, unknown>;
  opts: McpCallOptions | undefined;
}

/** McpGateway double: per-tool handlers, records every call. */
export function fakeMcp(handlers: Partial<Record<GmiToolName, (args: Record<string, unknown>) => unknown>> = {}) {
  const calls: McpCall[] = [];
  const mcp: McpGateway = {
    async callTool<T>(name: GmiToolName, args: Record<string, unknown> = {}, opts?: McpCallOptions) {
      calls.push({ name, args, opts });
      const handler = handlers[name];
      if (!handler) throw new GmiError('not_implemented', `no fake for ${name}`);
      return (await handler(args)) as T;
    },
  };
  return { mcp, calls, handlers, count: (name: GmiToolName) => calls.filter((c) => c.name === name).length };
}

/** AuthService double whose change listeners can be fired by the test. */
export function fakeAuth(signedIn = true) {
  const listeners = new Set<(state: AuthState) => void>();
  const state = { status: signedIn ? 'signed_in' : 'signed_out' } as AuthState;
  const auth: AuthService = {
    getState: () => state,
    isSignedIn: () => state.status === 'signed_in',
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    auth,
    fire(next: Partial<AuthState> = {}) {
      Object.assign(state, next);
      for (const l of listeners) l(state);
    },
    listenerCount: () => listeners.size,
  };
}

/** A mutable clock for ctx.now. */
export function clock(start: Date) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set(d: Date) {
      current = new Date(d);
    },
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}
