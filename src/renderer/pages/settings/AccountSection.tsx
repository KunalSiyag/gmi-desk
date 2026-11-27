import { useLayoutEffect, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Lock, LogIn, LogOut, RefreshCw, UserRound, X } from 'lucide-react';
import { GMI_SCOPES, type AuthState } from '@shared/contracts/auth';
import { formatRelativeTime } from '@shared/lib/format';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Plates } from '@renderer/components/brand/Plates';
import { microLabel, Spinner } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { CopyButton, dangerButton, InlineNote, KeychainLockedNote, Mono, Row, SCOPE_INFO, ScopeGrid, Section, StatusHeader } from './parts';

function sessionNote(expiresAt: string | null): string {
  if (!expiresAt) return 'session renews automatically';
  const minutes = Math.round((Date.parse(expiresAt) - Date.now()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 1) return 'session renewing';
  return `session renews automatically (token valid ${minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`})`;
}

function useAuthMutations() {
  const client = useQueryClient();
  const setState = (state: AuthState) => client.setQueryData(qk.auth, state);
  const signIn = useMutation({ mutationFn: () => gmi.auth.signIn(), onSuccess: setState });
  const cancel = useMutation({ mutationFn: () => gmi.auth.cancelSignIn(), onSuccess: setState });
  const signOut = useMutation({ mutationFn: () => gmi.auth.signOut(), onSuccess: setState });
  return { signIn, cancel, signOut };
}

export function AccountSection({ state }: { state: AuthState }) {
  const { signIn, cancel, signOut } = useAuthMutations();
  const waiting = state.status === 'signing_in' || state.signInInProgress === true;
  const signedIn = state.status === 'signed_in';
  // A saved sign-in exists but the OS keychain would not decrypt it (nothing was deleted).
  const locked = !signedIn && (state.lockedSecrets?.includes('sign_in') ?? false);
  const granted = new Set(state.scopes);
  // This card's "Open again / Cancel" is the page's sign-in row: the top bar hides its own copy meanwhile.
  const registerPendingRow = useUi((s) => s.registerPendingSignInRow);
  useLayoutEffect(() => (waiting ? registerPendingRow() : undefined), [waiting, registerPendingRow]);
  // The card's own "Sign in with GMI" is this page's sign-in call to action: the top bar hides its duplicate (D17).
  const showsSignIn = !waiting && !signedIn;
  const registerSignInCta = useUi((s) => s.registerSignInCta);
  useLayoutEffect(() => (showsSignIn ? registerSignInCta() : undefined), [showsSignIn, registerSignInCta]);
  const missing = signedIn ? GMI_SCOPES.filter((s) => !granted.has(s)) : [];

  const startSignIn = () => {
    signIn.reset();
    signIn.mutate();
  };

  let title = 'GMI Cloud';
  let subtitle: ReactNode;
  let badge: ReactNode = null;
  if (waiting) {
    title = 'Waiting for you in the browser…';
    subtitle = 'Approve GMI Desk on gmicloud.ai — this page updates by itself.';
  } else if (signedIn) {
    subtitle = `${state.signedInAt ? `Signed in ${formatRelativeTime(state.signedInAt)}` : 'Signed in'} · ${sessionNote(state.accessTokenExpiresAt)}`;
    badge = <Badge variant="primary">Signed in</Badge>;
  } else if (locked) {
    subtitle = 'Your saved sign-in is in the OS keychain, which GMI Desk could not unlock.';
    badge = (
      <Badge variant="warning">
        <Lock /> Keychain locked
      </Badge>
    );
  } else if (state.status === 'reauth_required') {
    subtitle = state.lastError ?? 'Your sign-in expired or was revoked. Sign in again to continue.';
    badge = <Badge variant="warning">Sign-in expired</Badge>;
  } else {
    subtitle = 'Sign in to see your prices, balance, media and docs.';
    badge = <Badge variant="outline">Not signed in</Badge>;
  }

  const actionError = signIn.error ?? signOut.error ?? cancel.error;
  const tone = waiting || signedIn ? 'brand' : locked || state.status === 'reauth_required' ? 'warning' : 'muted';

  return (
    <Section id="account" title="Account" description="Your GMI Cloud sign-in covers models, usage, media, docs and support.">
      <StatusHeader
        tone={tone}
        chip={waiting ? <Plates size="sm" /> : locked ? <Lock /> : <UserRound />}
        title={title}
        badges={badge}
        subtitle={<span title={typeof subtitle === 'string' ? subtitle : undefined}>{subtitle}</span>}
        actions={
          waiting ? (
            <>
              {/* Same emphasis as SignInPendingActions elsewhere: re-open is the way forward, cancel stays quiet. */}
              <Tooltip label="Open the GMI sign-in page again">
                <Button size="sm" variant="outline" onClick={() => void gmi.auth.signIn().catch(() => undefined)}>
                  <ExternalLink /> Open again
                </Button>
              </Tooltip>
              <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <X /> Cancel
              </Button>
            </>
          ) : signedIn ? null : (
            <Button size="sm" onClick={startSignIn} disabled={signIn.isPending}>
              {signIn.isPending ? <Spinner className="text-primary-foreground" /> : <LogIn />}
              {state.status === 'reauth_required' ? 'Sign in again' : 'Sign in with GMI'}
            </Button>
          )
        }
      />

      {actionError && !waiting ? (
        <div className="px-4 py-3">
          <ErrorNotice error={actionError} compact />
        </div>
      ) : locked && !waiting ? (
        <KeychainLockedNote secret="sign_in" />
      ) : state.lastError && !waiting && state.status !== 'reauth_required' ? (
        // Signed in: the session survives (e.g. a refresh hit a network error), so only warn.
        <InlineNote tone={signedIn ? 'warning' : 'danger'}>
          {signedIn ? `Could not refresh your session: ${state.lastError}` : state.lastError}
        </InlineNote>
      ) : null}

      {signedIn ? (
        <Row label="Organization" description="The GMI organization this sign-in belongs to.">
          {state.orgId ? (
            <>
              <Mono className="text-foreground/80" title={state.orgId}>
                {state.orgId}
              </Mono>
              <CopyButton value={state.orgId} label="Copy organization ID" />
            </>
          ) : state.orgIdPending ? (
            <span role="status" className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Plates size="sm" /> Looking it up…
            </span>
          ) : (
            <Tooltip label="GMI did not report it this time. GMI Desk asks again the next time it starts.">
              <span className="text-2xs text-muted-foreground">Not available</span>
            </Tooltip>
          )}
        </Row>
      ) : null}

      <div className="px-4 py-3.5">
        <div className="mb-2.5 flex items-baseline justify-between gap-4">
          <span className="text-[13px] font-medium">{signedIn ? 'Permissions' : 'GMI will ask you to allow'}</span>
          {signedIn ? (
            <span className={cn(microLabel, 'tabular-nums')}>
              <span className={missing.length === 0 ? 'text-primary-ink' : 'text-warning-foreground'}>{GMI_SCOPES.length - missing.length}</span>
              {' / '}
              {GMI_SCOPES.length} granted
            </span>
          ) : null}
        </div>
        <ScopeGrid scopes={state.scopes} mode={signedIn ? 'granted' : 'requested'} />
      </div>

      {missing.length > 0 && !waiting ? (
        <div className="flex items-center gap-3 bg-warning/[0.07] px-4 py-2.5">
          <AlertTriangle className="size-3.5 shrink-0 text-warning-foreground" />
          <p className="min-w-0 flex-1 text-2xs leading-relaxed">
            Not granted: {missing.map((s) => SCOPE_INFO[s].toLowerCase()).join(', ')}.
          </p>
          <Button size="sm" variant="outline" onClick={startSignIn}>
            <RefreshCw /> Reconnect to grant missing permissions
          </Button>
        </div>
      ) : null}

      {signedIn && !waiting ? (
        <Row label="Sign out" description="Forgets this computer’s GMI sign-in. Your API key, chats and settings stay.">
          <Button size="sm" variant="outline" className={dangerButton} onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            {signOut.isPending ? <Spinner className="text-destructive" /> : <LogOut />} Sign out
          </Button>
        </Row>
      ) : null}
    </Section>
  );
}
