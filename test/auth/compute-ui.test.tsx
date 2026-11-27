// Connect Compute and Settings › Compute key (renderer, C1-A): what each dialog state and each key state shows.
// Rendered with react-dom/server (node environment, no DOM): effects do not run.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, ComputeKeyInfo, InferenceKeyInfo } from '@shared/contracts/auth';
import type { ComputeAccess } from '@shared/contracts/compute';
import { GmiError, type GmiBridge } from '@shared/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import {
  COMPUTE_COPY,
  computeConnectView,
  computeKeyLocked,
  computeKeySessionOnly,
  computeKeySubtitle,
  computeStorageNote,
  entitlementLabel,
  entitlementRows,
  INFERENCE_SCOPE_DETAIL,
  isInferenceKeyError,
  savedComputeKeyNote,
} from '@renderer/components/connect/compute-access';
import { AccessChips } from '@renderer/components/connect/compute-parts';
import {
  ComputeConnectedView,
  ComputeStepsView,
  ComputeSuccessView,
  ConnectComputeBody,
} from '@renderer/components/connect/ConnectComputeDialog';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { COMPUTE_SETTINGS_SECTIONS } from '@renderer/pages/registry.compute';
import ComputeKeySection, { ComputeKeySectionBody } from '@renderer/pages/settings/ComputeKeySection';
import { lockedSecretNote } from '@renderer/pages/settings/copy';
import { SETTINGS_SECTIONS } from '@renderer/pages/settings/sections';

function installBridge(): void {
  const bridge: GmiBridge = { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' };
  (globalThis as { window?: unknown }).window = { gmi: bridge };
}

const NO_INFERENCE: InferenceKeyInfo = { status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
const NO_COMPUTE: ComputeKeyInfo = { status: 'missing', last4: null, keyId: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
const VALID_COMPUTE: ComputeKeyInfo = {
  status: 'valid',
  last4: 'c0mp',
  keyId: 'k-1',
  orgId: '00000000-0000-0000-0000-000000000000',
  orgMatchesAccount: true,
  validatedAt: '2026-11-02T10:00:00.000Z',
  error: null,
};
const ENTITLED: ComputeAccess = { key: VALID_COMPUTE, containers: 'entitled', sandboxes: 'entitled', checkedAt: '2026-11-02T10:00:00.000Z' };

function auth(patch: Partial<AuthState> = {}): AuthState {
  return {
    status: 'signed_in',
    scopes: [],
    orgId: '00000000-0000-0000-0000-000000000000',
    signedInAt: '2026-11-01T07:08:00.000Z',
    accessTokenExpiresAt: null,
    inferenceKey: { ...NO_INFERENCE },
    secureStorage: 'os',
    lastError: null,
    mock: false,
    keyDetection: { active: true, candidate: null, target: 'compute' },
    computeKey: { ...NO_COMPUTE },
    ...patch,
  };
}
const sessionOnlyKey = (): ComputeKeyInfo => ({ ...VALID_COMPUTE, sessionOnly: true }) as ComputeKeyInfo;
const FOUND = { active: true, candidate: { last4: 'Q7fA', detectedAt: '2026-11-02T11:00:00.000Z' }, target: 'compute' as const };

function render(node: ReactNode, state: AuthState | null = null): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  if (state) client.setQueryData(qk.auth, state);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const noop = () => undefined;
const steps = (state: AuthState, extra: Partial<Parameters<typeof ComputeStepsView>[0]> = {}) =>
  render(
    <ComputeStepsView
      state={state}
      stage="listening"
      animate={false}
      consoleOpened={false}
      onOpenConsole={noop}
      onUseKey={noop}
      onUseForChat={noop}
      onNotThisOne={noop}
      onWatchAgain={noop}
      useError={null}
      pasteOpen={false}
      onTogglePaste={noop}
      onPasted={noop}
      {...extra}
    />,
    state,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, '’').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
/** Buttons with the lime fill (Button variant="default"). */
const limeButtons = (html: string) => (html.match(/<button[^>]*class="[^"]*\bbg-primary text-primary-foreground[^"]*"/g) ?? []).length;
const inferenceError = () => new GmiError('invalid_input', 'This is an inference (chat) key.', { detail: INFERENCE_SCOPE_DETAIL });

beforeEach(installBridge);
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  useUi.setState({ page: 'chat', params: {}, paletteOpen: false, connectOpen: false, connectTarget: 'inference' });
});

describe('compute access (pure)', () => {
  it('the dialog view: steps without a usable key, connected with one (or a locked one)', () => {
    expect(computeConnectView(undefined, false)).toBe('steps');
    expect(computeConnectView(auth(), false)).toBe('steps');
    expect(computeConnectView(auth({ computeKey: { ...VALID_COMPUTE, status: 'invalid' } }), false)).toBe('steps');
    expect(computeConnectView(auth({ computeKey: VALID_COMPUTE }), false)).toBe('connected');
    expect(computeConnectView(auth({ computeKey: { ...VALID_COMPUTE, status: 'unverified' } }), false)).toBe('connected');
    expect(computeConnectView(auth({ computeKey: { ...VALID_COMPUTE, status: 'unverified' }, lockedSecrets: ['compute_key'] }), false)).toBe('connected');
    expect(computeConnectView(auth({ computeKey: VALID_COMPUTE }), true)).toBe('steps');
    // An older main process without computeKey: no key.
    expect(computeConnectView(auth({ computeKey: undefined }), false)).toBe('steps');
  });

  it('session-only: the wire flag, or no encryption at all; locked from lockedSecrets', () => {
    expect(computeKeySessionOnly(auth({ computeKey: VALID_COMPUTE }))).toBe(false);
    expect(computeKeySessionOnly(auth({ computeKey: sessionOnlyKey() }))).toBe(true);
    expect(computeKeySessionOnly(auth({ computeKey: VALID_COMPUTE, secureStorage: 'unavailable' }))).toBe(true);
    expect(computeKeySessionOnly(auth({ secureStorage: 'unavailable' }))).toBe(false); // no key
    expect(computeKeyLocked(auth({ lockedSecrets: ['compute_key'] }))).toBe(true);
    expect(computeKeyLocked(auth({ lockedSecrets: ['inference_key'] }))).toBe(false);
  });

  it('recognises the inference-key error only by its code and detail', () => {
    expect(isInferenceKeyError(inferenceError())).toBe(true);
    expect(isInferenceKeyError(new GmiError('invalid_input', 'This is an inference (chat) key.'))).toBe(false);
    expect(isInferenceKeyError(new Error('scope:ie_model'))).toBe(false);
  });

  it('storage notes say where the key goes and that a weak keyring asks first', () => {
    expect(computeStorageNote('os')).toMatch(/OS keychain/);
    expect(computeStorageNote('basic_text')).toMatch(/asks whether to store it with weak encryption or keep it for this session only/);
    expect(computeStorageNote('unavailable')).toMatch(/memory until you quit/);
    expect(savedComputeKeyNote('c0mp', true, 'os', false)).toBe('Key ••c0mp is saved in your OS keychain. We cleared it from your clipboard (clipboard history apps may keep a copy).');
    expect(savedComputeKeyNote('c0mp', false, 'basic_text', true)).toMatch(/session only/);
    expect(savedComputeKeyNote(null, false, 'basic_text', false)).toMatch(/^Your key is saved on this computer with weak encryption/);
  });

  it('entitlement labels and rows (null while unknown)', () => {
    expect(entitlementLabel('entitled')).toBe('Enabled');
    expect(entitlementLabel('not_entitled')).toBe('Not enabled');
    expect(entitlementLabel('checking')).toBe('Checking…');
    expect(entitlementLabel('error')).toBe('Couldn’t check');
    expect(entitlementLabel('unknown')).toBe('Not checked');
    expect(entitlementRows(null)).toBeNull();
    expect(entitlementRows(ENTITLED)?.map((r) => r.id)).toEqual(['containers', 'sandboxes']);
  });

  it('subtitle and locked note wording', () => {
    const ago = () => '2 hours ago';
    expect(computeKeySubtitle(VALID_COMPUTE, false, ago)).toBe('Verified 2 hours ago · Compute scope (ce_resource)');
    expect(computeKeySubtitle({ ...VALID_COMPUTE, status: 'invalid' }, false, ago)).toMatch(/^Checked/);
    expect(computeKeySubtitle({ ...VALID_COMPUTE, validatedAt: null }, false, ago)).toBe('Not verified with GMI yet');
    expect(computeKeySubtitle(VALID_COMPUTE, true, ago)).toMatch(/did not unlock/);
    expect(lockedSecretNote('compute_key')).toMatch(/your saved Compute key.*connect the key again/);
    expect(lockedSecretNote('inference_key')).toMatch(/your saved API key/);
  });
});

describe('Connect Compute dialog: every state', () => {
  it('loading', () => {
    expect(render(<ConnectComputeBody open state={undefined} access={null} onClose={noop} />)).toContain('Loading…');
  });

  it('steps, listening: explains the key, opens the Compute API keys page, watches the clipboard; one lime action', () => {
    const html = steps(auth());
    const t = text(html);
    expect(t).toContain(COMPUTE_COPY.explain);
    expect(t).toContain('Create a Compute key in GMI Console');
    expect(t).toContain('Open GMI Console');
    expect(t).toContain('GMI Desk – <this computer>');
    expect(t).toContain(COMPUTE_COPY.dedicated);
    expect(t).toContain(COMPUTE_COPY.listening);
    expect(t).toContain('Paste it instead');
    expect(t).not.toMatch(/weak encryption|memory until you quit/); // OS keyring: no storage warning
    expect(limeButtons(html)).toBe(1);
  });

  it('steps through the body: no key → the steps (and the dialog title/description copy)', () => {
    const t = text(render(<ConnectComputeBody open state={auth()} access={null} onClose={noop} />, auth()));
    expect(t).toContain(COMPUTE_COPY.listening);
    expect(COMPUTE_COPY.title).toBe('Connect Compute');
  });

  it('steps, found: "Use this key" with the last 4 is the one lime action', () => {
    const state = auth({ keyDetection: FOUND });
    const html = steps(state, { stage: 'found', consoleOpened: true });
    const t = text(html);
    expect(t).toContain('Found a key ending ••Q7fA');
    expect(t).toContain('Use this key');
    expect(t).toContain('Not this one');
    expect(t).not.toContain('Open GMI Console');
    expect(limeButtons(html)).toBe(1);
  });

  it('steps, verifying: checking with GMI, buttons disabled', () => {
    const html = steps(auth({ keyDetection: FOUND }), { stage: 'verifying' });
    expect(text(html)).toContain('Checking it with GMI…');
    expect(html).toContain('aria-busy="true"');
  });

  it('steps, stopped: watch again', () => {
    const t = text(steps(auth({ keyDetection: { active: false, candidate: null } }), { stage: 'stopped' }));
    expect(t).toContain(COMPUTE_COPY.stopped);
    expect(t).toContain('Watch again');
  });

  it('steps, the found key is an inference key: says so and offers chat instead (no lime "Use this key")', () => {
    const html = steps(auth({ keyDetection: FOUND }), { stage: 'found', useError: inferenceError(), consoleOpened: true });
    const t = text(html);
    expect(t).toContain(COMPUTE_COPY.inferenceTitle);
    expect(t).toContain('Use it for chat instead');
    expect(t).not.toContain('Use this key');
    expect(limeButtons(html)).toBe(0);
  });

  it('steps, GMI rejected the found key: the reason', () => {
    const html = steps(auth({ keyDetection: FOUND }), { stage: 'found', useError: new GmiError('invalid_compute_key', 'Expired API key.') });
    expect(text(html)).toContain('GMI didn’t accept that key (Expired API key). Copy another one.');
  });

  it('steps, the saved key was rejected: says it will be replaced', () => {
    const t = text(steps(auth({ computeKey: { ...VALID_COMPUTE, status: 'invalid', error: 'GMI rejected this key: Expired API key.' } })));
    expect(t).toContain('GMI rejected your current Compute key ••c0mp');
  });

  it('steps, weak keyring / no encryption: says what will happen before anything is saved', () => {
    expect(text(steps(auth({ secureStorage: 'basic_text' })))).toContain(computeStorageNote('basic_text'));
    expect(text(steps(auth({ secureStorage: 'unavailable' })))).toContain(computeStorageNote('unavailable'));
  });

  it('steps, paste form open: Compute wording, outline submit until there is a key', () => {
    const html = steps(auth(), { pasteOpen: true, consoleOpened: true });
    expect(html).toContain('placeholder="Paste your GMI Compute API key"');
    expect(html).toContain('type="password"');
    expect(text(html)).toContain(computeStorageNote('os'));
    expect(limeButtons(html)).toBe(0);
  });

  it('connected: key card, access chips, "Use a different key", Done', () => {
    const state = auth({ computeKey: VALID_COMPUTE });
    const html = render(<ComputeConnectedView state={state} access={ENTITLED} onDone={noop} onReplace={noop} />, state);
    const t = text(html);
    expect(t).toContain('•••• c0mp');
    expect(t).toContain('Valid');
    expect(t).toContain('Containers Enabled');
    expect(t).toContain('Sandboxes Enabled');
    expect(t).toContain('Use a different key');
    expect(t).toContain('Done');
    expect(limeButtons(html)).toBe(1);
  });

  it('connected through the body', () => {
    const state = auth({ computeKey: VALID_COMPUTE });
    expect(text(render(<ConnectComputeBody open state={state} access={null} onClose={noop} />, state))).toContain('Use a different key');
  });

  it('connected, not entitled: "Contact GMI support to enable"; checking: a working chip; unknown access: no chips', () => {
    const state = auth({ computeKey: VALID_COMPUTE });
    const partial = text(render(<ComputeConnectedView state={state} access={{ ...ENTITLED, containers: 'not_entitled' }} onDone={noop} onReplace={noop} />, state));
    expect(partial).toContain('Containers Not enabled');
    expect(partial).toContain('Contact GMI support to enable');
    const checking = text(render(<ComputeConnectedView state={state} access={{ ...ENTITLED, containers: 'checking', sandboxes: 'checking' }} onDone={noop} onReplace={noop} />, state));
    expect(checking).toContain('Containers Checking…');
    const unknown = text(render(<ComputeConnectedView state={state} access={null} onDone={noop} onReplace={noop} />, state));
    expect(unknown).not.toContain('Containers');
  });

  it('connected, locked keychain: Locked badge, nothing deleted, Try again', () => {
    const state = auth({ computeKey: { ...VALID_COMPUTE, status: 'unverified' }, lockedSecrets: ['compute_key'] });
    const t = text(render(<ComputeConnectedView state={state} access={null} onDone={noop} onReplace={noop} />, state));
    expect(t).toContain('Locked');
    expect(t).toContain('Nothing was deleted');
    expect(t).toContain('Try again');
  });

  it('connected, session only and another organization', () => {
    const state = auth({ computeKey: { ...sessionOnlyKey(), orgMatchesAccount: false }, secureStorage: 'basic_text' });
    const t = text(render(<ComputeConnectedView state={state} access={null} onDone={noop} onReplace={noop} />, state));
    expect(t).toContain('This session only');
    expect(t).toContain('another organization');
  });

  it('success: "Compute is connected", where the key is, access chips, Open Compute is the lime action', () => {
    const state = auth({ computeKey: VALID_COMPUTE });
    const html = render(
      <ComputeSuccessView success={{ kind: 'compute', last4: 'c0mp', clipboardCleared: true }} state={state} access={{ ...ENTITLED, sandboxes: 'not_entitled' }} onOpenCompute={noop} onStartChatting={noop} onDone={noop} />,
      state,
    );
    const t = text(html);
    expect(t).toContain(COMPUTE_COPY.ready);
    expect(t).toContain(savedComputeKeyNote('c0mp', true, 'os', false));
    expect(t).toContain('Sandboxes Not enabled');
    expect(t).toContain('Open Compute');
    expect(limeButtons(html)).toBe(1);
  });

  it('success, session only: says it is gone after quitting', () => {
    const state = auth({ computeKey: sessionOnlyKey(), secureStorage: 'basic_text' });
    const t = text(render(<ComputeSuccessView success={{ kind: 'compute', last4: 'c0mp', clipboardCleared: false }} state={state} access={null} onOpenCompute={noop} onStartChatting={noop} onDone={noop} />, state));
    expect(t).toContain('kept in memory for this session only');
  });

  it('success, the key went to chat instead: "Chat is ready", Start chatting, no compute chips', () => {
    const state = auth({ inferenceKey: { ...NO_INFERENCE, status: 'valid', last4: 'Q7fA' } });
    const t = text(render(<ComputeSuccessView success={{ kind: 'chat', last4: 'Q7fA', clipboardCleared: true }} state={state} access={ENTITLED} onOpenCompute={noop} onStartChatting={noop} onDone={noop} />, state));
    expect(t).toContain(COMPUTE_COPY.chatReady);
    expect(t).toContain('Start chatting');
    expect(t).toContain('Compute still needs its own key');
    expect(t).not.toContain('Containers');
  });

  it('access chips render nothing while unknown', () => {
    expect(render(<AccessChips access={null} />)).toBe('');
  });
});

describe('Settings › Compute key', () => {
  const section = (state: AuthState, access: ComputeAccess | null = null) => render(<ComputeKeySectionBody state={state} access={access} />, state);

  it('is registered after the inference key section (through pages/settings/sections.ts)', () => {
    expect(COMPUTE_SETTINGS_SECTIONS.map((s) => s.id)).toEqual(['compute-key']);
    expect(COMPUTE_SETTINGS_SECTIONS[0]!.Component).toBe(ComputeKeySection);
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids.indexOf('compute-key')).toBe(ids.indexOf('keys') + 1);
  });

  it('no key: explains it, Connect Compute (outline: the page’s lime belongs to Connect chat), console link', () => {
    const html = section(auth());
    const t = text(html);
    expect(t).toContain('No Compute key yet');
    expect(t).toContain('Not set');
    expect(t).toContain('Connect Compute');
    expect(t).toContain(COMPUTE_COPY.explain);
    expect(t).toContain('Open GMI Console');
    expect(t).not.toContain('Remove key');
    expect(limeButtons(html)).toBe(0);
  });

  it('valid: last 4, Re-verify, access, billed-to, remove (resources keep billing)', () => {
    const t = text(section(auth({ computeKey: VALID_COMPUTE }), ENTITLED));
    expect(t).toContain('c0mp');
    expect(t).toContain('Valid');
    expect(t).toContain('Re-verify');
    expect(t).toContain('Containers Enabled');
    expect(t).toContain('Matches your sign-in');
    expect(t).toContain('Remove key');
    expect(t).toContain(COMPUTE_COPY.keepBilling);
  });

  it('rejected: the reason and Connect a new key', () => {
    const t = text(section(auth({ computeKey: { ...VALID_COMPUTE, status: 'invalid', error: 'GMI rejected this key: Expired API key.' } })));
    expect(t).toContain('Rejected');
    expect(t).toContain('GMI rejected this key: Expired API key.');
    expect(t).toContain('Connect a new key');
  });

  it('locked keychain: Locked, the Compute wording, Try again; no Re-verify', () => {
    const t = text(section(auth({ computeKey: { ...VALID_COMPUTE, status: 'unverified' }, lockedSecrets: ['compute_key'] })));
    expect(t).toContain('Locked');
    expect(t).toContain(lockedSecretNote('compute_key'));
    expect(t).toContain('Try again');
    expect(t).not.toContain('Re-verify');
  });

  it('session only (weak keyring declined / no encryption) and another organization', () => {
    const weak = text(section(auth({ computeKey: { ...sessionOnlyKey(), orgMatchesAccount: false, orgId: '11111111-1111-1111-1111-111111111111' }, secureStorage: 'basic_text' })));
    expect(weak).toContain('This session only');
    expect(weak).toContain('no OS keyring was found');
    expect(weak).toContain('not the one you signed in with');
    const none = text(section(auth({ computeKey: VALID_COMPUTE, secureStorage: 'unavailable' })));
    expect(none).toContain('encryption is unavailable');
  });

  it('the default export renders nothing until the auth state is known', () => {
    expect(render(<ComputeKeySection />)).toBe('');
  });
});
