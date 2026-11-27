// Uploads and downloads between this computer and a sandbox (compute.md §8.3, T9; C2-B).
//
// - Upload: main shows a native multi-file picker (the renderer never names a host path), runs `mkdir -p` on the
//   target folder first (the parent must exist [V]), then one multipart POST per file, streamed from disk
//   (`fs.openAsBlob`). At most 500 MB per file (AB limit [V]); larger files fail with a hint before anything is sent.
//   507 → disk full, 413 → too large.
// - Download: main shows a native save dialog whose default name is the sanitised remote basename (T9). Bytes go to
//   `<dest>.part`, which is renamed onto `<dest>` only when complete. A broken stream resumes with Range only when the
//   server advertised `Accept-Ranges: bytes` and answers 206; a 200 restarts from zero [V]. Files are written 0644
//   (never executable) and never opened.
// - At most 2 transfers run per session; the rest queue. Each running transfer holds one exec slot (§8.3) and is
//   user activity (`transfer`). Every state change is emitted as `computer:transfer` (progress at most every 250 ms).
// - Logs carry sizes and durations only: never local paths, remote paths or contents (§17).
import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { chmod, open, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { UPLOAD_MAX_BYTES, type TransferInfo } from '@shared/contracts/compute';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { Platform } from '../../../core/context';
import type { Logger } from '../../../core/logger';
import type { DataPlaneApi } from '../sandbox/dataplane';
import type { ComputerTarget, ExecRunner } from './exec';
import { joinRemote, normalizeRemotePath, remoteBasename, type FileService } from './files';

/** Transfers running at once per session (§8.3); more wait in a queue. */
export const TRANSFERS_PER_SESSION = 2;
/** Attempts of one download when the stream breaks (network / timeout / 5xx). */
export const DOWNLOAD_ATTEMPTS = 3;
/** `computer:transfer` progress events at most this often per transfer. */
export const TRANSFER_PROGRESS_MS = 250;
/** Mode of every downloaded file: never executable (§8.3). */
export const DOWNLOAD_FILE_MODE = 0o644;

const UPLOAD_TOO_LARGE = 'Files larger than 500 MB cannot be uploaded. Split it, or fetch it from inside the sandbox.';

/**
 * The default local name for a download (T9): the remote basename with path separators, control characters and
 * characters other systems refuse removed; never empty, `.` or `..`.
 */
export function safeLocalName(remoteName: string): string {
  const cleaned = remoteName
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .slice(0, 200);
  return cleaned === '' || cleaned === '.' || cleaned === '..' || /^\.+$/.test(cleaned) ? 'download' : cleaned;
}

export interface TransferManager {
  /** Native picker, `mkdir -p`, then queued uploads. Null when the picker was cancelled. */
  upload(target: ComputerTarget, remoteDir: string): Promise<TransferInfo[] | null>;
  /** Native save dialog, then a queued download. Null when the dialog was cancelled. */
  download(target: ComputerTarget, remotePath: string): Promise<TransferInfo | null>;
  /** Cancels a queued or running transfer (no-op when finished; not_found when unknown). */
  cancel(transferId: string): Promise<void>;
  get(transferId: string): TransferInfo | null;
  list(sessionId?: string): TransferInfo[];
  /** Cancels every transfer of a closing session. */
  closeSession(sessionId: string): void;
  /** Resolves when no transfer is queued or running (tests, dispose). */
  idle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface TransferDeps {
  runner: ExecRunner;
  files: Pick<FileService, 'ensureDir'>;
  dataPlane: Pick<DataPlaneApi, 'writeFile' | 'download'>;
  platform: Pick<Platform, 'pickFiles' | 'pickSavePath'>;
  /** `computer:transfer`. */
  emit(info: TransferInfo): void;
  log: Logger;
  /** File-backed Blob of a local file (streamed when sent); default `fs.openAsBlob`. */
  openBlob?: (path: string) => Promise<Blob>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

interface Task {
  info: TransferInfo;
  target: ComputerTarget;
  abort: AbortController;
  run: (task: Task) => Promise<void>;
  lastEmit: number;
  startedMs: number;
}

const RETRYABLE: ReadonlySet<string> = new Set(['network', 'timeout', 'upstream']);

function uploadError(error: unknown): GmiError {
  const e = toGmiError(error);
  if (e.status === 507) return new GmiError('quota_exceeded', 'The sandbox disk is full.', { status: 507 });
  if (e.status === 413) return new GmiError('invalid_input', UPLOAD_TOO_LARGE, { status: 413 });
  return e;
}

export function createTransferManager(deps: TransferDeps): TransferManager {
  const log = deps.log.child('computer.files');
  const openBlob = deps.openBlob ?? ((p: string) => openAsBlob(p));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const tasks = new Map<string, Task>();
  const queues = new Map<string, { running: number; waiting: Task[] }>();
  const idleWaiters = new Set<() => void>();

  const snapshot = (info: TransferInfo): TransferInfo => ({ ...info, error: info.error ? { ...info.error } : null });
  const emit = (task: Task) => {
    task.lastEmit = nowMs();
    try {
      deps.emit(snapshot(task.info));
    } catch {
      // A renderer that went away must not break the transfer.
    }
  };
  const progress = (task: Task, bytes: number) => {
    task.info.bytes = bytes;
    if (nowMs() - task.lastEmit >= TRANSFER_PROGRESS_MS) emit(task);
  };
  const finished = (s: TransferInfo['state']) => s === 'done' || s === 'failed' || s === 'cancelled';

  function busy(): boolean {
    for (const q of queues.values()) if (q.running > 0 || q.waiting.length > 0) return true;
    return false;
  }
  function settleIdle() {
    if (busy()) return;
    for (const w of [...idleWaiters]) w();
    idleWaiters.clear();
  }

  function queueOf(sessionId: string) {
    let q = queues.get(sessionId);
    if (!q) {
      q = { running: 0, waiting: [] };
      queues.set(sessionId, q);
    }
    return q;
  }

  function pump(sessionId: string) {
    const q = queueOf(sessionId);
    while (q.running < TRANSFERS_PER_SESSION && q.waiting.length > 0) {
      const task = q.waiting.shift() as Task;
      if (finished(task.info.state)) continue;
      q.running += 1;
      task.info.state = 'running';
      task.startedMs = nowMs();
      emit(task);
      void execute(task).finally(() => {
        q.running -= 1;
        pump(sessionId);
        if (q.running === 0 && q.waiting.length === 0) queues.delete(sessionId);
        settleIdle();
      });
    }
  }

  async function execute(task: Task) {
    try {
      await task.run(task);
      if (task.abort.signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
      task.info.state = 'done';
      if (task.info.totalBytes !== null) task.info.bytes = task.info.totalBytes;
      log.info('transfer.done', { sid: task.target.sessionId, dir: task.info.direction, bytes: task.info.bytes, ms: nowMs() - task.startedMs });
    } catch (error) {
      if (task.abort.signal.aborted) {
        task.info.state = 'cancelled';
        task.info.error = null;
      } else {
        const e = task.info.direction === 'upload' ? uploadError(error) : toGmiError(error);
        task.info.state = 'failed';
        task.info.error = e.toShape();
        log.warn('transfer failed', { sid: task.target.sessionId, dir: task.info.direction, code: e.code, status: e.status });
      }
    }
    emit(task);
  }

  function enqueue(task: Task) {
    tasks.set(task.info.transferId, task);
    if (finished(task.info.state)) {
      emit(task);
      return;
    }
    queueOf(task.target.sessionId).waiting.push(task);
    emit(task);
    pump(task.target.sessionId);
  }

  function newInfo(target: ComputerTarget, direction: TransferInfo['direction'], name: string, remotePath: string, totalBytes: number | null): TransferInfo {
    return { transferId: `tr_${randomUUID()}`, sessionId: target.sessionId, direction, name, remotePath, bytes: 0, totalBytes, state: 'queued', error: null };
  }

  function newTask(info: TransferInfo, target: ComputerTarget, run: Task['run']): Task {
    return { info, target, abort: new AbortController(), run, lastEmit: 0, startedMs: nowMs() };
  }

  // ── upload ──
  const runUpload = (localPath: string) => async (task: Task) => {
    const signal = task.abort.signal;
    await deps.runner.withSlot(task.target, { origin: 'user', activity: 'transfer', signal }, async () => {
      const blob = await openBlob(localPath);
      if (blob.size > UPLOAD_MAX_BYTES) throw new GmiError('invalid_input', UPLOAD_TOO_LARGE);
      task.info.totalBytes = blob.size;
      await deps.dataPlane.writeFile(task.target.sandboxId, task.info.remotePath, blob, { signal });
    });
  };

  // ── download ──
  const runDownload = (dest: string) => async (task: Task) => {
    const signal = task.abort.signal;
    const part = `${dest}.part`;
    let renamed = false;
    try {
      await deps.runner.withSlot(task.target, { origin: 'user', activity: 'transfer', signal }, async () => {
        const fh = await open(part, 'w', DOWNLOAD_FILE_MODE);
        try {
          await receive(task, fh, signal);
          await fh.sync();
        } finally {
          await fh.close();
        }
        // `open(…, 'w')` keeps the mode of a `.part` left by an earlier run: set it explicitly (never executable).
        await chmod(part, DOWNLOAD_FILE_MODE);
        if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
        await rename(part, dest);
        renamed = true;
      });
    } finally {
      if (!renamed) await unlink(part).catch(() => undefined);
    }
  };

  async function receive(task: Task, fh: FileHandle, signal: AbortSignal) {
    let offset = 0;
    let rangesOk = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const res = await deps.dataPlane.download(task.target.sandboxId, task.info.remotePath, { offset: rangesOk ? offset : 0, signal });
        if (!(rangesOk && offset > 0 && res.resumed)) {
          // A 200 to a Range request (or no Range at all): the body is the whole file again [V].
          if (offset > 0) await fh.truncate(0);
          offset = 0;
          progress(task, 0);
        }
        rangesOk = res.acceptRanges;
        if (res.totalBytes !== null) task.info.totalBytes = res.totalBytes;
        if (res.body) {
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!value || value.byteLength === 0) continue;
              await fh.write(value, 0, value.byteLength, offset);
              offset += value.byteLength;
              progress(task, offset);
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (task.info.totalBytes !== null && offset !== task.info.totalBytes) {
          throw new GmiError('network', 'The download ended early.');
        }
        task.info.bytes = offset;
        return;
      } catch (error) {
        if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
        const e = toGmiError(error);
        if (attempt >= DOWNLOAD_ATTEMPTS || !RETRYABLE.has(e.code)) throw e;
        if (!rangesOk && offset > 0) {
          await fh.truncate(0);
          offset = 0;
        }
        await sleep(500 * attempt);
      }
    }
  }

  async function cancel(transferId: string): Promise<void> {
    const task = tasks.get(transferId);
    if (!task) throw new GmiError('not_found', 'That transfer no longer exists.');
    if (finished(task.info.state)) return;
    task.abort.abort();
    if (task.info.state === 'queued') {
      const q = queues.get(task.target.sessionId);
      if (q) q.waiting = q.waiting.filter((t) => t !== task);
      task.info.state = 'cancelled';
      emit(task);
      settleIdle();
    }
  }

  function cancelAll(match: (task: Task) => boolean) {
    for (const task of [...tasks.values()]) if (match(task) && !finished(task.info.state)) void cancel(task.info.transferId);
  }

  function idle(): Promise<void> {
    if (!busy()) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.add(resolve));
  }

  return {
    async upload(target, remoteDir) {
      const dir = normalizeRemotePath(remoteDir);
      const picked = await deps.platform.pickFiles({ title: `Upload to ${dir}` });
      if (!picked || picked.length === 0) return null;
      const planned: Array<{ info: TransferInfo; local: string | null }> = [];
      for (const local of picked) {
        const name = basename(local);
        let remotePath: string;
        try {
          remotePath = joinRemote(dir, name);
        } catch (error) {
          const info = newInfo(target, 'upload', safeLocalName(name), dir, null);
          planned.push({ info: { ...info, state: 'failed', error: toGmiError(error).toShape() }, local: null });
          continue;
        }
        const info = newInfo(target, 'upload', name, remotePath, null);
        try {
          const st = await stat(local);
          if (!st.isFile()) throw new GmiError('invalid_input', 'Only files can be uploaded (not folders).');
          info.totalBytes = st.size;
          if (st.size > UPLOAD_MAX_BYTES) throw new GmiError('invalid_input', UPLOAD_TOO_LARGE);
          planned.push({ info, local });
        } catch (error) {
          planned.push({ info: { ...info, state: 'failed', error: toGmiError(error).toShape() }, local: null });
        }
      }
      if (planned.some((p) => p.local !== null)) await deps.files.ensureDir(target, dir);
      for (const p of planned) {
        enqueue(newTask(p.info, target, p.local !== null ? runUpload(p.local) : async () => undefined));
      }
      return planned.map((p) => snapshot(p.info));
    },

    async download(target, remotePath) {
      const path = normalizeRemotePath(remotePath);
      if (path === '/') throw new GmiError('invalid_input', 'Choose a file to download.');
      const defaultName = safeLocalName(remoteBasename(path));
      const dest = await deps.platform.pickSavePath({ title: 'Download from the sandbox', defaultName });
      if (!dest) return null;
      const info = newInfo(target, 'download', safeLocalName(basename(dest)), path, null);
      const task = newTask(info, target, runDownload(dest));
      enqueue(task);
      return snapshot(task.info);
    },

    cancel,

    get: (id) => {
      const task = tasks.get(id);
      return task ? snapshot(task.info) : null;
    },
    list: (sessionId) => [...tasks.values()].filter((t) => !sessionId || t.target.sessionId === sessionId).map((t) => snapshot(t.info)),

    closeSession(sessionId) {
      cancelAll((t) => t.target.sessionId === sessionId);
      for (const [id, task] of tasks) if (task.target.sessionId === sessionId && finished(task.info.state)) tasks.delete(id);
    },

    idle,

    async dispose() {
      cancelAll(() => true);
      await idle();
      tasks.clear();
    },
  };
}
