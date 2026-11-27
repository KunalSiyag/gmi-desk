// Mock-mode wiring of the compute slice (C1 integrator): what the simulators cannot do by themselves.
//
// - The real clients call `requireComputeKey()` before every request; the simulators do not. `keyGated` makes the
//   simulated control planes behave the same, so mock mode shows the no-key state end to end (signed out,
//   `GMI_DESK_MOCK_AUTH` without `compute_key`, or the `no_key` compute flag).
// - The scenario's daily budget (default $25; `budget_low`: $5; `no_daily_budget`: none) is not handled here: the usage
//   slice seeds it into the one real budget on first run (services/usage/index.ts), so the cost guard, the Usage page
//   and edits made in the UI all agree.
import type { ComputeKeyProvider } from '../../core/services';

/** Wraps every method of a simulated API so it first requires the Compute key, as the real clients do. */
export function keyGated<T extends object>(api: T, keys: Pick<ComputeKeyProvider, 'requireComputeKey'>): T {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await keys.requireComputeKey();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
