/**
 * RFC 8252 loopback redirect for the OAuth sign-in: a one-shot HTTP server on 127.0.0.1 that waits for
 * GET /callback, checks `state` (and `iss`, RFC 9207), and answers the browser with a tiny local page.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GmiError } from '@shared/contracts/errors';
import { SIGN_IN_TIMEOUT_MS } from './constants';
import { authorizationErrorToGmiError, sameIssuer } from './oauth';

export const CALLBACK_PATH = '/callback';
const LOOPBACK_HOST = '127.0.0.1';

export type CallbackOutcome = { ok: true } | { ok: false; message: string };

export interface LoopbackOptions {
  /** The `state` sent in the authorization request. */
  expectedState: string;
  /** When the callback carries `iss`, it must equal this issuer (mix-up defence). */
  issuer: string | null;
  /** Port to try first (the one saved with the client registration). Falls back to any free port. */
  preferredPort?: number | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  appName: string;
  /** How long the browser's request is held open for finish() before a neutral page is sent. */
  holdMs?: number;
}

export interface LoopbackServer {
  readonly port: number;
  readonly redirectUri: string;
  /** Resolves with the authorization code of the first callback whose state matches. Rejects on an error
   *  response, an issuer mismatch, the timeout or cancellation. */
  readonly code: Promise<string>;
  /** Answers the held browser request (success or failure page) and shuts the server down. */
  finish(outcome: CallbackOutcome): Promise<void>;
  /** Shuts down (idempotent). A pending `code` rejects with `cancelled`. */
  close(): Promise<void>;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Self-contained page shown in the browser after the redirect (no external assets). */
export function renderCallbackPage(kind: 'success' | 'error' | 'pending', appName: string, message?: string): string {
  const app = escapeHtml(appName);
  const title = kind === 'success' ? 'Signed in to GMI.' : kind === 'pending' ? 'Almost done.' : 'Sign-in failed.';
  const body =
    kind === 'success'
      ? `You can close this tab and return to ${app}.`
      : kind === 'pending'
        ? `Return to ${app} to finish signing in.`
        : `${escapeHtml(message ?? 'Something went wrong.')} Return to ${app} and try again.`;
  const icon =
    kind === 'error'
      ? '<path d="M12 8v5m0 3h.01" /><circle cx="12" cy="12" r="9" />'
      : '<path d="m8 12.5 2.5 2.5L16 9.5" /><circle cx="12" cy="12" r="9" />';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(title.replace(/\.$/, ''))} · ${app}</title>
<style>
  :root { color-scheme: light dark; --bg: #fcfcfd; --fg: #18181b; --muted: #71717a; --border: #e4e4e7; --card: #fff; --accent: ${kind === 'error' ? '#dc2626' : '#4f46e5'}; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --fg: #fafafa; --muted: #a1a1aa; --border: rgba(255,255,255,.1); --card: #111; --accent: ${kind === 'error' ? '#f87171' : '#818cf8'}; } }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: min(26rem, calc(100vw - 2rem)); padding: 28px 28px 24px; border: 1px solid var(--border); border-radius: 12px; background: var(--card); text-align: center; }
  svg { width: 36px; height: 36px; stroke: var(--accent); fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
  h1 { margin: 12px 0 4px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); font-size: 13px; }
  footer { margin-top: 18px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<main>
<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
<h1>${escapeHtml(title)}</h1>
<p>${body}</p>
<footer>${app}</footer>
</main>
</body>
</html>`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function writeResponse(res: ServerResponse, status: number, contentType: string, body: string, extra: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve) => {
    if (res.writableEnded || res.destroyed) {
      resolve();
      return;
    }
    res.writeHead(status, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Connection: 'close',
      ...extra,
    });
    res.end(body, () => resolve());
  });
}

async function listenOn(server: ReturnType<typeof createServer>, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: LOOPBACK_HOST, exclusive: true });
  });
}

export async function startLoopbackServer(opts: LoopbackOptions): Promise<LoopbackServer> {
  if (opts.signal?.aborted) throw new GmiError('cancelled', 'Sign-in was cancelled.');
  const server = createServer();
  server.keepAliveTimeout = 1_000;
  server.requestTimeout = 30_000;

  let port: number;
  const preferred = opts.preferredPort && opts.preferredPort > 0 && opts.preferredPort < 65_536 ? opts.preferredPort : 0;
  try {
    port = await listenOn(server, preferred);
  } catch (error) {
    if (preferred === 0) throw new GmiError('internal', 'Could not start the local sign-in listener.', { cause: error });
    try {
      port = await listenOn(server, 0);
    } catch (fallbackError) {
      throw new GmiError('internal', 'Could not start the local sign-in listener.', { cause: fallbackError });
    }
  }

  const redirectUri = `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: GmiError) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  code.catch(() => undefined); // observed by the caller; avoid unhandled-rejection noise

  let settled = false;
  let closed = false;
  let held: ServerResponse | null = null;
  let holdTimer: NodeJS.Timeout | null = null;
  let closing: Promise<void> | null = null;

  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    clearTimeout(timer);
    if (holdTimer) clearTimeout(holdTimer);
    opts.signal?.removeEventListener('abort', onAbort);
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      // Anything still open after the final page was flushed is dropped.
      setTimeout(() => server.closeAllConnections(), 250).unref();
    });
    return closing;
  };

  const answerHeld = async (outcome: CallbackOutcome | 'pending'): Promise<void> => {
    const res = held;
    held = null;
    if (holdTimer) clearTimeout(holdTimer);
    if (!res) return;
    if (outcome === 'pending') await writeResponse(res, 200, 'text/html; charset=utf-8', renderCallbackPage('pending', opts.appName));
    else if (outcome.ok) await writeResponse(res, 200, 'text/html; charset=utf-8', renderCallbackPage('success', opts.appName));
    else await writeResponse(res, 400, 'text/html; charset=utf-8', renderCallbackPage('error', opts.appName, outcome.message));
  };

  const fail = (error: GmiError) => {
    if (!settled) {
      settled = true;
      rejectCode(error);
      void shutdown();
      return;
    }
    if (held) void answerHeld({ ok: false, message: error.message }).then(shutdown);
  };

  const timer = setTimeout(() => fail(new GmiError('timeout', 'Sign-in timed out. Start again when you are ready.')), opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = () => fail(new GmiError('cancelled', 'Sign-in was cancelled.'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? '').toLowerCase();
    // DNS-rebinding guard: only the literal loopback origin we registered.
    if (host !== `${LOOPBACK_HOST}:${port}` && host !== `localhost:${port}`) {
      void writeResponse(res, 400, 'text/plain; charset=utf-8', 'Bad request');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${port}`);
    } catch {
      void writeResponse(res, 400, 'text/plain; charset=utf-8', 'Bad request');
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      void writeResponse(res, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    if (req.method !== 'GET') {
      void writeResponse(res, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET' });
      return;
    }
    const html = 'text/html; charset=utf-8';
    if (settled || closed) {
      void writeResponse(res, 410, html, renderCallbackPage('error', opts.appName, 'This sign-in link was already used.'));
      return;
    }
    const params = url.searchParams;
    const state = params.get('state');
    if (!state || !safeEqual(state, opts.expectedState)) {
      // Not our request (stale tab or a forged hit): refuse it but keep waiting for the real callback.
      void writeResponse(res, 400, html, renderCallbackPage('error', opts.appName, 'This sign-in response does not match the sign-in started in the app.'));
      return;
    }
    const iss = params.get('iss');
    if (iss !== null && opts.issuer && !sameIssuer(iss, opts.issuer)) {
      const error = new GmiError('unauthorized', 'The sign-in response came from an unexpected server. Try again.');
      void writeResponse(res, 400, html, renderCallbackPage('error', opts.appName, error.message)).then(() => fail(error));
      return;
    }
    const oauthError = params.get('error');
    if (oauthError) {
      const error = authorizationErrorToGmiError(oauthError, params.get('error_description'));
      void writeResponse(res, 400, html, renderCallbackPage('error', opts.appName, error.message)).then(() => fail(error));
      return;
    }
    const authCode = params.get('code');
    if (!authCode) {
      const error = new GmiError('upstream', 'GMI did not return an authorization code.');
      void writeResponse(res, 400, html, renderCallbackPage('error', opts.appName, error.message)).then(() => fail(error));
      return;
    }
    settled = true;
    clearTimeout(timer);
    held = res;
    holdTimer = setTimeout(() => void answerHeld('pending').then(shutdown), opts.holdMs ?? 60_000);
    holdTimer.unref?.();
    res.on('close', () => {
      if (held === res) held = null;
    });
    resolveCode(authCode);
  };
  server.on('request', handle);

  if (opts.signal?.aborted) onAbort();

  return {
    port,
    redirectUri,
    code,
    async finish(outcome) {
      await answerHeld(outcome);
      await shutdown();
    },
    async close() {
      if (!settled) {
        settled = true;
        rejectCode(new GmiError('cancelled', 'Sign-in was cancelled.'));
      }
      await answerHeld({ ok: false, message: 'Sign-in was cancelled.' });
      await shutdown();
    },
  };
}
