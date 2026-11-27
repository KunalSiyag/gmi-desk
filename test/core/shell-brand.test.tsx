// GMI brand contracts for the UI kit and the app shell: lime is a fill with black text on top, brand-coloured
// text/icons use primary-ink (lime on dark, olive on light), micro-labels are mono uppercase, and the open page
// is marked by a brand-ink bar instead of a grey slab.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/contracts/app';
import type { AuthState } from '@shared/contracts/auth';
import { DEFAULT_SETTINGS } from '@shared/contracts';

vi.mock('@renderer/pages/chat/ChatSidebar', () => ({ ChatSidebar: () => null }));

import { Sidebar } from '@renderer/components/shell/Sidebar';
import { badgeVariants } from '@renderer/components/ui/badge';
import { buttonVariants } from '@renderer/components/ui/button';
import { EmptyState, Kbd, microLabel, SectionLabel } from '@renderer/components/ui/misc';
import { Switch } from '@renderer/components/ui/switch';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';

const words = (classes: string) => classes.split(/\s+/).filter(Boolean);

function signedIn(): AuthState {
  return {
    status: 'signed_in',
    scopes: [],
    orgId: null,
    signedInAt: null,
    accessTokenExpiresAt: null,
    inferenceKey: { status: 'valid', source: 'keychain', last4: 'abcd', keyId: 'k', scope: 'ie_model', orgId: null, orgMatchesAccount: null, validatedAt: null, error: null },
    secureStorage: 'os',
    lastError: null,
    mock: false,
    signInInProgress: false,
  };
}

// The shell reads the platform (Ctrl vs ⌘) from the preload bridge.
beforeEach(() => {
  (globalThis as { window?: unknown }).window = { gmi: { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' } };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function renderSidebar(page: 'models' | 'chat', collapsed = false): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<AppSettings>(qk.settings, { ...DEFAULT_SETTINGS, sidebarCollapsed: collapsed });
  client.setQueryData(qk.auth, signedIn());
  const initial = useUi.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, { page });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Sidebar />
      </QueryClientProvider>,
    );
  } finally {
    Object.assign(initial, saved);
  }
}

describe('lime is a fill, brand text is ink', () => {
  it('the default button is lime with black text and a hover token; links use primary-ink', () => {
    const primary = words(buttonVariants({ variant: 'default' }));
    expect(primary).toEqual(expect.arrayContaining(['bg-primary', 'text-primary-foreground', 'hover:bg-primary-hover']));
    expect(words(buttonVariants({ variant: 'link' }))).toContain('text-primary-ink');
  });

  it('no kit variant puts lime text on a surface (text-primary)', () => {
    for (const variant of ['default', 'secondary', 'outline', 'ghost', 'subtle', 'destructive', 'link'] as const) {
      expect(words(buttonVariants({ variant }))).not.toContain('text-primary');
    }
    for (const variant of ['default', 'primary', 'new', 'success', 'warning', 'danger', 'outline'] as const) {
      expect(words(badgeVariants({ variant }))).not.toContain('text-primary');
    }
    expect(words(badgeVariants({ variant: 'primary' }))).toContain('text-primary-ink');
    // "new" is a heavier brand tint with ink, not a lime fill: lists show many of them, the fill is one action per screen.
    expect(words(badgeVariants({ variant: 'new' }))).toEqual(expect.arrayContaining(['bg-primary/20', 'text-primary-ink']));
    expect(words(badgeVariants({ variant: 'new' }))).not.toContain('text-primary-foreground');
  });

  it('a checked switch is a lime track with a black thumb', () => {
    const html = renderToStaticMarkup(<Switch checked onCheckedChange={() => undefined} aria-label="On" />);
    expect(html).toContain('data-[checked]:bg-primary');
    expect(html).toContain('data-[checked]:bg-primary-foreground');
  });
});

describe('GMI micro-labels', () => {
  it('section labels and keycaps are monospace; section labels are uppercase with wide tracking', () => {
    expect(words(microLabel)).toEqual(expect.arrayContaining(['font-mono', 'uppercase', 'text-3xs']));
    const label = renderToStaticMarkup(<SectionLabel>Recent</SectionLabel>);
    for (const c of words(microLabel)) expect(label).toContain(c);
    expect(renderToStaticMarkup(<Kbd>K</Kbd>)).toContain('font-mono');
  });

  it('EmptyState shows Dino on a grid floor when given a mood, and keeps the icon API', () => {
    const withDino = renderToStaticMarkup(<EmptyState dino="sleep" title="Nothing yet" />);
    expect(withDino).toContain('data-mood="sleep"');
    expect(withDino).toContain('grid-floor');
    const withIcon = renderToStaticMarkup(<EmptyState icon={<svg data-testid="icon" />} title="Nothing yet" />);
    expect(withIcon).toContain('data-testid="icon"');
    expect(withIcon).not.toContain('data-mood');
  });
});

describe('sidebar: the open page is marked by a brand-ink bar, not a grey slab', () => {
  it.each([false, true])('collapsed: %s', (collapsed) => {
    const html = renderSidebar('models', collapsed);
    const current = /<button[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/button>/.exec(html);
    expect(current).not.toBeNull();
    const tag = current![0].slice(0, current![0].indexOf('>') + 1);
    // The bar (brand ink) and a brand-ink icon; no unconditional grey background on the current item.
    expect(current![1]).toContain('bg-primary-ink');
    expect(current![0]).toContain('text-primary-ink');
    expect(tag).not.toMatch(/[\s"]bg-accent(\/\d+)?[\s"]/);
  });

  it.each([false, true])('New chat is quiet (no lime slab): outline, brand-ink plus, neutral keycaps (collapsed: %s)', (collapsed) => {
    const html = renderSidebar('models', collapsed);
    const button = /<button[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g;
    const newChat = (html.match(button) ?? []).find((b) => b.includes('New chat'));
    expect(newChat).toBeDefined();
    const tag = newChat!.slice(0, newChat!.indexOf('>') + 1);
    expect(tag).not.toMatch(/[\s"]bg-primary[\s"]/);
    expect(tag).toContain('border-input');
    expect(newChat).toMatch(/<svg[^>]*class="[^"]*lucide-plus[^"]*text-primary-ink/);
    expect(newChat).not.toContain('text-primary-foreground');
  });

  it('switches the current page\'s icon instantly like its bar and label; only other items\' icons ease on hover', () => {
    const html = renderSidebar('models');
    const nav = /<nav aria-label="Pages"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    const icons = (button: string) => /<svg[^>]*class="([^"]*)"/.exec(button)?.[1] ?? '';
    const buttons = nav.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g) ?? [];
    const current = buttons.filter((b) => b.includes('aria-current="page"'));
    const others = buttons.filter((b) => !b.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(others.length).toBeGreaterThan(0);
    expect(words(icons(current[0]!))).toContain('text-primary-ink');
    expect(icons(current[0]!)).not.toMatch(/transition|duration-/);
    for (const b of others) {
      expect(words(icons(b))).toEqual(expect.arrayContaining(['text-muted-foreground', 'transition-[color]', 'ease-out', 'group-hover/nav:text-foreground']));
    }
  });

  it('full-width rows (pages, search, account) answer a press with a deeper background, never a scale', () => {
    const html = renderSidebar('models');
    const buttons = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g) ?? [];
    const rows = buttons.filter((b) => /Usage<\/span>|Search or jump to|Org |Signed in/.test(b));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const tag = words(/class="([^"]*)"/.exec(row)?.[1] ?? '');
      expect(tag).toContain('active:bg-foreground/10');
      expect(tag.filter((c) => /(^|:)scale-/.test(c))).toEqual([]);
    }
  });

  it("shows GMI Cloud's logo, then the product word in brand ink, and no demo tag outside demo data", () => {
    const html = renderSidebar('chat');
    // The official logo (mark + GMI wordmark) in the text colour, labelled for screen readers.
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="GMI"[^>]*class="[^"]*text-foreground/);
    expect(html).toMatch(/<span class="[^"]*text-primary-ink[^"]*">Desk<\/span>/);
    expect(html).not.toContain('Demo');
  });
});
