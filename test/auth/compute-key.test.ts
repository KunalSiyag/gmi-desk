/**
 * The Compute key (compute.md DC1, §4; slice C1-A), main process: validation and the scope check, secure storage,
 * session-only storage on a weak keyring, the locked keychain, 401/403 semantics, revalidation, clipboard detection
 * for Connect Compute, and that the key never reaches AuthState, events, auth.json or any API result.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import keyFixtures from '@main/mock/fixtures/auth/api-key-current.json';
import { silentLogger } from '@main/core/logger';
import { createSecureStore, type Cipher } from '@main/core/secure-store';
import type { AuthState } from '@shared/contracts/auth';
import { GmiError } from '@shared/contracts/errors';
import { createAuthSliceWith, type AuthSlice, type AuthSliceOptions } from '@main/services/auth';
import {
  ComputeKeyManager,
  INFERENCE_SCOPE_DETAIL,
  UNKNOWN_SCOPE_DETAIL,
  WEAK_KEYRING_CONFIRM,
  normalizeComputeKey,
} from '@main/services/auth/compute-keys';
import { COMPUTE_KEY_LOCKED_MESSAGE, SECURE_KEYS } from '@main/services/auth/constants';
import { normalizeAuthFile } from '@main/services/auth/state';
import { createFakeFetch, jsonResponse, type RecordedRequest } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';
import { exact, KEY_URL, lockableSecureStore, seedTokens, waitFor } from './helpers';

// --- fake keys (JWT-shaped, HS256 like GMI's keys; nothing real) ------------------------------------------
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: Record<string, unknown>, signature: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${signature}`;
const COMPUTE_A = jwt({ sub: 'test-compute-a' }, 'c2lnbmF0dXJlLWNvbXB1dGUta2V5LWFhQ0Ma');
const COMPUTE_B = jwt({ sub: 'test-compute-b' }, 'c2lnbmF0dXJlLWNvbXB1dGUta2V5LWJiQ0Mb');
const INFERENCE = jwt({ sub: 'test-inference' }, 'c2lnbmF0dXJlLWluZmVyZW5jZS1rZXktSU5m');
const NO_SCOPE = jwt({ sub: 'test-no-scope' }, 'c2lnbmF0dXJlLW5vLXNjb3BlLWtleS1Ob1Nj');
const REVOKED = jwt({ sub: 'test-revoked' }, 'c2lnbmF0dXJlLXJldm9rZWQta2V5LVJlVm8');
const FORBIDDEN = jwt({ sub: 'test-forbidden' }, 'c2lnbmF0dXJlLWZvcmJpZGRlbi1rZXktRm9y');
const ALL_KEYS = [COMPUTE_A, COMPUTE_B, INFERENCE, NO_SCOPE, REVOKED, FORBIDDEN];

const NOW = new Date('2026-11-02T12:00:00.000Z');
const DAY = 24 * 3_600_000;

let t: TestContext;
let slice: AuthSlice | null = null;
/** Bearer → status override, for keys that change answers over a test (revoked later, GMI down). */
let override: Map<string, () => Response>;

afterEach(async () => {
  await slice?.dispose();
  slice = null;
  await t?.cleanup();
});

/** Ends the current slice and context inside a test that sets up another one. */
async function restart() {
  await slice?.dispose();
  slice = null;
  await t.cleanup();
}

function keyEndpoint(req: RecordedRequest): Response {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const forced = override.get(bearer);
  if (forced) return forced();
  if (bearer === COMPUTE_A || bearer === COMPUTE_B) return jsonResponse(keyFixtures.compute);
  if (bearer === INFERENCE) return jsonResponse(keyFixtures.inference);
  if (bearer === NO_SCOPE) return jsonResponse({ key: { id: 'k-none' }, organization: { id: '00000000-0000-0000-0000-000000000000' } });
  if (bearer === FORBIDDEN) return jsonResponse({ message: 'forbidden' }, 403);
  return jsonResponse(keyFixtures.expired, 401);
}

/** A file-backed secure store over a fake cipher that reports `backend`. */
async function storeWithBackend(dir: string, backend: 'basic_text' | 'unavailable') {
  const cipher: Cipher = {
    isAvailable: async () => backend !== 'unavailable',
    backend: () => 'basic_text',
    encrypt: async (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decrypt: async (data) => ({ value: Buffer.from(data.toString('utf8').slice(4), 'base64').toString('utf8'), shouldReEncrypt: false }),
  };
  return createSecureStore(dir, cipher, silentLogger);
}

interface SetupOpts extends Partial<AuthSliceOptions> {
  signedIn?: boolean;
  authFile?: Record<string, unknown>;
  /** Replaces ctx.secure before the slice starts. */
  secure?: (t: TestContext) => Promise<TestContext['ctx']['secure']>;
  /** Saved secrets before the slice starts. */
  seed?: Record<string, string>;
  log?: TestContext['ctx']['log'];
}

async function setup(opts: SetupOpts = {}) {
  override = new Map();
  const fake = createFakeFetch([{ match: exact(KEY_URL), method: 'GET', respond: keyEndpoint }]);
  t = await createTestContext({ fetch: fake.fetch, now: () => NOW });
  if (opts.log) t.ctx.log = opts.log;
  if (opts.secure) t.ctx.secure = await opts.secure(t);
  if (opts.signedIn) await seedTokens(t.ctx.secure);
  for (const [name, value] of Object.entries(opts.seed ?? {})) await t.ctx.secure.set(name, value);
  if (opts.authFile) await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, ...opts.authFile }));
  const { signedIn: _s, authFile: _a, secure: _sec, seed: _seed, log: _log, ...sliceOpts } = opts;
  slice = await createAuthSliceWith(t.ctx, {
    fetch: fake.fetch,
    envKey: null,
    learnOrgOnStart: false,
    probeInferenceOnStart: false,
    keyDetectionPollMs: 20,
    ...sliceOpts,
  });
  const keyCalls = () => fake.requests.filter((r) => r.url === KEY_URL);
  return { slice, fake, keyCalls };
}

const authFile = async () => JSON.parse(await readFile(join(t.ctx.paths.data, 'auth.json'), 'utf8')) as Record<string, unknown>;
const authEvents = () => t.emitted.filter((e) => e.name === 'auth:changed').map((e) => e.payload as AuthState);

/** Every key value must be absent from everything that leaves main or reaches disk outside the secure store. */
function expectNoKeys(value: unknown, keys: string[] = ALL_KEYS) {
  const text = JSON.stringify(value);
  for (const key of keys) {
    expect(text).not.toContain(key);
    // Not even the part after the header (the payload + signature identify the key too).
    expect(text).not.toContain(key.split('.').slice(1).join('.'));
  }
}

describe('normalizeComputeKey', () => {
  it('trims, refuses empty, spaces and absurd lengths', () => {
    expect(normalizeComputeKey(`  ${COMPUTE_A}\n`)).toBe(COMPUTE_A);
    for (const bad of ['', '   ', 'a b', 'x'.repeat(5000), 42 as unknown as string]) {
      expect(() => normalizeComputeKey(bad)).toThrow(GmiError);
    }
  });
});

describe('setComputeKey: validation and the scope check', () => {
  it('stores a ce_resource key in the secure store as compute.key, metadata only in auth.json and AuthState', async () => {
    const { slice, keyCalls } = await setup({ signedIn: true, authFile: { orgId: '00000000-0000-0000-0000-000000000000' } });
    const state = await slice.api.setComputeKey(`  ${COMPUTE_A} `);
    expect(keyCalls()).toHaveLength(1);
    expect(keyCalls()[0]!.headers.authorization).toBe(`Bearer ${COMPUTE_A}`);
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBe(COMPUTE_A);
    expect(SECURE_KEYS.computeKey).toBe('compute.key');
    expect(state.computeKey).toMatchObject({
      status: 'valid',
      last4: COMPUTE_A.slice(-4),
      keyId: keyFixtures.compute.key.id,
      orgId: keyFixtures.compute.organization.id,
      orgMatchesAccount: true,
      validatedAt: NOW.toISOString(),
      error: null,
    });
    expect((state.computeKey as { sessionOnly?: boolean }).sessionOnly).toBeUndefined();
    expect((await authFile()).computeKey).toMatchObject({ status: 'valid', scope: 'ce_resource', last4: COMPUTE_A.slice(-4) });
    // The inference key is untouched.
    expect(state.inferenceKey.status).toBe('missing');
    expect(await slice.computeKeys.getComputeKey()).toBe(COMPUTE_A);
    expect(await slice.computeKeys.requireComputeKey()).toBe(COMPUTE_A);
  });

  it('an inference (ie_model) key is refused with a detail the dialog turns into "Use it for chat instead"; nothing stored', async () => {
    const { slice } = await setup();
    const error = await slice.api.setComputeKey(INFERENCE).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'invalid_input', detail: INFERENCE_SCOPE_DETAIL });
    expect((error as GmiError).message).toMatch(/inference \(chat\) key/);
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBeNull();
    expect((await slice.api.getState()).computeKey?.status).toBe('missing');
    expect((await slice.api.getState()).inferenceKey.status).toBe('missing');
  });

  it('a key with no known scope and a revoked key (401) are refused; nothing stored', async () => {
    const { slice } = await setup();
    await expect(slice.api.setComputeKey(NO_SCOPE)).rejects.toMatchObject({ code: 'invalid_input', detail: UNKNOWN_SCOPE_DETAIL });
    await expect(slice.api.setComputeKey(REVOKED)).rejects.toMatchObject({ code: 'invalid_compute_key' });
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBeNull();
    await expect(slice.computeKeys.requireComputeKey()).rejects.toMatchObject({ code: 'no_compute_key' });
  });

  it('a 403 from the key check is a permission problem, not a rejected key (nothing stored, no invalid status)', async () => {
    const { slice } = await setup();
    await expect(slice.api.setComputeKey(FORBIDDEN)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await slice.api.getState()).computeKey?.status).toBe('missing');
  });

  it('a key with both scopes counts as a Compute key', async () => {
    const { slice } = await setup();
    override.set(COMPUTE_B, () => jsonResponse({ key: { id: 'both', scope: ['ie_model', 'ce_resource'] }, organization: { id: '00000000-0000-0000-0000-000000000000' } }));
    const state = await slice.api.setComputeKey(COMPUTE_B);
    expect(state.computeKey?.status).toBe('valid');
  });

  it('removal deletes the secret and the metadata, and other slices hear about it', async () => {
    const { slice } = await setup();
    let changes = 0;
    const off = slice.computeKeys.onChange(() => (changes += 1));
    await slice.api.setComputeKey(COMPUTE_A);
    expect(changes).toBe(1);
    const state = await slice.api.removeComputeKey();
    expect(changes).toBe(2);
    off();
    expect(state.computeKey?.status).toBe('missing');
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBeNull();
    expect((await authFile()).computeKey).toBeNull();
    expect(await slice.computeKeys.getComputeKey()).toBeNull();
  });
});

describe('the key never leaves main', () => {
  it('no API result, event, auth.json or log line contains a key (every AuthApi method, both key kinds)', async () => {
    const lines: string[] = [];
    const record = (...a: unknown[]) => void lines.push(JSON.stringify(a));
    const log: TestContext['ctx']['log'] = { debug: record, info: record, warn: record, error: record, child: () => log };
    const { slice } = await setup({ signedIn: true, log });
    const results: unknown[] = [];
    const call = async (fn: () => Promise<unknown>) => {
      try {
        results.push(await fn());
      } catch (error) {
        // Errors cross IPC as their shape: that must be clean too.
        results.push(error instanceof GmiError ? error.toShape() : String(error));
      }
    };
    await call(() => slice.api.getState());
    await call(() => slice.api.setComputeKey(COMPUTE_A));
    await call(() => slice.api.setComputeKey(INFERENCE));
    await call(() => slice.api.setComputeKey(REVOKED));
    await call(() => slice.api.revalidateComputeKey());
    await call(() => slice.api.setInferenceKey(INFERENCE));
    t.platform.clipboard = COMPUTE_B;
    await call(() => slice.api.startKeyDetection('compute'));
    await waitFor(() => slice.service.getState().keyDetection?.candidate !== null);
    await call(() => slice.api.getState());
    await call(() => slice.api.useDetectedKey());
    await call(() => slice.api.stopKeyDetection());
    await call(() => slice.api.dismissDetectedKey());
    await call(() => slice.api.retrySecureStorage());
    await call(() => slice.api.revalidateInferenceKey());
    await call(() => slice.api.removeComputeKey());
    await call(() => slice.api.signOut());
    expect(results.length).toBeGreaterThan(10);
    expectNoKeys(results);
    expectNoKeys(t.emitted);
    expectNoKeys(await authFile());
    expectNoKeys(lines);
  });
});

describe('401 / 403 semantics (reportInvalidComputeKey)', () => {
  it('a 403 never marks the key dead; a 401 does (once), and listeners hear it', async () => {
    const { slice } = await setup();
    await slice.api.setComputeKey(COMPUTE_A);
    let changes = 0;
    slice.computeKeys.onChange(() => (changes += 1));
    await slice.computeKeys.reportInvalidComputeKey('tenant has no permission', COMPUTE_A, 403);
    expect(slice.service.getState().computeKey?.status).toBe('valid');
    expect(changes).toBe(0);
    await slice.computeKeys.reportInvalidComputeKey('Expired API key.', COMPUTE_A, 401);
    expect(slice.service.getState().computeKey).toMatchObject({ status: 'invalid', error: 'Expired API key.' });
    expect(changes).toBe(1);
    await slice.computeKeys.reportInvalidComputeKey('again', COMPUTE_A, 401);
    expect(changes).toBe(1);
    // Still the key in use (the compute slice sees 401s until a new key arrives; the UI asks for one).
    expect(await slice.computeKeys.getComputeKey()).toBe(COMPUTE_A);
  });

  it('other statuses and late reports about a replaced key are ignored', async () => {
    const { slice } = await setup();
    await slice.api.setComputeKey(COMPUTE_A);
    await slice.api.setComputeKey(COMPUTE_B);
    await slice.computeKeys.reportInvalidComputeKey('late', COMPUTE_A, 401);
    await slice.computeKeys.reportInvalidComputeKey('server error', COMPUTE_B, 500);
    expect(slice.service.getState().computeKey?.status).toBe('valid');
    // No key passed: the active key is meant.
    await slice.computeKeys.reportInvalidComputeKey('');
    expect(slice.service.getState().computeKey).toMatchObject({ status: 'invalid', error: 'GMI rejected the Compute API key.' });
  });

  it('revalidate: 401 → invalid, an inference key → invalid, 403 and network failures throw and keep the status', async () => {
    const { slice } = await setup();
    await slice.api.setComputeKey(COMPUTE_A);
    override.set(COMPUTE_A, () => jsonResponse({ message: 'forbidden' }, 403));
    await expect(slice.api.revalidateComputeKey()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(slice.service.getState().computeKey?.status).toBe('valid');
    override.set(COMPUTE_A, () => {
      throw new TypeError('fetch failed');
    });
    await expect(slice.api.revalidateComputeKey()).rejects.toMatchObject({ code: 'network' });
    expect(slice.service.getState().computeKey?.status).toBe('valid');
    override.set(COMPUTE_A, () => jsonResponse(keyFixtures.inference));
    expect((await slice.api.revalidateComputeKey()).computeKey).toMatchObject({ status: 'invalid', error: expect.stringMatching(/inference/) });
    override.set(COMPUTE_A, () => jsonResponse(keyFixtures.expired, 401));
    expect((await slice.api.revalidateComputeKey()).computeKey).toMatchObject({ status: 'invalid', error: expect.stringMatching(/GMI rejected this key/) });
    override.delete(COMPUTE_A);
    expect((await slice.api.revalidateComputeKey()).computeKey?.status).toBe('valid');
  });
});

describe('startup revalidation (at most once a day)', () => {
  const meta = (validatedAt: string | null) => ({
    computeKey: { keyId: 'k', scope: 'ce_resource', orgId: null, last4: COMPUTE_A.slice(-4), validatedAt, status: 'valid', error: null },
  });

  it('a key checked more than a day ago is checked again in the background', async () => {
    const { keyCalls, slice } = await setup({ seed: { [SECURE_KEYS.computeKey]: COMPUTE_A }, authFile: meta(new Date(NOW.getTime() - 2 * DAY).toISOString()) });
    await waitFor(() => keyCalls().length === 1);
    await waitFor(() => slice.service.getState().computeKey?.validatedAt === NOW.toISOString());
  });

  it('a key checked within the day is not; nor when disabled', async () => {
    const recent = await setup({ seed: { [SECURE_KEYS.computeKey]: COMPUTE_A }, authFile: meta(new Date(NOW.getTime() - 3_600_000).toISOString()) });
    await new Promise((r) => setTimeout(r, 30));
    expect(recent.keyCalls()).toHaveLength(0);
    expect(recent.slice.service.getState().computeKey?.status).toBe('valid');
    await restart();
    const off = await setup({ seed: { [SECURE_KEYS.computeKey]: COMPUTE_A }, authFile: meta(null), revalidateComputeKeyOnStart: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(off.keyCalls()).toHaveLength(0);
  });

  it('a saved key without metadata (older file) shows as unverified until checked', async () => {
    const { slice } = await setup({ seed: { [SECURE_KEYS.computeKey]: COMPUTE_A }, revalidateComputeKeyOnStart: false });
    expect(slice.service.getState().computeKey).toMatchObject({ status: 'unverified', last4: COMPUTE_A.slice(-4) });
  });

  it('auth.json without computeKey (written before C1-A) normalises to null', () => {
    expect(normalizeAuthFile({ version: 1, orgId: null }).computeKey).toBeNull();
  });
});

describe('locked keychain', () => {
  it('keeps the metadata, reports compute_key as locked, and Try again reads it once unlocked', async () => {
    const lockable = { store: null as Awaited<ReturnType<typeof lockableSecureStore>> | null };
    const savedMeta = { keyId: 'k-1', scope: 'ce_resource', orgId: '00000000-0000-0000-0000-000000000000', last4: COMPUTE_A.slice(-4), validatedAt: NOW.toISOString(), status: 'valid', error: null };
    const { slice, keyCalls } = await setup({
      secure: async (tc) => {
        lockable.store = await lockableSecureStore(join(tc.dir, 'secure-lockable'));
        await lockable.store.secure.set(SECURE_KEYS.computeKey, COMPUTE_A);
        lockable.store.lock();
        return lockable.store.secure;
      },
      authFile: { computeKey: savedMeta },
    });
    const state = slice.service.getState();
    expect(state.lockedSecrets).toContain('compute_key');
    expect(state.computeKey).toMatchObject({ status: 'unverified', last4: COMPUTE_A.slice(-4), keyId: 'k-1', error: COMPUTE_KEY_LOCKED_MESSAGE });
    expect((await authFile()).computeKey).toMatchObject(savedMeta);
    expect(await slice.computeKeys.getComputeKey()).toBeNull();
    await expect(slice.computeKeys.requireComputeKey()).rejects.toMatchObject({ code: 'no_compute_key', message: COMPUTE_KEY_LOCKED_MESSAGE });
    // No startup check of a key that cannot be read.
    expect(keyCalls()).toHaveLength(0);
    let changes = 0;
    slice.computeKeys.onChange(() => (changes += 1));
    lockable.store!.unlock();
    const unlocked = await slice.api.retrySecureStorage();
    expect(unlocked.lockedSecrets ?? []).not.toContain('compute_key');
    expect(unlocked.computeKey).toMatchObject({ status: 'valid', last4: COMPUTE_A.slice(-4) });
    expect(changes).toBe(1);
    expect(await slice.computeKeys.getComputeKey()).toBe(COMPUTE_A);
  });
});

describe('weak keyring (basic_text): session-only unless confirmed natively', () => {
  it('declined → kept in memory for this session only: nothing written, flagged sessionOnly', async () => {
    const { slice } = await setup({ secure: (tc) => storeWithBackend(join(tc.dir, 'secure-weak'), 'basic_text') });
    t.platform.confirmAnswer = false;
    const state = await slice.api.setComputeKey(COMPUTE_A);
    expect(t.platform.confirms).toEqual([{ title: WEAK_KEYRING_CONFIRM.title, message: WEAK_KEYRING_CONFIRM.message }]);
    expect(state.computeKey).toMatchObject({ status: 'valid', last4: COMPUTE_A.slice(-4), sessionOnly: true });
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBeNull();
    expect((await authFile()).computeKey).toBeNull();
    expect(await slice.computeKeys.getComputeKey()).toBe(COMPUTE_A);
    // Status changes stay in memory too.
    await slice.computeKeys.reportInvalidComputeKey('Expired', COMPUTE_A, 401);
    expect(slice.service.getState().computeKey).toMatchObject({ status: 'invalid', sessionOnly: true });
    expect((await authFile()).computeKey).toBeNull();
  });

  it('declined after a key was stored earlier → the old saved key is deleted (it must not come back after a restart)', async () => {
    const { slice } = await setup({ secure: (tc) => storeWithBackend(join(tc.dir, 'secure-weak'), 'basic_text') });
    t.platform.confirmAnswer = true;
    await slice.api.setComputeKey(COMPUTE_A);
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBe(COMPUTE_A);
    t.platform.confirmAnswer = false;
    await slice.api.setComputeKey(COMPUTE_B);
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBeNull();
    expect(await slice.computeKeys.getComputeKey()).toBe(COMPUTE_B);
  });

  it('confirmed → stored (under the weak built-in key), not session-only', async () => {
    const { slice } = await setup({ secure: (tc) => storeWithBackend(join(tc.dir, 'secure-weak'), 'basic_text') });
    t.platform.confirmAnswer = true;
    const state = await slice.api.setComputeKey(COMPUTE_A);
    expect(t.platform.confirms).toHaveLength(1);
    expect((state.computeKey as { sessionOnly?: boolean }).sessionOnly).toBeUndefined();
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBe(COMPUTE_A);
  });

  it('a rejected key never shows the dialog; an OS keyring never asks; no encryption at all → session-only without asking', async () => {
    const weak = await setup({ secure: (tc) => storeWithBackend(join(tc.dir, 'secure-weak'), 'basic_text') });
    await expect(weak.slice.api.setComputeKey(REVOKED)).rejects.toMatchObject({ code: 'invalid_compute_key' });
    expect(t.platform.confirms).toHaveLength(0);
    await restart();

    const os = await setup();
    await os.slice.api.setComputeKey(COMPUTE_A);
    expect(t.platform.confirms).toHaveLength(0);
    await restart();

    const none = await setup({ secure: (tc) => storeWithBackend(join(tc.dir, 'secure-none'), 'unavailable') });
    const state = await none.slice.api.setComputeKey(COMPUTE_A);
    expect(t.platform.confirms).toHaveLength(0);
    expect(state.secureStorage).toBe('unavailable');
    expect(state.computeKey).toMatchObject({ status: 'valid', sessionOnly: true });
  });
});

describe('clipboard detection for Connect Compute', () => {
  it('target compute: finds a key, "Use this key" stores it as the Compute key and clears the clipboard', async () => {
    const { slice } = await setup();
    t.platform.clipboard = COMPUTE_A;
    const started = await slice.api.startKeyDetection('compute');
    expect(started.keyDetection).toMatchObject({ active: true, target: 'compute' });
    await waitFor(() => slice.service.getState().keyDetection?.candidate?.last4 === COMPUTE_A.slice(-4));
    const result = await slice.api.useDetectedKey();
    expect(result.clipboardCleared).toBe(true);
    expect(t.platform.clipboard).toBe('');
    expect(result.state.computeKey).toMatchObject({ status: 'valid', last4: COMPUTE_A.slice(-4) });
    expect(result.state.inferenceKey.status).toBe('missing');
    expect(result.state.keyDetection).toEqual({ active: false, candidate: null });
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBe(COMPUTE_A);
  });

  it('never offers a stored key: neither the Compute key nor the inference key, whatever the target', async () => {
    const { slice } = await setup();
    await slice.api.setComputeKey(COMPUTE_A);
    await slice.api.setInferenceKey(INFERENCE);
    for (const target of ['compute', 'inference'] as const) {
      for (const copied of [COMPUTE_A, INFERENCE]) {
        t.platform.clipboard = copied;
        await slice.api.startKeyDetection(target);
        await new Promise((r) => setTimeout(r, 60));
        expect(slice.service.getState().keyDetection?.candidate).toBeNull();
        await slice.api.stopKeyDetection();
      }
    }
    // A new key is still found.
    t.platform.clipboard = COMPUTE_B;
    await slice.api.startKeyDetection('compute');
    await waitFor(() => slice.service.getState().keyDetection?.candidate?.last4 === COMPUTE_B.slice(-4));
  });

  it('an inference key found by Connect Compute stays offered and can go to chat ("Use it for chat instead")', async () => {
    const { slice } = await setup();
    t.platform.clipboard = INFERENCE;
    await slice.api.startKeyDetection('compute');
    await waitFor(() => slice.service.getState().keyDetection?.candidate !== null);
    await expect(slice.api.useDetectedKey()).rejects.toMatchObject({ code: 'invalid_input', detail: INFERENCE_SCOPE_DETAIL });
    expect(slice.service.getState().keyDetection?.candidate?.last4).toBe(INFERENCE.slice(-4));
    // Switching the target keeps the candidate.
    const switched = await slice.api.startKeyDetection('inference');
    expect(switched.keyDetection).toMatchObject({ active: true, target: 'inference', candidate: { last4: INFERENCE.slice(-4) } });
    const result = await slice.api.useDetectedKey();
    expect(result.state.inferenceKey).toMatchObject({ status: 'valid', last4: INFERENCE.slice(-4) });
    expect(result.state.computeKey?.status).toBe('missing');
    expect(await t.ctx.secure.get(SECURE_KEYS.computeKey)).toBeNull();
  });

  it('a key GMI rejects for Compute is not offered again; a transient failure keeps it for a retry', async () => {
    const { slice } = await setup();
    t.platform.clipboard = REVOKED;
    await slice.api.startKeyDetection('compute');
    await waitFor(() => slice.service.getState().keyDetection?.candidate !== null);
    await expect(slice.api.useDetectedKey()).rejects.toMatchObject({ code: 'invalid_compute_key' });
    expect(slice.service.getState().keyDetection?.candidate).toBeNull();
    t.platform.emitFocus();
    await new Promise((r) => setTimeout(r, 60));
    expect(slice.service.getState().keyDetection?.candidate).toBeNull();

    t.platform.clipboard = COMPUTE_B;
    override.set(COMPUTE_B, () => jsonResponse({ error: 'down' }, 503));
    await waitFor(() => slice.service.getState().keyDetection?.candidate !== null);
    await expect(slice.api.useDetectedKey()).rejects.toMatchObject({ code: 'upstream' });
    expect(slice.service.getState().keyDetection?.candidate?.last4).toBe(COMPUTE_B.slice(-4));
  });

  it('startKeyDetection() without a target is still the inference flow', async () => {
    const { slice } = await setup();
    expect((await slice.api.startKeyDetection()).keyDetection?.target).toBe('inference');
    expect((await slice.api.stopKeyDetection()).keyDetection).toEqual({ active: false, candidate: null });
  });
});

describe('ComputeKeyManager (unit)', () => {
  it('a set that finished first wins over a revalidation answer about the old key', async () => {
    override = new Map();
    let release: () => void = () => undefined;
    const fake = createFakeFetch([
      {
        match: exact(KEY_URL),
        method: 'GET',
        respond: async (req) => {
          if (req.headers.authorization === `Bearer ${COMPUTE_A}` && override.has('slow')) await new Promise<void>((r) => (release = r));
          return keyEndpoint(req);
        },
      },
    ]);
    t = await createTestContext({ fetch: fake.fetch, now: () => NOW });
    const { openJsonStore } = await import('@main/core/store');
    const { DEFAULT_AUTH_FILE } = await import('@main/services/auth/state');
    const file = await openJsonStore(join(t.ctx.paths.data, 'auth.json'), DEFAULT_AUTH_FILE, { log: silentLogger, normalize: normalizeAuthFile });
    const manager = new ComputeKeyManager({ http: t.ctx.http, secure: t.ctx.secure, file, platform: t.platform, now: () => NOW, log: silentLogger, emit: () => undefined });
    await manager.load();
    await manager.set(COMPUTE_A);
    override.set('slow', () => jsonResponse({}));
    override.set(COMPUTE_A, () => jsonResponse(keyFixtures.expired, 401));
    const pending = manager.revalidate();
    await waitFor(() => fake.requests.length === 2);
    await manager.set(COMPUTE_B);
    release();
    await pending;
    expect(manager.info()).toMatchObject({ status: 'valid', last4: COMPUTE_B.slice(-4) });
    expect(manager.needsRevalidation()).toBe(false);
  });
});
