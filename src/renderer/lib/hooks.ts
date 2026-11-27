import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { GmiEventName, GmiEvents } from '@shared/contracts';
import type { AppSettings } from '@shared/contracts/app';
import type { AuthState } from '@shared/contracts/auth';
import type { CodeState, CodeThreadEvent, CodeThreadSummary } from '@shared/contracts/code';
import type { ComputeResource, ComputeState } from '@shared/contracts/compute';
import type { GatewayStatus } from '@shared/contracts/gateway';
import { isTerminalJobStatus } from '@shared/contracts/media';
import type { BudgetStatus } from '@shared/contracts/usage';
import { gmi, onGmiEvent } from './gmi';
import { debouncedInvalidation, qk } from './query';

/** Subscribes to a main-process event for the component's lifetime (latest handler wins). */
export function useGmiEvent<K extends GmiEventName>(name: K, handler: (payload: GmiEvents[K]) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onGmiEvent(name, (payload) => ref.current(payload)), [name]);
}

export function useAppInfo() {
  return useQuery({ queryKey: qk.appInfo, queryFn: () => gmi.app.info(), staleTime: Infinity });
}

/** App settings, kept live by `app:settings` (changes can come from the main process too). */
export function useSettings() {
  const client = useQueryClient();
  useGmiEvent('app:settings', (settings) => client.setQueryData<AppSettings>(qk.settings, settings));
  return useQuery({ queryKey: qk.settings, queryFn: () => gmi.app.getSettings(), staleTime: Infinity });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => gmi.app.updateSettings(patch),
    onSuccess: (settings) => client.setQueryData(qk.settings, settings),
  });
}

/** Auth state, kept live by `auth:changed`. */
export function useAuth() {
  const client = useQueryClient();
  useGmiEvent('auth:changed', (state) => client.setQueryData<AuthState>(qk.auth, state));
  return useQuery({ queryKey: qk.auth, queryFn: () => gmi.auth.getState(), staleTime: Infinity });
}

/**
 * Model catalog snapshot. `catalog:updated` invalidates it once, in App (always mounted): a listener per
 * consumer would re-fetch the whole snapshot over IPC once per mounted component for every event.
 */
export function useCatalog() {
  return useQuery({ queryKey: qk.catalog, queryFn: () => gmi.catalog.getSnapshot(), staleTime: 60_000 });
}

/** Budget status, kept live by `usage:budget`. */
export function useBudget() {
  const client = useQueryClient();
  useGmiEvent('usage:budget', (status) => client.setQueryData<BudgetStatus>(qk.budget, status));
  return useQuery({ queryKey: qk.budget, queryFn: () => gmi.usage.getBudget(), staleTime: 60_000 });
}

/** Delay that groups bursts of spend events into one balance refresh. */
export const BALANCE_REFRESH_DEBOUNCE_MS = 3_000;

/**
 * Spending refreshes the account summary (the top-bar balance): budget ledger updates (chat replies, media
 * submits) and media jobs reaching a final state. Debounced; the main process caches GMI's answer briefly.
 * Mount once (App).
 */
export function useBalanceRefresh(): void {
  const client = useQueryClient();
  const refresh = useMemo(() => debouncedInvalidation(client, qk.accountSummaryAll, BALANCE_REFRESH_DEBOUNCE_MS), [client]);
  useEffect(() => () => refresh.cancel(), [refresh]);
  useGmiEvent('usage:budget', () => refresh.schedule());
  useGmiEvent('media:job', (job) => {
    if (isTerminalJobStatus(job.status)) refresh.schedule();
  });
}

/** True once the user is signed in with GMI (or the app runs in mock mode). */
export function useIsSignedIn(): boolean {
  const auth = useAuth();
  return auth.data?.status === 'signed_in';
}

/** A `compute:resources` event: both list caches (all rows / managed only), then each changed resource's detail. */
export function applyComputeResources(client: QueryClient, resources: ComputeResource[]): void {
  client.setQueryData<ComputeResource[]>(qk.computeResources(true), resources);
  client.setQueryData<ComputeResource[]>(qk.computeResources(false), resources.filter((r) => r.managed));
  for (const r of resources) void client.invalidateQueries({ queryKey: qk.computeResource(r.id), refetchType: 'active' });
}

/**
 * Keeps the compute queries live: `compute:state` and `compute:resources` replace the cached values (the event
 * carries managed + visible unmanaged rows; the managed-only list gets the managed ones), a new alarm refreshes the
 * state, a changed resource refreshes its detail. Mount where compute data is shown (the Compute page, the dock);
 * several mounts are harmless (they write the same values).
 */
export function useComputeEvents(): void {
  const client = useQueryClient();
  useGmiEvent('compute:state', (state) => client.setQueryData<ComputeState>(qk.computeState, state));
  useGmiEvent('compute:resources', (resources) => applyComputeResources(client, resources));
  useGmiEvent('compute:alarm', () => void client.invalidateQueries({ queryKey: qk.computeState }));
}

/**
 * Keeps the Code queries live: state, the thread list, pending approvals and the gateway status. Durable thread
 * events (`code:event`) go to `onThreadEvent` (the page applies them in thread_seq order); a resolved or new
 * approval refreshes the approvals list.
 */
export function useCodeEvents(onThreadEvent?: (event: CodeThreadEvent) => void): void {
  const client = useQueryClient();
  useGmiEvent('code:state', (state) => client.setQueryData<CodeState>(qk.codeState, state));
  useGmiEvent('code:threads', (threads) => client.setQueryData<CodeThreadSummary[]>(qk.codeThreads, threads));
  useGmiEvent('code:approval', () => void client.invalidateQueries({ queryKey: qk.codeApprovals }));
  useGmiEvent('code:gateway', (status) => client.setQueryData<GatewayStatus>(qk.gatewayStatus, status));
  useGmiEvent('code:event', (event) => onThreadEvent?.(event));
}
