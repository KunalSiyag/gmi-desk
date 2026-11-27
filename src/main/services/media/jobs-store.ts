/**
 * Local media job ledger (`<data>/media-jobs.json`): jobs started from this app plus GMI history entries the user
 * opened. Newest first, capped. Reads are synchronous from memory; writes are atomic and serialised.
 */
import type { MediaJob, MediaJobStatus, MediaModality, MediaOutput, MediaRequestOptions } from '@shared/contracts/media';
import type { Logger } from '../../core/logger';
import { openJsonStore, type JsonStore } from '../../core/store';

export const MAX_STORED_JOBS = 500;

interface JobsFile {
  version: 1;
  jobs: MediaJob[];
}

const STATUSES: readonly MediaJobStatus[] = ['created', 'queued', 'dispatched', 'processing', 'success', 'failed', 'cancelled', 'unknown'];
const MODALITIES: readonly MediaModality[] = ['image', 'video', 'audio', 'workflow', 'other'];
const KINDS: readonly MediaOutput['kind'][] = ['image', 'video', 'audio', 'file'];

const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => {
  const text = s(v);
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

function normalizeOutput(raw: unknown): MediaOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const url = s(o.url);
  if (!url) return null;
  return {
    url,
    kind: KINDS.includes(o.kind as MediaOutput['kind']) ? (o.kind as MediaOutput['kind']) : 'file',
    localPath: s(o.localPath),
    localUrl: s(o.localUrl),
    mimeType: s(o.mimeType),
    bytes: n(o.bytes),
  };
}

function normalizeOptions(raw: unknown): MediaRequestOptions | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: MediaRequestOptions = {};
  if (s(o.aspectRatio)) out.aspectRatio = o.aspectRatio as string;
  if (s(o.negativePrompt)) out.negativePrompt = o.negativePrompt as string;
  if (n(o.n) !== null) out.n = o.n as number;
  if (n(o.seed) !== null) out.seed = o.seed as number;
  return Object.keys(out).length ? out : null;
}

/** Validates one stored job (untrusted disk data); null when unusable. */
export function normalizeStoredJob(raw: unknown): MediaJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  const id = s(j.id);
  const modelId = s(j.modelId);
  const createdAt = iso(j.createdAt);
  if (!id || !modelId || !createdAt) return null;
  const outputs = Array.isArray(j.outputs) ? j.outputs.map(normalizeOutput).filter((o): o is MediaOutput => o !== null) : [];
  const job: MediaJob = {
    id,
    modelId,
    modality: MODALITIES.includes(j.modality as MediaModality) ? (j.modality as MediaModality) : 'other',
    status: STATUSES.includes(j.status as MediaJobStatus) ? (j.status as MediaJobStatus) : 'unknown',
    prompt: s(j.prompt),
    parameters: j.parameters && typeof j.parameters === 'object' && !Array.isArray(j.parameters) ? (j.parameters as Record<string, unknown>) : {},
    estimateUsd: n(j.estimateUsd),
    createdAt,
    updatedAt: iso(j.updatedAt) ?? createdAt,
    outputs,
    error: s(j.error),
    fromThisDevice: j.fromThisDevice === true,
    listUsd: n(j.listUsd),
    discount: n(j.discount),
    posterUrl: s(j.posterUrl),
    options: normalizeOptions(j.options),
  };
  if (j.pollingStopped === true) job.pollingStopped = true;
  const finishedAt = iso(j.finishedAt);
  if (finishedAt) job.finishedAt = finishedAt;
  return job;
}

export const byNewest = (a: MediaJob, b: MediaJob) => Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * Newest first, at most MAX_STORED_JOBS. Over the cap, GMI-history entries the user merely opened (GMI still lists
 * them) are forgotten before any job started on this device, whose prompt, settings and local files only live here.
 */
export function capJobs(jobs: MediaJob[], max = MAX_STORED_JOBS): MediaJob[] {
  const sorted = jobs.slice().sort(byNewest);
  if (sorted.length <= max) return sorted;
  const mine = sorted.filter((j) => j.fromThisDevice).slice(0, max);
  const history = sorted.filter((j) => !j.fromThisDevice).slice(0, max - mine.length);
  return [...mine, ...history].sort(byNewest);
}

function normalizeFile(raw: unknown): JobsFile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.jobs) ? r.jobs : [];
  const seen = new Set<string>();
  const jobs: MediaJob[] = [];
  for (const entry of list) {
    const job = normalizeStoredJob(entry);
    if (!job || seen.has(job.id)) continue;
    seen.add(job.id);
    jobs.push(job);
  }
  return { version: 1, jobs: capJobs(jobs) };
}

export interface JobsStore {
  readonly path: string;
  /** Newest first. */
  list(): MediaJob[];
  get(id: string): MediaJob | null;
  isEmpty(): boolean;
  /** Inserts or replaces a job (sorted, capped). Applied in memory at once; written to disk in the background. */
  upsert(job: MediaJob): MediaJob;
  /** Applies `fn` to a stored job; returns the new job (null when it does not exist). */
  update(id: string, fn: (job: MediaJob) => MediaJob): MediaJob | null;
  /** Resolves when every pending write has reached the disk. */
  flush(): Promise<void>;
}

export async function openJobsStore(path: string, log?: Logger): Promise<JobsStore> {
  const store: JsonStore<JobsFile> = await openJsonStore<JobsFile>(path, { version: 1, jobs: [] }, { log, normalize: (raw) => normalizeFile(raw) });
  // JsonStore.set applies the value in memory synchronously and serialises the disk writes (errors are logged there).
  const write = (jobs: MediaJob[]) => void store.set({ version: 1, jobs: capJobs(jobs) });

  return {
    path,
    list: () => store.get().jobs.slice(),
    get: (id) => store.get().jobs.find((j) => j.id === id) ?? null,
    isEmpty: () => store.get().jobs.length === 0,
    upsert(job) {
      const jobs = store.get().jobs.filter((j) => j.id !== job.id);
      jobs.push(job);
      write(jobs);
      return job;
    },
    update(id, fn) {
      const jobs = store.get().jobs.slice();
      const index = jobs.findIndex((j) => j.id === id);
      if (index < 0) return null;
      const next = fn(jobs[index] as MediaJob);
      jobs[index] = next;
      write(jobs);
      return next;
    },
    flush: () => store.flush(),
  };
}
