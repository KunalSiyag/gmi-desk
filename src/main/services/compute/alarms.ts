// The compute alarm store and its notification throttle (compute.md §9.6). Alarms are deduplicated by
// (kind, resourceId); notifications are throttled per alarm and globally; critical alarms repeat at a fixed interval
// until dismissed or resolved. Memory only: the guard and the sweep raise them again after a restart.
import { randomUUID } from 'node:crypto';
import type { ComputeAlarm, ComputeAlarmKind } from '@shared/contracts/compute';
import type { AppContext } from '../../core/context';
import type { AlarmCenter, AlarmInput } from './types';

const MINUTE_MS = 60_000;

/**
 * How often an alarm that is still active notifies again (null: only when new or escalated). Critical alarms repeat
 * (§9.3: a container left running past its budget every 15 min; a lease that ended on `notify` every 30 min).
 */
export const ALARM_REPEAT_MS: Record<ComputeAlarmKind, number | null> = {
  orphan: null,
  eip_unattached: null,
  lease_expiring: 30 * MINUTE_MS,
  lease_action: null,
  budget_warning: 60 * MINUTE_MS,
  budget_exhausted: 15 * MINUTE_MS,
  paused_long: 24 * 60 * MINUTE_MS,
  price_unknown: null,
  api_unavailable: null,
  key_invalid: null,
  create_unknown: 30 * MINUTE_MS,
  lease_action_failed: 30 * MINUTE_MS,
};

/** Global cap: at most this many desktop notifications per minute (the rest wait for a later raise). */
export const NOTIFY_MAX_PER_MINUTE = 5;

const SEVERITY_RANK: Record<ComputeAlarm['severity'], number> = { info: 0, warning: 1, critical: 2 };

export interface RaiseOptions {
  /** `force`: notify now even if this alarm notified recently (lease warnings at T−15/5/1); `never`: list only. */
  notify?: 'auto' | 'force' | 'never';
  /** Overrides ALARM_REPEAT_MS for this alarm. */
  repeatMs?: number | null;
}

export interface ComputeAlarmCenter extends AlarmCenter {
  raise(input: AlarmInput, opts?: RaiseOptions): ComputeAlarm;
  /** The alarm of (kind, resourceId), also when dismissed; null when none. */
  get(kind: ComputeAlarmKind, resourceId: string | null): ComputeAlarm | null;
  /** Resolves every alarm of `resourceId` (it was deleted or adopted away). */
  resolveResource(resourceId: string): void;
}

interface Entry {
  alarm: ComputeAlarm;
  lastNotifiedAt: number | null;
  repeatMs: number | null;
  dismissed: boolean;
}

const keyOf = (kind: ComputeAlarmKind, resourceId: string | null) => `${kind}\u0000${resourceId ?? ''}`;

const sameContent = (a: ComputeAlarm, b: AlarmInput) =>
  a.severity === b.severity &&
  a.title === b.title &&
  a.body === b.body &&
  a.usdPerHour === b.usdPerHour &&
  a.actions.length === b.actions.length &&
  a.actions.every((x, i) => x === b.actions[i]);

export function createAlarmCenter(opts: {
  ctx: Pick<AppContext, 'platform' | 'events' | 'log' | 'now'>;
  /** Where a notification click leads; default: focus the app and open the resource (or the Compute page). */
  onNotificationClick?: (alarm: ComputeAlarm) => void;
}): ComputeAlarmCenter {
  const { ctx } = opts;
  const log = ctx.log.child('compute.guard');
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const sentAt: number[] = [];

  const changed = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.warn('alarm listener failed', error);
      }
    }
  };

  const click = (alarm: ComputeAlarm) => {
    if (opts.onNotificationClick) return opts.onNotificationClick(alarm);
    ctx.platform.focusApp();
    ctx.events.emit('app:navigate', { page: 'compute', params: alarm.resourceId ? { resource: alarm.resourceId } : {} });
  };

  /** Sends the desktop notification unless the global cap is reached. True when sent. */
  const notify = (alarm: ComputeAlarm, now: number): boolean => {
    while (sentAt.length > 0 && now - (sentAt[0] ?? 0) >= MINUTE_MS) sentAt.shift();
    if (sentAt.length >= NOTIFY_MAX_PER_MINUTE) return false;
    sentAt.push(now);
    try {
      ctx.platform.notify({ title: alarm.title, body: alarm.body, onClick: () => click(alarm) });
    } catch (error) {
      log.warn('notification failed', error);
    }
    return true;
  };

  const center: ComputeAlarmCenter = {
    raise(input, raiseOpts = {}) {
      const now = ctx.now().getTime();
      const key = keyOf(input.kind, input.resourceId);
      const mode = raiseOpts.notify ?? 'auto';
      const repeatMs = raiseOpts.repeatMs !== undefined ? raiseOpts.repeatMs : ALARM_REPEAT_MS[input.kind];
      let entry = entries.get(key);
      let isNew = false;
      let escalated = false;
      let contentChanged = false;
      if (!entry) {
        isNew = true;
        entry = {
          alarm: { ...input, actions: [...input.actions], id: `al_${randomUUID()}`, createdAt: new Date(now).toISOString() },
          lastNotifiedAt: null,
          repeatMs,
          dismissed: false,
        };
        entries.set(key, entry);
        log.info('alarm.raised', { kind: input.kind, rid: input.resourceId });
      } else {
        escalated = SEVERITY_RANK[input.severity] > SEVERITY_RANK[entry.alarm.severity];
        contentChanged = !sameContent(entry.alarm, input);
        if (contentChanged) entry.alarm = { ...entry.alarm, ...input, actions: [...input.actions] };
        entry.repeatMs = repeatMs;
      }
      // A dismissal covers what the user saw. An escalation (warning → critical: "lease ended, still billing") or a
      // forced step with new content (lease warnings at T−5 / T−1) brings the alarm back.
      if (entry.dismissed && (escalated || (mode === 'force' && contentChanged))) {
        entry.dismissed = false;
        isNew = true;
      }
      if (entry.dismissed) return { ...entry.alarm };

      // `auto`: when new, escalated, never sent yet (the global cap held it back) or the repeat interval passed.
      const due =
        mode === 'force' ||
        (mode === 'auto' &&
          (isNew || escalated || entry.lastNotifiedAt === null || (entry.repeatMs !== null && now - entry.lastNotifiedAt >= entry.repeatMs)));
      if (due && notify(entry.alarm, now)) entry.lastNotifiedAt = now;

      if (isNew) ctx.events.emit('compute:alarm', { ...entry.alarm });
      if (isNew || contentChanged) changed();
      return { ...entry.alarm };
    },
    resolve(kind, resourceId) {
      if (entries.delete(keyOf(kind, resourceId))) changed();
    },
    resolveResource(resourceId) {
      let any = false;
      for (const [key, entry] of entries) {
        if (entry.alarm.resourceId === resourceId) {
          entries.delete(key);
          any = true;
        }
      }
      if (any) changed();
    },
    dismiss(alarmId) {
      for (const entry of entries.values()) {
        if (entry.alarm.id === alarmId && !entry.dismissed) {
          entry.dismissed = true;
          changed();
          return;
        }
      }
    },
    get(kind, resourceId) {
      const entry = entries.get(keyOf(kind, resourceId));
      return entry ? { ...entry.alarm } : null;
    },
    list() {
      return [...entries.values()]
        .filter((e) => !e.dismissed)
        .map((e) => ({ ...e.alarm, actions: [...e.alarm.actions] }))
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAt.localeCompare(a.createdAt));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return center;
}
