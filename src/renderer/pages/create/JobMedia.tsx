import { useState } from 'react';
import { AlertTriangle, AudioLines, Ban, Check, Clock, File, Film, History, ImageIcon, Workflow } from 'lucide-react';
import type { MediaJob, MediaOutput } from '@shared/contracts/media';
import { cn } from '@renderer/lib/cn';
import { Plates } from '@renderer/components/brand/Plates';
import { Badge } from '@renderer/components/ui/badge';
import { outputSrc, statusView, type StatusTone } from './form';

const KIND_ICON = { image: ImageIcon, video: Film, audio: AudioLines, file: File, workflow: Workflow } as const;

/** GMI's grid floor behind a tile's centre (running jobs, audio outputs). Decorative. */
const TILE_FLOOR = 'grid-floor pointer-events-none absolute inset-0 [--grid-fade:radial-gradient(ellipse_70%_60%_at_50%_50%,black_10%,transparent_80%)]';

/**
 * The tile's "open details" buttons. They fill an overflow-hidden tile, so the focus outline is drawn inside; a tile is
 * too large to scale on press (Emil: big surfaces lurch), so it dims while held instead.
 */
const TILE_BUTTON = 'outline-offset-[-2px] transition-opacity duration-150 ease-out active:opacity-80';

/** Running and done share GMI's lime tint: running carries the plates, done a check. */
const TONE_BADGE: Record<StatusTone, 'default' | 'primary' | 'danger' | 'warning'> = {
  muted: 'default',
  progress: 'primary',
  success: 'primary',
  danger: 'danger',
  warning: 'warning',
};

/** A job's status chip (gallery cards, the detail view). */
export function JobStatusBadge({ job, className }: { job: Pick<MediaJob, 'status' | 'pollingStopped'>; className?: string }) {
  const status = statusView(job);
  return (
    <Badge variant={TONE_BADGE[status.tone]} className={className}>
      {status.busy ? <Plates size="sm" /> : status.tone === 'success' ? <Check aria-hidden /> : null}
      {status.label}
    </Badge>
  );
}

function elapsed(fromIso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

function Placeholder({
  icon,
  title,
  detail,
}: {
  icon: 'busy' | 'failed' | 'cancelled' | 'clock' | 'history' | keyof typeof KIND_ICON;
  title?: string | null;
  detail?: string | null;
}) {
  const Icon =
    icon === 'busy'
      ? null
      : icon === 'failed'
        ? AlertTriangle
        : icon === 'cancelled'
          ? Ban
          : icon === 'clock'
            ? Clock
            : icon === 'history'
              ? History
              : KIND_ICON[icon];
  // Quiet on purpose: the card's badge carries the status colour, so a wall of failures does not shout.
  return (
    <span className="flex size-full flex-col items-center justify-center gap-1.5 px-4 text-center">
      {/* Waiting on GMI uses the app's one working signal (the plates), not a spinner. */}
      {Icon ? <Icon aria-hidden className="size-5 text-muted-foreground/70" /> : <Plates className="flex h-5 items-center" />}
      {title ? <span className="text-xs font-medium tabular-nums text-foreground/80">{title}</span> : null}
      {detail ? <span className="line-clamp-4 text-3xs leading-snug text-muted-foreground">{detail}</span> : null}
    </span>
  );
}

/**
 * A job GMI is still working on: what is being made and a mono elapsed clock on GMI's grid floor, over a static
 * brand-ink baseline that marks the tile as live. The card's badge carries the one moving signal (the plates).
 */
function Running({ kind, elapsed: time, detail }: { kind: keyof typeof KIND_ICON; elapsed: string; detail?: string | null }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className="relative flex size-full flex-col items-center justify-center gap-2 px-4 text-center">
      <span aria-hidden className={TILE_FLOOR} />
      <Icon aria-hidden className="relative size-5 text-primary-ink" />
      <span className="relative font-mono text-lg font-medium leading-none tabular-nums text-foreground">{time}</span>
      {detail ? <span className="relative line-clamp-3 max-w-40 text-3xs leading-snug text-muted-foreground">{detail}</span> : null}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-primary-ink" />
    </span>
  );
}

/** One output, filling its box (`fit` cover for cards, contain for the detail view). */
export function OutputView({
  output,
  job,
  fit = 'cover',
  className,
  onOpen,
}: {
  output: MediaOutput;
  job: MediaJob;
  fit?: 'cover' | 'contain';
  className?: string;
  onOpen?: () => void;
}) {
  const src = outputSrc(output);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const broken = !src || failedSrc === src;
  const fitClass = fit === 'cover' ? 'object-cover' : 'object-contain';

  if (broken) {
    return (
      <div className={cn('size-full', className)}>
        <Placeholder icon={output.kind} title="Preview unavailable" detail={output.localUrl ? 'The local copy could not be read.' : 'The file could not be loaded.'} />
      </div>
    );
  }
  if (output.kind === 'video') {
    return (
      <video
        key={src}
        src={src}
        poster={job.posterUrl ?? undefined}
        controls
        // Remote clips with a poster load nothing until played; local copies are cheap to probe.
        preload={!output.localUrl && job.posterUrl ? 'none' : 'metadata'}
        playsInline
        onError={() => setFailedSrc(src)}
        className={cn('size-full bg-black', fitClass, className)}
      />
    );
  }
  if (output.kind === 'audio') {
    return (
      <div className={cn('relative flex size-full flex-col bg-muted/60 dark:bg-white/[0.03]', className)}>
        <span aria-hidden className={TILE_FLOOR} />
        <button type="button" onClick={onOpen} tabIndex={onOpen ? 0 : -1} aria-label="Open details" className={cn('relative flex flex-1 items-center justify-center', TILE_BUTTON)}>
          <AudioLines className="size-8 text-primary-ink" />
        </button>
        <audio key={src} src={src} controls preload="metadata" onError={() => setFailedSrc(src)} className="relative h-9 w-full shrink-0 px-1.5 pb-1.5" />
      </div>
    );
  }
  if (output.kind === 'image') {
    const img = <img key={src} src={src} alt={job.prompt ?? 'Generated image'} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} className={cn('size-full', fitClass)} />;
    return onOpen ? (
      <button type="button" onClick={onOpen} aria-label="Open details" className={cn('block size-full', TILE_BUTTON, className)}>
        {img}
      </button>
    ) : (
      <div className={cn('size-full', className)}>{img}</div>
    );
  }
  return (
    <div className={cn('size-full', className)}>
      <Placeholder icon="file" title="File output" detail="Open the details to save or copy it." />
    </div>
  );
}

/** The media area of a job: its first output, or its state (running, failed, history not loaded). */
export function JobMedia({
  job,
  now,
  preview,
  onOpen,
}: {
  job: MediaJob;
  now: Date;
  preview: 'idle' | 'loading' | 'done' | 'failed';
  onOpen: () => void;
}) {
  const status = statusView(job);
  const first = job.outputs[0];
  if (first && job.status === 'success') return <OutputView output={first} job={job} onOpen={onOpen} />;

  let content;
  if (status.busy) {
    // The card's badge carries the working signal; the tile shows what is being made and for how long.
    const kind = job.modality === 'other' ? 'image' : job.modality;
    content = (
      <Running
        kind={kind}
        elapsed={elapsed(job.createdAt, now)}
        detail={job.modality === 'video' || job.modality === 'workflow' ? 'Videos usually take a few minutes.' : null}
      />
    );
  } else if (job.status === 'failed' || job.status === 'cancelled') {
    content = (
      <Placeholder
        icon={job.status === 'cancelled' ? 'cancelled' : 'failed'}
        detail={job.error ?? (job.status === 'cancelled' ? 'The generation was cancelled.' : 'GMI reported that the generation failed.')}
      />
    );
  } else if (job.status === 'success') {
    content =
      preview === 'failed' ? (
        <Placeholder icon="history" title="Preview expired" detail="GMI no longer keeps the result of this older request." />
      ) : preview === 'loading' ? (
        <Placeholder icon="busy" title="Loading from GMI…" />
      ) : (
        <Placeholder icon="history" title="From your GMI history" detail="Open to load the result." />
      );
  } else {
    content = <Placeholder icon="clock" title={status.label} detail={job.pollingStopped ? 'GMI Desk stopped checking. Open it to check again.' : null} />;
  }
  return (
    <button type="button" onClick={onOpen} aria-label="Open details" className={cn('block size-full', TILE_BUTTON)}>
      {content}
    </button>
  );
}
