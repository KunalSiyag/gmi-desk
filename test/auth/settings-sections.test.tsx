// Settings › Account and API key cards: status line, separated destructive rows, OAuth probe status.
// Rendered with react-dom/server (node environment, no DOM): effects do not run.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, InferenceKeyInfo } from '@shared/contracts/auth';
import type { GmiBridge } from '@shared/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import type { AppInfo } from '@shared/contracts/app';
import { qk } from '@renderer/lib/query';
import SettingsPage from '@renderer/pages/settings';
import { AccountSection } from '@renderer/pages/settings/AccountSection';
import { KeySection } from '@renderer/pages/settings/KeySection';
import { AboutSection, SecuritySection } from '@renderer/pages/settings/PreferenceSections';

const NO_KEY: InferenceKeyInfo = { status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
const VALID_KEY: InferenceKeyInfo = { ...NO_KEY, status: 'valid', source: 'keychain', last4: 'abcd', scope: 'ie_model', validatedAt: '2026-11-01T10:00:00.000Z' };

function auth(patch: Partial<AuthState> = {}): AuthState {
  return {
    status: 'signed_in',
    scopes: ['models:read', 'generation:read', 'generation:write', 'billing:read', 'profile:read', 'support:write'],
    orgId: '00000000-0000-0000-0000-000000000000',
    signedInAt: '2026-11-01T07:08:00.000Z',
    accessTokenExpiresAt: null,
    inferenceKey: { ...NO_KEY },
    secureStorage: 'os',
    lastError: null,
    mock: false,
    inference: { via: null, oauthProbe: 'unsupported', oauthProbeAt: '2026-11-01T09:00:00.000Z' },
    ...patch,
  };
}

function render(node: ReactNode, state: AuthState, info?: AppInfo): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.auth, state);
  if (info) client.setQueryData(qk.appInfo, info);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/\s+/g, ' ');
/** The opening `<tag …>` of the nearest `tag` element that starts before `label` (a badge, a button). */
const tagOf = (html: string, label: string, tag = 'span') => {
  const at = html.indexOf(label);
  if (at < 0) return '';
  const start = html.lastIndexOf(`<${tag}`, at);
  return html.slice(start, html.indexOf('>', start) + 1);
};
/** Brand-positive states are lime (Badge variant="primary"), never the mint success token. */
const PRIMARY_BADGE = 'bg-primary/15 text-primary-ink';

beforeEach(() => {
  const bridge: GmiBridge = { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' };
  (globalThis as { window?: unknown }).window = { gmi: bridge };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('Settings › Account', () => {
  it('signed in: brand-tinted chip, permission count, and sign-out in its own row at the end', () => {
    const html = render(<AccountSection state={auth()} />, auth());
    const visible = text(html);
    expect(html).toContain('bg-primary/15 text-primary-ink');
    expect(visible).toMatch(/6 \/ 6 granted/);
    expect(visible).toContain('Forgets this computer’s GMI sign-in');
    // Sign out comes after the permissions, never next to the status line.
    expect(visible.indexOf('Sign out')).toBeGreaterThan(visible.indexOf('Permissions'));
    expect(html).toContain('text-destructive');
  });

  it('"Signed in" is a lime brand badge; demo mode is not flagged again on the card', () => {
    const state = auth({ mock: true });
    const html = render(<AccountSection state={state} />, state);
    expect(tagOf(html, 'Signed in')).toContain(PRIMARY_BADGE);
    expect(html).not.toMatch(/success/);
    expect(text(html)).not.toContain('Demo data');
  });

  it('waiting for the browser: plates in the chip (no spinner), re-open outlined and cancel quiet', () => {
    const state = auth({ status: 'signing_in', scopes: [], signedInAt: null, orgId: null });
    const html = render(<AccountSection state={state} />, state);
    expect(html).toContain('data-plates');
    expect(html).not.toContain('animate-spin');
    expect(text(html)).toContain('Waiting for you in the browser');
    expect(tagOf(html, 'Open again', 'button')).toContain('border-input');
    expect(tagOf(html, 'Cancel', 'button')).not.toContain('border-input');
  });

  it('signed out: offers sign-in in the status line and no sign-out row', () => {
    const state = auth({ status: 'signed_out', scopes: [], signedInAt: null, orgId: null });
    const visible = text(render(<AccountSection state={state} />, state));
    expect(visible).toContain('Sign in with GMI');
    expect(visible).toContain('GMI will ask you to allow');
    expect(visible).not.toContain('Sign out');
  });
});

describe('Settings › API key', () => {
  it('a saved key: re-verify in the status line, removal separated at the end of the card', () => {
    const state = auth({ inferenceKey: VALID_KEY });
    const visible = text(render(<KeySection state={state} focusInput={0} />, state));
    expect(visible).toContain('•••• •••• abcd');
    expect(visible).toContain('Re-verify');
    expect(visible).toContain('Remove key');
    expect(visible.lastIndexOf('Remove key')).toBeGreaterThan(visible.indexOf('Chat with your GMI sign-in'));
  });

  it('a GMI_API_KEY from the environment cannot be removed here', () => {
    const state = auth({ inferenceKey: { ...VALID_KEY, source: 'env', status: 'unverified' } });
    const visible = text(render(<KeySection state={state} focusInput={0} />, state));
    expect(visible).toContain('GMI_API_KEY');
    expect(visible).not.toContain('Remove key');
  });

  it('shows whether GMI accepts the sign-in for chat ("Available" / "Not yet") with a Check now button', () => {
    const notYet = text(render(<KeySection state={auth()} focusInput={0} />, auth()));
    expect(notYet).toContain('Not yet');
    expect(notYet).toContain('Check now');
    const supported = auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: '2026-11-01T09:00:00.000Z' } });
    const visible = text(render(<KeySection state={supported} focusInput={0} />, supported));
    expect(visible).toContain('Available');
    expect(visible).toContain('Using your GMI sign-in');
  });

  it('a valid key and its organization match are lime brand badges (no mint success)', () => {
    const state = auth({ inferenceKey: { ...VALID_KEY, orgId: '00000000-0000-0000-0000-000000000000', orgMatchesAccount: true } });
    const html = render(<KeySection state={state} focusInput={0} />, state);
    expect(tagOf(html, 'Valid')).toContain(PRIMARY_BADGE);
    expect(tagOf(html, 'Matches your sign-in')).toContain(PRIMARY_BADGE);
    expect(html).not.toMatch(/success/);
  });

  it('chat through the sign-in: "No key needed" and "Available" are lime brand badges', () => {
    const state = auth({ inference: { via: 'oauth', oauthProbe: 'supported', oauthProbeAt: '2026-11-01T09:00:00.000Z' } });
    const html = render(<KeySection state={state} focusInput={0} />, state);
    expect(tagOf(html, 'No key needed')).toContain(PRIMARY_BADGE);
    expect(tagOf(html, 'Available')).toContain(PRIMARY_BADGE);
    expect(html).not.toMatch(/success/);
  });

  it('the empty key form stays quiet (outline) next to the lime Connect chat button', () => {
    const html = render(<KeySection state={auth()} focusInput={0} />, auth());
    const save = html.slice(html.indexOf('<button type="submit"'), html.indexOf('Save &amp; verify'));
    expect(save).toContain('disabled=""');
    expect(save).not.toContain('text-primary-foreground');
    expect(text(html)).toContain('Connect chat');
  });
});


describe('Settings › Security and About', () => {
  const INFO: AppInfo = {
    name: 'GMI Desk',
    version: '0.1.0',
    electron: '45.2.1',
    chrome: '156.0.0.0',
    node: '24.22.1',
    platform: 'linux',
    arch: 'x64',
    mock: true,
    userDataDir: '/tmp/gmi-desk-test',
    mediaDir: '/tmp/gmi-desk-test/media',
    secureStorage: 'os',
  };

  it('the OS keychain is a lime brand badge', () => {
    const html = render(<SecuritySection state={auth()} />, auth());
    expect(tagOf(html, 'OS keychain')).toContain(PRIMARY_BADGE);
    expect(html).not.toMatch(/success/);
  });

  it('About names demo mode with a neutral micro tag, not a lime badge', () => {
    const html = render(<AboutSection />, auth(), INFO);
    const tag = tagOf(html, 'Demo data');
    expect(tag).toContain('font-mono');
    expect(tag).toContain('ring-border');
    expect(tag).not.toContain('primary');
  });
});

describe('Settings page', () => {
  it('section nav marks the current section with the edge bar and ink icon, no fill slab', () => {
    const html = render(<SettingsPage />, auth());
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
    const current = nav.slice(nav.indexOf('aria-current="location"'), nav.indexOf('</button>', nav.indexOf('aria-current="location"')));
    expect(current).toContain('data-active-bar="edge"');
    expect(current).toContain('text-primary-ink');
    expect(nav).not.toContain('bg-accent/50');
    expect(nav.match(/data-active-bar/g)).toHaveLength(1);
  });

  it('the title is a hidden h1 (the top bar shows it); the description stays visible', () => {
    const html = render(<SettingsPage />, auth());
    expect(html).toContain('<h1 class="sr-only">Settings</h1>');
    expect(text(html)).toContain('Your GMI account, API key and preferences.');
    expect(html).not.toContain('text-lg');
  });
});
