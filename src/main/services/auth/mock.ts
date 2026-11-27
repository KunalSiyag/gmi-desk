/**
 * Mock-mode auth (GMI_DESK_MOCK=1, screenshots): signed in to a placeholder organisation with every
 * scope and a valid demo inference key. Nothing touches the network, the keychain or the clipboard.
 */
import type { AuthApi, AuthState, ComputeKeyInfo, InferenceAccess, KeyTarget, LockedSecret } from '@shared/contracts/auth';
import { GMI_SCOPES } from '@shared/contracts/auth';
import { GmiError } from '@shared/contracts/errors';
import type { AppContext } from '../../core/context';
import type { AuthService, ComputeKeyProvider, GmiToolName, McpCallOptions, McpGateway } from '../../core/services';
import { createMockMcp } from '../../mock/mcp';
import { INFERENCE_KEY_FOR_COMPUTE_MESSAGE, INFERENCE_SCOPE_DETAIL, normalizeComputeKey, NO_COMPUTE_KEY_MESSAGE, WEAK_KEYRING_CONFIRM, type ComputeKeyInfoWire } from './compute-keys';
import { COMPUTE_KEY_LOCKED_MESSAGE, KEY_LOCKED_MESSAGE, MOCK_ORG_ID, SIGN_IN_LOCKED_MESSAGE } from './constants';
import { last4Of, normalizeInferenceKey, type AuthKeyProvider } from './keys';
import { deriveOrgMatch } from './state';

export interface MockAuthParts {
  service: AuthService;
  mcp: McpGateway;
  keys: AuthKeyProvider;
  /** The mock Compute key (flags compute_key, compute_key_invalid, compute_key_locked; none by default). */
  computeKeys: ComputeKeyProvider;
  api: AuthApi;
  dispose(): void;
}

const HOUR = 3_600_000;

/** The access token mock mode hands out for chat while GMI "accepts the sign-in" (oauth_inference). */
export const MOCK_OAUTH_ACCESS_TOKEN = 'gmi-mock-oauth-access-token';
/** Last 4 characters of the key the key_candidate scenario "finds" on the clipboard. */
export const MOCK_CANDIDATE_LAST4 = 'Q7fA';
/** How long mock "Use this key" takes (shows the verifying state in dev:mock). */
const MOCK_VERIFY_MS = 450;
/** Last 4 characters of the mock Compute key (flags compute_key, compute_key_invalid, compute_key_locked). */
export const MOCK_COMPUTE_LAST4 = 'c0mp';

export const NO_COMPUTE_KEY_INFO: ComputeKeyInfo = { status: 'missing', last4: null, keyId: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };

/** A mock "pasted" key counts as an inference key when it says so (shows Connect Compute's "Use it for chat instead"). */
const looksLikeInferenceKey = (key: string) => /ie_model|inference/i.test(key);

/** How chat authenticates in `s`: a usable key wins, then the sign-in while GMI accepts it (mirrors the real slice). */
export function mockInferenceAccess(s: AuthState): InferenceAccess {
  const probe = s.inference ?? { via: null, oauthProbe: 'unknown', oauthProbeAt: null };
  const keyUsable = s.inferenceKey.status !== 'missing' && !s.lockedSecrets?.includes('inference_key');
  const via = keyUsable ? 'api_key' : s.status === 'signed_in' && probe.oauthProbe === 'supported' ? 'oauth' : null;
  return { via, oauthProbe: probe.oauthProbe, oauthProbeAt: probe.oauthProbeAt };
}

/**
 * Dev/screenshot knob: GMI_DESK_MOCK_AUTH="signed_out,no_key" starts mock mode in another state.
 * Flags: signed_out, signing_in, reconnecting, reauth, partial_scopes, error, org_pending, org_unknown,
 * no_key, invalid_key, unverified_key, env_key, other_org_key, basic_text, unavailable,
 * keychain_locked (saved sign-in and key could not be decrypted; "Try again" unlocks them),
 * sign_in_fails (signIn() rejects with a timeout, to show sign-in error states),
 * oauth_inference (GMI accepts the sign-in for chat: probe `supported`, no key saved, chat works via the sign-in),
 * key_candidate (clipboard key detection is on and has found a key ending in MOCK_CANDIDATE_LAST4).
 * Compute key (compute.md §4; none by default): compute_key (valid, ending MOCK_COMPUTE_LAST4), compute_key_invalid
 * (GMI rejected it), compute_key_locked (saved, the keychain would not decrypt it), no_compute_key (none, wins over the
 * others); with basic_text, "Use this key" asks natively whether to store it (else it is kept for this session).
 */
export function applyMockScenario(state: AuthState, raw: string | undefined): AuthState {
  const flags = new Set((raw ?? '').split(',').map((f) => f.trim()).filter(Boolean));
  let s: AuthState = { ...state, inferenceKey: { ...state.inferenceKey } };
  const signedOut = { scopes: [], orgId: null, signedInAt: null, accessTokenExpiresAt: null };
  if (flags.has('signed_out')) s = { ...s, ...signedOut, status: 'signed_out' };
  if (flags.has('signing_in')) s = { ...s, ...signedOut, status: 'signing_in', signInInProgress: true };
  if (flags.has('reconnecting')) s = { ...s, signInInProgress: true };
  if (flags.has('reauth')) s = { ...s, ...signedOut, orgId: state.orgId, status: 'reauth_required', lastError: 'Your GMI sign-in expired. Sign in again.' };
  if (flags.has('partial_scopes')) s = { ...s, scopes: s.scopes.filter((x) => x !== 'generation:write' && x !== 'support:write') };
  if (flags.has('error')) s = { ...s, lastError: 'Could not reach GMI. Check your connection.' };
  if (flags.has('org_pending')) s = { ...s, orgId: null, orgIdPending: true };
  if (flags.has('org_unknown')) s = { ...s, orgId: null, orgIdPending: false };
  const key = s.inferenceKey;
  if (flags.has('no_key')) {
    s.inferenceKey = { ...key, status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
  }
  if (flags.has('invalid_key')) s.inferenceKey = { ...key, status: 'invalid', error: 'GMI rejected this key: Expired API key.' };
  if (flags.has('unverified_key')) s.inferenceKey = { ...key, status: 'unverified', keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null };
  if (flags.has('env_key')) s.inferenceKey = { ...s.inferenceKey, source: 'env', status: 'unverified', validatedAt: null };
  if (flags.has('other_org_key')) s.inferenceKey = { ...s.inferenceKey, orgId: '11111111-1111-1111-1111-111111111111', orgMatchesAccount: false };
  if (flags.has('basic_text')) s.secureStorage = 'basic_text';
  if (flags.has('unavailable')) s.secureStorage = 'unavailable';
  if (flags.has('oauth_inference')) {
    s.inferenceKey = { ...s.inferenceKey, status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
    s.inference = { via: null, oauthProbe: 'supported', oauthProbeAt: s.inference?.oauthProbeAt ?? null };
  }
  if (flags.has('keychain_locked')) {
    const hasKey = s.inferenceKey.status !== 'missing';
    s = { ...s, ...signedOut, status: 'signed_out', lastError: SIGN_IN_LOCKED_MESSAGE, lockedSecrets: hasKey ? ['sign_in', 'inference_key'] : ['sign_in'] };
    if (hasKey) s.inferenceKey = { ...s.inferenceKey, status: 'unverified', source: 'keychain', orgMatchesAccount: null, error: KEY_LOCKED_MESSAGE };
  }
  const computeKey = mockComputeKey(state, flags);
  if (computeKey) s.computeKey = computeKey;
  if (flags.has('compute_key_locked') || (flags.has('keychain_locked') && s.computeKey && s.computeKey.status !== 'missing')) {
    if (s.computeKey && s.computeKey.status !== 'missing') {
      s.computeKey = { ...s.computeKey, status: 'unverified', orgMatchesAccount: null, error: COMPUTE_KEY_LOCKED_MESSAGE };
      s.lockedSecrets = [...new Set<LockedSecret>([...(s.lockedSecrets ?? []), 'compute_key'])];
    }
  }
  if (s.status !== 'signed_in' && s.inference) s.inference = { ...s.inference, oauthProbe: 'unknown', oauthProbeAt: null };
  if (flags.has('key_candidate')) s.keyDetection = { active: true, candidate: { last4: MOCK_CANDIDATE_LAST4, detectedAt: s.keyDetection?.candidate?.detectedAt ?? new Date().toISOString() } };
  s.inference = mockInferenceAccess(s);
  return s;
}

/** The Compute key metadata a scenario starts with (null: keep what `state` has). */
function mockComputeKey(state: AuthState, flags: Set<string>): ComputeKeyInfo | null {
  if (flags.has('no_compute_key')) return { ...NO_COMPUTE_KEY_INFO };
  const present = flags.has('compute_key') || flags.has('compute_key_invalid') || flags.has('compute_key_locked');
  if (!present) return null;
  const validatedAt = state.inferenceKey.validatedAt ?? state.signedInAt;
  const key: ComputeKeyInfo = {
    status: 'valid',
    last4: MOCK_COMPUTE_LAST4,
    keyId: 'mock-compute-key-0001',
    orgId: MOCK_ORG_ID,
    orgMatchesAccount: null,
    validatedAt,
    error: null,
  };
  return flags.has('compute_key_invalid') ? { ...key, status: 'invalid', error: 'GMI rejected this key: Expired API key.' } : key;
}

/** Whether the scenario has a key-shaped value waiting on the (simulated) clipboard. */
export function mockHasKeyCandidate(raw: string | undefined): boolean {
  return (raw ?? '').split(',').some((f) => f.trim() === 'key_candidate');
}

/** Whether GMI accepts the sign-in for inference in this scenario (the probe's answer). */
export function mockOAuthInferenceSupported(raw: string | undefined): boolean {
  return (raw ?? '').split(',').some((f) => f.trim() === 'oauth_inference');
}

/** Whether the scenario makes the simulated browser sign-in fail. */
export function mockSignInFails(raw: string | undefined): boolean {
  return (raw ?? '').split(',').some((f) => f.trim() === 'sign_in_fails');
}

export function createMockAuth(ctx: AppContext, opts: { signInDelayMs?: number; mcp?: McpGateway; scenario?: string } = {}): MockAuthParts {
  const delay = opts.signInDelayMs ?? 600;
  const now = ctx.now().getTime();
  let key: string | null = 'gmi-mock-inference-key-demo';
  let state: AuthState = {
    status: 'signed_in',
    scopes: [...GMI_SCOPES],
    orgId: MOCK_ORG_ID,
    signedInAt: new Date(now - 3 * 24 * HOUR).toISOString(),
    accessTokenExpiresAt: new Date(now + 0.9 * HOUR).toISOString(),
    inferenceKey: {
      status: 'valid',
      source: 'keychain',
      last4: 'demo',
      keyId: 'mock-key-0001',
      scope: 'ie_model',
      orgId: MOCK_ORG_ID,
      orgMatchesAccount: true,
      validatedAt: new Date(now - 2 * HOUR).toISOString(),
      error: null,
    },
    secureStorage: ctx.secure.backend,
    lastError: null,
    mock: true,
    signInInProgress: false,
    orgIdPending: false,
    inference: { via: 'api_key', oauthProbe: 'unsupported', oauthProbeAt: new Date(now - 2 * HOUR).toISOString() },
    keyDetection: { active: false, candidate: null },
    computeKey: { ...NO_COMPUTE_KEY_INFO },
  };
  // What "Try again" reveals once a locked keychain is unlocked: the same scenario without the lock.
  const unlocked = applyMockScenario(
    state,
    (opts.scenario ?? '')
      .split(',')
      .filter((f) => f.trim() !== 'keychain_locked' && f.trim() !== 'compute_key_locked')
      .concat((opts.scenario ?? '').includes('compute_key_locked') ? ['compute_key'] : [])
      .join(','),
  );
  state = applyMockScenario(state, opts.scenario);
  if (state.inferenceKey.status === 'missing') key = null;
  let computeKey: string | null = state.computeKey && state.computeKey.status !== 'missing' ? `gmi-mock-compute-key-${MOCK_COMPUTE_LAST4}` : null;
  /** The mock Compute key is kept for this session only (basic_text, store declined). */
  let computeSessionOnly = false;
  const computeListeners = new Set<() => void>();
  const computeChanged = () => {
    for (const listener of [...computeListeners]) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  };
  const signInFails = mockSignInFails(opts.scenario);
  const oauthSupported = mockOAuthInferenceSupported(opts.scenario);
  /** A key is "on the clipboard" until it is used or dismissed. */
  let candidateWaiting = mockHasKeyCandidate(opts.scenario);
  const listeners = new Set<(s: AuthState) => void>();
  let pending: { promise: Promise<AuthState>; cancel: () => void } | null = null;

  const snapshot = (): AuthState => {
    const compute = state.computeKey ?? NO_COMPUTE_KEY_INFO;
    const computeInfo: ComputeKeyInfoWire = { ...compute, orgMatchesAccount: deriveOrgMatch(state.status, state.orgId, compute.orgId) };
    if (computeSessionOnly && compute.status !== 'missing') computeInfo.sessionOnly = true;
    return {
      ...state,
      scopes: [...state.scopes],
      inferenceKey: { ...state.inferenceKey, orgMatchesAccount: deriveOrgMatch(state.status, state.orgId, state.inferenceKey.orgId) },
      inference: mockInferenceAccess(state),
      keyDetection: state.keyDetection ? { ...state.keyDetection } : { active: false, candidate: null },
      computeKey: computeInfo,
    };
  };
  const probeRecord = () => state.inference ?? { via: null, oauthProbe: 'unknown' as const, oauthProbeAt: null };
  const setProbe = (oauthProbe: InferenceAccess['oauthProbe'], at: string | null) => ({ inference: { ...probeRecord(), oauthProbe, oauthProbeAt: at } });

  const set = (patch: Partial<AuthState>): AuthState => {
    state = { ...state, ...patch };
    const s = snapshot();
    ctx.events.emit('auth:changed', s);
    for (const listener of listeners) {
      try {
        listener(s);
      } catch {
        // ignore
      }
    }
    return s;
  };

  /** lockedSecrets without `secret` (an explicit sign-in/out or key change replaces what was locked). */
  const without = (secret: LockedSecret): Partial<AuthState> =>
    state.lockedSecrets?.includes(secret) ? { lockedSecrets: state.lockedSecrets.filter((x) => x !== secret) } : {};

  const setKey = (patch: Partial<AuthState['inferenceKey']>) => set({ ...without('inference_key'), inferenceKey: { ...state.inferenceKey, ...patch } });
  const computeLocked = () => state.lockedSecrets?.includes('compute_key') === true;
  const setComputeInfo = (info: ComputeKeyInfo, sessionOnly = computeSessionOnly) => {
    computeSessionOnly = sessionOnly;
    const s = set({ ...without('compute_key'), computeKey: info });
    computeChanged();
    return s;
  };
  /** Mock validation + the weak-keyring choice (the native dialog in dev:mock), then "stores" the Compute key. */
  const storeComputeKey = async (next: string, last4: string): Promise<AuthState> => {
    if (looksLikeInferenceKey(next)) throw new GmiError('invalid_input', INFERENCE_KEY_FOR_COMPUTE_MESSAGE, { detail: INFERENCE_SCOPE_DETAIL });
    const backend = state.secureStorage;
    const persist = backend === 'os' ? true : backend === 'basic_text' ? await ctx.platform.confirm({ ...WEAK_KEYRING_CONFIRM }) : false;
    computeKey = next;
    return setComputeInfo(
      { status: 'valid', last4, keyId: 'mock-compute-key-0002', orgId: MOCK_ORG_ID, orgMatchesAccount: null, validatedAt: ctx.now().toISOString(), error: null },
      !persist,
    );
  };

  const inner = opts.mcp ?? createMockMcp();
  const mcp: McpGateway = {
    async callTool<T = unknown>(name: GmiToolName, args?: Record<string, unknown>, callOpts?: McpCallOptions): Promise<T> {
      if (state.status !== 'signed_in') {
        throw state.status === 'reauth_required'
          ? new GmiError('reauth_required', 'Your GMI sign-in expired. Sign in again.')
          : new GmiError('not_signed_in', 'Sign in with GMI to use this.');
      }
      return inner.callTool<T>(name, args, callOpts);
    },
  };

  const api: AuthApi = {
    async getState() {
      return snapshot();
    },
    signIn() {
      if (pending) return pending.promise;
      const wasSignedIn = state.status === 'signed_in';
      set({ status: wasSignedIn ? 'signed_in' : 'signing_in', signInInProgress: true, lastError: null });
      let cancel: () => void = () => undefined;
      const promise = new Promise<AuthState>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          if (signInFails) {
            const error = new GmiError('timeout', 'Sign-in timed out. Start again when you are ready.');
            set({ status: wasSignedIn ? 'signed_in' : 'signed_out', signInInProgress: false, lastError: error.message });
            reject(error);
            return;
          }
          resolve(
            set({
              status: 'signed_in',
              scopes: [...GMI_SCOPES],
              orgId: MOCK_ORG_ID,
              signedInAt: ctx.now().toISOString(),
              accessTokenExpiresAt: new Date(ctx.now().getTime() + HOUR).toISOString(),
              signInInProgress: false,
              orgIdPending: false,
              lastError: null,
              ...without('sign_in'),
              // The real slice asks GMI right after a sign-in whether inference accepts it.
              ...setProbe(oauthSupported ? 'supported' : 'unsupported', ctx.now().toISOString()),
            }),
          );
          ctx.platform.focusApp();
        }, delay);
        cancel = () => {
          clearTimeout(timer);
          pending = null;
          resolve(set({ status: wasSignedIn ? 'signed_in' : 'signed_out', signInInProgress: false }));
        };
      });
      pending = { promise, cancel };
      return promise;
    },
    async cancelSignIn() {
      if (pending) {
        const { promise, cancel } = pending;
        cancel();
        await promise;
      } else if (state.signInInProgress) {
        set({ status: state.status === 'signing_in' ? 'signed_out' : state.status, signInInProgress: false });
      }
      return snapshot();
    },
    async signOut() {
      if (pending) pending.cancel();
      return set({
        ...without('sign_in'),
        status: 'signed_out',
        scopes: [],
        orgId: null,
        signedInAt: null,
        accessTokenExpiresAt: null,
        lastError: null,
        signInInProgress: false,
        orgIdPending: false,
        ...setProbe('unknown', null),
      });
    },
    async setInferenceKey(raw: string) {
      const next = normalizeInferenceKey(raw);
      key = next;
      setKey({
        status: 'valid',
        source: 'keychain',
        last4: last4Of(next),
        keyId: 'mock-key-0002',
        scope: 'ie_model',
        orgId: MOCK_ORG_ID,
        orgMatchesAccount: null,
        validatedAt: ctx.now().toISOString(),
        error: null,
      });
      return snapshot();
    },
    async removeInferenceKey() {
      key = null;
      setKey({ status: 'missing', source: null, last4: null, keyId: null, scope: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null });
      return snapshot();
    },
    async revalidateInferenceKey() {
      if (key) setKey({ status: 'valid', validatedAt: ctx.now().toISOString(), error: null });
      return snapshot();
    },
    async probeOAuthInference() {
      if (state.status !== 'signed_in') return snapshot();
      set(setProbe('checking', probeRecord().oauthProbeAt));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return set(setProbe(oauthSupported ? 'supported' : 'unsupported', ctx.now().toISOString()));
    },
    async startKeyDetection(target?: KeyTarget) {
      const candidate = candidateWaiting ? (state.keyDetection?.candidate ?? { last4: MOCK_CANDIDATE_LAST4, detectedAt: ctx.now().toISOString() }) : null;
      return set({ keyDetection: { active: true, candidate, target: target === 'compute' ? 'compute' : 'inference' } });
    },
    async stopKeyDetection() {
      if (!state.keyDetection?.active && !state.keyDetection?.candidate) return snapshot();
      return set({ keyDetection: { active: false, candidate: null } });
    },
    async useDetectedKey() {
      const candidate = state.keyDetection?.candidate;
      if (!candidate) throw new GmiError('not_found', 'The copied key is no longer available. Copy it again in GMI Console.');
      await new Promise((resolve) => setTimeout(resolve, MOCK_VERIFY_MS));
      if (state.keyDetection?.target === 'compute') {
        await storeComputeKey(`gmi-mock-detected-compute-key-${candidate.last4}`, candidate.last4);
        candidateWaiting = false;
        set({ keyDetection: { active: false, candidate: null } });
        return { state: snapshot(), clipboardCleared: true };
      }
      candidateWaiting = false;
      key = `gmi-mock-detected-key-${candidate.last4}`;
      set({ keyDetection: { active: false, candidate: null } });
      setKey({
        status: 'valid',
        source: 'keychain',
        last4: candidate.last4,
        keyId: 'mock-key-0003',
        scope: 'ie_model',
        orgId: MOCK_ORG_ID,
        orgMatchesAccount: null,
        validatedAt: ctx.now().toISOString(),
        error: null,
      });
      return { state: snapshot(), clipboardCleared: true };
    },
    async dismissDetectedKey() {
      candidateWaiting = false;
      if (!state.keyDetection?.candidate) return snapshot();
      return set({ keyDetection: { active: state.keyDetection.active, candidate: null } });
    },
    async retrySecureStorage() {
      // Simulated unlock: the saved sign-in and key become readable again.
      if (!state.lockedSecrets?.length) return snapshot();
      const locked = new Set(state.lockedSecrets);
      return set({
        ...(locked.has('sign_in') ? { status: unlocked.status, scopes: [...unlocked.scopes], orgId: unlocked.orgId, signedInAt: unlocked.signedInAt, accessTokenExpiresAt: unlocked.accessTokenExpiresAt, lastError: null } : {}),
        ...(locked.has('inference_key') ? { inferenceKey: { ...unlocked.inferenceKey } } : {}),
        ...(locked.has('compute_key') ? { computeKey: { ...(unlocked.computeKey ?? NO_COMPUTE_KEY_INFO) } } : {}),
        lockedSecrets: [],
      });
    },
    async setComputeKey(raw: string) {
      const next = normalizeComputeKey(raw);
      await storeComputeKey(next, last4Of(next));
      return snapshot();
    },
    async removeComputeKey() {
      computeKey = null;
      setComputeInfo({ ...NO_COMPUTE_KEY_INFO }, false);
      return snapshot();
    },
    async revalidateComputeKey() {
      if (computeKey && !computeLocked()) setComputeInfo({ ...(state.computeKey ?? NO_COMPUTE_KEY_INFO), status: 'valid', validatedAt: ctx.now().toISOString(), error: null });
      return snapshot();
    },
  };

  const keyLocked = () => state.lockedSecrets?.includes('inference_key') === true;
  const viaOAuth = () => mockInferenceAccess(state).via === 'oauth';
  const keys: AuthKeyProvider = {
    getInferenceKey: async () => (key && !keyLocked() ? key : viaOAuth() ? MOCK_OAUTH_ACCESS_TOKEN : null),
    requireInferenceKey: async () => {
      if (key && !keyLocked()) return key;
      if (viaOAuth()) return MOCK_OAUTH_ACCESS_TOKEN;
      throw new GmiError('no_api_key', key ? KEY_LOCKED_MESSAGE : 'Add a GMI inference API key in Settings to use chat.');
    },
    reportInvalidKey: async (reason, used, status) => {
      if (used === MOCK_OAUTH_ACCESS_TOKEN || (used === undefined && !key && viaOAuth())) {
        set(setProbe('unsupported', ctx.now().toISOString()));
        return;
      }
      if (status === 403) return; // a permission problem for a real key, not a dead key
      if (!key || keyLocked() || (used !== undefined && used !== key)) return; // nothing usable, or a late report about a replaced key
      setKey({ status: 'invalid', error: reason || 'GMI rejected the inference API key.' });
    },
  };

  const computeKeys: ComputeKeyProvider = {
    getComputeKey: async () => (computeKey && !computeLocked() ? computeKey : null),
    requireComputeKey: async () => {
      if (computeKey && !computeLocked()) return computeKey;
      throw new GmiError('no_compute_key', computeKey ? COMPUTE_KEY_LOCKED_MESSAGE : NO_COMPUTE_KEY_MESSAGE);
    },
    reportInvalidComputeKey: async (reason, used, status) => {
      if (status !== undefined && status !== null && status !== 401) return; // 403: not entitled / permission, never a dead key
      if (!computeKey || computeLocked() || (used !== undefined && used !== computeKey)) return;
      if (state.computeKey?.status === 'invalid') return;
      setComputeInfo({ ...(state.computeKey ?? NO_COMPUTE_KEY_INFO), status: 'invalid', error: reason || 'GMI rejected the Compute API key.' });
    },
    onChange(listener) {
      computeListeners.add(listener);
      return () => {
        computeListeners.delete(listener);
      };
    },
  };

  const service: AuthService = {
    getState: snapshot,
    isSignedIn: () => state.status === 'signed_in',
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    service,
    mcp,
    keys,
    computeKeys,
    api,
    dispose() {
      pending?.cancel();
    },
  };
}
