import { useEffect, useRef, type ComponentType, type CSSProperties } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import type { PageId } from '@shared/contracts/app';
import type { AuthState } from '@shared/contracts/auth';
import { hideBootSplash } from './lib/boot-splash';
import { qk } from './lib/query';
import { ComputerDock } from './components/computer/ComputerDock';
import { ConnectChatDialog } from './components/connect/ConnectChatDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { CommandPalette } from './components/shell/CommandPalette';
import { Sidebar } from './components/shell/Sidebar';
import { TopBar } from './components/shell/TopBar';
import { useGlobalShortcuts } from './components/shell/useGlobalShortcuts';
import { TooltipProvider } from './components/ui/tooltip';
import { useAuth, useBalanceRefresh, useGmiEvent, useSettings } from './lib/hooks';
import { useUi } from './lib/store';
import { useApplyTheme } from './lib/theme';
import ChatPage from './pages/chat';
import CreatePage from './pages/create';
import DocsPage from './pages/docs';
import ModelsPage from './pages/models';
import { CodePage } from './pages/registry.code';
import { ComputePage } from './pages/registry.compute';
import SettingsPage from './pages/settings';
import UsagePage from './pages/usage';
import WelcomePage from './pages/welcome';

/**
 * Toasts on GMI's neutral surfaces: sonner's colour variables pointed at the app's tokens (inline, so they beat
 * sonner's theme rules), the app's radius, and type colour only on the icon (lime ink for success).
 * Motion stays sonner's own: bottom-right, in and out through the bottom edge (swipe right or down to dismiss),
 * timers paused on hover and while the window is hidden, no motion under prefers-reduced-motion.
 * Focus (Alt+T, then Tab): the app's outline ring. sonner's ring is a box-shadow, which `shadow-lg!` replaces.
 */
const TOASTER_STYLE = {
  '--normal-bg': 'var(--popover)',
  '--normal-bg-hover': 'var(--accent)',
  '--normal-border': 'var(--border)',
  '--normal-border-hover': 'var(--input)',
  '--normal-text': 'var(--popover-foreground)',
  '--gray2': 'var(--accent)',
  '--gray5': 'var(--input)',
  '--border-radius': 'var(--radius-xl)',
} as CSSProperties;

const TOAST_CLASSES = {
  toast:
    'font-sans text-[13px] gap-2.5! px-3.5! py-3! shadow-lg! dark:border-input! dark:shadow-[0_12px_32px_rgb(0_0_0/0.6)]! focus-visible:outline-2! focus-visible:outline-offset-1! focus-visible:outline-ring/70!',
  title: 'font-medium! leading-snug!',
  description: 'text-xs! leading-relaxed! text-muted-foreground!',
  success: '[&_[data-icon]]:text-primary-ink',
  error: '[&_[data-icon]]:text-destructive',
  warning: '[&_[data-icon]]:text-warning',
  info: '[&_[data-icon]]:text-muted-foreground',
  actionButton: 'bg-primary! text-primary-foreground! font-medium! rounded-md!',
  cancelButton: 'bg-accent! text-foreground! rounded-md!',
  closeButton: 'text-muted-foreground! hover:text-foreground!',
};

const PAGES: Record<PageId, ComponentType> = {
  chat: ChatPage,
  models: ModelsPage,
  create: CreatePage,
  usage: UsagePage,
  docs: DocsPage,
  settings: SettingsPage,
  welcome: WelcomePage,
  compute: ComputePage,
  code: CodePage,
};

export function App() {
  const settings = useSettings();
  const dark = useApplyTheme(settings.data?.theme);
  const auth = useAuth();
  const page = useUi((s) => s.page);
  const navigate = useUi((s) => s.navigate);
  const welcomeDismissed = useUi((s) => s.welcomeDismissed);

  const client = useQueryClient();

  useGlobalShortcuts();
  useGmiEvent('app:navigate', (request) => navigate(request.page, request.params ?? {}));
  // Spending (chat, media) refreshes the top-bar balance.
  useBalanceRefresh();

  // The one place that invalidates the catalog snapshot on catalog:updated (every useCatalog consumer relies
  // on it). Always mounted (unlike pages), so a refresh that finishes while the welcome screen is up is never missed.
  useGmiEvent('catalog:updated', () => {
    void client.invalidateQueries({ queryKey: qk.catalog });
  });

  // Account-scoped data must not survive a sign-out or a switch to another organization.
  const lastAccount = useRef<{ status: AuthState['status']; orgId: string | null } | null>(null);
  useGmiEvent('auth:changed', (state) => {
    const prev = lastAccount.current;
    lastAccount.current = { status: state.status, orgId: state.orgId };
    if (!prev) return;
    const leftAccount = prev.status === 'signed_in' && state.status !== 'signed_in' && state.status !== 'reauth_required';
    const switchedOrg = Boolean(prev.orgId && state.orgId && prev.orgId !== state.orgId);
    const joined = prev.status !== 'signed_in' && state.status === 'signed_in';
    if (leftAccount || switchedOrg) {
      client.removeQueries({ queryKey: ['usage'] });
      client.removeQueries({ queryKey: ['media'] });
      client.removeQueries({ queryKey: ['docs'] });
    }
    if (leftAccount || switchedOrg || joined) {
      // Prices and availability depend on the organization's discount.
      void client.invalidateQueries({ queryKey: ['catalog'] });
      void client.invalidateQueries({ queryKey: ['usage'] });
    }
  });
  useEffect(() => {
    if (auth.data && !lastAccount.current) lastAccount.current = { status: auth.data.status, orgId: auth.data.orgId };
  }, [auth.data]);
  useGmiEvent('app:toast', (message) => {
    const show =
      message.kind === 'error' ? toast.error : message.kind === 'success' ? toast.success : message.kind === 'warning' ? toast.warning : toast.info;
    show(message.title, { description: message.description });
  });

  // First run: land on the welcome screen once if the user is signed out.
  const checkedWelcome = useRef(false);
  useEffect(() => {
    if (checkedWelcome.current || !auth.data) return;
    checkedWelcome.current = true;
    if (auth.data.status === 'signed_out' && !welcomeDismissed) navigate('welcome');
  }, [auth.data, welcomeDismissed, navigate]);

  // The boot splash (index.html) stays until the shell can render its real first state: account and theme known.
  const firstStateKnown = (auth.data !== undefined || auth.isError) && (settings.data !== undefined || settings.isError);
  useEffect(() => {
    if (firstStateKnown) hideBootSplash();
  }, [firstStateKnown]);

  const Page = PAGES[page];
  const chrome = page !== 'welcome';

  return (
    <TooltipProvider>
      <div className="flex h-full">
        {chrome ? <Sidebar /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {chrome ? <TopBar /> : null}
          <div className="flex min-h-0 flex-1">
            <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              <ErrorBoundary key={page}>
                <Page />
              </ErrorBoundary>
            </main>
            {/* Chat, Code and Compute: the computer to the right of the page (nothing while closed). */}
            {chrome ? <ComputerDock /> : null}
          </div>
        </div>
      </div>
      <CommandPalette />
      {/* The one Connect chat dialog: every "add a key" entry point opens it (useUi().openConnect). */}
      <ConnectChatDialog />
      <Toaster theme={dark ? 'dark' : 'light'} position="bottom-right" closeButton style={TOASTER_STYLE} toastOptions={{ classNames: TOAST_CLASSES }} />
    </TooltipProvider>
  );
}
