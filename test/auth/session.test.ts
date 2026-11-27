import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import { createAuthSliceWith, type AuthSlice } from '@main/services/auth';
import asMetadata from '@main/mock/fixtures/auth/oauth-authorization-server.json';
import type { StoredClient, StoredTokens } from '@main/services/auth/secrets';
import { createFakeFetch, jsonResponse, type FakeRoute } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';
import {
  ALL_SCOPES,
  discoveryRoutes,
  exact,
  fakeMcpServer,
  form,
  ISSUER,
  REGISTER_URL,
  REVOKE_URL,
  seedClient,
  seedTokens,
  textResult,
  TOKEN_URL,
  tokenResponse,
  waitFor,
} from './helpers';

type Browser = (authUrl: URL) => Promise<void> | void;

let t: TestContext;
let slice: AuthSlice | null = null;

afterEach(async () => {
  await slice?.dispose();
  slice = null;
  await t?.cleanup();
});

/** Fake GMI (discovery, registration, token, revocation, MCP) + a scripted browser. */
async function setup(opts: { browser?: Browser; routes?: FakeRoute[]; signInTimeoutMs?: number } = {}) {
  let registrations = 0;
  let tokenCalls = 0;
  const mcp = fakeMcpServer({
    validTokens: new Set(['access-new']),
    tools: { get_account_summary: () => textResult({ org_id: 'org-0001', balance_usd: '1.00' }) },
  });
  const fake = createFakeFetch([
    ...(opts.routes ?? []),
    ...discoveryRoutes(),
    mcp.route,
    {
      match: exact(REGISTER_URL),
      method: 'POST',
      respond: (req) => {
        registrations += 1;
        const body = JSON.parse(req.body!) as { redirect_uris: string[] };
        return jsonResponse({ client_id: `client-${registrations}`, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, 201);
      },
    },
    {
      match: exact(TOKEN_URL),
      method: 'POST',
      respond: () => {
        tokenCalls += 1;
        return tokenResponse('access-new', { refresh_token: 'refresh-new' });
      },
    },
    { match: exact(REVOKE_URL), method: 'POST', respond: () => new Response(null, { status: 200 }) },
  ]);
  t = await createTestContext({ fetch: fake.fetch });
  const focus = { count: 0 };
  t.platform.focusApp = () => {
    focus.count += 1;
  };
  const browserPages: Array<Promise<Response>> = [];
  t.platform.openExternal = async (url) => {
    t.platform.opened.push(url);
    if (opts.browser) setTimeout(() => void opts.browser!(new URL(url)), 0);
  };
  slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, signInTimeoutMs: opts.signInTimeoutMs });
  return { slice, fake, mcp, focus, browserPages, registrations: () => registrations, tokenCalls: () => tokenCalls };
}

/** A browser that approves: follows the redirect to the loopback with a code and the state. */
function approvingBrowser(pages: Array<Promise<Response>>, extra: Record<string, string> = { iss: ISSUER }): Browser {
  return (authUrl) => {
    const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', 'auth-code-1');
    redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
    for (const [k, v] of Object.entries(extra)) redirect.searchParams.set(k, v);
    pages.push(fetch(redirect));
  };
}

const authEvents = () => t.emitted.filter((e) => e.name === 'auth:changed').map((e) => e.payload as AuthState);

/** A loopback port that is free right now (for seeding a reusable client registration). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('sign-in', () => {
  it('runs discovery → registration → PKCE → browser → loopback → token exchange', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({ browser: approvingBrowser(pages) });
    expect(s.slice.service.getState().status).toBe('signed_out');

    const state = await s.slice.api.signIn();
    expect(state).toMatchObject({ status: 'signed_in', lastError: null, signInInProgress: false });
    expect(state.scopes.join(' ')).toBe(ALL_SCOPES);
    expect(state.signedInAt).not.toBeNull();
    expect(state.accessTokenExpiresAt).not.toBeNull();
    expect(s.slice.service.isSignedIn()).toBe(true);

    // Browser saw the success page.
    const page = await pages[0]!;
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Signed in to GMI.');

    // Authorization request.
    const authUrl = new URL(t.platform.opened[0]!);
    const p = authUrl.searchParams;
    const redirectUri = p.get('redirect_uri')!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(p.get('client_id')).toBe('client-1');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('scope')).toBe(ALL_SCOPES);
    expect(p.get('resource')).toBe('https://mcp.gmicloud.ai/mcp');
    expect(p.get('state')!.length).toBeGreaterThanOrEqual(43);

    // Registration and token exchange.
    const reg = JSON.parse(s.fake.requests.find((r) => r.url === REGISTER_URL)!.body!) as Record<string, unknown>;
    expect(reg).toMatchObject({ client_name: 'GMI Desk', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', scope: ALL_SCOPES });
    const exchange = form(s.fake.requests.find((r) => r.url === TOKEN_URL)!);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('auth-code-1');
    expect(exchange.get('redirect_uri')).toBe(redirectUri);
    expect(exchange.get('client_id')).toBe('client-1');
    expect(exchange.get('resource')).toBe('https://mcp.gmicloud.ai/mcp');
    expect(exchange.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);

    // Secrets stored securely; nothing secret in auth.json.
    const client = JSON.parse((await t.ctx.secure.get('oauth.client'))!) as { client_id: string; redirect_port: number };
    expect(client.client_id).toBe('client-1');
    expect(client.redirect_port).toBe(Number(new URL(redirectUri).port));
    const tokens = JSON.parse((await t.ctx.secure.get('oauth.tokens'))!) as { access_token: string; refresh_token: string; expires_at: number };
    expect(tokens).toMatchObject({ access_token: 'access-new', refresh_token: 'refresh-new' });

    // Events: signing_in → signed_in (org lookup pending), then the org id learned over MCP.
    expect(authEvents().map((e) => e.status)).toEqual(expect.arrayContaining(['signing_in', 'signed_in']));
    expect(authEvents()[0]).toMatchObject({ status: 'signing_in', signInInProgress: true, orgIdPending: false });
    expect(state).toMatchObject({ orgId: null, orgIdPending: true });
    expect(s.focus.count).toBe(1);
    // The org id and `orgIdPending: false` may arrive in two consecutive events: wait for the settled one.
    await waitFor(() => authEvents().some((e) => e.orgId === 'org-0001' && !e.orgIdPending)); // emitted after auth.json is written
    expect(authEvents().at(-1)).toMatchObject({ orgId: 'org-0001', orgIdPending: false });
    const file = await readFile(join(t.ctx.paths.data, 'auth.json'), 'utf8');
    expect(file).toContain('org-0001');
    expect(file).not.toContain('access-new');
    expect(file).not.toContain('refresh-new');
  });

  it('asks GMI right after sign-in whether inference accepts it (and chat uses it when it does)', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({
      browser: approvingBrowser(pages),
      routes: [{ match: exact('https://api.gmi-serving.com/v1/models'), method: 'GET', respond: () => jsonResponse({ object: 'list', data: [{ id: 'm' }] }) }],
    });
    expect(s.slice.service.getState().inference).toMatchObject({ via: null, oauthProbe: 'unknown' });
    const state = await s.slice.api.signIn();
    expect(state.inference?.oauthProbe).toBe('checking'); // the signed_in state already says it is asking
    await waitFor(() => s.slice.service.getState().inference?.oauthProbe === 'supported');
    const probe = s.fake.requests.filter((r) => r.url === 'https://api.gmi-serving.com/v1/models');
    expect(probe).toHaveLength(1);
    expect(probe[0]!.headers.authorization).toBe('Bearer access-new');
    expect(s.slice.service.getState().inference?.via).toBe('oauth');
    await expect(s.slice.keys.requireInferenceKey()).resolves.toBe('access-new');
  });

  it('reuses the client registration and its port on the next sign-in', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({ browser: approvingBrowser(pages) });
    await s.slice.api.signIn();
    await s.slice.api.signOut();
    await s.slice.api.signIn();
    expect(s.registrations()).toBe(1);
    const ports = t.platform.opened.map((u) => new URL(new URL(u).searchParams.get('redirect_uri')!).port);
    expect(ports[0]).toBe(ports[1]);
  });

  it('re-registers when the saved port is taken', async () => {
    const pages: Array<Promise<Response>> = [];
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const s = await setup({ browser: approvingBrowser(pages) });
      await seedClient(t.ctx.secure, { client_id: 'client-old', redirect_port: port, redirect_uri: `http://127.0.0.1:${port}/callback` });
      await s.slice.api.signIn();
      expect(s.registrations()).toBe(1);
      expect(new URL(t.platform.opened[0]!).searchParams.get('client_id')).toBe('client-1');
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('can be cancelled while waiting for the browser', async () => {
    const s = await setup();
    const signingIn = s.slice.api.signIn();
    await waitFor(() => t.platform.opened.length === 1);
    expect(s.slice.service.getState()).toMatchObject({ status: 'signing_in', signInInProgress: true });
    const after = await s.slice.api.cancelSignIn();
    expect(after).toMatchObject({ status: 'signed_out', signInInProgress: false, lastError: null });
    await expect(signingIn).resolves.toMatchObject({ status: 'signed_out' });
    const redirect = new URL(t.platform.opened[0]!).searchParams.get('redirect_uri')!;
    await expect(fetch(redirect)).rejects.toThrow(); // loopback closed
    expect(s.tokenCalls()).toBe(0);
  });

  it('never runs two sign-ins at once (a second request reopens the page and joins)', async () => {
    const s = await setup();
    const first = s.slice.api.signIn();
    await waitFor(() => t.platform.opened.length === 1);
    const second = s.slice.api.signIn();
    await waitFor(() => t.platform.opened.length === 2);
    expect(t.platform.opened[1]).toBe(t.platform.opened[0]);
    // Complete through the browser once.
    const authUrl = new URL(t.platform.opened[0]!);
    const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', 'c');
    redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
    void fetch(redirect).catch(() => undefined);
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe('signed_in');
    expect(b.status).toBe('signed_in');
    expect(s.tokenCalls()).toBe(1);
  });

  it('reports a declined consent and returns to signed_out', async () => {
    const s = await setup({
      browser: (authUrl) => {
        const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
        void fetch(redirect).catch(() => undefined);
      },
    });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'cancelled', message: 'Sign-in was declined in the browser.' });
    expect(s.slice.service.getState()).toMatchObject({ status: 'signed_out', lastError: 'Sign-in was declined in the browser.', signInInProgress: false });
    expect(s.focus.count).toBe(1);
  });

  it('fails when the code exchange is rejected, telling the browser too', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({
      browser: approvingBrowser(pages),
      routes: [{ match: exact(TOKEN_URL), respond: () => jsonResponse({ error: 'invalid_grant', error_description: 'code expired' }, 400) }],
    });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(s.slice.service.getState().status).toBe('signed_out');
    const page = await pages[0]!;
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('Sign-in failed.');
  });

  it('times out when the browser never comes back', async () => {
    const s = await setup({ signInTimeoutMs: 80 });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'timeout' });
    expect(s.slice.service.getState()).toMatchObject({ status: 'signed_out', signInInProgress: false });
    expect(s.focus.count).toBe(0);
  });

  it('leaves the organization unknown (not pending) when GMI cannot tell it', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({ browser: approvingBrowser(pages) });
    s.mcp.route.respond = () => new Response('upstream down', { status: 503 });
    await expect(s.slice.api.signIn()).resolves.toMatchObject({ status: 'signed_in', orgIdPending: true });
    await waitFor(() => authEvents().at(-1)?.orgIdPending === false);
    expect(s.slice.service.getState()).toMatchObject({ status: 'signed_in', orgId: null, orgIdPending: false });
  });

  it('forgets a reused registration when the browser never comes back', async () => {
    const s = await setup();
    const port = await freePort();
    await seedClient(t.ctx.secure, { redirect_port: port, redirect_uri: `http://127.0.0.1:${port}/callback` });
    const pending = s.slice.api.signIn();
    await waitFor(() => t.platform.opened.length === 1);
    expect(new URL(t.platform.opened[0]!).searchParams.get('client_id')).toBe('client-seeded'); // reused: its port was free
    await s.slice.api.cancelSignIn();
    await pending;
    expect(s.registrations()).toBe(0);
    expect(await t.ctx.secure.get('oauth.client')).toBeNull(); // the next attempt registers again
  });

  it('forgets the registration when GMI calls the client unknown at the token endpoint', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({
      browser: approvingBrowser(pages),
      routes: [{ match: exact(TOKEN_URL), respond: () => jsonResponse({ error: 'invalid_client', error_description: 'unknown client' }, 401) }],
    });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(s.registrations()).toBe(1);
    expect(await t.ctx.secure.get('oauth.client')).toBeNull();
  });

  it('keeps the registration when the user declines in the browser', async () => {
    const s = await setup({
      browser: (authUrl) => {
        const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
        void fetch(redirect).catch(() => undefined);
      },
    });
    const port = await freePort();
    await seedClient(t.ctx.secure, { redirect_port: port, redirect_uri: `http://127.0.0.1:${port}/callback` });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.registrations()).toBe(0);
    expect(JSON.parse((await t.ctx.secure.get('oauth.client'))!)).toMatchObject({ client_id: 'client-seeded' });
  });

  it('reconnecting keeps the session signed in while the browser is open', async () => {
    const s = await setup();
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure, { scope: 'models:read billing:read' });
    slice = await createAuthSliceWith(t.ctx, { fetch: s.fake.fetch, envKey: null, learnOrgOnStart: false });
    await s.slice.dispose();
    expect(slice.service.getState().scopes).toEqual(['models:read', 'billing:read']);
    const pending = slice.api.signIn();
    await waitFor(() => t.platform.opened.length === 1);
    expect(slice.service.getState()).toMatchObject({ status: 'signed_in', signInInProgress: true });
    expect(slice.service.isSignedIn()).toBe(true);
    await slice.api.cancelSignIn();
    await expect(pending).resolves.toMatchObject({ status: 'signed_in', signInInProgress: false });
  });
});

describe('sign-out and restore', () => {
  it('revokes the refresh token then the access token, forgets the session and keeps the key + registration', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({ browser: approvingBrowser(pages) });
    await s.slice.api.signIn();
    await t.ctx.secure.set('inference.key', 'sk-keep-me');
    const state = await s.slice.api.signOut();
    expect(state).toMatchObject({ status: 'signed_out', scopes: [], orgId: null, signedInAt: null, accessTokenExpiresAt: null });
    const revocations = s.fake.requests.filter((r) => r.url === REVOKE_URL).map((r) => Object.fromEntries(form(r)));
    expect(revocations).toEqual([
      { token: 'refresh-new', token_type_hint: 'refresh_token', client_id: 'client-1' },
      { token: 'access-new', token_type_hint: 'access_token', client_id: 'client-1' },
    ]);
    expect(await t.ctx.secure.get('oauth.tokens')).toBeNull();
    expect(await t.ctx.secure.get('oauth.client')).not.toBeNull();
    expect(await t.ctx.secure.get('inference.key')).toBe('sk-keep-me');
    expect(authEvents().at(-1)?.status).toBe('signed_out');
    await expect(s.slice.mcp.callTool('search_models', {})).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('signs out locally even when revocation fails', async () => {
    const s = await setup({ routes: [{ match: exact(REVOKE_URL), respond: () => new Response('down', { status: 503 }) }] });
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure);
    slice = await createAuthSliceWith(t.ctx, { fetch: s.fake.fetch, envKey: null, learnOrgOnStart: false });
    await s.slice.dispose();
    await expect(slice.api.signOut()).resolves.toMatchObject({ status: 'signed_out' });
    expect(await t.ctx.secure.get('oauth.tokens')).toBeNull();
  });

  it('restores a stored session on startup with the granted scopes', async () => {
    const s = await setup();
    await seedClient(t.ctx.secure);
    const tokens = await seedTokens(t.ctx.secure, { scope: 'models:read generation:read' });
    await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, orgId: 'org-9', signedInAt: '2026-10-30T10:00:00.000Z' }));
    slice = await createAuthSliceWith(t.ctx, { fetch: s.fake.fetch, envKey: null, learnOrgOnStart: false });
    await s.slice.dispose();
    expect(slice.service.getState()).toMatchObject({
      status: 'signed_in',
      scopes: ['models:read', 'generation:read'],
      orgId: 'org-9',
      signedInAt: '2026-10-30T10:00:00.000Z',
      accessTokenExpiresAt: new Date(tokens.expires_at!).toISOString(),
    });
  });

  it('restores reauth_required, and treats an expired session without a refresh token as reauth_required', async () => {
    const s = await setup();
    await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, orgId: 'org-9', reauthRequired: true }));
    slice = await createAuthSliceWith(t.ctx, { fetch: s.fake.fetch, envKey: null, learnOrgOnStart: false });
    expect(slice.service.getState()).toMatchObject({ status: 'reauth_required', orgId: 'org-9' });
    await slice.dispose();

    await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1 }));
    await seedTokens(t.ctx.secure, { refresh_token: null, expires_at: Date.now() - 1_000 });
    slice = await createAuthSliceWith(t.ctx, { fetch: s.fake.fetch, envKey: null, learnOrgOnStart: false });
    await s.slice.dispose();
    expect(slice.service.getState().status).toBe('reauth_required');
    expect(await t.ctx.secure.get('oauth.tokens')).toBeNull();
  });

  it('starts signed out with a corrupt auth.json or token blob', async () => {
    const s = await setup();
    await writeFile(join(t.ctx.paths.data, 'auth.json'), '{nope');
    await t.ctx.secure.set('oauth.tokens', 'not-json');
    slice = await createAuthSliceWith(t.ctx, { fetch: s.fake.fetch, envKey: null, learnOrgOnStart: false });
    await s.slice.dispose();
    expect(slice.service.getState()).toMatchObject({ status: 'signed_out', orgId: null });
  });
});

describe('reconnecting while signed in keeps what the live session refreshes with', () => {
  /**
   * Fake GMI whose token endpoint binds each refresh token to the client it was issued to (OAuth 2.1): a refresh
   * sent with another client_id gets invalid_grant. Seeds a saved registration (on a free port) and a session
   * whose access token is about to expire, so the next MCP call refreshes it.
   */
  async function setupBound(opts: { browser?: Browser; signInTimeoutMs?: number; client?: Partial<StoredClient>; tokens?: Partial<StoredTokens> } = {}) {
    const valid = new Set(['access-1']);
    const issuedTo = new Map([['refresh-1', 'client-seeded']]);
    const refreshClientIds: string[] = [];
    let registrations = 0;
    let issued = 1;
    const mcp = fakeMcpServer({ validTokens: valid, tools: { get_account_summary: () => textResult({ org_id: 'org-1' }) } });
    const fake = createFakeFetch([
      ...discoveryRoutes(),
      mcp.route,
      {
        match: exact(REGISTER_URL),
        method: 'POST',
        respond: (req) => {
          registrations += 1;
          const body = JSON.parse(req.body!) as { redirect_uris: string[] };
          return jsonResponse({ client_id: `client-new-${registrations}`, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, 201);
        },
      },
      {
        match: exact(TOKEN_URL),
        method: 'POST',
        respond: (req) => {
          const f = form(req);
          const clientId = f.get('client_id') ?? '';
          if (f.get('grant_type') === 'refresh_token') {
            refreshClientIds.push(clientId);
            if (issuedTo.get(f.get('refresh_token') ?? '') !== clientId) {
              return jsonResponse({ error: 'invalid_grant', error_description: 'refresh token was issued to another client' }, 400);
            }
          }
          issued += 1;
          valid.add(`access-${issued}`);
          issuedTo.set(`refresh-${issued}`, clientId);
          return tokenResponse(`access-${issued}`, { refresh_token: `refresh-${issued}` });
        },
      },
      { match: exact(REVOKE_URL), method: 'POST', respond: () => new Response(null, { status: 200 }) },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    t.platform.openExternal = async (url) => {
      t.platform.opened.push(url);
      if (opts.browser) setTimeout(() => void opts.browser!(new URL(url)), 0);
    };
    const port = await freePort();
    await seedClient(t.ctx.secure, { redirect_port: port, redirect_uri: `http://127.0.0.1:${port}/callback`, ...opts.client });
    await seedTokens(t.ctx.secure, { expires_at: Date.now() + 30_000, ...opts.tokens });
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false, signInTimeoutMs: opts.signInTimeoutMs });
    expect(slice.service.getState().status).toBe('signed_in');
    return { slice, fake, valid, refreshClientIds, registrations: () => registrations };
  }

  const savedClientId = async () => (JSON.parse((await t.ctx.secure.get('oauth.client')) ?? 'null') as StoredClient | null)?.client_id ?? null;
  const savedTokens = async () => JSON.parse((await t.ctx.secure.get('oauth.tokens')) ?? 'null') as StoredTokens | null;

  const declining: Browser = (authUrl) => {
    const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
    void fetch(redirect).catch(() => undefined);
  };

  async function busyPort(): Promise<{ port: number; close: () => Promise<void> }> {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    return { port: (blocker.address() as AddressInfo).port, close: () => new Promise<void>((r) => blocker.close(() => r())) };
  }

  it('a cancelled reconnect keeps the reused registration, and the session refreshes with it', async () => {
    const s = await setupBound();
    const pending = s.slice.api.signIn();
    await waitFor(() => t.platform.opened.length === 1);
    expect(new URL(t.platform.opened[0]!).searchParams.get('client_id')).toBe('client-seeded');
    await s.slice.api.cancelSignIn();
    await expect(pending).resolves.toMatchObject({ status: 'signed_in', signInInProgress: false, lastError: null });
    expect(await savedClientId()).toBe('client-seeded');
    await expect(s.slice.mcp.callTool('get_account_summary', {})).resolves.toMatchObject({ org_id: 'org-1' });
    expect(s.refreshClientIds).toEqual(['client-seeded']);
    expect(s.slice.service.getState().status).toBe('signed_in');
  });

  it('a reconnect abandoned in the browser (timeout) keeps it too', async () => {
    const s = await setupBound({ signInTimeoutMs: 100 });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'timeout' });
    expect(s.slice.service.getState()).toMatchObject({ status: 'signed_in', signInInProgress: false });
    expect(await savedClientId()).toBe('client-seeded');
    await expect(s.slice.mcp.callTool('get_account_summary', {})).resolves.toMatchObject({ org_id: 'org-1' });
    expect(s.refreshClientIds).toEqual(['client-seeded']);
  });

  it('a registration made because the saved port is busy is not saved before the reconnect succeeds', async () => {
    const busy = await busyPort();
    try {
      const s = await setupBound({ client: { redirect_port: busy.port, redirect_uri: `http://127.0.0.1:${busy.port}/callback` } });
      const pending = s.slice.api.signIn();
      await waitFor(() => t.platform.opened.length === 1);
      expect(new URL(t.platform.opened[0]!).searchParams.get('client_id')).toBe('client-new-1');
      expect(await savedClientId()).toBe('client-seeded'); // nothing overwritten before consent
      await s.slice.api.cancelSignIn();
      await pending;
      expect(await savedClientId()).toBe('client-seeded');
      await expect(s.slice.mcp.callTool('get_account_summary', {})).resolves.toMatchObject({ org_id: 'org-1' });
      expect(s.refreshClientIds).toEqual(['client-seeded']);
    } finally {
      await busy.close();
    }
  });

  it('a reconnect declined in the browser after a scope change keeps the old registration', async () => {
    const s = await setupBound({ browser: declining, client: { scope: 'models:read billing:read' } });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.registrations()).toBe(1); // a new registration was needed for the new scopes...
    expect(await savedClientId()).toBe('client-seeded'); // ...but it never replaced the session's
    expect(s.slice.service.getState().status).toBe('signed_in');
    await expect(s.slice.mcp.callTool('get_account_summary', {})).resolves.toMatchObject({ org_id: 'org-1' });
    expect(s.refreshClientIds).toEqual(['client-seeded']);
  });

  it('sign-out after a cancelled reconnect still revokes with the session’s client', async () => {
    const s = await setupBound({ tokens: { expires_at: Date.now() + 3_600_000 } });
    const pending = s.slice.api.signIn();
    await waitFor(() => t.platform.opened.length === 1);
    await s.slice.api.cancelSignIn();
    await pending;
    await s.slice.api.signOut();
    const revocations = s.fake.requests.filter((r) => r.url === REVOKE_URL).map((r) => Object.fromEntries(form(r)));
    expect(revocations).toEqual([
      { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'client-seeded' },
      { token: 'access-1', token_type_hint: 'access_token', client_id: 'client-seeded' },
    ]);
  });

  it('a successful reconnect saves the new registration after its tokens, and refreshes with it from then on', async () => {
    const busy = await busyPort();
    try {
      const pages: Array<Promise<Response>> = [];
      const s = await setupBound({
        browser: approvingBrowser(pages),
        client: { redirect_port: busy.port, redirect_uri: `http://127.0.0.1:${busy.port}/callback` },
        tokens: { expires_at: Date.now() + 3_600_000 },
      });
      await expect(s.slice.api.signIn()).resolves.toMatchObject({ status: 'signed_in', signInInProgress: false });
      expect(await savedClientId()).toBe('client-new-1');
      expect(await savedTokens()).toMatchObject({ access_token: 'access-2', refresh_token: 'refresh-2', client_id: 'client-new-1' });
      // GMI drops the access token early: the forced refresh must use the client the tokens belong to.
      s.valid.delete('access-2');
      await expect(s.slice.mcp.callTool('get_account_summary', {})).resolves.toMatchObject({ org_id: 'org-1' });
      expect(s.refreshClientIds).toEqual(['client-new-1']);
    } finally {
      await busy.close();
    }
  });

  it('tokens remember their client: a refresh uses it even when another registration is saved', async () => {
    const s = await setupBound({ client: { client_id: 'client-other' }, tokens: { client_id: 'client-seeded' } });
    await expect(s.slice.mcp.callTool('get_account_summary', {})).resolves.toMatchObject({ org_id: 'org-1' });
    expect(s.refreshClientIds).toEqual(['client-seeded']);
    expect(await savedTokens()).toMatchObject({ access_token: 'access-2', client_id: 'client-seeded' });
  });
});

describe('scopes GMI refuses', () => {
  /** GMI's metadata advertising an inference scope it then refuses to grant this client. */
  const advertising = (extra: string[]): FakeRoute => ({
    match: exact(`${ISSUER}/.well-known/oauth-authorization-server`),
    respond: () => jsonResponse({ ...asMetadata, scopes_supported: [...asMetadata.scopes_supported, ...extra] }),
  });
  const requestedScopes = (url: string) => new URL(url).searchParams.get('scope');

  it('registration refused for an extra scope: registers again with the known scopes, no browser round trip lost', async () => {
    const pages: Array<Promise<Response>> = [];
    const bodies: string[] = [];
    const s = await setup({
      browser: approvingBrowser(pages),
      routes: [
        advertising(['inference:write']),
        {
          match: exact(REGISTER_URL),
          method: 'POST',
          respond: (req) => {
            const body = JSON.parse(req.body!) as { scope: string; redirect_uris: string[] };
            bodies.push(body.scope);
            if (body.scope.includes('inference:write')) return jsonResponse({ error: 'invalid_client_metadata', error_description: 'scope not allowed' }, 400);
            return jsonResponse({ client_id: 'client-known', redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, 201);
          },
        },
      ],
    });
    const state = await s.slice.api.signIn();
    expect(state.status).toBe('signed_in');
    expect(bodies).toEqual([`${ALL_SCOPES} inference:write`, ALL_SCOPES]);
    expect(t.platform.opened).toHaveLength(1);
    expect(requestedScopes(t.platform.opened[0]!)).toBe(ALL_SCOPES);
  });

  it('authorization refused for an extra scope: says so, and the next sign-in asks only for the known scopes', async () => {
    const pages: Array<Promise<Response>> = [];
    let refuse = true;
    const s = await setup({
      routes: [advertising(['inference:write'])],
      browser: (authUrl) => {
        if (refuse && authUrl.searchParams.get('scope')!.includes('inference:write')) {
          const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
          redirect.searchParams.set('error', 'invalid_scope');
          redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
          void fetch(redirect).catch(() => undefined);
          return;
        }
        approvingBrowser(pages)(authUrl);
      },
    });
    await expect(s.slice.api.signIn()).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/asks only for the standard ones/) });
    expect(requestedScopes(t.platform.opened[0]!)).toBe(`${ALL_SCOPES} inference:write`);
    refuse = false;
    await expect(s.slice.api.signIn()).resolves.toMatchObject({ status: 'signed_in' });
    expect(requestedScopes(t.platform.opened[1]!)).toBe(ALL_SCOPES);
  });

  it('a saved registration whose scopes only differ in order is reused (no new registration)', async () => {
    const pages: Array<Promise<Response>> = [];
    const s = await setup({ browser: approvingBrowser(pages) });
    const port = await freePort();
    await seedClient(t.ctx.secure, {
      redirect_port: port,
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      scope: ALL_SCOPES.split(' ').reverse().join(' '),
    });
    await s.slice.api.signIn();
    expect(s.registrations()).toBe(0);
    expect(new URL(t.platform.opened[0]!).searchParams.get('client_id')).toBe('client-seeded');
  });
});
