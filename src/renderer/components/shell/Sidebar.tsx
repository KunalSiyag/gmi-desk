import { useMemo, type ComponentType, type ReactNode } from 'react';
import { Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Sun, UserRound } from 'lucide-react';
import type { ThemePreference } from '@shared/contracts/app';
import { APP_NAME } from '@shared/app';
import { useAuth, useCatalog, useSettings, useUpdateSettings } from '@renderer/lib/hooks';
import { useUi } from '@renderer/lib/store';
import { isMac } from '@renderer/lib/gmi';
import { cn } from '@renderer/lib/cn';
import { NAV_PAGES, PAGE_META } from '@renderer/pages/registry';
import { ChatSidebar } from '@renderer/pages/chat/ChatSidebar';
import { ActiveBar } from '../ui/active-bar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Kbd, microLabel } from '../ui/misc';
import { rowPressMotion } from '../ui/motion';
import { Tooltip } from '../ui/tooltip';
import { chatViaSignIn } from '../connect/access';
import { GmiLogo } from '@renderer/components/brand/GmiLogo';

const THEME_ORDER: ThemePreference[] = ['system', 'dark', 'light'];
const THEME_ICON = { system: Monitor, dark: Moon, light: Sun } as const;

export const modKey = () => (isMac() ? '⌘' : 'Ctrl');

/** "GMI Desk": the GMI part in the text colour, the product part in brand ink (as on the boot splash). */
const [BRAND_WORD, ...PRODUCT_WORDS] = APP_NAME.split(' ');

/*
 * The open page's marker is the kit's ActiveBar on the sidebar's left edge (placement="edge"). It appears instantly
 * (pages change from the keyboard, Ctrl+1…5); only hover colours ease. Full-width rows: pressing deepens the
 * background (rowPressMotion), never scales.
 */
const navItemMotion = cn(rowPressMotion, 'aria-[current=page]:transition-none');

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  trailing,
  hint,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  /** Shortcut shown on hover when there is no trailing badge. */
  hint?: string;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'group/nav relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px]',
        navItemMotion,
        active ? 'font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {active ? <ActiveBar placement="edge" /> : null}
      {/* Like the bar and the label, the current page's icon switches instantly; only hover colours ease. */}
      <Icon
        className={cn(
          'size-4 shrink-0',
          active ? 'text-primary-ink' : 'text-muted-foreground transition-[color] duration-150 ease-out group-hover/nav:text-foreground',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing ??
        (hint ? (
          <span aria-hidden className="font-mono text-3xs text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover/nav:opacity-100">
            {hint}
          </span>
        ) : null)}
    </button>
  );
}

function RailItem({
  icon: Icon,
  label,
  active,
  onClick,
  dot,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: boolean;
}) {
  return (
    <Tooltip label={label} side="right">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className={cn('relative', active && 'text-primary-ink hover:text-primary-ink')}
      >
        {active ? <ActiveBar placement="edge" className="-left-2.5" /> : null}
        <Icon />
        {dot ? <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary-ink ring-2 ring-sidebar" /> : null}
      </Button>
    </Tooltip>
  );
}

export function Sidebar() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const auth = useAuth();
  const catalog = useCatalog();
  const { page, navigate, setPaletteOpen } = useUi();
  const collapsed = settings.data?.sidebarCollapsed ?? false;
  const theme = settings.data?.theme ?? 'system';
  const ThemeIcon = THEME_ICON[theme];
  const newCount = useMemo(() => (catalog.data?.models ?? []).filter((m) => m.isNew).length, [catalog.data]);

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? 'system';
    updateSettings.mutate({ theme: next });
  };
  const toggleCollapsed = () => updateSettings.mutate({ sidebarCollapsed: !collapsed });

  const state = auth.data;
  const signedIn = state?.status === 'signed_in';
  const orgShort = signedIn && state.orgId ? state.orgId.slice(0, 8) : null;
  const accountLabel = signedIn
    ? 'Signed in'
    : state?.status === 'signing_in'
      ? 'Signing in…'
      : state?.status === 'reauth_required'
        ? 'Sign in again'
        : 'Not signed in';
  const keyLine =
    state?.inferenceKey.status === 'valid' || state?.inferenceKey.status === 'unverified'
      ? `API key ••${state.inferenceKey.last4 ?? ''}`
      : state?.inferenceKey.status === 'invalid'
        ? 'API key rejected'
        : chatViaSignIn(state)
          ? 'Chat via GMI sign-in'
          : 'No API key';

  if (collapsed) {
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar">
        <div className="flex h-topbar shrink-0 items-center">
          <Tooltip label={`${APP_NAME} · Expand sidebar`} side="right">
            <Button variant="ghost" size="icon-sm" onClick={toggleCollapsed} aria-label="Expand sidebar">
              <PanelLeftOpen />
            </Button>
          </Tooltip>
        </div>
        <div className="flex flex-col items-center gap-1">
          <Tooltip label={`New chat · ${modKey()} N`} side="right">
            <Button variant="outline" size="icon-sm" onClick={() => navigate('chat', { new: '1' })} aria-label="New chat">
              <Plus className="text-primary-ink" />
            </Button>
          </Tooltip>
          <Tooltip label="Search or jump to…" side="right">
            <Button variant="ghost" size="icon-sm" onClick={() => setPaletteOpen(true)} aria-label="Search or jump to">
              <Search />
            </Button>
          </Tooltip>
        </div>
        <nav aria-label="Pages" className="mt-3 flex flex-col items-center gap-1">
          {NAV_PAGES.map((id) => (
            <RailItem
              key={id}
              icon={PAGE_META[id].icon}
              label={PAGE_META[id].title}
              active={page === id}
              onClick={() => navigate(id)}
              dot={id === 'models' && newCount > 0}
            />
          ))}
        </nav>
        <div className="flex-1" />
        <div className="flex w-full flex-col items-center gap-1 border-t border-border py-2">
          <RailItem icon={Settings} label="Settings" active={page === 'settings'} onClick={() => navigate('settings')} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-topbar shrink-0 items-center gap-2.5 pl-3 pr-2">
        {/* GMI Cloud's own logo, then the product word in brand ink (as on the boot splash). */}
        <span className="flex min-w-0 items-center gap-2" title={APP_NAME}>
          <GmiLogo className="h-[15px] w-auto text-foreground" label={BRAND_WORD ?? 'GMI'} />
          {PRODUCT_WORDS.length ? <span className="truncate text-sm font-semibold tracking-tight text-primary-ink">{PRODUCT_WORDS.join(' ')}</span> : null}
        </span>
        {/* Demo data (mock mode) is flagged once, next to the app name. */}
        {state?.mock ? (
          <span title="Demo data: nothing here touches your GMI account" className={cn(microLabel, 'shrink-0 rounded-sm px-1 py-px text-[9px] leading-3 tracking-[0.12em] text-muted-foreground ring-1 ring-inset ring-border')}>
            Demo
          </span>
        ) : null}
        <span className="flex-1" />
        <Tooltip label="Collapse sidebar" side="bottom">
          <Button variant="ghost" size="icon-xs" onClick={toggleCollapsed} aria-label="Collapse sidebar">
            <PanelLeftClose />
          </Button>
        </Tooltip>
      </div>

      <div className="flex flex-col gap-1.5 px-2">
        {/* Quiet on purpose: lime is each page's own primary action, not a fixture of the chrome. */}
        <Button variant="outline" className="w-full justify-start px-2.5 text-foreground" onClick={() => navigate('chat', { new: '1' })}>
          <Plus className="text-primary-ink" /> New chat
          <span className="ml-auto flex items-center gap-0.5">
            <Kbd>{modKey()}</Kbd>
            <Kbd>N</Kbd>
          </span>
        </Button>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md border border-input px-2.5 text-xs text-muted-foreground hover:border-foreground/20 hover:text-foreground dark:bg-white/[0.02]',
            rowPressMotion,
            'transition-[color,background-color,border-color]',
          )}
        >
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search or jump to…</span>
          <span className="flex items-center gap-0.5">
            <Kbd>{modKey()}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>

      <nav aria-label="Pages" className="mt-3 flex flex-col gap-px px-2">
        {NAV_PAGES.map((id) => {
          const meta = PAGE_META[id];
          return (
            <NavItem
              key={id}
              icon={meta.icon}
              label={meta.title}
              active={page === id}
              onClick={() => navigate(id)}
              hint={meta.shortcut ? `${modKey()} ${meta.shortcut}` : undefined}
              trailing={
                id === 'models' && newCount > 0 ? (
                  <Badge variant="primary" className="font-mono tabular-nums">
                    {newCount} new
                  </Badge>
                ) : undefined
              }
            />
          );
        })}
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ChatSidebar />
      </div>

      <div className="flex shrink-0 items-center gap-0.5 border-t border-border p-2">
        <button
          type="button"
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => navigate('settings')}
          className={cn('relative flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-accent/60', navItemMotion)}
        >
          {page === 'settings' ? <ActiveBar placement="edge" /> : null}
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-md ring-1 ring-inset',
              signedIn ? 'bg-primary/15 text-primary-ink ring-primary-ink/20 dark:bg-primary/12' : 'bg-muted text-muted-foreground ring-border',
            )}
          >
            <UserRound className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-foreground">
              {orgShort ? (
                <>
                  Org <span className="font-mono">{orgShort}</span>
                </>
              ) : (
                accountLabel
              )}
            </span>
            <span className="mt-px block truncate text-3xs text-muted-foreground">{keyLine}</span>
          </span>
        </button>
        <Tooltip label={`Theme: ${theme}`} side="top">
          <Button variant="ghost" size="icon-sm" onClick={cycleTheme} aria-label="Change theme">
            <ThemeIcon />
          </Button>
        </Tooltip>
        <Tooltip label={`Settings · ${modKey()} ,`} side="top">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate('settings')} aria-label="Settings">
            <Settings />
          </Button>
        </Tooltip>
      </div>
    </aside>
  );
}
