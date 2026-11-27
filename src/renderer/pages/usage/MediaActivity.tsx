import { AudioLines, CircleCheck, CircleDashed, CircleX, Film, ImageIcon, ImagePlus, Info, RotateCw, Shapes, Sparkles, Workflow, type LucideIcon } from 'lucide-react';
import type { MediaActivity as MediaActivityData } from '@shared/contracts/usage';
import { formatNumber } from '@shared/lib/format';
import { describeError } from '@renderer/lib/errors';
import { useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, microLabel, Skeleton } from '@renderer/components/ui/misc';
import { ACCOUNT_EMPTY, Panel } from './parts';

const MODALITIES: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: 'image', label: 'Image', icon: ImageIcon },
  { key: 'video', label: 'Video', icon: Film },
  { key: 'audio', label: 'Audio', icon: AudioLines },
];
const EXTRA_ICONS: Record<string, LucideIcon> = { workflow: Workflow };
const MAX_MODELS = 6;
const ROW = 'grid grid-cols-[minmax(0,1fr)_2.5rem_3rem_3rem] items-center gap-2';

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** Image/video/audio job counts from list_generations (GMI reports no per-job cost here). */
export function MediaActivity({
  activity,
  loading,
  periodLabel,
  error,
  onRetry,
  retrying,
}: {
  activity: MediaActivityData | undefined;
  loading: boolean;
  periodLabel: string;
  /** Loading failed and there is nothing to show. */
  error?: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const navigate = useUi((s) => s.navigate);
  const extra = Object.keys(activity?.byModality ?? {}).filter((k) => !MODALITIES.some((m) => m.key === k));
  const tiles = [
    ...MODALITIES,
    ...extra.map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1), icon: EXTRA_ICONS[key] ?? Shapes })),
  ];
  const models = activity?.byModel ?? [];
  const hidden = models.length - MAX_MODELS;
  const errorView = error ? describeError(error) : null;
  const errorText = errorView ? errorView.message || errorView.title : '';

  return (
    <Panel
      title="Media activity"
      meta={
        activity
          ? `${formatNumber(activity.total)}${activity.truncated ? '+' : ''} ${activity.total === 1 ? 'job' : 'jobs'} · ${periodLabel.toLowerCase()}`
          : periodLabel.toLowerCase()
      }
      className={ACCOUNT_EMPTY.card}
      bodyClassName="flex flex-col gap-3"
    >
      {error ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2.5 py-8 text-center">
          <CircleDashed aria-hidden className="size-4 text-muted-foreground" />
          <div className="flex max-w-xs flex-col gap-0.5">
            <p className="text-xs font-medium">Media activity is not available right now</p>
            <p className="text-2xs text-muted-foreground">{errorText}</p>
          </div>
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
              <RotateCw className={cn(retrying && 'animate-spin')} /> Try again
            </Button>
          ) : null}
        </div>
      ) : loading && !activity ? (
        <div aria-hidden className="flex flex-col gap-3">
          <Skeleton className="h-[3.75rem]" />
          <div className="flex flex-col gap-3 pt-1">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-3" style={{ width: `${92 - i * 9}%` }} />
            ))}
          </div>
        </div>
      ) : !activity || activity.total === 0 ? (
        // One Dino per view: Top models beside this panel keeps the sleeping one; the title lines up with its title.
        <EmptyState
          icon={<Sparkles />}
          className={ACCOUNT_EMPTY.icon}
          title="No media jobs yet"
          description="Image, video and audio jobs land here, counted by model."
          action={
            <Button size="sm" variant="outline" onClick={() => navigate('create')}>
              <ImagePlus /> Create something
            </Button>
          }
        />
      ) : (
        <>
          <div
            className={cn(
              'grid gap-px overflow-hidden rounded-md border border-border bg-border',
              tiles.length > 3 ? 'grid-cols-4' : 'grid-cols-3',
            )}
          >
            {tiles.map(({ key, label, icon: Icon }) => (
              <div key={key} className="flex min-w-0 flex-col gap-1 bg-card px-3 py-2">
                <span className={cn('flex min-w-0 items-center gap-1.5', microLabel)}>
                  <Icon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{label}</span>
                </span>
                <span className="text-xl font-semibold leading-6 tracking-tight tabular-nums">{formatNumber(activity.byModality[key] ?? 0)}</span>
              </div>
            ))}
          </div>

          <div>
            <div aria-hidden className={cn(ROW, microLabel, 'pb-1.5')}>
              <span>Model</span>
              <span className="text-right">Jobs</span>
              <span className="text-right">Done</span>
              <span className="text-right">Failed</span>
            </div>
            <ul aria-label="Media jobs by model" className="flex flex-col">
              {models.slice(0, MAX_MODELS).map((m) => (
                <li
                  key={m.modelId}
                  aria-label={`${m.modelId}: ${m.count} jobs, ${m.succeeded} succeeded, ${m.failed} failed`}
                  className={cn(ROW, 'h-7 border-t border-border text-xs')}
                >
                  <span className="truncate" title={m.modelId}>
                    {m.modelId}
                  </span>
                  <span className="text-right font-medium tabular-nums">{formatNumber(m.count)}</span>
                  <span className="flex items-center justify-end gap-1 tabular-nums text-muted-foreground">
                    {m.succeeded > 0 ? <CircleCheck aria-hidden className="size-3 text-primary-ink" /> : null}
                    {formatNumber(m.succeeded)}
                  </span>
                  <span className="flex items-center justify-end gap-1 tabular-nums text-muted-foreground">
                    {m.failed > 0 ? <CircleX aria-hidden className="size-3 text-destructive" /> : null}
                    {formatNumber(m.failed)}
                  </span>
                </li>
              ))}
            </ul>
            {hidden > 0 ? <p className="border-t border-border pt-1.5 text-2xs text-muted-foreground">+{hidden} more models</p> : null}
          </div>

          <p className="mt-auto flex items-start gap-1.5 text-2xs text-muted-foreground">
            <Info aria-hidden className="mt-px size-3 shrink-0" />
            <span>
              {activity.truncated
                ? `Counted the latest ${formatNumber(activity.scanned ?? activity.total)} jobs${
                    activity.oldestAt ? ` (back to ${dateFmt.format(new Date(activity.oldestAt))})` : ''
                  }; older jobs in this period are not included. `
                : ''}
              Counts only: GMI does not report the cost of individual media jobs.
            </span>
          </p>
        </>
      )}
    </Panel>
  );
}
