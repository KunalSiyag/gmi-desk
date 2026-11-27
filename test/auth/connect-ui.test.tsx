// Connect chat (renderer): what the dialog shows in each state, the entry points that open it, and the UI store
// flag. Rendered with react-dom/server (node environment, no DOM): effects do not run.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, InferenceKeyInfo } from '@shared/contracts/auth';
import { ERROR_HINTS, GmiError, type GmiBridge } from '@shared/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import { chatAccess, chatViaSignIn, CONNECT_COPY, connectView, detectStage, foundKeyLabel, savedKeyNote } from '@renderer/components/connect/access';
import { CONNECT_SUCCESS_CLOSE_MS, ConnectChatBody } from '@renderer/components/connect/ConnectChatDialog';
import { DINO_GLOW, EnterKbd, GridGlow, ListeningDot, StepMarker, SuccessMark } from '@renderer/components/connect/parts';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { RequireInferenceKey } from '@renderer/components/RequireAuth';
import { actionValue, PALETTE_ACTIONS, paletteFilter } from '@renderer/components/shell/palette-items';
import { TopBar } from '@renderer/components/shell/TopBar';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { oauthProbeLabel } from '@renderer/pages/settings/copy';
import { KeySection } from '@renderer/pages/settings/KeySection';
import WelcomePage from '@renderer/pages/welcome';

function installBridge(): void {
  const bridge: GmiBridge = { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' };
  (globalThis as { window?: unknown }).window = { gmi: bridge };
}

const NO_KEY: InferenceKeyInfo = { status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
const VALID_KEY: InferenceKeyInfo = { ...NO_KEY, status: 'valid', source: 'keychain', last4: 'abcd', scope: 'ie_model', validatedAt: '2026-11-01T10:00:00.000Z' };

function auth(patch: Partial<AuthState> = {}): AuthState {
  return {
    status: 'signed_in',
    scopes: [],
    orgId: '00000000-0000-0000-0000-000000000000',
    signedInAt: '2026-11-01T07:08:00.000Z',
    accessTokenExpiresAt: null,
    inferenceKey: { ...NO_KEY },
    secureStorage: 'os',
    lastError: null,
    mock: false,
    inference: { via: null, oauthProbe: 'unsupported', oauthProbeAt: '2026-11-01T09:00:00.000Z' },
    keyDetection: { active: true, candidate: null },
    ...patch,
  };
}

/** Server rendering reads zustand's initial state, so UI state for one render is applied there and restored. */
function render(node: ReactNode, state: AuthState | null, ui: Partial<ReturnType<typeof useUi.getState>> = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (state) client.setQueryData(qk.auth, state);
  const initial = useUi.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, ui);
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  } finally {
    Object.assign(initial, saved);
  }
}

const body = (state: AuthState) => render(<ConnectChatBody open state={state} onClose={() => undefined} />, state);
/** Visible text only (tags stripped, entities decoded enough for these checks). */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/**
 * Class tokens that put lime (the --color-primary fill) into a glow, halo or gradient on the light theme: lime on
 * white reads as a yellow haze, so those belong behind `dark:` (the light theme uses the olive --color-primary-ink).
 */
const limeGlowsOnLight = (html: string) =>
  (html.match(/class="[^"]*"/g) ?? [])
    .flatMap((attr) => attr.slice(7, -1).split(/\s+/))
    .filter((token) => /(?:shadow|bg)-\[[^\]]*var\(--color-primary\)/.test(token) && !token.startsWith('dark:'));

beforeEach(installBridge);
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  useUi.setState({ page: 'chat', params: {}, paletteOpen: false, connectOpen: false });
});

describe('chat access', () => {
  it('is ready with a usable key, or with no key while GMI accepts the sign-in', () => {
    expect(chatAccess(undefined)).toBe('ready'); // still loading: no nagging
    expect(chatAccess(auth())).toBe('missing');
    expect(chatAccess(auth({ inferenceKey: VALID_KEY }))).toBe('ready');
    expect(chatAccess(auth({ inferenceKey: { ...VALID_KEY, status: 'unverified' } }))).toBe('ready');
    expect(chatAccess(auth({ inferenceKey: { ...VALID_KEY, status: 'invalid' } }))).toBe('invalid');
    expect(chatAccess(auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } }))).toBe('ready');
    // Older main process without `inference`: only the key counts.
    expect(chatAccess({ ...auth(), inference: undefined })).toBe('missing');
    expect(chatViaSignIn(auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } }))).toBe(true);
    expect(chatViaSignIn(auth({ inferenceKey: VALID_KEY, inference: { via: 'api_key', oauthProbe: 'supported', oauthProbeAt: null } }))).toBe(false);
  });

  it('picks the dialog view and the detection stage', () => {
    expect(connectView(auth(), false)).toBe('steps');
    expect(connectView(auth({ inferenceKey: VALID_KEY }), false)).toBe('connected');
    expect(connectView(auth({ inferenceKey: VALID_KEY }), true)).toBe('steps');
    expect(connectView(auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } }), false)).toBe('oauth');
    expect(detectStage(auth(), false)).toBe('listening');
    expect(detectStage(auth({ keyDetection: { active: false, candidate: null } }), false)).toBe('stopped');
    expect(detectStage(auth({ keyDetection: undefined }), false)).toBe('listening');
    const found = auth({ keyDetection: { active: true, candidate: { last4: 'Q7fA', detectedAt: '2026-11-01T10:00:00.000Z' } } });
    expect(detectStage(found, false)).toBe('found');
    expect(detectStage(found, true)).toBe('verifying');
  });

  it('says where the key went and whether the clipboard was cleared', () => {
    expect(foundKeyLabel('Q7fA')).toBe('Found a key ending ••Q7fA');
    // Honest about clipboard history (GNOME/KDE managers, Windows Win+V keep copies the app cannot clear).
    expect(savedKeyNote('Q7fA', true, 'os')).toBe('Key ••Q7fA is saved in your OS keychain. We cleared it from your clipboard (clipboard history apps may keep a copy).');
    expect(savedKeyNote('Q7fA', false, 'unavailable')).toBe('Key ••Q7fA is saved in memory until you quit.');
    expect(oauthProbeLabel('supported')).toBe('Available');
    expect(oauthProbeLabel('unsupported')).toBe('Not yet');
  });
});

describe('Connect chat dialog body', () => {
  it('no key: three steps, listening quietly, the paste fallback and the footnotes', () => {
    const html = text(body(auth()));
    expect(html).toContain('Signed in to GMI');
    expect(html).toContain('Create a key in GMI Console');
    expect(html).toContain('Open GMI Console');
    expect(html).toContain('Create API key');
    expect(html).toContain('name it “GMI Desk”');
    expect(html).toContain('Come back here — we’ll pick it up');
    expect(html).toContain(CONNECT_COPY.listening);
    expect(html).toContain('Watching your clipboard while this dialog is open'); // the dialog, not the app window
    expect(html).toContain('Paste it instead');
    expect(html).toContain('GMI’s sign-in doesn’t cover chat yet. Once it does, GMI Desk switches over by itself.');
    expect(html).toContain('On a Coding Plan? Use your plan’s key.');
    expect(html).toContain('Check again');
    expect(html).not.toContain('Use this key');
  });

  it('words the user knows: "API key" as in GMI Console, no "inference key" or "GMI Router" jargon up front', () => {
    expect(CONNECT_COPY.description).toBe('Chat needs an API key from GMI Console. It takes about 30 seconds.');
    expect(CONNECT_COPY.description).not.toMatch(/inference|Router/);
    expect(text(body(auth()))).not.toMatch(/inference key|this step disappears/);
  });

  it('the next action has focus on open (marked for the dialog’s initialFocus), never the close button', () => {
    const autofocus = (html: string) => html.match(/<button[^>]*data-autofocus[^>]*>(?:(?!<\/button>).)*<\/button>/g) ?? [];
    const steps = autofocus(body(auth()));
    expect(steps).toHaveLength(1);
    expect(text(steps[0]!)).toContain('Open GMI Console');
    const found = autofocus(body(auth({ keyDetection: { active: true, candidate: { last4: 'Q7fA', detectedAt: '2026-11-01T10:00:00.000Z' } } })));
    expect(found).toHaveLength(1);
    expect(text(found[0]!)).toContain('Use this key');
    const oauth = autofocus(body(auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } })));
    expect(text(oauth[0]!)).toContain('Start chatting');
    const connected = autofocus(body(auth({ inferenceKey: VALID_KEY })));
    expect(text(connected[0]!)).toContain('Done');
  });

  it('gives the success line time to be read before closing by itself', () => {
    expect(CONNECT_SUCCESS_CLOSE_MS).toBeGreaterThanOrEqual(2_400);
  });

  it('a found key: "Found a key ending ••Q7fA" with [Not this one] [Use this key]; step 2 is done, step 3 asks to confirm', () => {
    const html = body(auth({ keyDetection: { active: true, candidate: { last4: 'Q7fA', detectedAt: '2026-11-01T10:00:00.000Z' } } }));
    expect(text(html)).toContain('Found a key ending ••Q7fA');
    expect(text(html)).toContain('Confirm the key');
    expect(text(html)).not.toContain('we’ll pick it up');
    expect(text(html)).toContain('Use this key');
    expect(text(html)).toContain('Not this one');
    expect(text(html)).not.toContain('Open GMI Console');
    expect(text(html)).not.toContain(CONNECT_COPY.listening);
    expect(html).toContain('aria-current="step"');
  });

  it('after 10 minutes: offers to watch again', () => {
    const html = text(body(auth({ keyDetection: { active: false, candidate: null } })));
    expect(html).toContain(CONNECT_COPY.stopped);
    expect(html).toContain('Watch again');
  });

  it('signed out: step 1 offers an optional sign-in (the key steps still work) and there is no probe link', () => {
    const markup = body(auth({ status: 'signed_out', orgId: null, inference: { via: null, oauthProbe: 'unknown', oauthProbeAt: null } }));
    const html = text(markup);
    expect(html).toContain('Sign in to GMI (optional)');
    expect(html).toContain('Sign in');
    expect(html).toContain('Open GMI Console');
    expect(html).not.toContain('Check again');
    // One active step (create a key), so the eye has one place to start.
    const current = markup.match(/<li[^>]*aria-current="step"[^>]*>/g) ?? [];
    expect(current).toHaveLength(1);
    expect(markup).toMatch(/<li[^>]*aria-current="step"[^>]*>(?:(?!<\/li>).)*Create a key in GMI Console/);
  });

  it('step markers fill with the dialog surface (no black discs in dark mode)', () => {
    for (const status of ['active', 'todo'] as const) {
      const html = renderToStaticMarkup(<StepMarker n={2} status={status} />);
      expect(html).toContain('bg-popover');
      expect(html).not.toContain('bg-background');
    }
  });

  it('step markers: done is a brand-positive tint with a check (no lime fill), the active one a lime/olive ring, numbers in mono', () => {
    const done = renderToStaticMarkup(<StepMarker n={1} status="done" />);
    // Same tint as Badge variant="primary": the solid lime fill is left to the one call to action.
    expect(done).toContain('bg-primary/15');
    expect(done).toContain('dark:bg-primary/12');
    expect(done).toContain('text-primary-ink');
    expect(done).toContain('border-primary-ink/30');
    expect(done).not.toMatch(/(?:^|[\s"])bg-primary(?=[\s"])/);
    expect(done).not.toContain('text-primary-foreground');
    expect(done).toContain('<svg');
    const active = renderToStaticMarkup(<StepMarker n={2} status="active" />);
    expect(active).toContain('border-primary-ink');
    expect(active).toContain('text-primary-ink');
    expect(active).toContain('font-mono');
    expect(text(active)).toContain('2');
  });

  it('the ↵ hint on lime buttons is black on lime (never white on lime)', () => {
    const kbd = renderToStaticMarkup(<EnterKbd />);
    expect(kbd).toContain('text-primary-foreground');
    expect(kbd).not.toMatch(/(?:bg|border|text)-white/);
    const found = body(auth({ keyDetection: { active: true, candidate: { last4: 'Q7fA', detectedAt: '2026-11-01T10:00:00.000Z' } } }));
    expect(found).not.toMatch(/(?:bg|border)-white\//);
  });

  it('the success moment is a happy Dino with a check drawn once', () => {
    const html = renderToStaticMarkup(<SuccessMark />);
    expect(html).toContain('data-mood="happy"');
    expect(html).toContain('stroke-dashoffset');
    expect(html).toContain('aria-hidden="true"');
  });

  it('the success mark moves within 250 ms per transition (the check keeps its delay after the hop)', () => {
    const html = renderToStaticMarkup(<SuccessMark />);
    expect(html).toContain('delay-[320ms] duration-250');
    const durations = [...html.matchAll(/duration-(?:\[(\d+)ms\]|(\d+))/g)].map((m) => Number(m[1] ?? m[2]));
    expect(durations.length).toBeGreaterThan(0);
    for (const ms of durations) expect(ms).toBeLessThanOrEqual(250);
  });

  it('GMI accepts the sign-in: a happy Dino says so', () => {
    const html = body(auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } }));
    expect(html).toContain('data-mood="happy"');
    expect(text(html)).toContain('Connected');
  });

  it('a rejected key: says so above the steps', () => {
    const html = text(body(auth({ inferenceKey: { ...VALID_KEY, status: 'invalid', error: 'Expired API key.' } })));
    expect(html).toContain('GMI rejected your current key ••abcd');
    expect(html).toContain('Open GMI Console');
  });

  it('GMI accepts the sign-in: no key needed, no steps, no clipboard watching', () => {
    const html = text(body(auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null }, keyDetection: { active: false, candidate: null } })));
    expect(html).toContain(CONNECT_COPY.oauthTitle);
    expect(html).toContain('Start chatting');
    expect(html).not.toContain('Open GMI Console');
    expect(html).not.toContain(CONNECT_COPY.listening);
  });

  it('a key already saved: shows it and offers a different one', () => {
    const html = text(body(auth({ inferenceKey: VALID_KEY })));
    expect(html).toContain('•••• abcd');
    expect(html).toContain('Use a different key');
    expect(html).not.toContain('Open GMI Console');
  });

  it('the raw key is nowhere in the markup (the renderer only has last4)', () => {
    const html = body(auth({ keyDetection: { active: true, candidate: { last4: 'Q7fA', detectedAt: '2026-11-01T10:00:00.000Z' } } }));
    expect(html).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
  });
});

describe('GMI look (one accent green, olive on light, the kit pieces)', () => {
  const found = () => auth({ keyDetection: { active: true, candidate: { last4: 'Q7fA', detectedAt: '2026-11-01T10:00:00.000Z' } } });
  const viaSignIn = () => auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } });

  it('the light behind Dino is lime on dark only (a faint olive tint on light)', () => {
    expect(limeGlowsOnLight(`<i class="${DINO_GLOW}"></i>`)).toEqual([]);
    expect(DINO_GLOW).toContain('dark:bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--color-primary)_');
    expect(DINO_GLOW).toMatch(/^bg-\[radial-gradient\(closest-side,color-mix\(in_oklch,var\(--color-primary-ink\)_6%,/);
    for (const html of [
      renderToStaticMarkup(<SuccessMark />),
      renderToStaticMarkup(<GridGlow />),
      renderToStaticMarkup(<StepMarker n={2} status="active" />),
      renderToStaticMarkup(<ListeningDot />),
      body(auth()),
      body(found()),
      body(viaSignIn()),
    ]) {
      expect(limeGlowsOnLight(html)).toEqual([]);
    }
  });

  it('the listening halo and the active step halo are olive on light, lime on dark', () => {
    expect(renderToStaticMarkup(<ListeningDot />)).toMatch(/bg-primary-ink\/\d+ [^"]*dark:bg-primary\/30/);
    const active = renderToStaticMarkup(<StepMarker n={2} status="active" />);
    expect(active).toContain('shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-primary-ink)_12%,transparent)]');
    expect(active).toContain('dark:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-primary)_22%,transparent)]');
  });

  it('the grid floor behind Dino is the kit utility (20 px cells), no inline grid styles', () => {
    const html = renderToStaticMarkup(<GridGlow />);
    expect(html).toContain('grid-floor');
    expect(html).toContain('[--grid-cell:20px]');
    expect(html).not.toContain('style=');
  });

  it('a valid key is brand-positive: the lime/olive "primary" badge, not the mint success one', () => {
    const html = body(auth({ inferenceKey: VALID_KEY }));
    const valid = html.match(/<span[^>]*>Valid<\/span>/)?.[0] ?? '';
    expect(valid).toContain('text-primary-ink');
    expect(valid).not.toContain('success');
    expect(html).not.toMatch(/(?:text|bg|ring|border)-success/);
  });

  it('"Connected" is the kit micro-label with the brand dot (0.16em tracking, never a local 0.18em copy)', () => {
    const oauth = body(viaSignIn());
    expect(oauth).not.toContain('tracking-[0.18em]');
    expect(oauth).toMatch(/<span class="[^"]*tracking-\[0\.16em\][^"]*"><span aria-hidden="true" class="size-1\.5 shrink-0 bg-primary-ink"><\/span><span[^>]*>Connected<\/span>/);
  });

  it('waiting for the browser says so with Dino’s plates, not a spinner (spinners are for pending buttons)', () => {
    const signingIn = body(auth({ status: 'signing_in', orgId: null, inference: { via: null, oauthProbe: 'unknown', oauthProbeAt: null } }));
    const row = signingIn.match(/<span[^>]*role="status"[^>]*>(?:(?!<\/span>Waiting).)*<\/span>(?:(?!<\/span>).)*Waiting for the browser…/)?.[0] ?? '';
    expect(row).toContain('data-plates');
    expect(signingIn).not.toContain('animate-spin');
  });
});

describe('entry points open the dialog instead of Settings', () => {
  it('top bar: "Connect chat" without a key, "Fix API key" for a rejected one, nothing when chat works', () => {
    expect(text(render(<TopBar />, auth(), { page: 'models' }))).toContain('Connect chat');
    // Chat's composer already offers it in context: no second "Connect chat" competing at the top.
    expect(text(render(<TopBar />, auth(), { page: 'chat' }))).not.toContain('Connect chat');
    expect(text(render(<TopBar />, auth({ inferenceKey: { ...VALID_KEY, status: 'invalid' } }), { page: 'chat' }))).not.toContain('Fix API key');
    expect(text(render(<TopBar />, auth({ inferenceKey: { ...VALID_KEY, status: 'invalid' } }), { page: 'models' }))).toContain('Fix API key');
    expect(text(render(<TopBar />, auth({ inferenceKey: VALID_KEY }), { page: 'models' }))).not.toContain('Connect chat');
    const viaSignIn = auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } });
    expect(text(render(<TopBar />, viaSignIn, { page: 'models' }))).not.toContain('Connect chat');
  });

  it('RequireInferenceKey lets chat-only content through on the GMI sign-in and offers "Connect chat" otherwise', () => {
    const viaSignIn = auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: null } });
    expect(render(<RequireInferenceKey reason="r">inner-content</RequireInferenceKey>, viaSignIn)).toContain('inner-content');
    const missing = text(render(<RequireInferenceKey reason="r">inner-content</RequireInferenceKey>, auth()));
    expect(missing).not.toContain('inner-content');
    expect(missing).toContain('Connect chat');
  });

  it('ErrorNotice offers "Connect chat" for no_api_key and "Replace API key" for invalid_api_key', () => {
    expect(text(render(<ErrorNotice error={new GmiError('no_api_key', 'x')} />, auth()))).toContain('Connect chat');
    expect(text(render(<ErrorNotice error={new GmiError('invalid_api_key', 'x')} />, auth()))).toContain('Replace API key');
  });

  it('key error hints point at the Connect chat button next to them, not at Settings', () => {
    expect(ERROR_HINTS.no_api_key).toBe('Chat needs a GMI API key. Connect chat to add one (about 30 seconds).');
    expect(ERROR_HINTS.invalid_api_key).toBe('GMI rejected your API key. Connect a new one.');
    for (const hint of [ERROR_HINTS.no_api_key, ERROR_HINTS.invalid_api_key]) expect(hint).not.toContain('Settings');
  });

  it('Settings names the action the same as everywhere else ("Connect chat", not "Connect automatically")', () => {
    const missing = text(render(<KeySection state={auth()} focusInput={0} />, auth()));
    expect(missing).toContain('Connect chat');
    expect(missing).not.toContain('Connect automatically');
    const rejected = auth({ inferenceKey: { ...VALID_KEY, status: 'invalid', error: 'Expired API key.' } });
    expect(text(render(<KeySection state={rejected} focusInput={0} />, rejected))).not.toContain('Connect automatically');
  });

  it('the palette has "Connect chat" (found by key words too)', () => {
    expect(PALETTE_ACTIONS.connectChat.label).toBe('Connect chat');
    expect(paletteFilter(actionValue('connectChat'), 'connect')).toBeGreaterThan(0);
    expect(paletteFilter(actionValue('connectChat'), 'api key')).toBeGreaterThan(0);
  });

  it('the store flag: openConnect (closing the palette), connect=1 on any navigation, other navigation closes it', () => {
    useUi.setState({ paletteOpen: true });
    useUi.getState().openConnect();
    expect(useUi.getState()).toMatchObject({ connectOpen: true, paletteOpen: false });
    useUi.getState().navigate('chat');
    expect(useUi.getState().connectOpen).toBe(false);
    useUi.getState().navigate('settings', { connect: '1' });
    expect(useUi.getState().connectOpen).toBe(true);
    useUi.getState().setConnectOpen(false);
    expect(useUi.getState().connectOpen).toBe(false);
  });
});

describe('welcome', () => {
  const welcome = (state: AuthState, params: Record<string, string> = {}) => render(<WelcomePage />, state, { page: 'welcome', params });
  const signedOut = () => auth({ status: 'signed_out', orgId: null, signedInAt: null, mock: true, inference: { via: null, oauthProbe: 'unknown', oauthProbeAt: null } });

  it('signed out: Dino (idle) as the hero, one lime "Sign in with GMI", a way to browse first, the four areas and the key footnote', () => {
    const html = welcome(signedOut());
    const visible = text(html);
    expect(html).toMatch(/<h1[^>]*>GMI Cloud, on your desktop<\/h1>/);
    expect(visible).toContain('Welcome to GMI Desk');
    expect(html).toContain('data-mood="idle"');
    expect(visible).toContain('Sign in with GMI');
    expect(visible).toContain('Browse models first');
    for (const area of ['Live model catalog', 'Chat + GMI Router', 'Images, video & audio', 'Usage & budgets']) expect(visible).toContain(area);
    expect(visible).toContain('Chat also needs an API key from GMI Console');
    expect(visible).toContain('never sees your password');
    expect(visible).toContain('Demo data'); // mock mode says so
    // Hidden content is only ever the boot hand-over, which needs a DOM splash: nothing is hidden here.
    expect(html).not.toContain('opacity-0');
  });

  it('the hero: the splash’s 40 px grid floor (kit utility, centred), a light behind Dino that is lime on dark only', () => {
    const html = welcome(signedOut());
    expect(html).toMatch(/class="[^"]*grid-floor [^"]*\[--grid-cell:40px\]/);
    expect(html).not.toContain('background-size');
    expect(html).toContain(DINO_GLOW);
    expect(limeGlowsOnLight(html)).toEqual([]);
    // Micro-labels come from the kit (one tracking everywhere).
    expect(html).not.toContain('tracking-[0.18em]');
    expect(html).toMatch(/tracking-\[0\.16em\][^"]*"><span aria-hidden="true" class="size-1\.5 shrink-0 bg-primary-ink"><\/span><span[^>]*>Welcome to GMI Desk<\/span>/);
  });

  it('while the browser is open: Dino works (loading) and Esc cancels', () => {
    const html = welcome({ ...signedOut(), status: 'signing_in' });
    expect(html).toContain('data-mood="loading"');
    expect(text(html)).toContain('Waiting for the browser…');
    // Dino's plates are the one "working" signal (no spinner in the status card).
    expect(html).toContain('data-plates');
    expect(html).not.toContain('animate-spin');
    expect(text(html)).toContain('Cancel Esc');
    expect(text(html)).not.toContain('Sign in with GMI');
  });

  it('just signed in, chat not connected: Dino is happy and "Connect chat" is the one primary action', () => {
    const html = welcome(auth({ mock: true }), { step: 'connect' });
    const visible = text(html);
    expect(html).toContain('data-mood="happy"');
    expect(visible).toContain('Signed in to GMI');
    expect(visible).toContain('Step 1 of 2');
    expect(visible).toContain('Connect chat');
    expect(visible).toContain('Later');
    expect(visible).not.toContain('Sign in with GMI');
    expect(visible).toContain('GMI’s sign-in doesn’t cover chat yet');
  });
});
