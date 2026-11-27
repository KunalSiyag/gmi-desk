/**
 * The Compute key (`ce_resource`: Cluster Engine containers and Agentbox sandboxes; compute.md DC1, §4). The auth
 * slice owns it; other slices get it only through ComputeKeyProvider. It is validated with GET /me/api-keys/current
 * and kept in the secure store as `compute.key`; only metadata (last 4, org, status) is persisted in auth.json or sent
 * to the renderer.
 *
 * The key carries spend authority for the whole organization, so with a weak keyring (`basic_text`) it is kept in
 * memory for this session only unless the user confirms storing it in a native dialog shown by main (T21).
 */
import type { ComputeKeyInfo } from '@shared/contracts/auth';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { Platform } from '../../core/context';
import type { Http } from '../../core/http';
import type { Logger } from '../../core/logger';
import type { SecretStatus, SecureStore } from '../../core/secure-store';
import type { ComputeKeyProvider } from '../../core/services';
import type { JsonStore } from '../../core/store';
import { COMPUTE_KEY_LOCKED_MESSAGE, COMPUTE_KEY_REVALIDATE_MS, KEY_VALIDATION_URL, SECURE_KEYS } from './constants';
import { keyScopesOf, last4Of, MAX_KEY_LENGTH, parseKeyResponse, type VerifiedKey } from './keys';
import type { AuthFile, KeyMeta } from './state';

/** A ComputeKeyProvider with no key: get → null, require → no_compute_key, reports and listeners do nothing. */
export function createUnavailableComputeKeys(): ComputeKeyProvider {
  return {
    getComputeKey: async () => null,
    requireComputeKey: async () => {
      throw new GmiError('no_compute_key', NO_COMPUTE_KEY_MESSAGE);
    },
    reportInvalidComputeKey: async () => undefined,
    onChange: () => () => undefined,
  };
}

export const NO_COMPUTE_KEY_MESSAGE = 'Compute needs a GMI Compute API key. Connect Compute to add one.';

/** `GmiError.detail` when the key checked is an inference key (Connect Compute offers "Use it for chat instead"). */
export const INFERENCE_SCOPE_DETAIL = 'scope:ie_model';
/** `GmiError.detail` when GMI names neither scope for the key. */
export const UNKNOWN_SCOPE_DETAIL = 'scope:unknown';

export const INFERENCE_KEY_FOR_COMPUTE_MESSAGE = 'This is an inference (chat) key. Compute needs a Compute key (GMI Console › Cluster Engine › API Keys).';
export const UNKNOWN_SCOPE_MESSAGE = 'GMI did not confirm that this key can manage containers and sandboxes. Create a Compute key in GMI Console.';

/**
 * Wire form of ComputeKeyInfo: `sessionOnly` is true while the key is kept in memory for this session only (weak
 * keyring declined, or no encryption at all). Additive field pending a contract update (C1-A report).
 */
export interface ComputeKeyInfoWire extends ComputeKeyInfo {
  sessionOnly?: boolean;
}

/** Trims and checks the pasted key's format. Throws GmiError('invalid_input'). */
export function normalizeComputeKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new GmiError('invalid_input', 'Paste your GMI Compute API key.');
  const key = raw.trim();
  if (!key) throw new GmiError('invalid_input', 'Paste your GMI Compute API key.');
  if (key.length > MAX_KEY_LENGTH) throw new GmiError('invalid_input', 'That is too long to be a GMI API key.');
  if (/\s/.test(key)) throw new GmiError('invalid_input', 'API keys cannot contain spaces or line breaks.');
  return key;
}

/**
 * Asks GMI about a Compute key. Resolves for a key with the `ce_resource` scope; throws GmiError:
 * `invalid_compute_key` (401), `invalid_input` with detail INFERENCE_SCOPE_DETAIL (an inference key) or
 * UNKNOWN_SCOPE_DETAIL (no known scope), and `unauthorized` (403: never a dead key) / `network` / `timeout` /
 * `upstream` otherwise.
 */
export async function verifyComputeKey(http: Http, key: string, signal?: AbortSignal): Promise<VerifiedKey> {
  const body = await http.json<unknown>(KEY_VALIDATION_URL, {
    bearer: key,
    unauthorizedCode: 'invalid_compute_key',
    timeoutMs: 15_000,
    retries: 1,
    signal,
  });
  const scopes = keyScopesOf(body);
  const info = parseKeyResponse(body);
  if (scopes.includes('ce_resource')) return { ...info, scope: 'ce_resource' };
  if (scopes.includes('ie_model')) throw new GmiError('invalid_input', INFERENCE_KEY_FOR_COMPUTE_MESSAGE, { detail: INFERENCE_SCOPE_DETAIL });
  throw new GmiError('invalid_input', UNKNOWN_SCOPE_MESSAGE, { detail: UNKNOWN_SCOPE_DETAIL });
}

/** Whether `error` says GMI rejected the key itself (as opposed to a transient or permission failure). */
function rejectsKey(error: GmiError): boolean {
  if (error.code === 'invalid_compute_key') return true;
  return error.code === 'invalid_input' && (error.detail === INFERENCE_SCOPE_DETAIL || error.detail === UNKNOWN_SCOPE_DETAIL);
}

/** The native dialog (main process) before a Compute key is written under the weak built-in key (`basic_text`). */
export const WEAK_KEYRING_CONFIRM = {
  title: 'Store the Compute key with weak encryption?',
  message: 'No OS keyring was found, so GMI Desk can only protect this key with a weak built-in key.',
  detail:
    'A Compute key can create, change and delete paid machines for your whole GMI organization. Anyone who can read your files could use it. "Keep for this session" holds it in memory until you quit GMI Desk.',
  confirmLabel: 'Store it anyway',
  cancelLabel: 'Keep for this session',
} as const;

export interface ComputeKeyManagerDeps {
  http: Http;
  secure: SecureStore;
  file: JsonStore<AuthFile>;
  platform: Pick<Platform, 'confirm'>;
  now: () => Date;
  log: Logger;
  /** Broadcasts the new AuthState. */
  emit: () => void;
}

export interface SetComputeKeyResult {
  /** True when the key is kept in memory for this session only. */
  sessionOnly: boolean;
}

const MISSING: ComputeKeyInfo = { status: 'missing', last4: null, keyId: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };

export class ComputeKeyManager {
  /** The key in use (saved, or session-only), cached after the first read. undefined = not read yet. */
  private stored: string | null | undefined;
  /** A key is saved but the OS keychain would not decrypt it (kept on disk, metadata kept). */
  private unreadable = false;
  /** The key lives in memory only (never written): weak keyring declined, or encryption unavailable. */
  private sessionOnly = false;
  /** Metadata of a session-only key (never persisted: the key will be gone after a restart). */
  private sessionMeta: KeyMeta | null = null;
  /** Bumped when the user saves or removes a key, so a read or check that started earlier does not undo it. */
  private epoch = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ComputeKeyManagerDeps) {}

  /** True when a saved key exists but could not be read (OS keychain locked or unavailable). */
  get locked(): boolean {
    return this.unreadable;
  }

  private async readStored(): Promise<{ value: string | null; status: SecretStatus }> {
    try {
      return await this.deps.secure.getWithStatus(SECURE_KEYS.computeKey);
    } catch (error) {
      // An I/O error is not proof that there is no key: keep it and its metadata.
      this.deps.log.warn('could not read the stored Compute key', toGmiError(error).code);
      return { value: null, status: 'unreadable' };
    }
  }

  /**
   * Reads the saved key and reconciles it with auth.json. A key the keychain would not decrypt keeps its metadata;
   * only a key that is really missing clears it. A session-only key is never replaced by a read.
   */
  async load(): Promise<void> {
    const epoch = this.epoch;
    const { value: key, status } = await this.readStored();
    if (epoch !== this.epoch || this.sessionOnly) return;
    const wasUnreadable = this.unreadable;
    this.stored = key;
    this.unreadable = status === 'unreadable';
    if (status === 'unreadable') {
      this.deps.log.warn('the saved Compute key could not be read (OS keychain locked or unavailable)');
      return;
    }
    const meta = this.deps.file.get().computeKey ?? null;
    if (!key && meta) {
      await this.deps.file.update((f) => ({ ...f, computeKey: null }));
    } else if (key && (!meta || meta.last4 !== last4Of(key))) {
      await this.deps.file.update((f) => ({
        ...f,
        computeKey: { keyId: null, scope: 'ce_resource', orgId: null, last4: last4Of(key), validatedAt: null, status: 'unverified', error: null },
      }));
    }
    if (wasUnreadable) this.changed();
  }

  /** Reads a saved key the OS keychain would not decrypt earlier again (after the user unlocked it). */
  async reload(): Promise<void> {
    if (this.unreadable) await this.load();
  }

  /** Metadata for the UI (orgMatchesAccount is filled in by the state hub). Never the key. */
  info(): ComputeKeyInfoWire {
    if (this.unreadable) {
      const meta = this.deps.file.get().computeKey ?? null;
      return { ...(meta ? this.metaToInfo(meta) : MISSING), status: 'unverified', error: COMPUTE_KEY_LOCKED_MESSAGE };
    }
    const meta = this.activeMeta();
    if (!this.stored || !meta) return { ...MISSING };
    return this.sessionOnly ? { ...this.metaToInfo(meta), sessionOnly: true } : this.metaToInfo(meta);
  }

  private metaToInfo(meta: KeyMeta): ComputeKeyInfo {
    return {
      status: meta.status,
      last4: meta.last4,
      keyId: meta.keyId,
      orgId: meta.orgId,
      orgMatchesAccount: null,
      validatedAt: meta.validatedAt,
      error: meta.error,
    };
  }

  /** A key is usable right now (saved and readable, or session-only). */
  hasKey(): boolean {
    return Boolean(this.stored);
  }

  async getKey(): Promise<string | null> {
    if (this.stored === undefined) await this.load();
    return this.stored ?? null;
  }

  async requireKey(): Promise<string> {
    const key = await this.getKey();
    if (!key) throw new GmiError('no_compute_key', this.locked ? COMPUTE_KEY_LOCKED_MESSAGE : NO_COMPUTE_KEY_MESSAGE);
    return key;
  }

  /** The saved key's last check is older than a day (or never happened): check it in the background at startup. */
  needsRevalidation(): boolean {
    if (!this.stored || this.unreadable) return false;
    const meta = this.activeMeta();
    if (!meta || meta.status === 'invalid') return false;
    const at = meta.validatedAt ? Date.parse(meta.validatedAt) : Number.NaN;
    return !Number.isFinite(at) || this.deps.now().getTime() - at >= COMPUTE_KEY_REVALIDATE_MS;
  }

  /**
   * Validates with GMI, then stores (replacing a saved key, readable or not). Nothing is stored when validation fails.
   * With a weak keyring the user chooses in a native dialog between storing it and keeping it for this session; with
   * no encryption at all it is kept for this session (the secure store would only hold it in memory anyway).
   */
  async set(raw: unknown): Promise<SetComputeKeyResult> {
    const key = normalizeComputeKey(raw);
    const verified = await verifyComputeKey(this.deps.http, key);
    const backend = this.deps.secure.backend;
    const persist = backend === 'os' ? true : backend === 'basic_text' ? await this.deps.platform.confirm({ ...WEAK_KEYRING_CONFIRM }) : false;
    const meta: KeyMeta = {
      keyId: verified.keyId,
      scope: 'ce_resource',
      orgId: verified.orgId,
      last4: last4Of(key),
      validatedAt: this.deps.now().toISOString(),
      status: 'valid',
      error: null,
    };
    this.epoch += 1;
    if (persist) {
      await this.deps.secure.set(SECURE_KEYS.computeKey, key);
      await this.deps.file.update((f) => ({ ...f, computeKey: meta }));
      this.sessionMeta = null;
      this.sessionOnly = false;
    } else {
      // An older saved key must not come back at the next start.
      await this.deps.secure.delete(SECURE_KEYS.computeKey).catch((error) => this.deps.log.warn('could not delete the saved Compute key', toGmiError(error).code));
      await this.deps.file.update((f) => ({ ...f, computeKey: null }));
      this.sessionMeta = meta;
      this.sessionOnly = true;
    }
    this.stored = key;
    this.unreadable = false;
    this.changed();
    return { sessionOnly: !persist };
  }

  /** Deletes the key from this computer. Resources it created keep running (and billing) in GMI. */
  async remove(): Promise<void> {
    this.epoch += 1;
    await this.deps.secure.delete(SECURE_KEYS.computeKey);
    await this.deps.file.update((f) => ({ ...f, computeKey: null }));
    this.stored = null;
    this.unreadable = false;
    this.sessionOnly = false;
    this.sessionMeta = null;
    this.changed();
  }

  /**
   * Re-checks the key. A rejected key (401, or not a Compute key) resolves with status `invalid`; transient failures
   * and a 403 throw and leave the status as it was. An answer about a key replaced meanwhile is dropped.
   */
  async revalidate(): Promise<void> {
    if (this.locked) await this.reload();
    const key = await this.getKey();
    if (!key) {
      if (this.locked) throw new GmiError('no_compute_key', COMPUTE_KEY_LOCKED_MESSAGE);
      return;
    }
    const epoch = this.epoch;
    let verified: VerifiedKey | null = null;
    let failure: GmiError | null = null;
    try {
      verified = await verifyComputeKey(this.deps.http, key);
    } catch (error) {
      failure = toGmiError(error);
    }
    if (epoch !== this.epoch || (await this.getKey()) !== key) return;
    const current = this.activeMeta();
    let next: KeyMeta;
    if (verified) {
      next = { ...verified, last4: last4Of(key), validatedAt: this.deps.now().toISOString(), status: 'valid', error: null };
    } else if (failure && rejectsKey(failure)) {
      next = {
        keyId: current?.keyId ?? null,
        scope: failure.detail === INFERENCE_SCOPE_DETAIL ? 'ie_model' : (current?.scope ?? null),
        orgId: current?.orgId ?? null,
        last4: last4Of(key),
        validatedAt: this.deps.now().toISOString(),
        status: 'invalid',
        error: failure.code === 'invalid_compute_key' ? `GMI rejected this key: ${failure.message}` : failure.message,
      };
    } else {
      throw failure ?? new GmiError('internal', 'Could not verify the Compute key.');
    }
    await this.writeActiveMeta(next);
    this.changed();
  }

  /**
   * A compute call got `status` for `key`. Only a 401 (or an unknown status) marks the key invalid: a 403 means the
   * organization is not entitled or lacks a permission, never a dead key. A report about a key that is no longer the
   * active one is ignored.
   */
  async reportInvalid(reason: string, key?: string | null, status?: number | null): Promise<void> {
    if (status !== undefined && status !== null && status !== 401) return;
    if (key !== undefined && key !== (await this.getKey())) return;
    const current = this.activeMeta();
    if (!this.stored || !current || current.status === 'invalid') return;
    const error = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : 'GMI rejected the Compute API key.';
    await this.writeActiveMeta({ ...current, status: 'invalid', error });
    this.changed();
  }

  /** Called after every change of the key or its status (set, remove, invalid, unlocked). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The provider other slices get (DC1): never the manager itself. */
  provider(): ComputeKeyProvider {
    return {
      getComputeKey: () => this.getKey(),
      requireComputeKey: () => this.requireKey(),
      reportInvalidComputeKey: (reason, key, status) => this.reportInvalid(reason, key, status),
      onChange: (listener) => this.onChange(listener),
    };
  }

  private activeMeta(): KeyMeta | null {
    return this.sessionOnly ? this.sessionMeta : (this.deps.file.get().computeKey ?? null);
  }

  private async writeActiveMeta(meta: KeyMeta): Promise<void> {
    if (this.sessionOnly) {
      this.sessionMeta = meta;
      return;
    }
    await this.deps.file.update((f) => ({ ...f, computeKey: meta }));
  }

  private changed(): void {
    this.deps.emit();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a faulty listener must not break auth
      }
    }
  }
}
