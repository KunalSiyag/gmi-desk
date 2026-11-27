/**
 * Connect chat end to end: the real auth slice wired to the real chat slice, with GMI's /v1/models accepting the
 * sign-in. What happens when chat or GMI Router then refuse it (401, or 403 insufficient_scope), and that the probe
 * does not flip the answer back while the granted scopes stay the same.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import keyFixtures from '@main/mock/fixtures/auth/api-key-current.json';
import type { ChatStreamEvent } from '@shared/contracts/chat';
import { createAuthSliceWith, type AuthSlice } from '@main/services/auth';
import { INFERENCE_PROBE_URL } from '@main/services/auth/constants';
import { createChatSlice, type ChatSlice } from '@main/services/chat';
import { ROUTER_URL } from '@main/services/chat/stream-router';
import { createFakeFetch, jsonResponse, type FakeRoute } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';
import { fakeBudget, fakeCatalog, llm, waitForEnd } from '../chat/fakes';
import { ALL_SCOPES, exact, KEY_URL, seedTokens, waitFor } from './helpers';

const GLM = 'zai-org/GLM-5.3';
const CHAT_URL = 'https://api.gmi-serving.com/v1/chat/completions';
const ACCESS = 'access-1'; // seedTokens' access token
const REAL_KEY = 'sk-inference-key-0001-ab12';
const sortedScopes = ALL_SCOPES.split(' ').sort().join(' ');

const MODELS_OK = () => jsonResponse({ object: 'list', data: [{ id: GLM }] });
const INSUFFICIENT_SCOPE = () => jsonResponse({ error: { message: 'insufficient_scope', type: 'authentication_error' } }, 403);
const UNAUTHORIZED = () => jsonResponse({ error: { message: 'unauthorized', type: 'authentication_error', code: 'invalid_api_key' } }, 401);

let t: TestContext | null = null;
let auth: AuthSlice | null = null;
let chat: ChatSlice | null = null;

afterEach(async () => {
  await chat?.dispose();
  await auth?.dispose();
  await t?.cleanup();
  chat = null;
  auth = null;
  t = null;
});

async function wire(opts: { chat?: () => Response; router?: () => Response; authFile?: Record<string, unknown> } = {}) {
  let probe = MODELS_OK;
  let chatAnswer = opts.chat ?? UNAUTHORIZED;
  const routes: FakeRoute[] = [
    { match: exact(INFERENCE_PROBE_URL), method: 'GET', respond: () => probe() },
    {
      match: exact(KEY_URL),
      method: 'GET',
      respond: (req) => (req.headers.authorization === `Bearer ${REAL_KEY}` ? jsonResponse(keyFixtures.inference) : jsonResponse(keyFixtures.invalid, 401)),
    },
    { match: exact(CHAT_URL), method: 'POST', respond: () => chatAnswer() },
    { match: exact(ROUTER_URL), method: 'POST', respond: () => (opts.router ?? UNAUTHORIZED)() },
  ];
  const fake = createFakeFetch(routes);
  t = await createTestContext({ fetch: fake.fetch });
  await seedTokens(t.ctx.secure);
  if (opts.authFile) await writeFile(join(t.ctx.paths.data, 'auth.json'), JSON.stringify({ version: 1, ...opts.authFile }));
  auth = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false });
  chat = await createChatSlice(t.ctx, { keys: auth.keys, catalog: fakeCatalog([llm(GLM, { featured: true })]), budget: fakeBudget().budget }, { flushIntervalMs: 0 });
  return {
    fake,
    setProbe: (next: () => Response) => (probe = next),
    setChat: (next: () => Response) => (chatAnswer = next),
    chatRequests: () => fake.requests.filter((r) => r.url === CHAT_URL || r.url === ROUTER_URL),
  };
}

const inference = () => auth!.service.getState().inference;
const authJson = async () => JSON.parse(await readFile(join(t!.ctx.paths.data, 'auth.json'), 'utf8')) as { oauthInference?: Record<string, unknown> };

async function send(settings?: { mode: 'auto' }) {
  const thread = await chat!.api.createThread(settings ? { settings } : undefined);
  const { assistantMessageId } = await chat!.api.send(thread.id, 'Hi');
  return (await waitForEnd(t!, assistantMessageId)) as ChatStreamEvent & { error?: { code: string; status?: number } };
}

describe('chat on the GMI sign-in, refused by GMI', () => {
  it('a 403 (insufficient_scope) from chat flips the sign-in to unsupported, so the app asks for a key again', async () => {
    const w = await wire({ chat: INSUFFICIENT_SCOPE });
    await waitFor(() => inference()?.via === 'oauth');
    const end = await send();
    expect(w.chatRequests()[0]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(end.type).toBe('error');
    expect(end.error).toMatchObject({ code: 'unauthorized', status: 403 });
    await waitFor(() => inference()?.oauthProbe === 'unsupported');
    expect(inference()).toMatchObject({ via: null, oauthProbe: 'unsupported' });
    expect(auth!.service.getState().inferenceKey.status).toBe('missing'); // no key was marked invalid
    await expect(auth!.keys.requireInferenceKey()).rejects.toMatchObject({ code: 'no_api_key' });
    expect((await authJson()).oauthInference).toMatchObject({ status: 'unsupported', rejectedForScope: sortedScopes });
  });

  it('a 401 from GMI Router does the same', async () => {
    const w = await wire({ router: UNAUTHORIZED });
    await waitFor(() => inference()?.via === 'oauth');
    await send({ mode: 'auto' });
    expect(w.chatRequests().map((r) => r.url)).toEqual([ROUTER_URL]);
    expect(w.chatRequests()[0]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    await waitFor(() => inference()?.oauthProbe === 'unsupported');
    expect(inference()?.via).toBeNull();
  });

  it('a Cloudflare 403 says nothing about the sign-in: chat keeps using it', async () => {
    await wire({ chat: () => new Response('error code: 1010', { status: 403 }) });
    await waitFor(() => inference()?.via === 'oauth');
    const end = await send();
    expect(end.type).toBe('error');
    await new Promise((r) => setTimeout(r, 30));
    expect(inference()).toMatchObject({ via: 'oauth', oauthProbe: 'supported' });
  });

  it('the next probe (Check again, or the daily one) does not flip it back while the granted scopes are the same', async () => {
    await wire({ chat: UNAUTHORIZED });
    await waitFor(() => inference()?.via === 'oauth');
    await send();
    await waitFor(() => inference()?.oauthProbe === 'unsupported');
    await auth!.api.probeOAuthInference(); // /v1/models still answers 200
    expect(inference()).toMatchObject({ via: null, oauthProbe: 'unsupported' });
    expect((await authJson()).oauthInference).toMatchObject({ status: 'unsupported', rejectedForScope: sortedScopes });
    await expect(auth!.keys.getInferenceKey()).resolves.toBeNull();
  });

  it('a rejection recorded for other scopes (an older sign-in GMI granted less to) does not block the answer', async () => {
    const earlier = { status: 'unsupported', checkedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(), rejectedForScope: 'models:read' };
    await wire({ authFile: { oauthInference: earlier } });
    await waitFor(() => inference()?.oauthProbe === 'supported');
    expect(inference()?.via).toBe('oauth');
    expect((await authJson()).oauthInference).toMatchObject({ status: 'supported', rejectedForScope: null });
  });

  it('a 403 for a real key is a permission problem: the key stays valid', async () => {
    await wire({ chat: INSUFFICIENT_SCOPE });
    await auth!.api.setInferenceKey(REAL_KEY);
    const end = await send();
    expect(end.error).toMatchObject({ code: 'unauthorized', status: 403 });
    await new Promise((r) => setTimeout(r, 30));
    expect(auth!.service.getState().inferenceKey.status).toBe('valid');
    expect(inference()?.oauthProbe).toBe('supported');
  });

  it('a 401 for a real key still marks it invalid', async () => {
    await wire({ chat: UNAUTHORIZED });
    await auth!.api.setInferenceKey(REAL_KEY);
    await send();
    await waitFor(() => auth!.service.getState().inferenceKey.status === 'invalid');
    expect(inference()?.oauthProbe).toBe('supported');
  });
});
