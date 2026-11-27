/**
 * The inference API key (chat, GMI Router). Validated with GET /me/api-keys/current, kept in the
 * secure store; only metadata (last 4, scope, org, status) is persisted in auth.json or sent to the UI.
 */
import type { InferenceKeyInfo } from '@shared/contracts/auth';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { Http } from '../../core/http';
import type { KeyProvider } from '../../core/services';
import type { Logger } from '../../core/logger';
import type { SecretStatus, SecureStore } from '../../core/secure-store';
import type { JsonStore } from '../../core/store';
import { KEY_LOCKED_MESSAGE, KEY_VALIDATION_URL, SECURE_KEYS } from './constants';
import type { AuthFile, KeyMeta, KeyScope } from './state';

export const MAX_KEY_LENGTH = 4096;

/**
 * KeyProvider whose reportInvalidKey also takes the key the failed request used: a late 401 for a key the user
 * has since replaced must not mark the new key invalid. (Callers typed as plain KeyProvider pass only a reason.)
 */
export interface AuthKeyProvider extends KeyProvider {
  reportInvalidKey(reason: string, key?: string | null, status?: number | null): Promise<void>;
}

/** A packaged Electron app (not `electron .` in development, not plain Node as in tests). */
export function isPackagedApp(proc: { versions: NodeJS.ProcessVersions; defaultApp?: boolean } = process): boolean {
  return typeof proc.versions.electron === 'string' && proc.defaultApp !== true;
}

/**
 * GMI_API_KEY replaces the saved key: a developer override, honoured only in development runs. A packaged app
 * ignores it (a stray variable must not silently take over chat billing), and GMI_DESK_ALLOW_ENV_KEY=0 turns it off.
 */
export function envKeyFromEnvironment(env: NodeJS.ProcessEnv = process.env, packaged = isPackagedApp()): string | null {
  if (packaged || env.GMI_DESK_ALLOW_ENV_KEY === '0') return null;
  return env.GMI_API_KEY?.trim() || null;
}
export const COMPUTE_KEY_MESSAGE = 'That is a Compute (Agentbox) key; chat needs an Inference key (Console > Inference > API Keys)';

/** Trims and checks the pasted key's format. Throws GmiError('invalid_input'). */
export function normalizeInferenceKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new GmiError('invalid_input', 'Paste your GMI inference API key.');
  const key = raw.trim();
  if (!key) throw new GmiError('invalid_input', 'Paste your GMI inference API key.');
  if (key.length > MAX_KEY_LENGTH) throw new GmiError('invalid_input', 'That is too long to be a GMI API key.');
  if (/\s/.test(key)) throw new GmiError('invalid_input', 'API keys cannot contain spaces or line breaks.');
  return key;
}

export function last4Of(key: string): string {
  return key.slice(-4);
}

export interface VerifiedKey {
  keyId: string | null;
  scope: KeyScope | null;
  orgId: string | null;
}

const idOf = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 200) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Every scope GMI names for the key (`key.scope` as a string, comma/space separated, or a list). */
export function keyScopesOf(body: unknown): string[] {
  const scope = objOf(objOf(body).key).scope;
  const raw = Array.isArray(scope) ? scope.filter((s): s is string => typeof s === 'string').join(',') : typeof scope === 'string' ? scope : '';
  return raw.split(/[\s,]+/).filter(Boolean);
}

/** Reads `{"key":{"id","scope"},"organization":{"id"}}` leniently. */
export function parseKeyResponse(body: unknown): VerifiedKey {
  const b = objOf(body);
  const key = objOf(b.key);
  const org = objOf(b.organization);
  const rawScope = Array.isArray(key.scope) ? key.scope.filter((s) => typeof s === 'string').join(',') : typeof key.scope === 'string' ? key.scope : '';
  const scope: KeyScope | null = /\bie_model\b/.test(rawScope) ? 'ie_model' : /\bce_resource\b/.test(rawScope) ? 'ce_resource' : null;
  return {
    keyId: idOf(key.id),
    scope,
    orgId: idOf(org.id) ?? idOf(key.organization_id) ?? idOf(key.org_id),
  };
}

/**
 * Asks GMI about the key. Resolves for an inference key; throws GmiError: `invalid_api_key` (401,
 * with GMI's message), `invalid_input` (a compute key), `network`/`timeout`/`upstream` otherwise.
 */
export async function verifyInferenceKey(http: Http, key: string, signal?: AbortSignal): Promise<VerifiedKey> {
  const body = await http.json<unknown>(KEY_VALIDATION_URL, {
    bearer: key,
    unauthorizedCode: 'invalid_api_key',
    timeoutMs: 15_000,
    retries: 1,
    signal,
  });
  const info = parseKeyResponse(body);
  if (info.scope === 'ce_resource') throw new GmiError('invalid_input', COMPUTE_KEY_MESSAGE);
  return info;
}

export interface KeyManagerDeps {
  http: Http;
  secure: SecureStore;
  file: JsonStore<AuthFile>;
  now: () => Date;
  log: Logger;
  /** GMI_API_KEY from the environment (dev); overrides the stored key. */
  envKey: string | null;
  /** Broadcasts the new AuthState. */
  emit: () => void;
}

const MISSING: InferenceKeyInfo = {
  status: 'missing',
  source: null,
  last4: null,
  keyId: null,
  scope: null,
  orgId: null,
  orgMatchesAccount: null,
  validatedAt: null,
  error: null,
};

export class KeyManager {
  /** Stored (keychain) key, cached after the first read. undefined = not read yet. */
  private stored: string | null | undefined;
  /** A key is saved but the OS keychain would not decrypt it (kept on disk, metadata kept; see reload()). */
  private unreadable = false;
  /** Bumped when the user saves or removes a key, so a read that started earlier does not undo it. */
  private epoch = 0;
  /** Validation results for the env key (memory only; the env may differ next run). */
  private envMeta: KeyMeta | null;

  constructor(private readonly deps: KeyManagerDeps) {
    this.envMeta = deps.envKey
      ? { keyId: null, scope: null, orgId: null, last4: last4Of(deps.envKey), validatedAt: null, status: 'unverified', error: null }
      : null;
  }

  /** True when a saved key exists but could not be read (OS keychain locked or unavailable) and no env key replaces it. */
  get locked(): boolean {
    return !this.deps.envKey && this.unreadable;
  }

  private async readStored(): Promise<{ value: string | null; status: SecretStatus }> {
    try {
      return await this.deps.secure.getWithStatus(SECURE_KEYS.inferenceKey);
    } catch (error) {
      // An I/O error is not proof that there is no key: keep it and its metadata.
      this.deps.log.warn('could not read the stored inference key', error);
      return { value: null, status: 'unreadable' };
    }
  }

  /**
   * Reads the stored key and reconciles it with the metadata in auth.json. A key the keychain would not decrypt
   * keeps its metadata (it is not gone); only a key that is really missing clears it.
   */
  async load(): Promise<void> {
    const epoch = this.epoch;
    const { value: key, status } = await this.readStored();
    if (epoch !== this.epoch) return; // the user saved or removed a key meanwhile: that wins
    this.stored = key;
    this.unreadable = status === 'unreadable';
    if (status === 'unreadable') {
      this.deps.log.warn('the saved inference key could not be read (OS keychain locked or unavailable)');
      return;
    }
    const meta = this.deps.file.get().inferenceKey;
    if (!key && meta) {
      await this.deps.file.update((f) => ({ ...f, inferenceKey: null }));
    } else if (key && (!meta || meta.last4 !== last4Of(key))) {
      await this.deps.file.update((f) => ({
        ...f,
        inferenceKey: { keyId: null, scope: null, orgId: null, last4: last4Of(key), validatedAt: null, status: 'unverified', error: null },
      }));
    }
  }

  /** Reads a saved key the OS keychain would not decrypt earlier again (after the user unlocked it). */
  async reload(): Promise<void> {
    if (this.unreadable) await this.load();
  }

  /** Metadata for the UI (orgMatchesAccount is filled in by the state hub). */
  info(): InferenceKeyInfo {
    if (this.deps.envKey && this.envMeta) return { ...this.metaToInfo(this.envMeta), source: 'env' };
    const meta = this.deps.file.get().inferenceKey;
    if (this.unreadable) {
      // Saved but unreadable right now: still the user's key (not "missing"), just not usable until it is read.
      const known = meta ? this.metaToInfo(meta) : { ...MISSING };
      return { ...known, status: 'unverified', source: 'keychain', error: KEY_LOCKED_MESSAGE };
    }
    if (!this.stored || !meta) return { ...MISSING };
    return { ...this.metaToInfo(meta), source: 'keychain' };
  }

  private metaToInfo(meta: KeyMeta): InferenceKeyInfo {
    return {
      status: meta.status,
      source: null,
      last4: meta.last4,
      keyId: meta.keyId,
      scope: meta.scope,
      orgId: meta.orgId,
      orgMatchesAccount: null,
      validatedAt: meta.validatedAt,
      error: meta.error,
    };
  }

  /** A key is available right now (GMI_API_KEY, or a saved key the keychain could read). */
  hasKey(): boolean {
    return Boolean(this.deps.envKey) || Boolean(this.stored);
  }

  async getKey(): Promise<string | null> {
    if (this.deps.envKey) return this.deps.envKey;
    if (this.stored === undefined) await this.load();
    return this.stored ?? null;
  }

  async requireKey(): Promise<string> {
    const key = await this.getKey();
    if (!key) throw new GmiError('no_api_key', this.locked ? KEY_LOCKED_MESSAGE : 'Add a GMI inference API key in Settings to use chat.');
    return key;
  }

  /** Validates with GMI, then stores (replacing a saved key, readable or not). Nothing is stored when validation fails. */
  async set(raw: unknown): Promise<void> {
    const key = normalizeInferenceKey(raw);
    const verified = await verifyInferenceKey(this.deps.http, key);
    this.epoch += 1;
    await this.deps.secure.set(SECURE_KEYS.inferenceKey, key);
    this.stored = key;
    this.unreadable = false;
    await this.deps.file.update((f) => ({
      ...f,
      inferenceKey: {
        keyId: verified.keyId,
        scope: verified.scope,
        orgId: verified.orgId,
        last4: last4Of(key),
        validatedAt: this.deps.now().toISOString(),
        status: 'valid',
        error: null,
      },
    }));
    this.deps.emit();
  }

  async remove(): Promise<void> {
    this.epoch += 1;
    await this.deps.secure.delete(SECURE_KEYS.inferenceKey);
    this.stored = null;
    this.unreadable = false;
    await this.deps.file.update((f) => ({ ...f, inferenceKey: null }));
    this.deps.emit();
  }

  /**
   * Re-checks the active key. A rejected key resolves with status `invalid`; transient failures
   * (network, GMI down) throw and leave the status as it was. An answer about a key that was replaced or
   * removed while GMI answered is dropped. A key the keychain could not read is read again first.
   */
  async revalidate(): Promise<void> {
    if (this.locked) await this.reload();
    const key = await this.getKey();
    if (!key) {
      if (this.locked) throw new GmiError('no_api_key', KEY_LOCKED_MESSAGE);
      return;
    }
    let verified: VerifiedKey | null = null;
    let failure: GmiError | null = null;
    try {
      verified = await verifyInferenceKey(this.deps.http, key);
    } catch (error) {
      failure = toGmiError(error);
    }
    if ((await this.getKey()) !== key) return; // replaced meanwhile: the answer is about a key no longer in use
    let next: KeyMeta;
    if (verified) {
      next = { ...verified, last4: last4Of(key), validatedAt: this.deps.now().toISOString(), status: 'valid', error: null };
    } else if (failure && (failure.code === 'invalid_api_key' || (failure.code === 'invalid_input' && failure.message === COMPUTE_KEY_MESSAGE))) {
      const current = this.activeMeta();
      next = {
        keyId: current?.keyId ?? null,
        scope: failure.code === 'invalid_input' ? 'ce_resource' : (current?.scope ?? null),
        orgId: current?.orgId ?? null,
        last4: last4Of(key),
        validatedAt: this.deps.now().toISOString(),
        status: 'invalid',
        error: failure.code === 'invalid_input' ? failure.message : `GMI rejected this key: ${failure.message}`,
      };
    } else {
      throw failure ?? new GmiError('internal', 'Could not verify the inference key.');
    }
    await this.writeActiveMeta(next);
    this.deps.emit();
  }

  /**
   * Chat/router/catalog got a 401 for `key`: mark it invalid so the UI asks for a new one. Pass the key the
   * request used: a report about a key that is no longer the active one (replaced while the request ran) is
   * ignored. Without `key` the active key is meant (older callers).
   */
  async reportInvalid(reason: string, key?: string | null): Promise<void> {
    if (key !== undefined && key !== (await this.getKey())) return;
    const current = this.activeMeta();
    if (!current) return;
    const error = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : 'GMI rejected the inference API key.';
    await this.writeActiveMeta({ ...current, status: 'invalid', error });
    this.deps.emit();
  }

  private activeMeta(): KeyMeta | null {
    if (this.deps.envKey) return this.envMeta;
    return this.stored ? this.deps.file.get().inferenceKey : null;
  }

  private async writeActiveMeta(meta: KeyMeta): Promise<void> {
    if (this.deps.envKey) {
      this.envMeta = meta;
      return;
    }
    await this.deps.file.update((f) => ({ ...f, inferenceKey: meta }));
  }
}
