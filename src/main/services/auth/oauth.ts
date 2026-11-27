/**
 * OAuth 2.1 client for GMI's authorization server (https://mcp.gmicloud.ai): RFC 9728/8414 discovery,
 * RFC 7591 dynamic client registration, PKCE (S256) authorization URL, code exchange, refresh and
 * RFC 7009 revocation. Every request carries the app's User-Agent and the RFC 8707 resource indicator.
 */
import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { APP_ID, APP_NAME, APP_VERSION } from '@shared/app';
import { GmiError, type GmiErrorCode } from '@shared/contracts/errors';
import type { FetchLike } from '../../core/http';
import type { Logger } from '../../core/logger';
import { GMI_MCP_RESOURCE, GMI_OAUTH_ISSUER, OAUTH_REQUEST_TIMEOUT_MS, REQUESTED_SCOPE, requestedScopeFor } from './constants';
import { createWrappedFetch, raceAbort, trackStatus } from './fetch';
import { tokensFromResponse, type StoredClient, type StoredTokens } from './secrets';

export interface OAuthServerInfo {
  /** Issuer identifier from the authorization server metadata. */
  issuer: string;
  metadata: AuthorizationServerMetadata;
  /** RFC 8707 resource indicator for the MCP server. */
  resource: string;
  /**
   * Scope string to register and request: the known scopes plus the inference / key-read scopes the server
   * advertises (`requestedScopeFor`), so a scope GMI adds later (e.g. inference) is asked for without an app update.
   * Only the known scopes after GMI refused the extra ones (`restrictToKnownScopes`).
   */
  scope: string;
}

/** Endpoints published by GMI (verified 2026-10-31); used only when discovery returns nothing usable. */
export const FALLBACK_SERVER_METADATA: AuthorizationServerMetadata = {
  issuer: GMI_OAUTH_ISSUER,
  authorization_endpoint: `${GMI_OAUTH_ISSUER}/authorize`,
  token_endpoint: `${GMI_OAUTH_ISSUER}/token`,
  registration_endpoint: `${GMI_OAUTH_ISSUER}/register`,
  revocation_endpoint: `${GMI_OAUTH_ISSUER}/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
};

/** GMI refused the requested scope (at registration or authorization). */
export function isScopeRejection(error: unknown): boolean {
  return error instanceof OAuthRequestError && (error.oauthCode === 'invalid_scope' || error.oauthCode === 'invalid_client_metadata');
}

/** A GmiError that also remembers the OAuth `error` code (e.g. invalid_grant, invalid_client). */
export class OAuthRequestError extends GmiError {
  readonly oauthCode: string | null;

  constructor(code: GmiErrorCode, message: string, opts: { oauthCode?: string | null; status?: number | null; detail?: string | null; cause?: unknown } = {}) {
    super(code, message, { status: opts.status ?? null, detail: opts.detail ?? null, cause: opts.cause });
    this.oauthCode = opts.oauthCode ?? null;
  }
}

/** Authorization servers the app will talk to: https on gmicloud.ai or a subdomain. */
export function isTrustedAuthServer(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'gmicloud.ai' || url.hostname.endsWith('.gmicloud.ai'));
  } catch {
    return false;
  }
}

/** Compares issuer identifiers, tolerating one trailing slash (RFC 8414 §3.3 / RFC 9207 §2.4). */
export function sameIssuer(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function oauthCodeOf(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' && code ? code : null;
}

function cleanDescription(text: string): string {
  // The SDK prefixes non-OAuth bodies with "HTTP 401: Invalid OAuth error response: ... Raw body: ...".
  const raw = text.replace(/^HTTP \d{3}:\s*/, '');
  const body = /Raw body:\s*([\s\S]*)$/.exec(raw)?.[1] ?? raw;
  return body.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
}

export type OAuthPhase = 'discover' | 'register' | 'exchange' | 'refresh';

/** Maps SDK/OAuth failures (OAuthError subclasses, ServerError, zod, network) to GmiError. */
export function oauthErrorToGmiError(error: unknown, status: number | null, phase: OAuthPhase): GmiError {
  if (error instanceof GmiError) return error;
  const oauthCode = oauthCodeOf(error);
  const description = cleanDescription(error instanceof Error ? error.message : String(error ?? ''));
  const detail = description || null;
  const opts = { oauthCode, status, detail, cause: error };

  if ((error as { name?: unknown } | null)?.name === 'ZodError' || error instanceof SyntaxError) {
    return new OAuthRequestError('upstream', 'GMI returned an unexpected sign-in response.', { ...opts, detail: null });
  }
  const grantDead = oauthCode === 'invalid_grant' || oauthCode === 'invalid_token' || oauthCode === 'invalid_client' || oauthCode === 'unauthorized_client';
  if (grantDead || status === 401) {
    if (phase === 'refresh') return new OAuthRequestError('reauth_required', 'Your GMI sign-in expired. Sign in again.', opts);
    if (phase === 'exchange') return new OAuthRequestError('unauthorized', 'GMI did not accept the sign-in. Try again.', opts);
    return new OAuthRequestError('unauthorized', description || 'GMI refused the sign-in request.', opts);
  }
  if (oauthCode === 'access_denied') return new OAuthRequestError('cancelled', 'Sign-in was declined.', opts);
  if (oauthCode === 'invalid_scope') return new OAuthRequestError('invalid_input', 'GMI did not accept the requested permissions.', opts);
  if (status === 429 || oauthCode === 'slow_down') return new OAuthRequestError('rate_limited', 'GMI is rate-limiting sign-in. Try again shortly.', opts);
  if (oauthCode === 'temporarily_unavailable' || oauthCode === 'server_error' || (status !== null && status >= 500)) {
    return new OAuthRequestError('upstream', 'GMI sign-in is temporarily unavailable. Try again.', opts);
  }
  if (status === 400 || oauthCode === 'invalid_request' || oauthCode === 'invalid_client_metadata' || oauthCode === 'invalid_redirect_uri') {
    return new OAuthRequestError('invalid_input', description || 'GMI rejected the sign-in request.', opts);
  }
  return new OAuthRequestError('upstream', description || 'GMI sign-in failed.', opts);
}

/** Maps the `error` parameter of an authorization response (RFC 6749 §4.1.2.1). */
export function authorizationErrorToGmiError(error: string, description: string | null): GmiError {
  const desc = description ? cleanDescription(description) : '';
  const opts = { oauthCode: error, detail: desc || null };
  if (error === 'access_denied') return new OAuthRequestError('cancelled', 'Sign-in was declined in the browser.', opts);
  if (error === 'invalid_scope') return new OAuthRequestError('invalid_input', desc || 'GMI did not accept the requested permissions.', opts);
  if (error === 'temporarily_unavailable' || error === 'server_error') {
    return new OAuthRequestError('upstream', desc || 'GMI sign-in is temporarily unavailable. Try again.', opts);
  }
  return new OAuthRequestError('unauthorized', desc || `GMI returned an error (${error.slice(0, 60)}).`, opts);
}

export interface OAuthClient {
  discover(signal?: AbortSignal): Promise<OAuthServerInfo>;
  register(server: OAuthServerInfo, redirectUri: string, signal?: AbortSignal): Promise<StoredClient>;
  authorizationUrl(server: OAuthServerInfo, client: StoredClient, state: string): Promise<{ url: string; codeVerifier: string }>;
  exchangeCode(server: OAuthServerInfo, client: StoredClient, code: string, codeVerifier: string, signal?: AbortSignal): Promise<StoredTokens>;
  /** Refresh and revocation only need the client id (public client): pass the one the tokens were issued to. */
  refresh(server: OAuthServerInfo, client: Pick<StoredClient, 'client_id'>, current: StoredTokens): Promise<StoredTokens>;
  /** RFC 7009. Resolves when GMI accepted the request; throws otherwise. */
  revoke(server: OAuthServerInfo, client: Pick<StoredClient, 'client_id'>, token: string, hint: 'access_token' | 'refresh_token', timeoutMs?: number): Promise<void>;
  /** Forgets cached discovery results (next call re-discovers). */
  forget(): void;
  /**
   * GMI refused the extra advertised scopes: from now on (this run of the app) register and authorize with the six
   * known scopes only. Returns whether that changes what is requested.
   */
  restrictToKnownScopes(): boolean;
}

export function createOAuthClient(deps: { fetch: FetchLike; userAgent: string; log: Logger; now: () => Date }): OAuthClient {
  const log = deps.log.child('oauth');
  let cached: OAuthServerInfo | null = null;
  let discovering: Promise<OAuthServerInfo> | null = null;
  let knownOnly = false;
  const withScope = (info: OAuthServerInfo): OAuthServerInfo => (knownOnly ? { ...info, scope: REQUESTED_SCOPE } : info);

  const fetchFor = (signal?: AbortSignal, timeoutMs = OAUTH_REQUEST_TIMEOUT_MS) =>
    createWrappedFetch(deps.fetch, { userAgent: deps.userAgent, signal, timeoutMs });

  /** Shared by every caller (sign-in, refresh, revocation), so it never carries one caller's signal. */
  async function runDiscovery(): Promise<OAuthServerInfo> {
    let authServerUrl = GMI_OAUTH_ISSUER;
    let metadata: AuthorizationServerMetadata | undefined;
    let resource: string | undefined;
    try {
      const info = await discoverOAuthServerInfo(GMI_MCP_RESOURCE, { fetchFn: fetchFor() });
      authServerUrl = info.authorizationServerUrl;
      metadata = info.authorizationServerMetadata;
      resource = info.resourceMetadata?.resource;
    } catch (error) {
      if (error instanceof GmiError) throw error; // network / timeout / cancelled
      log.warn('OAuth discovery failed; using the built-in GMI endpoints', error);
    }
    if (!isTrustedAuthServer(authServerUrl)) {
      throw new GmiError('upstream', 'GMI pointed sign-in at an unexpected server, so the app stopped.', { detail: authServerUrl });
    }
    if (!metadata) {
      if (!sameIssuer(authServerUrl, GMI_OAUTH_ISSUER)) {
        throw new GmiError('upstream', 'Could not load GMI sign-in settings. Try again later.');
      }
      metadata = FALLBACK_SERVER_METADATA;
    }
    if (!sameIssuer(metadata.issuer, authServerUrl)) {
      throw new GmiError('upstream', 'GMI sign-in settings are inconsistent (issuer mismatch).', { detail: `${metadata.issuer} ≠ ${authServerUrl}` });
    }
    if (!isTrustedAuthServer(metadata.authorization_endpoint) || !isTrustedAuthServer(metadata.token_endpoint)) {
      throw new GmiError('upstream', 'GMI sign-in endpoints are not on gmicloud.ai, so the app stopped.');
    }
    const challenges = metadata.code_challenge_methods_supported;
    if (challenges && !challenges.includes('S256')) {
      throw new GmiError('upstream', 'GMI sign-in no longer supports PKCE S256.');
    }
    if (resource && !sameIssuer(resource, GMI_MCP_RESOURCE)) {
      log.warn('protected resource metadata names a different resource; using the MCP URL', { resource });
    }
    return { issuer: metadata.issuer, metadata, resource: GMI_MCP_RESOURCE, scope: requestedScopeFor(metadata) };
  }

  return {
    async discover(signal) {
      if (cached) return withScope(cached);
      if (!discovering) {
        const run = runDiscovery()
          .then((info) => {
            cached = info;
            return info;
          })
          .finally(() => {
            if (discovering === run) discovering = null;
          });
        run.catch(() => undefined); // every caller may have given up already
        discovering = run;
      }
      return withScope(await raceAbort(discovering, signal, 'Sign-in was cancelled.'));
    },

    async register(server, redirectUri, signal) {
      const endpoint = server.metadata.registration_endpoint;
      if (!endpoint || !isTrustedAuthServer(endpoint)) {
        throw new GmiError('upstream', 'GMI does not offer app registration for sign-in.');
      }
      const tracked = trackStatus(fetchFor(signal));
      let text = '';
      let status: number | null = null;
      try {
        const res = await tracked.fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_name: APP_NAME,
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: server.scope,
            software_id: APP_ID,
            software_version: APP_VERSION,
          }),
        });
        status = res.status;
        text = await res.text();
        if (!res.ok) {
          let body: { error?: unknown; error_description?: unknown } = {};
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            // not JSON
          }
          const code = typeof body.error === 'string' ? body.error : null;
          const description = typeof body.error_description === 'string' ? body.error_description : text.slice(0, 300);
          throw oauthErrorToGmiError(Object.assign(new Error(description), { errorCode: code }), status, 'register');
        }
      } catch (error) {
        throw oauthErrorToGmiError(error, status ?? tracked.lastStatus(), 'register');
      }
      let parsed: { client_id?: unknown };
      try {
        parsed = JSON.parse(text) as { client_id?: unknown };
      } catch (error) {
        throw new GmiError('upstream', 'GMI returned an unexpected registration response.', { cause: error });
      }
      if (typeof parsed.client_id !== 'string' || !parsed.client_id) {
        throw new GmiError('upstream', 'GMI did not return a client id for this app.');
      }
      const port = Number(new URL(redirectUri).port);
      return {
        client_id: parsed.client_id,
        redirect_uri: redirectUri,
        redirect_port: port,
        issuer: server.issuer,
        scope: server.scope,
        registered_at: deps.now().toISOString(),
      };
    },

    async authorizationUrl(server, client, state) {
      const { authorizationUrl, codeVerifier } = await startAuthorization(server.issuer, {
        metadata: server.metadata,
        clientInformation: { client_id: client.client_id },
        redirectUrl: client.redirect_uri,
        scope: server.scope,
        state,
        resource: server.resource,
      });
      return { url: authorizationUrl.toString(), codeVerifier };
    },

    async exchangeCode(server, client, code, codeVerifier, signal) {
      const tracked = trackStatus(fetchFor(signal));
      try {
        const res = await exchangeAuthorization(server.issuer, {
          metadata: server.metadata,
          clientInformation: { client_id: client.client_id },
          authorizationCode: code,
          codeVerifier,
          redirectUri: client.redirect_uri,
          resource: server.resource,
          fetchFn: tracked.fetch,
        });
        return tokensFromResponse(res, deps.now(), { scope: server.scope });
      } catch (error) {
        throw oauthErrorToGmiError(error, tracked.lastStatus(), 'exchange');
      }
    },

    async refresh(server, client, current) {
      if (!current.refresh_token) throw new GmiError('reauth_required', 'Your GMI sign-in expired. Sign in again.');
      const tracked = trackStatus(fetchFor());
      try {
        const res = await refreshAuthorization(server.issuer, {
          metadata: server.metadata,
          clientInformation: { client_id: client.client_id },
          refreshToken: current.refresh_token,
          resource: server.resource,
          fetchFn: tracked.fetch,
        });
        return tokensFromResponse(res, deps.now(), { scope: current.scope, refreshToken: current.refresh_token });
      } catch (error) {
        throw oauthErrorToGmiError(error, tracked.lastStatus(), 'refresh');
      }
    },

    async revoke(server, client, token, hint, timeoutMs = 5_000) {
      const raw = (server.metadata as { revocation_endpoint?: unknown }).revocation_endpoint;
      const endpoint = typeof raw === 'string' ? raw : null;
      if (!endpoint || !isTrustedAuthServer(endpoint)) return;
      const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id });
      const res = await fetchFor(undefined, timeoutMs)(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new GmiError('upstream', `GMI did not revoke the ${hint.replace('_', ' ')} (HTTP ${res.status}).`, { status: res.status });
    },

    forget() {
      cached = null;
    },

    restrictToKnownScopes() {
      if (knownOnly) return false;
      knownOnly = true;
      // Unknown until discovery ran: assume the extra scopes were the problem.
      return cached === null || cached.scope !== REQUESTED_SCOPE;
    },
  };
}
