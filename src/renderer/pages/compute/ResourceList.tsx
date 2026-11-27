// The Resources tab's list (§15): managed resources first; "Show all in organization" adds other members' resources
// as read-only "Unmanaged" rows (§7.5 step 9). Sleeping Dino when there is nothing yet.
import { useId } from 'react';
import { Rocket } from 'lucide-react';
import type { ComputeCatalog, ComputeResource } from '@shared/contracts/compute';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, Skeleton } from '@renderer/components/ui/misc';
import { Switch } from '@renderer/components/ui/switch';
import { Label } from '@renderer/components/ui/input';
import { ResourceRow } from './ResourceRow';
import { SectionHeading } from './parts';

/** Managed first, then by phase activity (running/working before paused/failed/deleted), then newest. */
export function sortResources(rows: readonly ComputeResource[]): ComputeResource[] {
  const rank = (r: ComputeResource) => (r.phase === 'deleted' ? 3 : r.phase === 'failed' ? 2 : r.phase === 'paused' ? 1 : 0);
  return [...rows].sort(
    (a, b) =>
      Number(b.managed) - Number(a.managed) ||
      rank(a) - rank(b) ||
      (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt),
  );
}

export function ResourceList({
  resources,
  catalog,
  loading,
  error,
  onRetry,
  includeUnmanaged,
  onIncludeUnmanaged,
  selectedId,
  now,
  onOpen,
  onLaunch,
  readOnly,
}: {
  resources: ComputeResource[] | undefined;
  catalog: ComputeCatalog | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  includeUnmanaged: boolean;
  onIncludeUnmanaged: (on: boolean) => void;
  selectedId: string | null;
  now: number;
  onOpen: (id: string) => void;
  onLaunch: () => void;
  /** No usable key: rows show, Launch does not. */
  readOnly?: boolean;
}) {
  const switchId = useId();
  const rows = resources ? sortResources(resources) : [];
  const managed = rows.filter((r) => r.managed);
  const unmanaged = rows.filter((r) => !r.managed);
  const billing = managed.filter((r) => r.phase !== 'deleted').length;

  return (
    <section aria-labelledby="compute-resources" className="flex flex-col gap-3">
      <SectionHeading
        id="compute-resources"
        title="Resources"
        meta={resources ? `${billing} managed${includeUnmanaged ? ` · ${unmanaged.length} more in your organization` : ''}` : null}
        action={
          <span className="flex items-center gap-2">
            <Label htmlFor={switchId} className="text-2xs font-normal text-muted-foreground">
              Show all in organization
            </Label>
            <Switch id={switchId} checked={includeUnmanaged} onCheckedChange={onIncludeUnmanaged} />
          </span>
        }
      />
      {error && !resources ? (
        <ErrorNotice error={error} onRetry={onRetry} />
      ) : loading && !resources ? (
        <div className="flex flex-col gap-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyState
            dino="sleep"
            title="No computers yet"
            description={
              includeUnmanaged
                ? 'Nothing is running in your organization that this key can see.'
                : 'Launch a GPU container or a sandbox. You see the price per hour and approve it before anything bills.'
            }
            action={
              readOnly ? null : (
                <Button onClick={onLaunch}>
                  <Rocket /> Launch a computer
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {managed.length ? (
            <ul aria-label="Managed resources" className="divide-y divide-border">
              {managed.map((r) => (
                <ResourceRow key={r.id} resource={r} catalog={catalog} selected={r.id === selectedId} now={now} onOpen={onOpen} />
              ))}
            </ul>
          ) : null}
          {includeUnmanaged && unmanaged.length ? (
            <>
              {/* first:border-t-0: with no managed rows above, the card's own border is the top edge (no 2px line). */}
              <p className="border-y border-border bg-muted/40 px-4 py-1.5 text-2xs text-muted-foreground first:border-t-0 dark:bg-white/[0.02]">
                Other resources in your organization. Read-only: GMI Desk never acts on them unless you adopt one.
              </p>
              <ul aria-label="Other resources in your organization" className="divide-y divide-border">
                {unmanaged.map((r) => (
                  <ResourceRow key={r.id} resource={r} catalog={catalog} selected={r.id === selectedId} now={now} onOpen={onOpen} />
                ))}
              </ul>
            </>
          ) : null}
          {managed.length === 0 && !(includeUnmanaged && unmanaged.length) ? (
            <EmptyState dino="sleep" title="No computers yet" description="Nothing managed by GMI Desk is running." className="py-8" />
          ) : null}
        </div>
      )}
    </section>
  );
}
