// Registration of the compute slice (compute.md §14): the `compute` namespace, its disposer and its quit check.
// Owned by C1-0; the service itself is built in services/compute/index.ts (C1-C).
import type { ComputeApi } from '@shared/contracts/compute';
import type { AppContext } from '../core/context';
import type { SliceHost } from '../core/services';
import { registerQuitCheck } from '../core/shutdown';
import { createComputeSlice, notImplementedComputeApi, type ComputeBackends, type ComputeServiceDeps } from '../services/compute';
import type { ComputeInternals } from '../services/compute/types';

export { notImplementedComputeApi };
export type ComputeSliceDeps = ComputeServiceDeps;

/** What other registrations (computer C2, harness broker H4, code H4-C) get from the compute slice. */
export interface ComputeSlice {
  readonly api: ComputeApi;
  /** Registry, supervisor, guard, actions, secret check, prices. Null until C1-C (callers must handle it). */
  readonly internals: ComputeInternals | null;
  /** The clients (data plane, tokens, the mock simulator) for the computer (C2). Null when unavailable. */
  readonly backends?: ComputeBackends | null;
}

export async function setupComputeSlice(ctx: AppContext, deps: ComputeSliceDeps, host: SliceHost): Promise<ComputeSlice> {
  const service = await createComputeSlice(ctx, deps);
  host.registerApi('compute', service.api);
  // An offscreen screenshot run (throwaway profile, mock data, nothing billable) quits on its own: a native quit
  // dialog there has no window to sit on and kills the run (Wayland). Packaged builds strip GMI_DESK_SHOTS.
  if (service.quitCheck && !screenshotRun(process.env)) {
    const unregister = registerQuitCheck(service.quitCheck);
    host.onDispose(unregister);
  }
  host.onDispose(() => service.dispose());
  return { api: service.api, internals: service.internals, backends: service.backends ?? null };
}

/** True in an offscreen screenshot run (scripts/screenshots.mjs); never in a packaged build (dev-env strips it). */
export function screenshotRun(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.GMI_DESK_SHOTS?.trim());
}
