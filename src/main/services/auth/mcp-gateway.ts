/**
 * McpGateway over GMI's MCP server (Streamable HTTP) with the user's OAuth access token.
 * One shared, lazily connected client per access token. A token refresh or a transport failure retires
 * the connection (calls already running on it finish first) and the next call reconnects.
 * A 401 triggers one refresh + retry; a second 401 ends the session (reauth_required).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { APP_NAME, APP_VERSION } from '@shared/app';
import { GMI_SCOPES } from '@shared/contracts/auth';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { FetchLike } from '../../core/http';
import type { Logger } from '../../core/logger';
import type { GmiToolName, McpCallOptions, McpGateway } from '../../core/services';
import { MCP_DEFAULT_TIMEOUT_MS } from './constants';
import { raceAbort } from './fetch';

interface ToolContentBlock {
  type?: unknown;
  text?: unknown;
}

interface ToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
  toolResult?: unknown;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content as ToolContentBlock[]) {
    if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  }
  return null;
}

/** Maps an `isError` tool result message to a GmiError. */
export function toolErrorToGmiError(message: string): GmiError {
  const text = message.trim().slice(0, 1_000) || 'GMI could not complete the request.';
  if (/insufficient[_\s-]?scope|missing (?:the )?(?:required )?(?:oauth )?scopes?\b|requires? (?:the )?(?:oauth )?scopes?\b/i.test(text)) {
    const missing = GMI_SCOPES.filter((scope) => text.includes(scope));
    const list = missing.length ? missing.join(', ') : null;
    return new GmiError(
      'insufficient_scope',
      list
        ? `Your GMI sign-in is missing the ${missing.length > 1 ? 'permissions' : 'permission'} ${list}. Reconnect to grant ${missing.length > 1 ? 'them' : 'it'}.`
        : 'Your GMI sign-in is missing a permission this needs. Reconnect to grant it.',
      { detail: text },
    );
  }
  if (/no longer valid for its organi[sz]ation/i.test(text)) {
    return new GmiError('reauth_required', 'Your GMI sign-in is no longer valid for its organization. Sign in again.', { detail: text });
  }
  if (/upstream_unavailable|currently unavailable/i.test(text)) return new GmiError('upstream', text);
  if (/rate[\s_-]?limit|too many requests/i.test(text)) return new GmiError('rate_limited', text);
  return new GmiError('invalid_input', text);
}

/**
 * The tool's JSON result: structuredContent first, else the first text block parsed as JSON,
 * else that text as-is. `isError` results throw (see toolErrorToGmiError).
 */
export function parseToolResult<T = unknown>(result: unknown): T {
  const r = (result && typeof result === 'object' ? result : {}) as ToolResultLike;
  if (r.isError === true) {
    const text = firstText(r.content);
    const structured = r.structuredContent && typeof r.structuredContent === 'object' ? (r.structuredContent as Record<string, unknown>) : null;
    const fallback = structured && typeof structured.error === 'string' ? structured.error : structured && typeof structured.message === 'string' ? structured.message : '';
    throw toolErrorToGmiError(text ?? fallback);
  }
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent as T;
  const text = firstText(r.content);
  if (text !== null) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
  if ('toolResult' in r) return r.toolResult as T;
  return null as T;
}

/** HTTP status behind a transport error (StreamableHTTPError carries it as `code`). */
export function httpStatusOf(error: unknown): number | null {
  if (error instanceof StreamableHTTPError) return typeof error.code === 'number' && error.code > 0 ? error.code : null;
  if (error instanceof Error && /^Streamable HTTP error: /.test(error.message)) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' && code > 0 ? code : null;
  }
  return null;
}

function stripMcpPrefix(message: string): string {
  return message.replace(/^MCP error -?\d+:\s*/, '').replace(/^Streamable HTTP error:\s*/, '').trim();
}

/** Maps transport / protocol failures to GmiError (tool `isError` results are handled by parseToolResult). */
export function mcpErrorToGmiError(error: unknown, signal?: AbortSignal): GmiError {
  if (error instanceof GmiError) return error;
  if (signal?.aborted) return new GmiError('cancelled', 'The request was cancelled.', { cause: error });
  const status = httpStatusOf(error);
  if (status !== null) {
    const message = error instanceof Error ? stripMcpPrefix(error.message) : '';
    if (status === 401) return new GmiError('reauth_required', 'Your GMI sign-in expired. Sign in again.', { status, cause: error });
    if (status === 403) {
      if (/insufficient_scope/i.test(message)) return toolErrorToGmiError(message);
      if (/error code: 1010|cloudflare/i.test(message)) return new GmiError('unauthorized', 'GMI blocked this request (Cloudflare).', { status, cause: error });
      return new GmiError('unauthorized', 'GMI refused the request.', { status, detail: message || null, cause: error });
    }
    if (status === 429) return new GmiError('rate_limited', 'GMI is rate-limiting this organization. Try again shortly.', { status, cause: error });
    if (status === 400 || status === 422) return new GmiError('invalid_input', message || 'GMI rejected the request.', { status, cause: error });
    if (status === 404) return new GmiError('upstream', 'GMI could not find the MCP session. Try again.', { status, cause: error });
    return new GmiError('upstream', 'GMI had a problem handling this request. Try again.', { status, detail: message || null, cause: error });
  }
  if (error instanceof McpError) {
    const message = stripMcpPrefix(error.message);
    switch (error.code) {
      case ErrorCode.RequestTimeout:
        return new GmiError('timeout', 'GMI took too long to answer.', { cause: error });
      case ErrorCode.ConnectionClosed:
        return new GmiError('network', 'The connection to GMI closed unexpectedly.', { cause: error });
      case ErrorCode.InvalidParams:
      case ErrorCode.InvalidRequest:
        return new GmiError('invalid_input', message || 'GMI rejected the request.', { cause: error });
      case ErrorCode.MethodNotFound:
        return new GmiError('not_implemented', message || 'GMI does not offer this tool.', { cause: error });
      default:
        return new GmiError('upstream', message || 'GMI had a problem handling this request.', { cause: error });
    }
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new GmiError('cancelled', 'The request was cancelled.', { cause: error });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return new GmiError('upstream', 'GMI returned a response the app could not read.', { cause: error });
  }
  return toGmiError(error);
}

/** A JSON-RPC error answered by the server leaves the MCP session usable. */
function answeredByServer(error: unknown): boolean {
  return error instanceof McpError && error.code !== ErrorCode.ConnectionClosed && error.code !== ErrorCode.RequestTimeout;
}

/**
 * GMI no longer knows the MCP session (404 per the spec; some servers answer 400 "...session...").
 * The request was refused before the tool ran, so starting a new session and retrying is safe.
 */
export function isSessionLost(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status === 404) return true;
  return status === 400 && error instanceof Error && /session/i.test(error.message);
}

export interface McpGatewayDeps {
  url: string;
  /** Fetch with the User-Agent already applied (see createWrappedFetch). */
  fetch: FetchLike;
  log: Logger;
  tokens: {
    getAccessToken(): Promise<string>;
    forceRefresh(staleAccessToken: string): Promise<string>;
  };
  /** Throws not_signed_in / reauth_required when there is no usable session. */
  assertSession(): void;
  /** The grant is dead (second 401, or GMI says the token no longer fits its organization). */
  onReauthRequired(reason: string): void | Promise<void>;
  connectTimeoutMs?: number;
}

export interface McpGatewayHandle extends McpGateway {
  /**
   * Closes every connection now (sign-out, dead grant, quit), including one still connecting: its in-flight
   * requests are aborted and the calls waiting on it fail at once. The next call reconnects.
   */
  reset(): Promise<void>;
}

/** One MCP session opened with one access token. */
interface Connection {
  token: string;
  /** Created with the connection, so closing it also aborts a connect that is still in progress. */
  client: Client;
  ready: Promise<Client>;
  /** Calls currently running on this connection. */
  active: number;
  /** Takes no new calls; closed as soon as the last running call finishes. */
  retired: boolean;
  closing: Promise<void> | null;
}

const cancelled = (cause?: unknown) => new GmiError('cancelled', 'The request was cancelled.', cause === undefined ? {} : { cause });

export function createMcpGateway(deps: McpGatewayDeps): McpGatewayHandle {
  const log = deps.log.child('mcp');
  let current: Connection | null = null;
  /** Connections not closed yet (the current one and retired ones still finishing calls). */
  const live = new Set<Connection>();

  /**
   * Closes the transport right away, never waiting for a pending connect: closing aborts the in-flight
   * `initialize` POST and rejects it (ConnectionClosed) instead of sitting out the connect timeout.
   */
  function close(conn: Connection): Promise<void> {
    live.delete(conn);
    conn.closing ??= conn.client.close().catch(() => undefined);
    return conn.closing;
  }

  function retire(conn: Connection): void {
    conn.retired = true;
    if (current === conn) current = null;
    if (conn.active === 0) void close(conn);
  }

  function release(conn: Connection): void {
    conn.active -= 1;
    if (conn.retired && conn.active === 0) void close(conn);
  }

  async function connect(conn: Connection, transport: StreamableHTTPClientTransport): Promise<Client> {
    const { client } = conn;
    try {
      await client.connect(transport, { timeout: deps.connectTimeoutMs ?? 30_000 });
    } catch (error) {
      void client.close().catch(() => undefined);
      throw error;
    }
    // Closed while the handshake was finishing (sign-out): do not hand out a connection nobody may use.
    if (conn.closing) {
      void client.close().catch(() => undefined);
      throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
    }
    return client;
  }

  function open(token: string): Connection {
    const transport = new StreamableHTTPClientTransport(new URL(deps.url), {
      fetch: deps.fetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: APP_NAME, version: APP_VERSION }, { capabilities: {} });
    const conn: Connection = { token, client, ready: Promise.resolve(client), active: 0, retired: false, closing: null };
    client.onerror = (error) => log.debug('transport error', { message: error instanceof Error ? error.message : String(error) });
    // Closed by the transport or by us, or failed to connect: never hand this connection out again.
    client.onclose = () => retire(conn);
    live.add(conn);
    conn.ready = connect(conn, transport);
    conn.ready.catch(() => retire(conn));
    return conn;
  }

  /** The live connection for `token`, opening one (and retiring the previous) when needed. */
  function acquire(token: string): Connection {
    if (current && current.token === token && !current.retired) return current;
    if (current) retire(current);
    current = open(token);
    return current;
  }

  async function reset(): Promise<void> {
    current = null;
    const conns = [...live];
    for (const conn of conns) conn.retired = true;
    await Promise.all(conns.map((conn) => close(conn)));
  }

  return {
    reset,
    async callTool<T = unknown>(name: GmiToolName, args: Record<string, unknown> = {}, opts: McpCallOptions = {}): Promise<T> {
      const { signal } = opts;
      const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
      if (signal?.aborted) throw cancelled();
      deps.assertSession();
      let token = await raceAbort(deps.tokens.getAccessToken(), signal);
      let refreshed = false;
      let sessionRetried = false;
      let result: unknown;
      for (;;) {
        const conn = acquire(token);
        conn.active += 1;
        let connected = false;
        try {
          const client = await raceAbort(conn.ready, signal);
          connected = true;
          result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs });
          break;
        } catch (error) {
          if (signal?.aborted) throw cancelled(error);
          // Signed out (or the grant died) while this call ran: say that, not "connection closed".
          deps.assertSession();
          if (httpStatusOf(error) === 401) {
            retire(conn);
            if (!refreshed) {
              refreshed = true;
              token = await deps.tokens.forceRefresh(token);
              continue;
            }
            const err = new GmiError('reauth_required', 'Your GMI sign-in expired. Sign in again.', { status: 401 });
            await deps.onReauthRequired(err.message);
            throw err;
          }
          if (connected && !sessionRetried && isSessionLost(error)) {
            sessionRetried = true;
            retire(conn);
            continue;
          }
          // Anything but a JSON-RPC error answered by GMI (HTTP error, network, closed stream, timeout)
          // means this connection is not trusted again; calls still running on it may finish.
          if (!answeredByServer(error)) retire(conn);
          throw mcpErrorToGmiError(error, signal);
        } finally {
          release(conn);
        }
      }
      try {
        return parseToolResult<T>(result);
      } catch (error) {
        const err = toGmiError(error);
        if (err.code === 'reauth_required') {
          await reset();
          await deps.onReauthRequired(err.message);
        }
        throw err;
      }
    },
  };
}
