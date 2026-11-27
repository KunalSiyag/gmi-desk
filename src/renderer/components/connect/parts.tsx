// Building blocks of the Connect chat dialog (and the welcome screen's after-sign-in offer). Motion follows
// components/ui/motion.ts: only this occasional, state-change UI animates (opacity, scale, a ≤2 px blur, a stroke
// drawn once); reduced motion keeps the fades.
import type { ReactNode } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { Dino } from '@renderer/components/brand/Dino';
import { cn } from '@renderer/lib/cn';
import { Kbd } from '../ui/misc';

export type StepStatus = 'done' | 'active' | 'todo';

/**
 * The marker on the left of a step: a number in a ring, a lime ring (with a soft lime halo) for the step to do now,
 * a lime-tinted disc with a brand-ink check once it is done (no solid lime: that is the call to action's). Light
 * theme: the ring, its halo and the check use the olive ink, since lime alone almost disappears on white (and a lime
 * halo reads as a yellow smudge there).
 */
export function StepMarker({ n, status }: { n: number; status: StepStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative z-10 flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-3xs font-medium tabular-nums',
        'transition-[background-color,border-color,color,box-shadow] duration-200 ease-out',
        // Brand-positive tint (Badge variant="primary"): the lime fill belongs to the dialog's one call to action.
        status === 'done' && 'border-primary-ink/30 bg-primary/15 text-primary-ink dark:bg-primary/12',
        // Same fill as the dialog surface (bg-popover): the marker only has to hide the connector line behind it.
        status === 'active' &&
          'border-primary-ink bg-popover text-primary-ink shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-primary-ink)_12%,transparent)] dark:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-primary)_22%,transparent)]',
        status === 'todo' && 'border-border bg-popover text-muted-foreground',
      )}
    >
      {status === 'done' ? <Check className="size-3" strokeWidth={3} /> : n}
    </span>
  );
}

/** One step: marker + hairline connector on the left (olive/lime once the step is done), title (+ aside) and body. */
export function Step({
  n,
  status,
  title,
  aside,
  last,
  children,
}: {
  n: number;
  status: StepStatus;
  title: ReactNode;
  aside?: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className={cn('relative flex gap-3', !last && 'pb-5')} aria-current={status === 'active' ? 'step' : undefined}>
      {last ? null : (
        <span
          aria-hidden
          className={cn(
            'absolute bottom-0 left-[9.5px] top-5 w-px transition-colors duration-200 ease-out',
            status === 'done' ? 'bg-primary-ink/45' : 'bg-border',
          )}
        />
      )}
      <StepMarker n={n} status={status} />
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5 items-center gap-2">
          <p className={cn('min-w-0 flex-1 text-[13px] font-medium leading-5', status === 'todo' && 'text-muted-foreground')}>
            {title}
            {status === 'done' ? <span className="sr-only"> (done)</span> : null}
          </p>
          {aside}
        </div>
        {children}
      </div>
    </li>
  );
}

/** "Create API key › name it “GMI Desk” › Copy" as a quiet breadcrumb. */
export function ClickPath({ steps }: { steps: readonly string[] }) {
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-2xs text-muted-foreground">
      {steps.map((step, i) => (
        <span key={step} className="flex items-center gap-1">
          {i > 0 ? <ChevronRight aria-hidden className="size-3 opacity-60" /> : null}
          <span className={i === 0 || i === steps.length - 1 ? 'font-medium text-foreground/85' : undefined}>{step}</span>
        </span>
      ))}
    </p>
  );
}

/**
 * The listening indicator: a dot with a slow, quiet halo (opacity only, 2.4 s, so it reads as "alive", not
 * "urgent"; reduced motion keeps it because it is status, not decoration). Brand-ink core; the halo is lime on dark,
 * a faint olive on light.
 */
export function ListeningDot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('relative flex size-4 shrink-0 items-center justify-center', className)}>
      <span className="absolute inset-0 animate-pulse rounded-full bg-primary-ink/15 [animation-duration:2.4s] dark:bg-primary/30" />
      <span className="relative size-1.5 rounded-full bg-primary-ink" />
    </span>
  );
}

/** The ↵ hint inside a lime button: black on lime, like the button's text. */
export function EnterKbd({ className }: { className?: string }) {
  return <Kbd className={cn('border-primary-foreground/15 bg-primary-foreground/[0.08] text-primary-foreground/70', className)}>↵</Kbd>;
}

/**
 * Fades its content in from a 2 px blur when it mounts (200 ms ease-out), so swapping a keyed instance reads as a
 * crossfade between step states. `animate={false}` renders it in place (first paint inside an opening dialog,
 * which already animates). Reduced motion: opacity only.
 */
export function Fade({ animate = true, className, children }: { animate?: boolean; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        animate &&
          'transition-[opacity,filter] duration-200 ease-out [filter:blur(0)] starting:opacity-0 starting:[filter:blur(2px)] motion-reduce:starting:[filter:blur(0)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The soft brand light behind Dino (Welcome's hero, the Connect success / "sign-in works" marks): lime on dark; on
 * light only a barely-there olive tint, because a lime glow on a white page reads as a yellow haze. Background
 * classes for a sized, aria-hidden box; it fades out at the box's closest side.
 */
export const DINO_GLOW =
  'bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-primary-ink)_6%,transparent),transparent)] dark:bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-primary)_11%,transparent),transparent)]';

/**
 * GMI's faint grid floor (the `grid-floor` utility, 20 px cells) with DINO_GLOW in the middle, for behind Dino
 * (decorative). Both fade out before the box's edges; keep the box inside any scroll container, or its clipped edge
 * shows.
 */
export function GridGlow({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('pointer-events-none absolute', className)}>
      <span className="grid-floor absolute inset-0 [--grid-cell:20px] [--grid-fade:radial-gradient(closest-side,#000_20%,transparent_100%)]" />
      <span className={cn('absolute inset-0', DINO_GLOW)} />
    </span>
  );
}

/**
 * The success mark: a happy Dino (one hop) on a faint grid floor, with a lime check badge that settles in
 * (0.95 → 1) and draws its check once (stroke-dashoffset, 250 ms, after the hop has started). Reduced motion: Dino
 * stays put, the badge fades, the check is simply there.
 */
export function SuccessMark({ size = 84, className }: { size?: number; className?: string }) {
  return (
    <span aria-hidden className={cn('relative flex items-center justify-center', className)}>
      <GridGlow className="-inset-x-28 -bottom-8 -top-2" />
      <span className="relative">
        <Dino mood="happy" size={size} />
        <span
          className={cn(
            'absolute -bottom-0.5 -right-1 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground ring-[3px] ring-popover',
            'transition-[opacity,scale] delay-200 duration-250 ease-out starting:scale-95 starting:opacity-0 motion-reduce:starting:scale-100',
          )}
        >
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
            <path
              d="M5 12.5l4.5 4.5L19 7.5"
              pathLength={1}
              className="[stroke-dasharray:1] [stroke-dashoffset:0] transition-[stroke-dashoffset] delay-[320ms] duration-250 ease-out starting:[stroke-dashoffset:1] motion-reduce:transition-none"
            />
          </svg>
        </span>
      </span>
    </span>
  );
}
