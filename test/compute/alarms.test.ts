// C1-D alarms (compute.md §9.6): deduplicated by (kind, resourceId), throttled notifications, critical alarms that
// repeat until dismissed or resolved, the compute:alarm event, and a notification click that opens the resource.
import { afterEach, describe, expect, it } from 'vitest';
import { ALARM_REPEAT_MS, createAlarmCenter, NOTIFY_MAX_PER_MINUTE } from '@main/services/compute/alarms';
import type { AlarmInput } from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { MIN, testClock } from './guard-harness';

let t: TestContext | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const input = (over: Partial<AlarmInput> = {}): AlarmInput => ({
  kind: 'budget_warning',
  severity: 'warning',
  resourceId: 'cr_1',
  title: 'Compute budget almost used up',
  body: '$0.20 left',
  usdPerHour: 1,
  actions: ['open'],
  ...over,
});

async function setup() {
  const clock = testClock(new Date(2026, 10, 15, 12, 0));
  t = await createTestContext({ now: clock.now });
  const notified: Array<{ title: string; onClick?: () => void }> = [];
  t.ctx.platform.notify = (n) => {
    notified.push(n);
  };
  const center = createAlarmCenter({ ctx: t.ctx });
  return { center, clock, notified, t };
}

describe('deduplication', () => {
  it('one alarm per (kind, resourceId); a refresh updates it in place without a new notification', async () => {
    const { center, notified, t } = await setup();
    const a = center.raise(input());
    const b = center.raise(input({ body: '$0.10 left' }));
    expect(b.id).toBe(a.id);
    expect(center.list()).toHaveLength(1);
    expect(center.list()[0]?.body).toBe('$0.10 left');
    expect(notified).toHaveLength(1);
    center.raise(input({ resourceId: 'cr_2' }));
    center.raise(input({ kind: 'budget_exhausted', severity: 'critical' }));
    expect(center.list()).toHaveLength(3);
    // compute:alarm is emitted for new alarms only.
    expect(t.emitted.filter((e) => e.name === 'compute:alarm')).toHaveLength(3);
  });

  it('lists critical first, then newest', async () => {
    const { center, clock } = await setup();
    center.raise(input({ resourceId: 'a' }));
    clock.advance(MIN);
    center.raise(input({ resourceId: 'b' }));
    center.raise(input({ kind: 'lease_action_failed', severity: 'critical', resourceId: 'a' }));
    expect(center.list().map((x) => `${x.kind}:${x.resourceId}`)).toEqual(['lease_action_failed:a', 'budget_warning:b', 'budget_warning:a']);
  });
});

describe('notification throttle', () => {
  it('a budget warning notifies at most once per resource per hour', async () => {
    const { center, clock, notified } = await setup();
    center.raise(input());
    for (let i = 0; i < 59; i++) {
      clock.advance(MIN);
      center.raise(input());
    }
    expect(notified).toHaveLength(1);
    clock.advance(MIN);
    center.raise(input());
    expect(notified).toHaveLength(2);
    expect(ALARM_REPEAT_MS.budget_warning).toBe(60 * MIN);
  });

  it('critical alarms repeat at their fixed interval until dismissed', async () => {
    const { center, clock, notified } = await setup();
    const crit = input({ kind: 'budget_exhausted', severity: 'critical' });
    const a = center.raise(crit);
    clock.advance(14 * MIN);
    center.raise(crit);
    expect(notified).toHaveLength(1);
    clock.advance(MIN);
    center.raise(crit);
    expect(notified).toHaveLength(2);
    center.dismiss(a.id);
    expect(center.list()).toHaveLength(0);
    clock.advance(30 * MIN);
    center.raise(crit);
    expect(notified).toHaveLength(2);
    expect(center.list()).toHaveLength(0);
  });

  it('resolving ends an alarm; the same cause later is a new alarm', async () => {
    const { center, notified } = await setup();
    const a = center.raise(input({ kind: 'orphan', severity: 'warning' }));
    center.dismiss(a.id);
    center.resolve('orphan', 'cr_1');
    const b = center.raise(input({ kind: 'orphan', severity: 'warning' }));
    expect(b.id).not.toBe(a.id);
    expect(center.list()).toHaveLength(1);
    expect(notified).toHaveLength(2);
  });

  it('an escalation notifies at once; "never" and "force" override the policy', async () => {
    const { center, notified } = await setup();
    center.raise(input({ kind: 'lease_expiring' }), { notify: 'never' });
    expect(notified).toHaveLength(0);
    center.raise(input({ kind: 'lease_expiring', severity: 'critical' }));
    expect(notified).toHaveLength(1);
    center.raise(input({ kind: 'lease_expiring', severity: 'critical' }), { notify: 'force' });
    expect(notified).toHaveLength(2);
  });

  it(`sends at most ${NOTIFY_MAX_PER_MINUTE} notifications a minute; held-back alarms notify on a later raise`, async () => {
    const { center, clock, notified } = await setup();
    for (let i = 0; i < 8; i++) center.raise(input({ kind: 'orphan', resourceId: `r${i}` }));
    expect(notified).toHaveLength(NOTIFY_MAX_PER_MINUTE);
    expect(center.list()).toHaveLength(8);
    clock.advance(MIN);
    for (let i = 0; i < 8; i++) center.raise(input({ kind: 'orphan', resourceId: `r${i}` }));
    expect(notified).toHaveLength(8);
  });

  it('resolveResource clears every alarm of a resource; onChange fires on real changes only', async () => {
    const { center } = await setup();
    let changes = 0;
    center.onChange(() => changes++);
    center.raise(input());
    center.raise(input());
    center.raise(input({ kind: 'price_unknown' }));
    expect(changes).toBe(2);
    center.resolveResource('cr_1');
    expect(center.list()).toHaveLength(0);
    expect(changes).toBe(3);
    center.resolve('orphan', null);
    expect(changes).toBe(3);
  });
});

describe('notification click', () => {
  it('focuses the app and opens the resource on the Compute page', async () => {
    const { center, notified, t } = await setup();
    let focused = 0;
    t.ctx.platform.focusApp = () => focused++;
    center.raise(input());
    notified[0]?.onClick?.();
    expect(focused).toBe(1);
    expect(t.emitted.find((e) => e.name === 'app:navigate')?.payload).toEqual({ page: 'compute', params: { resource: 'cr_1' } });
  });
});
