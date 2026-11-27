import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecureStorageBackend } from '@shared/contracts/app';
import type { Logger } from './logger';
import { atomicWriteFile } from './store';

/** Encryption provider (Electron safeStorage async API in the app, a fake in tests). */
export interface Cipher {
  isAvailable(): Promise<boolean>;
  backend(): SecureStorageBackend;
  encrypt(plain: string): Promise<Buffer>;
  /** `shouldReEncrypt` is true when the OS rotated keys; the store then rewrites the value. */
  decrypt(data: Buffer): Promise<{ value: string; shouldReEncrypt: boolean }>;
}

/**
 * - ok: value returned
 * - missing: nothing stored
 * - unreadable: a stored value exists but could not be decrypted right now (keyring locked, different
 *   desktop session, OS denied access). The file is KEPT so a later launch can read it again; callers
 *   must not treat this as "signed out / no key" in a way that deletes related metadata.
 */
export type SecretStatus = 'ok' | 'missing' | 'unreadable';

/** Secrets at rest: OAuth tokens, the inference key. Values never go to the renderer. */
export interface SecureStore {
  readonly backend: SecureStorageBackend;
  /** The value, or null when missing OR unreadable (use getWithStatus to tell them apart). */
  get(key: string): Promise<string | null>;
  getWithStatus(key: string): Promise<{ value: string | null; status: SecretStatus }>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`invalid secure-store key: ${key}`);
}

/**
 * Files in `dir`, each encrypted with the OS keychain-backed cipher. When encryption is not
 * available the store keeps values in memory only (nothing sensitive is written in clear).
 */
export async function createSecureStore(dir: string, cipher: Cipher, log: Logger): Promise<SecureStore> {
  let available = false;
  try {
    available = await cipher.isAvailable();
  } catch (error) {
    log.warn('could not query OS encryption availability', error);
  }
  const backend: SecureStorageBackend = available ? cipher.backend() : 'unavailable';
  const memory = new Map<string, string>();
  if (!available) log.warn('OS encryption is unavailable; secrets will be kept in memory only for this session');
  else if (backend === 'basic_text') log.warn('no OS keyring found; secrets are encrypted with a weak built-in key (basic_text)');

  const fileFor = (key: string) => join(dir, `${key}.bin`);

  const write = async (key: string, value: string) => {
    await atomicWriteFile(fileFor(key), await cipher.encrypt(value), 0o600);
  };

  const getWithStatus = async (key: string): Promise<{ value: string | null; status: SecretStatus }> => {
    assertKey(key);
    if (!available) {
      const value = memory.get(key) ?? null;
      return { value, status: value === null ? 'missing' : 'ok' };
    }
    let data: Buffer;
    try {
      data = await readFile(fileFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, status: 'missing' };
      throw error;
    }
    try {
      const { value, shouldReEncrypt } = await cipher.decrypt(data);
      if (shouldReEncrypt) await write(key, value).catch((error) => log.warn(`could not re-encrypt ${key}`, error));
      return { value, status: 'ok' };
    } catch (error) {
      // Often temporary (locked keyring, other desktop session, access denied): keep the file.
      log.warn(`could not decrypt secret ${key}; keeping it for a later launch`, error);
      return { value: null, status: 'unreadable' };
    }
  };

  return {
    backend,
    getWithStatus,
    async get(key) {
      return (await getWithStatus(key)).value;
    },
    async set(key, value) {
      assertKey(key);
      if (!available) {
        memory.set(key, value);
        return;
      }
      await write(key, value);
    },
    async delete(key) {
      assertKey(key);
      memory.delete(key);
      if (available) await rm(fileFor(key), { force: true });
    },
  };
}

/** In-memory store for tests and mock mode. */
export function createMemorySecureStore(backend: SecureStorageBackend = 'os'): SecureStore {
  const memory = new Map<string, string>();
  return {
    backend,
    get: async (key) => {
      assertKey(key);
      return memory.get(key) ?? null;
    },
    getWithStatus: async (key) => {
      assertKey(key);
      const value = memory.get(key) ?? null;
      return { value, status: value === null ? 'missing' : 'ok' };
    },
    set: async (key, value) => {
      assertKey(key);
      memory.set(key, value);
    },
    delete: async (key) => {
      assertKey(key);
      memory.delete(key);
    },
  };
}
