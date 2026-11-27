// Small shared pieces of the Compute page: phase badge, kind icon, section heading, notes.
import type { ReactNode } from 'react';
import { Box, CircleAlert, Info, Server, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ComputeKind, ComputePhase } from '@shared/contracts/compute';
import { cn } from '@renderer/lib/cn';
import { Plates } from '@renderer/components/brand/Plates';
import { Badge } from '@renderer/components/ui/badge';
import { microLabel } from '@renderer/components/ui/misc';
import { PHASE_VIEW } from './format';

/** A server for containers, a box for sandboxes. */
export const KIND_ICON: Record<ComputeKind, LucideIcon> = { container: Server, sandbox: Box };

/** Running = brand ink; working = Plates; paused = amber; failed = red; deleted/unknown = muted (§8.5). */
export function PhaseBadge({ phase, pending, className }: { phase: ComputePhase; pending?: string | null; className?: string }) {
  const view = PHASE_VIEW[phase];
  if (pending)
    return (
      <Badge variant="default" className={className} aria-live="polite">
        <Plates size="sm" /> {pending}
      </Badge>
    );
  if (view.tone === 'working')
    return (
      <Badge variant="default" className={className} aria-live="polite">
        <Plates size="sm" /> {view.label}
      </Badge>
    );
  const variant = view.tone === 'ok' ? 'primary' : view.tone === 'paused' ? 'warning' : view.tone === 'danger' ? 'danger' : 'outline';
  return (
    <Badge variant={variant} className={className}>
      {view.label}
    </Badge>
  );
}

/** Section rule: mono micro-label, quiet meta, then a 1px line to the edge (the Usage page's heading). */
export function SectionHeading({ id, title, meta, action }: { id?: string; title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2.5">
      <h2 id={id} className={cn(microLabel, 'shrink-0 text-foreground/80')}>
        {title}
      </h2>
      {meta ? <span className="min-w-0 truncate text-2xs tabular-nums text-muted-foreground">{meta}</span> : null}
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
    </div>
  );
}

/** A quiet inline note: info (muted), warning (amber), danger (red). Never lime. */
export function Note({ tone = 'info', children, className }: { tone?: 'info' | 'warning' | 'danger'; children: ReactNode; className?: string }) {
  const Icon = tone === 'danger' ? CircleAlert : tone === 'warning' ? TriangleAlert : Info;
  return (
    <p
      className={cn(
        'flex items-start gap-2 text-2xs leading-relaxed',
        tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** Label/value rows for detail panels (dense, mono labels). */
export function Facts({ rows, className }: { rows: Array<{ label: string; value: ReactNode; hint?: ReactNode } | null>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2', className)}>
      {rows.filter(Boolean).map((row) => (
        <div key={row!.label} className="contents">
          <dt className={cn(microLabel, 'pt-0.5')}>{row!.label}</dt>
          <dd className="min-w-0 text-[13px] tabular-nums">
            <span className="break-words">{row!.value}</span>
            {row!.hint ? <span className="ml-2 text-2xs text-muted-foreground">{row!.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A bordered card surface used by the page's panels. */
export function Panel({ children, className, ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('rounded-lg border border-border bg-card', className)} {...props}>
      {children}
    </section>
  );
}
