// Small shared pieces of the computer dock: the strip banner, the quiet "not here" panel, the toolbar row.
import type { ReactNode } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { Plates } from '@renderer/components/brand/Plates';
import { cn } from '@renderer/lib/cn';

export type BannerTone = 'info' | 'working' | 'warning' | 'danger';

const TONE: Record<BannerTone, string> = {
  info: 'bg-muted/60 text-foreground dark:bg-white/[0.03]',
  working: 'bg-muted/60 text-foreground dark:bg-white/[0.03]',
  warning: 'bg-warning/10 text-foreground',
  danger: 'bg-destructive/[0.07] text-foreground',
};

/**
 * A full-width strip above a tab's content (paused, attached elsewhere, reconnecting, cold resume): icon, one line of
 * text with an optional detail, and the action that resolves it on the right. Appears instantly (status, not
 * decoration).
 */
export function Banner({
  tone = 'info',
  title,
  detail,
  action,
  className,
}: {
  tone?: BannerTone;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const icon =
    tone === 'working' ? (
      <Plates size="sm" className="mt-[5px]" />
    ) : tone === 'warning' ? (
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
    ) : tone === 'danger' ? (
      <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" />
    ) : (
      <Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
    );
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      data-banner={tone}
      className={cn('flex shrink-0 items-start gap-2 border-b border-border px-3 py-2 text-xs', TONE[tone], className)}
    >
      {icon}
      <div className="min-w-0 flex-1 leading-snug">
        <p className="font-medium">{title}</p>
        {detail ? <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{detail}</p> : null}
      </div>
      {action ? <div className="-my-0.5 flex shrink-0 items-center gap-1">{action}</div> : null}
    </div>
  );
}

/** A quiet centred note for a tab that has nothing to show here (no Dino: the dock's one Dino is its empty state). */
export function Placeholder({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 py-10 text-center">
      {icon ? (
        <div className="mb-1.5 flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground [&_svg]:size-4">{icon}</div>
      ) : null}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {children ? <div className="max-w-xs text-xs leading-relaxed text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A 32px toolbar row at the top of a tab (path, counts, actions). */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex h-8 shrink-0 items-center gap-1 border-b border-border px-2', className)}>{children}</div>;
}
