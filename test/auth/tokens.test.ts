import { describe, expect, it, vi } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { silentLogger } from '@main/core/logger';
import { createMemorySecureStore } from '@main/core/secure-store';
import { parseStoredTokens, scopesOf, tokensFromResponse, type StoredTokens } from '@main/services/auth/secrets';
import { TokenManager, type TokenManagerDeps } from '@main/services/auth/tokens';
import { ALL_SCOPES, seedTokens } from './helpers';

function setup(overrides: Partial<TokenManagerDeps> = {}) {
  const secure = createMemorySecureStore();
  let now = Date.parse('2026-10-31T12:00:00Z');
  let refreshCalls = 0;
  const onReauthRequired = vi.fn();
  const onRefreshFailed = vi.fn();
  const onRefreshed = vi.fn();
  const deps: TokenManagerDeps = {
    secure,
    now: () => new Date(now),
    log: silentLogger,
    async refresh(current) {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ...current, access_token: `access-${refreshCalls + 1}`, expires_at: now + 3_600_000 };
    },
    onReauthRequired,
    onRefreshFailed,
    onRefreshed,
    ...overrides,
  };
  const manager = new TokenManager(deps);
  return {
    manager,
    secure,
    onReauthRequired,
    onRefreshFailed,
    onRefreshed,
    refreshCalls: () => refreshCalls,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

describe('token store', () => {
  it('parses stored tokens defensively and drops corrupt values', async () => {
    expect(parseStoredTokens('{not json')).toBeNull();
    expect(parseStoredTokens(JSON.stringify({ refresh_token: 'r' }))).toBeNull();
    expect(parseStoredTokens(JSON.stringify({ access_token: 'a', expires_at: 'soon' }))).toMatchObject({
      access_token: 'a',
      refresh_token: null,
      expires_at: null,
      token_type: 'Bearer',
    });

    const t = setup();
    await t.secure.set('oauth.tokens', 'garbage');
    expect(await t.manager.load()).toBeNull();
    expect(await t.secure.get('oauth.tokens')).toBeNull();
  });

  it('normalises token responses (expiry, inherited scope and refresh token)', () => {
    const now = new Date('2026-10-31T00:00:00Z');
    const tokens = tokensFromResponse({ access_token: 'a', token_type: 'bearer', expires_in: 600 }, now, { scope: ALL_SCOPES, refreshToken: 'old' });
    expect(tokens).toEqual({ access_token: 'a', refresh_token: 'old', expires_at: now.getTime() + 600_000, scope: ALL_SCOPES, token_type: 'bearer' });
    expect(scopesOf({ ...tokens, scope: 'models:read  billing:read models:read' })).toEqual(['models:read', 'billing:read']);
  });

  it('returns the stored access token while it is fresh', async () => {
    const t = setup();
    await seedTokens(t.secure, { expires_at: t.at() + 10 * 60_000 });
    await expect(t.manager.getAccessToken()).resolves.toBe('access-1');
    expect(t.refreshCalls()).toBe(0);
  });

  it('refreshes proactively when less than 60 s remain, once for concurrent callers', async () => {
    const t = setup();
    await seedTokens(t.secure, { expires_at: t.at() + 30_000 });
    const results = await Promise.all([t.manager.getAccessToken(), t.manager.getAccessToken(), t.manager.getAccessToken()]);
    expect(results).toEqual(['access-2', 'access-2', 'access-2']);
    expect(t.refreshCalls()).toBe(1);
    expect(t.onRefreshed).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse((await t.secure.get('oauth.tokens'))!) as StoredTokens;
    expect(persisted.access_token).toBe('access-2');
    // fresh again: no further refresh
    await expect(t.manager.getAccessToken()).resolves.toBe('access-2');
    expect(t.refreshCalls()).toBe(1);
  });

  it('forceRefresh refreshes once and skips when another caller already replaced the token', async () => {
    const t = setup();
    await seedTokens(t.secure);
    await t.manager.load();
    const [a, b] = await Promise.all([t.manager.forceRefresh('access-1'), t.manager.forceRefresh('access-1')]);
    expect(a).toBe('access-2');
    expect(b).toBe('access-2');
    expect(t.refreshCalls()).toBe(1);
    await expect(t.manager.forceRefresh('access-1')).resolves.toBe('access-2');
    expect(t.refreshCalls()).toBe(1);
  });

  it('ends the session on invalid_grant (reauth_required) and clears the tokens', async () => {
    const t = setup({
      refresh: async () => {
        throw new GmiError('reauth_required', 'Your GMI sign-in expired. Sign in again.');
      },
    });
    await seedTokens(t.secure, { expires_at: t.at() - 1 });
    await expect(t.manager.getAccessToken()).rejects.toMatchObject({ code: 'reauth_required' });
    expect(t.onReauthRequired).toHaveBeenCalledWith('Your GMI sign-in expired. Sign in again.');
    expect(t.manager.current).toBeNull();
    expect(await t.secure.get('oauth.tokens')).toBeNull();
  });

  it('treats a missing refresh token as a dead session', async () => {
    const t = setup();
    await seedTokens(t.secure, { refresh_token: null, expires_at: t.at() - 1 });
    await expect(t.manager.getAccessToken()).rejects.toMatchObject({ code: 'reauth_required' });
    expect(t.onReauthRequired).toHaveBeenCalled();
    expect(t.refreshCalls()).toBe(0);
  });

  it('keeps the session on transient failures (uses the old token while it is still valid)', async () => {
    const t = setup({
      refresh: async () => {
        throw new GmiError('network', 'Could not reach GMI. Check your connection.');
      },
    });
    await seedTokens(t.secure, { expires_at: t.at() + 20_000 });
    await expect(t.manager.getAccessToken()).resolves.toBe('access-1');
    expect(t.onRefreshFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'network' }));
    expect(t.onReauthRequired).not.toHaveBeenCalled();

    t.advance(30_000); // now expired
    await expect(t.manager.getAccessToken()).rejects.toMatchObject({ code: 'network' });
    expect(t.manager.current?.access_token).toBe('access-1');
  });

  it('drops a refresh that finishes after sign-out', async () => {
    const t = setup();
    await seedTokens(t.secure, { expires_at: t.at() + 1_000 });
    await t.manager.load();
    const pending = t.manager.getAccessToken();
    await new Promise((r) => setTimeout(r, 5)); // refresh in flight
    await t.manager.clear();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(t.manager.current).toBeNull();
    expect(await t.secure.get('oauth.tokens')).toBeNull();
    expect(t.onReauthRequired).not.toHaveBeenCalled();
  });

  it('a sign-out during the initial load is not undone by the load', async () => {
    const t = setup();
    await seedTokens(t.secure);
    const loading = t.manager.load();
    await t.manager.clear();
    await expect(loading).resolves.toBeNull();
    expect(t.manager.current).toBeNull();
    await expect(t.manager.getAccessToken()).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('reports not_signed_in without tokens', async () => {
    const t = setup();
    await expect(t.manager.getAccessToken()).rejects.toMatchObject({ code: 'not_signed_in' });
  });
});
