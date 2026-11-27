/**
 * Auth slice: "Sign in with GMI" (OAuth 2.1 + PKCE + loopback redirect against mcp.gmicloud.ai),
 * the MCP gateway every other slice uses for GMI's tools, and the inference API key for chat.
 */
import { join } from 'node:path';
import { GMI_URLS, USER_AGENT } from '@shared/app';
import type { AuthApi } from '@shared/contracts/auth';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { AppContext } from '../../core/context';
import type { FetchLike } from '../../core/http';
import type { KeyTarget, LockedSecret } from '@shared/contracts/auth';
import type { AuthService, ComputeKeyProvider, McpGateway } from '../../core/services';
import { ComputeKeyManager, INFERENCE_SCOPE_DETAIL } from './compute-keys';
import { openJsonStore } from '../../core/store';
import { createWrappedFetch } from './fetch';
import { INFERENCE_PROBE_MAX_AGE_MS } from './constants';
import { OAuthInference } from './inference';
import { KeyDetector } from './key-detection';
import { envKeyFromEnvironment, KeyManager, type AuthKeyProvider } from './keys';
import { createMcpGateway } from './mcp-gateway';
import { createMockAuth } from './mock';
import { createOAuthClient } from './oauth';
import { createOrgLookup } from './org';
import { scopesOf } from './secrets';
import { createSession } from './session';
import { AuthStateHub, DEFAULT_AUTH_FILE, normalizeAuthFile, type AuthFile } from './state';

export type { AuthKeyProvider } from './keys';

export interface AuthSlice {
  service: AuthService;
  mcp: McpGateway;
  keys: AuthKeyProvider;
  /** The Compute key (`ce_resource`, compute.md DC1): the only way other slices get it. */
  computeKeys: ComputeKeyProvider;
  api: AuthApi;
  dispose(): void | Promise<void>;
}

/** Test seams; the app uses the defaults. */
export interface AuthSliceOptions {
  /** Raw fetch for OAuth and MCP requests (default: global fetch). */
  fetch?: FetchLike;
  /**
   * Overrides GMI_API_KEY (undefined = read the environment, which a packaged app ignores; null = no env key,
   * e.g. what the main process passes when app.isPackaged).
   */
  envKey?: string | null;
  signInTimeoutMs?: number;
  mockSignInDelayMs?: number;
  /** Mock mode starting state (see applyMockScenario); defaults to GMI_DESK_MOCK_AUTH. */
  mockScenario?: string;
  /** Ask GMI for the organisation id at startup when it is unknown (default true). */
  learnOrgOnStart?: boolean;
  /** Delays before retrying a failed organisation lookup (default ORG_RETRY_DELAYS_MS). */
  orgRetryDelaysMs?: number[];
  /**
   * Ask GMI whether inference accepts the sign-in at startup when the last answer is old, and again while the app
   * stays open (default true).
   */
  probeInferenceOnStart?: boolean;
  /** How often a running app checks whether the last probe answer is a day old (default 6 hours). */
  inferenceRecheckMs?: number;
  /** Clipboard key detection timings (defaults: 10 minutes, 1 s). */
  keyDetectionTimeoutMs?: number;
  keyDetectionPollMs?: number;
  /** Re-check a saved Compute key whose last check is a day old at startup (default true). */
  revalidateComputeKeyOnStart?: boolean;
}

export async function createAuthSlice(ctx: AppContext, opts: Pick<AuthSliceOptions, 'envKey'> = {}): Promise<AuthSlice> {
  return createAuthSliceWith(ctx, opts);
}

export async function createAuthSliceWith(ctx: AppContext, opts: AuthSliceOptions = {}): Promise<AuthSlice> {
  if (ctx.mock) {
    return createMockAuth(ctx, { signInDelayMs: opts.mockSignInDelayMs, scenario: opts.mockScenario ?? process.env.GMI_DESK_MOCK_AUTH });
  }

  const log = ctx.log.child('auth');
  const envKey = opts.envKey !== undefined ? opts.envKey : envKeyFromEnvironment();
  const rawFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));

  const file = await openJsonStore<AuthFile>(join(ctx.paths.data, 'auth.json'), DEFAULT_AUTH_FILE, {
    log,
    normalize: (raw) => normalizeAuthFile(raw),
  });

  // Built in dependency order; the closures below only run after construction.
  let hub: AuthStateHub;
  const keys = new KeyManager({ http: ctx.http, secure: ctx.secure, file, now: () => ctx.now(), log, envKey, emit: () => void hub.emit() });
  await keys.load();
  const computeKeys = new ComputeKeyManager({
    http: ctx.http,
    secure: ctx.secure,
    file,
    platform: ctx.platform,
    now: () => ctx.now(),
    log,
    emit: () => void hub.emit(),
  });
  await computeKeys.load();
  hub = new AuthStateHub({
    events: ctx.events,
    file,
    secureStorage: ctx.secure.backend,
    mock: false,
    keyInfo: () => keys.info(),
    lockedSecrets: () => {
      const locked: LockedSecret[] = [];
      if (session.tokens.storedUnreadable) locked.push('sign_in');
      if (keys.locked) locked.push('inference_key');
      if (computeKeys.locked) locked.push('compute_key');
      return locked;
    },
    inference: (status) => inference.access(status),
    keyDetection: () => detector.state(),
    computeKeyInfo: () => computeKeys.info(),
  });

  const oauth = createOAuthClient({ fetch: rawFetch, userAgent: USER_AGENT, log, now: () => ctx.now() });

  const session = createSession({
    ctx,
    hub,
    file,
    oauth,
    signInTimeoutMs: opts.signInTimeoutMs,
    onSessionStarted: () => {
      void org.start();
      // A new sign-in may come with an inference scope: ask GMI right away.
      void inference.probeNow();
    },
    onSessionEnded: async () => {
      org.stop();
      await inference.reset();
      return gateway.reset();
    },
  });

  const gateway = createMcpGateway({
    url: GMI_URLS.mcp,
    fetch: createWrappedFetch(rawFetch, { userAgent: USER_AGENT }),
    log,
    tokens: session.tokens,
    assertSession: () => session.assertSession(),
    onReauthRequired: (reason) => session.markReauthRequired(reason),
  });

  const org = createOrgLookup({ hub, file, mcp: gateway, epoch: () => session.tokens.epoch, log, retryDelaysMs: opts.orgRetryDelaysMs });

  const inference = new OAuthInference({
    http: ctx.http,
    file,
    now: () => ctx.now(),
    log,
    accessToken: () => session.tokens.getAccessToken(),
    hasSession: () => session.tokens.current !== null,
    epoch: () => session.tokens.epoch,
    hasKey: () => keys.hasKey(),
    grantedScope: () => [...scopesOf(session.tokens.current)].sort().join(' '),
    emit: () => void hub.emit(),
  });

  const detector = new KeyDetector({
    platform: ctx.platform,
    now: () => ctx.now(),
    currentKey: () => keys.getKey(),
    storedKeys: async () => [await keys.getKey(), await computeKeys.getKey()],
    emit: () => void hub.emit(),
    log,
    timeoutMs: opts.keyDetectionTimeoutMs,
    pollMs: opts.keyDetectionPollMs,
  });

  await session.restore();
  if (hub.runtime.status === 'signed_in' && !file.get().orgId && opts.learnOrgOnStart !== false) void org.start();
  const probeOnStart = opts.probeInferenceOnStart !== false;
  if (hub.runtime.status === 'signed_in' && probeOnStart) inference.maybeProbe();
  // A desktop app may stay open for days: ask again once the last answer is a day old (maybeProbe keeps that limit),
  // so chat switches to the sign-in the day GMI accepts it without a restart.
  const probeTimer = probeOnStart
    ? setInterval(() => {
        if (hub.runtime.status === 'signed_in') inference.maybeProbe();
      }, opts.inferenceRecheckMs ?? INFERENCE_PROBE_MAX_AGE_MS / 4)
    : null;
  probeTimer?.unref?.();
  // A saved Compute key is re-checked at most once a day, at startup (compute.md §4.2); failures keep its status.
  if (opts.revalidateComputeKeyOnStart !== false && computeKeys.needsRevalidation()) {
    void computeKeys.revalidate().catch((error) => log.warn('could not re-check the Compute key', toGmiError(error).code));
  }

  const service: AuthService = {
    getState: () => hub.snapshot(),
    isSignedIn: () => hub.runtime.status === 'signed_in',
    onChange: (listener) => hub.onChange(listener),
  };

  const api: AuthApi = {
    getState: async () => hub.snapshot(),
    signIn: () => session.signIn(),
    cancelSignIn: () => session.cancelSignIn(),
    signOut: () => session.signOut(),
    async setInferenceKey(key: string) {
      await keys.set(key);
      return hub.snapshot();
    },
    async removeInferenceKey() {
      await keys.remove();
      return hub.snapshot();
    },
    async revalidateInferenceKey() {
      await keys.revalidate();
      return hub.snapshot();
    },
    async retrySecureStorage() {
      // The user unlocked the keychain (or wants to check): read what could not be read, then tell everyone.
      await keys.reload();
      await computeKeys.reload();
      await session.retryLocked();
      // Like a normal startup: a sign-in restored from the unlocked keychain asks GMI about chat (at most daily).
      if (hub.runtime.status === 'signed_in' && probeOnStart) inference.maybeProbe();
      return hub.emit();
    },
    async probeOAuthInference() {
      if (hub.runtime.status !== 'signed_in') return hub.snapshot();
      const probe = inference.probeNow();
      hub.emit(); // shows `checking`
      await probe;
      return hub.snapshot();
    },
    async startKeyDetection(target?: KeyTarget) {
      detector.start(target === 'compute' ? 'compute' : 'inference');
      return hub.snapshot();
    },
    async stopKeyDetection() {
      detector.stop();
      return hub.snapshot();
    },
    async useDetectedKey() {
      const key = detector.take();
      if (!key) throw new GmiError('not_found', 'The copied key is no longer available. Copy it again in GMI Console.');
      const target = detector.activeTarget;
      try {
        if (target === 'compute') await computeKeys.set(key);
        else await keys.set(key);
      } catch (error) {
        const err = toGmiError(error);
        // Not a usable key for this target (GMI said so): do not offer it again. Transient failures keep it for a
        // retry, and so does an inference key found by Connect Compute ("Use it for chat instead" switches targets).
        const unusable =
          target === 'compute'
            ? err.code === 'invalid_compute_key' || (err.code === 'invalid_input' && err.detail !== INFERENCE_SCOPE_DETAIL)
            : err.code === 'invalid_api_key' || err.code === 'invalid_input';
        if (unusable) detector.dismiss(key);
        throw err;
      }
      detector.stop();
      let clipboardCleared = false;
      try {
        clipboardCleared = await ctx.platform.clearClipboardIfEquals(key);
      } catch (error) {
        log.warn('could not clear the clipboard', toGmiError(error).code);
      }
      return { state: hub.snapshot(), clipboardCleared };
    },
    async dismissDetectedKey() {
      detector.dismiss();
      return hub.snapshot();
    },
    // The Compute key (compute.md §4): validated (scope ce_resource), then stored; never returned.
    async setComputeKey(key: string) {
      await computeKeys.set(key);
      return hub.snapshot();
    },
    async removeComputeKey() {
      await computeKeys.remove();
      return hub.snapshot();
    },
    async revalidateComputeKey() {
      await computeKeys.revalidate();
      return hub.snapshot();
    },
  };

  return {
    service,
    mcp: gateway,
    keys: {
      // A stored key always wins; without one, the sign-in's access token while GMI accepts it for inference.
      async getInferenceKey() {
        const key = await keys.getKey();
        if (key) return key;
        return inference.token().catch(() => null);
      },
      async requireInferenceKey() {
        const key = await keys.getKey();
        if (key) return key;
        const token = await inference.token();
        return token ?? keys.requireKey();
      },
      async reportInvalidKey(reason, key, status) {
        // A 401 or 403 for the sign-in's token means GMI does not (or no longer) accept it for that call (chat,
        // GMI Router, /v1/models): ask for a key.
        if (inference.isOAuthToken(key) || (key === undefined && !keys.hasKey() && inference.supported)) {
          await inference.markUnsupported(reason);
          return;
        }
        // A 403 for a real key is a permission problem (model, organization), not a dead key.
        if (status === 403) return;
        await keys.reportInvalid(reason, key);
      },
    },
    computeKeys: computeKeys.provider(),
    api,
    async dispose() {
      if (probeTimer) clearInterval(probeTimer);
      detector.dispose();
      org.stop();
      await session.dispose();
      await gateway.reset();
      await file.flush();
    },
  };
}
