import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, Eye, FolderOpen, MoreHorizontal, RefreshCw, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { CatalogModel } from '@shared/contracts/catalog';
import type { MediaJob } from '@shared/contracts/media';
import { formatUsd } from '@shared/lib/money';
import { useCatalog } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Plates } from '@renderer/components/brand/Plates';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { DropdownMenu, type MenuItemSpec } from '@renderer/components/ui/menu';
import { EmptyState, Skeleton, Spinner } from '@renderer/components/ui/misc';
import { TabStrip } from '@renderer/components/ui/tabs';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { requestFromJob, shortAge, shortModelId, statusView } from './form';
import { useHistoryPreview, useJobActions, useMediaJobs, useNow, useSeen } from './hooks';
import { JobDialog } from './JobDialog';
import { JobMedia, JobStatusBadge } from './JobMedia';
import { useCreateUi, type GalleryFilter } from './state';

const PAGE = 48;
const FRESH_MS = 10 * 60_000;
const MAX_JOBS = 500;

export interface JobHandlers {
  onRetake: (job: MediaJob) => void;
  onUseSettings: (job: MediaJob) => void;
}

export function useModelNames(): (id: string) => string {
  const catalog = useCatalog();
  const byId = useMemo(() => new Map((catalog.data?.models ?? []).map((m: CatalogModel) => [m.id, m.name])), [catalog.data]);
  return (id: string) => byId.get(id) ?? shortModelId(id);
}

/** Menu entries for a job (card menu and detail view share them). */
export function jobMenuItems(job: MediaJob, actions: ReturnType<typeof useJobActions>, handlers: JobHandlers, onOpen?: () => void): Array<MenuItemSpec | 'separator'> {
  const hasOutputs = job.outputs.length > 0;
  const canLoad = job.status === 'success';
  const saved = hasOutputs && job.outputs.every((o) => o.localPath);
  const items: Array<MenuItemSpec | 'separator'> = [];
  if (onOpen) items.push({ label: 'Open', icon: <Eye />, onSelect: onOpen });
  items.push(
    { label: saved ? 'Saved locally' : 'Save locally', icon: <Download />, onSelect: () => void actions.saveAll(job), disabled: !canLoad || saved },
    { label: 'Show in folder', icon: <FolderOpen />, onSelect: () => void actions.reveal(job, 0), disabled: !canLoad },
    { label: job.outputs.length > 1 ? 'Copy links' : 'Copy link', icon: <Copy />, onSelect: () => actions.copyUrls(job), disabled: !hasOutputs },
    'separator',
    { label: 'Retake', icon: <RotateCcw />, onSelect: () => handlers.onRetake(job), disabled: !requestFromJob(job) },
    { label: 'Use these settings', icon: <SlidersHorizontal />, onSelect: () => handlers.onUseSettings(job), disabled: !job.modelId || job.modelId === 'unknown' },
  );
  if (!statusView(job).busy && job.status !== 'success' && job.status !== 'failed' && job.status !== 'cancelled') {
    items.push({ label: 'Check again', icon: <RefreshCw />, onSelect: () => void actions.refresh(job) });
  }
  return items;
}

function JobCard({ job, now, modelName, handlers, onOpen }: { job: MediaJob; now: Date; modelName: string; handlers: JobHandlers; onOpen: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const seen = useSeen(ref);
  const preview = useHistoryPreview(job, seen);
  const actions = useJobActions();
  const count = job.outputs.length;
  // A "Done" badge marks results that finished in the last few minutes; older ones need no badge.
  const justFinished = job.status === 'success' && !!job.finishedAt && now.getTime() - Date.parse(job.finishedAt) < FRESH_MS;

  return (
    <article
      ref={ref}
      className="group flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors duration-150 ease-out hover:border-foreground/15"
    >
      <div className="relative aspect-square overflow-hidden bg-muted/60 dark:bg-white/[0.025]">
        <JobMedia job={job} now={now} preview={preview} onOpen={onOpen} />
        {job.status !== 'success' ? (
          <JobStatusBadge job={job} className="pointer-events-none absolute left-1.5 top-1.5" />
        ) : justFinished ? (
          <span className="pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-px text-2xs font-medium text-white">
            <Check className="size-3 text-brand-lime" /> Done
          </span>
        ) : null}
        {count > 1 ? (
          <span className="pointer-events-none absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-px text-2xs font-medium tabular-nums text-white">
            {count} outputs
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-start gap-1 px-2.5 pb-2 pt-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button type="button" onClick={onOpen} className="min-w-0 text-left">
            {job.prompt ? (
              <span className="line-clamp-2 text-xs leading-snug text-foreground">{job.prompt}</span>
            ) : (
              <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                {job.fromThisDevice ? 'No prompt recorded' : 'From your GMI history'}
              </span>
            )}
          </button>
          <div className="flex min-w-0 items-center gap-1 text-3xs tabular-nums text-muted-foreground">
            <span className="min-w-0 truncate" title={job.modelId}>
              {modelName}
            </span>
            {job.estimateUsd !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 tabular-nums">{formatUsd(job.estimateUsd)}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span className="shrink-0 tabular-nums" title={new Date(job.createdAt).toLocaleString()}>
              {shortAge(job.createdAt, now)}
            </span>
          </div>
        </div>
        <DropdownMenu
          trigger={
            <Button variant="ghost" size="icon-xs" aria-label="Job actions" className="-mr-1.5 -mt-0.5 size-5 text-muted-foreground">
              <MoreHorizontal />
            </Button>
          }
          items={jobMenuItems(job, actions, handlers, onOpen)}
        />
      </div>
    </article>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3 p-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
          <Skeleton className="aspect-square rounded-none" />
          <div className="flex flex-col gap-1.5 p-2.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Right pane: every generation, newest first, live-updated while jobs run. */
export function Gallery({ handlers }: { handlers: JobHandlers }) {
  const [limit, setLimit] = useState(PAGE);
  const jobs = useMediaJobs(limit);
  const client = useQueryClient();
  const filter = useCreateUi((s) => s.galleryFilter);
  const setFilter = useCreateUi((s) => s.setGalleryFilter);
  const now = useNow(15_000);
  const nameOf = useModelNames();
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Navigating (palette, deep links) closes the detail view.
  const navSeq = useUi((s) => s.navSeq);
  useEffect(() => setOpenId(null), [navSeq]);

  const all = jobs.data?.jobs ?? [];
  const mine = all.filter((j) => j.fromThisDevice);
  const shown = filter === 'device' ? mine : all;
  const running = mine.filter((j) => statusView(j).busy).length;
  const openJob = openId ? (all.find((j) => j.id === openId) ?? null) : null;
  const total = jobs.data?.total ?? 0;
  const canLoadMore = jobs.data !== undefined && all.length < total && limit < MAX_JOBS;

  return (
    <section aria-label="Gallery" className="flex min-h-0 min-w-0 flex-col">
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
        <h2 className="text-[13px] font-semibold">Gallery</h2>
        {jobs.data ? <span className="font-mono text-2xs tabular-nums text-muted-foreground">{filter === 'device' ? mine.length : total}</span> : null}
        {running > 0 ? (
          <Badge variant="primary" className="ml-1 tabular-nums">
            <Plates size="sm" /> {running} running
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <TabStrip<GalleryFilter>
            value={filter}
            onValueChange={setFilter}
            items={[
              { value: 'all', label: 'All' },
              { value: 'device', label: 'This device' },
            ]}
          />
          <Tooltip label="Refresh">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh gallery"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void client.invalidateQueries({ queryKey: qk.mediaJobs }).finally(() => setRefreshing(false));
              }}
            >
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
            </Button>
          </Tooltip>
        </div>
      </header>

      {jobs.data?.remoteError ? (
        <p className="border-b border-border px-4 py-1.5 text-2xs text-muted-foreground">
          Showing this device only: GMI's history could not be loaded ({jobs.data.remoteError}).
        </p>
      ) : null}

      {jobs.isLoading ? (
        <GallerySkeleton />
      ) : jobs.error && !jobs.data ? (
        <div className="p-4">
          <ErrorNotice error={jobs.error} onRetry={() => void jobs.refetch()} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          className="py-20"
          dino="sleep"
          title={filter === 'device' && all.length > 0 ? 'Nothing generated on this device yet' : 'No generations yet'}
          description="Pick a model, describe what you want and press Run. Results land here, and GMI Desk keeps a copy in your media folder."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] content-start gap-3 p-4">
          {shown.map((job) => (
            <JobCard key={job.id} job={job} now={now} modelName={nameOf(job.modelId)} handlers={handlers} onOpen={() => setOpenId(job.id)} />
          ))}
        </div>
      )}

      {canLoadMore ? (
        <div className="flex justify-center pb-5">
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => Math.min(MAX_JOBS, l + PAGE))} disabled={jobs.isFetching}>
            {jobs.isFetching ? <Spinner /> : null} Show more
          </Button>
        </div>
      ) : null}

      <JobDialog
        job={openJob}
        modelName={openJob ? nameOf(openJob.modelId) : ''}
        handlers={handlers}
        onClose={() => setOpenId(null)}
      />
    </section>
  );
}
