import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/cn';

/**
 * The first line of a page's content area. The top bar already shows the page title, so the title here is a
 * visually hidden <h1> (for screen readers and the document outline) and what shows is the description as one
 * muted line, with optional actions on the right (T3-style density).
 *
 * Props: `title` (hidden h1), `description?` (the visible line), `actions?` (right side), `className?`.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  if (!description && !actions) return <h1 className="sr-only">{title}</h1>;
  return (
    <div className={cn('flex min-h-7 items-center justify-between gap-4', className)}>
      <h1 className="sr-only">{title}</h1>
      {description ? <p className="min-w-0 text-[13px] leading-snug text-muted-foreground">{description}</p> : <span aria-hidden />}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Scrollable page body with the standard padding. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="relative h-full overflow-y-auto">
      <div className={cn('mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6', className)}>{children}</div>
    </div>
  );
}
