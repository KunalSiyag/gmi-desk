import { useLayoutEffect, useState, type ReactNode } from 'react';
import { KeyRound, LogIn } from 'lucide-react';
import { useAuth } from '@renderer/lib/hooks';
import { gmi } from '@renderer/lib/gmi';
import { useUi } from '@renderer/lib/store';
import { chatAccess } from './connect/access';
import { DinoLoader } from './brand/Dino';
import { Button } from './ui/button';
import { EmptyState, Spinner } from './ui/misc';
import { ErrorNotice } from './ErrorNotice';
import { SignInPendingActions } from './SignInPendingActions';

/** Renders children only when signed in with GMI; otherwise a sign-in prompt explaining why. */
export function RequireAuth({ children, reason }: { children: ReactNode; reason: string }) {
  const auth = useAuth();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const status = auth.data?.status;
  // The gate's "Sign in with GMI" is the page's sign-in CTA: the top bar hides its own "Sign in" while it is shown.
  // (While signing in, the pending row below counts itself instead.) Layout effect: no frame with both buttons.
  const showsSignIn = !auth.isLoading && status !== 'signed_in' && status !== 'signing_in';
  const registerSignInCta = useUi((s) => s.registerSignInCta);
  useLayoutEffect(() => (showsSignIn ? registerSignInCta() : undefined), [showsSignIn, registerSignInCta]);

  if (auth.isLoading) return <DinoLoader label="Checking your account" className="min-h-48 py-10" />;
  if (status === 'signed_in') return <>{children}</>;

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await gmi.auth.signIn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-3">
      <EmptyState
        dino={status === 'signing_in' ? 'loading' : 'idle'}
        title={status === 'signing_in' ? 'Finish signing in in your browser' : status === 'reauth_required' ? 'Sign in again' : 'Sign in with GMI Cloud'}
        description={reason}
        action={
          status === 'signing_in' ? (
            // A pending browser sign-in can be re-opened or abandoned here (not only in Settings). Dino's plates are
            // the working signal; while this row is mounted the top bar hides its own copy of these actions.
            <SignInPendingActions />
          ) : (
            <Button onClick={() => void signIn()} disabled={busy}>
              {busy ? <Spinner className="text-primary-foreground" /> : <LogIn />}
              Sign in with GMI
            </Button>
          )
        }
      />
      {error ? <ErrorNotice error={error} compact /> : null}
    </div>
  );
}

/**
 * Renders children only when chat can authenticate (a usable key, or GMI accepts the sign-in for chat);
 * otherwise offers the Connect chat dialog.
 */
export function RequireInferenceKey({ children, reason }: { children: ReactNode; reason: string }) {
  const auth = useAuth();
  const openConnect = useUi((s) => s.openConnect);
  if (auth.isLoading) return <DinoLoader label="Checking your account" className="min-h-48 py-10" />;
  const access = auth.data ? chatAccess(auth.data) : 'missing';
  if (access === 'ready') return <>{children}</>;
  return (
    <EmptyState
      icon={<KeyRound />}
      title={access === 'invalid' ? 'Your API key was rejected' : 'Connect chat to GMI'}
      description={reason}
      action={
        <Button onClick={openConnect}>
          <KeyRound /> {access === 'invalid' ? 'Replace key' : 'Connect chat'}
        </Button>
      }
    />
  );
}
