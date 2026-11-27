import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import { GMI_SCOPES } from '@shared/contracts/auth';
import { createAuthSliceWith, type AuthSlice } from '@main/services/auth';
import { createMockAuth, MOCK_CANDIDATE_LAST4, MOCK_OAUTH_ACCESS_TOKEN } from '@main/services/auth/mock';
import { createFakeFetch } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';

let t: TestContext;
let slice: AuthSlice | null = null;

afterEach(async () => {
  await slice?.dispose();
  slice = null;
  await t?.cleanup();
});

const events = () => t.emitted.filter((e) => e.name === 'auth:changed').map((e) => e.payload as AuthState);

async function setup() {
  const fake = createFakeFetch();
  t = await createTestContext({ fetch: fake.fetch, mock: true });
  slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, mockSignInDelayMs: 20 });
  return { slice, fake };
}

describe('mock mode', () => {
  it('starts signed in to the placeholder org with every scope and a valid demo key', async () => {
    const { slice, fake } = await setup();
    const state = slice.service.getState();
    expect(state).toMatchObject({
      status: 'signed_in',
      orgId: '00000000-0000-0000-0000-000000000000',
      mock: true,
      lastError: null,
      inferenceKey: { status: 'valid', last4: 'demo', scope: 'ie_model', source: 'keychain', orgMatchesAccount: true },
    });
    expect(state.scopes).toEqual([...GMI_SCOPES]);
    expect(slice.service.isSignedIn()).toBe(true);
    await expect(slice.api.getState()).resolves.toEqual(state);
    await expect(slice.keys.requireInferenceKey()).resolves.toMatch(/demo$/);
    expect(fake.requests).toHaveLength(0);
  });

  it('simulates sign-out and a successful sign-in', async () => {
    const { slice } = await setup();
    await expect(slice.api.signOut()).resolves.toMatchObject({ status: 'signed_out', orgId: null, scopes: [], inferenceKey: { orgMatchesAccount: null } });
    await expect(slice.mcp.callTool('search_models', {})).rejects.toMatchObject({ code: 'not_signed_in' });
    const pending = slice.api.signIn();
    expect(slice.service.getState()).toMatchObject({ status: 'signing_in', signInInProgress: true });
    expect(slice.api.signIn()).toBe(pending); // joined, not a second flow
    const state = await pending;
    expect(state).toMatchObject({
      status: 'signed_in',
      signInInProgress: false,
      orgIdPending: false,
      orgId: '00000000-0000-0000-0000-000000000000',
      inferenceKey: { orgMatchesAccount: true },
    });
    expect(events().map((e) => e.status)).toEqual(['signed_out', 'signing_in', 'signed_in']);
  });

  it('can cancel the simulated sign-in', async () => {
    const { slice } = await setup();
    await slice.api.signOut();
    const pending = slice.api.signIn();
    await expect(slice.api.cancelSignIn()).resolves.toMatchObject({ status: 'signed_out', signInInProgress: false });
    await expect(pending).resolves.toMatchObject({ status: 'signed_out' });
  });

  it('validates inference keys by format only and keeps them in memory', async () => {
    const { slice, fake } = await setup();
    await expect(slice.api.setInferenceKey('bad key')).rejects.toMatchObject({ code: 'invalid_input' });
    const state = await slice.api.setInferenceKey('  sk-local-test-wxyz ');
    expect(state.inferenceKey).toMatchObject({ status: 'valid', last4: 'wxyz', scope: 'ie_model' });
    await expect(slice.keys.getInferenceKey()).resolves.toBe('sk-local-test-wxyz');
    expect(await t.ctx.secure.get('inference.key')).toBeNull();
    await slice.keys.reportInvalidKey('401 from chat');
    expect(slice.service.getState().inferenceKey).toMatchObject({ status: 'invalid', error: '401 from chat' });
    await expect(slice.api.revalidateInferenceKey()).resolves.toMatchObject({ inferenceKey: { status: 'valid' } });
    await expect(slice.api.removeInferenceKey()).resolves.toMatchObject({ inferenceKey: { status: 'missing' } });
    await expect(slice.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key' });
    expect(fake.requests).toHaveLength(0);
  });

  it('keychain_locked: the saved sign-in and key stay locked until Try again', async () => {
    t = await createTestContext({ mock: true });
    slice = await createAuthSliceWith(t.ctx, { mockScenario: 'keychain_locked', mockSignInDelayMs: 20 });
    expect(slice.service.getState()).toMatchObject({
      status: 'signed_out',
      lockedSecrets: ['sign_in', 'inference_key'],
      inferenceKey: { status: 'unverified', last4: 'demo', source: 'keychain' },
    });
    await expect(slice.keys.getInferenceKey()).resolves.toBeNull();
    await expect(slice.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key', message: expect.stringMatching(/keychain/) });
    await expect(slice.api.retrySecureStorage()).resolves.toMatchObject({
      status: 'signed_in',
      lockedSecrets: [],
      lastError: null,
      inferenceKey: { status: 'valid', last4: 'demo', error: null },
    });
    await expect(slice.keys.requireInferenceKey()).resolves.toMatch(/demo$/);
  });

  it('sign_in_fails: the simulated browser sign-in rejects', async () => {
    t = await createTestContext({ mock: true });
    slice = await createAuthSliceWith(t.ctx, { mockScenario: 'signed_out,sign_in_fails', mockSignInDelayMs: 10 });
    await expect(slice.api.signIn()).rejects.toMatchObject({ code: 'timeout' });
    expect(slice.service.getState()).toMatchObject({ status: 'signed_out', signInInProgress: false, lastError: expect.stringMatching(/timed out/) });
  });

  it('ignores an invalid-key report about a key that is no longer in use', async () => {
    const { slice } = await setup();
    await slice.keys.reportInvalidKey('401 for an old key', 'sk-replaced-0000');
    expect(slice.service.getState().inferenceKey.status).toBe('valid');
    // A 403 for the key in use is a permission problem (model, organization), not a dead key.
    await slice.keys.reportInvalidKey('403 for this key', await slice.keys.getInferenceKey(), 403);
    expect(slice.service.getState().inferenceKey.status).toBe('valid');
    await slice.keys.reportInvalidKey('401 for this key', await slice.keys.getInferenceKey());
    expect(slice.service.getState().inferenceKey.status).toBe('invalid');
  });

  it('reports how chat authenticates: the demo key by default, nothing with no_key', async () => {
    const { slice } = await setup();
    expect(slice.service.getState().inference).toMatchObject({ via: 'api_key', oauthProbe: 'unsupported' });
    expect(slice.service.getState().keyDetection).toEqual({ active: false, candidate: null });
    await slice.api.removeInferenceKey();
    expect(slice.service.getState().inference?.via).toBeNull();

    await t.cleanup();
    t = await createTestContext({ mock: true });
    const noKey = await createAuthSliceWith(t.ctx, { mockScenario: 'no_key' });
    expect(noKey.service.getState()).toMatchObject({ inferenceKey: { status: 'missing' }, inference: { via: null, oauthProbe: 'unsupported' } });
    await expect(noKey.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key' });
    noKey.dispose();
  });

  it('oauth_inference: GMI accepts the sign-in, no key needed; a 401/403 for the token asks for a key again', async () => {
    t = await createTestContext({ mock: true });
    slice = await createAuthSliceWith(t.ctx, { mockScenario: 'oauth_inference' });
    expect(slice.service.getState()).toMatchObject({ inferenceKey: { status: 'missing' }, inference: { via: 'oauth', oauthProbe: 'supported' } });
    const token = await slice.keys.requireInferenceKey();
    expect(token).toBe(MOCK_OAUTH_ACCESS_TOKEN);
    await expect(slice.api.probeOAuthInference()).resolves.toMatchObject({ inference: { via: 'oauth', oauthProbe: 'supported' } });
    await slice.keys.reportInvalidKey('403 insufficient_scope', token, 403);
    expect(slice.service.getState()).toMatchObject({ inferenceKey: { status: 'missing' }, inference: { via: null, oauthProbe: 'unsupported' } });
    await slice.api.signOut();
    expect(slice.service.getState().inference).toMatchObject({ via: null, oauthProbe: 'unknown', oauthProbeAt: null });
  });

  it('key_candidate: a found key can be used (valid, detection stops) or dismissed; the clipboard is never read', async () => {
    t = await createTestContext({ mock: true });
    slice = await createAuthSliceWith(t.ctx, { mockScenario: 'no_key,key_candidate' });
    t.platform.clipboard = 'should never be read in mock mode';
    expect(slice.service.getState().keyDetection).toMatchObject({ active: true, candidate: { last4: MOCK_CANDIDATE_LAST4 } });
    await slice.api.stopKeyDetection();
    expect(slice.service.getState().keyDetection).toEqual({ active: false, candidate: null });
    await expect(slice.api.startKeyDetection()).resolves.toMatchObject({ keyDetection: { active: true, candidate: { last4: MOCK_CANDIDATE_LAST4 } } });
    const used = await slice.api.useDetectedKey();
    expect(used.clipboardCleared).toBe(true);
    expect(used.state).toMatchObject({
      inferenceKey: { status: 'valid', last4: MOCK_CANDIDATE_LAST4 },
      inference: { via: 'api_key' },
      keyDetection: { active: false, candidate: null },
    });
    await expect(slice.api.useDetectedKey()).rejects.toMatchObject({ code: 'not_found' });
    expect(t.platform.clipboardReads).toBe(0);

    await t.cleanup();
    t = await createTestContext({ mock: true });
    const other = await createAuthSliceWith(t.ctx, { mockScenario: 'no_key,key_candidate' });
    await expect(other.api.dismissDetectedKey()).resolves.toMatchObject({ keyDetection: { active: true, candidate: null } });
    await other.api.stopKeyDetection();
    await expect(other.api.startKeyDetection()).resolves.toMatchObject({ keyDetection: { active: true, candidate: null } });
    other.dispose();
  });

  it('no_key without key_candidate: detection listens but finds nothing', async () => {
    t = await createTestContext({ mock: true });
    slice = await createAuthSliceWith(t.ctx, { mockScenario: 'no_key' });
    await expect(slice.api.startKeyDetection()).resolves.toMatchObject({ keyDetection: { active: true, candidate: null } });
    await expect(slice.api.useDetectedKey()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('serves MCP tools through the mock table while signed in', async () => {
    t = await createTestContext({ mock: true });
    const parts = createMockAuth(t.ctx, {
      mcp: {
        async callTool<T>(name: string) {
          return { tool: name } as T;
        },
      },
    });
    await expect(parts.mcp.callTool('get_account_summary', { days: 1 })).resolves.toEqual({ tool: 'get_account_summary' });
    parts.dispose();
  });
});
