// H1-B: per-model circuit breaker (harness.md §4.6).
import { describe, expect, it } from 'vitest';
import { createBreaker } from '@main/services/gateway/breaker';
import { GATEWAY_LIMITS } from '@main/services/gateway/types';
import { describeBreakerContract } from './contracts';
import { fakeClock } from './fakes';

describeBreakerContract('breaker.ts', (clock) => createBreaker({ clock }));

const b = GATEWAY_LIMITS.breaker;

function openIt(breaker: ReturnType<typeof createBreaker>, key = 'm') {
  for (let i = 0; i < b.failures; i++) {
    breaker.tryAcquire(key);
    breaker.record(key, 'failure');
  }
}

describe('breaker', () => {
  it('each failed probe doubles the open time, up to 5 minutes; a success resets it', () => {
    const clock = fakeClock();
    const breaker = createBreaker({ clock });
    openIt(breaker);
    const opens: number[] = [];
    let openMs: number = b.openMs;
    for (let i = 0; i < 6; i++) {
      clock.advance(openMs - 1);
      expect(breaker.state('m')).toBe('open');
      clock.advance(1);
      expect(breaker.tryAcquire('m')).toBe(true);
      breaker.record('m', 'failure');
      openMs = Math.min(b.maxOpenMs, openMs * 2);
      opens.push(Date.parse(breaker.snapshot()[0]!.reopenAt!) - clock.now());
    }
    expect(opens).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    clock.advance(b.maxOpenMs);
    breaker.tryAcquire('m');
    breaker.record('m', 'success');
    openIt(breaker);
    expect(Date.parse(breaker.snapshot()[0]!.reopenAt!) - clock.now()).toBe(b.openMs);
  });

  it('notifies when an open breaker turns half-open (so queued requests wake), via its own timer', () => {
    const clock = fakeClock();
    const breaker = createBreaker({ clock });
    const states: string[] = [];
    breaker.onChange(() => states.push(breaker.state('m')));
    openIt(breaker);
    clock.advance(b.openMs);
    expect(states).toEqual(['open', 'half_open']);
    expect(breaker.snapshot()).toEqual([{ modelKey: 'm', breaker: 'half_open', reopenAt: null }]);
  });

  it('late failures of requests admitted before it opened do not extend it; successes while open do not close it', () => {
    const clock = fakeClock();
    const breaker = createBreaker({ clock });
    openIt(breaker);
    const reopenAt = breaker.snapshot()[0]!.reopenAt;
    breaker.record('m', 'failure');
    breaker.record('m', 'success');
    expect(breaker.state('m')).toBe('open');
    expect(breaker.snapshot()[0]!.reopenAt).toBe(reopenAt);
  });

  it('only "failure" counts: a stream of neutral outcomes (4xx, network, cancel) never opens it', () => {
    const breaker = createBreaker({ clock: fakeClock() });
    for (let i = 0; i < 100; i++) {
      breaker.tryAcquire('m');
      breaker.record('m', 'neutral');
    }
    expect(breaker.state('m')).toBe('closed');
    expect(breaker.snapshot()).toEqual([]);
  });

  it('dispose clears its timers and listeners', () => {
    const clock = fakeClock();
    const breaker = createBreaker({ clock });
    let calls = 0;
    breaker.onChange(() => (calls += 1));
    openIt(breaker);
    breaker.dispose();
    expect(clock.pendingTimers()).toBe(0);
    clock.advance(b.openMs);
    expect(calls).toBe(1);
  });
});
