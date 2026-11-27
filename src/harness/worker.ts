/**
 * Heavy work off the host's event loop (harness.md §5.1: no synchronous block over 1 s): migrations, diff parsing,
 * transcript rendering, hashing or serialising contexts above 1 MB.
 *
 * The worker thread runs the SAME bundle (dist-electron/harness.cjs): host.ts starts `runWorkerThread()` when it is
 * loaded as a worker (WORKER_MARKER in workerData). So a job registered with `registerWorkerJob` at module load is
 * available in both threads, and no second build entry is needed. Tests use `createInlineWorker` (same handlers,
 * same thread).
 */
import { createHash } from 'node:crypto';
import { parentPort, Worker as ThreadWorker } from 'node:worker_threads';
import { GmiError, toGmiError, type GmiErrorShape } from '@shared/contracts/errors';
import type { HostLog, Worker, WorkerJobName, WorkerJobs } from './types';

export const WORKER_MARKER = 'gmiDeskHarnessWorker';

type Handler<K extends WorkerJobName> = (input: WorkerJobs[K]['input']) => WorkerJobs[K]['output'] | Promise<WorkerJobs[K]['output']>;
const handlers = new Map<string, (input: unknown) => unknown>();

/** Registers the handler of a job (at module load, so the worker thread has it too). A second registration replaces the first. */
export function registerWorkerJob<K extends WorkerJobName>(job: K, handler: Handler<K>): void {
  handlers.set(job, handler as (input: unknown) => unknown);
}

registerWorkerJob('echo', (input) => input);
registerWorkerJob('sha256', ({ text }) => createHash('sha256').update(text).digest('hex'));

async function runHandler(job: string, input: unknown): Promise<unknown> {
  const handler = handlers.get(job);
  if (!handler) throw new GmiError('not_implemented', `Unknown worker job: ${job.slice(0, 64)}`);
  return handler(input);
}

const cancelled = () => new GmiError('cancelled', 'The worker job was cancelled.');

/** Runs jobs in the calling thread (tests; also the fallback when a worker thread cannot start). */
export function createInlineWorker(): Worker {
  let closed = false;
  return {
    async run(job, input, opts = {}) {
      if (closed) throw cancelled();
      if (opts.signal?.aborted) throw cancelled();
      const result = await runHandler(job, input);
      if (opts.signal?.aborted) throw cancelled();
      return result as never;
    },
    async close() {
      closed = true;
    },
  };
}

type WorkerReply = { id: number; ok: true; output: unknown } | { id: number; ok: false; error: GmiErrorShape };

/**
 * One worker thread running `file` (the host bundle itself, `__filename` in production). Started on first use and
 * restarted after a crash; jobs in flight when it dies reject with `internal`. An aborted job rejects at once (the
 * thread finishes it and the result is dropped).
 */
export function createThreadWorker(opts: { file: string; log: HostLog }): Worker {
  let thread: ThreadWorker | null = null;
  let seq = 0;
  let closed = false;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();

  const failAll = (error: GmiError) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  const ensure = (): ThreadWorker => {
    if (thread) return thread;
    const t = new ThreadWorker(opts.file, { workerData: { [WORKER_MARKER]: true } });
    t.unref();
    t.on('message', (reply: WorkerReply) => {
      const p = pending.get(reply.id);
      if (!p) return;
      pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.output);
      else p.reject(new GmiError(reply.error.code, reply.error.message, { detail: reply.error.detail ?? null }));
    });
    t.on('error', (error) => {
      opts.log.error('worker thread failed', { error: error instanceof Error ? error.name : 'unknown' });
    });
    t.on('exit', (code) => {
      if (thread === t) thread = null;
      if (pending.size > 0) failAll(new GmiError('internal', `The worker thread exited (code ${code}).`));
    });
    thread = t;
    return t;
  };

  return {
    run(job, input, runOpts = {}) {
      if (closed || runOpts.signal?.aborted) return Promise.reject(cancelled());
      const id = (seq += 1);
      return new Promise((resolve, reject) => {
        const signal = runOpts.signal;
        const onAbort = () => {
          if (pending.delete(id)) reject(cancelled());
        };
        pending.set(id, {
          resolve: (v) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(v as never);
          },
          reject: (e) => {
            signal?.removeEventListener('abort', onAbort);
            reject(e);
          },
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          ensure().postMessage({ id, job, input });
        } catch (error) {
          pending.delete(id);
          reject(toGmiError(error));
        }
      });
    },
    async close() {
      closed = true;
      failAll(cancelled());
      const t = thread;
      thread = null;
      if (t) await t.terminate();
    },
  };
}

/** The worker thread's main: answers `{id, job, input}` with `{id, ok, output | error}`. */
export function runWorkerThread(): void {
  const port = parentPort;
  if (!port) return;
  port.on('message', (msg: { id: number; job: string; input: unknown }) => {
    void runHandler(msg.job, msg.input).then(
      (output) => port.postMessage({ id: msg.id, ok: true, output } satisfies WorkerReply),
      (error: unknown) => port.postMessage({ id: msg.id, ok: false, error: toGmiError(error).toShape() } satisfies WorkerReply),
    );
  });
}
