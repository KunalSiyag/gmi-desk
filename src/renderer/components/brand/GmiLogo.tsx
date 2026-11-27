import type { CSSProperties } from 'react';
import { cn } from '@renderer/lib/cn';
import { GMI_LOGO_VIEWBOX, gmiLogoPaths, type GmiLogoVariant } from './gmi-logo';

/**
 * GMI Cloud's logo (official paths, gmi-logo.ts), in currentColor: `full` (mark + GMI), `mark` (the pixel G) or
 * `wordmark`. Size it with a height class (e.g. h-4); the width follows the aspect ratio.
 */
export function GmiLogo({
  variant = 'full',
  className,
  label = 'GMI Cloud',
  style,
}: {
  variant?: GmiLogoVariant;
  className?: string;
  label?: string | null;
  style?: CSSProperties;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={GMI_LOGO_VIEWBOX[variant]}
      fill="currentColor"
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      className={cn('block shrink-0', className)}
      style={style}
    >
      {gmiLogoPaths(variant).map((d) => (
        <path key={d.slice(0, 24)} d={d} />
      ))}
    </svg>
  );
}
