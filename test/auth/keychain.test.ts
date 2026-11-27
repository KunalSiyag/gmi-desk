// A saved secret the OS keychain will not decrypt right now (locked keyring, another desktop session, access
// denied) is not a missing one: auth keeps it, says so (AuthState.lockedSecrets), and reads it again on "Try again".
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import keyFixtures from '@main/mock/fixtures/auth/api-key-current.json';
import { createAuthSliceWith, type AuthSlice } from '@main/services/auth';
import { INFERENCE_PROBE_URL } from '@main/services/auth/constants';
import { createFakeFetch, jsonResponse } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';
import { discoveryRoutes, fakeMcpServer, KEY_URL, lockableSecureStore, seedClient, seedTokens, textResult, waitFor } from './helpers';

const VALID = 'sk-inference-key-0001-ab12';
const OTHER = 'sk-inference-key-0004-gh78';
const SIGNED_IN_AT = '2026-10-30T10:00:00.000Z';

let t: TestContext | null = null;
const slices: AuthSlice[] = [];

afterEach(async () => {
  for (const s of slices.splice(0)) await s.dispose();
  await t?.cleanup();
  t = null;
});

async function setup() {
  const mcp = fakeMcpServer({ validTokens: new Set(['access-1']), tools: { get_account_summary: () => textResult({ org_id: 'org-9' }) } });
  const fake = createFakeFetch([
    ...discoveryRoutes(),
    mcp.route,
    // GMI's inference API does not accept the sign-in (today's answer).
    { match: (u) => u === INFERENCE_PROBE_URL, method: 'GET', respond: () => jsonResponse({ error: 'Invalid API key' }, 401) },
    {
      match: (u) => u === KEY_URL,
      method: 'GET',
      respond: (req) =>
        req.headers.authorization === `Bearer ${VALID}` || req.headers.authorization === `Bearer ${OTHER}`
          ? jsonResponse(keyFixtures.inference)
          : jsonResponse(keyFixtures.invalid, 401),
    },
  ]);
  const ctx = await createTestContext({ fetch: fake.fetch });
  t = ctx;
  const store = await lockableSecureStore(ctx.ctx.paths.secure);
  ctx.ctx.secure = store.secure;
  /** One app launch. */
  const launch = async () => {
    const slice = await createAuthSliceWith(ctx.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false });
    slices.push(slice);
    return slice;
  };
  const quit = async (slice: AuthSlice) => {
    slices.splice(slices.indexOf(slice), 1);
    await slice.dispose();
  };
  const exists = (name: string) => access(join(ctx.ctx.paths.secure, name)).then(() => true, () => false);
  const authFile = async () => JSON.parse(await readFile(join(ctx.ctx.paths.data, 'auth.json'), 'utf8')) as Record<string, unknown>;
  const seedSession = async () => {
    await seedClient(store.secure);
    await seedTokens(store.secure);
    await writeFile(join(ctx.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, orgId: 'org-9', signedInAt: SIGNED_IN_AT }));
  };
  const probeRequests = () => fake.requests.filter((r) => r.url === INFERENCE_PROBE_URL);
  return { store, launch, quit, exists, authFile, seedSession, probeRequests };
}

describe('saved sign-in the keychain will not decrypt', () => {
  it('is kept (tokens, organization, sign-in time) and restored by Try again once the keychain is unlocked', async () => {
    const { store, launch, exists, authFile, seedSession } = await setup();
    await seedSession();
    store.lock();
    const slice = await launch();

    const state = slice.service.getState();
    expect(state).toMatchObject({ status: 'signed_out', lockedSecrets: ['sign_in'], orgId: 'org-9' });
    expect(state.lastError).toMatch(/keychain is locked or unavailable/);
    expect(await exists('oauth.tokens.bin')).toBe(true);
    expect(await exists('oauth.client.bin')).toBe(true);
    expect(await authFile()).toMatchObject({ orgId: 'org-9', signedInAt: SIGNED_IN_AT });
    await expect(slice.mcp.callTool('get_account_summary', {})).rejects.toMatchObject({ code: 'not_signed_in', message: expect.stringMatching(/keychain/) });

    // Still locked: Try again changes nothing.
    await expect(slice.api.retrySecureStorage()).resolves.toMatchObject({ status: 'signed_out', lockedSecrets: ['sign_in'] });

    store.unlock();
    await expect(slice.api.retrySecureStorage()).resolves.toMatchObject({
      status: 'signed_in',
      lockedSecrets: [],
      orgId: 'org-9',
      signedInAt: SIGNED_IN_AT,
      lastError: null,
    });
    await expect(slice.mcp.callTool('get_account_summary', {})).resolves.toMatchObject({ org_id: 'org-9' });
  });

  it('Try again after unlocking asks GMI about chat with the restored sign-in, like a normal startup', async () => {
    const { store, launch, seedSession, probeRequests } = await setup();
    await seedSession();
    store.lock();
    const slice = await launch();
    await new Promise((r) => setTimeout(r, 30));
    expect(probeRequests()).toHaveLength(0); // nothing to ask with while locked
    store.unlock();
    await slice.api.retrySecureStorage();
    await waitFor(() => slice.service.getState().inference?.oauthProbe === 'unsupported');
    expect(probeRequests()).toHaveLength(1);
    expect(probeRequests()[0]!.headers.authorization).toBe('Bearer access-1');
  });

  it('survives a locked launch: the next launch with the keychain unlocked is signed in as before', async () => {
    const { store, launch, quit, seedSession } = await setup();
    await seedSession();
    store.lock();
    await quit(await launch());
    store.unlock();
    const next = await launch();
    expect(next.service.getState()).toMatchObject({ status: 'signed_in', orgId: 'org-9', signedInAt: SIGNED_IN_AT, lockedSecrets: [] });
  });

  it('is forgotten only on an explicit sign-out', async () => {
    const { store, launch, exists, seedSession } = await setup();
    await seedSession();
    store.lock();
    const slice = await launch();
    await expect(slice.api.signOut()).resolves.toMatchObject({ status: 'signed_out', lockedSecrets: [], lastError: null });
    expect(await exists('oauth.tokens.bin')).toBe(false);
  });
});

describe('saved inference key the keychain will not decrypt', () => {
  it('keeps the key and its metadata, refuses to pretend it is missing, and reads it again on Try again', async () => {
    const { store, launch, quit, exists, authFile } = await setup();
    const first = await launch();
    await first.api.setInferenceKey(VALID);
    await quit(first);
    store.lock();

    const slice = await launch();
    const state = slice.service.getState();
    expect(state.lockedSecrets).toEqual(['inference_key']);
    expect(state.inferenceKey).toMatchObject({ status: 'unverified', source: 'keychain', last4: 'ab12', scope: 'ie_model' });
    expect(state.inferenceKey.error).toMatch(/keychain is locked or unavailable/);
    expect(await exists('inference.key.bin')).toBe(true);
    expect((await authFile()).inferenceKey).toMatchObject({ status: 'valid', last4: 'ab12' });
    await expect(slice.keys.getInferenceKey()).resolves.toBeNull();
    await expect(slice.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key', message: expect.stringMatching(/keychain/) });
    await expect(slice.api.revalidateInferenceKey()).rejects.toMatchObject({ code: 'no_api_key' }); // still locked

    store.unlock();
    await expect(slice.api.retrySecureStorage()).resolves.toMatchObject({
      lockedSecrets: [],
      inferenceKey: { status: 'valid', last4: 'ab12', error: null },
    });
    await expect(slice.keys.requireInferenceKey()).resolves.toBe(VALID);
  });

  it('Re-verify reads a locked key again first', async () => {
    const { store, launch, quit } = await setup();
    const first = await launch();
    await first.api.setInferenceKey(VALID);
    await quit(first);
    store.lock();
    const slice = await launch();
    store.unlock();
    await expect(slice.api.revalidateInferenceKey()).resolves.toMatchObject({ lockedSecrets: [], inferenceKey: { status: 'valid', last4: 'ab12' } });
  });

  it('is replaced only when the user saves a new key', async () => {
    const { store, launch, quit } = await setup();
    const first = await launch();
    await first.api.setInferenceKey(VALID);
    await quit(first);
    store.lock();
    const slice = await launch();
    await expect(slice.api.setInferenceKey(OTHER)).resolves.toMatchObject({ lockedSecrets: [], inferenceKey: { status: 'valid', last4: 'gh78' } });
    await quit(slice);
    store.unlock();
    const next = await launch();
    await expect(next.keys.getInferenceKey()).resolves.toBe(OTHER);
  });
});
