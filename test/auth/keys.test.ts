import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import keyFixtures from '@main/mock/fixtures/auth/api-key-current.json';
import type { AuthState } from '@shared/contracts/auth';
import { createAuthSliceWith, type AuthSlice } from '@main/services/auth';
import { COMPUTE_KEY_MESSAGE, envKeyFromEnvironment, isPackagedApp, normalizeInferenceKey, parseKeyResponse } from '@main/services/auth/keys';
import { createFakeFetch, jsonResponse, type RecordedRequest } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';
import { KEY_URL, seedTokens, waitFor } from './helpers';

const ORG = '00000000-0000-0000-0000-000000000000';
const VALID = 'sk-inference-key-0001-ab12';
const COMPUTE = 'sk-compute-key-0002-cd34';
const EXPIRED = 'sk-expired-key-0003-ef56';
const VALID2 = 'sk-inference-key-0004-gh78';

let t: TestContext;
let slice: AuthSlice | null = null;
let failNetwork = false;

afterEach(async () => {
  await slice?.dispose();
  slice = null;
  failNetwork = false;
  await t?.cleanup();
});

/** GMI's key endpoint: answers by bearer token. */
function keyEndpoint(req: RecordedRequest): Response {
  if (failNetwork) throw new TypeError('fetch failed');
  const auth = req.headers.authorization;
  if (auth === `Bearer ${VALID}` || auth === `Bearer ${VALID2}`) return jsonResponse(keyFixtures.inference);
  if (auth === `Bearer ${COMPUTE}`) return jsonResponse(keyFixtures.compute);
  if (auth === `Bearer ${EXPIRED}`) return jsonResponse(keyFixtures.expired, 401);
  return jsonResponse(keyFixtures.invalid, 401);
}

async function setup(opts: { envKey?: string | null; orgId?: string | null } = {}) {
  const fake = createFakeFetch([{ match: (u) => u === KEY_URL, method: 'GET', respond: keyEndpoint }]);
  t = await createTestContext({ fetch: fake.fetch });
  if (opts.orgId) {
    // orgMatchesAccount compares with the signed-in organization, so sign in first.
    await seedTokens(t.ctx.secure);
    await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, orgId: opts.orgId }));
  }
  slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: opts.envKey ?? null, learnOrgOnStart: false, probeInferenceOnStart: false });
  return { slice, fake };
}

const lastAuth = () => t.emitted.filter((e) => e.name === 'auth:changed').at(-1)?.payload as AuthState | undefined;

describe('inference key format', () => {
  it('trims and rejects empty, whitespace-containing and oversized keys', () => {
    expect(normalizeInferenceKey('  sk-abc  \n')).toBe('sk-abc');
    expect(() => normalizeInferenceKey('')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => normalizeInferenceKey('   ')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => normalizeInferenceKey('sk abc')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => normalizeInferenceKey('sk-a\nb')).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => normalizeInferenceKey('x'.repeat(4097))).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(normalizeInferenceKey('x'.repeat(4096))).toHaveLength(4096);
    expect(() => normalizeInferenceKey(42)).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('parses the key endpoint response leniently', () => {
    expect(parseKeyResponse(keyFixtures.inference)).toEqual({ keyId: '00000000-0000-0000-0000-0000000000a1', scope: 'ie_model', orgId: ORG });
    expect(parseKeyResponse({ key: { id: 7, scope: ['ce_resource'] } })).toEqual({ keyId: '7', scope: 'ce_resource', orgId: null });
    expect(parseKeyResponse(null)).toEqual({ keyId: null, scope: null, orgId: null });
  });
});

describe('inference key', () => {
  it('validates an ie_model key with GMI and stores it in the secure store', async () => {
    const { slice, fake } = await setup({ orgId: ORG });
    expect(slice.service.getState().inferenceKey.status).toBe('missing');
    const state = await slice.api.setInferenceKey(`  ${VALID}  `);
    expect(state.inferenceKey).toMatchObject({
      status: 'valid',
      source: 'keychain',
      last4: 'ab12',
      keyId: '00000000-0000-0000-0000-0000000000a1',
      scope: 'ie_model',
      orgId: ORG,
      orgMatchesAccount: true,
      error: null,
    });
    expect(state.inferenceKey.validatedAt).not.toBeNull();
    const req = fake.requests[0]!;
    expect(req.url).toBe(KEY_URL);
    expect(req.headers.authorization).toBe(`Bearer ${VALID}`);
    expect(req.headers['user-agent']).toBe('GMI-Desk/test');
    expect(await t.ctx.secure.get('inference.key')).toBe(VALID);
    await expect(slice.keys.getInferenceKey()).resolves.toBe(VALID);
    await expect(slice.keys.requireInferenceKey()).resolves.toBe(VALID);
    expect(lastAuth()?.inferenceKey.status).toBe('valid');
    const file = await readFile(join(t.ctx.paths.data, 'auth.json'), 'utf8');
    expect(file).toContain('ab12');
    expect(file).not.toContain(VALID);
    expect(JSON.stringify(state)).not.toContain(VALID);
  });

  it('flags a key from another organization', async () => {
    const { slice } = await setup({ orgId: '11111111-1111-1111-1111-111111111111' });
    const state = await slice.api.setInferenceKey(VALID);
    expect(state.inferenceKey.orgMatchesAccount).toBe(false);
  });

  it('only compares organizations while signed in (an expired session’s org id does not count)', async () => {
    const fake = createFakeFetch([{ match: (u) => u === KEY_URL, method: 'GET', respond: keyEndpoint }]);
    t = await createTestContext({ fetch: fake.fetch });
    await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, orgId: ORG, reauthRequired: true }));
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false });
    const state = await slice.api.setInferenceKey(VALID);
    expect(state.status).toBe('reauth_required');
    expect(state.inferenceKey).toMatchObject({ status: 'valid', orgId: ORG, orgMatchesAccount: null });
  });

  it('refuses a compute (ce_resource) key without storing it', async () => {
    const { slice } = await setup();
    await expect(slice.api.setInferenceKey(COMPUTE)).rejects.toMatchObject({ code: 'invalid_input', message: COMPUTE_KEY_MESSAGE });
    expect(await t.ctx.secure.get('inference.key')).toBeNull();
    expect(slice.service.getState().inferenceKey.status).toBe('missing');
  });

  it('rejects invalid and expired keys with GMI’s message and keeps the previous key', async () => {
    const { slice } = await setup();
    await slice.api.setInferenceKey(VALID);
    await expect(slice.api.setInferenceKey('sk-wrong-0000')).rejects.toMatchObject({ code: 'invalid_api_key', message: 'Invalid API key.', status: 401 });
    await expect(slice.api.setInferenceKey(EXPIRED)).rejects.toMatchObject({ code: 'invalid_api_key', message: 'Expired API key.' });
    expect(await t.ctx.secure.get('inference.key')).toBe(VALID);
    expect(slice.service.getState().inferenceKey).toMatchObject({ status: 'valid', last4: 'ab12' });
  });

  it('does not store the key when GMI cannot be reached', async () => {
    const { slice } = await setup();
    failNetwork = true;
    await expect(slice.api.setInferenceKey(VALID)).rejects.toMatchObject({ code: 'network' });
    expect(await t.ctx.secure.get('inference.key')).toBeNull();
  });

  it('rejects malformed keys before calling GMI', async () => {
    const { slice, fake } = await setup();
    await expect(slice.api.setInferenceKey('two words')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(slice.api.setInferenceKey('')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fake.requests).toHaveLength(0);
  });

  it('reportInvalidKey marks the key invalid; requireInferenceKey needs a key', async () => {
    const { slice } = await setup();
    await expect(slice.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key' });
    await expect(slice.keys.getInferenceKey()).resolves.toBeNull();
    await slice.keys.reportInvalidKey('nothing stored'); // no-op without a key
    expect(slice.service.getState().inferenceKey.status).toBe('missing');

    await slice.api.setInferenceKey(VALID);
    await slice.keys.reportInvalidKey('GMI answered 401 for chat');
    expect(slice.service.getState().inferenceKey).toMatchObject({ status: 'invalid', error: 'GMI answered 401 for chat' });
    expect(lastAuth()?.inferenceKey.status).toBe('invalid');
    await expect(slice.keys.requireInferenceKey()).resolves.toBe(VALID); // still usable; the UI asks for a new one
  });

  it('revalidates: valid → valid, rejected → invalid, offline → throws and keeps the status', async () => {
    const { slice } = await setup();
    await slice.api.setInferenceKey(VALID);
    await slice.keys.reportInvalidKey('flaky');
    await expect(slice.api.revalidateInferenceKey()).resolves.toMatchObject({ inferenceKey: { status: 'valid', error: null } });

    failNetwork = true;
    await expect(slice.api.revalidateInferenceKey()).rejects.toMatchObject({ code: 'network' });
    expect(slice.service.getState().inferenceKey.status).toBe('valid');
    failNetwork = false;

    // The stored key was revoked on GMI's side.
    await t.ctx.secure.set('inference.key', EXPIRED);
    const again = await createAuthSliceWith(t.ctx, { fetch: createFakeFetch([{ match: (u) => u === KEY_URL, respond: keyEndpoint }]).fetch, envKey: null, learnOrgOnStart: false });
    const state = await again.api.revalidateInferenceKey();
    expect(state.inferenceKey).toMatchObject({ status: 'invalid', error: 'GMI rejected this key: Expired API key.' });
    await again.dispose();
  });

  it('removes the key', async () => {
    const { slice } = await setup();
    await slice.api.setInferenceKey(VALID);
    const state = await slice.api.removeInferenceKey();
    expect(state.inferenceKey).toMatchObject({ status: 'missing', source: null, last4: null });
    expect(await t.ctx.secure.get('inference.key')).toBeNull();
    await expect(slice.keys.getInferenceKey()).resolves.toBeNull();
  });

  it('persists metadata across restarts', async () => {
    const { slice, fake } = await setup();
    await slice.api.setInferenceKey(VALID);
    const next = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false });
    expect(next.service.getState().inferenceKey).toMatchObject({ status: 'valid', last4: 'ab12', source: 'keychain', scope: 'ie_model' });
    await expect(next.keys.getInferenceKey()).resolves.toBe(VALID);
    await next.dispose();
  });

  it('ignores a late invalid-key report about a key the user has since replaced', async () => {
    const { slice } = await setup();
    await slice.api.setInferenceKey(VALID);
    // A catalog refresh or chat request still running with the old key gets its 401 after the user saved a new one.
    await slice.api.setInferenceKey(VALID2);
    await slice.keys.reportInvalidKey('GMI answered 401', VALID);
    expect(slice.service.getState().inferenceKey).toMatchObject({ status: 'valid', last4: 'gh78', error: null });
    // A report about the key in use still counts.
    await slice.keys.reportInvalidKey('GMI answered 401', VALID2);
    expect(slice.service.getState().inferenceKey).toMatchObject({ status: 'invalid', last4: 'gh78', error: 'GMI answered 401' });
  });

  it('drops a re-verification answer about a key that was replaced while GMI answered', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeFetch([
      {
        match: (u) => u === KEY_URL,
        method: 'GET',
        respond: async (req) => {
          if (req.headers.authorization === `Bearer ${EXPIRED}`) await gate; // GMI is slow to reject the revoked key
          return keyEndpoint(req);
        },
      },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    await t.ctx.secure.set('inference.key', EXPIRED); // saved earlier, revoked in GMI Console since
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false });
    const checking = slice.api.revalidateInferenceKey();
    await waitFor(() => fake.requests.length === 1);
    await slice.api.setInferenceKey(VALID); // the user pastes a new key meanwhile
    release();
    await checking;
    expect(slice.service.getState().inferenceKey).toMatchObject({ status: 'valid', last4: 'ab12', error: null });
  });

  it('lets GMI_API_KEY override the stored key (unverified until revalidated)', async () => {
    const { slice } = await setup({ envKey: VALID });
    expect(slice.service.getState().inferenceKey).toMatchObject({ status: 'unverified', source: 'env', last4: 'ab12' });
    await expect(slice.keys.getInferenceKey()).resolves.toBe(VALID);
    const state = await slice.api.revalidateInferenceKey();
    expect(state.inferenceKey).toMatchObject({ status: 'valid', source: 'env', scope: 'ie_model', orgId: ORG });
    expect(await t.ctx.secure.get('inference.key')).toBeNull(); // env keys are never written to disk
  });
});

describe('GMI_API_KEY', () => {
  it('is a development override: ignored by a packaged app and when GMI_DESK_ALLOW_ENV_KEY=0', () => {
    expect(envKeyFromEnvironment({ GMI_API_KEY: '  sk-env-0001  ' }, false)).toBe('sk-env-0001');
    expect(envKeyFromEnvironment({ GMI_API_KEY: '   ' }, false)).toBeNull();
    expect(envKeyFromEnvironment({}, false)).toBeNull();
    expect(envKeyFromEnvironment({ GMI_API_KEY: 'sk-env-0001' }, true)).toBeNull();
    expect(envKeyFromEnvironment({ GMI_API_KEY: 'sk-env-0001', GMI_DESK_ALLOW_ENV_KEY: '0' }, false)).toBeNull();
  });

  it('knows a packaged app from `electron .` and from plain Node', () => {
    const electron = { ...process.versions, electron: '45.2.1' };
    expect(isPackagedApp({ versions: electron })).toBe(true);
    expect(isPackagedApp({ versions: electron, defaultApp: true })).toBe(false);
    expect(isPackagedApp({ versions: { ...process.versions, electron: undefined as unknown as string } })).toBe(false);
    expect(isPackagedApp()).toBe(false); // vitest runs on plain Node
  });
});
