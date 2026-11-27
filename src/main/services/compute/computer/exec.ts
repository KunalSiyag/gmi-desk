// The computer's exec runner (compute.md §8.1, §8.3, §9.5; C2-B). Every command the file browser, the port scan, the
// services and the Resources popover run goes through here, so the rules live in one place:
//
// - One slot of the session's ExecPort per execution, held until the execution is terminal (not until the HTTP call
//   returns: a 25 s wait that times out leaves it running [V]). Once GMI names the execution the slot is bound to
//   its eid (persisted by the port); an execution that is abandoned after that (abort, poll failure) is handed to
//   `ExecPort.cancel`, which frees the slot when it is terminal. A request that never got an eid releases with
//   `not_started`.
// - `execution_timeout_seconds` is always explicit.
// - User data (paths, names, service commands) only ever goes through `envs`; callers never interpolate it.
// - Only user-originated work is activity (§9.5): `origin: 'app'` (port scan, usage snapshot, listing refresh) never
//   reaches the ActivitySink, so code inside the sandbox cannot keep itself alive.
// - A 429 `Execution.ConcurrencyLimitExceeded` lowers the port's capacity to what GMI allowed.
// - `/files` requests (read, write, upload, download) are not executions but still take one slot (§8.3): `withSlot`.
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../../core/logger';
import { ComputeHttpError } from '../errors';
import { isTerminalExec, type DataPlaneApi } from '../sandbox/dataplane';
import type { V2ExecResult, V2ExecTerminalStatus } from '../sandbox/dto';
import type { ActivitySink, ExecOrigin, ExecPort, ExecPriority, ExecSlot, UserActivityKind } from '../types';

/** What one computer operation runs against (resolved by the session manager from a `sessionId`). */
export interface ComputerTarget {
  sessionId: string;
  /** Registry id (`cr_…`): the ExecPort, the registry and the activity clock are keyed by it. */
  resourceId: string;
  /** v2 sandbox id: the data plane is keyed by it. */
  sandboxId: string;
}

export interface RunExecInput {
  command: string;
  /** Paths, names and user commands go here, never into `command`. */
  envs?: Record<string, string>;
  cwd?: string;
  /** Always explicit (1..3600). */
  timeoutSec: number;
  /** `app`: never activity. `user`: activity when `activity` names a kind. */
  origin: Exclude<ExecOrigin, 'agent'>;
  /** The activity kind a user exec records (ignored for `app`). */
  activity?: UserActivityKind | null;
  priority?: ExecPriority;
  signal?: AbortSignal;
}

export interface SlotOptions {
  origin: Exclude<ExecOrigin, 'agent'>;
  activity?: UserActivityKind | null;
  priority?: ExecPriority;
  signal?: AbortSignal;
}

export interface ExecRunner {
  /** Runs one execution to a terminal state under a slot. Resolves with the terminal result (any exit code). */
  run(target: ComputerTarget, input: RunExecInput): Promise<V2ExecResult>;
  /** Holds one slot around a `/files` request (no execution id): released as `not_started` when `fn` settles. */
  withSlot<T>(target: ComputerTarget, opts: SlotOptions, fn: () => Promise<T>): Promise<T>;
}

export interface ExecRunnerDeps {
  dataPlane: DataPlaneApi;
  execPort: ExecPort;
  activity: ActivitySink;
  log: Logger;
}

/** The v2 remote code of a 429 from a sandbox that already runs its maximum of executions. */
export const EXEC_CONCURRENCY_CODE = 'Execution.ConcurrencyLimitExceeded';

export function isConcurrencyLimit(error: unknown): boolean {
  return error instanceof ComputeHttpError && error.status === 429 && error.remoteCode === EXEC_CONCURRENCY_CODE;
}

function recordActivity(deps: ExecRunnerDeps, target: ComputerTarget, origin: ExecOrigin, kind: UserActivityKind | null | undefined): void {
  if (origin !== 'user' || !kind) return;
  try {
    deps.activity.record(target.resourceId, { kind });
  } catch {
    // The idle clock must never break the user's action.
  }
}

export function createExecRunner(deps: ExecRunnerDeps): ExecRunner {
  const log = deps.log.child('computer.exec');

  async function acquire(target: ComputerTarget, priority: ExecPriority, signal: AbortSignal | undefined): Promise<ExecSlot> {
    if (signal?.aborted) throw new GmiError('cancelled', 'Cancelled.');
    return deps.execPort.acquire(target.resourceId, { priority, signal });
  }

  function onRefused(target: ComputerTarget, error: unknown): void {
    if (!isConcurrencyLimit(error)) return;
    // GMI counts executions we cannot see (another install, a leftover): it allows fewer than our slots in use.
    const { inUse } = deps.execPort.usage(target.resourceId);
    deps.execPort.lowerCapacity(target.resourceId, Math.max(1, inUse - 1));
  }

  async function abandon(eid: string): Promise<void> {
    try {
      await deps.execPort.cancel(eid);
    } catch (error) {
      log.warn('cancel of an abandoned execution failed', { code: error instanceof GmiError ? error.code : 'internal' });
    }
  }

  return {
    async run(target, input) {
      const priority = input.priority ?? 'user';
      const slot = await acquire(target, priority, input.signal);
      recordActivity(deps, target, input.origin, input.activity);
      const accepted: { eid: string | null } = { eid: null };
      let first: Awaited<ReturnType<DataPlaneApi['startExec']>>;
      try {
        first = await deps.dataPlane.startExec(target.sandboxId, {
          command: input.command,
          ...(input.envs ? { envs: input.envs } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
          timeoutSec: input.timeoutSec,
          signal: input.signal,
          onAccepted: async (id) => {
            accepted.eid = id;
            await slot.bind({ eid: id, origin: input.origin, grantId: null, timeoutSec: input.timeoutSec });
          },
        });
      } catch (error) {
        if (accepted.eid === null) {
          await slot.release('not_started');
          onRefused(target, error);
        } else {
          await abandon(accepted.eid);
        }
        throw error;
      }
      const id = first.execution_id;
      if (isTerminalExec(first.status)) {
        await slot.release(first.status as V2ExecTerminalStatus);
        return first as V2ExecResult;
      }
      try {
        const done = await deps.dataPlane.waitExecution(target.sandboxId, id, { signal: input.signal });
        await slot.release(done.status as V2ExecTerminalStatus);
        return done;
      } catch (error) {
        // Aborted or the poll failed: the execution may still run. The port cancels it and frees the slot once
        // GMI reports it terminal; until then it keeps counting against the sandbox's 10.
        await abandon(id);
        throw error;
      }
    },

    async withSlot(target, opts, fn) {
      const slot = await acquire(target, opts.priority ?? 'user', opts.signal);
      recordActivity(deps, target, opts.origin, opts.activity);
      try {
        return await fn();
      } finally {
        await slot.release('not_started');
      }
    },
  };
}

// ─── Exec result helpers shared by files / ports / services ─────────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** Plain text for the UI: ANSI and control characters removed (tabs and newlines kept), capped. */
export function plainText(text: string | null | undefined, maxChars = 16 * 1024): string {
  const clean = (text ?? '').replace(ANSI, '').replace(CONTROL, '');
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}\n…` : clean;
}

/** The first meaningful stderr line, user-safe (no control characters, at most 200 characters). */
export function stderrLine(result: Pick<V2ExecResult, 'stderr'>): string {
  const line = plainText(result.stderr, 4096)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? (line.length > 200 ? `${line.slice(0, 200)}…` : line) : '';
}

/** Maps a failed shell command (non-zero exit) to a GmiError with a user-safe message. */
export function execFailure(result: V2ExecResult, what: string): GmiError {
  if (result.status === 'timed_out') return new GmiError('timeout', `${what} took too long in the sandbox.`);
  if (result.status === 'cancelled') return new GmiError('cancelled', `${what} was cancelled.`);
  const line = stderrLine(result);
  const detail = line || (result.exit_code !== null ? `exit code ${result.exit_code}` : null);
  if (/no such file or directory|not found|cannot stat|cannot access/i.test(line)) return new GmiError('not_found', `${what}: not found.`, { detail });
  if (/permission denied|operation not permitted|read-only file system/i.test(line)) return new GmiError('permission_denied', `${what}: permission denied in the sandbox.`, { detail });
  if (/file exists|directory not empty/i.test(line)) return new GmiError('conflict', `${what}: something with that name already exists.`, { detail });
  if (/no space left/i.test(line)) return new GmiError('quota_exceeded', `${what}: the sandbox disk is full.`, { detail });
  return new GmiError('upstream', `${what} failed in the sandbox.`, { detail });
}
