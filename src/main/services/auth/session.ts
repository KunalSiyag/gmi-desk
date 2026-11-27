/**
 * The GMI OAuth session: sign-in (discover → register → PKCE → browser → loopback → exchange),
 * cancel, sign-out with revocation, restore on startup, and the reauth_required transition.
 */
import { randomBytes } from 'node:crypto';
import { APP_NAME } from '@shared/app';
import type { AuthState, AuthStatus } from '@shared/contracts/auth';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { AppContext } from '../../core/context';
import type { JsonStore } from '../../core/store';
import { scopeSet, SIGN_IN_LOCKED_MESSAGE, SIGN_IN_TIMEOUT_MS } from './constants';
import { startLoopbackServer, type LoopbackServer } from './loopback';
import { isScopeRejection, OAuthRequestError, sameIssuer, type OAuthClient } from './oauth';
import { deleteClient, readClient, readClientWithStatus, scopesOf, writeClient, type StoredClient, type StoredTokens } from './secrets';
import { isoFromEpoch, type AuthFile, type AuthStateHub } from './state';
import { TokenManager } from './tokens';

export interface SessionDeps {
  ctx: AppContext;
  hub: AuthStateHub;
  file: JsonStore<AuthFile>;
  oauth: OAuthClient;
  signInTimeoutMs?: number;
  /** A new session started (fresh tokens): e.g. learn the organisation id. */
  onSessionStarted?(): void;
  /** The session ended (sign-out or dead grant): drop shared MCP connections. */
  onSessionEnded?(): void | Promise<void>;
}

export interface Session {
  readonly tokens: TokenManager;
  restore(): Promise<void>;
  signIn(): Promise<AuthState>;
  cancelSignIn(): Promise<AuthState>;
  signOut(): Promise<AuthState>;
  /** The grant is dead: forget tokens and ask the user to sign in again. */
  markReauthRequired(reason: string): Promise<void>;
  /** Throws not_signed_in / reauth_required when there is no usable session. */
  assertSession(): void;
  /** Reads a saved sign-in the OS keychain would not decrypt earlier again (after the user unlocked it). */
  retryLocked(): Promise<void>;
  dispose(): Promise<void>;
}

interface Flow {
  controller: AbortController;
  promise: Promise<AuthState>;
  /** Authorization URL once built (signIn() during a flow reopens it). */
  authUrl: string | null;
}

const EXPIRED_MESSAGE = 'Your GMI sign-in expired. Sign in again.';

export function createSession(deps: SessionDeps): Session {
  const { ctx, hub, file, oauth } = deps;
  const log = ctx.log.child('auth');
  let flow: Flow | null = null;

  const settledStatus = (): AuthStatus => {
    if (tokens.current) return 'signed_in';
    return file.get().reauthRequired ? 'reauth_required' : 'signed_out';
  };

  /** lastError while nothing is happening: says why a saved sign-in is not in use when the keychain is locked. */
  const restingError = (): string | null => (!tokens.current && tokens.storedUnreadable ? SIGN_IN_LOCKED_MESSAGE : null);

  /** Drops shared MCP connections (after the state already says the session is over). */
  async function endConnections(): Promise<void> {
    try {
      await deps.onSessionEnded?.();
    } catch (error) {
      log.warn('could not close the MCP connections', error);
    }
  }

  async function endWithReauth(reason: string): Promise<void> {
    if (hub.runtime.status === 'signed_out' && !flow) return; // a sign-out won the race
    await tokens.clear();
    await file.update((f) => ({ ...f, reauthRequired: true }));
    hub.update({ status: flow ? 'signing_in' : 'reauth_required', scopes: [], accessTokenExpiresAt: null, lastError: reason });
    await endConnections();
  }

  /**
   * The client id that refreshes and revokes `current`: the one the tokens were issued to, or (tokens saved by
   * older versions) the saved registration's. Null when neither is known.
   */
  async function clientIdFor(current: StoredTokens): Promise<string | null> {
    if (current.client_id) return current.client_id;
    const { client, status } = await readClientWithStatus(ctx.secure);
    // Locked keychain: a transient failure, not a dead grant (that would delete the tokens).
    if (status === 'unreadable') throw new GmiError('internal', SIGN_IN_LOCKED_MESSAGE);
    return client?.client_id ?? null;
  }

  /** Deletes the saved registration, but only when it is `clientId` (never one saved for another session). */
  async function forgetClient(clientId: string): Promise<void> {
    try {
      const { client } = await readClientWithStatus(ctx.secure);
      if (client?.client_id === clientId) await deleteClient(ctx.secure);
    } catch (error) {
      log.warn('could not forget the client registration', error);
    }
  }

  const tokens: TokenManager = new TokenManager({
    secure: ctx.secure,
    now: () => ctx.now(),
    log,
    async refresh(current) {
      const server = await oauth.discover();
      const clientId = await clientIdFor(current);
      if (!clientId) throw new GmiError('reauth_required', EXPIRED_MESSAGE);
      try {
        return { ...(await oauth.refresh(server, { client_id: clientId }, current)), client_id: clientId };
      } catch (error) {
        // The registration itself is gone: register again on the next sign-in.
        if (error instanceof OAuthRequestError && error.oauthCode === 'invalid_client') await forgetClient(clientId);
        throw error;
      }
    },
    onReauthRequired: (reason) => endWithReauth(reason),
    onRefreshed: (next) => {
      hub.update({ scopes: scopesOf(next), accessTokenExpiresAt: isoFromEpoch(next.expires_at), lastError: null });
    },
    onRefreshFailed: (error) => {
      log.warn(`token refresh failed: ${error.code}`);
      hub.update({ lastError: error.message });
    },
  });

  const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) throw new GmiError('cancelled', 'Sign-in was cancelled.');
  };

  async function run(entry: Flow): Promise<AuthState> {
    const { signal } = entry.controller;
    // Reconnecting (e.g. to grant missing permissions): the live session must keep working until new tokens replace
    // it, so nothing it relies on changes before then (its tokens, the registration saved for its refreshes).
    const reconnecting = hub.runtime.status === 'signed_in';
    hub.update({ status: reconnecting ? 'signed_in' : 'signing_in', signInInProgress: true, lastError: null });
    let loopback: LoopbackServer | null = null;
    let browserOpened = false;
    let browserAnswered = false;
    let reusedClient = false;
    /** The registration this attempt uses. */
    let client: StoredClient | null = null;
    /** A registration made while reconnecting: saved only once tokens issued to it are. */
    let unsaved: StoredClient | null = null;
    try {
      let server = await oauth.discover(signal);
      client = await readClient(ctx.secure);
      // A registration for another server, or for other scopes than the app now asks for, is replaced (registered
      // again). Scopes compare as sets: GMI reordering its metadata is not a reason to register again.
      if (client && (!sameIssuer(client.issuer, server.issuer) || scopeSet(client.scope) !== scopeSet(server.scope))) client = null;
      const state = randomBytes(32).toString('base64url');
      loopback = await startLoopbackServer({
        expectedState: state,
        issuer: server.issuer,
        preferredPort: client?.redirect_port ?? null,
        timeoutMs: deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
        signal,
        appName: APP_NAME,
      });
      reusedClient = client !== null && client.redirect_port === loopback.port;
      if (!client || !reusedClient) {
        try {
          client = await oauth.register(server, loopback.redirectUri, signal);
        } catch (error) {
          // GMI refused an extra advertised scope at registration: ask again with the six known ones (no browser
          // has opened yet, so the user never sees the first attempt).
          if (!isScopeRejection(error) || !oauth.restrictToKnownScopes()) throw error;
          log.warn('GMI refused the extra scopes at registration; registering with the known scopes only');
          server = await oauth.discover(signal);
          client = await oauth.register(server, loopback.redirectUri, signal);
        }
        if (reconnecting) unsaved = client;
        else await writeClient(ctx.secure, client);
      }
      const { url, codeVerifier } = await oauth.authorizationUrl(server, client, state);
      throwIfAborted(signal);
      entry.authUrl = url;
      await ctx.platform.openExternal(url);
      browserOpened = true;

      let code: string;
      try {
        code = await loopback.code;
        browserAnswered = true;
      } catch (error) {
        browserAnswered = !signal.aborted && toGmiError(error).code !== 'timeout';
        throw error;
      }

      let fresh: StoredTokens;
      try {
        // The tokens remember their client: refreshes keep using it whatever registration is saved later.
        fresh = { ...(await oauth.exchangeCode(server, client, code, codeVerifier, signal)), client_id: client.client_id };
        throwIfAborted(signal);
      } catch (error) {
        await loopback.finish({ ok: false, message: toGmiError(error).message });
        throw error;
      }
      await tokens.set(fresh);
      if (unsaved) {
        const registration = unsaved;
        unsaved = null;
        await writeClient(ctx.secure, registration).catch((e: unknown) => log.warn('could not save the client registration', e));
      }
      await file.update((f) => ({ ...f, signedInAt: ctx.now().toISOString(), reauthRequired: false }));
      await loopback.finish({ ok: true });
      // Starts the organization lookup first so the signed_in state below already says it is pending.
      deps.onSessionStarted?.();
      const state2 = hub.update({
        status: 'signed_in',
        scopes: scopesOf(fresh),
        accessTokenExpiresAt: isoFromEpoch(fresh.expires_at),
        lastError: null,
        signInInProgress: false,
      });
      ctx.platform.focusApp();
      return state2;
    } catch (error) {
      const err = toGmiError(error);
      if (loopback) {
        await loopback.finish({ ok: false, message: signal.aborted ? 'Sign-in was cancelled.' : err.message });
        await loopback.close();
      }
      // GMI no longer knows the registration this attempt used (it said so, or its page never sent the browser
      // back): forget it so the next attempt registers again instead of failing the same way. While reconnecting,
      // an abandoned browser (cancel, timeout) is not a reason: the live session still refreshes with it.
      const unknownClient = error instanceof OAuthRequestError && (error.oauthCode === 'invalid_client' || error.oauthCode === 'unauthorized_client');
      const abandoned = !reconnecting && reusedClient && browserOpened && !browserAnswered;
      if (client && (unknownClient || abandoned)) await forgetClient(client.client_id);
      if (signal.aborted) {
        // Cancelled from the app: back to where we were, no error.
        return hub.update({ status: settledStatus(), signInInProgress: false, lastError: restingError() });
      }
      // GMI refused the extra advertised scopes in the browser: the next attempt asks only for the known ones.
      const failure =
        isScopeRejection(error) && oauth.restrictToKnownScopes()
          ? new OAuthRequestError('invalid_input', 'GMI did not accept the extra permissions GMI Desk asked for. Sign in again: it now asks only for the standard ones.', {
              oauthCode: (error as OAuthRequestError).oauthCode,
              status: err.status,
              detail: err.detail,
            })
          : err;
      log.warn(`sign-in failed: ${failure.code}`, { message: failure.message });
      hub.update({ status: settledStatus(), signInInProgress: false, lastError: failure.message });
      if (browserAnswered) ctx.platform.focusApp();
      throw failure;
    }
  }

  async function revokeQuietly(old: StoredTokens, clientId: string): Promise<void> {
    let server;
    try {
      server = await oauth.discover();
    } catch (error) {
      log.debug('skipping token revocation (discovery failed)', { code: toGmiError(error).code });
      return;
    }
    const attempts: Array<[string, 'refresh_token' | 'access_token']> = [];
    if (old.refresh_token) attempts.push([old.refresh_token, 'refresh_token']);
    attempts.push([old.access_token, 'access_token']);
    for (const [token, hint] of attempts) {
      try {
        await oauth.revoke(server, { client_id: clientId }, token, hint);
      } catch (error) {
        log.debug(`could not revoke the ${hint}`, { code: toGmiError(error).code });
      }
    }
  }

  return {
    tokens,

    async restore() {
      const stored = await tokens.load();
      const f = file.get();
      if (!stored && tokens.storedUnreadable) {
        // Saved tokens the OS keychain would not decrypt (locked keyring, another desktop session): not a sign-out.
        // auth.json (organization, sign-in time) and the file stay; retryLocked() or a new sign-in takes it from here.
        log.warn('the saved GMI sign-in could not be read (OS keychain locked or unavailable)');
        hub.runtime = {
          status: f.reauthRequired ? 'reauth_required' : 'signed_out',
          scopes: [],
          accessTokenExpiresAt: null,
          lastError: SIGN_IN_LOCKED_MESSAGE,
          signInInProgress: false,
          orgIdPending: false,
        };
        return;
      }
      if (stored) {
        if (tokens.isExpired(stored) && !stored.refresh_token) {
          hub.runtime = { ...hub.runtime, status: 'signed_in' };
          await endWithReauth(EXPIRED_MESSAGE);
          return;
        }
        if (f.reauthRequired) await file.update((x) => ({ ...x, reauthRequired: false }));
        hub.runtime = {
          status: 'signed_in',
          scopes: scopesOf(stored),
          accessTokenExpiresAt: isoFromEpoch(stored.expires_at),
          lastError: null,
          signInInProgress: false,
          orgIdPending: false,
        };
        return;
      }
      if (!f.reauthRequired && (f.signedInAt || f.orgId)) {
        // Tokens are gone (e.g. secure storage was unavailable last run): signed out.
        await file.update((x) => ({ ...x, signedInAt: null, orgId: null }));
      }
      hub.runtime = {
        status: f.reauthRequired ? 'reauth_required' : 'signed_out',
        scopes: [],
        accessTokenExpiresAt: null,
        lastError: null,
        signInInProgress: false,
        orgIdPending: false,
      };
    },

    async signIn() {
      if (flow) {
        // One sign-in at a time: a second request re-opens the browser page and joins the first.
        if (flow.authUrl) await ctx.platform.openExternal(flow.authUrl).catch((error) => log.warn('could not reopen the sign-in page', error));
        return flow.promise;
      }
      const entry: Flow = { controller: new AbortController(), authUrl: null, promise: Promise.resolve(hub.snapshot()) };
      flow = entry;
      const clear = () => {
        if (flow === entry) flow = null;
      };
      entry.promise = run(entry).then(
        (state) => {
          clear();
          return state;
        },
        (error: unknown) => {
          clear();
          throw error;
        },
      );
      return entry.promise;
    },

    async cancelSignIn() {
      const current = flow;
      if (!current) return hub.snapshot();
      current.controller.abort();
      await current.promise.catch(() => undefined);
      return hub.snapshot();
    },

    async signOut() {
      if (flow) {
        const current = flow;
        current.controller.abort();
        await current.promise.catch(() => undefined);
      }
      const old = tokens.current ?? (await tokens.load());
      const clientId = old ? await clientIdFor(old).catch(() => null) : null;
      // An explicit sign-out also forgets a saved sign-in the keychain could not read.
      await tokens.clear();
      await file.update((f) => ({ ...f, orgId: null, signedInAt: null, reauthRequired: false }));
      // Signed out as far as anyone can tell before the (quick) connection close and the revocation round trips.
      hub.update({ status: 'signed_out', scopes: [], accessTokenExpiresAt: null, lastError: null, signInInProgress: false });
      await endConnections();
      if (old && clientId) await revokeQuietly(old, clientId);
      return hub.snapshot();
    },

    markReauthRequired: endWithReauth,

    assertSession() {
      if (tokens.current) return;
      if (hub.runtime.status === 'reauth_required' || file.get().reauthRequired) throw new GmiError('reauth_required', EXPIRED_MESSAGE);
      if (tokens.storedUnreadable) throw new GmiError('not_signed_in', SIGN_IN_LOCKED_MESSAGE);
      throw new GmiError('not_signed_in', 'Sign in with GMI to use this.');
    },

    async retryLocked() {
      if (flow || tokens.current || !tokens.storedUnreadable) return;
      // A sign-in or sign-out that finished meanwhile wins: reload() then returns what it left behind.
      const stored = await tokens.reload();
      if (stored) {
        if (tokens.isExpired(stored) && !stored.refresh_token) {
          hub.runtime = { ...hub.runtime, status: 'signed_in' }; // so endWithReauth does not take it for a sign-out
          await endWithReauth(EXPIRED_MESSAGE);
          return;
        }
        if (file.get().reauthRequired) await file.update((x) => ({ ...x, reauthRequired: false }));
        // Learn the organization first so the signed_in state below already says the lookup is pending.
        if (!flow && !file.get().orgId) deps.onSessionStarted?.();
        // A browser sign-in started meanwhile keeps its status; it settles on these tokens if it is cancelled.
        hub.update({
          status: flow ? hub.runtime.status : 'signed_in',
          scopes: scopesOf(stored),
          accessTokenExpiresAt: isoFromEpoch(stored.expires_at),
          lastError: flow ? hub.runtime.lastError : null,
        });
        return;
      }
      if (tokens.storedUnreadable) return; // still locked: nothing changes
      // The saved sign-in is gone now (deleted, or not valid tokens): plainly signed out.
      if (!file.get().reauthRequired) await file.update((x) => ({ ...x, signedInAt: null, orgId: null }));
      hub.update({ status: settledStatus(), lastError: null });
    },

    async dispose() {
      const current = flow;
      if (!current) return;
      current.controller.abort();
      await current.promise.catch(() => undefined);
    },
  };
}
