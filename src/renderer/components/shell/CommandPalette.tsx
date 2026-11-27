import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, LogIn, LogOut, MessageSquare, Monitor, Moon, Plug, Plus, RefreshCw, Sun, X } from 'lucide-react';
import type { ConsolePage } from '@shared/app';
import { GMI_URLS } from '@shared/app';
import { returnFocusTarget, restoreFocusIfIdle } from '@renderer/lib/focus';
import { gmi } from '@renderer/lib/gmi';
import { useAuth, useUpdateSettings } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { cancelSignIn, signInWithFeedback, toastError } from '@renderer/lib/sign-in';
import { useCommandRegistry, useUi, type PaletteCommand } from '@renderer/lib/store';
import { NAV_PAGES, PAGE_META } from '@renderer/pages/registry';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Kbd, microLabel } from '../ui/misc';
import { cn } from '@renderer/lib/cn';
import { actionValue, chatPaletteItems, PALETTE_ACTIONS, paletteFilter, paletteValue } from './palette-items';
import { modKey } from './Sidebar';

const CONSOLE_LINKS: Array<{ page: ConsolePage; label: string }> = [
  { page: 'apiKeys', label: 'API keys' },
  { page: 'billing', label: 'Credits & payment' },
  { page: 'invoices', label: 'Invoices' },
  { page: 'subscription', label: 'Subscription' },
  { page: 'studio', label: 'GMI Studio workflows' },
  { page: 'routerPlayground', label: 'GMI Router playground' },
  { page: 'computeApiKeys', label: 'Compute (Agentbox) API keys' },
];

/** Recent chats listed before anything is typed (all of them, up to the cap, once searching). */
const RECENT_CHATS_SHOWN = 5;
/** After a command ran: time for it to open a dialog or navigate before focus goes back to where it was. */
const FOCUS_SETTLE_MS = 150;

/**
 * A titled group while browsing; a flat run of items while searching. cmdk ranks items only within their
 * group (it never reorders groups), so a flat list is what puts the best match first ("theme" → the theme
 * items, not "New chat with…" just because the page's group comes first).
 */
function Section({ heading, flat, children }: { heading: string; flat: boolean; children: ReactNode }) {
  return flat ? <>{children}</> : <CommandGroup heading={heading}>{children}</CommandGroup>;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const navigate = useUi((s) => s.navigate);
  const openConnect = useUi((s) => s.openConnect);
  const registered = useCommandRegistry((s) => s.commands);
  const auth = useAuth();
  const updateSettings = useUpdateSettings();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const closedByCommand = useRef(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (open) closedByCommand.current = false;
    else setSearch('');
  }, [open]);

  // Chats are searchable by title (the sidebar's list is hidden when it is collapsed).
  const threads = useQuery({ queryKey: qk.threads, queryFn: () => gmi.chat.listThreads(), enabled: open, staleTime: 0 });
  const chats = useMemo(() => chatPaletteItems(threads.data), [threads.data]);

  const run = (fn: () => void | Promise<void>, onError?: (error: unknown) => void) => {
    closedByCommand.current = true;
    const opener = useUi.getState().paletteOpener;
    setOpen(false);
    void Promise.resolve()
      .then(fn)
      .catch((error: unknown) => onError?.(error));
    // Commands that open a dialog or another page move focus themselves; otherwise it goes back.
    window.setTimeout(() => restoreFocusIfIdle(opener), FOCUS_SETTLE_MS);
  };

  const pageCommands = useMemo(() => {
    const groups = new Map<string, PaletteCommand[]>();
    for (const list of registered.values()) {
      for (const cmd of list) {
        const g = groups.get(cmd.group) ?? [];
        g.push(cmd);
        groups.set(cmd.group, g);
      }
    }
    return [...groups.entries()];
  }, [registered]);

  const status = auth.data?.status;
  const signedIn = status === 'signed_in';
  const searching = search.trim().length > 0;

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/25 dark:bg-black/60" />
        <BaseDialog.Popup
          initialFocus={inputRef}
          // Dismissed (Esc, click outside, Ctrl+K): back to the composer / search box / button that opened it.
          finalFocus={() => returnFocusTarget(useUi.getState().paletteOpener, closedByCommand.current)}
          className="fixed left-1/2 top-[14vh] z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none dark:border-input"
        >
          <BaseDialog.Title className="sr-only">Command palette</BaseDialog.Title>
          <Command loop filter={paletteFilter}>
            <CommandInput
              ref={inputRef}
              placeholder="Type a command or search…"
              value={search}
              onValueChange={setSearch}
              trailing={<Kbd className="shrink-0">Esc</Kbd>}
            />
            <CommandList>
              <CommandEmpty>Nothing matches “{search.trim()}”.</CommandEmpty>
              {pageCommands.map(([group, commands]) => (
                <Section key={group} heading={group} flat={searching}>
                  {commands.map((cmd) => (
                    <CommandItem key={cmd.id} value={paletteValue(cmd.label, cmd.keywords)} onSelect={() => run(cmd.run)}>
                      {cmd.icon}
                      <span className="flex-1">{cmd.label}</span>
                      {cmd.shortcut ? <Kbd>{cmd.shortcut}</Kbd> : null}
                    </CommandItem>
                  ))}
                </Section>
              ))}
              <Section heading="Go to" flat={searching}>
                {[...NAV_PAGES, 'settings' as const].map((id) => {
                  const meta = PAGE_META[id];
                  const Icon = meta.icon;
                  return (
                    <CommandItem key={id} value={paletteValue(meta.title, ['go to', 'page', ...(meta.keywords ?? [])])} onSelect={() => run(() => navigate(id))}>
                      <Icon />
                      <span className="flex-1">{meta.title}</span>
                      {meta.shortcut ? (
                        <span className="flex gap-0.5">
                          <Kbd>{modKey()}</Kbd>
                          <Kbd>{meta.shortcut}</Kbd>
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </Section>
              <Section heading="Actions" flat={searching}>
                <CommandItem value={actionValue('newChat')} onSelect={() => run(() => navigate('chat', { new: '1' }))}>
                  <Plus />
                  <span className="flex-1">{PALETTE_ACTIONS.newChat.label}</span>
                  <span className="flex gap-0.5">
                    <Kbd>{modKey()}</Kbd>
                    <Kbd>N</Kbd>
                  </span>
                </CommandItem>
                <CommandItem
                  value={actionValue('refreshCatalog')}
                  onSelect={() =>
                    run(
                      async () => {
                        await gmi.catalog.refresh();
                        await client.invalidateQueries({ queryKey: qk.catalog });
                      },
                      (error) => toastError('Could not refresh the model catalog', error),
                    )
                  }
                >
                  <RefreshCw /> {PALETTE_ACTIONS.refreshCatalog.label}
                </CommandItem>
                {signedIn ? (
                  <CommandItem
                    value={actionValue('signOut')}
                    onSelect={() => run(() => gmi.auth.signOut().then(() => undefined), (error) => toastError('Could not sign out', error))}
                  >
                    <LogOut /> {PALETTE_ACTIONS.signOut.label}
                  </CommandItem>
                ) : status === 'signing_in' ? (
                  <>
                    <CommandItem value={actionValue('reopenSignIn')} onSelect={() => run(() => signInWithFeedback().then(() => undefined))}>
                      <ExternalLink /> {PALETTE_ACTIONS.reopenSignIn.label}
                    </CommandItem>
                    <CommandItem value={actionValue('cancelSignIn')} onSelect={() => run(() => cancelSignIn())}>
                      <X /> {PALETTE_ACTIONS.cancelSignIn.label}
                    </CommandItem>
                  </>
                ) : (
                  <CommandItem value={actionValue('signIn')} onSelect={() => run(() => signInWithFeedback().then(() => undefined))}>
                    <LogIn /> {PALETTE_ACTIONS.signIn.label}
                  </CommandItem>
                )}
                <CommandItem value={actionValue('connectChat')} onSelect={() => run(() => openConnect())}>
                  <Plug /> {PALETTE_ACTIONS.connectChat.label}
                </CommandItem>
                <CommandItem value={actionValue('apiKey')} onSelect={() => run(() => navigate('settings', { section: 'keys' }))}>
                  <KeyRound /> {PALETTE_ACTIONS.apiKey.label}
                </CommandItem>
                <CommandItem value={actionValue('themeDark')} onSelect={() => run(() => updateSettings.mutate({ theme: 'dark' }))}>
                  <Moon /> {PALETTE_ACTIONS.themeDark.label}
                </CommandItem>
                <CommandItem value={actionValue('themeLight')} onSelect={() => run(() => updateSettings.mutate({ theme: 'light' }))}>
                  <Sun /> {PALETTE_ACTIONS.themeLight.label}
                </CommandItem>
                <CommandItem value={actionValue('themeSystem')} onSelect={() => run(() => updateSettings.mutate({ theme: 'system' }))}>
                  <Monitor /> {PALETTE_ACTIONS.themeSystem.label}
                </CommandItem>
              </Section>
              {chats.length > 0 ? (
                <Section heading="Recent chats" flat={searching}>
                  {(searching ? chats : chats.slice(0, RECENT_CHATS_SHOWN)).map((chat) => (
                    <CommandItem key={chat.id} value={chat.value} onSelect={() => run(() => navigate('chat', { thread: chat.id }))}>
                      <MessageSquare />
                      <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                    </CommandItem>
                  ))}
                </Section>
              ) : null}
              <Section heading="GMI Console" flat={searching}>
                {CONSOLE_LINKS.map((link) => (
                  <CommandItem key={link.page} value={paletteValue(link.label, ['console', 'gmi'])} onSelect={() => run(() => gmi.app.openConsole(link.page))}>
                    <ExternalLink /> {link.label}
                  </CommandItem>
                ))}
                <CommandItem value={actionValue('docs')} onSelect={() => run(() => gmi.app.openExternal(GMI_URLS.docs))}>
                  <ExternalLink /> {PALETTE_ACTIONS.docs.label}
                </CommandItem>
              </Section>
            </CommandList>
            <div aria-hidden className={cn('flex h-8 shrink-0 items-center gap-4 border-t border-border px-3 text-muted-foreground', microLabel)}>
              <span className="flex items-center gap-1.5">
                <span className="flex gap-0.5">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </span>
                Move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                Open
              </span>
              <span className="ml-auto">GMI Desk</span>
            </div>
          </Command>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
