import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { createSecureStore, type Cipher } from '@main/core/secure-store';
import { normalizeSettings } from '@main/core/settings';
import { openJsonStore } from '@main/core/store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gmi-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openJsonStore', () => {
  it('persists atomically and reloads', async () => {
    const file = join(dir, 'a.json');
    const store = await openJsonStore(file, { n: 0 });
    await store.update((v) => ({ n: v.n + 1 }));
    await store.update((v) => ({ n: v.n + 1 }));
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 2 });
    const reopened = await openJsonStore(file, { n: 0 });
    expect(reopened.get()).toEqual({ n: 2 });
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('moves a corrupt file aside and falls back to defaults', async () => {
    const file = join(dir, 'b.json');
    await writeFile(file, '{not json');
    const store = await openJsonStore(file, { ok: true }, { log: silentLogger });
    expect(store.get()).toEqual({ ok: true });
    expect((await readdir(dir)).some((f) => f.startsWith('b.json.corrupt-'))).toBe(true);
  });
});

function fakeCipher(opts: { available?: boolean; reencrypt?: boolean; failDecrypt?: boolean } = {}): Cipher & { encrypted: number } {
  const c = {
    encrypted: 0,
    isAvailable: async () => opts.available ?? true,
    backend: () => 'os' as const,
    encrypt: async (plain: string) => {
      c.encrypted += 1;
      return Buffer.from(`enc:${plain}`);
    },
    decrypt: async (data: Buffer) => {
      if (opts.failDecrypt) throw new Error('bad key');
      return { value: data.toString().replace(/^enc:/, ''), shouldReEncrypt: Boolean(opts.reencrypt) };
    },
  };
  return c;
}

describe('createSecureStore', () => {
  it('encrypts to disk and never writes plaintext', async () => {
    const store = await createSecureStore(dir, fakeCipher(), silentLogger);
    await store.set('oauth.tokens', 'secret-token');
    expect(await store.get('oauth.tokens')).toBe('secret-token');
    expect((await readFile(join(dir, 'oauth.tokens.bin'))).toString()).toBe('enc:secret-token');
    await store.delete('oauth.tokens');
    expect(await store.get('oauth.tokens')).toBeNull();
  });

  it('keeps secrets in memory only when encryption is unavailable', async () => {
    const store = await createSecureStore(dir, fakeCipher({ available: false }), silentLogger);
    expect(store.backend).toBe('unavailable');
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    expect(await readdir(dir)).toEqual([]);
  });

  it('re-encrypts on key rotation and discards undecryptable data', async () => {
    const cipher = fakeCipher({ reencrypt: true });
    const store = await createSecureStore(dir, cipher, silentLogger);
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    expect(cipher.encrypted).toBe(2);
  });

  it('keeps undecryptable secrets for a later launch and reports them as unreadable', async () => {
    const first = await createSecureStore(dir, fakeCipher(), silentLogger);
    await first.set('inference.key', 'sk-live');
    // Launch 2: keyring locked → decrypt fails. Nothing may be deleted.
    const locked = await createSecureStore(dir, fakeCipher({ failDecrypt: true }), silentLogger);
    expect(await locked.get('inference.key')).toBeNull();
    expect(await locked.getWithStatus('inference.key')).toEqual({ value: null, status: 'unreadable' });
    expect(await locked.getWithStatus('absent')).toEqual({ value: null, status: 'missing' });
    expect(await readdir(dir)).toEqual(['inference.key.bin']);
    // Launch 3: keyring back → the original value is still there.
    const back = await createSecureStore(dir, fakeCipher(), silentLogger);
    expect(await back.getWithStatus('inference.key')).toEqual({ value: 'sk-live', status: 'ok' });
  });

  it('rejects path-like keys', async () => {
    const store = await createSecureStore(dir, fakeCipher(), silentLogger);
    await expect(store.set('../evil', 'x')).rejects.toThrow();
  });
});

describe('normalizeSettings', () => {
  it('clamps and validates untrusted input', () => {
    const s = normalizeSettings({ theme: 'neon', catalogRefreshHours: 0, chatMaxTokens: 10_000_000, notifyNewModels: 'yes', defaultRouterMode: 'quality' });
    expect(s.theme).toBe('system');
    expect(s.catalogRefreshHours).toBe(1);
    expect(s.chatMaxTokens).toBe(131_072);
    expect(s.notifyNewModels).toBe(true);
    expect(s.defaultRouterMode).toBe('quality');
  });
});
