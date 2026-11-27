import asMetadata from '@main/mock/fixtures/auth/oauth-authorization-server.json';
import prMetadata from '@main/mock/fixtures/auth/oauth-protected-resource.json';
import { silentLogger } from '@main/core/logger';
import { createSecureStore, type Cipher, type SecureStore } from '@main/core/secure-store';
import type { StoredClient, StoredTokens } from '@main/services/auth/secrets';
import { jsonResponse, type FakeRoute, type RecordedRequest } from '../helpers/fetch';

export const ISSUER = 'https://mcp.gmicloud.ai';
export const MCP_URL = 'https://mcp.gmicloud.ai/mcp';
export const TOKEN_URL = 'https://mcp.gmicloud.ai/token';
export const REGISTER_URL = 'https://mcp.gmicloud.ai/register';
export const REVOKE_URL = 'https://mcp.gmicloud.ai/revoke';
export const KEY_URL = 'https://console.gmicloud.ai/api/v1/me/api-keys/current';
export const ALL_SCOPES = 'models:read generation:read generation:write billing:read profile:read support:write';

export const exact = (url: string) => (u: string) => u === url;

/** The two public well-known documents (recorded fixtures). */
export function discoveryRoutes(): FakeRoute[] {
  return [
    { match: (u) => u.includes('/.well-known/oauth-protected-resource'), respond: () => jsonResponse(prMetadata) },
    { match: exact(`${ISSUER}/.well-known/oauth-authorization-server`), respond: () => jsonResponse(asMetadata) },
  ];
}

export function form(req: RecordedRequest): URLSearchParams {
  return new URLSearchParams(req.body ?? '');
}

export async function seedClient(secure: SecureStore, overrides: Partial<StoredClient> = {}): Promise<StoredClient> {
  const client: StoredClient = {
    client_id: 'client-seeded',
    redirect_uri: 'http://127.0.0.1:43123/callback',
    redirect_port: 43123,
    issuer: ISSUER,
    scope: ALL_SCOPES,
    registered_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
  await secure.set('oauth.client', JSON.stringify(client));
  return client;
}

export async function seedTokens(secure: SecureStore, overrides: Partial<StoredTokens> = {}): Promise<StoredTokens> {
  const tokens: StoredTokens = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 3_600_000,
    scope: ALL_SCOPES,
    token_type: 'Bearer',
    ...overrides,
  };
  await secure.set('oauth.tokens', JSON.stringify(tokens));
  return tokens;
}

export function tokenResponse(access: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ access_token: access, token_type: 'Bearer', expires_in: 3600, scope: ALL_SCOPES, ...extra });
}

export async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export type ToolHandler = (args: Record<string, unknown>) => unknown;

/**
 * A minimal Streamable HTTP MCP server (JSON responses) for the fake fetch: initialize, the
 * initialized notification, tools/call (handlers may be async). Rejects tokens not in `validTokens`
 * with 401 and unknown session ids with 404 (see `forgetSessions`).
 */
export function fakeMcpServer(opts: { validTokens: Set<string>; tools: Record<string, ToolHandler> }) {
  let sessions = 0;
  const live = new Set<string>();
  const log: Array<{ method: string; token: string | null; session: string | null }> = [];
  const route: FakeRoute = {
    match: exact(MCP_URL),
    respond: async (req) => {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (req.method === 'GET') return new Response(null, { status: 405 });
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      const msg = JSON.parse(req.body ?? '{}') as { id?: number; method: string; params?: Record<string, unknown> };
      log.push({ method: msg.method, token, session: req.headers['mcp-session-id'] ?? null });
      if (!token || !opts.validTokens.has(token)) {
        return new Response(JSON.stringify({ error: 'invalid_token' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' },
        });
      }
      if (msg.method === 'initialize') {
        sessions += 1;
        const id = `session-${sessions}`;
        live.add(id);
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-gmi', version: '1.0.0' },
            },
          },
          200,
          { 'mcp-session-id': id },
        );
      }
      const session = req.headers['mcp-session-id'] ?? null;
      if (session !== null && !live.has(session)) return new Response('Session not found', { status: 404 });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      if (msg.method === 'tools/call') {
        const name = String(msg.params?.name);
        const handler = opts.tools[name];
        const result = handler
          ? await handler((msg.params?.arguments as Record<string, unknown>) ?? {})
          : { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
        return jsonResponse({ jsonrpc: '2.0', id: msg.id, result });
      }
      return jsonResponse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    },
  };
  return {
    route,
    log,
    sessions: () => sessions,
    /** Simulates GMI dropping every MCP session (e.g. a server restart): old session ids get 404. */
    forgetSessions: () => live.clear(),
  };
}

/** Tool result helpers. */
export const textResult = (value: unknown) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
export const errorResult = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true });

/**
 * A real file-backed SecureStore over a fake OS cipher that can be "locked" like a keyring: while locked, every
 * decrypt fails (as safeStorage does with a locked or different keyring) but the files stay on disk.
 */
export async function lockableSecureStore(dir: string) {
  const state = { locked: false, decrypts: 0 };
  const cipher: Cipher = {
    isAvailable: async () => true,
    backend: () => 'os',
    encrypt: async (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decrypt: async (data) => {
      state.decrypts += 1;
      if (state.locked) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      const text = data.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this cipher');
      return { value: Buffer.from(text.slice(4), 'base64').toString('utf8'), shouldReEncrypt: false };
    },
  };
  const secure: SecureStore = await createSecureStore(dir, cipher, silentLogger);
  return {
    secure,
    state,
    lock: () => {
      state.locked = true;
    },
    unlock: () => {
      state.locked = false;
    },
  };
}
