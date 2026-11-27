import { useCallback, useEffect, useRef, useState } from 'react';
import { LogIn, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import type { AuthState } from '@shared/contracts/auth';
import { chatAccess } from '@renderer/components/connect/access';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { PageHeader } from '@renderer/components/PageHeader';
import { ActiveBar } from '@renderer/components/ui/active-bar';
import { MicroLabel, Skeleton } from '@renderer/components/ui/misc';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { cn } from '@renderer/lib/cn';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useAuth } from '@renderer/lib/hooks';
import { useCommandRegistry, useUi, type PaletteCommand } from '@renderer/lib/store';
import { AccountSection } from './AccountSection';
import { KeySection } from './KeySection';
import { Section, type SettingsSectionId } from './parts';
import { AboutSection, AppearanceSection, CatalogSection, ChatSection, MediaSection, SecuritySection } from './PreferenceSections';
import { SETTINGS_SECTIONS, type SettingsSectionDef } from './sections';

/** Built-in sections and the ones features register (pages/settings/sections.ts), in display order. */
const SECTIONS = SETTINGS_SECTIONS;

/** Any section id: built-in (SettingsSectionId) or registered by a feature. */
const isSectionId = (value: string | undefined): value is string => SECTIONS.some((s) => s.id === value);

/** A feature's section: its Component inside the standard titled card. */
function FeatureSection({ def }: { def: SettingsSectionDef }) {
  const Body = def.Component;
  if (!Body) return null;
  return (
    // Feature ids are not SettingsSectionId members; Section only uses the id for its anchor.
    <Section id={def.id as SettingsSectionId} title={def.title ?? def.label} description={def.description}>
      <Body />
    </Section>
  );
}

function toastError(error: unknown) {
  const view = describeError(error);
  toast.error(view.title, { description: view.message || undefined });
}

/** Palette commands while Settings is open (sign-in/out and key management are global commands). */
function useSettingsCommands(state: AuthState | undefined) {
  const register = useCommandRegistry((s) => s.register);
  const signedIn = state?.status === 'signed_in';
  const hasKey = state ? state.inferenceKey.status !== 'missing' : false;
  useEffect(() => {
    const commands: PaletteCommand[] = [];
    if (hasKey) {
      commands.push({
        id: 'settings.reverify-key',
        label: 'Re-verify inference API key',
        group: 'Settings',
        icon: <RotateCw />,
        keywords: ['api key', 'check', 'validate'],
        run: async () => {
          try {
            const next = await gmi.auth.revalidateInferenceKey();
            if (next.inferenceKey.status === 'valid') toast.success('Inference key verified');
            else toast.error('GMI rejected the inference key', { description: next.inferenceKey.error ?? undefined });
          } catch (error) {
            toastError(error);
          }
        },
      });
    }
    if (signedIn) {
      commands.push({
        id: 'settings.reconnect',
        label: 'Reconnect GMI account',
        group: 'Settings',
        icon: <LogIn />,
        keywords: ['permissions', 'scopes', 'sign in', 'grant'],
        run: () => gmi.auth.signIn().then(() => undefined, toastError),
      });
    }
    return register('settings', commands);
  }, [register, signedIn, hasKey]);
}

/** Placeholder in the shape of the Account card while the auth state loads (usually a single frame). */
function AccountSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-busy>
      <Skeleton className="h-3 w-20" />
      <div className="divide-y divide-border rounded-lg border border-border">
        <div className="flex items-center gap-3 px-4 py-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-72" />
          </div>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const auth = useAuth();
  const params = useUi((s) => s.params);
  const navSeq = useUi((s) => s.navSeq);
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string>('account');
  const [focusKey, setFocusKey] = useState(0);
  // The section the user jumped to stays highlighted until they scroll themselves: short sections near the end
  // can't reach the top, and the scroll position alone would highlight the last one instead.
  const pinned = useRef<string | null>(null);
  useSettingsCommands(auth.data);

  const jumpTo = useCallback((id: string, smooth = false) => {
    const el = document.getElementById(`settings-${id}`);
    if (!el || !scroller.current) return;
    pinned.current = id;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    scroller.current.scrollTo({ top: Math.max(0, el.offsetTop - 24), behavior: smooth && !reduced ? 'smooth' : 'auto' });
    setActive(id);
  }, []);

  // ?section= deep links (e.g. "Add API key" buttons elsewhere in the app).
  const ready = Boolean(auth.data);
  useEffect(() => {
    if (!ready) return;
    const section = params.section;
    if (!isSectionId(section)) return;
    const frame = requestAnimationFrame(() => {
      jumpTo(section);
      if (section === 'keys') setFocusKey((n) => n + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [params.section, navSeq, ready, jumpTo]);

  // Highlight the section being read.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let frame = 0;
    const release = () => {
      pinned.current = null;
    };
    const onScroll = () => {
      if (pinned.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nodes = [...root.querySelectorAll<HTMLElement>('[data-settings-section]')];
        const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
        let current = nodes[0]?.dataset.settingsSection;
        for (const node of nodes) if (node.offsetTop - root.scrollTop <= 80) current = node.dataset.settingsSection;
        if (atBottom) current = nodes.at(-1)?.dataset.settingsSection ?? current;
        if (isSectionId(current)) setActive(current);
      });
    };
    const manual = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    root.addEventListener('scroll', onScroll, { passive: true });
    for (const type of manual) root.addEventListener(type, release, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('scroll', onScroll);
      for (const type of manual) root.removeEventListener(type, release);
    };
  }, [ready]);

  return (
    <div ref={scroller} className="relative h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[57.5rem] gap-10 px-6 py-6">
        <nav aria-label="Settings sections" className="sticky top-6 hidden w-40 shrink-0 self-start md:block">
          <MicroLabel as="p" className="mb-1.5 h-7 px-2.5">
            Sections
          </MicroLabel>
          <ul className="flex flex-col gap-px">
            {SECTIONS.map(({ id, label, icon: Icon }) => {
              const current = active === id;
              const attention = id === 'keys' && auth.data && chatAccess(auth.data) !== 'ready';
              return (
                <li key={id}>
                  <button
                    type="button"
                    // A click scrolls smoothly (it shows where the section is); Enter/Space (detail 0) jumps at once.
                    onClick={(event) => jumpTo(id, event.detail > 0)}
                    aria-current={current ? 'location' : undefined}
                    className={cn(
                      'group/nav relative flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs',
                      // Navigation, marked like the app sidebar: the kit's edge bar and a brand-ink icon, no fill.
                      // The current section changes instantly (scroll spy, keyboard); only hover colours ease, and a
                      // press deepens the background (a full-width row: no scale).
                      rowPressMotion,
                      current ? 'font-medium text-foreground transition-none' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    {current ? <ActiveBar placement="edge" /> : null}
                    <Icon
                      className={cn(
                        'size-3.5 shrink-0',
                        current ? 'text-primary-ink' : 'text-muted-foreground transition-colors duration-150 ease-out group-hover/nav:text-foreground',
                      )}
                    />
                    <span className="truncate">{label}</span>
                    {attention ? <span role="img" className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" aria-label="Needs attention" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-9 pb-16">
          {/* The top bar shows the title: a hidden h1 and the description line, like every other page. */}
          <PageHeader title="Settings" description="Your GMI account, API key and preferences." />

          {SECTIONS.map((def) => {
            switch (def.id) {
              case 'account':
                return auth.isLoading ? (
                  <AccountSkeleton key={def.id} />
                ) : auth.error || !auth.data ? (
                  <ErrorNotice key={def.id} error={auth.error ?? new Error('Could not load your account.')} onRetry={() => void auth.refetch()} />
                ) : (
                  <AccountSection key={def.id} state={auth.data} />
                );
              case 'keys':
                return auth.data && !auth.isLoading ? <KeySection key={def.id} state={auth.data} focusInput={focusKey} /> : null;
              case 'security':
                return auth.data && !auth.isLoading ? <SecuritySection key={def.id} state={auth.data} /> : null;
              case 'appearance':
                return <AppearanceSection key={def.id} />;
              case 'catalog':
                return <CatalogSection key={def.id} />;
              case 'chat':
                return <ChatSection key={def.id} />;
              case 'media':
                return <MediaSection key={def.id} />;
              case 'about':
                return <AboutSection key={def.id} />;
              default:
                return <FeatureSection key={def.id} def={def} />;
            }
          })}
        </div>
      </div>
    </div>
  );
}
