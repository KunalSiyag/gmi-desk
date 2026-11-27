/**
 * Non-secret auth state: the persisted bits (auth.json: org id, sign-in time, key metadata) and the
 * live AuthState snapshot pushed to the renderer as `auth:changed` on every change.
 */
import type { SecureStorageBackend } from '@shared/contracts/app';
import type { AuthState, AuthStatus, ComputeKeyInfo, InferenceAccess, InferenceKeyInfo, KeyDetectionState, LockedSecret } from '@shared/contracts/auth';
import type { EventBus } from '../../core/events';
import type { JsonStore } from '../../core/store';

export type KeyScope = 'ie_model' | 'ce_resource';
export type StoredKeyStatus = 'valid' | 'invalid' | 'unverified';

/** Metadata about the inference key in the keychain (never the key itself). */
export interface KeyMeta {
  keyId: string | null;
  scope: KeyScope | null;
  orgId: string | null;
  last4: string | null;
  validatedAt: string | null;
  status: StoredKeyStatus;
  error: string | null;
}

/** The last answer of the OAuth inference probe (GET /v1/models with the sign-in's access token). */
export interface OAuthInferenceRecord {
  status: 'supported' | 'unsupported' | 'error';
  checkedAt: string;
  /**
   * Chat, GMI Router or the models API refused the sign-in while it had these granted scopes (sorted, space
   * separated). /v1/models accepting the token (models:read) proves nothing for chat until the granted scopes
   * change, so the probe keeps answering `unsupported` meanwhile. Null/absent: no such rejection.
   */
  rejectedForScope?: string | null;
}

export interface AuthFile {
  version: 1;
  orgId: string | null;
  signedInAt: string | null;
  /** The last session ended with a dead grant: show "Sign in again" after a restart too. */
  reauthRequired: boolean;
  inferenceKey: KeyMeta | null;
  /** Whether GMI's inference API accepted the current sign-in; null = not checked for this sign-in. */
  oauthInference: OAuthInferenceRecord | null;
  /**
   * Metadata about the Compute key in the keychain (never the key). Absent in files written before C1-A; null while
   * no key is saved, including a key kept for this session only (its metadata stays in memory).
   */
  computeKey?: KeyMeta | null;
}

export const DEFAULT_AUTH_FILE: AuthFile = { version: 1, orgId: null, signedInAt: null, reauthRequired: false, inferenceKey: null, oauthInference: null, computeKey: null };

const str = (v: unknown, max = 512): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const isoOrNull = (v: unknown): string | null => {
  const s = str(v, 64);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};

export function normalizeKeyMeta(raw: unknown): KeyMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const status: StoredKeyStatus = r.status === 'valid' || r.status === 'invalid' || r.status === 'unverified' ? r.status : 'unverified';
  return {
    keyId: str(r.keyId, 200),
    scope: r.scope === 'ie_model' || r.scope === 'ce_resource' ? r.scope : null,
    orgId: str(r.orgId, 200),
    last4: str(r.last4, 8),
    validatedAt: isoOrNull(r.validatedAt),
    status,
    error: str(r.error, 500),
  };
}

export function normalizeOAuthInference(raw: unknown): OAuthInferenceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const checkedAt = isoOrNull(r.checkedAt);
  if (!checkedAt || (r.status !== 'supported' && r.status !== 'unsupported' && r.status !== 'error')) return null;
  const rejectedForScope = typeof r.rejectedForScope === 'string' && r.rejectedForScope.length <= 4096 ? r.rejectedForScope : null;
  return { status: r.status, checkedAt, rejectedForScope };
}

/** Coerces auth.json (possibly hand-edited or from an older version) into a valid AuthFile. */
export function normalizeAuthFile(raw: unknown): AuthFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    version: 1,
    orgId: str(r.orgId, 200),
    signedInAt: isoOrNull(r.signedInAt),
    reauthRequired: r.reauthRequired === true,
    inferenceKey: normalizeKeyMeta(r.inferenceKey),
    oauthInference: normalizeOAuthInference(r.oauthInference),
    computeKey: normalizeKeyMeta(r.computeKey),
  };
}

/** Session fields that live only in memory. */
export interface RuntimeAuth {
  status: AuthStatus;
  scopes: string[];
  accessTokenExpiresAt: string | null;
  lastError: string | null;
  signInInProgress: boolean;
  /** The organization id is being looked up over MCP. */
  orgIdPending: boolean;
}

export interface AuthHubDeps {
  events: EventBus;
  file: JsonStore<AuthFile>;
  secureStorage: SecureStorageBackend;
  mock: boolean;
  /** Key metadata without `orgMatchesAccount` (the hub fills it in). */
  keyInfo: () => InferenceKeyInfo;
  /** Saved secrets the OS keychain would not decrypt (see AuthState.lockedSecrets). */
  lockedSecrets?: () => LockedSecret[];
  /** How chat authenticates, given the session status (see AuthState.inference). */
  inference?: (status: AuthStatus) => InferenceAccess;
  /** Clipboard key detection (see AuthState.keyDetection). */
  keyDetection?: () => KeyDetectionState;
  /** Compute key metadata without `orgMatchesAccount` (the hub fills it in; see AuthState.computeKey). */
  computeKeyInfo?: () => ComputeKeyInfo;
}

/** Builds AuthState snapshots and broadcasts them (renderer + in-process listeners). */
export class AuthStateHub {
  runtime: RuntimeAuth = { status: 'signed_out', scopes: [], accessTokenExpiresAt: null, lastError: null, signInInProgress: false, orgIdPending: false };
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(private readonly deps: AuthHubDeps) {}

  snapshot(): AuthState {
    const file = this.deps.file.get();
    const key = this.deps.keyInfo();
    const orgMatchesAccount = deriveOrgMatch(this.runtime.status, file.orgId, key.orgId);
    return {
      status: this.runtime.status,
      scopes: [...this.runtime.scopes],
      orgId: file.orgId,
      signedInAt: this.runtime.status === 'signed_in' ? file.signedInAt : null,
      accessTokenExpiresAt: this.runtime.accessTokenExpiresAt,
      inferenceKey: { ...key, orgMatchesAccount },
      secureStorage: this.deps.secureStorage,
      lastError: this.runtime.lastError,
      mock: this.deps.mock,
      signInInProgress: this.runtime.signInInProgress,
      orgIdPending: this.runtime.status === 'signed_in' && this.runtime.orgIdPending,
      lockedSecrets: this.deps.lockedSecrets?.() ?? [],
      ...(this.deps.inference ? { inference: this.deps.inference(this.runtime.status) } : {}),
      ...(this.deps.keyDetection ? { keyDetection: this.deps.keyDetection() } : {}),
      ...(this.deps.computeKeyInfo ? { computeKey: this.computeKeySnapshot(this.deps.computeKeyInfo(), file.orgId) } : {}),
    };
  }

  private computeKeySnapshot(info: ComputeKeyInfo, accountOrgId: string | null): ComputeKeyInfo {
    return { ...info, orgMatchesAccount: deriveOrgMatch(this.runtime.status, accountOrgId, info.orgId) };
  }

  /** Applies a runtime patch and broadcasts the new state. */
  update(patch: Partial<RuntimeAuth>): AuthState {
    this.runtime = { ...this.runtime, ...patch };
    return this.emit();
  }

  emit(): AuthState {
    const state = this.snapshot();
    this.deps.events.emit('auth:changed', state);
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // a faulty listener must not break auth
      }
    }
    return state;
  }

  onChange(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Whether the key's organization is the signed-in one; null unless signed in with both ids known. */
export function deriveOrgMatch(status: AuthStatus, accountOrgId: string | null, keyOrgId: string | null): boolean | null {
  if (status !== 'signed_in' || !accountOrgId || !keyOrgId) return null;
  return accountOrgId === keyOrgId;
}

export function isoFromEpoch(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
