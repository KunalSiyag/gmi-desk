import { useId, useMemo, type ReactNode } from 'react';
import { microLabel } from '@renderer/components/ui/micro-label';
import { cn } from '@renderer/lib/cn';
import { dinoSvg } from './dino-art';
import { Plates } from './Plates';

/** idle: blinks now and then · loading: plates light up, bobs · happy: one hop · sleep: eyes closed, breathing. */
export type DinoMood = 'idle' | 'loading' | 'happy' | 'sleep';

export interface DinoProps {
  mood?: DinoMood;
  /** Rendered size in px (the art is square). */
  size?: number;
  /** No motion at all (e.g. the brand mark, which sits in view all day). */
  still?: boolean;
  /** Accessible name; without one Dino is decorative (aria-hidden). */
  label?: string;
  className?: string;
}

/**
 * Dino, GMI Cloud's mascot (art: ./dino-art.ts, motion: styles/dino.css). Static markup from our own module, so
 * innerHTML is safe; gradient ids are unique per instance.
 */
export function Dino({ mood = 'idle', size = 64, still, label, className }: DinoProps) {
  const id = useId();
  const html = useMemo(() => ({ __html: dinoSvg(`dino-${id}`) }), [id]);
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-mood={mood}
      data-still={still ? '' : undefined}
      className={cn('dino', className)}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={html}
    />
  );
}

/**
 * Page-level loading state: Dino with a small mono caption. Fades in after a beat (styles/dino.css), so quick
 * loads never flash it. Use skeletons instead where the layout of what is coming is known (lists, tables).
 */
export function DinoLoader({
  label = 'Loading',
  size = 72,
  className,
  children,
}: {
  label?: ReactNode;
  size?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" className={cn('dino-loader flex flex-col items-center justify-center gap-3 text-center', className)}>
      <Dino mood="loading" size={size} />
      <span className={cn(microLabel, 'flex items-center gap-2')}>
        <Plates size="sm" />
        {label}
      </span>
      {children}
    </div>
  );
}
