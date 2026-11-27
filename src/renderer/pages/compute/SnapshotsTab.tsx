// The Snapshots tab (§7.3): sandbox snapshots, launch a sandbox from one, delete. Taking a snapshot starts from a
// running sandbox's page. Snapshot storage price is unknown (said plainly).
import { useState } from 'react';
import { Camera, Rocket, Trash2 } from 'lucide-react';
import type { ComputeSnapshot, SnapshotState } from '@shared/contracts/compute';
import { gmi } from '@renderer/lib/gmi';
import { Plates } from '@renderer/components/brand/Plates';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Dialog } from '@renderer/components/ui/dialog';
import { EmptyState, Skeleton, Spinner } from '@renderer/components/ui/misc';
import { formatAgo, formatBytes } from './format';
import { toastActionError } from './hooks';
import { Note, SectionHeading } from './parts';

const STATE_VIEW: Record<SnapshotState, { label: string; working?: boolean; variant?: 'primary' | 'danger' | 'outline' }> = {
  creating: { label: 'Saving', working: true },
  ready: { label: 'Ready', variant: 'primary' },
  error: { label: 'Failed', variant: 'danger' },
  deleting: { label: 'Deleting', working: true },
  delete_failed: { label: 'Delete failed', variant: 'danger' },
  unknown: { label: 'Unknown', variant: 'outline' },
};

export function SnapshotsTab({
  snapshots,
  loading,
  error,
  onRetry,
  now,
  canManage,
  onLaunch,
  onDeleted,
}: {
  snapshots: ComputeSnapshot[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
  canManage: boolean;
  onLaunch: (snapshotId: string) => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState<ComputeSnapshot | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = async (s: ComputeSnapshot) => {
    setConfirm(null);
    setDeleting(s.id);
    try {
      await gmi.compute.deleteSnapshot(s.id);
      onDeleted();
    } catch (e) {
      toastActionError('Could not delete the snapshot', e);
    } finally {
      setDeleting(null);
    }
  };

  if (error && !snapshots) return <ErrorNotice error={error} onRetry={onRetry} />;
  if (loading || !snapshots)
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  return (
    <section aria-labelledby="compute-snapshots" className="flex flex-col gap-3">
      <SectionHeading id="compute-snapshots" title="Snapshots" meta={String(snapshots.length)} />
      {snapshots.length === 0 ? (
        <EmptyState
          icon={<Camera />}
          title="No snapshots yet"
          description="Take one from a running sandbox’s page to launch copies of it later."
          className="rounded-lg border border-border"
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {snapshots.map((s) => {
            const view = STATE_VIEW[s.state];
            return (
              <li key={s.id} data-snapshot={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    {s.name}
                    {view.working ? (
                      <Badge variant="default">
                        <Plates size="sm" /> {view.label}
                      </Badge>
                    ) : (
                      <Badge variant={view.variant}>{view.label}</Badge>
                    )}
                    {!s.managed ? <Badge variant="outline">Unmanaged</Badge> : null}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {[s.idc, formatBytes(s.sizeBytes), s.createdAt ? formatAgo(s.createdAt, now) : null].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {canManage ? (
                  <div className="flex items-center gap-1.5">
                    <Button variant="outline" size="xs" disabled={s.state !== 'ready'} onClick={() => onLaunch(s.id)}>
                      <Rocket /> Launch sandbox
                    </Button>
                    {s.managed ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${s.name}`}
                        disabled={deleting !== null || s.state === 'deleting'}
                        onClick={() => setConfirm(s)}
                      >
                        {deleting === s.id ? <Spinner className="size-3" /> : <Trash2 />}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Note>Snapshot storage price is unknown: GMI has not published it. GMI refuses to delete a snapshot while sandboxes launched from it still exist.</Note>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={`Delete ${confirm?.name ?? 'snapshot'}?`}
        description="It cannot be restored. Sandboxes already launched from it keep running."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => confirm && void remove(confirm)}>
              <Trash2 /> Delete
            </Button>
          </>
        }
      />
    </section>
  );
}
