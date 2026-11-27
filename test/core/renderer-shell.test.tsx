// App shell (renderer): command palette search, focus return, sign-in feedback and pending-sign-in actions,
// the top-bar balance, sidebar navigation semantics and badge text colours.
// Findings foundation-22, -38, -39, -40, -41, -46, -54 (badges), -56.
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/contracts/app';
import type { AuthState } from '@shared/contracts/auth';
import type { ChatThreadSummary } from '@shared/contracts/chat';
import { DEFAULT_SETTINGS, ERROR_HINTS, type GmiBridge } from '@shared/contracts';

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));
// The chat list is the chat slice's component; the sidebar test is about the navigation around it.
vi.mock('@renderer/pages/chat/ChatSidebar', () => ({ ChatSidebar: () => null }));

import { RequireAuth } from '@renderer/components/RequireAuth';
import { SignInPendingActions } from '@renderer/components/SignInPendingActions';
import { badgeVariants } from '@renderer/components/ui/badge';
import { actionValue, chatPaletteItems, MAX_PALETTE_CHATS, PALETTE_ACTIONS, paletteFilter, paletteValue, type PaletteActionId } from '@renderer/components/shell/palette-items';
import { Sidebar } from '@renderer/components/shell/Sidebar';
import { BALANCE_REFRESH_MS, balanceQueryOptions, TopBar } from '@renderer/components/shell/TopBar';
import { restoreFocusIfIdle, returnFocusTarget } from '@renderer/lib/focus';
import { debouncedInvalidation, qk } from '@renderer/lib/query';
import { cancelSignIn, SIGN_IN_ERROR_TOAST_ID, signInWithFeedback } from '@renderer/lib/sign-in';
import { useUi } from '@renderer/lib/store';

type Invoke = (ns: string, method: string, args: unknown[]) => Promise<unknown>;

function installBridge(invoke: Invoke): { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const bridge: GmiBridge = {
    invoke: (ns, method, args) => {
      calls.push([ns, method]);
      return invoke(ns, method, args) as ReturnType<GmiBridge['invoke']>;
    },
    on: () => () => undefined,
    platform: 'linux',
  };
  (globalThis as { window?: unknown }).window = { gmi: bridge };
  return { calls };
}

const KEY = { status: 'valid', source: 'keychain', last4: 'abcd', keyId: 'k', scope: 'ie_model', orgId: null, orgMatchesAccount: null, validatedAt: null, error: null } as const;

function authState(status: AuthState['status']): AuthState {
  return {
    status,
    scopes: [],
    orgId: null,
    signedInAt: null,
    accessTokenExpiresAt: null,
    inferenceKey: { ...KEY },
    secureStorage: 'os',
    lastError: null,
    mock: true,
    signInInProgress: status === 'signing_in',
  };
}

/**
 * Server rendering reads zustand's *initial* state (useSyncExternalStore's server snapshot), so UI state for a
 * render is applied to that object and restored afterwards.
 */
function renderWith(node: ReactNode, seed: (client: QueryClient) => void, ui: Partial<ReturnType<typeof useUi.getState>> = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  const initial = useUi.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, ui);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  } finally {
    Object.assign(initial, saved);
  }
}

/** A `disabled` attribute (not the `disabled:` Tailwind variants in class names). */
const DISABLED_ATTR = /\sdisabled(=""|\s|>)/;

beforeEach(() => {
  installBridge(async () => ({ ok: true, data: null }));
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  useUi.setState({ page: 'chat', params: {}, paletteOpen: false, paletteOpener: null });
  vi.clearAllMocks();
});

describe('command palette search (foundation-38, foundation-46)', () => {
  it('finds every built-in action by the label the user sees', () => {
    for (const [id, action] of Object.entries(PALETTE_ACTIONS) as Array<[PaletteActionId, (typeof PALETTE_ACTIONS)[PaletteActionId]]>) {
      expect(paletteFilter(actionValue(id), action.label), action.label).toBeGreaterThan(0);
      expect(paletteFilter(actionValue(id), action.label.split(' ')[0]!), action.label).toBeGreaterThan(0);
    }
    expect(paletteFilter(actionValue('apiKey'), 'inference key')).toBeGreaterThan(0);
    expect(paletteFilter(actionValue('docs'), 'docs')).toBeGreaterThan(0);
  });

  it('ranks the theme items first when typing "theme"', () => {
    const theme = paletteFilter(actionValue('themeDark'), 'theme');
    expect(theme).toBeGreaterThan(paletteFilter(paletteValue('New chat with DeepSeek-V4-Pro', ['new', 'chat', 'thread', 'same model']), 'theme'));
    expect(theme).toBeGreaterThan(paletteFilter(paletteValue('Delete chat…', ['remove']), 'theme'));
  });

  const thread = (id: string, title: string, updatedAt: string): ChatThreadSummary => ({
    id,
    title,
    mode: 'model',
    model: 'zai-org/GLM-5.3',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
    costUsd: 0,
  });

  it('lists chats newest first, searchable by title, capped', () => {
    const items = chatPaletteItems([
      thread('11111111-aaaa-4bbb-8ccc-dddddddddddd', 'Old chat', '2026-10-01T10:00:00.000Z'),
      thread('22222222-aaaa-4bbb-8ccc-dddddddddddd', 'Explain KV cache in 5 bullets', '2026-10-31T10:00:00.000Z'),
      thread('33333333-aaaa-4bbb-8ccc-dddddddddddd', '  ', '2026-10-15T10:00:00.000Z'),
    ]);
    expect(items.map((i) => i.title)).toEqual(['Explain KV cache in 5 bullets', 'Untitled chat', 'Old chat']);
    const kv = items[0]!;
    expect(paletteFilter(kv.value, 'KV cache')).toBeGreaterThan(0);
    expect(paletteFilter(kv.value, 'kv')).toBeGreaterThan(0);
    // The id only keeps values unique; hex-looking words do not match every chat through it.
    expect(paletteFilter(kv.value, 'dead')).toBe(0);
    expect(new Set(items.map((i) => i.value)).size).toBe(3);

    const many = Array.from({ length: 80 }, (_, i) => thread(`id-${i}`, `Chat ${i}`, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString()));
    const capped = chatPaletteItems(many);
    expect(capped).toHaveLength(MAX_PALETTE_CHATS);
    expect(capped[0]!.title).toBe('Chat 79');
    expect(chatPaletteItems(undefined)).toEqual([]);
  });
});

describe('palette focus return (foundation-39)', () => {
  const el = (connected = true) => ({ isConnected: connected, focus: vi.fn() });

  it('remembers the focused element when the palette opens', () => {
    const composer = el();
    const body = {};
    (globalThis as { document?: unknown }).document = { activeElement: composer, body };
    useUi.getState().setPaletteOpen(true);
    expect(useUi.getState().paletteOpener).toBe(composer);
    // Focus moves into the palette input; re-opening while open must not overwrite the opener.
    (globalThis as { document?: unknown }).document = { activeElement: el(), body };
    useUi.getState().setPaletteOpen(true);
    expect(useUi.getState().paletteOpener).toBe(composer);
    useUi.getState().setPaletteOpen(false);
    expect(useUi.getState().paletteOpener).toBe(composer);
    // Opened while nothing had focus.
    (globalThis as { document?: unknown }).document = { activeElement: body, body };
    useUi.getState().setPaletteOpen(true);
    expect(useUi.getState().paletteOpener).toBeNull();
  });

  it('returns focus to the opener on dismiss, and leaves it to commands otherwise', () => {
    const composer = el();
    expect(returnFocusTarget(composer, false)).toBe(composer);
    expect(returnFocusTarget(el(false), false)).toBe(true);
    expect(returnFocusTarget(null, false)).toBe(true);
    expect(returnFocusTarget(composer, true)).toBe(false);
  });

  it('after a command, refocuses the opener only when focus fell to <body>', () => {
    const body = {};
    const composer = el();
    expect(restoreFocusIfIdle(composer, { activeElement: body, body })).toBe(true);
    expect(composer.focus).toHaveBeenCalledTimes(1);
    const dialogInput = el();
    expect(restoreFocusIfIdle(composer, { activeElement: dialogInput, body })).toBe(false);
    expect(restoreFocusIfIdle(el(false), { activeElement: body, body })).toBe(false);
    expect(composer.focus).toHaveBeenCalledTimes(1);
  });
});

describe('sign-in feedback (foundation-41)', () => {
  it('shows a toast when sign-in fails', async () => {
    const { calls } = installBridge(async () => ({ ok: false, error: { code: 'network', message: 'fetch failed' } }));
    await expect(signInWithFeedback()).resolves.toBe(false);
    expect(calls).toEqual([['auth', 'signIn']]);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.error.mock.calls[0]!;
    expect(title).toBe('Sign-in failed');
    expect(opts).toMatchObject({ id: SIGN_IN_ERROR_TOAST_ID });
    expect(String(opts.description)).toContain(ERROR_HINTS.network);
    expect(String(opts.description)).toContain('fetch failed');
  });

  it('stays quiet when the sign-in succeeds or was cancelled', async () => {
    installBridge(async () => ({ ok: true, data: authState('signed_in') }));
    await expect(signInWithFeedback()).resolves.toBe(true);
    installBridge(async () => ({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } }));
    await expect(signInWithFeedback()).resolves.toBe(false);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('cancelSignIn calls the main process', async () => {
    const { calls } = installBridge(async () => ({ ok: true, data: authState('signed_out') }));
    await cancelSignIn();
    expect(calls).toEqual([['auth', 'cancelSignIn']]);
  });
});

describe('pending browser sign-in (foundation-40)', () => {
  const enabledButtons = (html: string) => (html.match(/<button[^>]*>/g) ?? []).filter((tag) => !DISABLED_ATTR.test(tag)).length;

  it('offers enabled "open again" and "cancel" actions', () => {
    const html = renderToStaticMarkup(<SignInPendingActions />);
    expect(html).toContain('Open sign-in page again');
    expect(html).toContain('Cancel');
    expect(html).not.toMatch(DISABLED_ATTR);
    expect(enabledButtons(html)).toBe(2);
  });

  it('replaces the disabled top-bar button while signing in', () => {
    const html = renderWith(<TopBar />, (c) => c.setQueryData(qk.auth, authState('signing_in')), { page: 'create' });
    expect(html).toContain('<h2 class="truncate text-[13px] font-semibold">Create</h2>');
    expect(html).toContain('Open again');
    expect(html).toContain('Cancel');
    expect(html).not.toMatch(DISABLED_ATTR);
  });

  it('replaces the disabled RequireAuth button while signing in', () => {
    const html = renderWith(<RequireAuth reason="Create needs your GMI account.">secret</RequireAuth>, (c) => c.setQueryData(qk.auth, authState('signing_in')));
    expect(html).not.toContain('secret');
    expect(html).toContain('Open sign-in page again');
    expect(html).not.toMatch(DISABLED_ATTR);
    // Dino's plates are the working signal: no spinner in the pending row, the text stays.
    expect(html).toContain('Waiting for the browser sign-in');
    expect(html).not.toContain('animate-spin');
  });

  it('the top bar leaves "Open again / Cancel" to a page that already shows them, and uses plates, not a spinner', () => {
    const seed = (c: QueryClient) => c.setQueryData(qk.auth, authState('signing_in'));
    const alone = renderWith(<TopBar />, seed, { page: 'usage' });
    expect(alone).toContain('Open again');
    expect(alone).toContain('dino-plate-fade');
    expect(alone).not.toContain('animate-spin');
    const withGate = renderWith(<TopBar />, seed, { page: 'usage', pendingSignInRows: 1 });
    expect(withGate).not.toContain('Open again');
    expect(withGate).not.toContain('Waiting for browser');
  });

  it('the "Updating models" chip says working with plates', () => {
    const html = renderWith(<TopBar />, (c) => {
      c.setQueryData(qk.auth, authState('signed_out'));
      c.setQueryData(qk.catalog, { models: [], refreshing: true });
    }, { page: 'models' });
    expect(html).toMatch(/role="status"[^>]*>(?:(?!<\/span><\/span>).)*dino-plate-fade/);
    expect(html).toContain('Updating models');
    expect(html).not.toContain('animate-pulse');
  });

  it('in-page pending rows count themselves while mounted; the top bar copy does not', () => {
    const { registerPendingSignInRow } = useUi.getState();
    const before = useUi.getState().pendingSignInRows;
    const a = registerPendingSignInRow();
    const b = registerPendingSignInRow();
    expect(useUi.getState().pendingSignInRows).toBe(before + 2);
    a();
    a(); // idempotent
    expect(useUi.getState().pendingSignInRows).toBe(before + 1);
    b();
    expect(useUi.getState().pendingSignInRows).toBe(before);
  });

  it('shows a plain enabled sign-in button when signed out', () => {
    const html = renderWith(<TopBar />, (c) => c.setQueryData(qk.auth, authState('signed_out')), { page: 'models' });
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Waiting for browser');
    expect(html).not.toMatch(DISABLED_ATTR);
  });
});

describe('one sign-in CTA per screen', () => {
  const topBarSignIn = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*Sign in(?: again)?<\/button>/.test(html);

  it.each(['signed_out', 'reauth_required'] as const)('the top bar leaves "Sign in" to a page that shows its own (%s)', (status) => {
    const seed = (c: QueryClient) => c.setQueryData(qk.auth, authState(status));
    for (const page of ['models', 'usage', 'create', 'docs'] as const) {
      expect(topBarSignIn(renderWith(<TopBar />, seed, { page })), page).toBe(true);
      expect(topBarSignIn(renderWith(<TopBar />, seed, { page, signInCtas: 1 })), page).toBe(false);
    }
  });

  it('a page CTA does not hide the pending-sign-in cluster (that has its own counter)', () => {
    const html = renderWith(<TopBar />, (c) => c.setQueryData(qk.auth, authState('signing_in')), { page: 'usage', signInCtas: 1 });
    expect(html).toContain('Open again');
  });

  it('in-page sign-in CTAs count themselves while mounted (idempotent uncount)', () => {
    const { registerSignInCta } = useUi.getState();
    const before = useUi.getState().signInCtas;
    const a = registerSignInCta();
    const b = registerSignInCta();
    expect(useUi.getState().signInCtas).toBe(before + 2);
    a();
    a(); // idempotent
    expect(useUi.getState().signInCtas).toBe(before + 1);
    b();
    expect(useUi.getState().signInCtas).toBe(before);
    expect(useUi.getState().pendingSignInRows).toBe(0);
  });
});

describe('top-bar balance (foundation-22)', () => {
  it('polls and keeps the default retry policy', () => {
    const opts = balanceQueryOptions();
    expect(opts.queryKey).toEqual(qk.accountSummary(1));
    expect(opts.refetchInterval).toBe(BALANCE_REFRESH_MS);
    expect(BALANCE_REFRESH_MS).toBeLessThanOrEqual(5 * 60_000);
    expect('retry' in opts).toBe(false);
  });

  it('one burst of spend events refetches the account summary once', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let balance = 10;
    const queryFn = vi.fn(async () => ({ balanceUsd: balance }));
    const observer = new QueryObserver(client, { queryKey: qk.accountSummary(1), queryFn, staleTime: 5 * 60_000 });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    balance = 7.5;
    const refresh = debouncedInvalidation(client, qk.accountSummaryAll, 20);
    refresh.schedule();
    refresh.schedule();
    refresh.schedule();
    await vi.waitFor(() => expect(client.getQueryData(qk.accountSummary(1))).toEqual({ balanceUsd: 7.5 }));
    await new Promise((r) => setTimeout(r, 40));
    expect(queryFn).toHaveBeenCalledTimes(2);
    refresh.schedule();
    refresh.cancel();
    await new Promise((r) => setTimeout(r, 40));
    expect(queryFn).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe('sidebar navigation semantics (foundation-56)', () => {
  const seed = (collapsed: boolean) => (c: QueryClient) => {
    c.setQueryData<AppSettings>(qk.settings, { ...DEFAULT_SETTINGS, sidebarCollapsed: collapsed });
    c.setQueryData(qk.auth, authState('signed_in'));
  };
  const current = (html: string) => html.match(/<button[^>]*aria-current="page"[^>]*>/g) ?? [];

  it.each([false, true])('marks exactly the open page as current (collapsed: %s)', (collapsed) => {
    let html = renderWith(<Sidebar />, seed(collapsed), { page: 'models' });
    expect(current(html)).toHaveLength(1);
    if (collapsed) expect(current(html)[0]).toContain('aria-label="Models"');
    else expect(html).toMatch(/<button[^>]*aria-current="page"[^>]*>(?:(?!<\/button>).)*Models<\/span>/);

    html = renderWith(<Sidebar />, seed(collapsed), { page: 'settings' });
    expect(current(html)).toHaveLength(1);
    if (collapsed) expect(current(html)[0]).toContain('aria-label="Settings"');
    else expect(html).toMatch(/<button[^>]*aria-current="page"[^>]*>(?:(?!<\/button>).)*Signed in/);
  });
});

describe('sidebar account footer', () => {
  const seed = (auth: AuthState) => (c: QueryClient) => {
    c.setQueryData<AppSettings>(qk.settings, DEFAULT_SETTINGS);
    c.setQueryData(qk.auth, auth);
  };
  const noKey = { ...KEY, status: 'missing', source: null, last4: null } as const;

  it('says chat runs on the GMI sign-in instead of "No API key" when it does', () => {
    const viaSignIn: AuthState = { ...authState('signed_in'), inferenceKey: { ...noKey }, inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } };
    expect(renderWith(<Sidebar />, seed(viaSignIn))).toContain('Chat via GMI sign-in');
    const missing: AuthState = { ...authState('signed_in'), inferenceKey: { ...noKey }, inference: { via: null, oauthProbe: 'unsupported', oauthProbeAt: null } };
    expect(renderWith(<Sidebar />, seed(missing))).toContain('No API key');
    expect(renderWith(<Sidebar />, seed(authState('signed_in')))).toContain('API key ••abcd');
  });
});

describe('badge text contrast (foundation-54)', () => {
  it('warning and success badges use the AA text tokens', () => {
    expect(badgeVariants({ variant: 'warning' })).toContain('text-warning-foreground');
    expect(badgeVariants({ variant: 'success' })).toContain('text-success-foreground');
  });
});
