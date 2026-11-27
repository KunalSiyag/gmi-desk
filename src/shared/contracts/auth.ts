import type { SecureStorageBackend } from './app';

/** Scopes offered by GMI's OAuth server (https://mcp.gmicloud.ai). There is no inference scope yet. */
export const GMI_SCOPES = [
  'models:read',
  'generation:read',
  'generation:write',
  'billing:read',
  'profile:read',
  'support:write',
] as const;
export type GmiScope = (typeof GMI_SCOPES)[number];

export type AuthStatus = 'signed_out' | 'signing_in' | 'signed_in' | 'reauth_required';

export type InferenceKeyStatus = 'missing' | 'valid' | 'invalid' | 'unverified';

/** Metadata about the stored inference key. The key itself never leaves the main process. */
export interface InferenceKeyInfo {
  status: InferenceKeyStatus;
  /** Where the key came from: OS keychain (pasted in the app) or the GMI_API_KEY env var (dev). */
  source: 'keychain' | 'env' | null;
  last4: string | null;
  keyId: string | null;
  /** `ie_model` = inference key (what chat needs); `ce_resource` = compute/Agentbox key. */
  scope: 'ie_model' | 'ce_resource' | null;
  orgId: string | null;
  /** Whether the key's org equals the signed-in org. null when either side is unknown. */
  orgMatchesAccount: boolean | null;
  validatedAt: string | null;
  error: string | null;
}

/**
 * Metadata about the stored Compute API key (`ce_resource` scope: Cluster Engine containers and Agentbox sandboxes).
 * The key itself never leaves the main process.
 */
export interface ComputeKeyInfo {
  status: InferenceKeyStatus;
  last4: string | null;
  keyId: string | null;
  orgId: string | null;
  /** Whether the key's org equals the signed-in org. null when either side is unknown. */
  orgMatchesAccount: boolean | null;
  validatedAt: string | null;
  error: string | null;
}

/** Which key a Connect dialog (and its clipboard detection) is about. */
export type KeyTarget = 'inference' | 'compute';

/** A saved secret: the GMI sign-in (OAuth tokens), the inference API key or the Compute API key. */
export type LockedSecret = 'sign_in' | 'inference_key' | 'compute_key';

/**
 * Whether GMI's inference API accepts the OAuth sign-in (GET /v1/models with the access token):
 * `unknown` = never checked for this sign-in, `checking` = in flight, `error` = no clear answer (offline, 5xx).
 */
export type OAuthInferenceProbe = 'unknown' | 'checking' | 'supported' | 'unsupported' | 'error';

/** How chat and GMI Router authenticate right now. */
export interface InferenceAccess {
  /** `api_key` = a stored (or GMI_API_KEY) key; `oauth` = no key, and GMI accepts the sign-in for inference; null = neither. */
  via: 'api_key' | 'oauth' | null;
  oauthProbe: OAuthInferenceProbe;
  /** When the probe last answered (ISO). */
  oauthProbeAt: string | null;
}

/** A key-shaped value found on the clipboard while the Connect dialog is open. Only metadata: never the key. */
export interface DetectedKeyCandidate {
  last4: string;
  detectedAt: string;
}

export interface KeyDetectionState {
  /** True between startKeyDetection() and stopKeyDetection() (or the 10-minute auto-stop). */
  active: boolean;
  candidate: DetectedKeyCandidate | null;
  /** Which key is being looked for (absent: `inference`). */
  target?: KeyTarget;
}

export interface UseDetectedKeyResult {
  state: AuthState;
  /** The clipboard still held the key and was cleared. */
  clipboardCleared: boolean;
}

export interface AuthState {
  status: AuthStatus;
  /** Scopes actually granted by GMI for the current session. */
  scopes: string[];
  orgId: string | null;
  signedInAt: string | null;
  accessTokenExpiresAt: string | null;
  inferenceKey: InferenceKeyInfo;
  secureStorage: SecureStorageBackend;
  lastError: string | null;
  mock: boolean;
  /**
   * True while a browser sign-in is open. Usually status is `signing_in` then; when an existing session
   * reconnects (e.g. to grant missing permissions) status stays `signed_in` and only this flag is set.
   */
  signInInProgress?: boolean;
  /** True while the app asks GMI which organization the sign-in belongs to (after sign-in / at startup). */
  orgIdPending?: boolean;
  /**
   * Saved secrets that exist but the OS keychain would not decrypt (locked keyring, another desktop session,
   * access denied). Nothing was deleted: unlock the keychain and call `retrySecureStorage()`, or replace them
   * (sign in again / save a new key). While the sign-in is locked, status is `signed_out`; while the key is
   * locked, `inferenceKey` keeps its saved metadata with status `unverified`. Absent or empty: nothing locked.
   */
  lockedSecrets?: LockedSecret[];
  /** How chat authenticates (absent from older main processes: then only `inferenceKey` counts). */
  inference?: InferenceAccess;
  /** Clipboard key detection for the Connect chat dialog. */
  keyDetection?: KeyDetectionState;
  /** The Compute API key (absent from main processes without the compute slice). */
  computeKey?: ComputeKeyInfo;
}

export interface AuthApi {
  getState(): Promise<AuthState>;
  /** Runs OAuth (PKCE + loopback redirect) in the system browser. Resolves when finished or cancelled. */
  signIn(): Promise<AuthState>;
  cancelSignIn(): Promise<AuthState>;
  /** Revokes and forgets the OAuth session. The inference key is kept unless removed separately. */
  signOut(): Promise<AuthState>;
  /** Validates the key with GMI (GET /me/api-keys/current) and stores it in the secure store (OS keychain when available). */
  setInferenceKey(key: string): Promise<AuthState>;
  removeInferenceKey(): Promise<AuthState>;
  revalidateInferenceKey(): Promise<AuthState>;
  /** Reads saved secrets that were locked (see `AuthState.lockedSecrets`) again, e.g. after the keychain was unlocked. */
  retrySecureStorage(): Promise<AuthState>;
  /** Asks GMI now whether its inference API accepts the sign-in (see `AuthState.inference`). */
  probeOAuthInference(): Promise<AuthState>;
  /**
   * Starts watching the clipboard for an inference key (the Connect dialog is open): on start, on every window
   * focus and about once a second while focused; stops by itself after 10 minutes. Nothing found is sent anywhere
   * until useDetectedKey(); the renderer only ever sees the last 4 characters.
   */
  startKeyDetection(target?: KeyTarget): Promise<AuthState>;
  /** Stops watching and forgets a found candidate. */
  stopKeyDetection(): Promise<AuthState>;
  /**
   * Validates and stores the found key (same path as setInferenceKey), stops watching and clears the clipboard
   * if it still holds that key. Throws `not_found` when there is no candidate.
   */
  useDetectedKey(): Promise<UseDetectedKeyResult>;
  /** "Not this one": forgets the candidate and ignores that value for the rest of the session. */
  dismissDetectedKey(): Promise<AuthState>;
  /** Validates the Compute key with GMI (scope `ce_resource`) and stores it in the secure store. */
  setComputeKey(key: string): Promise<AuthState>;
  removeComputeKey(): Promise<AuthState>;
  revalidateComputeKey(): Promise<AuthState>;
}
