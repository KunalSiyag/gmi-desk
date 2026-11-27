// C1-D cost guard (compute.md §9.3–9.6): lease warnings T−15/5/1, expiry actions, actionPending retries with an
// alarm after 3 failures, destructive catch-up only on GMI's clock, idle pause on user activity only, auto-extend,
// budget actions per kind, setLease assessment, alarms for the key and the API.
import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { AuthState } from '@shared/contracts/auth';
import type { AuthService } from '@main/core/services';
import { assessLeaseChange, confirmLeaseChange, leaseAdjective } from '@main/services/compute/guard';
import { COMPUTE_TIMING, type ComputeActivity } from '@main/services/compute/types';
import { CONTAINER_LEASE, guardHarness, HOUR, MIN, record, SANDBOX_LEASE, type GuardHarness } from './guard-harness';

const NOW = new Date(2026, 10, 15, 12, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let h: GuardHarness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

/** A managed container that has been running since `runningFor` ago with the default 4 h delete lease. */
const container = (id: string, runningFor: number, over = {}) =>
  record({ id, kind: 'container', listUsdPerHour: 3.35, lease: CONTAINER_LEASE, runningSince: ago(runningFor), intervals: [{ from: ago(runningFor), to: null, usdPerHour: 3.35 }], ...over });

const sandbox = (id: string, runningFor: number, over = {}) =>
  record({ id, listUsdPerHour: 0.0911, lease: SANDBOX_LEASE, runningSince: ago(runningFor), intervals: [{ from: ago(runningFor), to: null, usdPerHour: 0.0911 }], ...over });

describe('lease warnings and expiry (§9.4)', () => {
  it('notifies at T−15, T−5 and T−1 once each, then deletes the container at expiry', async () => {
    h = await guardHarness({ now: NOW, records: [container('c1', 4 * HOUR - 16 * MIN)] });
    h.sup.verify();
    h.sup.markFresh('c1');
    const minutesLeft = [16, 14, 13, 10, 5, 4, 2, 1, 0.5];
    let elapsed = 0;
    for (const left of minutesLeft) {
      const target = (16 - left) * MIN;
      h.clock.advance(target - elapsed);
      elapsed = target;
      await h.guard.tick();
    }
    const titles = h.t.platform.notifications.map((n) => n.title);
    expect(titles.filter((x) => x.includes('lease ends in'))).toHaveLength(3);
    expect(titles[0]).toMatch(/lease ends in 14 min/);
    expect(h.guard.alarms.get('lease_expiring', 'c1')?.actions).toEqual(['extend', 'open']);
    expect(h.act.calls).toHaveLength(0);
    h.clock.advance(MIN);
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'delete', id: 'c1', cause: 'lease' }]);
    expect(h.reg.registry.get('c1')?.actionPending).toBeNull();
    const done = h.guard.alarms.get('lease_action', 'c1');
    expect(done).toMatchObject({ severity: 'info', title: 'Deleted c1', body: 'Its 4-hour lease ended.' });
    // The poll has not caught up yet: the next tick does not delete twice.
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(1);
  });

  it('pauses a sandbox at expiry; notify leaves it running with a critical alarm every 30 min', async () => {
    h = await guardHarness({
      now: NOW,
      records: [sandbox('s1', 8 * HOUR + MIN), container('c2', 5 * HOUR, { lease: { ...CONTAINER_LEASE, onExpiry: 'notify' } })],
    });
    h.guard.activity.record('s1', { kind: 'terminal_input' });
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'pause', id: 's1', cause: 'lease' }]);
    const alarm = h.guard.alarms.get('lease_expiring', 'c2');
    expect(alarm).toMatchObject({ severity: 'critical', title: 'c2: lease ended, still billing' });
    const count = () => h!.t.platform.notifications.filter((n) => n.title.includes('still billing')).length;
    expect(count()).toBe(1);
    h.clock.advance(29 * MIN);
    await h.guard.tick();
    expect(count()).toBe(1);
    h.clock.advance(MIN);
    await h.guard.tick();
    expect(count()).toBe(2);
  });

  it('a container lease on "pause" acts as notify (CE has no pause)', async () => {
    h = await guardHarness({ now: NOW, records: [container('c1', 5 * HOUR, { lease: { ...CONTAINER_LEASE, onExpiry: 'pause' } })] });
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    expect(h.guard.alarms.get('lease_expiring', 'c1')?.severity).toBe('critical');
  });

  it('never deletes within 15 min of a lease change without the warnings', async () => {
    // Running 3 h 50 min; the user shortened the lease to 1 h just now: deletion waits 15 min, with the warnings.
    h = await guardHarness({
      now: NOW,
      records: [container('c1', 230 * MIN, { lease: { ...CONTAINER_LEASE, maxLifetimeMin: 60 }, leaseChangedAt: NOW.toISOString() })],
    });
    h.sup.verify();
    h.sup.markFresh('c1');
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    expect(h.guard.cost('c1').leaseEndsAt).toBe(new Date(NOW.getTime() + 15 * MIN).toISOString());
    expect(h.t.platform.notifications.some((n) => /lease ends in 15 min/.test(n.title))).toBe(true);
    h.clock.advance(15 * MIN);
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'delete', id: 'c1', cause: 'lease' }]);
  });
});

describe('actionPending retries (§9.4)', () => {
  it('a failed delete is retried with back-off 1, 2, 5, 10 min and alarms after 3 failures, still retrying', async () => {
    h = await guardHarness({ now: NOW, records: [container('c1', 4 * HOUR + MIN)] });
    h.sup.verify();
    h.sup.markFresh('c1');
    h.act.fail.delete = new GmiError('upstream', 'GMI answered 503.');
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(1);
    let pending = h.reg.registry.get('c1')!.actionPending!;
    expect(pending).toMatchObject({ action: 'delete', attempts: 1, lastError: 'GMI answered 503.' });
    expect(Date.parse(pending.dueAt) - h.sup.supervisor.clock.now().getTime()).toBe(COMPUTE_TIMING.actionRetryMs[0]);

    h.clock.advance(30_000);
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(1); // not due yet
    h.clock.advance(30_000);
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(2);
    expect(h.guard.alarms.get('lease_action_failed', 'c1')).toBeNull();
    h.clock.advance(2 * MIN);
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(3);
    pending = h.reg.registry.get('c1')!.actionPending!;
    expect(pending.attempts).toBe(3);
    const alarm = h.guard.alarms.get('lease_action_failed', 'c1');
    expect(alarm).toMatchObject({ severity: 'critical', title: 'Could not delete c1' });
    expect(h.t.platform.notifications.some((n) => n.title === 'Could not delete c1')).toBe(true);
    // Still billing in the totals, still retried.
    expect(h.guard.totals().running.count).toBe(1);
    h.clock.advance(5 * MIN);
    h.act.fail.delete = null;
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(4);
    expect(h.reg.registry.get('c1')!.actionPending).toBeNull();
    expect(h.guard.alarms.get('lease_action_failed', 'c1')).toBeNull();
  });

  it('a pending action is cleared when its cause is gone (the user extended the lease) or the resource stops billing', async () => {
    h = await guardHarness({ now: NOW, records: [sandbox('s1', 8 * HOUR + MIN)] });
    h.act.fail.pause = new GmiError('conflict', 'busy');
    await h.guard.tick();
    expect(h.reg.registry.get('s1')!.actionPending?.action).toBe('pause');
    await h.reg.registry.update('s1', (r) => ({ ...r, lease: { ...SANDBOX_LEASE, maxLifetimeMin: 600 } }));
    h.guard.activity.record('s1', { kind: 'terminal_input' });
    await h.guard.tick();
    expect(h.reg.registry.get('s1')!.actionPending).toBeNull();
  });

  it('waits while a user action holds the resource lock', async () => {
    h = await guardHarness({ now: NOW, records: [sandbox('s1', 8 * HOUR + MIN)] });
    h.sup.pending.set('s1', 'resume');
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    h.sup.pending.delete('s1');
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(1);
  });
});

describe("destructive catch-up needs GMI's clock (§9.4, §9.7)", () => {
  it('local clock at +30 days: no delete before GMI time is known, none after it shows the lease has not ended', async () => {
    // The container really started 1 h ago; the machine's RTC jumped 30 days ahead.
    h = await guardHarness({ now: NOW, records: [container('c1', HOUR)] });
    h.clock.advance(30 * 24 * HOUR);
    h.sup.markFresh('c1');
    h.guard.start();
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    expect(h.reg.registry.get('c1')!.actionPending?.action).toBe('delete');
    // GMI's Date header arrives: server time is 30 days behind the local clock.
    h.sup.verify(-30 * 24 * HOUR);
    h.sup.markFresh('c1');
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    expect(h.reg.registry.get('c1')!.actionPending).toBeNull();
  });

  it('pauses may proceed on local time; deletes wait for fresh remote state too', async () => {
    h = await guardHarness({ now: NOW, records: [sandbox('s1', 9 * HOUR), container('c1', 5 * HOUR)] });
    h.guard.start();
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'pause', id: 's1', cause: 'catch_up' }]);
    h.sup.verify();
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(1); // no fresh poll of c1 yet
    h.sup.markFresh('c1');
    await h.guard.tick();
    expect(h.act.calls[1]).toEqual({ action: 'delete', id: 'c1', cause: 'catch_up' });
    expect(h.guard.alarms.get('lease_action', 'c1')?.body).toBe('Its 4-hour lease ended while GMI Desk was closed.');
    expect(h.t.platform.notifications.some((n) => n.title === 'Deleted c1')).toBe(true);
  });
});

describe('idle (§9.5)', () => {
  it('pauses after idlePauseMin with streaming output and an HMR preview open; only user input counts', async () => {
    h = await guardHarness({ now: NOW, records: [sandbox('s1', 5 * MIN)] });
    // Terminal output, preview traffic and app execs are not activity: the sink ignores them.
    for (const kind of ['terminal_output', 'preview_traffic', 'app_exec', 'poll']) {
      h.guard.activity.record('s1', { kind } as unknown as ComputeActivity);
    }
    expect(h.guard.lastActivityAt('s1')).toBeNull();
    expect(h.guard.cost('s1').idlePauseAt).toBe(new Date(NOW.getTime() + 15 * MIN).toISOString());
    h.clock.advance(14 * MIN);
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    h.clock.advance(MIN);
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'pause', id: 's1', cause: 'idle' }]);
    expect(h.guard.alarms.get('lease_action', 's1')?.title).toBe('Paused s1 after 20 min idle');
  });

  it('user input resets the idle clock; an agent tool call counts only during an active run', async () => {
    const active = new Set(['run-1']);
    h = await guardHarness({ now: NOW, records: [sandbox('s1', 19 * MIN)], extra: { isRunActive: (id) => active.has(id) } });
    h.guard.activity.record('s1', { kind: 'agent_tool', runId: '' });
    h.guard.activity.record('s1', { kind: 'agent_tool', runId: 'run-old' });
    expect(h.guard.lastActivityAt('s1')).toBeNull();
    h.guard.activity.record('s1', { kind: 'agent_tool', runId: 'run-1' });
    expect(h.guard.lastActivityAt('s1')).toBe(NOW.toISOString());
    h.clock.advance(10 * MIN);
    h.guard.activity.record('s1', { kind: 'terminal_input' });
    h.clock.advance(19 * MIN);
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    h.clock.advance(MIN);
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'pause', id: 's1', cause: 'idle' }]);
  });

  it('review: after an app start the idle period counts from the start (the in-memory clock knows no earlier use)', async () => {
    // Running for 39 min with a 20 min idle pause: before the fix the guard paused it at the first tick after launch.
    h = await guardHarness({ now: NOW, records: [sandbox('s1', 39 * MIN)] });
    h.guard.start();
    expect(h.guard.cost('s1').idlePauseAt).toBe(new Date(NOW.getTime() + 20 * MIN).toISOString());
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    h.clock.advance(20 * MIN);
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'pause', id: 's1', cause: 'idle' }]);
    h.guard.stop();
  });

  it('containers have no idle action', async () => {
    h = await guardHarness({ now: NOW, records: [container('c1', HOUR, { lease: { ...CONTAINER_LEASE, idlePauseMin: 20 } })] });
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    expect(h.guard.cost('c1').idlePauseAt).toBeNull();
  });
});

describe('auto-extend (§7.3)', () => {
  it('adds 30 min when fewer than 10 min remain and the user was active in the last 10 min, within the approved lifetime', async () => {
    h = await guardHarness({
      now: NOW,
      records: [
        sandbox('s1', HOUR, {
          serverEndsAt: new Date(NOW.getTime() + 8 * MIN).toISOString(),
          approvedMaxLifetimeMin: 480,
          lease: { ...SANDBOX_LEASE, idlePauseMin: null },
        }),
      ],
    });
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0); // no activity
    h.guard.activity.record('s1', { kind: 'file_op' });
    h.act.setExtendResult((s) => new Date(NOW.getTime() + s * 1000).toISOString());
    await h.guard.tick();
    expect(h.act.calls).toEqual([{ action: 'extend', id: 's1', cause: 'activity', seconds: 38 * 60 }]);
    expect(h.reg.registry.get('s1')!.serverEndsAt).toBe(new Date(NOW.getTime() + 38 * MIN).toISOString());
  });

  it('never extends past the lease or when the budget cannot pay for it', async () => {
    h = await guardHarness({
      now: NOW,
      budget: { dailyUsd: 0.01 },
      records: [sandbox('s1', 479 * MIN, { serverEndsAt: new Date(NOW.getTime() + 5 * MIN).toISOString(), lease: { ...SANDBOX_LEASE, maxLifetimeMin: 480 } })],
    });
    h.guard.activity.record('s1', { kind: 'terminal_input' });
    await h.guard.tick();
    expect(h.act.calls.filter((c) => c.action === 'extend')).toHaveLength(0);
  });
});

describe('budgets while running (§9.3)', () => {
  it('budget exhausted with enforce: sandboxes pause, containers notify (critical every 15 min), onBudget delete deletes', async () => {
    h = await guardHarness({
      now: NOW,
      budget: { dailyUsd: 5 },
      records: [
        sandbox('s1', 2 * HOUR),
        container('c1', 2 * HOUR, { lease: { ...CONTAINER_LEASE, maxLifetimeMin: null } }),
        container('c2', HOUR, { lease: { ...CONTAINER_LEASE, maxLifetimeMin: null, onBudget: 'delete' } }),
      ],
    });
    h.sup.verify();
    h.sup.markFresh('c2');
    h.guard.start();
    await h.guard.tick();
    expect(h.budget.status().remainingTodayUsd).toBe(0);
    expect(h.act.calls).toEqual(
      expect.arrayContaining([
        { action: 'pause', id: 's1', cause: 'budget' },
        { action: 'delete', id: 'c2', cause: 'budget' },
      ]),
    );
    expect(h.act.calls.some((c) => c.id === 'c1')).toBe(false);
    const alarm = h.guard.alarms.get('budget_exhausted', 'c1');
    expect(alarm).toMatchObject({ severity: 'critical', body: expect.stringContaining('Your budget will not stop this container.') });
    const crit = () => h!.t.platform.notifications.filter((n) => n.title.startsWith('Budget used up: c1')).length;
    expect(crit()).toBe(1);
    h.clock.advance(15 * MIN);
    await h.guard.tick();
    expect(crit()).toBe(2);
  });

  it('enforce off: a warning alarm, no action', async () => {
    h = await guardHarness({ now: NOW, budget: { dailyUsd: 1, enforce: false }, records: [sandbox('s1', 2 * HOUR, { listUsdPerHour: 1, lease: { ...SANDBOX_LEASE, idlePauseMin: null }, intervals: [{ from: ago(2 * HOUR), to: null, usdPerHour: 1 }] })] });
    h.guard.start();
    await h.guard.tick();
    expect(h.act.calls).toHaveLength(0);
    expect(h.guard.alarms.get('budget_exhausted', 's1')?.severity).toBe('warning');
  });

  it('budget_warning when what is left lasts 15 min or less at the current burn', async () => {
    h = await guardHarness({
      now: NOW,
      budget: { dailyUsd: 2.1 },
      records: [sandbox('s1', 2 * HOUR, { listUsdPerHour: 1, lease: null, intervals: [{ from: ago(2 * HOUR), to: null, usdPerHour: 1 }] })],
    });
    h.guard.start();
    await h.guard.tick();
    // $2.00 spent of $2.10: $0.10 lasts 6 min at $1/h.
    expect(h.guard.alarms.get('budget_warning', 's1')).toMatchObject({ severity: 'warning', title: 'Compute budget almost used up' });
    expect(h.act.calls).toHaveLength(0);
    const notes = () => h!.t.platform.notifications.filter((n) => n.title === 'Compute budget almost used up').length;
    expect(notes()).toBe(1);
    h.clock.advance(MIN);
    await h.guard.tick();
    expect(notes()).toBe(1);
    await h.budget.setBudget({ dailyUsd: 50 });
    await h.guard.tick();
    expect(h.guard.alarms.get('budget_warning', 's1')).toBeNull();
  });
});

describe('setLease assessment (§9.3)', () => {
  const c = () => container('c1', 3 * HOUR);
  it('shortening below run time + 15 min, or onExpiry/onBudget → delete, deletes sooner', () => {
    expect(assessLeaseChange(c(), { maxLifetimeMin: 190 }, NOW)).toMatchObject({ deletesSooner: true, loosens: false });
    expect(assessLeaseChange(c(), { maxLifetimeMin: 200 }, NOW).deletesSooner).toBe(false);
    expect(assessLeaseChange(c(), { onBudget: 'delete' }, NOW).deletesSooner).toBe(true);
    const notify = container('c2', HOUR, { lease: { ...CONTAINER_LEASE, onExpiry: 'notify' } });
    expect(assessLeaseChange(notify, { onExpiry: 'delete' }, NOW).deletesSooner).toBe(true);
    expect(assessLeaseChange(c(), { maxLifetimeMin: 190 }, NOW).reasons[0]).toMatch(/will be deleted at about .* \(in 15 min\)/);
  });

  it('longer, no limit, notify instead of delete and idle pause off loosen', () => {
    expect(assessLeaseChange(c(), { maxLifetimeMin: 480 }, NOW)).toMatchObject({ loosens: true, deletesSooner: false });
    expect(assessLeaseChange(c(), { maxLifetimeMin: null }, NOW).loosens).toBe(true);
    expect(assessLeaseChange(c(), { onExpiry: 'notify' }, NOW).loosens).toBe(true);
    const s = sandbox('s1', HOUR);
    expect(assessLeaseChange(s, { idlePauseMin: null }, NOW).reasons).toEqual(['Idle pause turns off.']);
    expect(assessLeaseChange(s, { onBudget: 'notify' }, NOW).reasons).toEqual(['Your budget will not stop this sandbox.']);
    expect(assessLeaseChange(s, { idlePauseMin: 10, maxLifetimeMin: 240 }, NOW)).toMatchObject({ loosens: false, deletesSooner: false });
  });

  it('a change that deletes sooner or loosens needs a native confirm; tightening applies directly', async () => {
    h = await guardHarness({ now: NOW });
    const rec = c();
    expect(await confirmLeaseChange(h.t.ctx, rec, assessLeaseChange(rec, { maxLifetimeMin: 200 }, NOW))).toBe(true);
    expect(h.t.platform.confirms).toHaveLength(0);
    h.t.platform.confirmAnswer = false;
    expect(await confirmLeaseChange(h.t.ctx, rec, assessLeaseChange(rec, { maxLifetimeMin: 60 }, NOW))).toBe(false);
    expect(h.t.platform.confirms.at(-1)).toEqual({ title: 'Delete sooner', message: 'Change the lease of c1? It will be deleted sooner.' });
    h.t.platform.confirmAnswer = true;
    expect(await confirmLeaseChange(h.t.ctx, rec, assessLeaseChange(rec, { maxLifetimeMin: null }, NOW))).toBe(true);
    expect(h.t.platform.confirms.at(-1)?.title).toBe('Loosen lease');
  });

  it('is exposed on the guard with GMI time', async () => {
    h = await guardHarness({ now: NOW });
    expect(h.guard.assessLeaseChange(c(), { maxLifetimeMin: 60 }).deletesSooner).toBe(true);
    expect(leaseAdjective(240)).toBe('4-hour');
    expect(leaseAdjective(90)).toBe('90-minute');
  });
});

describe('other alarms', () => {
  it('key_invalid follows the Compute key status; api_unavailable follows supervisor health; price_unknown per resource', async () => {
    let state = { computeKey: { status: 'valid' } } as unknown as AuthState;
    const listeners = new Set<(s: AuthState) => void>();
    const auth: AuthService = {
      getState: () => state,
      isSignedIn: () => true,
      onChange: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    h = await guardHarness({ now: NOW, extra: { auth }, records: [sandbox('s1', HOUR, { listUsdPerHour: null, intervals: [{ from: ago(HOUR), to: null, usdPerHour: null }] })] });
    h.guard.start();
    await h.guard.tick();
    expect(h.guard.alarms.get('key_invalid', null)).toBeNull();
    state = { computeKey: { status: 'invalid' } } as unknown as AuthState;
    for (const l of listeners) l(state);
    expect(h.guard.alarms.get('key_invalid', null)).toMatchObject({ actions: ['connect_key'] });
    h.sup.health.ce = 'down';
    await h.guard.tick();
    expect(h.guard.alarms.get('api_unavailable', null)).not.toBeNull();
    h.sup.health.ce = 'ok';
    await h.guard.tick();
    expect(h.guard.alarms.get('api_unavailable', null)).toBeNull();
    expect(h.guard.alarms.get('price_unknown', 's1')?.severity).toBe('warning');
  });
});

describe('totals, cost and performance', () => {
  it('totals and per-resource cost', async () => {
    h = await guardHarness({ now: NOW, records: [container('c1', 2 * HOUR), sandbox('s1', HOUR)] });
    const totals = h.guard.totals();
    expect(totals.running).toEqual({ count: 2, usdPerHour: 3.35 + 0.0911 });
    expect(totals.todayUsd).toBeCloseTo(6.7 + 0.0911, 6);
    expect(h.guard.cost('c1')).toMatchObject({ leaseEndsAt: new Date(NOW.getTime() + 2 * HOUR).toISOString(), idlePauseAt: null });
    expect(h.guard.cost('missing')).toEqual({ accruedUsd: 0, accruedTodayUsd: 0, leaseEndsAt: null, idlePauseAt: null });
  });

  it('a guard tick over 100 resources stays fast', async () => {
    const records = Array.from({ length: 100 }, (_, i) => (i % 2 ? sandbox(`s${i}`, HOUR) : container(`c${i}`, HOUR)));
    h = await guardHarness({ now: NOW, records });
    for (const r of records) h.guard.activity.record(r.id, { kind: 'terminal_input' });
    await h.guard.tick();
    const t0 = performance.now();
    await h.guard.tick();
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('power resume runs an immediate poll and tick; suspend stops the timer', async () => {
    const suspend = new Set<() => void>();
    const resume = new Set<() => void>();
    const power = {
      onSuspend: (l: () => void) => (suspend.add(l), () => suspend.delete(l)),
      onResume: (l: () => void) => (resume.add(l), () => resume.delete(l)),
    };
    h = await guardHarness({ now: NOW, extra: { power }, records: [sandbox('s1', 9 * HOUR)] });
    h.guard.start();
    await h.guard.tick();
    for (const l of suspend) l();
    const before = h.sup.polls;
    for (const l of resume) l();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sup.polls).toBe(before + 1);
    await h.guard.stop();
    expect(suspend.size + resume.size).toBe(0);
  });
});
