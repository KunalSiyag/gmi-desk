import type { HTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/lib/cn';

export const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded font-medium [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground',
        /**
         * Lime tint with brand ink (lime text on dark, olive on light): every brand-positive state — OK, verified,
         * valid, connected, done, a GMI deal (see DiscountBadge).
         */
        primary: 'bg-primary/15 text-primary-ink ring-1 ring-inset ring-primary-ink/20 dark:bg-primary/12',
        /**
         * Fresh things (new models): a heavier `primary` tint, like the sidebar's "4 new" counter. Not a lime fill:
         * that belongs to the one action a screen offers, and lists show many of these chips.
         */
        new: 'bg-primary/20 font-semibold text-primary-ink ring-1 ring-inset ring-primary-ink/30 dark:bg-primary/15',
        /** Rare verification states only (not brand-positive ones: those are `primary`). */
        success: 'bg-success/12 text-success-foreground ring-1 ring-inset ring-success/20',
        warning: 'bg-warning/15 text-warning-foreground ring-1 ring-inset ring-warning/25',
        danger: 'bg-destructive/12 text-destructive ring-1 ring-inset ring-destructive/20',
        outline: 'text-muted-foreground ring-1 ring-inset ring-border',
      },
      size: {
        md: 'px-1.5 py-px text-2xs',
        /** Dense rows (thread lists, diff rows, model lists): a 10px chip that fits a 16px line. */
        sm: 'px-1 py-0 text-3xs',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

/**
 * "-20%" for a discount given as a fraction (the catalog's `discount`, 0.2) or, with `{ pct }`, in whole percent
 * (20). One decimal at most ("-12.5%"), capped at 100 %. null for no / zero / negative discount.
 */
export function discountLabel(discount: number | null | undefined, unit: 'fraction' | 'pct' = 'fraction'): string | null {
  if (discount === null || discount === undefined || !Number.isFinite(discount) || discount <= 0) return null;
  const pct = Math.round(Math.min(1, unit === 'pct' ? discount / 100 : discount) * 1000) / 10;
  return pct > 0 ? `-${pct}%` : null;
}

/**
 * The one GMI deal badge: lime tint + brand ink (Badge variant="primary"), mono tabular "-20%". Renders nothing
 * without a positive discount.
 * - `pct`: discount in whole percent (20 → "-20%"), or
 * - `discount`: as a fraction, the way the catalog stores it (`model.discount`, 0.2 → "-20%"); `pct` wins if both.
 * - `children`: replaces the text (e.g. "-20% · your org"); still hidden when there is no discount.
 */
export function DiscountBadge({
  pct,
  discount,
  children,
  className,
}: {
  pct?: number | null;
  discount?: number | null;
  children?: ReactNode;
  className?: string;
}) {
  const off = pct !== undefined && pct !== null ? discountLabel(pct, 'pct') : discountLabel(discount);
  if (!off) return null;
  return (
    <Badge variant="primary" className={cn('font-mono tabular-nums tracking-tight', className)}>
      {children ?? off}
    </Badge>
  );
}
