import type { ComponentPropsWithoutRef, ElementType, HTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Dino, type DinoMood } from '@renderer/components/brand/Dino';
import { cn } from '@renderer/lib/cn';
import { microLabel } from './micro-label';

/** GMI's micro-label class string (defined in ./micro-label; re-exported here for convenience). */
export { microLabel };

/**
 * <MicroLabel> renders `microLabel` as an element.
 * - `dot`: a small square before the text: `true` = brand ink (lime on dark, olive on light), `'danger'` = red.
 * - `as`: the element (default `span`; e.g. `p`, `h2`, `dt`, `label`). Other props go to that element.
 * The text truncates on one line; the dot never shrinks.
 */
export function MicroLabel<T extends ElementType = 'span'>({
  as,
  dot,
  className,
  children,
  ...props
}: {
  as?: T;
  dot?: boolean | 'danger';
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, 'as' | 'dot' | 'className' | 'children'>) {
  const Tag: ElementType = as ?? 'span';
  return (
    <Tag className={cn('flex min-w-0 items-center gap-1.5', microLabel, className)} {...props}>
      {dot ? <span aria-hidden className={cn('size-1.5 shrink-0', dot === 'danger' ? 'bg-destructive' : 'bg-primary-ink')} /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </Tag>
  );
}

/**
 * Inline spinner for a pending button ("Saving…", icon buttons). Anything else that says "working" (status chips,
 * badges, rows) uses <Plates size="sm"> from components/brand/Plates; page-level waits use DinoLoader.
 */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn('size-4 animate-spin text-muted-foreground', className)} />;
}

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-muted px-1 font-mono text-3xs font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" className={cn(vertical ? 'h-full w-px' : 'h-px w-full', 'shrink-0 bg-border', className)} />;
}

export function EmptyState({
  icon,
  dino,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  /** Show Dino (in this mood) instead of an icon: e.g. 'sleep' for "nothing here yet", 'idle' for errors. */
  dino?: DinoMood;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-1.5 px-6 py-12 text-center', className)}>
      {dino ? (
        // Dino stands on GMI's faint grid floor.
        <div className="relative mb-3 flex items-end justify-center">
          <div aria-hidden className="grid-floor pointer-events-none absolute -inset-x-20 -inset-y-8" />
          <Dino mood={dino} size={76} className="relative" />
        </div>
      ) : icon ? (
        <div className="mb-2 flex size-10 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground [&_svg]:size-[18px]">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-semibold tracking-tight text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Section label for sidebars and panels ("RECENT"): a <MicroLabel> row with an optional trailing action. */
export function SectionLabel({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('flex h-6 items-center justify-between gap-2 px-2 text-muted-foreground', className)}>
      <MicroLabel>{children}</MicroLabel>
      {action}
    </div>
  );
}

/** Key/value row for detail panels: mono micro-label over a tabular value. */
export function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className={microLabel}>{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
      {hint ? <span className="text-3xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
