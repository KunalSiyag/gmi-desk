/**
 * Connect chat (main process): the OAuth inference probe and the KeyProvider fallback to the sign-in, the
 * scope union at sign-in, and clipboard key detection for the Connect dialog.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import keyFixtures from '@main/mock/fixtures/auth/api-key-current.json';
import asMetadata from '@main/mock/fixtures/auth/oauth-authorization-server.json';
import type { AuthState } from '@shared/contracts/auth';
import { GMI_SCOPES } from '@shared/contracts/auth';
import type { Logger } from '@main/core/logger';
import { createAuthSliceWith, type AuthSlice, type AuthSliceOptions } from '@main/services/auth';
import { INFERENCE_PROBE_URL, REQUESTED_SCOPE, requestedScopeFor, scopeSet } from '@main/services/auth/constants';
import { OAuthInference, probeInferenceWithToken } from '@main/services/auth/inference';
import { keyCandidateOf, KeyDetector, MIN_DETECTED_KEY_LENGTH } from '@main/services/auth/key-detection';
import { createOAuthClient } from '@main/services/auth/oauth';
import { DEFAULT_AUTH_FILE, type AuthFile } from '@main/services/auth/state';
import { createHttp } from '@main/core/http';
import { silentLogger } from '@main/core/logger';
import type { JsonStore } from '@main/core/store';
import { USER_AGENT } from '@shared/app';
import { createFakeFetch, jsonResponse, type FakeRoute, type RecordedRequest } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';
import { ALL_SCOPES, exact, ISSUER, KEY_URL, REGISTER_URL, seedTokens, waitFor } from './helpers';

// --- fake keys (JWT-shaped like GMI's inference keys; nothing real) -------------------------------------
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: Record<string, unknown>, signature: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${signature}`;
const KEY_A = jwt({ sub: 'test-key-a', scope: 'ie_model' }, 'c2lnbmF0dXJlLWZvci10ZXN0LWtleS1hAbCd');
const KEY_B = jwt({ sub: 'test-key-b', scope: 'ie_model' }, 'c2lnbmF0dXJlLWZvci10ZXN0LWtleS1iWxYz');
const REJECTED = jwt({ sub: 'test-key-revoked' }, 'c2lnbmF0dXJlLWZvci1yZXZva2VkLWtleQQq9');
const ACCESS = 'access-1'; // seedTokens' access token

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HOUR = 3_600_000;

let t: TestContext;
let slice: AuthSlice | null = null;

afterEach(async () => {
  await slice?.dispose();
  slice = null;
  await t?.cleanup();
});

/** GMI's key endpoint: answers by bearer. */
function keyEndpoint(req: RecordedRequest): Response {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${KEY_A}` || auth === `Bearer ${KEY_B}`) return jsonResponse(keyFixtures.inference);
  return jsonResponse(keyFixtures.expired, 401);
}

type ProbeAnswer = () => Response | Promise<Response>;
const MODELS_OK: ProbeAnswer = () => jsonResponse({ object: 'list', data: [{ id: 'deepseek-ai/DeepSeek-V3.2', object: 'model' }] });

interface SetupOpts extends Partial<AuthSliceOptions> {
  signedIn?: boolean;
  /** Access token lifetime from the real clock (default 1 hour). */
  tokenLifetimeMs?: number;
  probe?: ProbeAnswer;
  authFile?: Record<string, unknown>;
  now?: () => Date;
  log?: Logger;
}

async function setup(opts: SetupOpts = {}) {
  let probeAnswer: ProbeAnswer = opts.probe ?? (() => jsonResponse({ error: 'Unauthorized' }, 401));
  const routes: FakeRoute[] = [
    { match: exact(KEY_URL), method: 'GET', respond: keyEndpoint },
    { match: exact(INFERENCE_PROBE_URL), method: 'GET', respond: () => probeAnswer() },
  ];
  const fake = createFakeFetch(routes);
  t = await createTestContext({ fetch: fake.fetch, now: opts.now });
  if (opts.log) t.ctx.log = opts.log;
  if (opts.signedIn) await seedTokens(t.ctx.secure, opts.tokenLifetimeMs ? { expires_at: Date.now() + opts.tokenLifetimeMs } : {});
  if (opts.authFile) await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, ...opts.authFile }));
  const { signedIn: _s, probe: _p, authFile: _a, now: _n, log: _l, tokenLifetimeMs: _tl, ...sliceOpts } = opts;
  slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false, keyDetectionPollMs: 20, ...sliceOpts });
  return {
    slice,
    fake,
    probeRequests: () => fake.requests.filter((r) => r.url === INFERENCE_PROBE_URL),
    keyRequests: () => fake.requests.filter((r) => r.url === KEY_URL),
    answerProbeWith(next: ProbeAnswer) {
      probeAnswer = next;
    },
  };
}

const authEvents = () => t.emitted.filter((e) => e.name === 'auth:changed').map((e) => e.payload as AuthState);
const state = () => slice!.service.getState();
const authJson = async () => JSON.parse(await readFile(join(t.ctx.paths.data, 'auth.json'), 'utf8')) as Record<string, unknown>;

/** A logger that records every line (to prove secrets never reach it). */
function recordingLogger(lines: string[]): Logger {
  const write = (level: string) => (message: string, meta?: unknown) => {
    lines.push(`${level} ${message} ${meta === undefined ? '' : JSON.stringify(meta, (_k, v: unknown) => (v instanceof Error ? v.message : v))}`);
  };
  const logger: Logger = { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error'), child: () => logger };
  return logger;
}

describe('OAuth inference probe (GET /v1/models with the sign-in)', () => {
  const probeWith = async (respond: () => Response | Promise<Response>) => {
    const fake = createFakeFetch([{ match: exact(INFERENCE_PROBE_URL), respond }]);
    const http = createHttp({ userAgent: 'GMI-Desk/test', log: silentLogger, fetch: fake.fetch });
    const outcome = await probeInferenceWithToken(http, 'token-xyz');
    return { outcome, requests: fake.requests };
  };

  it('maps 200 + data array → supported, 401/403 → unsupported, anything else → error', async () => {
    const ok = await probeWith(MODELS_OK);
    expect(ok.outcome).toBe('supported');
    expect(ok.requests).toHaveLength(1);
    expect(ok.requests[0]).toMatchObject({ url: 'https://api.gmi-serving.com/v1/models', method: 'GET' });
    expect(ok.requests[0]!.headers.authorization).toBe('Bearer token-xyz');
    expect(ok.requests[0]!.headers['user-agent']).toBe('GMI-Desk/test');

    expect((await probeWith(() => jsonResponse({ error: 'invalid token' }, 401))).outcome).toBe('unsupported');
    expect((await probeWith(() => jsonResponse({ error: 'forbidden' }, 403))).outcome).toBe('unsupported');
    expect((await probeWith(() => jsonResponse({ object: 'list' }))).outcome).toBe('error');
    expect((await probeWith(() => jsonResponse({ data: 'nope' }))).outcome).toBe('error');
    expect((await probeWith(() => new Response('<html>oops</html>', { status: 200 }))).outcome).toBe('error');
    expect((await probeWith(() => new Response('error code: 1010', { status: 403 }))).outcome).toBe('error'); // Cloudflare, not the token
    expect((await probeWith(() => jsonResponse({ error: 'rate' }, 429))).outcome).toBe('error');
    expect((await probeWith(() => Promise.reject(new TypeError('fetch failed')))).outcome).toBe('error');
  });

  it('never retries (one request even for a 5xx)', async () => {
    const res = await probeWith(() => jsonResponse({ error: 'down' }, 503));
    expect(res.outcome).toBe('error');
    expect(res.requests).toHaveLength(1);
  });

  it('runs at startup when signed in, persists the answer, and chat then uses the sign-in when no key is stored', async () => {
    const s = await setup({ signedIn: true, probe: MODELS_OK });
    await waitFor(() => state().inference?.oauthProbe === 'supported');
    expect(s.probeRequests()).toHaveLength(1);
    expect(s.probeRequests()[0]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(state().inference).toMatchObject({ via: 'oauth', oauthProbe: 'supported' });
    expect(state().inferenceKey.status).toBe('missing');
    expect(Date.parse(state().inference!.oauthProbeAt!)).not.toBeNaN();
    expect((await authJson()).oauthInference).toMatchObject({ status: 'supported' });
    expect(JSON.stringify(await authJson())).not.toContain(ACCESS);
    await expect(s.slice.keys.getInferenceKey()).resolves.toBe(ACCESS);
    await expect(s.slice.keys.requireInferenceKey()).resolves.toBe(ACCESS);
  });

  it('401 → unsupported: no fallback, chat still asks for a key', async () => {
    const s = await setup({ signedIn: true });
    await waitFor(() => state().inference?.oauthProbe === 'unsupported');
    expect(state().inference?.via).toBeNull();
    await expect(s.slice.keys.getInferenceKey()).resolves.toBeNull();
    await expect(s.slice.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key' });
    expect((await authJson()).oauthInference).toMatchObject({ status: 'unsupported' });
  });

  it('a stored key always wins over the sign-in', async () => {
    const s = await setup({ signedIn: true, probe: MODELS_OK });
    await waitFor(() => state().inference?.via === 'oauth');
    await s.slice.api.setInferenceKey(KEY_A);
    expect(state().inference).toMatchObject({ via: 'api_key', oauthProbe: 'supported' });
    await expect(s.slice.keys.requireInferenceKey()).resolves.toBe(KEY_A);
    await s.slice.api.removeInferenceKey();
    await expect(s.slice.keys.requireInferenceKey()).resolves.toBe(ACCESS);
  });

  it('probes at startup at most once a day', async () => {
    const recent = { status: 'unsupported', checkedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString() };
    const fresh = await setup({ signedIn: true, now: () => NOW, authFile: { oauthInference: recent } });
    await new Promise((r) => setTimeout(r, 30));
    expect(fresh.probeRequests()).toHaveLength(0);
    expect(state().inference).toMatchObject({ via: null, oauthProbe: 'unsupported', oauthProbeAt: recent.checkedAt });
    await slice!.dispose();
    await t.cleanup();

    const old = { status: 'unsupported', checkedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() };
    const stale = await setup({ signedIn: true, now: () => NOW, authFile: { oauthInference: old }, probe: MODELS_OK });
    await waitFor(() => state().inference?.oauthProbe === 'supported');
    expect(stale.probeRequests()).toHaveLength(1);
  });

  it('does not probe at startup when signed out, or when turned off', async () => {
    const out = await setup({ probe: MODELS_OK });
    await new Promise((r) => setTimeout(r, 30));
    expect(out.probeRequests()).toHaveLength(0);
    expect(state().inference).toEqual({ via: null, oauthProbe: 'unknown', oauthProbeAt: null });
    // On demand while signed out: nothing to ask with.
    await out.slice.api.probeOAuthInference();
    expect(out.probeRequests()).toHaveLength(0);
  });

  it('probes on demand even when the last answer is recent, showing `checking` meanwhile', async () => {
    const recent = { status: 'unsupported', checkedAt: new Date(NOW.getTime() - HOUR).toISOString() };
    const s = await setup({ signedIn: true, now: () => NOW, authFile: { oauthInference: recent }, probe: MODELS_OK });
    const result = await s.slice.api.probeOAuthInference();
    expect(s.probeRequests()).toHaveLength(1);
    expect(result.inference).toMatchObject({ via: 'oauth', oauthProbe: 'supported', oauthProbeAt: NOW.toISOString() });
    expect(authEvents().map((e) => e.inference?.oauthProbe)).toEqual(expect.arrayContaining(['checking', 'supported']));
  });

  it('a network blip does not take chat away from a sign-in GMI accepted', async () => {
    const s = await setup({ signedIn: true, probe: MODELS_OK });
    await waitFor(() => state().inference?.oauthProbe === 'supported');
    s.answerProbeWith(() => Promise.reject(new TypeError('fetch failed')));
    await s.slice.api.probeOAuthInference();
    expect(state().inference).toMatchObject({ via: 'oauth', oauthProbe: 'supported' });
    s.answerProbeWith(() => jsonResponse({ error: 'invalid token' }, 401));
    await s.slice.api.probeOAuthInference();
    expect(state().inference).toMatchObject({ via: null, oauthProbe: 'unsupported' });
  });

  it('a 401 for the sign-in token flips the probe to unsupported instead of marking a key invalid', async () => {
    const s = await setup({ signedIn: true, probe: MODELS_OK });
    await waitFor(() => state().inference?.via === 'oauth');
    const token = await s.slice.keys.requireInferenceKey();
    await s.slice.keys.reportInvalidKey('Unauthorized', token);
    expect(state().inference).toMatchObject({ via: null, oauthProbe: 'unsupported' });
    expect(state().inferenceKey.status).toBe('missing');
    expect((await authJson()).oauthInference).toMatchObject({ status: 'unsupported' });
    await expect(s.slice.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key' });
  });

  it('a 401 for a stored key still marks the key invalid (not the probe)', async () => {
    const s = await setup({ signedIn: true, probe: MODELS_OK });
    await waitFor(() => state().inference?.via === 'oauth');
    await s.slice.api.setInferenceKey(KEY_A);
    await s.slice.keys.reportInvalidKey('Expired API key.', KEY_A);
    expect(state().inferenceKey.status).toBe('invalid');
    expect(state().inference?.oauthProbe).toBe('supported');
  });

  it('sign-out forgets the answer (it belonged to that sign-in)', async () => {
    const s = await setup({ signedIn: true, probe: MODELS_OK });
    await waitFor(() => state().inference?.via === 'oauth');
    await s.slice.api.signOut();
    expect(state().inference).toEqual({ via: null, oauthProbe: 'unknown', oauthProbeAt: null });
    expect((await authJson()).oauthInference).toBeNull();
    await expect(s.slice.keys.getInferenceKey()).resolves.toBeNull();
  });

  it('never logs the access token', async () => {
    const lines: string[] = [];
    await setup({ signedIn: true, probe: () => jsonResponse({ error: `bad token ${ACCESS}` }, 500), log: recordingLogger(lines) });
    await waitFor(() => state().inference?.oauthProbe === 'error');
    expect(lines.join('\n')).not.toContain(ACCESS);
  });
});

describe('scopes requested at sign-in', () => {
  it('are the six known scopes plus the advertised inference / key-read scopes, deduplicated, known ones first', () => {
    expect(requestedScopeFor(null)).toBe(GMI_SCOPES.join(' '));
    expect(requestedScopeFor({})).toBe(ALL_SCOPES);
    expect(requestedScopeFor(asMetadata)).toBe(ALL_SCOPES); // today's metadata: same six, other order
    expect(requestedScopeFor({ scopes_supported: ['billing:read', 'inference:write', 'keys:read', 'inference:write', 'ie_model', 'chat'] })).toBe(
      `${ALL_SCOPES} inference:write keys:read ie_model chat`,
    );
  });

  it('never asks for anything else GMI advertises (least privilege)', () => {
    const advertised = ['openid', 'offline_access', 'admin', 'keys:write', 'api_keys:write', 'billing:write', 'org:delete', 'mcp:admin', 'inference:write'];
    expect(requestedScopeFor({ scopes_supported: advertised })).toBe(`${ALL_SCOPES} inference:write`);
  });

  it('ignores malformed and excessive advertised scopes', () => {
    const bad = ['has space', 'quote"d', 'back\\slash', '', 42, null, 'x'.repeat(129), 'inference:chat'];
    expect(requestedScopeFor({ scopes_supported: bad })).toBe(`${ALL_SCOPES} inference:chat`);
    expect(requestedScopeFor({ scopes_supported: 'models:read inference:write' })).toBe(ALL_SCOPES);
    const many = Array.from({ length: 50 }, (_, i) => `chat:${'a'.repeat(i + 1)}`);
    expect(requestedScopeFor({ scopes_supported: many }).split(' ')).toHaveLength(GMI_SCOPES.length + 32);
  });

  it('compares registrations as sets (GMI reordering its metadata is not a change)', () => {
    expect(scopeSet('b a  a c')).toBe('a b c');
    expect(scopeSet(ALL_SCOPES)).toBe(scopeSet(ALL_SCOPES.split(' ').reverse().join(' ')));
  });

  it('falls back to the six known scopes after GMI refused the extra ones', async () => {
    const metadata = { ...asMetadata, scopes_supported: [...asMetadata.scopes_supported, 'inference:write'] };
    const fake = createFakeFetch([
      { match: (u) => u.includes('/.well-known/oauth-protected-resource'), respond: () => jsonResponse({ resource: 'https://mcp.gmicloud.ai/mcp', authorization_servers: [ISSUER] }) },
      { match: exact(`${ISSUER}/.well-known/oauth-authorization-server`), respond: () => jsonResponse(metadata) },
    ]);
    const oauth = createOAuthClient({ fetch: fake.fetch, userAgent: USER_AGENT, log: silentLogger, now: () => NOW });
    expect((await oauth.discover()).scope).toBe(`${ALL_SCOPES} inference:write`);
    expect(oauth.restrictToKnownScopes()).toBe(true);
    expect((await oauth.discover()).scope).toBe(REQUESTED_SCOPE);
    expect(oauth.restrictToKnownScopes()).toBe(false); // already restricted
    oauth.forget();
    expect((await oauth.discover()).scope).toBe(REQUESTED_SCOPE); // for the rest of this app run
  });

  it('registers and authorizes with a scope GMI adds later (no app update needed)', async () => {
    const metadata = { ...asMetadata, scopes_supported: [...asMetadata.scopes_supported, 'inference:write'] };
    const fake = createFakeFetch([
      { match: (u) => u.includes('/.well-known/oauth-protected-resource'), respond: () => jsonResponse({ resource: 'https://mcp.gmicloud.ai/mcp', authorization_servers: [ISSUER] }) },
      { match: exact(`${ISSUER}/.well-known/oauth-authorization-server`), respond: () => jsonResponse(metadata) },
      {
        match: exact(REGISTER_URL),
        method: 'POST',
        respond: (req) => jsonResponse({ client_id: 'client-new', redirect_uris: (JSON.parse(req.body!) as { redirect_uris: string[] }).redirect_uris, token_endpoint_auth_method: 'none' }, 201),
      },
    ]);
    const oauth = createOAuthClient({ fetch: fake.fetch, userAgent: USER_AGENT, log: silentLogger, now: () => NOW });
    const server = await oauth.discover();
    expect(server.scope).toBe(`${ALL_SCOPES} inference:write`);
    const client = await oauth.register(server, 'http://127.0.0.1:50999/callback');
    expect(client.scope).toBe(`${ALL_SCOPES} inference:write`);
    expect((JSON.parse(fake.requests.find((r) => r.url === REGISTER_URL)!.body!) as { scope: string }).scope).toBe(`${ALL_SCOPES} inference:write`);
    const { url } = await oauth.authorizationUrl(server, client, 'state-1');
    expect(new URL(url).searchParams.get('scope')).toBe(`${ALL_SCOPES} inference:write`);
  });
});

describe('clipboard key detection: what counts as a key', () => {
  it('accepts one JWT-shaped token (surrounding whitespace ignored)', () => {
    expect(keyCandidateOf(KEY_A)).toBe(KEY_A);
    expect(keyCandidateOf(`  \n${KEY_A}\n `)).toBe(KEY_A);
  });

  it('only HS256 JWTs (GMI inference keys) that name no other issuer: not the GMI sign-in token, not other services’ tokens', () => {
    const sig = 'c2lnbmF0dXJlLWZvci10ZXN0LXRva2VuLWFiY2Q';
    const token = (header: Record<string, unknown>, payload: unknown) => `${b64(header)}.${b64(payload)}.${sig}`;
    // The GMI sign-in's own access token (ES256, issued by mcp.gmicloud.ai).
    expect(keyCandidateOf(token({ alg: 'ES256', typ: 'JWT', kid: 'k1' }, { iss: 'https://mcp.gmicloud.ai', aud: 'https://mcp.gmicloud.ai/mcp' }))).toBeNull();
    // Another service's ID token (RS256), and an HS256 token naming another issuer.
    expect(keyCandidateOf(token({ alg: 'RS256', typ: 'JWT' }, { iss: 'https://accounts.example.com', sub: 'u1' }))).toBeNull();
    expect(keyCandidateOf(token({ alg: 'HS256', typ: 'JWT' }, { iss: 'https://project.supabase.co/auth/v1', sub: 'u1' }))).toBeNull();
    expect(keyCandidateOf(token({ alg: 'HS256', typ: 'JWT' }, { iss: 'https://evil-gmicloud.ai.example.com' }))).toBeNull();
    expect(keyCandidateOf(token({ alg: 'HS256', typ: 'JWT' }, { iss: 'https://[bad' }))).toBeNull();
    expect(keyCandidateOf(token({ alg: 'HS256', typ: 'JWT' }, ['not', 'an', 'object']))).toBeNull();
    expect(keyCandidateOf(`${b64({ alg: 'HS256' })}.${Buffer.from('not json').toString('base64url')}.${sig}`)).toBeNull();
    expect(keyCandidateOf(token({ alg: 'none' }, { sub: 'x' }))).toBeNull();
    // GMI-shaped: HS256 with no issuer, a non-URL issuer, or a GMI host.
    for (const payload of [{ sub: 'k' }, { iss: 'gmi', sub: 'k' }, { iss: 'https://console.gmicloud.ai' }, { iss: 'https://api.gmi-serving.com/v1' }]) {
      const key = token({ alg: 'HS256', typ: 'JWT' }, payload);
      expect(keyCandidateOf(key)).toBe(key);
    }
  });

  it('rejects whitespace inside, wrong shape, bad header, or out-of-range length', () => {
    const [h, p, sig] = KEY_A.split('.') as [string, string, string];
    expect(keyCandidateOf(`${h}.${p} .${sig}`)).toBeNull();
    expect(keyCandidateOf(`${KEY_A} ${KEY_B}`)).toBeNull();
    expect(keyCandidateOf(`Bearer ${KEY_A}`)).toBeNull();
    expect(keyCandidateOf(`${h}.${p}`)).toBeNull(); // 2 segments
    expect(keyCandidateOf(`${h}.${p}.${sig}.${sig}`)).toBeNull(); // 4 segments
    expect(keyCandidateOf(`${h}.${p}.`)).toBeNull(); // empty segment
    expect(keyCandidateOf(`${h}.${p}.sig+with/base64`)).toBeNull(); // not base64url
    expect(keyCandidateOf(`${b64({ typ: 'JWT' })}.${p}.${sig}`)).toBeNull(); // no alg
    expect(keyCandidateOf(`${b64(['alg'])}.${p}.${sig}`)).toBeNull(); // header not an object
    expect(keyCandidateOf(`${Buffer.from('not json at all').toString('base64url')}.${p}.${sig}`)).toBeNull();
    expect(keyCandidateOf('sk-plain-api-key-without-dots-123456')).toBeNull();
    expect(keyCandidateOf('a.b.c')).toBeNull(); // too short
    const short = `${b64({ alg: 'x' })}.a.b`;
    expect(short.length).toBeLessThan(MIN_DETECTED_KEY_LENGTH);
    expect(keyCandidateOf(short)).toBeNull();
    expect(keyCandidateOf(`${h}.${'A'.repeat(4096)}.${sig}`)).toBeNull(); // > 4096
    expect(keyCandidateOf('x'.repeat(100_000))).toBeNull();
    expect(keyCandidateOf('')).toBeNull();
    expect(keyCandidateOf(undefined)).toBeNull();
  });
});

describe('clipboard key detection: lifecycle', () => {
  const active = () => state().keyDetection?.active === true;
  const candidate = () => state().keyDetection?.candidate ?? null;

  it('does nothing until the Connect dialog starts it', async () => {
    const s = await setup();
    t.platform.clipboard = KEY_A;
    t.platform.emitFocus();
    await new Promise((r) => setTimeout(r, 60));
    expect(t.platform.clipboardReads).toBe(0);
    expect(t.platform.focusListeners.size).toBe(0);
    expect(state().keyDetection).toEqual({ active: false, candidate: null });
    expect(s.keyRequests()).toHaveLength(0);
  });

  it('checks on start, then about once a second while focused, and on every focus', async () => {
    await setup();
    const started = await slice!.api.startKeyDetection();
    expect(started.keyDetection?.active).toBe(true);
    await waitFor(() => t.platform.clipboardReads >= 1);
    await waitFor(() => t.platform.clipboardReads >= 3); // polling (20 ms in tests)

    t.platform.focused = false;
    await new Promise((r) => setTimeout(r, 40));
    const whileBlurred = t.platform.clipboardReads;
    await new Promise((r) => setTimeout(r, 80));
    expect(t.platform.clipboardReads).toBe(whileBlurred); // no polling without focus (Wayland would not answer)

    t.platform.clipboard = KEY_A;
    t.platform.emitFocus(); // back from GMI Console
    await waitFor(() => candidate() !== null);
    expect(candidate()).toEqual({ last4: KEY_A.slice(-4), detectedAt: expect.any(String) as string });
  });

  it('stops on stop(): no more reads, focus listener removed, candidate forgotten', async () => {
    await setup();
    t.platform.clipboard = KEY_A;
    await slice!.api.startKeyDetection();
    await waitFor(() => candidate() !== null);
    const stopped = await slice!.api.stopKeyDetection();
    expect(stopped.keyDetection).toEqual({ active: false, candidate: null });
    expect(t.platform.focusListeners.size).toBe(0);
    const reads = t.platform.clipboardReads;
    t.platform.emitFocus();
    await new Promise((r) => setTimeout(r, 80));
    expect(t.platform.clipboardReads).toBe(reads);
  });

  it('stops by itself after the timeout (10 minutes in the app)', async () => {
    await setup({ keyDetectionTimeoutMs: 80 });
    await slice!.api.startKeyDetection();
    expect(active()).toBe(true);
    await waitFor(() => !active(), 1_000);
    expect(authEvents().at(-1)?.keyDetection).toEqual({ active: false, candidate: null });
    expect(t.platform.focusListeners.size).toBe(0);
  });

  it('starting again restarts the clock instead of adding a second watcher', async () => {
    await setup({ keyDetectionTimeoutMs: 150 });
    await slice!.api.startKeyDetection();
    await new Promise((r) => setTimeout(r, 100));
    await slice!.api.startKeyDetection();
    expect(t.platform.focusListeners.size).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(active()).toBe(true); // 200 ms after the first start, 100 ms after the second
    await waitFor(() => !active(), 1_000);
  });

  it('ignores the key already in use, and values the user dismissed', async () => {
    const s = await setup();
    await s.slice.api.setInferenceKey(KEY_A);
    t.platform.clipboard = KEY_A;
    await s.slice.api.startKeyDetection();
    await new Promise((r) => setTimeout(r, 80));
    expect(candidate()).toBeNull();

    t.platform.clipboard = KEY_B;
    await waitFor(() => candidate()?.last4 === KEY_B.slice(-4));
    await s.slice.api.dismissDetectedKey();
    expect(candidate()).toBeNull();
    expect(active()).toBe(true); // still watching for the right one
    await new Promise((r) => setTimeout(r, 80));
    expect(candidate()).toBeNull(); // the dismissed value is not offered again
    t.platform.clipboard = `\n${KEY_B}\n`;
    await new Promise((r) => setTimeout(r, 80));
    expect(candidate()).toBeNull(); // not even with whitespace around it
  });

  it('sends nothing to GMI until "Use this key", then validates, stores, stops and clears the clipboard', async () => {
    const lines: string[] = [];
    const s = await setup({ log: recordingLogger(lines) });
    t.platform.clipboard = KEY_A;
    await s.slice.api.startKeyDetection();
    await waitFor(() => candidate() !== null);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.fake.requests).toHaveLength(0);

    const result = await s.slice.api.useDetectedKey();
    expect(s.keyRequests()).toHaveLength(1);
    expect(s.keyRequests()[0]!.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(result.clipboardCleared).toBe(true);
    expect(t.platform.clipboard).toBe('');
    expect(result.state.inferenceKey).toMatchObject({ status: 'valid', last4: KEY_A.slice(-4), source: 'keychain' });
    expect(result.state.keyDetection).toEqual({ active: false, candidate: null });
    expect(result.state.inference?.via).toBe('api_key');
    expect(await t.ctx.secure.get('inference.key')).toBe(KEY_A);
    expect(t.platform.focusListeners.size).toBe(0);

    // The raw key never reached the renderer (events) or the logs.
    for (const event of t.emitted) expect(JSON.stringify(event.payload)).not.toContain(KEY_A);
    expect(JSON.stringify(result)).not.toContain(KEY_A);
    expect(lines.join('\n')).not.toContain(KEY_A);
    expect(lines.join('\n')).not.toContain(KEY_A.split('.')[2]!);
  });

  it('leaves the clipboard alone when it no longer holds the key', async () => {
    const s = await setup();
    t.platform.clipboard = KEY_A;
    await s.slice.api.startKeyDetection();
    await waitFor(() => candidate() !== null);
    await s.slice.api.stopKeyDetection(); // the poller must not pick up the next copy
    await s.slice.api.startKeyDetection();
    await waitFor(() => candidate() !== null);
    t.platform.focused = false; // stop polling so the new clipboard text is not read
    await new Promise((r) => setTimeout(r, 40));
    t.platform.clipboard = 'something else the user copied';
    const result = await s.slice.api.useDetectedKey();
    expect(result.clipboardCleared).toBe(false);
    expect(t.platform.clipboard).toBe('something else the user copied');
    expect(result.state.inferenceKey.status).toBe('valid');
  });

  it('a key GMI rejects is reported, stored nowhere and not offered again', async () => {
    const s = await setup();
    t.platform.clipboard = REJECTED;
    await s.slice.api.startKeyDetection();
    await waitFor(() => candidate() !== null);
    await expect(s.slice.api.useDetectedKey()).rejects.toMatchObject({ code: 'invalid_api_key' });
    expect(state().inferenceKey.status).toBe('missing');
    expect(await t.ctx.secure.get('inference.key')).toBeNull();
    expect(candidate()).toBeNull();
    expect(active()).toBe(true);
    expect(t.platform.clipboard).toBe(REJECTED); // untouched
    await new Promise((r) => setTimeout(r, 80));
    expect(candidate()).toBeNull();
  });

  it('useDetectedKey without a candidate is not_found and sends nothing', async () => {
    const s = await setup();
    await s.slice.api.startKeyDetection();
    await expect(s.slice.api.useDetectedKey()).rejects.toMatchObject({ code: 'not_found' });
    expect(s.fake.requests).toHaveLength(0);
  });

  it('a clipboard read that never answers is abandoned after a timeout, and stop/start always recovers', async () => {
    let reads = 0;
    let hang = true;
    const detector = new KeyDetector({
      platform: {
        readClipboardText: () => {
          reads += 1;
          return hang ? new Promise<string>(() => undefined) : Promise.resolve(KEY_A);
        },
        isAppFocused: () => true,
        onAppFocus: () => () => undefined,
      },
      now: () => new Date(),
      currentKey: async () => null,
      emit: () => undefined,
      log: silentLogger,
      pollMs: 10,
      readTimeoutMs: 40,
    });
    try {
      detector.start();
      await new Promise((r) => setTimeout(r, 25));
      expect(reads).toBe(1); // the poller waits behind the hanging read…
      await waitFor(() => reads >= 2); // …until it times out
      // Reopening the dialog never waits for a hanging read.
      detector.stop();
      hang = false;
      const before = reads;
      detector.start();
      await waitFor(() => reads > before);
      await waitFor(() => detector.state().candidate?.last4 === KEY_A.slice(-4));
    } finally {
      detector.dispose();
    }
  });

  it('a read from before a stop reports nothing after it', async () => {
    const answers: Array<(text: string) => void> = [];
    const detector = new KeyDetector({
      platform: {
        readClipboardText: () => new Promise<string>((resolve) => answers.push(resolve)),
        isAppFocused: () => false,
        onAppFocus: () => () => undefined,
      },
      now: () => new Date(),
      currentKey: async () => null,
      emit: () => undefined,
      log: silentLogger,
    });
    try {
      detector.start();
      detector.stop();
      detector.start(); // a new run with its own read; the first read is still pending
      expect(answers).toHaveLength(2);
      answers[0]!(KEY_A); // the old run's read answers late
      await new Promise((r) => setTimeout(r, 20));
      expect(detector.state().candidate).toBeNull();
      answers[1]!(KEY_B); // the current run's read counts
      await waitFor(() => detector.state().candidate?.last4 === KEY_B.slice(-4));
    } finally {
      detector.dispose();
    }
  });

  it('dispose stops watching', async () => {
    await setup();
    await slice!.api.startKeyDetection();
    await slice!.dispose();
    slice = null;
    expect(t.platform.focusListeners.size).toBe(0);
    const reads = t.platform.clipboardReads;
    await new Promise((r) => setTimeout(r, 60));
    expect(t.platform.clipboardReads).toBe(reads);
  });
});

describe('OAuth inference probe: sessions and long-running apps', () => {
  /** An in-memory JsonStore for OAuthInference. */
  function memoryFile(initial: AuthFile = DEFAULT_AUTH_FILE): JsonStore<AuthFile> {
    let value = initial;
    return {
      path: 'memory:auth.json',
      get: () => value,
      set: async (next: AuthFile) => {
        value = next;
      },
      update: async (fn: (current: AuthFile) => AuthFile) => {
        value = fn(value);
        return value;
      },
      flush: async () => undefined,
    };
  }

  it('a sign-in during a probe for the previous session gets its own probe', async () => {
    const answers: Array<(res: Response) => void> = [];
    const fake = createFakeFetch([{ match: exact(INFERENCE_PROBE_URL), respond: () => new Promise<Response>((resolve) => answers.push(resolve)) }]);
    let epoch = 1;
    const file = memoryFile();
    const inference = new OAuthInference({
      http: createHttp({ userAgent: 'GMI-Desk/test', log: silentLogger, fetch: fake.fetch }),
      file,
      now: () => NOW,
      log: silentLogger,
      accessToken: async () => `token-${epoch}`,
      hasSession: () => true,
      epoch: () => epoch,
      hasKey: () => false,
      grantedScope: () => ALL_SCOPES,
      emit: () => undefined,
    });
    const first = inference.probeNow();
    expect(inference.probeNow()).toBe(first); // same session: joins
    await waitFor(() => answers.length === 1);
    epoch = 2; // signed out and in again while the first probe is in flight
    const second = inference.probeNow();
    expect(second).not.toBe(first);
    await waitFor(() => answers.length === 2);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
    answers[0]!(jsonResponse({ error: 'invalid token' }, 401)); // about the old sign-in: dropped
    await first;
    expect(file.get().oauthInference).toBeNull();
    answers[1]!(jsonResponse({ object: 'list', data: [{ id: 'm' }] }));
    await second;
    expect(file.get().oauthInference).toMatchObject({ status: 'supported' });
    expect(inference.probe).toBe('supported');
  });

  it('a long-running app asks again once the last answer is a day old', async () => {
    let now = NOW.getTime();
    const recent = { status: 'unsupported', checkedAt: new Date(now - 2 * HOUR).toISOString() };
    const s = await setup({
      signedIn: true,
      tokenLifetimeMs: 48 * HOUR,
      now: () => new Date(now),
      authFile: { oauthInference: recent },
      probe: MODELS_OK,
      inferenceRecheckMs: 20,
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(s.probeRequests()).toHaveLength(0); // checked 2 hours ago
    now += 23 * HOUR; // the app stayed open
    await waitFor(() => state().inference?.oauthProbe === 'supported');
    expect(s.probeRequests()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(s.probeRequests()).toHaveLength(1); // fresh again: no more asking for a day
  });

  it('does not re-check while signed out, or when turned off', async () => {
    let now = NOW.getTime();
    const signedOut = await setup({ now: () => new Date(now), probe: MODELS_OK, inferenceRecheckMs: 20 });
    now += 48 * HOUR;
    await new Promise((r) => setTimeout(r, 80));
    expect(signedOut.probeRequests()).toHaveLength(0);
    await slice!.dispose();
    slice = null;
    await t.cleanup();

    const off = await setup({ signedIn: true, now: () => new Date(now), probe: MODELS_OK, probeInferenceOnStart: false, inferenceRecheckMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    expect(off.probeRequests()).toHaveLength(0);
  });
});
