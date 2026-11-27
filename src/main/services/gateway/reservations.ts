/**
 * Budget reservations (harness.md §4.4). Main reserves the worst case of every request at admission, synchronously
 * (BudgetGuard.statusSnapshot(), the thread ledger and the outstanding sum are read and the reservation inserted
 * with no `await` in between), and releases it when the request settles. No time-based expiry.
 *
 * Three answers per request: fits → reserved; would fit if the other outstanding reservations settled → wait
 * (queued(budget)); does not fit even alone → refused (`limit_reached` for a thread / turn cap, `budget_exceeded`
 * for the app budget).
 *
 * - `chat` keeps today's semantics: never waits or is refused here (precheck = BudgetGuard.check(null, 'chat')),
 *   but its reservation counts as outstanding, so agents cannot overshoot together with a running chat reply.
 * - The app budget blocks only when it is enforced (an unenforced budget warns, as for chat and media); thread and
 *   turn caps always block.
 * - Unpriced requests (reserveUsd null): `chat` → 0; `probe` → the probe cap; any other purpose → `unpricedReserveUsd`
 *   when configured, otherwise refused, because main could not cap their spend.
 */
import type { GmiErrorShape } from '@shared/contracts/errors';
import type { BudgetStatus } from '@shared/contracts/usage';
import { formatUsd } from '@shared/lib/money';
import type { BudgetGuard } from '../../core/services';
import { GATEWAY_LIMITS, type PrecheckResult, type Reservation, type ReservationRequest, type Reservations, type ReserveAttempt, type ThreadLedger } from './types';

/** Float slack when comparing sums of money (USD). */
const EPS = 1e-9;

export interface ReservationsDeps {
  budget: Pick<BudgetGuard, 'check' | 'statusSnapshot'>;
  threads: Pick<ThreadLedger, 'spend' | 'caps'>;
  /**
   * Reservation for a non-chat request whose model has no known price (e.g. GMI Router before routing). Null
   * (default): such requests are refused with `invalid_input`.
   */
  unpricedReserveUsd?: number | null;
}

interface Held {
  requestId: string;
  purpose: ReservationRequest['purpose'];
  threadId: string | null;
  turnId: string | null;
  usd: number;
}

/** The smallest "remaining" of the app budget's set limits; Infinity when none is set or it is not enforced. */
export function appBudgetFree(status: BudgetStatus): number {
  if (!status.budget.enforce) return Number.POSITIVE_INFINITY;
  let free = Number.POSITIVE_INFINITY;
  for (const r of [status.remainingTodayUsd, status.remainingMonthUsd]) if (r !== null && Number.isFinite(r)) free = Math.min(free, Math.max(0, r));
  return free;
}

const budgetExceeded = (usd: number | null, free: number): GmiErrorShape => ({
  code: 'budget_exceeded',
  message: usd === null ? 'You have reached your budget.' : `This request could cost up to ${formatUsd(usd)}, more than your budget has left (${formatUsd(free)}).`,
});

const capReached = (which: 'turn' | 'thread', cap: number, spent: number, usd: number | null): GmiErrorShape => ({
  code: 'limit_reached',
  message:
    usd === null
      ? `This ${which} has reached its cost cap (${formatUsd(cap)}, ${formatUsd(spent)} used).`
      : `This request could cost up to ${formatUsd(usd)}, more than the ${which}'s cost cap allows (${formatUsd(cap)}, ${formatUsd(spent)} used).`,
  detail: which === 'turn' ? 'turn_cap' : 'thread_cap',
});

export function createReservations(deps: ReservationsDeps): Reservations {
  const { budget, threads } = deps;
  const unpriced = deps.unpricedReserveUsd ?? null;
  const held = new Map<string, Held>();
  const listeners = new Set<() => void>();
  let seq = 0;

  const outstandingUsd = (filter?: { threadId?: string; turnId?: string }): number => {
    let sum = 0;
    for (const h of held.values()) {
      if (filter?.threadId !== undefined && h.threadId !== filter.threadId) continue;
      if (filter?.turnId !== undefined && h.turnId !== filter.turnId) continue;
      sum += h.usd;
    }
    return sum;
  };

  const insert = (req: ReservationRequest, usd: number): Reservation => {
    // Two live requests could share an id (a caller bug): the key stays unique so neither release drops the other.
    seq += 1;
    const key = `${req.requestId}\u0000${seq}`;
    held.set(key, { requestId: req.requestId, purpose: req.purpose, threadId: req.threadId, turnId: req.turnId, usd });
    let released = false;
    return {
      requestId: req.requestId,
      usd,
      release() {
        if (released) return;
        released = true;
        held.delete(key);
        for (const l of [...listeners]) {
          try {
            l();
          } catch {
            // a listener must not break the release of the others
          }
        }
      },
    };
  };

  /** Actual-spend checks for thread and turn caps (no reservations): the refusal, or null. */
  const capRefusal = (threadId: string | null, turnId: string | null, extraUsd: number, alone: boolean, usd: number | null): GmiErrorShape | null => {
    if (!threadId) return null;
    const caps = threads.caps(threadId);
    const spent = threads.spend(threadId, turnId);
    if (turnId && caps.perTurnUsd !== null) {
      const out = alone ? 0 : outstandingUsd({ threadId, turnId });
      if (spent.turnUsd + out + extraUsd > caps.perTurnUsd + EPS || (extraUsd === 0 && spent.turnUsd >= caps.perTurnUsd - EPS)) return capReached('turn', caps.perTurnUsd, spent.turnUsd, usd);
    }
    if (caps.perThreadUsd !== null) {
      const out = alone ? 0 : outstandingUsd({ threadId });
      if (spent.threadUsd + out + extraUsd > caps.perThreadUsd + EPS || (extraUsd === 0 && spent.threadUsd >= caps.perThreadUsd - EPS)) return capReached('thread', caps.perThreadUsd, spent.threadUsd, usd);
    }
    return null;
  };

  return {
    async precheck(req): Promise<PrecheckResult> {
      if (req.purpose === 'chat') {
        const check = await budget.check(null, 'chat');
        if (!check.allowed) return { ok: false, error: { code: 'budget_exceeded', message: check.reason ?? 'You have reached your budget.' } };
        return { ok: true, warning: check.reason };
      }
      const capped = capRefusal(req.threadId, req.turnId, 0, true, null);
      if (capped) return { ok: false, error: capped };
      const status = budget.statusSnapshot();
      const free = appBudgetFree(status);
      if (free <= EPS) return { ok: false, error: budgetExceeded(null, free) };
      // Unenforced budget: the same warning the chat and media checks show.
      const check = await budget.check(null, 'agent');
      return { ok: true, warning: check.reason };
    },

    tryReserve(req): ReserveAttempt {
      let usd = req.reserveUsd;
      if (usd !== null && (!Number.isFinite(usd) || usd < 0)) usd = null;
      if (usd === null) {
        if (req.purpose === 'chat') usd = 0;
        else if (req.purpose === 'probe') usd = GATEWAY_LIMITS.probeReserveCapUsd;
        else if (unpriced !== null) usd = unpriced;
        else return { status: 'refused', error: { code: 'invalid_input', message: 'No price is known for this model, so GMI Desk cannot cap what an agent spends on it.', detail: 'unpriced_model' } };
      }
      if (req.purpose === 'chat') return { status: 'reserved', reservation: insert(req, usd) };

      // Synchronous from here to insert(): nothing else can reserve in between (§4.4).
      const free = appBudgetFree(budget.statusSnapshot());
      const capAlone = capRefusal(req.threadId, req.turnId, usd, true, usd);
      if (capAlone) return { status: 'refused', error: capAlone };
      if (usd > free + EPS) return { status: 'refused', error: budgetExceeded(usd, free) };
      const capNow = capRefusal(req.threadId, req.turnId, usd, false, usd);
      if (capNow) return { status: 'wait', usd, appBudget: false };
      // holdUsd: headroom an older request waiting for the app budget keeps (budget head-of-line).
      const hold = typeof req.holdUsd === 'number' && Number.isFinite(req.holdUsd) && req.holdUsd > 0 ? req.holdUsd : 0;
      if (usd + outstandingUsd() + hold > free + EPS) return { status: 'wait', usd, appBudget: true };
      return { status: 'reserved', reservation: insert(req, usd) };
    },

    outstandingUsd,
    count: () => held.size,
    onRelease(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
