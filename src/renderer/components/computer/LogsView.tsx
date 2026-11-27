// The Logs tab for containers (compute.md §8.8, §6.4): the last 256 KB, refreshed every 10 s while shown (a large
// log only by hand), and "Save full log…" through main's save dialog. Shares its cache with the Compute page's panel.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import type { ComputeResource } from '@shared/contracts/compute';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { Skeleton, Spinner } from '@renderer/components/ui/misc';
import { gmi } from '@renderer/lib/gmi';
import { formatAgo } from '@renderer/pages/compute/format';
import { toastActionError, useNow } from '@renderer/pages/compute/hooks';
import { Toolbar } from './parts';

export const LOGS_TAIL_BYTES = 256 * 1024;
export const LOGS_POLL_MS = 10_000;

export function LogsView({ resource }: { resource: Pick<ComputeResource, 'id'> }) {
  const now = useNow(15_000);
  const logs = useQuery({
    queryKey: ['compute', 'logs', resource.id],
    queryFn: () => gmi.compute.getLogs(resource.id, { tailBytes: LOGS_TAIL_BYTES }),
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => (query.state.data?.truncated ? false : LOGS_POLL_MS),
    refetchIntervalInBackground: false,
  });
  const save = useMutation({
    mutationFn: () => gmi.compute.saveLogs(resource.id),
    onError: (error) => toastActionError('Could not save the log', error),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <span className="min-w-0 flex-1 truncate px-1 text-2xs text-muted-foreground">
          {logs.data ? `${logs.data.truncated ? 'Last part · ' : ''}fetched ${formatAgo(logs.data.fetchedAt, now)}` : 'Container log'}
        </span>
        <Button variant="ghost" size="xs" disabled={logs.isFetching} onClick={() => void logs.refetch()}>
          {logs.isFetching ? <Spinner className="size-3" /> : <RefreshCw />} Refresh
        </Button>
        <Button variant="ghost" size="xs" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner className="size-3" /> : <Download />} Save full log…
        </Button>
      </Toolbar>
      {logs.isPending ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : logs.error ? (
        <div className="p-2">
          <ErrorNotice error={logs.error} compact onRetry={() => void logs.refetch()} />
        </div>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto bg-background px-3 py-2 font-mono text-2xs leading-relaxed break-all whitespace-pre-wrap text-foreground">
          {logs.data?.text || <span className="text-muted-foreground">The log is empty.</span>}
        </pre>
      )}
    </div>
  );
}
