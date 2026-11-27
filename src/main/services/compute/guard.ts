// The compute cost guard (compute.md §9): accrual from phase transitions, the compute SpendSource, the budget gate,
// leases (T−15/5/1 warnings, expiry actions, clock-gated destructive catch-up), budget actions per `onBudget`, idle
// pause on user activity only, auto-extend, `actionPending` retries with back-off, alarms and the quit check.
// Built against the frozen C1-0 interfaces (types.ts); C1-C's slice wires it (createComputeGuard below).
import type { ComputeKind, ComputeResource, LeaseAction, LeasePolicy } from '@shared/contracts/compute';
import { toGmiError } from '@shared/contracts/errors';
import { formatUsd } from '@shared/lib/money';
import type { AppContext } from '../../core/context';
import type { AuthService, BudgetGuard, BudgetSources } from '../../core/services';
import {
  applyTransition,
  burnUsdPerHour,
  createComputeSpendSource,
  effectiveLeaseEndMs,
  isBilling,
  openInterval,
  recordAccrual,
  recordUsdPerHour,
  spendSince,
  startOfLocalDay,
  startOfLocalMonth,
} from './accrual';
import { createAlarmCenter, type ComputeAlarmCenter } from './alarms';
import { assessQuote, effectiveAction, formatDuration } from './pricing';
import {
  COMPUTE_TIMING,
  USER_ACTIVITY_KINDS,
  type ComputeActivity,
  type ComputeRecord,
  type Guard,
  type GuardCause,
  type LeaseChangeAssessment,
  type PhaseTransition,
  type PriceBook,
  type Registry,
  type ResourceActions,
  type ResourceCost,
  type Supervisor,
} from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** A successful guard action is not repeated for this long while the poll catches up with the new phase. */
const APPLIED_SUPPRESS_MS = 2 * MINUTE_MS;
/** Budget warning when what is left lasts at most this long at the current burn (§9.3). */
const BUDGET_WARNING_WINDOW_H = 0.25;
/** Phases in which GMI accepts no pause or delete right now; the action waits (it is not a failure). */
const BUSY_FOR: Record<'pause' | 'delete', ReadonlySet<ComputeResource['phase']>> = {
  pause: new Set(['pausing', 'paused', 'deleting', 'deleted']),
  delete: new Set(['deleting', 'deleted']),
};

export type QuitChoice = 'delete' | 'keep' | 'cancel';

/** The quit dialog (§9.7). The default uses two native confirms because Platform has no three-button dialog yet. */
export type QuitDialog = (info: { count: number; usdPerHour: number; message: string }) => Promise<QuitChoice>;

export interface GuardDeps {
  ctx: AppContext;
  registry: Registry;
  supervisor: Supervisor;
  actions: ResourceActions;
  prices: PriceBook;
  budget: BudgetGuard;
  budgetSources: BudgetSources;
  /** Raises `key_invalid` when the Compute key turns invalid (C1-A). */
  auth?: AuthService | null;
  /** Electron powerMonitor (suspend stops the timers; resume ticks and polls at once, §9.7). */
  power?: { onSuspend(listener: () => void): () => void; onResume(listener: () => void): () => void } | null;
  quitDialog?: QuitDialog;
  /** H4: whether an agent run is active (an agent tool call counts as activity only then, §9.5). */
  isRunActive?: (runId: string) => boolean;
  alarms?: ComputeAlarmCenter;
}

export interface ComputeGuard extends Guard {
  readonly alarms: ComputeAlarmCenter;
  /** Applies one supervisor transition to the record's intervals (subscribed by start(); exposed for tests). */
  handleTransition(t: PhaseTransition): Promise<void>;
}

const iso = (t: number) => new Date(t).toISOString();
const ms = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
};
const minNonNull = (...values: Array<number | null>): number | null => {
  const set = values.filter((v): v is number => v !== null);
  return set.length === 0 ? null : Math.min(...set);
};
const clockTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const label = (r: Readonly<ComputeRecord>) => r.displayName || r.name;
/** 240 → "4-hour", 90 → "90-minute", 1440 → "1-day" (as in "its 4-hour lease ended"). */
export function leaseAdjective(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${Math.round(minutes)}-minute`;
}
const kindWord = (kind: ComputeKind) => (kind === 'container' ? 'container' : 'sandbox');

/** `onBudget` when the record has no lease: sandboxes pause, containers notify (§9.3). */
const defaultOnBudget = (kind: ComputeKind): LeaseAction => (kind === 'sandbox' ? 'pause' : 'notify');

/**
 * Which native dialog a `setLease` patch needs (§9.3). Deletes sooner: a delete-on-expiry lifetime shorter than the
 * time already run + 15 min, or `onExpiry` / `onBudget` newly set to `delete`. Loosens: a longer or no lifetime,
 * `notify` instead of `delete`/`pause`, idle pause off or longer.
 */
export function assessLeaseChange(
  record: Readonly<ComputeRecord>,
  patch: Partial<LeasePolicy>,
  now: Date,
): LeaseChangeAssessment {
  const reasons: string[] = [];
  const current = record.lease;
  const base: LeasePolicy = current ?? { maxLifetimeMin: null, onExpiry: 'notify', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' };
  const next: LeasePolicy = { ...base, ...patch };
  const kind = record.kind;
  const name = label(record);
  let deletesSooner = false;
  let loosens = false;

  const start = ms(record.runningSince);
  const ranMin = start === null ? 0 : Math.max(0, (now.getTime() - start) / MINUTE_MS);
  const nextExpiry = effectiveAction(kind, next.onExpiry);
  const curExpiry = current ? effectiveAction(kind, current.onExpiry) : null;
  const nextBudget = effectiveAction(kind, next.onBudget);
  const curBudget = current ? effectiveAction(kind, current.onBudget) : null;

  if (nextExpiry === 'delete' && next.maxLifetimeMin !== null && next.maxLifetimeMin < ranMin + 15) {
    deletesSooner = true;
    const when = start === null ? null : Math.max(start + next.maxLifetimeMin * MINUTE_MS, now.getTime() + COMPUTE_TIMING.leaseChangeGraceMs);
    reasons.push(
      when === null
        ? `${name} will be deleted ${formatDuration(next.maxLifetimeMin)} after it starts running.`
        : `${name} will be deleted at about ${clockTime(when)} (in ${Math.max(15, Math.round((when - now.getTime()) / MINUTE_MS))} min).`,
    );
  }
  if (patch.onExpiry !== undefined && nextExpiry === 'delete' && curExpiry !== 'delete') {
    deletesSooner = true;
    reasons.push(`${name} will be deleted when its lease ends, not ${curExpiry === 'pause' ? 'paused' : 'left running'}.`);
  }
  if (patch.onBudget !== undefined && nextBudget === 'delete' && curBudget !== 'delete') {
    deletesSooner = true;
    reasons.push(`${name} will be deleted when your compute budget runs out.`);
  }

  if (patch.maxLifetimeMin !== undefined && current) {
    if (next.maxLifetimeMin === null && current.maxLifetimeMin !== null) {
      loosens = true;
      reasons.push(`No automatic limit: ${name} keeps billing until you delete it.`);
    } else if (next.maxLifetimeMin !== null && current.maxLifetimeMin !== null && next.maxLifetimeMin > current.maxLifetimeMin) {
      loosens = true;
      reasons.push(`Lifetime: ${formatDuration(current.maxLifetimeMin)} → ${formatDuration(next.maxLifetimeMin)}.`);
    }
  }
  if (patch.onExpiry !== undefined && nextExpiry === 'notify' && curExpiry !== null && curExpiry !== 'notify') {
    loosens = true;
    reasons.push(`When the lease ends, ${name} is no longer ${curExpiry === 'delete' ? 'deleted' : 'paused'}: it keeps billing.`);
  }
  if (patch.onBudget !== undefined && nextBudget === 'notify' && curBudget !== null && curBudget !== 'notify') {
    loosens = true;
    reasons.push(`Your budget will not stop this ${kindWord(kind)}.`);
  }
  if (patch.idlePauseMin !== undefined && current && current.idlePauseMin !== null) {
    if (next.idlePauseMin === null) {
      loosens = true;
      reasons.push('Idle pause turns off.');
    } else if (next.idlePauseMin > current.idlePauseMin) {
      loosens = true;
      reasons.push(`Idle pause: ${current.idlePauseMin} min → ${next.idlePauseMin} min.`);
    }
  }
  return { loosens, deletesSooner, reasons };
}

/**
 * The native dialog for a `setLease` patch (§9.3), shown by main so a renderer cannot skip it. Resolves true when the
 * change may be applied: it only tightens (no dialog), or the user confirmed what gets deleted sooner / looser.
 */
export async function confirmLeaseChange(ctx: AppContext, record: Readonly<ComputeRecord>, assessment: LeaseChangeAssessment): Promise<boolean> {
  if (!assessment.loosens && !assessment.deletesSooner) return true;
  const name = label(record);
  return ctx.platform.confirm({
    title: assessment.deletesSooner ? 'Delete sooner' : 'Loosen lease',
    message: assessment.deletesSooner ? `Change the lease of ${name}? It will be deleted sooner.` : `Loosen the lease of ${name}? It can bill for longer.`,
    detail: assessment.reasons.map((line) => `• ${line}`).join('\n'),
    confirmLabel: assessment.deletesSooner ? 'Change lease' : 'Loosen lease',
    cancelLabel: 'Keep current lease',
  });
}

/** The default quit dialog: "Delete all and quit?" first, then "Keep running and quit?" (Cancel stays in the app). */
export function confirmQuitDialog(ctx: AppContext): QuitDialog {
  return async ({ message }) => {
    const del = await ctx.platform.confirm({
      title: 'Containers are still running',
      message,
      detail: 'Delete them now and quit, or choose to keep them running on the next step.',
      confirmLabel: 'Delete all and quit',
      cancelLabel: 'Keep them…',
    });
    if (del) return 'delete';
    const keep = await ctx.platform.confirm({
      title: 'Keep containers running?',
      message,
      detail: 'Leases are enforced again the next time GMI Desk starts.',
      confirmLabel: 'Keep running and quit',
      cancelLabel: 'Cancel',
    });
    return keep ? 'keep' : 'cancel';
  };
}

export function createComputeGuard(deps: GuardDeps): ComputeGuard {
  const { ctx, registry, supervisor, actions } = deps;
  const log = ctx.log.child('compute.guard');
  const alarms = deps.alarms ?? createAlarmCenter({ ctx });
  const now = () => supervisor.clock.now();
  const records = () => registry.list({ includeTombstones: true });
  const spend = createComputeSpendSource(records, now);
  const quitDialog = deps.quitDialog ?? confirmQuitDialog(ctx);

  const lastActivity = new Map<string, number>();
  /** Lease warnings already sent, per resource, for one lease end. */
  const warned = new Map<string, { end: number; sent: Set<number> }>();
  const inflight = new Map<string, Promise<void>>();
  const applied = new Map<string, { action: LeaseAction; at: number }>();
  const extending = new Set<string>();
  const listeners = new Set<() => void>();
  const unsubscribers: Array<() => void> = [];
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let suspended = false;
  let ticking: Promise<void> | null = null;
  let transitions: Promise<void> = Promise.resolve();

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.warn('guard listener failed', error);
      }
    }
  };

  const priceFor = (r: Readonly<ComputeRecord>): number | null => {
    if (!r.sku) return null;
    try {
      return deps.prices.price(r.sku, r.idc).usdPerHour;
    } catch {
      return null;
    }
  };

  // ── Transitions → intervals ────────────────────────────────────────────────────────────────────────────────────

  async function applyOne(t: PhaseTransition): Promise<void> {
    const r = registry.get(t.resourceId);
    if (!r) return;
    if (applyTransition(r, t, priceFor)) {
      await registry.update(t.resourceId, (cur) => applyTransition(cur, t, priceFor) ?? cur);
    }
    if (t.to === 'deleted') {
      for (const kind of ['budget_warning', 'budget_exhausted', 'lease_expiring', 'price_unknown', 'lease_action_failed'] as const) {
        alarms.resolve(kind, t.resourceId);
      }
      warned.delete(t.resourceId);
      lastActivity.delete(t.resourceId);
    }
    const after = registry.get(t.resourceId);
    if (after && !isBilling(after) && after.actionPending) {
      await registry.setActionPending(t.resourceId, null);
      alarms.resolve('lease_action_failed', t.resourceId);
    }
    changed();
  }

  function handleTransition(t: PhaseTransition): Promise<void> {
    const run = transitions.then(() => applyOne(t)).catch((error) => log.warn('accrual update failed', { rid: t.resourceId, error: toGmiError(error).code }));
    transitions = run;
    return run;
  }

  // ── Actions with retries (§9.4) ────────────────────────────────────────────────────────────────────────────────

  /** A delete needs GMI's clock and fresh remote state in this run (§9.4: a wrong local clock never deletes). */
  const deleteAllowed = (r: Readonly<ComputeRecord>) => supervisor.clock.verified() && supervisor.freshSince(r.id) !== null;

  function describeAction(r: Readonly<ComputeRecord>, action: 'pause' | 'delete', cause: GuardCause): { title: string; body: string } {
    const verb = action === 'delete' ? 'Deleted' : 'Paused';
    const life = r.lease?.maxLifetimeMin ? `${leaseAdjective(r.lease.maxLifetimeMin)} lease` : 'lease';
    const resume = action === 'pause' ? ' Resume it from Compute.' : '';
    switch (cause) {
      case 'catch_up':
        return { title: `${verb} ${label(r)}`, body: `Its ${life} ended while GMI Desk was closed.${resume}` };
      case 'lease':
        return { title: `${verb} ${label(r)}`, body: `Its ${life} ended.${resume}` };
      case 'budget':
        return { title: `${verb} ${label(r)}`, body: `Your compute budget is used up.${resume}` };
      case 'idle':
        return { title: `Paused ${label(r)} after ${r.lease?.idlePauseMin ?? 0} min idle`, body: `Nobody used it for ${r.lease?.idlePauseMin ?? 0} min.${resume}` };
      default:
        return { title: `${verb} ${label(r)}`, body: resume.trim() || 'Done.' };
    }
  }

  async function applyAction(r: Readonly<ComputeRecord>, action: 'pause' | 'delete', cause: GuardCause, t: number): Promise<void> {
    if (inflight.has(r.id) || BUSY_FOR[action].has(r.phase) || supervisor.pendingAction(r.id) !== null) return;
    const recent = applied.get(r.id);
    if (recent && recent.action === action && t - recent.at < APPLIED_SUPPRESS_MS) return;

    let pending = r.actionPending;
    if (!pending || pending.action !== action) {
      pending = { action, dueAt: iso(t), attempts: 0, lastError: null };
      await registry.setActionPending(r.id, pending);
    }
    if ((ms(pending.dueAt) ?? 0) > t) return;
    if (action === 'delete' && !deleteAllowed(r)) {
      log.debug('guard.action waits for GMI clock', { rid: r.id });
      return;
    }

    const attempt = pending;
    const run = (async () => {
      const usdPerHour = recordUsdPerHour(r);
      try {
        if (action === 'delete') await actions.delete(r.id, cause);
        else await actions.pause(r.id, cause);
        applied.set(r.id, { action, at: now().getTime() });
        log.info('guard.action', { rid: r.id, action, reason: cause, usdPerHour });
        await registry.setActionPending(r.id, null).catch(() => undefined);
        alarms.resolve('lease_action_failed', r.id);
        const text = describeAction(r, action, cause);
        alarms.raise({ kind: 'lease_action', severity: 'info', resourceId: r.id, title: text.title, body: text.body, usdPerHour, actions: ['open', 'dismiss'] }, { notify: 'force' });
      } catch (error) {
        const e = toGmiError(error);
        const attempts = attempt.attempts + 1;
        const backoff = COMPUTE_TIMING.actionRetryMs;
        const delay = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 10 * MINUTE_MS;
        log.warn('guard.action failed', { rid: r.id, action, reason: cause, attempts, code: e.code });
        await registry
          .setActionPending(r.id, { action, dueAt: iso(now().getTime() + delay), attempts, lastError: e.message })
          .catch(() => undefined);
        if (attempts >= COMPUTE_TIMING.actionFailuresBeforeAlarm) {
          alarms.raise({
            kind: 'lease_action_failed',
            severity: 'critical',
            resourceId: r.id,
            title: `Could not ${action} ${label(r)}`,
            body: `GMI Desk tried ${attempts} times and keeps trying. It is still billing${usdPerHour ? ` ${formatUsd(usdPerHour)}/h (list)` : ''}. Last error: ${e.message}`,
            usdPerHour,
            actions: [action === 'delete' ? 'delete' : 'pause', 'open_console', 'open'],
          });
        }
      }
    })();
    inflight.set(r.id, run);
    try {
      await run;
    } finally {
      inflight.delete(r.id);
    }
  }

  // ── Idle and auto-extend (§9.5, §7.3) ──────────────────────────────────────────────────────────────────────────

  function idlePauseAtMs(r: Readonly<ComputeRecord>): number | null {
    if (r.kind !== 'sandbox' || r.phase !== 'running' || !r.lease || r.lease.idlePauseMin === null) return null;
    const open = openInterval(r);
    // The activity clock lives in memory: after an app start nobody's use is known, so the idle period counts from
    // the guard's start at the earliest (a sandbox used right before a restart is not paused at once).
    const base = Math.max(lastActivity.get(r.id) ?? 0, ms(open?.from) ?? 0, ms(r.runningSince) ?? 0, startedAt ?? 0);
    if (base === 0) return null;
    return base + r.lease.idlePauseMin * MINUTE_MS;
  }

  async function maybeExtend(r: Readonly<ComputeRecord>, t: number): Promise<void> {
    if (r.kind !== 'sandbox' || r.phase !== 'running' || !r.lease?.extendOnActivity || extending.has(r.id)) return;
    const serverEnd = ms(r.serverEndsAt);
    if (serverEnd === null) return;
    const left = serverEnd - t;
    if (left <= 0 || left > COMPUTE_TIMING.autoExtendWhenRemainingMs) return;
    const last = lastActivity.get(r.id);
    if (last === undefined || t - last > COMPUTE_TIMING.autoExtendActivityWindowMs) return;

    const start = ms(r.runningSince);
    const caps = [effectiveLeaseEndMs(r), start !== null && r.approvedMaxLifetimeMin !== null ? start + r.approvedMaxLifetimeMin * MINUTE_MS : null];
    const cap = minNonNull(...caps) ?? Number.POSITIVE_INFINITY;
    const target = Math.min(serverEnd + COMPUTE_TIMING.autoExtendByMs, cap);
    if (target - serverEnd < MINUTE_MS) return;

    const status = deps.budget.statusSnapshot();
    const price = recordUsdPerHour(r);
    const remaining = minNonNull(status.remainingTodayUsd, status.remainingMonthUsd);
    if (status.budget.enforce && remaining !== null && price !== null && (price * (target - serverEnd)) / HOUR_MS > remaining) return;

    const seconds = Math.min(86_400, Math.max(60, Math.ceil((target - t) / 1000)));
    extending.add(r.id);
    try {
      const newEnd = await actions.extendServerTimeout(r.id, seconds, 'activity');
      log.info('guard.action', { rid: r.id, action: 'extend', reason: 'activity', usdPerHour: price });
      if (ms(newEnd) !== null) await registry.update(r.id, (cur) => ({ ...cur, serverEndsAt: newEnd }));
    } catch (error) {
      log.warn('auto-extend failed', { rid: r.id, code: toGmiError(error).code });
    } finally {
      extending.delete(r.id);
    }
  }

  // ── Lease warnings (§9.4) ──────────────────────────────────────────────────────────────────────────────────────

  function leaseWarning(r: Readonly<ComputeRecord>, end: number, t: number): void {
    const leftMin = (end - t) / MINUTE_MS;
    const windows = COMPUTE_TIMING.leaseWarningsMin;
    if (leftMin > (windows[0] ?? 15)) {
      alarms.resolve('lease_expiring', r.id);
      return;
    }
    let state = warned.get(r.id);
    if (!state || state.end !== end) {
      state = { end, sent: new Set() };
      warned.set(r.id, state);
    }
    // The smallest window already reached (T−15 → 15, T−4 → 5, T−0.5 → 1).
    let threshold: number | null = null;
    for (const w of windows) if (leftMin <= w) threshold = w;
    const act = effectiveAction(r.kind, r.lease?.onExpiry ?? 'notify');
    const what = act === 'delete' ? 'deleted' : act === 'pause' ? 'paused' : 'left running (still billing)';
    const mins = Math.max(1, Math.ceil(leftMin));
    const force = threshold !== null && !state.sent.has(threshold);
    if (force && threshold !== null) for (const w of windows) if (w >= threshold) state.sent.add(w);
    alarms.raise(
      {
        kind: 'lease_expiring',
        severity: 'warning',
        resourceId: r.id,
        title: `${label(r)}: lease ends in ${mins} min`,
        body: `It will be ${what} at ${clockTime(end)}. Open it to extend by 1 h.`,
        usdPerHour: recordUsdPerHour(r),
        actions: ['extend', 'open'],
      },
      { notify: force ? 'force' : 'never' },
    );
  }

  // ── The tick ──────────────────────────────────────────────────────────────────────────────────────────────────

  function checkHealth(): void {
    const health = supervisor.health();
    const down = (['ce', 'sandbox'] as const).filter((k) => health[k] === 'down');
    if (down.length === 0) {
      alarms.resolve('api_unavailable', null);
      return;
    }
    alarms.raise({
      kind: 'api_unavailable',
      severity: 'warning',
      resourceId: null,
      title: "GMI's compute API is not answering",
      body: 'Spend estimates continue from the last known state. Leases and budgets apply again as soon as GMI answers.',
      usdPerHour: null,
      actions: ['open'],
    });
  }

  function checkKey(): void {
    const info = deps.auth?.getState().computeKey;
    if (info?.status === 'invalid') {
      alarms.raise({
        kind: 'key_invalid',
        severity: 'warning',
        resourceId: null,
        title: 'Your Compute key stopped working',
        body: 'GMI Desk cannot manage or stop your resources until you connect a new key. Running resources keep billing.',
        usdPerHour: null,
        actions: ['connect_key'],
      });
    } else {
      alarms.resolve('key_invalid', null);
    }
  }

  function resolveRunningAlarms(id: string): void {
    for (const kind of ['budget_warning', 'budget_exhausted', 'lease_expiring', 'price_unknown'] as const) alarms.resolve(kind, id);
  }

  async function runTick(): Promise<void> {
    const t = now().getTime();
    const all = records();
    checkHealth();
    checkKey();
    const status = deps.budget.statusSnapshot();
    const burn = burnUsdPerHour(all);
    const remaining = minNonNull(status.remainingTodayUsd, status.remainingMonthUsd);
    const tasks: Array<Promise<void>> = [];

    for (const r of all) {
      if (!r.managed || r.tombstone !== null) continue;
      if (!isBilling(r)) {
        resolveRunningAlarms(r.id);
        if (r.actionPending) tasks.push(registry.setActionPending(r.id, null).then(() => alarms.resolve('lease_action_failed', r.id)));
        continue;
      }
      const price = recordUsdPerHour(r);
      if (price === null) {
        alarms.raise(
          {
            kind: 'price_unknown',
            severity: 'warning',
            resourceId: r.id,
            title: `Price unknown for ${label(r)}`,
            body: 'GMI Desk cannot verify what this costs per hour, so spend estimates and budgets leave it out.',
            usdPerHour: null,
            actions: ['open', 'delete'],
          },
          { notify: 'never' },
        );
      } else {
        alarms.resolve('price_unknown', r.id);
      }

      let want: { action: 'pause' | 'delete'; cause: GuardCause } | null = null;

      // 1. Lease.
      const end = effectiveLeaseEndMs(r);
      if (end !== null && r.lease) {
        if (t >= end) {
          const act = effectiveAction(r.kind, r.lease.onExpiry);
          if (act === 'notify') {
            alarms.raise({
              kind: 'lease_expiring',
              severity: 'critical',
              resourceId: r.id,
              title: `${label(r)}: lease ended, still billing`,
              body: `Its ${formatDuration(r.lease.maxLifetimeMin ?? 0)} lease ended at ${clockTime(end)}. It keeps billing${price ? ` ${formatUsd(price)}/h (list)` : ''} until you delete it.`,
              usdPerHour: price,
              actions: ['delete', 'extend', 'open'],
            });
          } else {
            want = { action: act, cause: startedAt !== null && end < startedAt ? 'catch_up' : 'lease' };
          }
        } else {
          leaseWarning(r, end, t);
        }
      } else {
        alarms.resolve('lease_expiring', r.id);
      }

      // 2. Budget.
      if (remaining !== null && remaining <= 0) {
        alarms.resolve('budget_warning', r.id);
        const act = effectiveAction(r.kind, r.lease?.onBudget ?? defaultOnBudget(r.kind));
        if (!status.budget.enforce) {
          alarms.raise({
            kind: 'budget_exhausted',
            severity: 'warning',
            resourceId: r.id,
            title: 'Compute budget used up',
            body: `Limits are not enforced, so ${label(r)} keeps running${price ? ` at ${formatUsd(price)}/h (list)` : ''}.`,
            usdPerHour: price,
            actions: ['open'],
          });
        } else if (act === 'notify') {
          alarms.raise({
            kind: 'budget_exhausted',
            severity: 'critical',
            resourceId: r.id,
            title: `Budget used up: ${label(r)} is still billing`,
            body: `Your budget will not stop this ${kindWord(r.kind)}. It keeps billing${price ? ` ${formatUsd(price)}/h (list)` : ''} until you delete it.`,
            usdPerHour: price,
            actions: r.kind === 'container' ? ['delete', 'open'] : ['pause', 'delete', 'open'],
          });
        } else {
          alarms.resolve('budget_exhausted', r.id);
          want ??= { action: act, cause: 'budget' };
        }
      } else if (remaining !== null && burn > 0 && remaining <= burn * BUDGET_WARNING_WINDOW_H) {
        alarms.resolve('budget_exhausted', r.id);
        alarms.raise({
          kind: 'budget_warning',
          severity: 'warning',
          resourceId: r.id,
          title: 'Compute budget almost used up',
          body: `${formatUsd(remaining)} left at ${formatUsd(burn)}/h (list). ${label(r)} will be ${describeBudgetAction(r)} when it runs out.`,
          usdPerHour: price,
          actions: ['open', r.kind === 'sandbox' ? 'pause' : 'delete'],
        });
      } else {
        alarms.resolve('budget_warning', r.id);
        alarms.resolve('budget_exhausted', r.id);
      }

      // 3. Idle (sandboxes only, user activity only).
      if (!want) {
        const idleAt = idlePauseAtMs(r);
        if (idleAt !== null && t >= idleAt) want = { action: 'pause', cause: 'idle' };
      }

      if (want) {
        tasks.push(applyAction(r, want.action, want.cause, t));
      } else {
        if (r.actionPending) tasks.push(registry.setActionPending(r.id, null).then(() => alarms.resolve('lease_action_failed', r.id)));
        tasks.push(maybeExtend(r, t));
      }
    }

    const results = await Promise.allSettled(tasks);
    for (const res of results) if (res.status === 'rejected') log.warn('guard tick step failed', { code: toGmiError(res.reason).code });
    changed();
  }

  function describeBudgetAction(r: Readonly<ComputeRecord>): string {
    const act = effectiveAction(r.kind, r.lease?.onBudget ?? defaultOnBudget(r.kind));
    return act === 'delete' ? 'deleted' : act === 'pause' ? 'paused' : 'left running';
  }

  function tick(): Promise<void> {
    if (ticking) return ticking;
    ticking = runTick()
      .catch((error) => log.warn('guard tick failed', { code: toGmiError(error).code }))
      .finally(() => {
        ticking = null;
      });
    return ticking;
  }

  const startTimer = () => {
    if (timer || suspended) return;
    timer = setInterval(() => void tick(), COMPUTE_TIMING.guardTickMs);
    timer.unref?.();
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  // ── Quit check (§9.7) ──────────────────────────────────────────────────────────────────────────────────────────

  async function quitCheck(): Promise<'quit' | 'cancel'> {
    const billing = registry.list().filter((r) => r.managed && r.kind === 'container' && isBilling(r) && r.phase !== 'deleting');
    if (billing.length === 0) return 'quit';
    const usd = billing.reduce((sum, r) => sum + (recordUsdPerHour(r) ?? 0), 0);
    const n = billing.length;
    const message = `${n === 1 ? '1 container is' : `${n} containers are`} still running (${formatUsd(usd)}/h list). ${n === 1 ? 'It keeps' : 'They keep'} billing after GMI Desk quits.`;
    const choice = await quitDialog({ count: n, usdPerHour: usd, message });
    if (choice === 'cancel') return 'cancel';
    if (choice === 'keep') return 'quit';
    const results = await Promise.allSettled(billing.map((r) => actions.delete(r.id, 'quit')));
    const failed = billing.filter((_, i) => results[i]?.status === 'rejected');
    for (const r of billing) if (!failed.includes(r)) log.info('guard.action', { rid: r.id, action: 'delete', reason: 'quit', usdPerHour: recordUsdPerHour(r) });
    if (failed.length === 0) return 'quit';
    const quit = await ctx.platform.confirm({
      title: 'Some containers were not deleted',
      message: `${failed.map(label).join(', ')} could not be deleted and ${failed.length === 1 ? 'keeps' : 'keep'} billing.`,
      detail: 'Stay to try again from Compute, or quit and delete them in the GMI console.',
      confirmLabel: 'Quit anyway',
      cancelLabel: 'Stay',
    });
    return quit ? 'quit' : 'cancel';
  }

  // ── The Guard ─────────────────────────────────────────────────────────────────────────────────────────────────

  const guard: ComputeGuard = {
    start() {
      if (startedAt !== null) return;
      startedAt = now().getTime();
      unsubscribers.push(deps.budgetSources.register(spend));
      unsubscribers.push(supervisor.onTransition((t) => void handleTransition(t)));
      unsubscribers.push(alarms.onChange(changed));
      if (deps.auth) unsubscribers.push(deps.auth.onChange(() => checkKey()));
      if (deps.power) {
        unsubscribers.push(
          deps.power.onSuspend(() => {
            suspended = true;
            stopTimer();
          }),
        );
        unsubscribers.push(
          deps.power.onResume(() => {
            suspended = false;
            startTimer();
            void supervisor
              .pollNow()
              .catch(() => undefined)
              .then(() => tick());
          }),
        );
      }
      startTimer();
      // Startup catch-up: overdue pauses at once; deletes wait for GMI's clock and fresh state (§9.4, §9.7).
      void tick();
    },
    async stop() {
      stopTimer();
      for (const off of unsubscribers.splice(0)) off();
      await ticking;
      await Promise.allSettled([...inflight.values()]);
      await transitions;
      startedAt = null;
    },
    tick,
    async assessQuote(input) {
      return assessQuote(input, { prices: deps.prices, budget: deps.budget, records: registry.list(), now: now() });
    },
    assessLeaseChange(record, patch) {
      return assessLeaseChange(record, patch, now());
    },
    dailyBudgetSet() {
      return deps.budget.statusSnapshot().budget.dailyUsd !== null;
    },
    spend,
    cost(resourceId): ResourceCost {
      const r = registry.get(resourceId);
      if (!r) return { accruedUsd: 0, accruedTodayUsd: 0, leaseEndsAt: null, idlePauseAt: null };
      const n = now();
      const end = effectiveLeaseEndMs(r);
      const idle = idlePauseAtMs(r);
      return { ...recordAccrual(r, n), leaseEndsAt: end === null ? null : iso(end), idlePauseAt: idle === null ? null : iso(idle) };
    },
    totals() {
      const all = records();
      const n = now();
      let count = 0;
      for (const r of all) if (r.managed && isBilling(r)) count++;
      return {
        todayUsd: spendSince(all, startOfLocalDay(n), n),
        monthUsd: spendSince(all, startOfLocalMonth(n), n),
        running: { count, usdPerHour: burnUsdPerHour(all) },
      };
    },
    alarms,
    activity: {
      record(resourceId, activity: ComputeActivity) {
        if (typeof resourceId !== 'string' || !activity || typeof activity !== 'object') return;
        if (activity.kind === 'agent_tool') {
          if (typeof activity.runId !== 'string' || activity.runId.length === 0) return;
          // Fail closed (§9.5): without H4's run state, an agent tool call never keeps a resource awake.
          if (!deps.isRunActive || !deps.isRunActive(activity.runId)) return;
        } else if (!(USER_ACTIVITY_KINDS as readonly string[]).includes(activity.kind)) {
          return;
        }
        lastActivity.set(resourceId, now().getTime());
      },
    },
    lastActivityAt(resourceId) {
      const t = lastActivity.get(resourceId);
      return t === undefined ? null : iso(t);
    },
    quitCheck,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    handleTransition,
  };
  return guard;
}
