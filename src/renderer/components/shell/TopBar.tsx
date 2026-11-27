import { useQuery } from '@tanstack/react-query';
import { KeyRound, LogIn, Wallet } from 'lucide-react';
import { formatUsd } from '@shared/lib/money';
import { useAuth, useCatalog } from '@renderer/lib/hooks';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { signInWithFeedback } from '@renderer/lib/sign-in';
import { useUi } from '@renderer/lib/store';
import { PAGE_META } from '@renderer/pages/registry';
import { chatAccess } from '../connect/access';
import { Plates } from '../brand/Plates';
import { SignInPendingActions } from '../SignInPendingActions';
import { cn } from '@renderer/lib/cn';
import { Button } from '../ui/button';
import { microLabel } from '../ui/misc';
import { Tooltip } from '../ui/tooltip';
import { TopBarSlotTarget } from './topbar-slot';
import { ComputerToggle } from '@renderer/components/computer/ComputerDock';

/** How often the top-bar balance refreshes on its own (spending also refreshes it, see useBalanceRefresh). */
export const BALANCE_REFRESH_MS = 5 * 60_000;

/**
 * The balance chip's query. It polls (GMI keeps charging below zero, and this chip is the only always-visible
 * balance) and uses the default retry policy, so one failure at startup does not hide it for the session.
 */
export function balanceQueryOptions() {
  return {
    queryKey: qk.accountSummary(1),
    queryFn: () => gmi.usage.getAccountSummary(1),
    staleTime: 5 * 60_000,
    refetchInterval: BALANCE_REFRESH_MS,
  };
}

function BalanceChip() {
  const navigate = useUi((s) => s.navigate);
  const summary = useQuery(balanceQueryOptions());
  if (!summary.data) return null;
  const { balanceUsd, promotionCreditUsd, balanceUnlimited } = summary.data;
  const tooltip = `Balance ${balanceUnlimited ? 'unlimited' : formatUsd(balanceUsd)}${
    promotionCreditUsd !== null ? ` · promotion credit ${formatUsd(promotionCreditUsd)} (separate pool)` : ''
  }`;
  const negative = balanceUsd !== null && balanceUsd < 0;
  return (
    <Tooltip label={tooltip} side="bottom">
      <Button variant="outline" size="sm" onClick={() => navigate('usage')} className="gap-2 px-2.5 text-foreground">
        <Wallet className="text-muted-foreground" />
        <span className={cn('font-semibold tabular-nums', negative && 'text-destructive')}>{balanceUnlimited ? 'Unlimited' : formatUsd(balanceUsd)}</span>
        {promotionCreditUsd ? (
          <>
            <span aria-hidden className="h-3.5 w-px bg-border" />
            <span className="flex items-baseline gap-1.5">
              <span className={cn('text-muted-foreground', microLabel)}>Promo</span>
              <span className="text-xs tabular-nums text-muted-foreground">{formatUsd(promotionCreditUsd)}</span>
            </span>
          </>
        ) : null}
      </Button>
    </Tooltip>
  );
}

export function TopBar() {
  const page = useUi((s) => s.page);
  const openConnect = useUi((s) => s.openConnect);
  // The page already shows "Open again / Cancel" (RequireAuth's gate, the Models banner): don't repeat it here.
  const pageShowsPendingSignIn = useUi((s) => s.pendingSignInRows > 0);
  // Same for "Sign in": the page's own CTA (RequireAuth's gate, the Models signed-out banner) is the one to press.
  const pageShowsSignIn = useUi((s) => s.signInCtas > 0);
  const auth = useAuth();
  const catalog = useCatalog();
  const meta = PAGE_META[page];
  const state = auth.data;
  // No usable key, and GMI does not (yet) accept the sign-in for chat.
  const access = chatAccess(state);

  return (
    <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-border px-4">
      <h2 className="truncate text-[13px] font-semibold">{meta.title}</h2>
      {catalog.data?.refreshing ? (
        <Tooltip label="Refreshing the model catalog" side="bottom">
          <span role="status" className={cn('flex h-6 shrink-0 items-center gap-2 rounded-full px-2.5 ring-1 ring-inset ring-border', microLabel)}>
            <Plates size="sm" />
            Updating models
          </span>
        </Tooltip>
      ) : null}
      <TopBarSlotTarget className="ml-auto flex items-center gap-1.5" />
      <div className="flex items-center gap-1.5 empty:hidden">
        {state?.status === 'signed_in' ? <BalanceChip /> : null}
        {state && state.status === 'signing_in' && page !== 'welcome' && !pageShowsPendingSignIn ? <SignInPendingActions compact topBar /> : null}
        {state && state.status !== 'signed_in' && state.status !== 'signing_in' && page !== 'welcome' && !pageShowsSignIn ? (
          <Button size="sm" variant="outline" onClick={() => void signInWithFeedback()}>
            <LogIn />
            {state.status === 'reauth_required' ? 'Sign in again' : 'Sign in'}
          </Button>
        ) : null}
        {/* Not on Settings (its own section) or Chat (the composer already offers it, in context). */}
        {access !== 'ready' && page !== 'settings' && page !== 'chat' ? (
          <Tooltip label={access === 'invalid' ? 'GMI rejected your API key: connect a new one' : 'Chat needs an API key from GMI Console (about 30 seconds)'} side="bottom">
            <Button size="sm" variant="ghost" onClick={() => openConnect()}>
              <KeyRound /> {access === 'invalid' ? 'Fix API key' : 'Connect chat'}
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {/* Chat, Code and Compute: show / hide the computer dock (⌘/Ctrl+J). Renders nothing on other pages. */}
      <ComputerToggle />
    </header>
  );
}
