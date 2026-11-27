import type { FetchLike } from '@main/core/http';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeRoute {
  /** Substring, RegExp or predicate matched against the full URL. */
  match: string | RegExp | ((url: string, init: RequestInit | undefined) => boolean);
  method?: string;
  respond: (req: RecordedRequest) => Response | Promise<Response>;
}

/** A fetch replacement that serves registered routes and records every request. */
export function createFakeFetch(routes: FakeRoute[] = []) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = typeof init?.body === 'string' ? init.body : init?.body ? '[binary]' : null;
    const req: RecordedRequest = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
    requests.push(req);
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    for (const route of routes) {
      if (route.method && route.method.toUpperCase() !== req.method) continue;
      const m = route.match;
      const hit = typeof m === 'string' ? url.includes(m) : m instanceof RegExp ? m.test(url) : m(url, init);
      if (hit) return route.respond(req);
    }
    return new Response(`no fake route for ${req.method} ${url}`, { status: 599 });
  };
  return {
    fetch: fetchImpl,
    requests,
    route(route: FakeRoute) {
      routes.push(route);
    },
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** An SSE response whose body is the given raw event blocks (each block is sent as one chunk). */
export function sseResponse(blocks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** `data: {json}\n\n` */
export const sseData = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
