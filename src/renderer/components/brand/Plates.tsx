import { cn } from '@renderer/lib/cn';

const DELAYS_MS = [0, 160, 320];

/** Plate size and spacing per `size`: md next to body text (chat replies), sm inside chips, badges and status rows. */
const SIZES = {
  sm: { row: 'gap-[3px] px-px', plate: 'size-[4px]' },
  md: { row: 'gap-[5px] px-0.5', plate: 'size-[5px]' },
} as const;

export type PlatesSize = keyof typeof SIZES;

/**
 * The app's one "working" signal: three pixels of GMI's stepped logo lighting up in turn, in brand ink (lime on dark,
 * olive on light). Use it in status chips, badges and rows ("Updating models", "Waiting for browser…", a running job);
 * a pending button keeps its small Spinner, a page-level wait uses DinoLoader.
 *
 * Props: `size` 'sm' (chips/badges, 4px plates) | 'md' (default, 5px, next to 13px text); `className`.
 * Opacity only (the `dino-plate-fade` keyframes in styles/dino.css), so it keeps pulsing under reduced motion: it is
 * status, not decoration. Decorative (aria-hidden): pair it with text or a role="status" label nearby.
 */
export function Plates({ size = 'md', className }: { size?: PlatesSize; className?: string }) {
  const s = SIZES[size];
  return (
    <span aria-hidden data-plates="" className={cn('inline-flex shrink-0 items-center', s.row, className)}>
      {DELAYS_MS.map((delay) => (
        <span
          key={delay}
          style={{ animationDelay: `${delay}ms` }}
          className={cn('rounded-[1px] bg-primary-ink opacity-40 animate-[dino-plate-fade_1.2s_cubic-bezier(0.45,0,0.55,1)_infinite]', s.plate)}
        />
      ))}
    </span>
  );
}
