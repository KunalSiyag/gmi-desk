// Sandbox API v2 control plane (compute.md §7, §14 `sandbox/client.ts`). C1-B.
//
// - Bearer = the Compute key (DC1); 401 reported, 403 never.
// - Create carries `Idempotency-Key: <rid>`. Retries only with that same key, in this process, inside the original
//   2-minute window: at most 3, for network errors and 503 (§7.1). Every other POST/DELETE: `retries: 0`.
//   `Sandbox.IdempotentKeyConsumed` → `unknown` (reconcile by `metadata[rid]`); `IdempotentParameterMismatch` is a bug
//   (`failed`, the caller raises an alarm). Parsed v2 quota / rate-limit refusals are definite (`failed`).
// - Lists page 100 at a time. `state` is sent one value per call (whether it takes several is [U] U21).
// - Create and connect return tokens (SECRET): only to the caller, never traced or logged (the trace scrubs them).
import { GmiError } from '@shared/contracts/errors';
import { GMI_URLS } from '@shared/app';
import type { Http } from '../../../core/http';
import type { Logger } from '../../../core/logger';
import type { ComputeKeyProvider } from '../../../core/services';
import type { CreateOutcome } from '../ce/client';
import { ComputeHttpError, computeJson, isDefiniteFailure, unwrapV2, type ComputeRequestDeps } from '../errors';
import type { ComputeTrace } from '../sanitize';
import {
  V2_PAGE_SIZE_MAX,
  type V2ConnectResult,
  type V2CreateSandboxRequest,
  type V2CreateSandboxResult,
  type V2CreateSnapshotRequest,
  type V2DeleteAccepted,
  type V2EgressPolicy,
  type V2EgressUpdateResult,
  type V2LifecycleAccepted,
  type V2Page,
  type V2Product,
  type V2SandboxDetail,
  type V2SandboxSummary,
  type V2SetTimeoutResult,
  type V2Snapshot,
  type V2Template,
} from './dto';

export const V2_API_BASE: string = GMI_URLS.consoleApiV2;

export const V2_TIMEOUTS = { get: 30_000, mutate: 30_000, create: 60_000 } as const;
/** §7.1: same key, same process, original 2-minute window, at most 3 retries. */
export const V2_CREATE_RETRY = { max: 3, windowMs: 2 * 60_000, delaysMs: [1_000, 3_000, 9_000] as const };
/** Lists stop after this many pages (10 000 sandboxes): a safety stop, never reached in practice. */
export const V2_LIST_MAX_PAGES = 100;

export interface SandboxListQuery {
  state?: string | null;
  idc?: string | null;
  /** `metadata[k]=v` filters (e.g. `{app: 'gmi-desk', inst}`). */
  metadata?: Record<string, string>;
  page?: number;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface SandboxApi {
  /** One POST (plus §7.1's same-key retries). The result holds tokens: memory only. */
  create(req: V2CreateSandboxRequest, opts: { idempotencyKey: string }): Promise<CreateOutcome<V2CreateSandboxResult>>;
  list(q?: SandboxListQuery): Promise<V2Page<V2SandboxSummary>>;
  /** Every page; with `states`, one listing per state (deduplicated by id). */
  listAll(q?: Omit<SandboxListQuery, 'page' | 'state'> & { states?: string[] }): Promise<V2SandboxSummary[]>;
  get(id: string): Promise<V2SandboxDetail>;
  delete(id: string): Promise<V2DeleteAccepted>;
  pause(id: string): Promise<V2LifecycleAccepted>;
  resume(id: string, timeoutSec?: number | null): Promise<V2LifecycleAccepted>;
  setTimeout(id: string, timeoutSec: number): Promise<V2SetTimeoutResult>;
  /** SECRET result (tokens): for the TokenCache only (§7.2). */
  connect(id: string, timeoutSec?: number | null): Promise<V2ConnectResult>;
  updateEgress(id: string, policy: V2EgressPolicy): Promise<V2EgressUpdateResult>;
  products(idc: string): Promise<V2Product[]>;
  templates(idc: string): Promise<V2Template[]>;
  listSnapshots(q?: { metadata?: Record<string, string> }): Promise<V2Snapshot[]>;
  getSnapshot(id: string): Promise<V2Snapshot>;
  createSnapshot(req: V2CreateSnapshotRequest): Promise<CreateOutcome<V2Snapshot>>;
  deleteSnapshot(id: string): Promise<void>;
}

export interface SandboxClientDeps {
  http: Http;
  log: Logger;
  keys: ComputeKeyProvider;
  trace?: ComputeTrace | null;
  onServerDate?: ((serverDate: Date) => void) | null;
  baseUrl?: string;
  now?: () => Date;
  /** Injectable for tests (the create retry delays). */
  sleep?: (ms: number) => Promise<void>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function seg(id: string): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new GmiError('invalid_input', 'Not a valid sandbox id.');
  return encodeURIComponent(id);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function metadataQuery(metadata: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadata ?? {})) {
    if (!/^[A-Za-z0-9_.-]{1,63}$/.test(k)) throw new GmiError('invalid_input', `Not a valid metadata label: ${k}`);
    out[`metadata[${k}]`] = v;
  }
  return out;
}

/** A page from either `{items,…}` or a `{data: {items}}` envelope; malformed items dropped. */
export function parsePage<T>(body: unknown, isItem: (v: unknown) => v is T): V2Page<T> {
  const src = isObj(body) && Array.isArray(body.items) ? body : isObj(body) && isObj(body.data) ? body.data : {};
  const items = Array.isArray((src as Obj).items) ? ((src as Obj).items as unknown[]).filter(isItem) : [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    request_id: isObj(body) && typeof body.request_id === 'string' ? body.request_id : '',
    total: num((src as Obj).total, items.length),
    page: num((src as Obj).page, 1),
    page_size: num((src as Obj).page_size, items.length),
    items,
  };
}

const isSummary = (v: unknown): v is V2SandboxSummary => isObj(v) && typeof v.id === 'string' && typeof v.state === 'string';
const isSnapshot = (v: unknown): v is V2Snapshot => isObj(v) && typeof v.snapshot_id === 'string';
const isTemplate = (v: unknown): v is V2Template => isObj(v) && typeof v.id === 'string' && typeof v.name === 'string';

/** A create / connect result that holds what the data plane needs; null otherwise (an odd 2xx). */
export function parseCreateResult(body: unknown): V2CreateSandboxResult | null {
  const d = unwrapV2<unknown>(body);
  if (!isObj(d)) return null;
  const ok = (k: string) => typeof d[k] === 'string' && (d[k] as string).length > 0;
  if (!ok('id') || !ok('sandbox_key') || !ok('domain') || !ok('sandbox_access_token')) return null;
  return {
    id: d.id as string,
    sandbox_key: d.sandbox_key as string,
    domain: d.domain as string,
    sandbox_access_token: d.sandbox_access_token as string,
    traffic_access_token: typeof d.traffic_access_token === 'string' ? d.traffic_access_token : '',
    ...(typeof d.template_id === 'string' ? { template_id: d.template_id } : {}),
  };
}

export function createSandboxClient(deps: SandboxClientDeps): SandboxApi {
  const base = deps.baseUrl ?? V2_API_BASE;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const r: ComputeRequestDeps = { http: deps.http, log: deps.log.child('compute.v2'), trace: deps.trace ?? null, onServerDate: deps.onServerDate ?? null };

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

  const get = (path: string, query?: Record<string, string | number | undefined>, signal?: AbortSignal) =>
    withKey(async (key) => (await computeJson<unknown>(r, { family: 'v2', url: `${base}${path}`, query, bearer: key, retries: 2, timeoutMs: V2_TIMEOUTS.get, signal })).body);

  const send = (method: 'POST' | 'DELETE' | 'PATCH', path: string, json?: unknown, headers?: Record<string, string>) =>
    withKey(async (key) => (await computeJson<unknown>(r, { family: 'v2', method, url: `${base}${path}`, json, headers, bearer: key, retries: 0, timeoutMs: V2_TIMEOUTS.mutate })).body);

  /**
   * On the entitlement probes (the collection list and create), v2's `Auth.Forbidden` means the org has no Agentbox
   * access; elsewhere it is a per-object permission (errors.ts maps it to `unauthorized`).
   */
  function entitlement(error: unknown): unknown {
    if (error instanceof ComputeHttpError && error.status === 403 && error.parsed && error.remoteCode === 'Auth.Forbidden' && error.code === 'unauthorized') {
      return new ComputeHttpError('not_entitled', 'Your GMI organization does not have access to this product yet. Contact GMI support to enable it.', {
        family: 'v2',
        status: 403,
        parsed: true,
        remoteCode: error.remoteCode,
        requestId: error.requestId,
        details: error.details,
        detail: error.detail,
      });
    }
    return error;
  }

  function expect<T>(body: unknown, guard: (v: unknown) => v is T, what: string): T {
    const d = unwrapV2<unknown>(body);
    if (!guard(d)) throw new ComputeHttpError('upstream', `GMI returned an unexpected ${what}.`, { family: 'v2', status: 200, parsed: false });
    return d;
  }

  const api: SandboxApi = {
    async create(req, opts) {
      if (!opts.idempotencyKey || !/^[A-Za-z0-9_-]{8,128}$/.test(opts.idempotencyKey)) throw new GmiError('invalid_input', 'A create needs a valid idempotency key.');
      if (typeof req.timeout !== 'number') throw new GmiError('invalid_input', 'A sandbox create always sends an explicit timeout.');
      const started = now().getTime();
      let attempt = 0;
      for (;;) {
        try {
          const body = await withKey(async (key) =>
            (
              await computeJson<unknown>(r, {
                family: 'v2',
                method: 'POST',
                url: `${base}/sandboxes`,
                json: req,
                headers: { 'Idempotency-Key': opts.idempotencyKey },
                bearer: key,
                retries: 0,
                timeoutMs: V2_TIMEOUTS.create,
              })
            ).body,
          );
          const result = parseCreateResult(body);
          if (!result) return { outcome: 'unknown', error: new ComputeHttpError('upstream', 'GMI answered the create in an unexpected way.', { family: 'v2', status: 201, parsed: false }) };
          return { outcome: 'confirmed', value: result };
        } catch (caught) {
          const error = entitlement(caught);
          const e = error instanceof GmiError ? error : new GmiError('internal', String(error));
          const retryable = e.code === 'network' || e.status === 503;
          const delay = V2_CREATE_RETRY.delaysMs[attempt] ?? 9_000;
          if (retryable && attempt < V2_CREATE_RETRY.max && now().getTime() - started + delay < V2_CREATE_RETRY.windowMs) {
            attempt += 1;
            r.log.info('sandbox create retry (same idempotency key)', { attempt, code: e.code, status: e.status });
            await sleep(delay);
            continue;
          }
          if (e instanceof ComputeHttpError && e.remoteCode === 'Sandbox.IdempotentKeyConsumed') return { outcome: 'unknown', error: e };
          if (e instanceof ComputeHttpError && e.parsed && e.status === 429 && (e.remoteCode === 'Resource.QuotaExceeded' || e.remoteCode === 'RateLimit.Exceeded')) {
            return { outcome: 'failed', error: e };
          }
          return isDefiniteFailure(e) ? { outcome: 'failed', error: e } : { outcome: 'unknown', error: e };
        }
      }
    },
    async list(q = {}) {
      const query: Record<string, string | number | undefined> = {
        page: q.page ?? 1,
        page_size: Math.min(q.pageSize ?? V2_PAGE_SIZE_MAX, V2_PAGE_SIZE_MAX),
        ...(q.state ? { state: q.state } : {}),
        ...(q.idc ? { idc_name: q.idc } : {}),
        ...metadataQuery(q.metadata),
      };
      let body: unknown;
      try {
        body = await get('/sandboxes', query, q.signal);
      } catch (error) {
        throw entitlement(error);
      }
      return parsePage(body, isSummary);
    },
    async listAll(q = {}) {
      const states = q.states && q.states.length ? q.states : [null];
      const seen = new Map<string, V2SandboxSummary>();
      for (const state of states) {
        for (let page = 1; page <= V2_LIST_MAX_PAGES; page += 1) {
          const res = await api.list({ ...q, state, page, pageSize: V2_PAGE_SIZE_MAX });
          for (const item of res.items) seen.set(item.id, item);
          if (res.items.length < V2_PAGE_SIZE_MAX || page * V2_PAGE_SIZE_MAX >= res.total) break;
        }
      }
      return [...seen.values()];
    },
    async get(id) {
      return expect(await get(`/sandboxes/${seg(id)}`), (v): v is V2SandboxDetail => isObj(v) && typeof v.id === 'string' && typeof v.state === 'string', 'sandbox');
    },
    async delete(id) {
      return expect(await send('DELETE', `/sandboxes/${seg(id)}`), (v): v is V2DeleteAccepted => isObj(v) && typeof v.state === 'string', 'delete answer');
    },
    async pause(id) {
      return expect(await send('POST', `/sandboxes/${seg(id)}/pause`, {}), (v): v is V2LifecycleAccepted => isObj(v) && typeof v.state === 'string', 'pause answer');
    },
    async resume(id, timeoutSec) {
      const body = typeof timeoutSec === 'number' && timeoutSec > 0 ? { timeout: Math.round(timeoutSec) } : {};
      return expect(await send('POST', `/sandboxes/${seg(id)}/resume`, body), (v): v is V2LifecycleAccepted => isObj(v) && typeof v.state === 'string', 'resume answer');
    },
    async setTimeout(id, timeoutSec) {
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 86_400) throw new GmiError('invalid_input', 'The timeout must be 1–86400 seconds.');
      return expect(await send('POST', `/sandboxes/${seg(id)}/timeout`, { timeout: timeoutSec }), (v): v is V2SetTimeoutResult => isObj(v) && typeof v.new_end_at === 'string', 'timeout answer');
    },
    async connect(id, timeoutSec) {
      const body = typeof timeoutSec === 'number' && timeoutSec > 0 ? { timeout: Math.round(timeoutSec) } : {};
      const raw = await send('POST', `/sandboxes/${seg(id)}/connect`, body);
      const result = parseCreateResult(raw);
      if (!result) throw new ComputeHttpError('upstream', 'GMI did not return sandbox access.', { family: 'v2', status: 200, parsed: false });
      const d = unwrapV2<unknown>(raw);
      const endAt = isObj(d) && typeof d.end_at === 'string' ? d.end_at : '';
      return { ...result, end_at: endAt };
    },
    async updateEgress(id, policy) {
      return expect(
        await send('POST', `/sandboxes/${seg(id)}/actions`, { action: 'update_egress_policy', params: policy }),
        (v): v is V2EgressUpdateResult => isObj(v) && typeof v.state === 'string',
        'egress answer',
      );
    },
    async products(idc) {
      const d = unwrapV2<unknown>(await get('/products', { idc_name: idc, resource_type: 'sandbox' }));
      return Array.isArray(d) ? d.filter((p): p is V2Product => isObj(p) && typeof p.product === 'string') : [];
    },
    async templates(idc) {
      const out: V2Template[] = [];
      for (let page = 1; page <= V2_LIST_MAX_PAGES; page += 1) {
        const res = parsePage(await get('/templates', { idc_name: idc, page, page_size: V2_PAGE_SIZE_MAX }), isTemplate);
        out.push(...res.items);
        if (res.items.length < V2_PAGE_SIZE_MAX || page * V2_PAGE_SIZE_MAX >= res.total) break;
      }
      return out;
    },
    async listSnapshots(q = {}) {
      const out: V2Snapshot[] = [];
      for (let page = 1; page <= V2_LIST_MAX_PAGES; page += 1) {
        const res = parsePage(await get('/snapshots', { page, page_size: V2_PAGE_SIZE_MAX, ...metadataQuery(q.metadata) }), isSnapshot);
        out.push(...res.items);
        if (res.items.length < V2_PAGE_SIZE_MAX || page * V2_PAGE_SIZE_MAX >= res.total) break;
      }
      return out;
    },
    async getSnapshot(id) {
      return expect(await get(`/snapshots/${seg(id)}`), isSnapshot, 'snapshot');
    },
    async createSnapshot(req) {
      try {
        const body = await send('POST', '/snapshots', req);
        const snap = unwrapV2<unknown>(body);
        if (!isSnapshot(snap)) return { outcome: 'unknown', error: new ComputeHttpError('upstream', 'GMI answered the snapshot in an unexpected way.', { family: 'v2', status: 200, parsed: false }) };
        return { outcome: 'confirmed', value: snap };
      } catch (error) {
        const e = error instanceof GmiError ? error : new GmiError('internal', String(error));
        return isDefiniteFailure(e) || e.code === 'conflict' ? { outcome: 'failed', error: e } : { outcome: 'unknown', error: e };
      }
    },
    async deleteSnapshot(id) {
      await send('DELETE', `/snapshots/${seg(id)}`);
    },
  };
  return api;
}
