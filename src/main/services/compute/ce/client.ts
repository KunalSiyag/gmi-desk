// Thin Cluster Engine client over `ctx.http` (compute.md §5, §6, §14 `ce/client.ts`). C1-B.
//
// - Bearer = the Compute key from ComputeKeyProvider (DC1), fetched per call, never stored here. A 401 is reported
//   (`reportInvalidComputeKey`); a 403 never is (not entitled / permission, §4.2).
// - GETs retry twice (transient only). POST / PUT / DELETE: `retries: 0`, always. The create POST is never retried
//   and its outcome is classified for the write-ahead journal (§6.2): `confirmed` | `failed` (definite) | `unknown`.
// - Responses are sanitised before they leave this file (§5.2): container env values and template credentials are
//   gone; the shell `urlPath` is returned to the caller only (never logged or traced).
// - Logs (§6.4): a one-time Range probe per container, a 1 MiB ring for bodies without Range, auto-polling off above
//   10 MB, and a streamed "save full log".
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { GmiError } from '@shared/contracts/errors';
import { GMI_URLS } from '@shared/app';
import type { Http } from '../../../core/http';
import type { Logger } from '../../../core/logger';
import type { ComputeKeyProvider } from '../../../core/services';
import { ComputeHttpError, computeJson, computeRequest, isDefiniteFailure, type ComputeRequestDeps } from '../errors';
import { redactContainer, redactContainers, type ComputeTrace, type SafeCeContainer } from '../sanitize';
import type {
  CeContainerCreateRequest,
  CeEipAllocateRequest,
  CeEipAssociateRequest,
  CeElasticIp,
  CeFirewall,
  CeFirewallAssociateRequest,
  CeFirewallCreateRequest,
  CeFirewallUpdateRequest,
  CeIdc,
  CeProduct,
  CeShellResponse,
  CeSshKey,
  CeTemplate,
} from './dto';

/** `https://console.gmicloud.ai/api/v1`. */
export const CE_API_BASE: string = GMI_URLS.consoleApi;

/** Timeouts (ms). The create POST waits 60 s (§6.2); everything else 30 s, logs longer. */
export const CE_TIMEOUTS = { get: 30_000, mutate: 30_000, create: 60_000, logsRange: 30_000, logsFull: 5 * 60_000 } as const;

/** Logs (§6.4). */
export const CE_LOGS = {
  /** Kept in main per resource, whatever the log size. */
  ringBytes: 1024 * 1024,
  /** Without Range, auto-polling stops above this size. */
  autoPollMaxBytes: 10 * 1000 * 1000,
} as const;

/** Outcome of a request that creates something billable (§6.2). Never re-sent by the client. */
export type CreateOutcome<T> =
  | { outcome: 'confirmed'; value: T }
  /** GMI definitely refused (400/401/403/404/422 with a parsed GMI body): nothing was created. */
  | { outcome: 'failed'; error: GmiError }
  /** Anything else: it may exist. Reconcile by listing; never POST again. */
  | { outcome: 'unknown'; error: GmiError };

export interface CeLogsResult {
  text: string;
  /** Older bytes were dropped (the ring kept the newest 1 MiB, or Range returned a tail). */
  truncated: boolean;
  /** Full log size when known (Content-Range total, Content-Length, or bytes read). */
  totalBytes: number | null;
  /** Range worked (206); persist it in the registry (`logsRangeSupported`). */
  rangeSupported: boolean;
  /** False: the log is too big to poll without Range (> 10 MB); offer Refresh / a 60 s poll instead. */
  autoPoll: boolean;
  fetchedAt: string;
}

/** The key-less feeds (signed out browsing, §5.1). */
export interface CePublicApi {
  idcs(): Promise<CeIdc[]>;
  /** Official templates (raw wire shape; the catalog redacts them). */
  publicTemplates(): Promise<CeTemplate[]>;
  /** The billing feed, raw (`{products}`): descriptions inside it are read only by the sanitiser. */
  billingProducts(dataCenter?: string | null): Promise<unknown>;
}

/** Everything that needs the Compute key. */
export interface CeApi {
  listContainers(opts?: { signal?: AbortSignal }): Promise<SafeCeContainer[]>;
  getContainer(id: string): Promise<SafeCeContainer>;
  /** `count` is forced to 1. Exactly one POST, whatever happens. */
  createContainer(req: CeContainerCreateRequest): Promise<CreateOutcome<string>>;
  deleteContainer(id: string): Promise<void>;
  restartContainer(id: string): Promise<void>;
  /** SECRET result: the caller keeps `urlPath` in memory only (§8.8). */
  containerShell(id: string): Promise<CeShellResponse>;
  getLogs(id: string, opts?: { tailBytes?: number; rangeSupported?: boolean | null; signal?: AbortSignal }): Promise<CeLogsResult>;
  /** Streams the whole log to `destPath` (`.part`, then rename). Returns the bytes written. */
  saveLogs(id: string, destPath: string, opts?: { signal?: AbortSignal }): Promise<number>;
  listProducts(idc: string): Promise<CeProduct[]>;
  /** The org's templates, raw (the catalog redacts `credential`). */
  listTemplates(): Promise<CeTemplate[]>;
  listSshKeys(): Promise<CeSshKey[]>;
  listEips(): Promise<CeElasticIp[]>;
  eipProducts(idc: string): Promise<CeProduct[]>;
  allocateEip(req: CeEipAllocateRequest): Promise<CreateOutcome<string>>;
  associateEip(id: string, req: CeEipAssociateRequest): Promise<void>;
  disassociateEip(id: string, req: CeEipAssociateRequest): Promise<void>;
  releaseEip(id: string): Promise<void>;
  listFirewalls(idc?: string | null): Promise<CeFirewall[]>;
  createFirewall(req: CeFirewallCreateRequest): Promise<CreateOutcome<CeFirewall>>;
  updateFirewall(id: string, req: CeFirewallUpdateRequest): Promise<void>;
  deleteFirewall(id: string): Promise<void>;
  associateFirewall(id: string, req: CeFirewallAssociateRequest): Promise<void>;
  disassociateFirewall(id: string, req: CeFirewallAssociateRequest): Promise<void>;
}

export interface CeClientDeps {
  http: Http;
  log: Logger;
  keys: ComputeKeyProvider;
  trace?: ComputeTrace | null;
  onServerDate?: ((serverDate: Date) => void) | null;
  baseUrl?: string;
  now?: () => Date;
}

const UUIDISH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function seg(id: string, what = 'id'): string {
  if (typeof id !== 'string' || !UUIDISH.test(id)) throw new GmiError('invalid_input', `Not a valid ${what}.`);
  return encodeURIComponent(id);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arrayOf = <T>(v: unknown, key?: string): T[] => {
  if (Array.isArray(v)) return v as T[];
  if (key && isObj(v) && Array.isArray(v[key])) return v[key] as T[];
  return [];
};

/** Classifies a create response body: exactly what §6.2 calls `200 + body [{id}]`. */
export function parseCreateIds(body: unknown): string[] | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const ids = body.map((x) => (isObj(x) && typeof x.id === 'string' && x.id.trim() ? x.id : null));
  return ids.every((x): x is string => x !== null) ? ids : null;
}

/** Maps a thrown error of a create-type request to the journal outcome. */
export function createOutcomeOf<T>(error: unknown): CreateOutcome<T> {
  const e = error instanceof GmiError ? error : new GmiError('internal', String(error));
  return isDefiniteFailure(e) ? { outcome: 'failed', error: e } : { outcome: 'unknown', error: e };
}

// ─── Public feeds ──────────────────────────────────────────────────────────────────────────────────────────────────

export function createCePublicClient(deps: Omit<CeClientDeps, 'keys'>): CePublicApi {
  const base = deps.baseUrl ?? CE_API_BASE;
  const r: ComputeRequestDeps = { http: deps.http, log: deps.log, trace: deps.trace ?? null, onServerDate: deps.onServerDate ?? null };
  return {
    async idcs() {
      const { body } = await computeJson<unknown>(r, { family: 'public', url: `${base}/idcs`, retries: 2, timeoutMs: CE_TIMEOUTS.get });
      return arrayOf<CeIdc>(body, 'idcs').filter((i) => isObj(i) && typeof i.idcId === 'string');
    },
    async publicTemplates() {
      const { body } = await computeJson<unknown>(r, { family: 'public', url: `${base}/public/templates`, retries: 2, timeoutMs: CE_TIMEOUTS.get });
      return arrayOf<CeTemplate>(body, 'templates');
    },
    async billingProducts(dataCenter) {
      const { body } = await computeJson<unknown>(r, {
        family: 'public',
        url: `${base}/billing/products`,
        query: dataCenter ? { dataCenter } : undefined,
        retries: 2,
        timeoutMs: CE_TIMEOUTS.get,
      });
      return body;
    },
  };
}

// ─── The logs ring ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Keeps the newest `capacity` bytes of a stream; memory never grows beyond it. */
export class ByteRing {
  private readonly buf: Uint8Array;
  private start = 0;
  private size = 0;
  /** Every byte ever written. */
  total = 0;
  constructor(readonly capacity: number) {
    this.buf = new Uint8Array(capacity);
  }
  write(chunk: Uint8Array): void {
    this.total += chunk.byteLength;
    let data = chunk;
    if (data.byteLength >= this.capacity) {
      data = data.subarray(data.byteLength - this.capacity);
      this.buf.set(data, 0);
      this.start = 0;
      this.size = this.capacity;
      return;
    }
    let end = (this.start + this.size) % this.capacity;
    const first = Math.min(data.byteLength, this.capacity - end);
    this.buf.set(data.subarray(0, first), end);
    if (first < data.byteLength) this.buf.set(data.subarray(first), 0);
    end = (end + data.byteLength) % this.capacity;
    const newSize = this.size + data.byteLength;
    if (newSize > this.capacity) {
      this.size = this.capacity;
      this.start = end;
    } else {
      this.size = newSize;
    }
  }
  /** Bytes currently held (≤ capacity). */
  get length(): number {
    return this.size;
  }
  get dropped(): boolean {
    return this.total > this.size;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    const firstLen = Math.min(this.size, this.capacity - this.start);
    out.set(this.buf.subarray(this.start, this.start + firstLen), 0);
    if (firstLen < this.size) out.set(this.buf.subarray(0, this.size - firstLen), firstLen);
    return out;
  }
}

/** Decodes a log tail: when older bytes were cut, skips a split UTF-8 sequence and the partial first line. */
export function decodeLogTail(bytes: Uint8Array, cut: boolean): string {
  let start = 0;
  if (cut) {
    while (start < bytes.length && start < 4 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    const nl = bytes.indexOf(0x0a, start);
    if (nl >= 0 && nl < bytes.length - 1) start = nl + 1;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start));
}

async function drainInto(res: Response, ring: ByteRing): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) ring.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** `bytes a-b/total` → total (null when absent or `*`). */
export function contentRangeTotal(header: string | null): number | null {
  const m = header ? /\/(\d+)\s*$/.exec(header) : null;
  return m?.[1] ? Number(m[1]) : null;
}

// ─── The authenticated client ──────────────────────────────────────────────────────────────────────────────────────

export function createCeClient(deps: CeClientDeps): CeApi {
  const base = deps.baseUrl ?? CE_API_BASE;
  const now = deps.now ?? (() => new Date());
  const r: ComputeRequestDeps = { http: deps.http, log: deps.log.child('compute.ce'), trace: deps.trace ?? null, onServerDate: deps.onServerDate ?? null };
  /** Range support learned per container in this run (seeded from the registry by the caller). */
  const rangeByContainer = new Map<string, boolean>();

  async function withKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
    const key = await deps.keys.requireComputeKey();
    try {
      return await fn(key);
    } catch (error) {
      if (error instanceof ComputeHttpError && error.status === 401) {
        await deps.keys.reportInvalidComputeKey(error.message, key, 401).catch(() => undefined);
      }
      throw error;
    }
  }

  const get = <T>(path: string, query?: Record<string, string | undefined>, signal?: AbortSignal) =>
    withKey(async (key) => (await computeJson<T>(r, { family: 'ce', url: `${base}${path}`, query, bearer: key, retries: 2, timeoutMs: CE_TIMEOUTS.get, signal })).body);

  const mutate = (method: 'POST' | 'PUT' | 'DELETE', path: string, json?: unknown, timeoutMs: number = CE_TIMEOUTS.mutate) =>
    withKey(async (key) => computeJson<unknown>(r, { family: 'ce', method, url: `${base}${path}`, json, bearer: key, retries: 0, timeoutMs }));

  async function createCall<T>(path: string, json: unknown, parse: (body: unknown) => T | null, timeoutMs: number): Promise<CreateOutcome<T>> {
    let body: unknown;
    try {
      body = (await mutate('POST', path, json, timeoutMs)).body;
    } catch (error) {
      return createOutcomeOf<T>(error);
    }
    const value = parse(body);
    if (value === null) {
      // A 200 whose body is not what a create returns: it may still have created something (§6.2).
      return { outcome: 'unknown', error: new ComputeHttpError('upstream', 'GMI answered the create in an unexpected way.', { family: 'ce', status: 200, parsed: false }) };
    }
    return { outcome: 'confirmed', value };
  }

  async function logsRequest(id: string, key: string, range: number | null, signal?: AbortSignal): Promise<Response> {
    return computeRequest(r, {
      family: 'ce',
      url: `${base}/containers/${seg(id)}/logs`,
      bearer: key,
      headers: { Accept: 'text/plain, */*', ...(range ? { Range: `bytes=-${range}` } : {}) },
      retries: 2,
      timeoutMs: range ? CE_TIMEOUTS.logsRange : CE_TIMEOUTS.logsFull,
      signal,
    });
  }

  return {
    async listContainers(opts) {
      const body = await get<unknown>('/containers', undefined, opts?.signal);
      // The list is a bare array [V]: anything else is a malformed answer (a poll failure), never "the org is empty".
      if (!Array.isArray(body)) throw new ComputeHttpError('upstream', 'GMI returned an unexpected container list.', { family: 'ce', status: 200, parsed: false });
      return redactContainers(body);
    },
    async getContainer(id) {
      const body = await get<unknown>(`/containers/${seg(id)}`);
      if (!isObj(body) || typeof body.id !== 'string') throw new ComputeHttpError('upstream', 'GMI returned an unexpected container.', { family: 'ce', status: 200, parsed: false });
      return redactContainer(body as never);
    },
    async createContainer(req) {
      const json: CeContainerCreateRequest = { ...req, count: 1 };
      return createCall('/containers', json, (b) => {
        const ids = parseCreateIds(b);
        return ids && ids.length === 1 ? (ids[0] as string) : null;
      }, CE_TIMEOUTS.create);
    },
    async deleteContainer(id) {
      await mutate('DELETE', `/containers/${seg(id)}`);
    },
    async restartContainer(id) {
      await mutate('POST', `/containers/${seg(id)}/restart`);
    },
    async containerShell(id) {
      // Not traced with its body: `urlPath` is a credential (computeRequest records status only).
      return withKey(async (key) => {
        const res = await computeRequest(r, { family: 'ce', method: 'POST', url: `${base}/containers/${seg(id)}/shell`, json: {}, bearer: key, retries: 0, timeoutMs: CE_TIMEOUTS.mutate });
        let body: unknown;
        try {
          body = JSON.parse(await res.text());
        } catch {
          body = null;
        }
        if (!isObj(body) || typeof body.urlPath !== 'string' || !body.urlPath) {
          throw new ComputeHttpError('upstream', 'GMI did not return a shell address.', { family: 'ce', status: res.status, parsed: false });
        }
        return { urlPath: body.urlPath };
      });
    },
    async getLogs(id, opts = {}) {
      const tail = Math.max(1024, Math.min(opts.tailBytes ?? CE_LOGS.ringBytes, CE_LOGS.ringBytes));
      const known = opts.rangeSupported ?? rangeByContainer.get(id) ?? null;
      return withKey(async (key) => {
        const res = await logsRequest(id, key, known === false ? null : tail, opts.signal);
        const ranged = known !== false && res.status === 206;
        if (known !== false) rangeByContainer.set(id, ranged);
        const ring = new ByteRing(ranged ? Math.max(tail, CE_LOGS.ringBytes) : CE_LOGS.ringBytes);
        const declared = Number(res.headers.get('content-length'));
        let cutShort = false;
        try {
          await drainInto(res, ring);
        } catch (error) {
          // The request's timeout (or the caller's abort) fired while a big body was still streaming (GMI ignored
          // Range): keep the tail already read instead of failing the whole view with a raw DOMException.
          const name = error instanceof Error ? error.name : '';
          if (opts.signal?.aborted) throw new GmiError('cancelled', 'Cancelled.', { cause: error });
          if (name !== 'TimeoutError' && name !== 'AbortError') throw error;
          if (ring.total === 0) throw new GmiError('timeout', 'GMI took too long to send the log.', { cause: error });
          cutShort = true;
        }
        const rangeTotal = ranged ? contentRangeTotal(res.headers.get('content-range')) : null;
        const totalBytes = ranged ? rangeTotal : Math.max(ring.total, Number.isFinite(declared) ? declared : 0);
        const cut = cutShort || (ranged ? (rangeTotal !== null ? rangeTotal > ring.total : ring.total >= tail) : ring.dropped);
        const tooBig = cutShort || (!ranged && (totalBytes ?? 0) > CE_LOGS.autoPollMaxBytes);
        return {
          text: decodeLogTail(ring.bytes(), cut),
          truncated: cut,
          totalBytes: cutShort ? null : totalBytes,
          rangeSupported: ranged,
          autoPoll: !tooBig,
          fetchedAt: now().toISOString(),
        };
      });
    },
    async saveLogs(id, destPath, opts = {}) {
      return withKey(async (key) => {
        const res = await computeRequest(r, {
          family: 'ce',
          url: `${base}/containers/${seg(id)}/logs`,
          bearer: key,
          headers: { Accept: 'text/plain, */*' },
          retries: 0,
          timeoutMs: 0,
          signal: opts.signal,
        });
        const part = `${destPath}.part`;
        const out = createWriteStream(part, { mode: 0o600 });
        let bytes = 0;
        try {
          if (res.body) {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value) continue;
              bytes += value.byteLength;
              if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
            }
          }
          await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
          await rename(part, destPath);
          return bytes;
        } catch (error) {
          out.destroy();
          await rm(part, { force: true }).catch(() => undefined);
          throw error;
        }
      });
    },
    async listProducts(idc) {
      return arrayOf<CeProduct>(await get<unknown>('/containers/products', { idc }), 'products');
    },
    async listTemplates() {
      return arrayOf<CeTemplate>(await get<unknown>('/templates'), 'templates');
    },
    async listSshKeys() {
      return arrayOf<CeSshKey>(await get<unknown>('/me/ssh-keys'), 'keys');
    },
    async listEips() {
      return arrayOf<CeElasticIp>(await get<unknown>('/elastic-ips'), 'elasticIPs');
    },
    async eipProducts(idc) {
      return arrayOf<CeProduct>(await get<unknown>('/elastic-ips/products', { idc }), 'products');
    },
    async allocateEip(req) {
      return createCall('/elastic-ips', { ...req, count: 1 }, (b) => {
        const ids = parseCreateIds(b);
        return ids && ids.length === 1 ? (ids[0] as string) : null;
      }, CE_TIMEOUTS.create);
    },
    async associateEip(id, req) {
      await mutate('POST', `/elastic-ips/${seg(id)}/associate`, req);
    },
    async disassociateEip(id, req) {
      await mutate('POST', `/elastic-ips/${seg(id)}/disassociate`, req);
    },
    async releaseEip(id) {
      await mutate('DELETE', `/elastic-ips/${seg(id)}`);
    },
    async listFirewalls(idc) {
      return arrayOf<CeFirewall>(await get<unknown>('/firewalls', idc ? { idc } : undefined), 'firewalls');
    },
    async createFirewall(req) {
      return createCall('/firewalls', req, (b) => (isObj(b) && typeof b.id === 'string' ? (b as unknown as CeFirewall) : null), CE_TIMEOUTS.create);
    },
    async updateFirewall(id, req) {
      await mutate('PUT', `/firewalls/${seg(id)}`, req);
    },
    async deleteFirewall(id) {
      await mutate('DELETE', `/firewalls/${seg(id)}`);
    },
    async associateFirewall(id, req) {
      await mutate('POST', `/firewalls/${seg(id)}/associate`, req);
    },
    async disassociateFirewall(id, req) {
      await mutate('POST', `/firewalls/${seg(id)}/disassociate`, req);
    },
  };
}
