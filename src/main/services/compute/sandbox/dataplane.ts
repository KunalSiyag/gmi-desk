// Sandbox API v2 data plane (compute.md §7.2, §8.1–8.3, §14 `sandbox/dataplane.ts`). C1-B: the primitives the
// computer (C2) and the H4 broker build on.
//
// - TokenCache: per-sandbox access from `connect`, in memory only (never persisted, emitted or traced). Single-flight
//   refresh: on a data-plane 401, after resume / timeout changes (`invalidate`), and 60 s before `end_at`.
//   `domain` is never built by the app: it comes only from create / connect, and the host is checked.
// - Exec: every request carries an explicit `execution_timeout_seconds`; POST waits 25 s, then GET polls until the
//   execution is terminal (a wait that times out leaves it running [V]). `onAccepted(eid)` fires as soon as GMI
//   names the execution (the ExecPort binds its slot there). An abort while waiting cancels it remotely.
// - Files: raw GET; multipart POST with part `file` (a 200 with `[]` is an error [V]); Range downloads resume only
//   on 206 (a 200 restarts from zero [V]).
// - Shell: POST /shell (202 → retry after 1 s), /shell/control (a `Shell.ResizeFailed` 502 is retried once), and the
//   WebSocket target for C2-A (`X-Access-Token` header; the app connects with `ws` in main).
// Data-plane bodies are never traced: status, sizes and request ids only (§17).
import { basename } from 'node:path';
import { UPLOAD_MAX_BYTES } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Http } from '../../../core/http';
import type { Logger } from '../../../core/logger';
import { ComputeHttpError, computeJson, computeRequest, type ComputeRequestDeps } from '../errors';
import type { ComputeTrace } from '../sanitize';
import {
  V2_EXEC_COMMAND_MAX_BYTES,
  V2_EXEC_ENV_VALUE_MAX_BYTES,
  V2_EXEC_TERMINAL_STATUSES,
  V2_EXEC_TIMEOUT_MAX_SEC,
  V2_EXEC_TIMEOUT_MIN_SEC,
  V2_EXEC_WAIT_TIMEOUT_MAX_SEC,
  V2_SHELL_SIZE_MAX,
  type V2ConnectResult,
  type V2CreateSandboxResult,
  type V2ExecAccepted,
  type V2ExecResult,
  type V2FileEntry,
  type V2ShellControlRequest,
  type V2ShellControlResponse,
  type V2ShellLaunch,
} from './dto';

// ─── Token cache (§7.2) ────────────────────────────────────────────────────────────────────────────────────────────

/** Everything needed to reach one sandbox's data plane. SECRET: memory only. */
export interface DataPlaneAccess {
  sandboxId: string;
  sandboxKey: string;
  domain: string;
  /** `{sandbox_key}.{domain}` (checked). */
  host: string;
  baseUrl: string;
  accessToken: string;
  /** Port previews (`traffic-access-token` header, exact host only, §8.4). */
  trafficToken: string;
  /** GMI's authoritative expiry from connect; null after a create (unknown until the first connect). */
  endAt: string | null;
  fetchedAt: string;
}

export interface TokenCache {
  /** Valid access, refreshed when missing or within 60 s of `end_at`. Single-flight per sandbox. */
  get(sandboxId: string): Promise<DataPlaneAccess>;
  /** Forces a new `connect` (data-plane 401). Concurrent callers share one call. */
  refresh(sandboxId: string): Promise<DataPlaneAccess>;
  /** After resume, a timeout change or delete: the next `get` connects again. */
  invalidate(sandboxId: string): void;
  peek(sandboxId: string): DataPlaneAccess | null;
  /** Seeds the cache from a create result (no connect right after create). */
  put(result: V2CreateSandboxResult | V2ConnectResult): DataPlaneAccess;
  clear(): void;
}

/** Refresh this long before `end_at`. */
export const TOKEN_REFRESH_BEFORE_MS = 60_000;

const SANDBOX_KEY = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAIN = /^(?=.{3,200}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** Builds and checks the data-plane origin from GMI's `sandbox_key` and `domain` (never composed by the app). */
export function dataPlaneAccessFrom(result: V2CreateSandboxResult | V2ConnectResult, now: Date): DataPlaneAccess {
  const key = result.sandbox_key;
  const domain = result.domain;
  if (!SANDBOX_KEY.test(key) || !DOMAIN.test(domain)) {
    throw new ComputeHttpError('upstream', 'GMI returned an invalid sandbox address.', { family: 'v2', status: 200, parsed: false });
  }
  const host = `${key}.${domain}`.toLowerCase();
  const url = new URL(`https://${host}`);
  if (url.host !== host) throw new ComputeHttpError('upstream', 'GMI returned an invalid sandbox address.', { family: 'v2', status: 200, parsed: false });
  if (!result.sandbox_access_token) throw new ComputeHttpError('upstream', 'GMI did not return a sandbox token.', { family: 'v2', status: 200, parsed: false });
  return {
    sandboxId: result.id,
    sandboxKey: key,
    domain: domain.toLowerCase(),
    host,
    baseUrl: `https://${host}`,
    accessToken: result.sandbox_access_token,
    trafficToken: result.traffic_access_token ?? '',
    endAt: 'end_at' in result && typeof result.end_at === 'string' && result.end_at ? result.end_at : null,
    fetchedAt: now.toISOString(),
  };
}

export function createTokenCache(deps: { connect: (sandboxId: string) => Promise<V2ConnectResult>; now?: () => Date }): TokenCache {
  const now = deps.now ?? (() => new Date());
  const entries = new Map<string, DataPlaneAccess>();
  const inflight = new Map<string, Promise<DataPlaneAccess>>();
  /** Bumped by invalidate: a connect that started before it must not repopulate the cache. */
  const generation = new Map<string, number>();

  function refresh(id: string): Promise<DataPlaneAccess> {
    const running = inflight.get(id);
    if (running) return running;
    const gen = generation.get(id) ?? 0;
    const p = (async () => {
      try {
        const access = dataPlaneAccessFrom(await deps.connect(id), now());
        if ((generation.get(id) ?? 0) === gen) entries.set(id, access);
        return access;
      } finally {
        inflight.delete(id);
      }
    })();
    inflight.set(id, p);
    return p;
  }

  const fresh = (a: DataPlaneAccess) => !a.endAt || Date.parse(a.endAt) - now().getTime() > TOKEN_REFRESH_BEFORE_MS;

  return {
    async get(id) {
      const cached = entries.get(id);
      if (cached && fresh(cached)) return cached;
      return refresh(id);
    },
    refresh,
    invalidate(id) {
      entries.delete(id);
      generation.set(id, (generation.get(id) ?? 0) + 1);
    },
    peek: (id) => entries.get(id) ?? null,
    put(result) {
      const access = dataPlaneAccessFrom(result, now());
      entries.set(access.sandboxId, access);
      return access;
    },
    clear() {
      for (const id of entries.keys()) generation.set(id, (generation.get(id) ?? 0) + 1);
      entries.clear();
    },
  };
}

// ─── Data plane ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ExecInput {
  command: string;
  /** Paths and user values go here, never into `command` (§8.3). */
  envs?: Record<string, string>;
  cwd?: string;
  /** Always explicit (1..3600). */
  timeoutSec: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** As soon as GMI names the execution (before it is terminal). */
  onAccepted?: (eid: string) => void | Promise<void>;
}

export interface ReadFileResult {
  bytes: Uint8Array;
  /** Content-Length when sent, else the bytes read when the whole file was read; null when truncated without a length. */
  size: number | null;
  truncated: boolean;
}

export interface DownloadResult {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  /** True only for a 206 to a Range request: append to the partial file. False: start from zero. */
  resumed: boolean;
  acceptRanges: boolean;
  /** Full file size when known. */
  totalBytes: number | null;
}

export interface DataPlaneApi {
  /** POST (25 s wait) then poll until terminal. Aborting cancels the remote execution. */
  exec(sandboxId: string, input: ExecInput): Promise<V2ExecResult>;
  /** One POST only (25 s wait): a result when it finished in time, else the accepted execution. */
  startExec(sandboxId: string, input: ExecInput): Promise<V2ExecResult | V2ExecAccepted>;
  getExecution(sandboxId: string, eid: string): Promise<V2ExecResult>;
  waitExecution(sandboxId: string, eid: string, opts?: { signal?: AbortSignal }): Promise<V2ExecResult>;
  /** POST /executions/{eid}/cancel. Already finished / cancelling (409) is fine. */
  cancelExecution(sandboxId: string, eid: string): Promise<void>;
  readFile(sandboxId: string, path: string, opts?: { maxBytes?: number; signal?: AbortSignal }): Promise<ReadFileResult>;
  /** Multipart POST, part `file`. `[]` → error. The parent directory must exist [V]. */
  writeFile(sandboxId: string, path: string, data: Uint8Array | string | Blob, opts?: { signal?: AbortSignal }): Promise<V2FileEntry[]>;
  download(sandboxId: string, path: string, opts?: { offset?: number; signal?: AbortSignal }): Promise<DownloadResult>;
  shellLaunch(sandboxId: string, opts?: { signal?: AbortSignal }): Promise<V2ShellLaunch>;
  shellControl(sandboxId: string, req: V2ShellControlRequest): Promise<V2ShellControlResponse>;
  /** Where C2-A's `ws` connects (main only; the token travels in a header). */
  shellSocket(sandboxId: string, connectUrl: string): Promise<{ url: string; headers: Record<string, string> }>;
  readonly tokens: TokenCache;
}

export interface DataPlaneDeps {
  http: Http;
  log: Logger;
  tokens: TokenCache;
  trace?: ComputeTrace | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Poll delays (ms) after the 25 s wait; the last value repeats. */
export const EXEC_POLL_DELAYS_MS = [1_000, 1_000, 2_000, 2_000, 3_000, 5_000] as const;
export const SHELL_CREATING_RETRY = { delayMs: 1_000, max: 15 } as const;
export const DATAPLANE_TIMEOUT_MS = 40_000;

const TERMINAL: ReadonlySet<string> = new Set(V2_EXEC_TERMINAL_STATUSES);
export const isTerminalExec = (status: string | null | undefined): boolean => typeof status === 'string' && TERMINAL.has(status);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Client-side checks of an exec request (§8.1, v2 limits). Throws invalid_input. */
export function validateExecInput(input: ExecInput): void {
  const t = input.timeoutSec;
  if (!Number.isInteger(t) || t < V2_EXEC_TIMEOUT_MIN_SEC || t > V2_EXEC_TIMEOUT_MAX_SEC) {
    throw new GmiError('invalid_input', `execution_timeout_seconds must be ${V2_EXEC_TIMEOUT_MIN_SEC}–${V2_EXEC_TIMEOUT_MAX_SEC}.`);
  }
  if (typeof input.command !== 'string' || !input.command || input.command.includes('\0') || utf8Bytes(input.command) > V2_EXEC_COMMAND_MAX_BYTES) {
    throw new GmiError('invalid_input', 'The command is empty, too long or contains a NUL byte.');
  }
  for (const [name, value] of Object.entries(input.envs ?? {})) {
    if (!ENV_NAME.test(name) || utf8Bytes(name) > 128) throw new GmiError('invalid_input', `Not a valid environment variable name: ${name.slice(0, 40)}`);
    if (typeof value !== 'string' || value.includes('\0') || utf8Bytes(value) > V2_EXEC_ENV_VALUE_MAX_BYTES) {
      throw new GmiError('invalid_input', `The value of ${name} is too long or contains a NUL byte.`);
    }
  }
  if (input.cwd !== undefined) assertRemotePath(input.cwd);
}

/** Absolute, normalised POSIX path without NUL, at most 4096 bytes (§8.3; the files layer normalises first). */
export function assertRemotePath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || utf8Bytes(path) > 4096) {
    throw new GmiError('invalid_input', 'Remote paths must be absolute.');
  }
  if (path !== '/' && (path.endsWith('/') || path.split('/').slice(1).some((s) => s === '' || s === '.' || s === '..'))) {
    throw new GmiError('invalid_input', 'Remote paths must be normalised (no empty, "." or ".." parts).');
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Normalises a data-plane exec body (accepted or result) into a full result shape. */
export function toExecResult(body: unknown): V2ExecResult | null {
  if (!isObj(body) || typeof body.execution_id !== 'string' || typeof body.status !== 'string') return null;
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : null);
  const b = (k: string) => (typeof body[k] === 'boolean' ? (body[k] as boolean) : null);
  return {
    request_id: s('request_id') ?? '',
    execution_id: body.execution_id,
    sandbox_id: s('sandbox_id') ?? '',
    status: body.status,
    ...(s('termination_reason') ? { termination_reason: s('termination_reason') as string } : {}),
    ...(s('failure_reason') ? { failure_reason: s('failure_reason') as string } : {}),
    exit_code: typeof body.exit_code === 'number' ? body.exit_code : null,
    stdout: s('stdout'),
    stderr: s('stderr'),
    stdout_truncated: b('stdout_truncated'),
    stderr_truncated: b('stderr_truncated'),
    started_at: s('started_at'),
    completed_at: s('completed_at'),
  };
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new GmiError('cancelled', 'Cancelled.'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new GmiError('cancelled', 'Cancelled.'));
      },
      { once: true },
    );
  });

function pathQuery(path: string): Record<string, string> {
  assertRemotePath(path);
  return { path };
}

export function createDataPlane(deps: DataPlaneDeps): DataPlaneApi {
  const log = deps.log.child('compute.dataplane');
  const r: ComputeRequestDeps = { http: deps.http, log, trace: deps.trace ?? null };
  const sleep = deps.sleep ?? defaultSleep;
  const { tokens } = deps;

  /** Runs `fn` with valid access; one token refresh and one retry after a data-plane 401 (it was not accepted). */
  async function withAccess<T>(sandboxId: string, fn: (a: DataPlaneAccess) => Promise<T>): Promise<T> {
    const access = await tokens.get(sandboxId);
    try {
      return await fn(access);
    } catch (error) {
      if (!(error instanceof GmiError) || error.status !== 401) throw error;
      log.info('data-plane token refused; reconnecting', { status: 401 });
      const again = await tokens.refresh(sandboxId);
      return fn(again);
    }
  }

  const headers = (a: DataPlaneAccess, extra?: Record<string, string>) => ({ 'X-Access-Token': a.accessToken, ...extra });

  async function startExec(sandboxId: string, input: ExecInput): Promise<V2ExecResult | V2ExecAccepted> {
    validateExecInput(input);
    const body = {
      action: 'exec' as const,
      parameters: {
        command: input.command,
        ...(input.envs && Object.keys(input.envs).length ? { envs: input.envs } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        execution_timeout_seconds: input.timeoutSec,
      },
    };
    const res = await withAccess(sandboxId, (a) =>
      computeJson<unknown>(r, {
        family: 'dataplane',
        method: 'POST',
        url: `${a.baseUrl}/executions`,
        query: { wait: true, wait_timeout_seconds: V2_EXEC_WAIT_TIMEOUT_MAX_SEC },
        json: body,
        headers: headers(a, input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : undefined),
        retries: 0,
        timeoutMs: DATAPLANE_TIMEOUT_MS,
        signal: input.signal,
      }),
    );
    const result = toExecResult(res.body);
    if (!result) throw new ComputeHttpError('upstream', 'The sandbox answered the command in an unexpected way.', { family: 'dataplane', status: res.status, parsed: false });
    if (input.onAccepted) await input.onAccepted(result.execution_id);
    return result;
  }

  async function getExecution(sandboxId: string, eid: string): Promise<V2ExecResult> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(eid)) throw new GmiError('invalid_input', 'Not a valid execution id.');
    const res = await withAccess(sandboxId, (a) =>
      computeJson<unknown>(r, { family: 'dataplane', url: `${a.baseUrl}/executions/${encodeURIComponent(eid)}`, headers: headers(a), retries: 2, timeoutMs: DATAPLANE_TIMEOUT_MS }),
    );
    const result = toExecResult(res.body);
    if (!result) throw new ComputeHttpError('upstream', 'The sandbox returned an unexpected execution.', { family: 'dataplane', status: res.status, parsed: false });
    return result;
  }

  async function cancelExecution(sandboxId: string, eid: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(eid)) throw new GmiError('invalid_input', 'Not a valid execution id.');
    try {
      await withAccess(sandboxId, (a) =>
        computeRequest(r, { family: 'dataplane', method: 'POST', url: `${a.baseUrl}/executions/${encodeURIComponent(eid)}/cancel`, headers: headers(a), retries: 0, timeoutMs: DATAPLANE_TIMEOUT_MS }),
      );
    } catch (error) {
      // AlreadyCancelled / CancelInProgress / AlreadyCompleted: nothing left to cancel.
      if (error instanceof ComputeHttpError && error.status === 409) return;
      throw error;
    }
  }

  async function waitExecution(sandboxId: string, eid: string, opts: { signal?: AbortSignal } = {}): Promise<V2ExecResult> {
    for (let i = 0; ; i += 1) {
      try {
        await sleep(EXEC_POLL_DELAYS_MS[Math.min(i, EXEC_POLL_DELAYS_MS.length - 1)] as number, opts.signal);
      } catch (error) {
        await cancelExecution(sandboxId, eid).catch((e: unknown) => log.warn('cancel after abort failed', { code: e instanceof GmiError ? e.code : 'internal' }));
        throw error;
      }
      const result = await getExecution(sandboxId, eid);
      if (isTerminalExec(result.status)) return result;
    }
  }

  return {
    tokens,
    startExec,
    getExecution,
    waitExecution,
    cancelExecution,
    async exec(sandboxId, input) {
      const first = await startExec(sandboxId, input);
      if (isTerminalExec(first.status)) return first as V2ExecResult;
      return waitExecution(sandboxId, first.execution_id, { signal: input.signal });
    },
    async readFile(sandboxId, path, opts = {}) {
      const max = Math.max(0, opts.maxBytes ?? 2 * 1024 * 1024);
      return withAccess(sandboxId, async (a) => {
        const res = await computeRequest(r, {
          family: 'dataplane',
          url: `${a.baseUrl}/files`,
          query: pathQuery(path),
          headers: headers(a, { Accept: '*/*' }),
          retries: 2,
          timeoutMs: DATAPLANE_TIMEOUT_MS,
          signal: opts.signal,
        });
        const declared = Number(res.headers.get('content-length'));
        const chunks: Uint8Array[] = [];
        let read = 0;
        let truncated = false;
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            if (read + value.byteLength > max) {
              chunks.push(value.subarray(0, max - read));
              read = max;
              truncated = true;
              await reader.cancel().catch(() => undefined);
              break;
            }
            chunks.push(value);
            read += value.byteLength;
          }
        }
        const bytes = new Uint8Array(read);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.byteLength;
        }
        const size = Number.isFinite(declared) && res.headers.get('content-length') !== null ? declared : truncated ? null : read;
        return { bytes, size, truncated };
      });
    },
    async writeFile(sandboxId, path, data, opts = {}) {
      const query = pathQuery(path);
      const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? new TextEncoder().encode(data) : data]);
      if (blob.size > UPLOAD_MAX_BYTES) throw new GmiError('invalid_input', 'Files larger than 500 MB cannot be uploaded. Split it, or fetch it from inside the sandbox.');
      const res = await withAccess(sandboxId, (a) => {
        const form = new FormData();
        form.append('file', blob, basename(path) || 'file');
        return computeJson<unknown>(r, {
          family: 'dataplane',
          method: 'POST',
          url: `${a.baseUrl}/files`,
          query,
          body: form,
          headers: headers(a),
          retries: 0,
          timeoutMs: 0,
          signal: opts.signal,
        });
      });
      const entries = Array.isArray(res.body) ? res.body.filter((e): e is V2FileEntry => isObj(e) && typeof e.path === 'string') : [];
      if (entries.length === 0) throw new ComputeHttpError('upstream', 'GMI did not store the file.', { family: 'dataplane', status: res.status, parsed: false });
      return entries;
    },
    async download(sandboxId, path, opts = {}) {
      const offset = Math.max(0, Math.floor(opts.offset ?? 0));
      return withAccess(sandboxId, async (a) => {
        const res = await computeRequest(r, {
          family: 'dataplane',
          url: `${a.baseUrl}/files`,
          query: pathQuery(path),
          headers: headers(a, { Accept: '*/*', ...(offset > 0 ? { Range: `bytes=${offset}-` } : {}) }),
          retries: 0,
          timeoutMs: 0,
          signal: opts.signal,
        });
        const resumed = offset > 0 && res.status === 206;
        const length = res.headers.get('content-length');
        const range = res.headers.get('content-range');
        const rangeTotal = range ? Number(/\/(\d+)\s*$/.exec(range)?.[1] ?? NaN) : NaN;
        const totalBytes = Number.isFinite(rangeTotal) ? rangeTotal : length !== null && Number.isFinite(Number(length)) ? Number(length) + (resumed ? offset : 0) : null;
        return {
          status: res.status,
          body: res.body,
          resumed,
          acceptRanges: /\bbytes\b/i.test(res.headers.get('accept-ranges') ?? ''),
          totalBytes,
        };
      });
    },
    async shellLaunch(sandboxId, opts = {}) {
      for (let attempt = 0; ; attempt += 1) {
        const res = await withAccess(sandboxId, (a) =>
          computeJson<unknown>(r, { family: 'dataplane', method: 'POST', url: `${a.baseUrl}/shell`, json: {}, headers: headers(a), retries: 0, timeoutMs: DATAPLANE_TIMEOUT_MS, signal: opts.signal }),
        );
        const body = res.body;
        if (res.status === 202 || (isObj(body) && body.status === 'creating')) {
          if (attempt >= SHELL_CREATING_RETRY.max) throw new ComputeHttpError('timeout', 'The sandbox shell did not start in time.', { family: 'dataplane', status: 202, parsed: false });
          await sleep(SHELL_CREATING_RETRY.delayMs, opts.signal);
          continue;
        }
        if (!isObj(body) || typeof body.connect_url !== 'string' || typeof body.status !== 'string') {
          throw new ComputeHttpError('upstream', 'The sandbox answered the shell request in an unexpected way.', { family: 'dataplane', status: res.status, parsed: false });
        }
        return {
          request_id: typeof body.request_id === 'string' ? body.request_id : '',
          sandbox_key: typeof body.sandbox_key === 'string' ? body.sandbox_key : '',
          status: body.status,
          connect_url: body.connect_url,
        };
      }
    },
    async shellControl(sandboxId, req) {
      if (req.action === 'resize') {
        const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= V2_SHELL_SIZE_MAX;
        if (!ok(req.cols) || !ok(req.rows)) throw new GmiError('invalid_input', `Terminal size must be 1–${V2_SHELL_SIZE_MAX}.`);
      }
      const once = () =>
        withAccess(sandboxId, (a) =>
          computeJson<unknown>(r, { family: 'dataplane', method: 'POST', url: `${a.baseUrl}/shell/control`, json: req, headers: headers(a), retries: 0, timeoutMs: DATAPLANE_TIMEOUT_MS }),
        );
      let res: Awaited<ReturnType<typeof once>>;
      try {
        res = await once();
      } catch (error) {
        if (req.action === 'resize' && error instanceof ComputeHttpError && error.status === 502 && error.remoteCode === 'Shell.ResizeFailed') res = await once();
        else throw error;
      }
      const body = isObj(res.body) ? res.body : {};
      return {
        request_id: typeof body.request_id === 'string' ? body.request_id : '',
        sandbox_key: typeof body.sandbox_key === 'string' ? body.sandbox_key : '',
        status: typeof body.status === 'string' ? body.status : 'unknown',
      };
    },
    async shellSocket(sandboxId, connectUrl) {
      if (!/^\/[A-Za-z0-9/_.-]*$/.test(connectUrl) || connectUrl.startsWith('//') || connectUrl.includes('..')) {
        throw new ComputeHttpError('upstream', 'The sandbox returned an invalid shell address.', { family: 'dataplane', status: 200, parsed: false });
      }
      const a = await tokens.get(sandboxId);
      const url = new URL(connectUrl, `wss://${a.host}`);
      if (url.host !== a.host) throw new ComputeHttpError('upstream', 'The sandbox returned an invalid shell address.', { family: 'dataplane', status: 200, parsed: false });
      return { url: url.toString(), headers: { 'X-Access-Token': a.accessToken } };
    },
  };
}
