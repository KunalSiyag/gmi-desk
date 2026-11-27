import { afterEach, describe, expect, it } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { USER_AGENT } from '@shared/app';
import type { AuthState } from '@shared/contracts/auth';
import { GmiError } from '@shared/contracts/errors';
import type { FetchLike } from '@main/core/http';
import { silentLogger } from '@main/core/logger';
import { createAuthSliceWith, type AuthSlice } from '@main/services/auth';
import { createMcpGateway, httpStatusOf, mcpErrorToGmiError, parseToolResult, toolErrorToGmiError } from '@main/services/auth/mcp-gateway';
import { createFakeFetch, jsonResponse } from '../helpers/fetch';
import { createTestContext, type TestContext } from '../helpers/context';
import {
  ALL_SCOPES,
  discoveryRoutes,
  errorResult,
  exact,
  fakeMcpServer,
  form,
  MCP_URL,
  REVOKE_URL,
  seedClient,
  seedTokens,
  textResult,
  TOKEN_URL,
  tokenResponse,
  waitFor,
  type ToolHandler,
} from './helpers';

describe('MCP tool results', () => {
  it('prefers structuredContent, then JSON text, then plain text', () => {
    expect(parseToolResult({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 1 });
    expect(parseToolResult({ content: [{ type: 'image', data: 'x' }, { type: 'text', text: '{"models":[1,2]}' }] })).toEqual({ models: [1, 2] });
    expect(parseToolResult({ content: [{ type: 'text', text: 'plain answer' }] })).toBe('plain answer');
    expect(parseToolResult({ content: [] })).toBeNull();
    expect(parseToolResult({ toolResult: { legacy: true } })).toEqual({ legacy: true });
  });

  it('throws mapped errors for isError results', () => {
    expect(() => parseToolResult(errorResult('days must be between 1 and 90, got 0'))).toThrowError(
      expect.objectContaining({ code: 'invalid_input', message: 'days must be between 1 and 90, got 0' }),
    );
    expect(() => parseToolResult({ isError: true, structuredContent: { error: 'upstream_unavailable: try later' } })).toThrowError(
      expect.objectContaining({ code: 'upstream' }),
    );
  });

  it('maps GMI tool error messages to error codes', () => {
    const scope = toolErrorToGmiError('insufficient scope: this tool requires generation:write');
    expect(scope.code).toBe('insufficient_scope');
    expect(scope.message).toContain('generation:write');
    expect(toolErrorToGmiError('Insufficient_scope').message).toMatch(/missing a permission/);
    expect(toolErrorToGmiError('missing required scope billing:read and support:write').message).toContain('billing:read, support:write');
    expect(toolErrorToGmiError('this token is no longer valid for its organization').code).toBe('reauth_required');
    expect(toolErrorToGmiError('upstream_unavailable').code).toBe('upstream');
    expect(toolErrorToGmiError('The video service is currently unavailable').code).toBe('upstream');
    expect(toolErrorToGmiError('rate limit exceeded for this organization').code).toBe('rate_limited');
    expect(toolErrorToGmiError('Too Many Requests').code).toBe('rate_limited');
    const other = toolErrorToGmiError('no model with id "x"; call search_models to list available ids');
    expect(other).toMatchObject({ code: 'invalid_input', message: 'no model with id "x"; call search_models to list available ids' });
  });

  it('maps transport and protocol failures', () => {
    expect(httpStatusOf(new StreamableHTTPError(401, 'Error POSTing to endpoint: nope'))).toBe(401);
    expect(mcpErrorToGmiError(new StreamableHTTPError(401, 'x')).code).toBe('reauth_required');
    expect(mcpErrorToGmiError(new StreamableHTTPError(403, 'Error POSTing to endpoint: error code: 1010')).message).toContain('Cloudflare');
    expect(mcpErrorToGmiError(new StreamableHTTPError(403, '{"error":"insufficient_scope"}')).code).toBe('insufficient_scope');
    expect(mcpErrorToGmiError(new StreamableHTTPError(429, 'slow')).code).toBe('rate_limited');
    expect(mcpErrorToGmiError(new StreamableHTTPError(503, 'down')).code).toBe('upstream');
    expect(mcpErrorToGmiError(new McpError(ErrorCode.RequestTimeout, 'Request timed out')).code).toBe('timeout');
    expect(mcpErrorToGmiError(new McpError(ErrorCode.ConnectionClosed, 'Connection closed')).code).toBe('network');
    expect(mcpErrorToGmiError(new McpError(ErrorCode.InvalidParams, 'bad days'))).toMatchObject({ code: 'invalid_input', message: 'bad days' });
    expect(mcpErrorToGmiError(new McpError(ErrorCode.InternalError, 'boom')).code).toBe('upstream');
    const aborted = new AbortController();
    aborted.abort();
    expect(mcpErrorToGmiError(new McpError(ErrorCode.RequestTimeout, 'AbortError'), aborted.signal).code).toBe('cancelled');
    expect(mcpErrorToGmiError(new GmiError('network', 'x')).code).toBe('network');
  });
});

describe('MCP gateway', () => {
  let t: TestContext;
  let slice: AuthSlice | null = null;

  afterEach(async () => {
    await slice?.dispose();
    slice = null;
    await t?.cleanup();
  });

  async function setup(opts: { validTokens: string[]; tools: Record<string, ToolHandler>; token?: (n: number) => Response; seed?: boolean; expiresInMs?: number }) {
    const server = fakeMcpServer({ validTokens: new Set(opts.validTokens), tools: opts.tools });
    let tokenCalls = 0;
    const fake = createFakeFetch([
      ...discoveryRoutes(),
      server.route,
      {
        match: exact(TOKEN_URL),
        method: 'POST',
        respond: () => {
          tokenCalls += 1;
          return opts.token ? opts.token(tokenCalls) : tokenResponse(`access-${tokenCalls + 1}`, { refresh_token: `refresh-${tokenCalls + 1}` });
        },
      },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    if (opts.seed !== false) {
      await seedClient(t.ctx.secure);
      await seedTokens(t.ctx.secure, { expires_at: Date.now() + (opts.expiresInMs ?? 3_600_000) });
    }
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, learnOrgOnStart: false, envKey: null });
    return { slice, fake, server, tokenCalls: () => tokenCalls };
  }

  const lastAuth = () => t.emitted.filter((e) => e.name === 'auth:changed').at(-1)?.payload as AuthState | undefined;

  it('calls tools with the bearer token and the User-Agent over one shared session', async () => {
    const { slice, fake, server } = await setup({
      validTokens: ['access-1'],
      tools: {
        search_models: (args) => ({ structuredContent: { models: [{ id: 'm1' }], query: args.query } }),
        get_account_summary: () => textResult({ org_id: 'org-1', balance_usd: '1.00' }),
      },
    });
    await expect(slice.mcp.callTool('search_models', { query: 'glm' })).resolves.toEqual({ models: [{ id: 'm1' }], query: 'glm' });
    await expect(slice.mcp.callTool('get_account_summary', { days: 1 })).resolves.toMatchObject({ org_id: 'org-1' });
    expect(server.sessions()).toBe(1);
    expect(server.log.map((l) => l.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
    expect(server.log.every((l) => l.token === 'access-1')).toBe(true);
    expect(server.log.at(-1)?.session).toBe('session-1');
    const mcpRequests = fake.requests.filter((r) => r.url === 'https://mcp.gmicloud.ai/mcp');
    expect(mcpRequests.every((r) => r.headers['user-agent'] === USER_AGENT)).toBe(true);
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const { slice, fake, server, tokenCalls } = await setup({
      validTokens: ['access-2'],
      tools: { search_models: () => textResult({ ok: true }) },
    });
    await expect(slice.mcp.callTool('search_models', {})).resolves.toEqual({ ok: true });
    expect(tokenCalls()).toBe(1);
    const refresh = form(fake.requests.find((r) => r.url === TOKEN_URL)!);
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('refresh_token')).toBe('refresh-1');
    expect(refresh.get('client_id')).toBe('client-seeded');
    expect(refresh.get('resource')).toBe('https://mcp.gmicloud.ai/mcp');
    expect(server.log.filter((l) => l.token === 'access-2').map((l) => l.method)).toContain('tools/call');
    const stored = JSON.parse((await t.ctx.secure.get('oauth.tokens'))!) as { access_token: string; refresh_token: string };
    expect(stored).toMatchObject({ access_token: 'access-2', refresh_token: 'refresh-2' });
    expect(slice.service.getState().status).toBe('signed_in');
  });

  it('ends the session when GMI still answers 401 after a refresh', async () => {
    const { slice, tokenCalls } = await setup({ validTokens: [], tools: {} });
    await expect(slice.mcp.callTool('search_models', {})).rejects.toMatchObject({ code: 'reauth_required' });
    expect(tokenCalls()).toBe(1);
    expect(slice.service.getState().status).toBe('reauth_required');
    expect(slice.service.isSignedIn()).toBe(false);
    expect(lastAuth()?.status).toBe('reauth_required');
    expect(await t.ctx.secure.get('oauth.tokens')).toBeNull();
    expect(await t.ctx.secure.get('oauth.client')).not.toBeNull(); // registration kept
    await expect(slice.mcp.callTool('search_models', {})).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('marks reauth_required when the refresh token is rejected (invalid_grant), keeping the registration', async () => {
    const { slice } = await setup({
      validTokens: ['access-1'],
      tools: { search_models: () => textResult({}) },
      expiresInMs: 20_000, // proactive refresh
      token: () => jsonResponse({ error: 'invalid_grant', error_description: 'revoked' }, 400),
    });
    await expect(slice.mcp.callTool('search_models', {})).rejects.toMatchObject({ code: 'reauth_required' });
    const state = slice.service.getState();
    expect(state.status).toBe('reauth_required');
    expect(state.lastError).toMatch(/expired/i);
    expect(await t.ctx.secure.get('oauth.client')).not.toBeNull();
    // survives a restart
    const again = await createAuthSliceWith(t.ctx, { fetch: createFakeFetch().fetch, learnOrgOnStart: false, envKey: null });
    expect(again.service.getState().status).toBe('reauth_required');
    await again.dispose();
  });

  it('keeps the session and sets lastError when the refresh hits a network error', async () => {
    const server = fakeMcpServer({ validTokens: new Set(['access-1']), tools: {} });
    const fake = createFakeFetch([...discoveryRoutes(), server.route]);
    fake.route({
      match: exact(TOKEN_URL),
      respond: () => {
        throw new TypeError('fetch failed');
      },
    });
    t = await createTestContext({ fetch: fake.fetch });
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure, { expires_at: Date.now() - 1_000 });
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, learnOrgOnStart: false, envKey: null });
    await expect(slice.mcp.callTool('search_models', {})).rejects.toMatchObject({ code: 'network' });
    const state = slice.service.getState();
    expect(state.status).toBe('signed_in');
    expect(state.lastError).toMatch(/reach GMI/);
    expect(await t.ctx.secure.get('oauth.tokens')).not.toBeNull();
  });

  it('maps tool errors and ends the session when GMI says the token no longer fits its organization', async () => {
    const { slice } = await setup({
      validTokens: ['access-1'],
      tools: {
        submit_generation: () => errorResult('insufficient scope: requires generation:write'),
        get_model: () => errorResult('no model with id "nope"'),
        list_generations: () => errorResult('this token is no longer valid for its organization'),
      },
    });
    await expect(slice.mcp.callTool('submit_generation', {})).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(slice.mcp.callTool('get_model', { model_id: 'nope' })).rejects.toMatchObject({ code: 'invalid_input', message: 'no model with id "nope"' });
    expect(slice.service.getState().status).toBe('signed_in');
    await expect(slice.mcp.callTool('list_generations', {})).rejects.toMatchObject({ code: 'reauth_required' });
    expect(slice.service.getState().status).toBe('reauth_required');
  });

  it('refuses calls without a session, and honours abort signals', async () => {
    const { slice } = await setup({ validTokens: ['access-1'], tools: { search_models: () => textResult({}) }, seed: false });
    await expect(slice.mcp.callTool('search_models', {})).rejects.toMatchObject({ code: 'not_signed_in' });
    const controller = new AbortController();
    controller.abort();
    await expect(slice.mcp.callTool('search_models', {}, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('lets a call already running finish when a token refresh moves later calls to a new connection', async () => {
    let clock = Date.parse('2026-10-31T12:00:00Z');
    let releaseSlow!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const server = fakeMcpServer({
      validTokens: new Set(['access-1', 'access-2']),
      tools: {
        get_generation: async () => {
          await gate;
          return textResult({ status: 'success' });
        },
        search_models: () => textResult({ ok: true }),
      },
    });
    const fake = createFakeFetch([
      ...discoveryRoutes(),
      server.route,
      { match: exact(TOKEN_URL), method: 'POST', respond: () => tokenResponse('access-2', { refresh_token: 'refresh-2' }) },
    ]);
    t = await createTestContext({ fetch: fake.fetch, now: () => new Date(clock) });
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure, { expires_at: clock + 5 * 60_000 });
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, learnOrgOnStart: false, envKey: null });

    const slow = slice.mcp.callTool('get_generation', { request_id: 'r-1' });
    await waitFor(() => server.log.some((l) => l.method === 'tools/call'));
    clock += 4.5 * 60_000; // under 60 s left: the next call refreshes and connects with the new token
    await expect(slice.mcp.callTool('search_models', {})).resolves.toEqual({ ok: true });
    releaseSlow();
    await expect(slow).resolves.toEqual({ status: 'success' });
    expect(server.sessions()).toBe(2);
    expect(server.log.filter((l) => l.method === 'tools/call').map((l) => l.token)).toEqual(['access-1', 'access-2']);
    // The retired connection is not reused.
    await expect(slice.mcp.callTool('search_models', {})).resolves.toEqual({ ok: true });
    expect(server.sessions()).toBe(2);
  });

  it('starts a new MCP session once when GMI forgets the current one (404)', async () => {
    const { slice, server } = await setup({ validTokens: ['access-1'], tools: { search_models: () => textResult({ n: 1 }) } });
    await expect(slice.mcp.callTool('search_models', {})).resolves.toEqual({ n: 1 });
    server.forgetSessions();
    await expect(slice.mcp.callTool('search_models', {})).resolves.toEqual({ n: 1 });
    expect(server.sessions()).toBe(2);
    expect(slice.service.getState().status).toBe('signed_in');
  });

  it('reports not_signed_in (not "connection closed") for a call cut off by signing out', async () => {
    let releaseSlow!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const { slice, server } = await setup({
      validTokens: ['access-1'],
      tools: {
        get_generation: async () => {
          await gate;
          return textResult({ status: 'success' });
        },
      },
    });
    const pending = slice.mcp.callTool('get_generation', { request_id: 'r-1' });
    await waitFor(() => server.log.some((l) => l.method === 'tools/call'));
    await slice.api.signOut();
    releaseSlow();
    await expect(pending).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('retries the organization lookup after a transient failure', async () => {
    let calls = 0;
    const server = fakeMcpServer({
      validTokens: new Set(['access-1']),
      tools: {
        get_account_summary: () => {
          calls += 1;
          return calls === 1 ? errorResult('upstream_unavailable: billing is busy') : textResult({ org_id: 'org-retried' });
        },
      },
    });
    const fake = createFakeFetch([...discoveryRoutes(), server.route]);
    t = await createTestContext({ fetch: fake.fetch });
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure);
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, orgRetryDelaysMs: [20, 20] });
    expect(slice.service.getState()).toMatchObject({ orgId: null, orgIdPending: true });
    await waitFor(() => lastAuth()?.orgId === 'org-retried');
    expect(calls).toBe(2);
    expect(lastAuth()?.orgIdPending).toBe(false);
  });

  it('does not retry the organization lookup when GMI refuses it', async () => {
    let calls = 0;
    const server = fakeMcpServer({
      validTokens: new Set(['access-1']),
      tools: {
        get_account_summary: () => {
          calls += 1;
          return errorResult('insufficient scope: requires billing:read');
        },
      },
    });
    const fake = createFakeFetch([...discoveryRoutes(), server.route]);
    t = await createTestContext({ fetch: fake.fetch });
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure);
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, orgRetryDelaysMs: [10, 10] });
    await waitFor(() => slice?.service.getState().orgIdPending === false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(1);
    expect(slice.service.getState()).toMatchObject({ status: 'signed_in', orgId: null, orgIdPending: false });
  });

  it('learns the organization id after startup', async () => {
    const server = fakeMcpServer({
      validTokens: new Set(['access-1']),
      tools: { get_account_summary: (args) => textResult({ org_id: 'org-learned', days: args.days }) },
    });
    const fake = createFakeFetch([...discoveryRoutes(), server.route]);
    t = await createTestContext({ fetch: fake.fetch });
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure);
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null });
    expect(slice.service.getState()).toMatchObject({ orgId: null, orgIdPending: true });
    // The lookup ends with one emit carrying the org id (auth.json is written first).
    await waitFor(() => lastAuth()?.orgIdPending === false);
    expect(lastAuth()).toMatchObject({ orgId: 'org-learned', orgIdPending: false });
    expect(slice.service.getState()).toMatchObject({ orgId: 'org-learned', orgIdPending: false });
    expect(slice.service.getState().scopes.join(' ')).toBe(ALL_SCOPES);
  });
});

describe('closing while GMI never answers the MCP handshake', () => {
  let t: TestContext | null = null;
  let slice: AuthSlice | null = null;
  afterEach(async () => {
    await slice?.dispose();
    slice = null;
    await t?.cleanup();
    t = null;
  });

  it('reset() aborts the pending connect instead of waiting for the connect timeout, and its call fails at once', async () => {
    let aborts = 0;
    // Accepts the request, never answers `initialize`; honours the abort signal like real fetch.
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborts += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const gw = createMcpGateway({
      url: MCP_URL,
      fetch: hanging,
      log: silentLogger,
      tokens: { getAccessToken: async () => 'access-1', forceRefresh: async () => 'access-1' },
      assertSession: () => undefined,
      onReauthRequired: () => undefined,
      connectTimeoutMs: 30_000,
    });
    let settledAt = 0;
    const call = gw.callTool('get_account_summary', {}).then(
      () => 'resolved',
      (error: unknown) => {
        settledAt = Date.now();
        return (error as GmiError).code;
      },
    );
    await new Promise((r) => setTimeout(r, 50)); // the initialize POST is in flight
    const started = Date.now();
    await gw.reset();
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(call).resolves.toBe('network');
    expect(settledAt - started).toBeLessThan(1_000);
    expect(aborts).toBe(1);
  });

  it('sign-out is immediate even when the MCP endpoint hangs (and ignores aborts)', async () => {
    const fake = createFakeFetch([
      ...discoveryRoutes(),
      { match: exact(MCP_URL), respond: () => new Promise<Response>(() => undefined) },
      { match: exact(REVOKE_URL), method: 'POST', respond: () => new Response(null, { status: 200 }) },
    ]);
    t = await createTestContext({ fetch: fake.fetch });
    await seedClient(t.ctx.secure);
    await seedTokens(t.ctx.secure);
    slice = await createAuthSliceWith(t.ctx, { fetch: fake.fetch, envKey: null, learnOrgOnStart: false });
    const pending = slice.mcp.callTool('get_account_summary', {}).catch((error: unknown) => (error as GmiError).code);
    await waitFor(() => fake.requests.some((r) => r.url === MCP_URL));
    const started = Date.now();
    await expect(slice.api.signOut()).resolves.toMatchObject({ status: 'signed_out' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slice.service.getState().status).toBe('signed_out');
    await expect(pending).resolves.toBe('not_signed_in');
    expect(fake.requests.filter((r) => r.url === REVOKE_URL)).toHaveLength(2);
  });
});
