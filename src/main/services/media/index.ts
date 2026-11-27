/**
 * Media slice: estimate → approve → submit → poll, uploads, and the local gallery.
 *
 * Every GMI call goes through the OAuth MCP gateway (no API key). Paid submissions are re-validated and re-priced in
 * the main process and must pass the local BudgetGuard plus an explicit approval of the charged price. Jobs are kept
 * in a local ledger (newest first) and merged with GMI's own history for the gallery; unfinished jobs are polled until
 * they finish, and outputs are copied into the media folder (served to the renderer as gmi-media:// URLs).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GmiError, toGmiError, type GmiErrorCode } from '@shared/contracts/errors';
import {
  isTerminalJobStatus,
  type MediaApi,
  type MediaJob,
  type MediaJobList,
  type MediaJobStatus,
  type MediaModality,
  type MediaOutput,
} from '@shared/contracts/media';
import { formatUsd } from '@shared/lib/money';
import { truncate } from '@shared/lib/format';
import type { AppContext } from '../../core/context';
import { isInsideDir, toMediaUrl } from '../../core/media-paths';
import type { AuthService, BudgetGuard, CatalogService, McpGateway } from '../../core/services';
import { atomicWriteFile } from '../../core/store';
import { isMockMediaUrl, renderMockMedia, seedMockGenerations } from '../../mock/media';
import { createModelResolver, prepareRequest, runEstimate, sanitizeRequest, submitArgs, unpricedRefusal } from './estimate';
import { byNewest, openJobsStore } from './jobs-store';
import { downloadToFile, MAX_OUTPUT_BYTES, outputFilePath, sameOutputUrl, sweepStaleTempFiles, type ExtractedOutput } from './outputs';
import { parseGeneration, parseGenerationList, type ParsedGeneration, type RemoteGeneration } from './parse';
import { createPoller } from './poller';
import { pickAndUpload } from './uploads';

export interface MediaSlice {
  api: MediaApi;
  dispose(): void | Promise<void>;
}

export interface MediaDeps {
  auth: AuthService;
  mcp: McpGateway;
  catalog: CatalogService;
  budget: BudgetGuard;
}

/** Tuning knobs (tests); production uses the defaults. */
export interface MediaSliceOptions {
  /** Delay before unfinished jobs resume polling at startup. Default 1.5s. */
  resumeDelayMs?: number;
  /** Poll interval per modality. Defaults: 3s image/audio, 8s video/workflow. */
  pollIntervalMs?: Partial<Record<MediaModality, number>>;
  /** Jobs older than this stop being polled. Default 2h. */
  maxPollAgeMs?: number;
  /** Mock mode: seed a demo gallery on first run. Default true. */
  seedDemo?: boolean;
}

const DEFAULT_INTERVALS: Record<MediaModality, number> = { image: 3000, audio: 3000, video: 8000, workflow: 8000, other: 5000 };
const MAX_POLL_AGE_MS = 2 * 60 * 60_000;
/** GMI forgets old requests; stop after this many consecutive "not found" answers. */
const MAX_NOT_FOUND = 3;
/** Seconds GMI may hold an image/audio submission open to return the finished media directly. */
const SUBMIT_WAIT_SECONDS = 8;
const AUTH_CODES: ReadonlySet<GmiErrorCode> = new Set(['not_signed_in', 'reauth_required', 'insufficient_scope', 'unauthorized']);
const UNKNOWN_MODEL = 'unknown';

const JOB_ID = /^[\w.:-]{1,200}$/;

function sanitizeId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID.test(value)) throw new GmiError('invalid_input', 'Invalid job id.');
  return value;
}

function sanitizeIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 999) throw new GmiError('invalid_input', 'Invalid output index.');
  return value;
}

function looksNotFound(error: GmiError): boolean {
  return error.code === 'not_found' || /no generation|not found|unknown request/i.test(error.message);
}

function outputsEqual(a: MediaOutput[], b: MediaOutput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function createMediaSlice(ctx: AppContext, deps: MediaDeps, options: MediaSliceOptions = {}): Promise<MediaSlice> {
  const log = ctx.log.child('media');
  const store = await openJobsStore(join(ctx.paths.data, 'media-jobs.json'), log);
  const resolver = createModelResolver({ catalog: deps.catalog, mcp: deps.mcp, now: () => ctx.now().getTime(), log });
  const intervals: Record<MediaModality, number> = { ...DEFAULT_INTERVALS, ...options.pollIntervalMs };
  const maxPollAge = options.maxPollAgeMs ?? MAX_POLL_AGE_MS;
  const lifetime = new AbortController();
  const downloads = new Map<string, Promise<MediaJob>>();
  /** One get_generation round-trip per job at a time (the poller, the job dialog and listJobs share it). */
  const refreshing = new Map<string, Promise<MediaJob>>();
  const remoteIndex = new Map<string, RemoteGeneration>();
  let submitChain: Promise<unknown> = Promise.resolve();
  let disposed = false;

  const nowIso = () => ctx.now().toISOString();
  const emit = (job: MediaJob) => {
    if (!disposed) ctx.events.emit('media:job', job);
  };
  const isExpired = (job: MediaJob) => ctx.now().getTime() - Date.parse(job.createdAt) > maxPollAge;

  function requireSignedIn(): void {
    if (deps.auth.isSignedIn()) return;
    const status = deps.auth.getState().status;
    if (status === 'reauth_required') throw new GmiError('reauth_required', 'Your GMI sign-in expired. Sign in again to generate media.');
    throw new GmiError('not_signed_in', 'Sign in with GMI to generate media.');
  }

  // ------------------------------------------------------------------------------------------ ledger updates

  function remoteJob(id: string, parsed: ParsedGeneration | null): MediaJob {
    const listed = remoteIndex.get(id);
    const createdAt = listed?.createdAt ?? parsed?.createdAt ?? nowIso();
    return {
      id,
      modelId: parsed?.modelId ?? listed?.modelId ?? UNKNOWN_MODEL,
      modality: listed?.modality ?? parsed?.modality ?? 'other',
      status: listed?.status ?? 'unknown',
      prompt: null,
      parameters: {},
      estimateUsd: null,
      createdAt,
      updatedAt: createdAt,
      outputs: [],
      error: null,
      fromThisDevice: false,
    };
  }

  function mergeOutputs(existing: MediaOutput[], incoming: ExtractedOutput[]): MediaOutput[] {
    return incoming.map((o) => {
      const prev = existing.find((e) => sameOutputUrl(e.url, o.url));
      return {
        url: o.url,
        kind: o.kind,
        mimeType: o.mimeType ?? prev?.mimeType ?? null,
        localPath: prev?.localPath ?? null,
        localUrl: prev?.localUrl ?? null,
        bytes: prev?.bytes ?? null,
      };
    });
  }

  /** Folds a get_generation/submit result into the ledger; persists and emits only when something changed. */
  async function applyGeneration(id: string, parsed: ParsedGeneration, existing: MediaJob | null): Promise<MediaJob> {
    const base = existing ?? remoteJob(id, parsed);
    const status: MediaJobStatus = parsed.status !== 'unknown' ? parsed.status : base.status;
    const outputs = parsed.outputs.length ? mergeOutputs(base.outputs, parsed.outputs) : base.outputs;
    let error: string | null = null;
    if (status === 'failed') error = parsed.error ?? base.error ?? 'GMI reported that the generation failed.';
    else if (status === 'cancelled') error = parsed.error ?? base.error ?? 'The generation was cancelled.';
    const modality = base.modality === 'other' && parsed.modality ? parsed.modality : base.modality;
    const next: MediaJob = {
      ...base,
      status,
      outputs,
      error,
      modality,
      modelId: base.modelId === UNKNOWN_MODEL && parsed.modelId ? parsed.modelId : base.modelId,
      posterUrl: parsed.posterUrl ?? base.posterUrl ?? null,
    };
    if (isTerminalJobStatus(status)) {
      delete next.pollingStopped;
      // Only a transition this app watched has a meaningful finish time (history entries arrive finished).
      if (existing && !isTerminalJobStatus(existing.status)) next.finishedAt = nowIso();
    }
    const changed =
      !existing ||
      next.status !== base.status ||
      next.error !== base.error ||
      next.modelId !== base.modelId ||
      next.modality !== base.modality ||
      next.posterUrl !== (base.posterUrl ?? null) ||
      next.pollingStopped !== base.pollingStopped ||
      !outputsEqual(next.outputs, base.outputs);
    if (!changed) return base;
    next.updatedAt = nowIso();
    store.upsert(next);
    emit(next);
    return next;
  }

  function markPollingStopped(id: string, error: string | null): void {
    const job = store.update(id, (j) => ({ ...j, pollingStopped: true, error: error ?? j.error, updatedAt: nowIso() }));
    if (job) emit(job);
  }

  function notifyFinished(job: MediaJob): void {
    // Images usually finish while the user is watching; long jobs get a desktop notification.
    if (job.modality === 'image' && ctx.now().getTime() - Date.parse(job.createdAt) < 60_000) return;
    const what = job.modality === 'video' ? 'Video' : job.modality === 'audio' ? 'Audio' : job.modality === 'image' ? 'Image' : 'Generation';
    ctx.platform.notify({
      title: job.status === 'success' ? `${what} ready` : `${what} ${job.status === 'cancelled' ? 'cancelled' : 'failed'}`,
      body: truncate(job.status === 'success' ? (job.prompt ?? job.modelId) : (job.error ?? job.modelId), 120),
      onClick: () => ctx.events.emit('app:navigate', { page: 'create' }),
    });
  }

  /**
   * Pulls the latest state of one request from GMI into the ledger. Concurrent callers for the same job share one
   * round-trip, and GMI's answer is applied to the job as it is when the answer arrives (not as it was when the call
   * started), so a finish is announced and saved once and a local copy saved meanwhile is kept.
   */
  function refreshJob(id: string): Promise<MediaJob> {
    const pending = refreshing.get(id);
    if (pending) return pending;
    const task = (async () => {
      const asked = store.get(id);
      const raw = await deps.mcp.callTool('get_generation', { request_id: id }, { timeoutMs: 30_000 });
      if (disposed) throw new GmiError('cancelled', 'GMI Desk is closing.');
      const current = store.get(id);
      const parsed = parseGeneration(raw, current?.modality ?? asked?.modality ?? remoteIndex.get(id)?.modality ?? null);
      const before = current?.status ?? null;
      const job = await applyGeneration(id, parsed, current);
      if (isTerminalJobStatus(job.status) && before !== job.status) {
        if (job.status === 'success') void autoSave(job.id);
        if (job.fromThisDevice && before !== null && !isTerminalJobStatus(before)) notifyFinished(job);
      }
      return job;
    })().finally(() => refreshing.delete(id));
    refreshing.set(id, task);
    return task;
  }

  // ------------------------------------------------------------------------------------------ downloads

  function ensureDownloaded(jobId: string, index: number): Promise<MediaJob> {
    const key = `${jobId}#${index}`;
    const pending = downloads.get(key);
    if (pending) return pending;
    const task = (async () => {
      if (disposed) throw new GmiError('cancelled', 'GMI Desk is closing.');
      const job = store.get(jobId);
      if (!job) throw new GmiError('not_found', 'That job is no longer in the gallery.');
      const output = job.outputs[index];
      if (!output) throw new GmiError('not_found', 'That output does not exist.');
      if (output.localPath && isInsideDir(ctx.paths.media, output.localPath) && existsSync(output.localPath)) return job;
      const dest = outputFilePath(ctx.paths.media, job.id, index, output);
      let bytes: number;
      let contentType: string | null;
      if (ctx.mock && isMockMediaUrl(output.url)) {
        const rendered = renderMockMedia(output.url);
        if (!rendered) throw new GmiError('not_found', 'This demo output is not available.');
        await atomicWriteFile(dest, rendered.data);
        bytes = rendered.data.byteLength;
        contentType = rendered.mimeType;
      } else {
        ({ bytes, contentType } = await downloadToFile(ctx.http, output.url, dest, { maxBytes: MAX_OUTPUT_BYTES, signal: lifetime.signal }));
      }
      const localUrl = toMediaUrl(ctx.paths.media, dest);
      const updated = store.update(jobId, (current) => ({
        ...current,
        outputs: current.outputs.map((o, i) =>
          i === index && sameOutputUrl(o.url, output.url) ? { ...o, localPath: dest, localUrl, bytes, mimeType: o.mimeType ?? contentType } : o,
        ),
        updatedAt: nowIso(),
      }));
      if (!updated) throw new GmiError('not_found', 'That job is no longer in the gallery.');
      emit(updated);
      return updated;
    })().finally(() => downloads.delete(key));
    downloads.set(key, task);
    return task;
  }

  /**
   * Copies every output of a finished job from this device into the media folder (when the setting is on).
   * Mock outputs always materialise locally: their placeholder URLs cannot be loaded remotely.
   */
  async function autoSave(jobId: string): Promise<void> {
    const job = store.get(jobId);
    if (!job || job.status !== 'success') return;
    const mockOutputs = ctx.mock && job.outputs.some((o) => isMockMediaUrl(o.url));
    if (!mockOutputs && (!job.fromThisDevice || !ctx.settings.get().saveMediaLocally)) return;
    for (let i = 0; i < job.outputs.length; i += 1) {
      if (disposed) return;
      try {
        await ensureDownloaded(jobId, i);
      } catch (error) {
        if (!disposed) log.warn(`could not save output ${i} of ${jobId}`, { code: toGmiError(error).code, message: toGmiError(error).message });
      }
    }
  }

  // ------------------------------------------------------------------------------------------ polling

  const poller = createPoller({
    async refresh(id) {
      const job = store.get(id);
      if (!job || isTerminalJobStatus(job.status)) return true;
      if (!deps.auth.isSignedIn()) throw new GmiError('not_signed_in', 'Sign in to keep checking this job.');
      const updated = await refreshJob(id);
      return isTerminalJobStatus(updated.status);
    },
    intervalMs: (id) => intervals[store.get(id)?.modality ?? 'other'],
    expired(id) {
      const job = store.get(id);
      return !job || isExpired(job);
    },
    onError(id, error, failures) {
      const err = toGmiError(error);
      if (AUTH_CODES.has(err.code)) return 'stop'; // resumes after the next sign-in
      if (looksNotFound(err) && failures >= MAX_NOT_FOUND) {
        markPollingStopped(id, 'GMI no longer has this request.');
        return 'stop';
      }
      return 'retry';
    },
    onStop(id, reason) {
      if (reason === 'expired' && store.get(id)) markPollingStopped(id, null);
    },
    log,
  });

  function resumePolling(): void {
    if (disposed) return;
    let stagger = 0;
    for (const job of store.list()) {
      if (!job.fromThisDevice || isTerminalJobStatus(job.status) || job.pollingStopped || poller.isPolling(job.id)) continue;
      if (isExpired(job)) {
        markPollingStopped(job.id, null);
        continue;
      }
      poller.start(job.id, { delayMs: stagger });
      stagger += 250;
    }
  }

  // ------------------------------------------------------------------------------------------ startup

  // Partial downloads and temp files left by a crash, a kill or a quit that did not wait (in the background).
  const sweeping = sweepStaleTempFiles(ctx.paths.media)
    .then((removed) => {
      if (removed) log.info(`removed ${removed} leftover temp file(s) from the media folder`);
    })
    .catch((error: unknown) => log.debug('media temp sweep failed', error));

  if (ctx.mock && options.seedDemo !== false && store.isEmpty()) {
    for (const job of seedMockGenerations(ctx.now().getTime())) store.upsert(job);
    void (async () => {
      for (const job of store.list()) if (job.status === 'success') await autoSave(job.id);
    })();
  }

  const resumeTimer = setTimeout(resumePolling, options.resumeDelayMs ?? 1500);
  (resumeTimer as { unref?: () => void }).unref?.();
  const unsubscribeAuth = deps.auth.onChange((state) => {
    if (state.status === 'signed_in') {
      resolver.clear();
      resumePolling();
    }
  });

  // ------------------------------------------------------------------------------------------ API

  async function listRemote(want: number, modality?: MediaModality): Promise<{ items: RemoteGeneration[]; total: number }> {
    const items: RemoteGeneration[] = [];
    let total = 0;
    while (items.length < want) {
      const limit = Math.min(100, want - items.length);
      const args: Record<string, unknown> = { limit, offset: items.length };
      if (modality) args.modality = modality;
      const page = parseGenerationList(await deps.mcp.callTool('list_generations', args, { timeoutMs: 20_000 }));
      items.push(...page.items);
      total = page.total ?? items.length;
      if (page.items.length < limit) break;
    }
    for (const item of items) remoteIndex.set(item.requestId, item);
    return { items, total: Math.max(total, items.length) };
  }

  const api: MediaApi = {
    async estimate(raw) {
      const req = sanitizeRequest(raw);
      const prepared = await prepareRequest(resolver, req);
      return runEstimate(deps, prepared);
    },

    submit(raw) {
      // Submissions are serialised so two quick runs cannot both pass the same budget check.
      const run = submitChain.then(() => submitOne(raw));
      submitChain = run.catch(() => undefined);
      return run;
    },

    async getJob(rawId) {
      const id = sanitizeId(rawId);
      const local = store.get(id);
      const fresh = local && isTerminalJobStatus(local.status) && (local.status !== 'success' || local.outputs.length > 0);
      if (fresh) return local;
      if (!deps.auth.isSignedIn()) {
        if (local) return local;
        requireSignedIn();
      }
      try {
        const job = await refreshJob(id);
        if (job.fromThisDevice && !isTerminalJobStatus(job.status) && !isExpired(job)) poller.start(job.id);
        return job;
      } catch (error) {
        if (local) return local;
        const err = toGmiError(error);
        if (looksNotFound(err)) {
          throw new GmiError('not_found', 'GMI no longer has the details of this generation (older requests expire).', { cause: error });
        }
        throw err;
      }
    },

    async listJobs(opts = {}) {
      const limit = Math.min(Math.max(Math.floor(Number(opts?.limit ?? 60)) || 60, 1), 500);
      const offset = Math.min(Math.max(Math.floor(Number(opts?.offset ?? 0)) || 0, 0), 5000);
      const modality = opts?.modality && ['image', 'video', 'audio', 'workflow', 'other'].includes(opts.modality) ? opts.modality : undefined;
      const local = store.list().filter((j) => !modality || j.modality === modality);
      let remote: RemoteGeneration[] = [];
      let remoteTotal = 0;
      let remoteError: string | null = null;
      if (deps.auth.isSignedIn()) {
        try {
          const res = await listRemote(Math.min(offset + limit, 500), modality);
          remote = res.items;
          remoteTotal = res.total;
        } catch (error) {
          const err = toGmiError(error);
          if (err.code !== 'not_implemented' && !AUTH_CODES.has(err.code)) remoteError = err.message;
          log.debug('list_generations unavailable', { code: err.code });
        }
      }

      const merged = new Map<string, MediaJob>();
      for (const job of local) merged.set(job.id, job);
      const remoteIds = new Set<string>();
      for (const item of remote) {
        remoteIds.add(item.requestId);
        const mine = merged.get(item.requestId);
        if (!mine) {
          merged.set(item.requestId, remoteJob(item.requestId, null));
        } else if (!isTerminalJobStatus(mine.status) && isTerminalJobStatus(item.status) && !poller.isPolling(mine.id)) {
          // Finished while the app was not watching: fetch the result in the background.
          void api.getJob(mine.id).catch(() => undefined);
        }
      }
      const jobs = [...merged.values()].sort(byNewest);
      let total = jobs.length;
      if (remote.length) {
        const oldestRemote = Math.min(...remote.map((r) => (r.createdAt ? Date.parse(r.createdAt) : Number.POSITIVE_INFINITY)));
        const localOnlyNewer = local.filter((j) => !remoteIds.has(j.id) && Date.parse(j.createdAt) >= oldestRemote).length;
        total = Math.max(jobs.length, remoteTotal + localOnlyNewer);
      }
      const result: MediaJobList = { jobs: jobs.slice(offset, offset + limit), total, remoteError };
      return result;
    },

    async pickAndUpload(kind) {
      return pickAndUpload({ ctx, mcp: deps.mcp, requireSignedIn, skipPut: (url) => ctx.mock && isMockMediaUrl(url), signal: lifetime.signal }, kind);
    },

    async saveOutput(rawId, rawIndex) {
      const id = sanitizeId(rawId);
      const index = sanitizeIndex(rawIndex);
      if (!store.get(id)?.outputs.length) await api.getJob(id);
      const job = store.get(id);
      if (!job) throw new GmiError('not_found', 'That job is not available.');
      if (!job.outputs[index]) throw new GmiError('not_found', 'That output does not exist.');
      return ensureDownloaded(id, index);
    },

    async revealOutput(rawId, rawIndex) {
      const job = await api.saveOutput(rawId, rawIndex);
      const path = job.outputs[sanitizeIndex(rawIndex)]?.localPath;
      if (!path || !isInsideDir(ctx.paths.media, path) || !existsSync(path)) throw new GmiError('not_found', 'The local copy is missing.');
      ctx.platform.showItemInFolder(path);
    },
  };

  async function submitOne(raw: unknown): Promise<MediaJob> {
    const input = (raw && typeof raw === 'object' ? raw : {}) as { approvedUsd?: unknown; nonce?: unknown };
    const req = sanitizeRequest(raw);
    const approvedUsd = typeof input.approvedUsd === 'number' && Number.isFinite(input.approvedUsd) ? input.approvedUsd : null;
    const nonce = typeof input.nonce === 'string' && /^[\w-]{1,100}$/.test(input.nonce) ? input.nonce : undefined;
    requireSignedIn();

    const prepared = await prepareRequest(resolver, req);
    // GMI's estimate for these is a flat placeholder: there is no real price to approve, budget or record.
    if (prepared.model.unpriced) throw new GmiError('not_implemented', unpricedRefusal(prepared.model));
    const estimate = await runEstimate(deps, prepared);
    if (!estimate.budget.allowed) {
      throw new GmiError('budget_exceeded', estimate.budget.reason ?? 'This would go over the budget you set in Usage.');
    }
    if (estimate.chargedUsd === null) {
      throw new GmiError('upstream', 'GMI did not return a price for this request, so it was not submitted.');
    }
    if (estimate.budget.needsConfirmation && (approvedUsd === null || approvedUsd + 1e-9 < estimate.chargedUsd)) {
      throw new GmiError(
        'confirmation_required',
        approvedUsd === null
          ? `Approve ${formatUsd(estimate.chargedUsd)} before running this.`
          : `GMI now prices this at ${formatUsd(estimate.chargedUsd)} (you approved ${formatUsd(approvedUsd)}). Approve the new price to run it.`,
      );
    }

    const modality = prepared.model.modality;
    const waitSeconds = modality === 'image' || modality === 'audio' ? SUBMIT_WAIT_SECONDS : undefined;
    let result: unknown;
    try {
      // Never retried automatically: one call is one charge.
      result = await deps.mcp.callTool('submit_generation', submitArgs(prepared, { nonce, waitSeconds }), {
        timeoutMs: waitSeconds ? (waitSeconds + 45) * 1000 : 45_000,
      });
    } catch (error) {
      const err = toGmiError(error);
      if (err.code === 'timeout' || err.code === 'network') {
        throw new GmiError(err.code, 'GMI did not confirm the submission, so it may still have started. Check the gallery before running it again.', {
          cause: error,
        });
      }
      throw err;
    }

    const parsed = parseGeneration(result, modality);
    if (!parsed.requestId && parsed.outputs.length === 0) {
      throw new GmiError('upstream', 'GMI accepted the request but returned no request id.', { detail: truncate(JSON.stringify(result) ?? '', 300) });
    }
    const id = parsed.requestId ?? `local-${randomUUID()}`;
    const earlier = store.get(id);
    if (earlier) {
      // GMI de-duplicated an identical request and returned the earlier job: nothing new was charged.
      const job = await applyGeneration(id, parsed, earlier);
      if (!isTerminalJobStatus(job.status) && job.fromThisDevice) poller.start(job.id);
      return { ...job, deduplicated: true };
    }

    const now = nowIso();
    const status: MediaJobStatus = parsed.status !== 'unknown' ? parsed.status : 'queued';
    const job: MediaJob = {
      id,
      modelId: prepared.modelId,
      modality,
      status,
      prompt: prepared.prompt,
      parameters: prepared.parameters,
      estimateUsd: estimate.chargedUsd,
      listUsd: estimate.listUsd,
      discount: estimate.discount,
      createdAt: now,
      updatedAt: now,
      outputs: mergeOutputs([], parsed.outputs),
      error: status === 'failed' || status === 'cancelled' ? (parsed.error ?? 'GMI reported that the generation failed.') : null,
      fromThisDevice: true,
      posterUrl: parsed.posterUrl,
      options: Object.keys(prepared.options).length ? prepared.options : null,
      ...(isTerminalJobStatus(status) ? { finishedAt: now } : {}),
    };
    store.upsert(job);
    if (status !== 'failed' && status !== 'cancelled') {
      await deps.budget
        .record({ kind: 'media', modelId: job.modelId, usd: estimate.chargedUsd, ref: id })
        .catch((error: unknown) => log.warn('could not record media spend', error));
    }
    emit(job);
    if (status === 'success') void autoSave(job.id);
    else if (!isTerminalJobStatus(status)) poller.start(job.id);
    return job;
  }

  return {
    api,
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(resumeTimer);
      unsubscribeAuth();
      poller.dispose();
      // Aborts in-flight downloads (each removes its partial file) and upload PUTs.
      lifetime.abort();
      await Promise.allSettled([...downloads.values(), sweeping]);
      await store.flush();
    },
  };
}
