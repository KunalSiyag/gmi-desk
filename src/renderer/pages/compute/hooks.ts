// Compute page (compute.md §15): queries, the key view and actions. Live updates come from useComputeEvents
// (lib/hooks): compute:state and compute:resources replace the cached values.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AuthState } from '@shared/contracts/auth';
import type { ComputeResource, ComputeState } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import { computeKeyLocked, computeKeyOf } from '@renderer/components/connect/compute-access';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import type { ComputeKeyView } from './format';

/** Which key state the page is in. The compute slice's view (state.access.key) wins over auth's once it answers. */
export function computeKeyView(auth: AuthState | undefined, state: ComputeState | undefined): ComputeKeyView {
  if (!auth && !state) return 'loading';
  if (auth && computeKeyLocked(auth)) return 'locked';
  const key = state?.access.key ?? computeKeyOf(auth);
  if (key.status === 'missing') return 'none';
  if (key.status === 'invalid') return 'invalid';
  return 'ready';
}

export function useComputeState() {
  return useQuery({ queryKey: qk.computeState, queryFn: () => gmi.compute.getState(), staleTime: 15_000, retry: false });
}

/**
 * The catalog. With an `idc` (and a Compute key) main also loads that data centre's account products and templates, so
 * its offers carry real SKUs (§5.1 "on wizard open, per IDC"); without one, sizes are the public aggregated list.
 */
export function useComputeCatalog(idc: string | null = null, enabled = true) {
  return useQuery({
    queryKey: qk.computeCatalog(idc),
    queryFn: () => gmi.compute.getCatalog({ idc }),
    staleTime: 5 * 60_000,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useComputeResources(includeUnmanaged: boolean, enabled: boolean) {
  return useQuery({
    queryKey: qk.computeResources(includeUnmanaged),
    queryFn: () => gmi.compute.listResources({ includeUnmanaged }),
    enabled,
    staleTime: 30_000,
  });
}

export function useComputeResource(id: string | null) {
  return useQuery({ queryKey: qk.computeResource(id ?? ''), queryFn: () => gmi.compute.getResource(id!), enabled: Boolean(id), staleTime: 15_000 });
}

export function useComputeSnapshots(enabled: boolean) {
  return useQuery({ queryKey: qk.computeSnapshots, queryFn: () => gmi.compute.listSnapshots(), enabled, staleTime: 30_000 });
}

export function useComputeNetwork(enabled: boolean) {
  return useQuery({ queryKey: qk.computeNetwork, queryFn: () => gmi.compute.getNetwork(), enabled, staleTime: 30_000 });
}

/** A native dialog in main was declined: not an error, say nothing. */
export function isCancelled(error: unknown): boolean {
  return error instanceof GmiError && error.code === 'cancelled';
}

/** Toasts a failed action (never a declined native dialog). */
export function toastActionError(label: string, error: unknown): void {
  if (isCancelled(error)) return;
  const view = describeError(error);
  toast.error(`${label}: ${view.title}`, view.message ? { description: view.message } : undefined);
}

/**
 * One compute action (pause, resume, delete, …): runs it, writes the returned resource into the caches, and toasts
 * failures. Main shows the native confirmations; a declined one rejects with `cancelled` and is silent.
 */
export function useResourceAction<A extends unknown[]>(label: string, run: (...args: A) => Promise<ComputeResource | void>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: A) => run(...args),
    onSuccess: (resource) => {
      if (resource && typeof resource === 'object' && 'id' in resource) {
        for (const all of [true, false]) {
          client.setQueryData<ComputeResource[]>(qk.computeResources(all), (rows) =>
            rows ? rows.map((r) => (r.id === resource.id ? { ...r, ...resource } : r)) : rows,
          );
        }
        void client.invalidateQueries({ queryKey: qk.computeResource(resource.id) });
      }
      void client.invalidateQueries({ queryKey: qk.computeState });
    },
    onError: (error) => toastActionError(label, error),
  });
}

/** Re-renders every `ms` (countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Reads a zustand store like its hook, but with the current state as the server snapshot too. The app never renders
 * on a server; this only lets react-dom/server markup tests render the page in a given state (zustand's own hook
 * renders the store's initial state there).
 */
export function useStoreNow<T, U>(store: Pick<StoreApi<T>, 'subscribe' | 'getState'>, selector: (state: T) => U): U {
  const read = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, read, read);
}
