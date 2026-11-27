// The hourly list price, said the same way everywhere on the Compute page (§9.1: list price, the org may pay less).
import { cn } from '@renderer/lib/cn';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { formatPerHour } from './format';

export const LIST_PRICE_NOTE = 'List price from GMI’s public price list. Your organization may pay less.';

/**
 * "$3.35/h" in mono tabular figures, with a tooltip saying it is a list price. `from`: "from $3.35/h" (signed-out
 * aggregated offers). `unknown` prices read "price unknown" in muted text.
 */
export function PriceTag({ usdPerHour, from, className, quiet }: { usdPerHour: number | null | undefined; from?: boolean; className?: string; quiet?: boolean }) {
  const known = usdPerHour !== null && usdPerHour !== undefined && Number.isFinite(usdPerHour);
  return (
    <Tooltip label={known ? LIST_PRICE_NOTE : 'GMI Desk cannot verify the price of this size right now.'}>
      <span
        className={cn(
          'inline-flex items-baseline gap-1 whitespace-nowrap font-mono text-xs tabular-nums',
          known ? (quiet ? 'text-muted-foreground' : 'text-foreground') : 'text-muted-foreground',
          className,
        )}
      >
        {from && known ? <span className="font-sans text-3xs text-muted-foreground">from</span> : null}
        {formatPerHour(usdPerHour)}
      </span>
    </Tooltip>
  );
}
