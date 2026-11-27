/**
 * One TPM-aware scheduler for the whole org (harness.md §4.5).
 *
 * - Limit: `limitTpm` (Settings tier, T1 = 1M by default) and an AIMD `effectiveTpm`: on a 429 →
 *   max(0.25·limit, 0.7·effective) (at most one decrease per second, so a burst of 429s from requests that were
 *   already in flight counts once); +5 %·limit after each 60 s without a 429.
 * - Accounting: a sliding 60 s window. Admission debits P + maxOut; settle corrects it to the measured tokens. A
 *   requeue for a 429 or a connect failure removes the debit (the request was not processed); a maybe-billed retry
 *   keeps it.
 * - Order: priority class (interactive > foreground > background > idle, +1 class per 30 s waited, up to
 *   foreground), then per-thread fair share (the thread with the fewest tokens admitted goes first; a thread that
 *   was idle starts at the current minimum, i.e. deficit round-robin by tokens), then the original position. A
 *   requeued request keeps its original position.
 * - Head-of-line per model: when the first request for a model does not fit (TPM or the model's concurrency),
 *   younger and lower-class requests for that model wait too. After 2 minutes the head is admitted anyway, with a
 *   warning. A request also goes through at once when the window is empty (larger than the whole effective limit:
 *   waiting cannot make it fit).
 * - Budget head-of-line: the first ticket (in that order) that waits for the app budget holds its amount back; a
 *   later ticket is reserved only if it fits with that amount kept free, so a large request cannot starve.
 * - Admission order per ticket: connectivity gate → retry-after pause, head-of-line, concurrency (16 global, 6 per
 *   model, per thread 1 agent / 2 subagents / 1 compaction), TPM → Breaker.tryAcquire → ticket.reserve(), all in one
 *   synchronous pass (no await between the budget check and the insert).
 * - `queued` info: position = number of requests ahead; reason tpm | concurrency | breaker | budget | offline; ETA
 *   for TPM, Retry-After pauses and delayed requeues.
 */
import type { GmiErrorShape } from '@shared/contracts/errors';
import type { GatewayPurpose } from '@shared/contracts/gateway';
import type { Logger } from '../../core/logger';
import {
  GATEWAY_LIMITS,
  PRIORITY_RANK,
  type AdmitResult,
  type Breaker,
  type ConnectivityGate,
  type GatewayClock,
  type GatewayTimer,
  type QueuedInfo,
  type Reservation,
  type Reservations,
  type Scheduler,
  type SchedulerHandle,
  type SchedulerSlot,
  type SchedulerStats,
  type SchedulerTicket,
} from './types';

type Reason = QueuedInfo['reason'];

export interface SchedulerLimits {
  global: number;
  perModel: number;
  /** Per thread and purpose; a purpose not listed has no per-thread cap. */
  perThread: Readonly<Partial<Record<GatewayPurpose, number>>>;
}

export interface SchedulerDeps {
  clock: GatewayClock;
  breaker: Pick<Breaker, 'tryAcquire' | 'record' | 'onChange'>;
  connectivity: Pick<ConnectivityGate, 'online' | 'onChange'>;
  /** The org's TPM limit (GATEWAY_TPM_TIERS.t1 by default). */
  tpmLimit?: number;
  /** Re-evaluate queued(budget) requests when any reservation is released. */
  reservations?: Pick<Reservations, 'onRelease'>;
  limits?: Partial<SchedulerLimits>;
  log?: Logger;
}

interface Entry {
  /** Original position (kept across requeues). */
  seq: number;
  ticket: SchedulerTicket;
  /** Start of the waiting time that counts for aging and head-of-line (queued time only, requeues included). */
  waitStart: number;
  /** Start of this queue period. */
  queuedAt: number;
  queuedMsBefore: number;
  eligibleAt: number;
  requeueReason: Reason | null;
  resolve: (result: AdmitResult) => void;
  listeners: Set<(info: QueuedInfo) => void>;
  last: QueuedInfo | null;
  done: boolean;
  holWarned: boolean;
}

interface WindowRecord {
  at: number;
  tokens: number;
}

const DECREASE_MIN_INTERVAL_MS = 1_000;
const MAX_SERVED_THREADS = 1_000;

const sameInfo = (a: QueuedInfo | null, b: QueuedInfo) => !!a && a.position === b.position && a.reason === b.reason && a.etaMs === b.etaMs;

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { clock, breaker, connectivity, log } = deps;
  const limits: SchedulerLimits = {
    global: deps.limits?.global ?? GATEWAY_LIMITS.concurrency.global,
    perModel: deps.limits?.perModel ?? GATEWAY_LIMITS.concurrency.perModel,
    perThread: deps.limits?.perThread ?? GATEWAY_LIMITS.concurrency.perThread,
  };
  const t = GATEWAY_LIMITS.tpm;
  const FOREGROUND = PRIORITY_RANK.foreground;

  let tpmLimit = validLimit(deps.tpmLimit) ?? 1_000_000;
  let effective = tpmLimit;
  let lastAimdAt = clock.now();
  let lastDecreaseAt = Number.NEGATIVE_INFINITY;
  let last429At: number | null = null;

  const queue: Entry[] = [];
  const window: WindowRecord[] = [];
  let inFlight = 0;
  const inFlightByModel = new Map<string, number>();
  const inFlightByThreadPurpose = new Map<string, number>();
  const pausedUntil = new Map<string, number>();
  const served = new Map<string, number>();
  let seq = 0;
  let disposed = false;
  let pumping = false;
  let pumpAgain = false;
  let pumpScheduled = false;
  let timer: GatewayTimer | null = null;
  let timerAt = Number.POSITIVE_INFINITY;

  function validLimit(n: unknown): number | null {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  }

  const threadKey = (ticket: SchedulerTicket) => ticket.threadId ?? '-';
  const tpKey = (ticket: SchedulerTicket) => `${ticket.threadId}\u0000${ticket.purpose}`;
  const bump = (map: Map<string, number>, key: string, by: number) => {
    const next = (map.get(key) ?? 0) + by;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  const applyAimd = (now: number) => {
    if (effective >= tpmLimit) {
      effective = tpmLimit;
      lastAimdAt = Math.max(lastAimdAt, now - t.aimdQuietMs);
      return;
    }
    while (effective < tpmLimit && now - lastAimdAt >= t.aimdQuietMs) {
      effective = Math.min(tpmLimit, effective + t.aimdIncrease * tpmLimit);
      lastAimdAt += t.aimdQuietMs;
    }
  };

  const tpmUsed = (now: number): number => {
    while (window.length > 0 && now - window[0]!.at >= t.windowMs) window.shift();
    let sum = 0;
    for (const r of window) sum += r.tokens;
    return sum;
  };

  /** ms until `tokens` fit the window (null: they never will by expiry alone). */
  const tpmEta = (now: number, tokens: number): number | null => {
    let used = tpmUsed(now);
    if (used + tokens <= effective) return 0;
    for (const r of window) {
      used -= r.tokens;
      if (used + tokens <= effective) return Math.max(0, r.at + t.windowMs - now);
    }
    return null;
  };

  const effectiveClass = (e: Entry, now: number): number => {
    const base = PRIORITY_RANK[e.ticket.priority] ?? 0;
    if (base >= FOREGROUND) return base;
    return Math.min(FOREGROUND, base + Math.floor(Math.max(0, now - e.waitStart) / GATEWAY_LIMITS.agingStepMs));
  };

  const ordered = (now: number): Entry[] => {
    const cls = new Map<Entry, number>();
    for (const e of queue) cls.set(e, effectiveClass(e, now));
    return [...queue].sort(
      (a, b) => cls.get(b)! - cls.get(a)! || (served.get(threadKey(a.ticket)) ?? 0) - (served.get(threadKey(b.ticket)) ?? 0) || a.seq - b.seq,
    );
  };

  const notify = (e: Entry, info: QueuedInfo) => {
    if (e.done || sameInfo(e.last, info)) return;
    e.last = info;
    for (const l of [...e.listeners]) {
      try {
        l(info);
      } catch {
        // a listener must not break the queue
      }
    }
  };

  const removeFromQueue = (e: Entry) => {
    const i = queue.indexOf(e);
    if (i !== -1) queue.splice(i, 1);
  };

  const finish = (e: Entry, result: AdmitResult) => {
    if (e.done) return;
    e.done = true;
    removeFromQueue(e);
    e.resolve(result);
  };

  const schedulePump = () => {
    if (pumpScheduled || disposed) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  };

  const makeSlot = (e: Entry, reservation: Reservation, debit: WindowRecord, now: number): SchedulerSlot => {
    const ticket = e.ticket;
    let freed = false;
    const queuedMs = e.queuedMsBefore + Math.max(0, now - e.queuedAt);
    const free = () => {
      freed = true;
      inFlight = Math.max(0, inFlight - 1);
      bump(inFlightByModel, ticket.modelKey, -1);
      if (ticket.threadId) bump(inFlightByThreadPurpose, tpKey(ticket), -1);
    };
    return {
      requestId: ticket.requestId,
      reservation,
      queuedMs,
      release(actualTokens) {
        if (freed) return;
        free();
        if (actualTokens !== null && Number.isFinite(actualTokens) && actualTokens >= 0) debit.tokens = actualTokens;
        reservation.release();
        schedulePump();
      },
      requeue({ delayMs, reason }) {
        if (freed) return closedHandle();
        free();
        // A 429 or a connect failure: GMI did not process it, so it does not count against the window.
        if (reason === 'tpm' || reason === 'offline') debit.tokens = 0;
        reservation.release();
        const at = clock.now();
        const again: Entry = {
          seq: e.seq,
          ticket,
          waitStart: at - queuedMs,
          queuedAt: at,
          queuedMsBefore: queuedMs,
          eligibleAt: at + Math.max(0, Number.isFinite(delayMs) ? delayMs : 0),
          requeueReason: reason,
          resolve: () => undefined,
          listeners: new Set(),
          last: null,
          done: false,
          holWarned: e.holWarned,
        };
        const handle = handleFor(again);
        if (disposed) {
          again.done = true;
          again.resolve({ status: 'cancelled' });
          return handle;
        }
        queue.push(again);
        schedulePump();
        return handle;
      },
    };
  };

  const admit = (e: Entry, reservation: Reservation, now: number, virtualStart: number) => {
    const ticket = e.ticket;
    inFlight += 1;
    bump(inFlightByModel, ticket.modelKey, 1);
    if (ticket.threadId) bump(inFlightByThreadPurpose, tpKey(ticket), 1);
    const debit: WindowRecord = { at: now, tokens: Math.max(0, ticket.tpmTokens) };
    window.push(debit);
    const key = threadKey(ticket);
    served.delete(key);
    served.set(key, Math.max(served.get(key) ?? 0, virtualStart) + Math.max(1, ticket.tpmTokens));
    if (served.size > MAX_SERVED_THREADS) {
      const queuedThreads = new Set(queue.map((q) => threadKey(q.ticket)));
      for (const k of served.keys()) {
        if (served.size <= MAX_SERVED_THREADS / 2) break;
        if (!queuedThreads.has(k)) served.delete(k);
      }
    }
    finish(e, { status: 'admitted', slot: makeSlot(e, reservation, debit, now) });
  };

  /** One pass in priority order; true when it admitted or ended a ticket (the order is then recomputed). */
  const pass = (now: number, reasons: Map<Entry, { reason: Reason; eta: number | null }>): boolean => {
    const list = ordered(now);
    let virtualStart = Number.POSITIVE_INFINITY;
    for (const e of list) virtualStart = Math.min(virtualStart, served.get(threadKey(e.ticket)) ?? 0);
    if (!Number.isFinite(virtualStart)) virtualStart = 0;
    const blocked = new Map<string, { reason: Reason; eta: number | null }>();
    // Budget head-of-line (§4.4): the first ticket waiting for the app budget keeps its amount back, so younger
    // and smaller tickets cannot keep taking the headroom it waits for.
    let budgetHold = 0;

    for (const e of list) {
      const ticket = e.ticket;
      const key = ticket.modelKey;
      if (now < e.eligibleAt) {
        reasons.set(e, { reason: e.requeueReason ?? 'tpm', eta: e.eligibleAt - now });
        continue;
      }
      const pause = pausedUntil.get(key);
      if (pause !== undefined && pause > now) {
        reasons.set(e, { reason: 'tpm', eta: pause - now });
        continue;
      }
      const hol = blocked.get(key);
      if (hol) {
        reasons.set(e, hol);
        continue;
      }
      if (inFlight >= limits.global) {
        reasons.set(e, { reason: 'concurrency', eta: null });
        continue;
      }
      if ((inFlightByModel.get(key) ?? 0) >= limits.perModel) {
        const r = { reason: 'concurrency' as const, eta: null };
        reasons.set(e, r);
        blocked.set(key, r);
        continue;
      }
      const cap = ticket.threadId ? limits.perThread[ticket.purpose] : undefined;
      if (cap !== undefined && (inFlightByThreadPurpose.get(tpKey(ticket)) ?? 0) >= cap) {
        reasons.set(e, { reason: 'concurrency', eta: null });
        continue;
      }
      const used = tpmUsed(now);
      if (used > 0 && used + ticket.tpmTokens > effective) {
        if (now - e.waitStart < GATEWAY_LIMITS.headOfLineMaxWaitMs) {
          const r = { reason: 'tpm' as const, eta: tpmEta(now, ticket.tpmTokens) };
          reasons.set(e, r);
          blocked.set(key, r);
          continue;
        }
        if (!e.holWarned) {
          e.holWarned = true;
          log?.warn('gateway: admitting a request over the TPM limit after waiting at the head of the queue', { requestId: ticket.requestId, model: key, size: ticket.tpmTokens, used, effective });
        }
      }
      if (!breaker.tryAcquire(key, { force: ticket.forceProbe === true, owner: ticket.requestId })) {
        reasons.set(e, { reason: 'breaker', eta: null });
        continue;
      }
      let attempt: ReturnType<SchedulerTicket['reserve']>;
      try {
        attempt = ticket.reserve(budgetHold > 0 ? budgetHold : undefined);
      } catch (error) {
        const shape: GmiErrorShape = { code: 'internal', message: 'The budget check failed.', detail: error instanceof Error ? error.message : String(error) };
        attempt = { status: 'refused', error: shape };
      }
      if (attempt.status !== 'reserved') breaker.record(key, 'neutral', ticket.requestId);
      if (attempt.status === 'wait') {
        if (budgetHold === 0 && attempt.appBudget && typeof attempt.usd === 'number' && attempt.usd > 0) budgetHold = attempt.usd;
        reasons.set(e, { reason: 'budget', eta: null });
        continue;
      }
      if (attempt.status === 'refused') {
        finish(e, { status: 'refused', error: attempt.error });
        return true;
      }
      admit(e, attempt.reservation, now, virtualStart);
      return true;
    }
    return false;
  };

  const armTimer = (now: number, reasons: Map<Entry, { reason: Reason; eta: number | null }>) => {
    let next = Number.POSITIVE_INFINITY;
    for (const e of queue) {
      if (e.eligibleAt > now) next = Math.min(next, e.eligibleAt);
      const r = reasons.get(e);
      if (r?.eta !== null && r?.eta !== undefined && r.eta > 0) next = Math.min(next, now + r.eta);
      if (r?.reason === 'tpm') next = Math.min(next, e.waitStart + GATEWAY_LIMITS.headOfLineMaxWaitMs);
      const base = PRIORITY_RANK[e.ticket.priority] ?? 0;
      if (effectiveClass(e, now) < FOREGROUND && base < FOREGROUND) {
        const waited = Math.max(0, now - e.waitStart);
        next = Math.min(next, e.waitStart + (Math.floor(waited / GATEWAY_LIMITS.agingStepMs) + 1) * GATEWAY_LIMITS.agingStepMs);
      }
    }
    if (queue.length > 0 && effective < tpmLimit) next = Math.min(next, lastAimdAt + t.aimdQuietMs);
    for (const [key, until] of pausedUntil) {
      if (until <= now) pausedUntil.delete(key);
      else if (queue.some((e) => e.ticket.modelKey === key)) next = Math.min(next, until);
    }
    if (!Number.isFinite(next)) return;
    if (timer !== null && timerAt <= next && timerAt > now) return;
    if (timer !== null) clock.clearTimeout(timer);
    timerAt = next;
    timer = clock.setTimeout(() => {
      timer = null;
      timerAt = Number.POSITIVE_INFINITY;
      pump();
    }, Math.max(0, next - now));
  };

  function pump(): void {
    if (disposed) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        const now = clock.now();
        applyAimd(now);
        if (!connectivity.online()) {
          ordered(now).forEach((e, i) => notify(e, { position: i, etaMs: null, reason: 'offline' }));
          continue;
        }
        const reasons = new Map<Entry, { reason: Reason; eta: number | null }>();
        while (queue.length > 0) {
          reasons.clear();
          if (!pass(now, reasons)) break;
        }
        ordered(now).forEach((e, i) => {
          const r = reasons.get(e) ?? { reason: 'concurrency' as const, eta: null };
          notify(e, { position: i, etaMs: r.eta === null ? null : Math.max(0, Math.round(r.eta)), reason: r.reason });
        });
        armTimer(now, reasons);
      } while (pumpAgain && !disposed);
    } finally {
      pumping = false;
    }
  }

  function handleFor(e: Entry): SchedulerHandle {
    const result = new Promise<AdmitResult>((resolve) => {
      e.resolve = resolve;
    });
    return {
      result,
      onQueued(listener) {
        e.listeners.add(listener);
        if (e.last && !e.done) {
          try {
            listener(e.last);
          } catch {
            // ignore
          }
        }
        return () => {
          e.listeners.delete(listener);
        };
      },
      cancel() {
        if (e.done) return;
        finish(e, { status: 'cancelled' });
        schedulePump();
      },
    };
  }

  function closedHandle(): SchedulerHandle {
    return { result: Promise.resolve({ status: 'cancelled' }), onQueued: () => () => undefined, cancel: () => undefined };
  }

  const unsubscribe = [breaker.onChange(schedulePump), connectivity.onChange(schedulePump), deps.reservations?.onRelease(schedulePump) ?? (() => undefined)];

  return {
    enqueue(ticket) {
      const now = clock.now();
      seq += 1;
      const e: Entry = {
        seq,
        ticket: { ...ticket, tpmTokens: Number.isFinite(ticket.tpmTokens) && ticket.tpmTokens > 0 ? ticket.tpmTokens : 0 },
        waitStart: now,
        queuedAt: now,
        queuedMsBefore: 0,
        eligibleAt: now,
        requeueReason: null,
        resolve: () => undefined,
        listeners: new Set(),
        last: null,
        done: false,
        holWarned: false,
      };
      // Keep the caller's reserve() bound to the original ticket object.
      e.ticket.reserve = (holdUsd) => ticket.reserve(holdUsd);
      const handle = handleFor(e);
      if (disposed) {
        e.done = true;
        e.resolve({ status: 'cancelled' });
        return handle;
      }
      queue.push(e);
      schedulePump();
      return handle;
    },

    report429(modelKey, retryAfterSec) {
      const now = clock.now();
      applyAimd(now);
      last429At = now;
      if (now - lastDecreaseAt >= DECREASE_MIN_INTERVAL_MS) {
        const before = effective;
        effective = Math.max(t.aimdFloor * tpmLimit, t.aimdDecrease * effective);
        lastDecreaseAt = now;
        log?.debug('gateway.aimd', { model: modelKey, from: Math.round(before), to: Math.round(effective) });
      }
      lastAimdAt = now;
      if (retryAfterSec !== null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        const until = now + Math.min(retryAfterSec * 1000, GATEWAY_LIMITS.retry.rateLimitGiveUpMs);
        pausedUntil.set(modelKey, Math.max(pausedUntil.get(modelKey) ?? 0, until));
      }
      schedulePump();
    },

    setTpmLimit(limit) {
      const next = validLimit(limit);
      if (next === null || next === tpmLimit) return;
      const wasFull = effective >= tpmLimit;
      tpmLimit = next;
      effective = wasFull ? next : Math.min(effective, next);
      schedulePump();
    },

    wake: pump,

    stats(): SchedulerStats {
      const now = clock.now();
      applyAimd(now);
      return {
        tpmLimit,
        tpmEffective: Math.round(effective),
        tpmUsedLastMinute: tpmUsed(now),
        queued: queue.length,
        inFlight,
        inFlightByModel: Object.fromEntries(inFlightByModel),
        last429At,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      for (const off of unsubscribe) off();
      for (const e of [...queue]) finish(e, { status: 'cancelled' });
    },
  };
}
