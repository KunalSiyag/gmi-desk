import { CircleAlert, ExternalLink, KeyRound, LogIn, RotateCw, Wallet } from 'lucide-react';
import { describeError, errorCode } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { signInWithFeedback } from '@renderer/lib/sign-in';
import { useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { Button } from './ui/button';

/**
 * Inline error with the action that fixes it (sign in, add key, raise budget, retry).
 * Use for query/mutation errors anywhere in the app.
 */
export function ErrorNotice({
  error,
  onRetry,
  retryLabel,
  className,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  /** A label for the retry action instead of "Retry" (also shown as text in the compact layout). */
  retryLabel?: string;
  className?: string;
  compact?: boolean;
}) {
  const navigate = useUi((s) => s.navigate);
  const openConnect = useUi((s) => s.openConnect);
  const view = describeError(error);
  const code = errorCode(error);

  let action: React.ReactNode = null;
  if (code === 'not_signed_in' || code === 'reauth_required' || code === 'insufficient_scope') {
    action = (
      <Button size="sm" onClick={() => void signInWithFeedback()}>
        <LogIn />{' '}
        {code === 'insufficient_scope' ? 'Reconnect to grant permission' : code === 'reauth_required' ? 'Sign in again' : 'Sign in with GMI'}
      </Button>
    );
  } else if (code === 'no_api_key' || code === 'invalid_api_key') {
    action = (
      <Button size="sm" onClick={() => openConnect('inference')}>
        <KeyRound /> {code === 'no_api_key' ? 'Connect chat' : 'Replace API key'}
      </Button>
    );
  } else if (code === 'no_compute_key' || code === 'invalid_compute_key') {
    action = (
      <Button size="sm" onClick={() => openConnect('compute')}>
        <KeyRound /> {code === 'no_compute_key' ? 'Connect Compute' : 'Replace Compute key'}
      </Button>
    );
  } else if (code === 'not_entitled' || code === 'quota_exceeded') {
    action = (
      <Button size="sm" variant="outline" onClick={() => void gmi.app.openConsole('computeHome')}>
        GMI Console <ExternalLink />
      </Button>
    );
  } else if (code === 'budget_exceeded') {
    action = (
      <Button size="sm" variant="outline" onClick={() => navigate('usage', { section: 'budget' })}>
        <Wallet /> Review budget
      </Button>
    );
  } else if (code === 'payment_required') {
    action = (
      <Button size="sm" variant="outline" onClick={() => void gmi.app.openConsole('billing')}>
        <Wallet /> Top up in GMI Console
      </Button>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-destructive/25 bg-destructive/[0.05] text-[13px] dark:bg-destructive/[0.08]',
        compact ? 'px-3 py-2' : 'px-4 py-3',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-snug text-foreground">{view.title}</p>
        {view.message ? <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{view.message}</p> : null}
        {(action || onRetry) && !compact ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {action}
            {onRetry ? (
              <Button size="sm" variant="ghost" onClick={onRetry}>
                <RotateCw /> {retryLabel ?? 'Retry'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {compact && (action || onRetry) ? (
        <div className="flex shrink-0 items-center gap-1">
          {action}
          {onRetry && retryLabel ? (
            <Button size="sm" variant="ghost" onClick={onRetry}>
              <RotateCw /> {retryLabel}
            </Button>
          ) : onRetry ? (
            <Button size="icon-sm" variant="ghost" aria-label="Retry" onClick={onRetry}>
              <RotateCw />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
