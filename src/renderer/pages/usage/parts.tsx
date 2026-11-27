import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, OctagonAlert } from 'lucide-react';
import { formatRelativeTime } from '@shared/lib/format';
import { cn } from '@renderer/lib/cn';
import { MicroLabel, Skeleton } from '@renderer/components/ui/misc';

export type PeriodKey = '24h' | '7d' | '30d' | '90d';

export const PERIODS: Array<{ value: PeriodKey; label: string; days: number; long: string }> = [
  { value: '24h', label: '24h', days: 1, long: 'Last 24 hours' },
  { value: '7d', label: '7d', days: 7, long: 'Last 7 days' },
  { value: '30d', label: '30d', days: 30, long: 'Last 30 days' },
  { value: '90d', label: '90d', days: 90, long: 'Last 90 days' },
];

export function periodFor(key: PeriodKey) {
  return PERIODS.find((p) => p.value === key) ?? PERIODS[1]!;
}

const centsFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Budget amounts read in cents: "$0.79", "<$0.01". */
export function formatCents(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01';
  return centsFmt.format(value);
}

/**
 * Series fills for the chat (LLM) / media split, GMI's chart palette. Dark: lime + olive (lightness 90 vs 63).
 * Light: lime keeps a thin edge (lime on white is 1.3:1 on its own) and media drops to moss, so the pair stays apart.
 */
export const SERIES = {
  chat: 'bg-brand-lime shadow-[var(--primary-edge)] dark:shadow-none',
  media: 'bg-brand-moss dark:bg-brand-olive',
} as const;

/** Single-value bars (Top models' magnitudes, the budget meter): olive on light surfaces, lime on dark. */
export const BAR_FILL = 'bg-brand-olive dark:bg-primary';

/**
 * Top models and Media activity sit side by side (stacked when narrow). Both cards share one min-height (`card`, in
 * every state, so loading → empty does not jump), and their empty states are anchored from the top so the two titles
 * sit on one line: Dino's slot (76px + 12px gap) is 40px taller than the icon tile's (40px + 8px), and Media's body
 * has 4px more top padding (py-3 vs py-2), so the icon variant starts 36px lower.
 */
export const ACCOUNT_EMPTY = {
  card: 'min-h-[19.5rem]',
  dino: 'flex-1 justify-start pb-8 pt-8',
  icon: 'flex-1 justify-start pb-8 pt-[4.25rem]',
} as const;

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const yearFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "Oct 24 – Oct 31"; windows of a day or so keep their times: "Oct 31 01:57 – Nov 1 01:57". */
export function formatRange(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const a = dateFmt.format(start);
  const b = dateFmt.format(end);
  if (a === b) return `${a}, ${timeFmt.format(start)} – ${timeFmt.format(end)}`;
  if (end.getTime() - start.getTime() <= 36 * 3_600_000) return `${a} ${timeFmt.format(start)} – ${b} ${timeFmt.format(end)}`;
  return `${a} – ${b}`;
}

/** Today "14:32", this year "Oct 28 14:32", older "Oct 28, 2025". */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
  return yearFmt.format(d);
}

/** "Updated 3m ago", re-rendered every 30 s so it never keeps saying "just now". */
export function UpdatedAgo({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [iso]);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="text-2xs tabular-nums text-muted-foreground">
      Updated {formatRelativeTime(iso, now)}
    </time>
  );
}

/** Card with a dense header row (title · meta · actions). */
export function Panel({
  title,
  meta,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  // `relative` keeps absolutely positioned content (e.g. sr-only captions) inside the page scroller; without it they
  // extend the document itself, and focusing or revealing anything below the fold then scrolls the whole app shell.
  return (
    <section id={id} className={cn('relative flex min-w-0 flex-col rounded-lg border border-border bg-card text-card-foreground', className)}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <h3 className="shrink-0 text-[13px] font-medium">{title}</h3>
        {meta ? <span className="min-w-0 truncate text-2xs text-muted-foreground">{meta}</span> : null}
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      <div className={cn('flex-1 px-4 py-3', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * One cell of a figure strip (cells sit on a 1px border grid): micro-label, big tabular number, one line of
 * context. `hero` is the number that matters most on the page (larger, brand ink).
 */
export function Figure({
  label,
  value,
  hint,
  tone = 'default',
  hero,
  loading,
  className,
  children,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'danger' | 'muted';
  hero?: boolean;
  loading?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn('relative flex min-w-0 flex-col gap-3 bg-card px-4 pb-3 pt-3.5', className)}>
      {children}
      <MicroLabel dot={hero ? (tone === 'danger' ? 'danger' : true) : false} className="relative">
        {label}
      </MicroLabel>
      <div className="relative mt-auto flex min-w-0 flex-col gap-1">
        {loading ? (
          <Skeleton className={cn(hero ? 'h-10 w-40' : 'h-7 w-20', 'my-0.5')} />
        ) : (
          <div
            className={cn(
              'truncate font-semibold tabular-nums tracking-tight',
              hero ? 'text-[2.5rem] leading-[2.75rem]' : 'text-2xl leading-8',
              tone === 'danger' ? 'text-destructive' : tone === 'muted' ? 'text-muted-foreground' : hero ? 'text-primary-ink' : 'text-foreground',
            )}
          >
            {value}
          </div>
        )}
        <div className="min-h-4 truncate text-2xs tabular-nums text-muted-foreground">{loading ? <Skeleton className="mt-1 h-2.5 w-24" /> : hint}</div>
      </div>
    </div>
  );
}

/**
 * Spend against a limit: a thin bar in the brand bar fill (olive on light, lime on dark) → amber (> 80 %) → red (at
 * or over the limit), with an icon and words for the two alert states (colour is never the only signal).
 */
export function Meter({ label, spent, limit, noLimitLabel }: { label: string; spent: number; limit: number | null; noLimitLabel: string }) {
  const ratio = limit === null ? null : limit <= 0 ? (spent > 0 ? Infinity : 1) : spent / limit;
  const state = ratio === null ? 'none' : ratio >= 1 ? 'over' : ratio > 0.8 ? 'warn' : 'ok';
  const pct = ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100));
  const fill = { none: 'bg-muted-foreground/40', ok: BAR_FILL, warn: 'bg-warning', over: 'bg-destructive' }[state];
  const left = limit === null ? null : limit - spent;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <MicroLabel>{label}</MicroLabel>
        {ratio !== null ? (
          <span
            className={cn(
              'font-mono text-3xs font-medium tabular-nums',
              state === 'over' ? 'text-destructive' : state === 'warn' ? 'text-warning-foreground' : 'text-muted-foreground',
            )}
          >
            {Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '—'}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5 tabular-nums">
        <span className="text-xl font-semibold leading-6 tracking-tight">{formatCents(spent)}</span>
        <span className="truncate text-xs text-muted-foreground">{limit === null ? noLimitLabel : `of ${formatCents(limit)}`}</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-sm bg-muted dark:bg-white/[0.06]"
        role="meter"
        aria-label={`${label} spend`}
        aria-valuemin={0}
        aria-valuemax={limit ?? undefined}
        aria-valuenow={spent}
        aria-valuetext={limit === null ? `${formatCents(spent)}, ${noLimitLabel}` : `${formatCents(spent)} of ${formatCents(limit)}`}
      >
        {pct > 0 ? <div className={cn('h-full rounded-sm', fill)} style={{ width: `${Math.max(pct, 2)}%` }} /> : null}
      </div>
      <div className="flex min-h-4 min-w-0 items-center gap-1 text-2xs text-muted-foreground">
        {state === 'over' ? (
          <>
            <OctagonAlert aria-hidden className="size-3 shrink-0 text-destructive" />
            <span className="truncate text-foreground">{left !== null && left < 0 ? `Over by ${formatCents(-left)}` : 'Limit reached'}</span>
          </>
        ) : state === 'warn' ? (
          <>
            <AlertTriangle aria-hidden className="size-3 shrink-0 text-warning-foreground" />
            <span className="text-foreground">Near the limit</span>
            <span className="truncate tabular-nums">· {formatCents(left ?? 0)} left</span>
          </>
        ) : state === 'ok' ? (
          <span className="truncate tabular-nums">{formatCents(left ?? 0)} left</span>
        ) : (
          <span className="truncate">Set a limit below to cap it</span>
        )}
      </div>
    </div>
  );
}

/** Thin segmented bar (6px, 2px surface gap). The rows beside it carry names and amounts. */
export function SegmentedBar({ parts, label }: { parts: Array<{ value: number; className: string; name: string }>; label: string }) {
  const total = parts.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div
      role="img"
      aria-label={`${label}: ${parts.map((p) => `${p.name} ${total > 0 ? Math.round((p.value / total) * 100) : 0}%`).join(', ')}`}
      className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-sm"
    >
      {total <= 0 ? (
        <div className="h-full w-full rounded-sm bg-muted" />
      ) : (
        visible.map((p) => <div key={p.name} className={cn('h-full rounded-sm', p.className)} style={{ flexGrow: p.value, flexBasis: 0, minWidth: 4 }} />)
      )}
    </div>
  );
}
