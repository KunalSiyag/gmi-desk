/**
 * Mock-mode Compute key (C1-A): the GMI_DESK_MOCK_AUTH flags no_compute_key, compute_key, compute_key_invalid,
 * compute_key_locked and basic_text, the mock ComputeKeyProvider, and Connect Compute's detection path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/contracts/auth';
import { createMockAuth, MOCK_CANDIDATE_LAST4, MOCK_COMPUTE_LAST4, type MockAuthParts } from '@main/services/auth/mock';
import { INFERENCE_SCOPE_DETAIL, WEAK_KEYRING_CONFIRM } from '@main/services/auth/compute-keys';
import { COMPUTE_KEY_LOCKED_MESSAGE } from '@main/services/auth/constants';
import { createTestContext, type TestContext } from '../helpers/context';

let t: TestContext;
let auth: MockAuthParts | null = null;

afterEach(async () => {
  auth?.dispose();
  auth = null;
  await t?.cleanup();
});

async function mock(scenario: string) {
  t = await createTestContext({ mock: true });
  auth = createMockAuth(t.ctx, { signInDelayMs: 5, scenario });
  return auth;
}

const compute = (s: AuthState) => s.computeKey!;

describe('mock Compute key flags', () => {
  it('none by default (and no_compute_key): provider has no key', async () => {
    for (const scenario of ['', 'no_compute_key', 'compute_key,no_compute_key']) {
      const a = await mock(scenario);
      expect(compute(a.service.getState()).status).toBe('missing');
      expect(await a.computeKeys.getComputeKey()).toBeNull();
      await expect(a.computeKeys.requireComputeKey()).rejects.toMatchObject({ code: 'no_compute_key' });
      a.dispose();
      await t.cleanup();
    }
  });

  it('compute_key: a valid key in the placeholder organization', async () => {
    const a = await mock('compute_key');
    expect(compute(a.service.getState())).toMatchObject({ status: 'valid', last4: MOCK_COMPUTE_LAST4, orgId: '00000000-0000-0000-0000-000000000000', orgMatchesAccount: true });
    expect(await a.computeKeys.requireComputeKey()).toMatch(/mock/);
  });

  it('compute_key_invalid: rejected, with GMI’s reason', async () => {
    const a = await mock('compute_key_invalid');
    expect(compute(a.service.getState())).toMatchObject({ status: 'invalid', error: expect.stringMatching(/rejected/) });
  });

  it('compute_key_locked: metadata kept, locked, no key; Try again unlocks it', async () => {
    const a = await mock('compute_key_locked');
    const s = a.service.getState();
    expect(s.lockedSecrets).toEqual(['compute_key']);
    expect(compute(s)).toMatchObject({ status: 'unverified', last4: MOCK_COMPUTE_LAST4, error: COMPUTE_KEY_LOCKED_MESSAGE });
    expect(s.status).toBe('signed_in'); // only the Compute key is locked
    expect(await a.computeKeys.getComputeKey()).toBeNull();
    await expect(a.computeKeys.requireComputeKey()).rejects.toMatchObject({ code: 'no_compute_key', message: COMPUTE_KEY_LOCKED_MESSAGE });
    const unlocked = await a.api.retrySecureStorage();
    expect(unlocked.lockedSecrets).toEqual([]);
    expect(compute(unlocked)).toMatchObject({ status: 'valid', error: null });
    expect(await a.computeKeys.getComputeKey()).not.toBeNull();
  });

  it('keychain_locked also locks a mock Compute key', async () => {
    const a = await mock('keychain_locked,compute_key');
    expect(a.service.getState().lockedSecrets).toEqual(expect.arrayContaining(['sign_in', 'inference_key', 'compute_key']));
  });

  it('401 marks the key invalid; 403 never does; listeners hear changes', async () => {
    const a = await mock('compute_key');
    let changes = 0;
    a.computeKeys.onChange(() => (changes += 1));
    await a.computeKeys.reportInvalidComputeKey('tenant has no permission', undefined, 403);
    expect(compute(a.service.getState()).status).toBe('valid');
    await a.computeKeys.reportInvalidComputeKey('Expired API key.', undefined, 401);
    expect(compute(a.service.getState())).toMatchObject({ status: 'invalid', error: 'Expired API key.' });
    expect(changes).toBe(1);
    await a.api.revalidateComputeKey();
    expect(compute(a.service.getState()).status).toBe('valid');
    await a.api.removeComputeKey();
    expect(compute(a.service.getState()).status).toBe('missing');
    expect(changes).toBe(3);
  });

  it('setComputeKey: stores a key; an "inference" key is refused with the chat-instead detail', async () => {
    const a = await mock('');
    await expect(a.api.setComputeKey('gmi-ie_model-key-1234')).rejects.toMatchObject({ code: 'invalid_input', detail: INFERENCE_SCOPE_DETAIL });
    const s = await a.api.setComputeKey('  gmi-mock-compute-paste-WXYZ ');
    expect(compute(s)).toMatchObject({ status: 'valid', last4: 'WXYZ' });
    expect(JSON.stringify(s)).not.toContain('gmi-mock-compute-paste');
  });

  it('basic_text: the native dialog decides; declined → session only', async () => {
    const a = await mock('basic_text');
    t.platform.confirmAnswer = false;
    const s = await a.api.setComputeKey('gmi-mock-compute-paste-WXYZ');
    expect(t.platform.confirms.map((c) => c.title)).toEqual([WEAK_KEYRING_CONFIRM.title]);
    expect(compute(s)).toMatchObject({ status: 'valid', sessionOnly: true });
    t.platform.confirmAnswer = true;
    const stored = await a.api.setComputeKey('gmi-mock-compute-paste-ABCD');
    expect((compute(stored) as { sessionOnly?: boolean }).sessionOnly).toBeUndefined();
  });

  it('Connect Compute detection: target compute stores the found key as the Compute key', async () => {
    const a = await mock('key_candidate');
    const started = await a.api.startKeyDetection('compute');
    expect(started.keyDetection).toMatchObject({ active: true, target: 'compute', candidate: { last4: MOCK_CANDIDATE_LAST4 } });
    const result = await a.api.useDetectedKey();
    expect(compute(result.state)).toMatchObject({ status: 'valid', last4: MOCK_CANDIDATE_LAST4 });
    expect(result.state.inferenceKey.last4).toBe('demo'); // the chat key is untouched
    expect(result.state.keyDetection).toEqual({ active: false, candidate: null });
  });
});
