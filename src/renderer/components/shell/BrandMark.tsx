import { GmiLogo } from '@renderer/components/brand/GmiLogo';
import { cn } from '@renderer/lib/cn';

/**
 * App mark: GMI Cloud's pixel "G" (official logo, components/brand/gmi-logo.ts), in the text colour. Dino, GMI's
 * mascot, lives in the moments (boot, loading, empty, success), not in the chrome.
 */
export function BrandMark({ className, size = 20 }: { className?: string; size?: number }) {
  return <GmiLogo variant="mark" label={null} className={cn('text-foreground', className)} style={{ height: size * 0.63, width: size }} />;
}
