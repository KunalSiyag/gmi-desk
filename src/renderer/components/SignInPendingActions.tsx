import { useLayoutEffect } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { cancelSignIn, signInWithFeedback } from '@renderer/lib/sign-in';
import { useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { Plates } from './brand/Plates';
import { Button } from './ui/button';

/**
 * Shown while a browser sign-in is pending (up to 5 minutes): the user can re-open the GMI page (the main
 * process joins the running flow) or give up, instead of facing a disabled "Waiting for browser…" button.
 *
 * - default: the page row under RequireAuth's Dino (whose plates already say "working", so no indicator here).
 * - `compact`: one line that never wraps (banners, the top bar), with small Plates as the working signal.
 * - `topBar`: set only by the TopBar. Every other instance counts itself in the UI store while mounted, and the
 *   top bar hides its own copy then, so a page never shows "Open again / Cancel" twice.
 */
export function SignInPendingActions({ compact = false, topBar = false, className }: { compact?: boolean; topBar?: boolean; className?: string }) {
  const register = useUi((s) => s.registerPendingSignInRow);
  // Layout effect: the top bar drops its copy before the first paint, not one frame later.
  useLayoutEffect(() => (topBar ? undefined : register()), [register, topBar]);

  return (
    <div className={cn('flex items-center gap-1.5', compact ? 'shrink-0' : 'flex-wrap justify-center', className)}>
      <span className={cn('flex items-center gap-2 text-muted-foreground', compact ? 'whitespace-nowrap text-xs' : 'w-full justify-center text-[13px]')} role="status">
        {compact ? <Plates size="sm" /> : null}
        {compact ? 'Waiting for browser…' : 'Waiting for the browser sign-in…'}
      </span>
      <Button size={compact ? 'sm' : 'md'} variant="outline" onClick={() => void signInWithFeedback()}>
        <ExternalLink /> {compact ? 'Open again' : 'Open sign-in page again'}
      </Button>
      <Button size={compact ? 'sm' : 'md'} variant="ghost" onClick={() => void cancelSignIn()}>
        <X /> Cancel
      </Button>
    </div>
  );
}
