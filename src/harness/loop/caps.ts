/**
 * Turn caps (harness.md §6.3). Main enforces money (reservations, persisted thread ledger, §4.4); the host checks
 * the same figures before each step so a turn stops cleanly instead of failing on a refused request.
 *
 * The wall clock counts only ACTIVE time (§6.1 invariant 5): `awaiting_approval` and `awaiting_user` pause it.
 */
import { CODE_DEFAULTS, type CodeThreadSettings, type NoticeReason } from '@shared/contracts/code';
import type { HostClock } from '../types';

export const CAP_LIMITS = {
  minSteps: 1,
  maxSteps: 500,
  /** Tool output of all results of one step (§6.3): truncate the largest first. */
  stepOutputTokens: 40_000,
  /** Invalid tool JSON / unknown tools per step before `model_error` (§6.2 step 5). */
  invalidCallsPerStep: 2,
  /** Layer-2 shrink levels (§7.5), fractions of the rejected size. */
  overflowLevels: [0.85, 0.7, 0.5, 0.35] as const,
} as const;

export interface ResolvedBudget {
  maxSteps: number;
  maxActiveMs: number;
  perTurnUsd: number | null;
  perThreadUsd: number | null;
}

export function resolveBudget(settings: Pick<CodeThreadSettings, 'budget'>): ResolvedBudget {
  const b = settings.budget;
  const steps = Number.isFinite(b?.maxStepsPerTurn) ? Math.floor(b.maxStepsPerTurn) : CODE_DEFAULTS.maxStepsPerTurn;
  const minutes = Number.isFinite(b?.maxTurnMinutes) && b.maxTurnMinutes > 0 ? b.maxTurnMinutes : CODE_DEFAULTS.maxTurnMinutes;
  return {
    maxSteps: Math.min(CAP_LIMITS.maxSteps, Math.max(CAP_LIMITS.minSteps, steps)),
    maxActiveMs: Math.round(minutes * 60_000),
    perTurnUsd: b?.perTurnUsd ?? null,
    perThreadUsd: b?.perThreadUsd ?? null,
  };
}

/**
 * Active-time stopwatch with an expiry callback. `pause()`/`resume()` nest (two parallel approvals pause once).
 * The expiry timer runs only while active.
 */
export class ActiveClock {
  private accumulated = 0;
  private since: number | null = null;
  private pauses = 0;
  private timer: unknown = null;
  private expired = false;

  constructor(
    private readonly clock: HostClock,
    private readonly limitMs: number,
    private readonly onExpire: () => void,
  ) {}

  start(): void {
    if (this.since !== null || this.expired) return;
    this.since = this.clock.now();
    this.arm();
  }

  pause(): void {
    this.pauses += 1;
    if (this.pauses > 1 || this.since === null) return;
    this.accumulated += this.clock.now() - this.since;
    this.since = null;
    this.disarm();
  }

  resume(): void {
    if (this.pauses === 0) return;
    this.pauses -= 1;
    if (this.pauses > 0 || this.expired) return;
    this.since = this.clock.now();
    this.arm();
  }

  activeMs(): number {
    return this.accumulated + (this.since === null ? 0 : this.clock.now() - this.since);
  }

  isExpired(): boolean {
    return this.expired || this.activeMs() >= this.limitMs;
  }

  stop(): void {
    if (this.since !== null) this.accumulated += this.clock.now() - this.since;
    this.since = null;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    const left = this.limitMs - this.activeMs();
    if (left <= 0) {
      this.fire();
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.since !== null && this.activeMs() >= this.limitMs) this.fire();
      else if (this.since !== null) this.arm();
    }, left);
  }

  private disarm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private fire(): void {
    if (this.expired) return;
    this.expired = true;
    this.stop();
    this.onExpire();
  }
}

export type CapStop = { reason: Extract<NoticeReason, 'step_cap' | 'cost_cap' | 'time_cap'>; text: string };

/** The checks of §6.2 step 1 that the host can make itself (the app budget is main's). */
export function checkCaps(input: { stepsDone: number; budget: ResolvedBudget; turnCostUsd: number; threadCostUsd: number; activeExpired: boolean }): CapStop | null {
  if (input.activeExpired) return { reason: 'time_cap', text: `The turn reached its time limit (${Math.round(input.budget.maxActiveMs / 60_000)} min of active time).` };
  const { perTurnUsd, perThreadUsd } = input.budget;
  if (perTurnUsd !== null && input.turnCostUsd >= perTurnUsd) return { reason: 'cost_cap', text: `The turn reached its cost cap ($${perTurnUsd.toFixed(2)}).` };
  if (perThreadUsd !== null && input.threadCostUsd >= perThreadUsd) return { reason: 'cost_cap', text: `The thread reached its cost cap ($${perThreadUsd.toFixed(2)}).` };
  if (input.stepsDone >= input.budget.maxSteps) return { reason: 'step_cap', text: `The turn reached its step cap (${input.budget.maxSteps} steps).` };
  return null;
}

/** What a run did, from the log (tool effects), for the no-model-call summary at a cost cap (§6.3). */
export interface RunLog {
  steps: number;
  toolCalls: number;
  failedCalls: number;
  changedPaths: Set<string>;
  commands: string[];
  lastText: string;
}

export function emptyRunLog(): RunLog {
  return { steps: 0, toolCalls: 0, failedCalls: 0, changedPaths: new Set(), commands: [], lastText: '' };
}

/** A short, deterministic summary built from the log; no model call (§6.3 cost caps). */
export function summaryFromLog(log: RunLog): string {
  const lines = [`Steps: ${log.steps}; tool calls: ${log.toolCalls} (${log.failedCalls} failed).`];
  const changed = [...log.changedPaths].sort();
  if (changed.length > 0) lines.push(`Changed: ${changed.slice(0, 15).join(', ')}${changed.length > 15 ? ` (+${changed.length - 15} more)` : ''}.`);
  if (log.commands.length > 0) lines.push(`Last command: ${log.commands[log.commands.length - 1]!.slice(0, 200)}`);
  const last = log.lastText.trim();
  if (last) lines.push(`Last message: ${last.length > 400 ? `${last.slice(0, 400)}…` : last}`);
  return lines.join('\n');
}
