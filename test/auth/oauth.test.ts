import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { USER_AGENT } from '@shared/app';
import { silentLogger } from '@main/core/logger';
import {
  authorizationErrorToGmiError,
  createOAuthClient,
  FALLBACK_SERVER_METADATA,
  isTrustedAuthServer,
  oauthErrorToGmiError,
  OAuthRequestError,
  sameIssuer,
} from '@main/services/auth/oauth';
import type { StoredClient } from '@main/services/auth/secrets';
import { createFakeFetch, jsonResponse } from '../helpers/fetch';
import { ALL_SCOPES, discoveryRoutes, exact, form, ISSUER, MCP_URL, REGISTER_URL, REVOKE_URL, TOKEN_URL, tokenResponse } from './helpers';

const NOW = new Date('2026-10-31T12:00:00Z');
const client: StoredClient = {
  client_id: 'client-1',
  redirect_uri: 'http://127.0.0.1:43123/callback',
  redirect_port: 43123,
  issuer: ISSUER,
  scope: ALL_SCOPES,
  registered_at: NOW.toISOString(),
};

function makeClient(routes = discoveryRoutes()) {
  const fake = createFakeFetch(routes);
  const oauth = createOAuthClient({ fetch: fake.fetch, userAgent: USER_AGENT, log: silentLogger, now: () => NOW });
  return { fake, oauth };
}

describe('OAuth discovery', () => {
  it('discovers GMI from the protected-resource and authorization-server metadata', async () => {
    const { fake, oauth } = makeClient();
    const server = await oauth.discover();
    expect(server.issuer).toBe(ISSUER);
    expect(server.resource).toBe(MCP_URL);
    expect(server.metadata.token_endpoint).toBe(TOKEN_URL);
    expect(server.metadata.registration_endpoint).toBe(REGISTER_URL);
    expect(fake.requests.map((r) => r.url)).toEqual([
      'https://mcp.gmicloud.ai/.well-known/oauth-protected-resource/mcp',
      'https://mcp.gmicloud.ai/.well-known/oauth-authorization-server',
    ]);
    for (const req of fake.requests) expect(req.headers['user-agent']).toBe(USER_AGENT);
    // cached
    await oauth.discover();
    expect(fake.requests).toHaveLength(2);
  });

  it('falls back to the built-in endpoints when GMI publishes no metadata', async () => {
    const { oauth } = makeClient([{ match: () => true, respond: () => new Response('nope', { status: 404 }) }]);
    const server = await oauth.discover();
    expect(server.metadata).toEqual(FALLBACK_SERVER_METADATA);
    expect(server.issuer).toBe(ISSUER);
  });

  it('shares one discovery between callers; one caller cancelling does not cancel it for the others', async () => {
    let releaseMetadata!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const [pr, as] = discoveryRoutes();
    const { fake, oauth } = makeClient([
      pr!,
      {
        match: as!.match,
        respond: async (req) => {
          await gate;
          return as!.respond(req);
        },
      },
    ]);
    const controller = new AbortController();
    const cancelled = oauth.discover(controller.signal);
    const other = oauth.discover();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    releaseMetadata();
    await expect(other).resolves.toMatchObject({ issuer: ISSUER });
    expect(fake.requests.filter((r) => r.url.endsWith('/oauth-authorization-server'))).toHaveLength(1);
  });

  it('fails with a network error when GMI is unreachable', async () => {
    const fake = createFakeFetch();
    const oauth = createOAuthClient({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      userAgent: USER_AGENT,
      log: silentLogger,
      now: () => NOW,
    });
    void fake;
    await expect(oauth.discover()).rejects.toMatchObject({ code: 'network' });
  });

  it('refuses an authorization server outside gmicloud.ai', async () => {
    const { oauth } = makeClient([
      {
        match: (u) => u.includes('oauth-protected-resource'),
        respond: () => jsonResponse({ resource: MCP_URL, authorization_servers: ['https://login.evil.example'] }),
      },
      {
        match: (u) => u.startsWith('https://login.evil.example/.well-known/oauth-authorization-server'),
        respond: () =>
          jsonResponse({
            issuer: 'https://login.evil.example',
            authorization_endpoint: 'https://login.evil.example/authorize',
            token_endpoint: 'https://login.evil.example/token',
            response_types_supported: ['code'],
          }),
      },
    ]);
    await expect(oauth.discover()).rejects.toMatchObject({ code: 'upstream' });
    expect(isTrustedAuthServer('https://mcp.gmicloud.ai')).toBe(true);
    expect(isTrustedAuthServer('https://auth.gmicloud.ai/x')).toBe(true);
    expect(isTrustedAuthServer('http://mcp.gmicloud.ai')).toBe(false);
    expect(isTrustedAuthServer('https://gmicloud.ai.evil.example')).toBe(false);
    expect(sameIssuer('https://mcp.gmicloud.ai/', 'https://mcp.gmicloud.ai')).toBe(true);
  });
});

describe('OAuth requests', () => {
  it('registers a public client for the loopback redirect (lenient response parsing)', async () => {
    const { fake, oauth } = makeClient([
      ...discoveryRoutes(),
      { match: exact(REGISTER_URL), method: 'POST', respond: () => jsonResponse({ client_id: 'client-xyz' }, 201) },
    ]);
    const server = await oauth.discover();
    const registered = await oauth.register(server, 'http://127.0.0.1:50123/callback');
    expect(registered).toMatchObject({ client_id: 'client-xyz', redirect_port: 50123, redirect_uri: 'http://127.0.0.1:50123/callback', issuer: ISSUER, scope: ALL_SCOPES });
    const req = fake.requests.find((r) => r.url === REGISTER_URL)!;
    expect(req.headers['user-agent']).toBe(USER_AGENT);
    expect(JSON.parse(req.body!)).toMatchObject({
      client_name: 'GMI Desk',
      redirect_uris: ['http://127.0.0.1:50123/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: ALL_SCOPES,
    });
  });

  it('maps registration errors', async () => {
    const { oauth } = makeClient([
      ...discoveryRoutes(),
      { match: exact(REGISTER_URL), respond: () => jsonResponse({ error: 'invalid_redirect_uri', error_description: 'bad uri' }, 400) },
    ]);
    await expect(oauth.register(await oauth.discover(), 'http://127.0.0.1:1/callback')).rejects.toMatchObject({ code: 'invalid_input', message: 'bad uri' });
  });

  it('builds a PKCE S256 authorization URL with state, every scope and the resource indicator', async () => {
    const { oauth } = makeClient();
    const server = await oauth.discover();
    const { url, codeVerifier } = await oauth.authorizationUrl(server, client, 'state-abc');
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://mcp.gmicloud.ai/authorize');
    const p = u.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('client-1');
    expect(p.get('redirect_uri')).toBe(client.redirect_uri);
    expect(p.get('state')).toBe('state-abc');
    expect(p.get('scope')).toBe(ALL_SCOPES);
    expect(p.get('resource')).toBe(MCP_URL);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    expect(p.get('code_challenge')).toBe(expected);
  });

  it('exchanges the code with the verifier, redirect URI, client id and resource', async () => {
    const { fake, oauth } = makeClient([
      ...discoveryRoutes(),
      { match: exact(TOKEN_URL), method: 'POST', respond: () => tokenResponse('access-new', { refresh_token: 'refresh-new', scope: 'models:read billing:read' }) },
    ]);
    const server = await oauth.discover();
    const tokens = await oauth.exchangeCode(server, client, 'code-1', 'verifier-1');
    expect(tokens).toEqual({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
      expires_at: NOW.getTime() + 3_600_000,
      scope: 'models:read billing:read',
      token_type: 'Bearer',
    });
    const req = fake.requests.find((r) => r.url === TOKEN_URL)!;
    expect(req.headers['user-agent']).toBe(USER_AGENT);
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = form(req);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      code_verifier: 'verifier-1',
      redirect_uri: client.redirect_uri,
      resource: MCP_URL,
      client_id: 'client-1',
    });
  });

  it('refreshes (keeping the refresh token and scope when GMI omits them)', async () => {
    const { fake, oauth } = makeClient([
      ...discoveryRoutes(),
      { match: exact(TOKEN_URL), method: 'POST', respond: () => jsonResponse({ access_token: 'access-2', token_type: 'Bearer', expires_in: 60 }) },
    ]);
    const server = await oauth.discover();
    const next = await oauth.refresh(server, client, { access_token: 'a', refresh_token: 'r-1', expires_at: 0, scope: 'models:read', token_type: 'Bearer' });
    expect(next).toMatchObject({ access_token: 'access-2', refresh_token: 'r-1', scope: 'models:read', expires_at: NOW.getTime() + 60_000 });
    expect(Object.fromEntries(form(fake.requests.at(-1)!))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r-1', resource: MCP_URL, client_id: 'client-1' });
  });

  it('maps refresh failures: invalid_grant / 401 → reauth_required, 5xx → upstream', async () => {
    const make = (res: () => Response) =>
      makeClient([...discoveryRoutes(), { match: exact(TOKEN_URL), respond: res }]).oauth;
    const current = { access_token: 'a', refresh_token: 'r', expires_at: 0, scope: ALL_SCOPES, token_type: 'Bearer' };

    const grant = make(() => jsonResponse({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400));
    const err = await grant.refresh(await grant.discover(), client, current).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthRequestError);
    expect(err).toMatchObject({ code: 'reauth_required', oauthCode: 'invalid_grant' });

    const unauthorized = make(() => new Response('Unauthorized', { status: 401 }));
    await expect(unauthorized.refresh(await unauthorized.discover(), client, current)).rejects.toMatchObject({ code: 'reauth_required', status: 401 });

    const invalidClient = make(() => jsonResponse({ error: 'invalid_client' }, 401));
    await expect(invalidClient.refresh(await invalidClient.discover(), client, current)).rejects.toMatchObject({ code: 'reauth_required', oauthCode: 'invalid_client' });

    const down = make(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(down.refresh(await down.discover(), client, current)).rejects.toMatchObject({ code: 'upstream' });

    const garbage = make(() => jsonResponse({ token_type: 'Bearer' }));
    await expect(garbage.refresh(await garbage.discover(), client, current)).rejects.toMatchObject({ code: 'upstream' });
  });

  it('revokes with client_id, token and token_type_hint', async () => {
    const { fake, oauth } = makeClient([...discoveryRoutes(), { match: exact(REVOKE_URL), method: 'POST', respond: () => new Response(null, { status: 200 }) }]);
    await oauth.revoke(await oauth.discover(), client, 'refresh-1', 'refresh_token');
    const req = fake.requests.at(-1)!;
    expect(req.url).toBe(REVOKE_URL);
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(form(req))).toEqual({ token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'client-1' });
  });
});

describe('OAuth error mapping', () => {
  it('maps authorization-response errors', () => {
    expect(authorizationErrorToGmiError('access_denied', 'nope')).toMatchObject({ code: 'cancelled', message: 'Sign-in was declined in the browser.' });
    expect(authorizationErrorToGmiError('temporarily_unavailable', null)).toMatchObject({ code: 'upstream' });
    expect(authorizationErrorToGmiError('invalid_scope', 'scope x unknown')).toMatchObject({ code: 'invalid_input', message: 'scope x unknown' });
    expect(authorizationErrorToGmiError('weird', null)).toMatchObject({ code: 'unauthorized' });
  });

  it('maps token-endpoint failures by phase', () => {
    const grant = Object.assign(new Error('expired code'), { errorCode: 'invalid_grant' });
    expect(oauthErrorToGmiError(grant, 400, 'exchange')).toMatchObject({ code: 'unauthorized' });
    expect(oauthErrorToGmiError(grant, 400, 'refresh')).toMatchObject({ code: 'reauth_required' });
    expect(oauthErrorToGmiError(new Error('HTTP 429: slow'), 429, 'refresh')).toMatchObject({ code: 'rate_limited' });
    expect(oauthErrorToGmiError(Object.assign(new Error('x'), { name: 'ZodError' }), 200, 'exchange')).toMatchObject({ code: 'upstream' });
  });
});
