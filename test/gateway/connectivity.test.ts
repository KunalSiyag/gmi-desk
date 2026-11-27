// H1-B: the global connectivity gate (harness.md §4.6) and how it pauses the scheduler without opening breakers.
import { describe, expect, it } from 'vitest';
import { createBreaker } from '@main/services/gateway/breaker';
import { createConnectivityGate } from '@main/services/gateway/connectivity';
import { createRetryPolicy } from '@main/services/gateway/retry';
import { createScheduler } from '@main/services/gateway/scheduler';
import type { ConnectivitySignals, QueuedInfo, ReserveAttempt } from '@main/services/gateway/types';
import { fakeClock } from './fakes';

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function signals(initial = true) {
  let online = initial;
  const resume = new Set<() => void>();
  const s: ConnectivitySignals & { set(v: boolean): void; wake(): void } = {
    isOnline: () => online,
    onResume(listener) {
      resume.add(listener);
      return () => resume.delete(listener);
    },
    set: (v) => (online = v),
    wake: () => resume.forEach((l) => l()),
  };
  return s;
}

function gate(opts: { online?: boolean; probe?: () => Promise<boolean> } = {}) {
  const clock = fakeClock();
  const sig = signals(opts.online ?? true);
  let probes = 0;
  let answer = true;
  const g = createConnectivityGate({
    signals: sig,
    clock,
    probe:
      opts.probe ??
      (async () => {
        probes += 1;
        return answer;
      }),
  });
  return { clock, sig, g, probes: () => probes, setAnswer: (v: boolean) => (answer = v) };
}

describe('connectivity gate', () => {
  it('closes on DNS / refused / reset with no response; other errors leave it open', () => {
    for (const errno of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET']) {
      const { g } = gate();
      g.reportNetworkFailure(errno);
      expect(g.online()).toBe(false);
      g.dispose();
    }
    const { g } = gate();
    g.reportNetworkFailure('ETIMEDOUT');
    g.reportNetworkFailure(null);
    expect(g.online()).toBe(true);
  });

  it('the OS saying offline closes it, even with no failure', () => {
    const { g, sig } = gate();
    const changes: boolean[] = [];
    g.onChange((v) => changes.push(v));
    sig.set(false);
    expect(g.online()).toBe(false);
    expect(changes).toEqual([false]);
    g.dispose();
  });

  it('reopens after a probe succeeds; probes back off while they fail and never run while the OS is offline', async () => {
    const t = gate();
    t.setAnswer(false);
    t.g.reportNetworkFailure('ENOTFOUND');
    t.clock.advance(1_000);
    await flush();
    expect(t.probes()).toBe(1);
    t.clock.advance(1_999);
    await flush();
    expect(t.probes()).toBe(1);
    t.clock.advance(1);
    await flush();
    expect(t.probes()).toBe(2);
    t.sig.set(false);
    t.clock.advance(60_000);
    await flush();
    expect(t.probes()).toBe(2);
    t.sig.set(true);
    t.setAnswer(true);
    t.clock.advance(30_000);
    await flush();
    expect(t.g.online()).toBe(true);
    expect(t.clock.pendingTimers()).toBe(0);
  });

  it('wake from sleep probes at once', async () => {
    const t = gate();
    t.setAnswer(false);
    t.g.reportNetworkFailure('ECONNREFUSED');
    t.setAnswer(true);
    t.sig.wake();
    await flush();
    expect(t.probes()).toBe(1);
    expect(t.g.online()).toBe(true);
  });

  it('any HTTP response reopens it; a probe that throws counts as failed', async () => {
    const t = gate({ probe: async () => Promise.reject(new Error('boom')) });
    t.g.reportNetworkFailure('ENOTFOUND');
    t.clock.advance(1_000);
    await flush();
    expect(t.g.online()).toBe(false);
    t.g.reportResponse();
    expect(t.g.online()).toBe(true);
  });

  it('starts closed when the OS is offline at launch', async () => {
    const t = gate({ online: false });
    expect(t.g.online()).toBe(false);
    t.sig.set(true);
    t.clock.advance(1_000);
    await flush();
    expect(t.g.online()).toBe(true);
  });

  it('dispose stops probing and unsubscribes from resume', async () => {
    const t = gate();
    t.g.reportNetworkFailure('ENOTFOUND');
    t.g.dispose();
    t.sig.wake();
    t.clock.advance(60_000);
    await flush();
    expect(t.probes()).toBe(0);
  });
});

describe('offline: requests wait, no breaker opens, they resume after the probe', () => {
  it('connect failures go to the gate (no retry budget, no breaker count); queued(offline) until it reopens', async () => {
    const clock = fakeClock();
    const sig = signals();
    let probeAnswer = false;
    const connectivity = createConnectivityGate({ signals: sig, clock, probe: async () => probeAnswer });
    const breaker = createBreaker({ clock });
    const scheduler = createScheduler({ clock, breaker, connectivity });
    const retry = createRetryPolicy({ clock });
    const reserved = (): ReserveAttempt => ({ status: 'reserved', reservation: { requestId: 'x', usd: 0, release: () => undefined } });

    // Ten requests fail to connect: each decision is `offline` and none counts for the breaker.
    for (let i = 0; i < 10; i++) {
      const d = retry.decide(
        { kind: 'network', errno: 'ENOTFOUND', bodySent: false, message: 'getaddrinfo ENOTFOUND' },
        { purpose: 'agent', priority: 'foreground', promptTokens: 1_000, attempt: 1, maybeBilledRetries: 0, notBilledRequeues: 0, rateLimitedSince: null, afterOutput: false, now: clock.now() },
      );
      expect(d).toEqual({ action: 'offline', countsForBreaker: false });
      connectivity.reportNetworkFailure('ENOTFOUND');
    }
    expect(breaker.state('m')).toBe('closed');
    expect(connectivity.online()).toBe(false);

    const queued: QueuedInfo[] = [];
    const h = scheduler.enqueue({ requestId: 'q1', purpose: 'agent', priority: 'foreground', threadId: 't1', modelKey: 'm', tpmTokens: 1_000, reserve: reserved });
    h.onQueued((q) => queued.push(q));
    await flush();
    expect(queued.at(-1)?.reason).toBe('offline');

    probeAnswer = true;
    clock.advance(1_000);
    await flush();
    expect(connectivity.online()).toBe(true);
    expect((await h.result).status).toBe('admitted');
    expect(breaker.state('m')).toBe('closed');
    scheduler.dispose();
    connectivity.dispose();
  });
});
