// Computer sessions in the renderer (compute.md §8.1): `open` once per resource, kept live by `computer:session`,
// released (`close`) shortly after the last view lets go; main keeps it warm for 5 minutes (a reopen reattaches), plus the dock-wide event listeners (previews,
// transfers) and the query keys under ['computer'].
import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ComputerSessionInfo } from '@shared/contracts/compute';
import { gmi } from '@renderer/lib/gmi';
import { useComputeEvents, useGmiEvent } from '@renderer/lib/hooks';
import { parentOf } from './paths';
import { useComputerUi } from './store';

/** Query keys of the dock (all under ['computer'], next to lib/query's `computerSession`). */
export const computerKeys = {
  /** The session `open(resourceId)` returned, kept live by `computer:session`. */
  session: (resourceId: string) => ['computer', 'resource', resourceId] as const,
  dirAll: (sessionId: string) => ['computer', 'dir', sessionId] as const,
  dir: (sessionId: string, path: string) => ['computer', 'dir', sessionId, path] as const,
  file: (sessionId: string, path: string) => ['computer', 'file', sessionId, path] as const,
  ports: (sessionId: string) => ['computer', 'ports', sessionId] as const,
  usage: (sessionId: string) => ['computer', 'usage', sessionId] as const,
};

/** Main keeps a released session this long, so coming back reattaches at once (§8.1). Main owns the timer. */
export const WARM_CLOSE_MS = 5 * 60_000;

/**
 * The renderer releases a session this long after its last view unmounted (a remount, e.g. the dock moving from one
 * page to another, keeps it). Main's warm period starts then: the total stays 5 minutes, and a reload loses nothing.
 */
export const RELEASE_DEBOUNCE_MS = 1_500;

interface Retained {
  count: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const retained = new Map<string, Retained>();

/**
 * Counts one view of `resourceId`'s session; the returned function releases it. When the count drops to zero the
 * session is released to main (`close`, which starts main's warm period) after RELEASE_DEBOUNCE_MS unless a view
 * comes back first.
 */
export function retainSession(client: QueryClient, resourceId: string, closeAfterMs = RELEASE_DEBOUNCE_MS): () => void {
  const entry = retained.get(resourceId) ?? { count: 0, timer: null };
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.count++;
  retained.set(resourceId, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.count--;
    if (entry.count > 0) return;
    entry.timer = setTimeout(() => {
      if (retained.get(resourceId) !== entry || entry.count > 0) return;
      retained.delete(resourceId);
      const key = computerKeys.session(resourceId);
      const info = client.getQueryData<ComputerSessionInfo>(key);
      client.removeQueries({ queryKey: key, exact: true });
      if (info && info.state !== 'closed') void gmi.computer.close(info.sessionId).catch(() => undefined);
    }, closeAfterMs);
  };
}

/** How many views hold a resource's session (tests). */
export function retainedCount(resourceId: string): number {
  return retained.get(resourceId)?.count ?? 0;
}

/** The session of `resourceId` (opened on first use; `enabled` false keeps what is cached without opening). */
export function useComputerSession(resourceId: string | null, enabled: boolean) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: computerKeys.session(resourceId ?? ''),
    queryFn: () => gmi.computer.open(resourceId!),
    enabled: enabled && Boolean(resourceId),
    staleTime: Infinity,
    gcTime: WARM_CLOSE_MS + 60_000,
    retry: false,
  });
  // Held while the view is mounted, also while the resource is paused (the screen stays readable under the banner):
  // only leaving the view starts the warm-close timer.
  useEffect(() => {
    if (!resourceId) return undefined;
    return retainSession(client, resourceId);
  }, [client, resourceId]);
  return query;
}

/**
 * The dock's event listeners (mounted once, by ComputerDock, also while it is closed): sessions, previews and
 * transfers, plus the compute events that keep the resource list live.
 */
export function useComputerEvents(): void {
  const client = useQueryClient();
  useComputeEvents();
  useGmiEvent('computer:session', (info) => {
    const key = computerKeys.session(info.resourceId);
    const current = client.getQueryData<ComputerSessionInfo>(key);
    // Only resources this renderer holds a session for (the event may carry a newer session of the same resource).
    if (current) client.setQueryData<ComputerSessionInfo>(key, info);
    if (info.state === 'closed') {
      const ui = useComputerUi.getState();
      for (const p of Object.values(ui.previews)) if (p.sessionId === info.sessionId) ui.removePreview(p.previewId);
    }
  });
  useGmiEvent('computer:preview', (preview) => useComputerUi.getState().upsertPreview(preview));
  useGmiEvent('computer:transfer', (transfer) => {
    useComputerUi.getState().upsertTransfer(transfer);
    // A finished upload shows up in its folder.
    if (transfer.direction === 'upload' && transfer.state === 'done') {
      void client.invalidateQueries({ queryKey: computerKeys.dir(transfer.sessionId, parentOf(transfer.remotePath)) });
    }
  });
}
