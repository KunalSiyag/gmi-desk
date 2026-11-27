// One sign-in CTA per screen: a page that shows its own "Sign in" (RequireAuth's gate on Usage / Create / Docs, the
// Models signed-out banner) counts itself in the UI store while mounted, and the top bar hides its copy meanwhile
// (see renderer-shell.test.tsx for the top bar side). The node suite has no DOM, so react-dom/server never runs
// layout effects: here useLayoutEffect runs during render, and its cleanups stand in for unmounting.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import type { CatalogSnapshot } from '@shared/contracts/catalog';

const effects = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useLayoutEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') effects.cleanups.push(cleanup);
    },
  };
});

import { RequireAuth } from '@renderer/components/RequireAuth';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import ModelsPage from '@renderer/pages/models';
import { AccountSection } from '@renderer/pages/settings/AccountSection';

function authState(status: AuthState['status']): AuthState {
  return {
    status,
    scopes: [],
    orgId: null,
    signedInAt: null,
    accessTokenExpiresAt: null,
    inferenceKey: { status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null },
    secureStorage: 'os',
    lastError: null,
    mock: true,
    signInInProgress: status === 'signing_in',
  } as AuthState;
}

/** Renders `node` "mounted" (layout effects ran) and returns the markup plus the counters at that moment. */
function mount(node: ReactNode, status: AuthState['status'], seed?: (c: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.auth, authState(status));
  seed?.(client);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  const { signInCtas, pendingSignInRows } = useUi.getState();
  return { html, signInCtas, pendingSignInRows };
}

function unmountAll() {
  for (const cleanup of effects.cleanups.splice(0)) cleanup();
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { gmi: { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' } };
});

afterEach(() => {
  unmountAll();
  delete (globalThis as { window?: unknown }).window;
});

describe('RequireAuth sign-in gate', () => {
  it.each(['signed_out', 'reauth_required'] as const)('counts itself as the page sign-in CTA while mounted (%s)', (status) => {
    const { html, signInCtas, pendingSignInRows } = mount(<RequireAuth reason="Usage needs your GMI account.">secret</RequireAuth>, status);
    expect(html).not.toContain('secret');
    expect(html).toContain('Sign in with GMI');
    expect(signInCtas).toBe(1);
    expect(pendingSignInRows).toBe(0);
    unmountAll();
    expect(useUi.getState().signInCtas).toBe(0);
  });

  it('does not count when signed in (no gate) or while signing in (the pending row counts itself instead)', () => {
    const signedIn = mount(<RequireAuth reason="r">secret</RequireAuth>, 'signed_in');
    expect(signedIn.html).toBe('secret');
    expect(signedIn.signInCtas).toBe(0);
    unmountAll();
    const pending = mount(<RequireAuth reason="r">secret</RequireAuth>, 'signing_in');
    expect(pending.signInCtas).toBe(0);
    expect(pending.pendingSignInRows).toBe(1);
  });
});

describe('Models signed-out banner', () => {
  const snapshot = { models: [], refreshing: false, sources: {} } as unknown as CatalogSnapshot;
  const seed = (c: QueryClient) => c.setQueryData(qk.catalog, snapshot);

  it.each(['signed_out', 'reauth_required'] as const)('counts its "Sign in" as the page sign-in CTA (%s)', (status) => {
    const { html, signInCtas } = mount(<ModelsPage />, status, seed);
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Sign in<\/button>/);
    expect(signInCtas).toBe(1);
    unmountAll();
    expect(useUi.getState().signInCtas).toBe(0);
  });

  it('does not count when signed in (no banner) or while signing in (pending row instead)', () => {
    expect(mount(<ModelsPage />, 'signed_in', seed).signInCtas).toBe(0);
    unmountAll();
    const pending = mount(<ModelsPage />, 'signing_in', seed);
    expect(pending.signInCtas).toBe(0);
    expect(pending.pendingSignInRows).toBe(1);
  });
});

describe('Settings account card', () => {
  it.each(['signed_out', 'reauth_required'] as const)('counts its "Sign in" as the page sign-in CTA (%s)', (status) => {
    const { html, signInCtas } = mount(<AccountSection state={authState(status)} />, status);
    expect(html).toMatch(/Sign in (with GMI|again)/);
    expect(signInCtas).toBe(1);
    unmountAll();
    expect(useUi.getState().signInCtas).toBe(0);
  });

  it('does not count when signed in or while signing in (pending row instead)', () => {
    expect(mount(<AccountSection state={authState('signed_in')} />, 'signed_in').signInCtas).toBe(0);
    unmountAll();
    const pending = mount(<AccountSection state={authState('signing_in')} />, 'signing_in');
    expect(pending.signInCtas).toBe(0);
    expect(pending.pendingSignInRows).toBe(1);
  });
});
