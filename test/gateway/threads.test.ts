// H1-B: the persisted thread ledger (harness.md §4.3–4.4): spend and caps survive a restart, host caps only
// tighten, one agent ledger row per turn (or per $0.10 / 60 s), and the budget never counts the spend twice.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import type { BudgetGuard } from '@main/core/services';
import { createBudgetService } from '@main/services/usage/budget';
import { openSpendLedger } from '@main/services/usage/ledger';
import { createThreadLedger, THREAD_LEDGER_FILE } from '@main/services/gateway/threads';
import { GATEWAY_LIMITS, type ThreadSpendCharge } from '@main/services/gateway/types';
import { createTestContext, type TestContext } from '../helpers/context';
import { describeThreadLedgerContract } from './contracts';
import { fakeClock, type FakeClock } from './fakes';

const dirs: string[] = [];
const contexts: TestContext[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.cleanup();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gmi-desk-threads-'));
  dirs.push(dir);
  return dir;
}

type Row = Parameters<BudgetGuard['record']>[0];
const recorder = () => {
  const rows: Row[] = [];
  return { rows, budget: { record: async (r: Row) => void rows.push(r) } };
};

describeThreadLedgerContract('threads.ts', async () => {
  const dir = await tempDir();
  const clock = fakeClock();
  const { rows, budget } = recorder();
  return {
    ledger: createThreadLedger({ dataDir: dir, budget, clock }),
    rows: () => rows.map((r) => ({ kind: r.kind, modelId: r.modelId, usd: r.usd, ref: r.ref ?? null })),
    reopen: async () => createThreadLedger({ dataDir: dir, budget, clock }),
  };
});

const at = Date.parse('2026-11-02T10:00:00Z');
const charge = (over: Partial<ThreadSpendCharge> = {}): ThreadSpendCharge => ({ threadId: 't1', turnId: 'u1', modelId: 'm', usd: 0.01, at, ...over });

async function persisted(dir: string): Promise<{ version: number; threads: Record<string, { spentUsd: number; unflushed: Record<string, unknown>; caps: unknown }> }> {
  return JSON.parse(await readFile(join(dir, THREAD_LEDGER_FILE), 'utf8'));
}

describe('flush schedule (§4.3)', () => {
  it('a turn reaching $0.10 of unflushed spend becomes ledger rows at once (one per model)', async () => {
    const dir = await tempDir();
    const { rows, budget } = recorder();
    const ledger = createThreadLedger({ dataDir: dir, budget, clock: fakeClock() });
    await ledger.load();
    ledger.add(charge({ usd: 0.06 }));
    ledger.add(charge({ usd: 0.02, modelId: 'flash' }));
    expect(rows).toEqual([]);
    ledger.add(charge({ usd: 0.03 }));
    expect(rows.map((r) => [r.modelId, r.ref])).toEqual([
      ['m', 'thr:t1/turn:u1'],
      ['flash', 'thr:t1/turn:u1'],
    ]);
    expect(rows[0]!.usd).toBeCloseTo(0.09, 9);
    expect(ledger.source.totalSince(new Date(0))).toBe(0);
    await ledger.dispose();
  });

  it('unflushed spend becomes a row 60 s after its first charge', async () => {
    const dir = await tempDir();
    const clock = fakeClock();
    const { rows, budget } = recorder();
    const ledger = createThreadLedger({ dataDir: dir, budget, clock });
    await ledger.load();
    ledger.add(charge({ at: clock.now() }));
    clock.advance(30_000);
    ledger.add(charge({ turnId: 'u2', at: clock.now() }));
    clock.advance(GATEWAY_LIMITS.agentFlushMs - 30_000 - 1);
    expect(rows).toEqual([]);
    clock.advance(1);
    expect(rows.map((r) => r.ref)).toEqual(['thr:t1/turn:u1']);
    clock.advance(30_000);
    expect(rows.map((r) => r.ref)).toEqual(['thr:t1/turn:u1', 'thr:t1/turn:u2']);
    expect(clock.pendingTimers()).toBe(0);
    await ledger.dispose();
  });

  it('spend without a turn id is kept under "-"', async () => {
    const { rows, budget } = recorder();
    const ledger = createThreadLedger({ dataDir: await tempDir(), budget, clock: fakeClock() });
    await ledger.load();
    ledger.add(charge({ turnId: null }));
    ledger.settleTurn('t1', '-');
    expect(rows.map((r) => r.ref)).toEqual(['thr:t1/turn:-']);
    await ledger.dispose();
  });

  it('ignores invalid charges', async () => {
    const ledger = createThreadLedger({ dataDir: await tempDir(), budget: recorder().budget, clock: fakeClock() });
    await ledger.load();
    ledger.add(charge({ usd: -1 }));
    ledger.add(charge({ usd: Number.NaN }));
    ledger.add(charge({ threadId: '' }));
    expect(ledger.spend('t1').threadUsd).toBe(0);
    await ledger.dispose();
  });
});

describe('caps', () => {
  it('invalid caps are refused; the stored caps are unchanged', async () => {
    const ledger = createThreadLedger({ dataDir: await tempDir(), budget: recorder().budget, clock: fakeClock() });
    await ledger.load();
    expect(() => ledger.setCaps('t1', { perTurnUsd: -1, perThreadUsd: null })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => ledger.approveCaps('t1', { perTurnUsd: Number.POSITIVE_INFINITY, perThreadUsd: null })).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(ledger.caps('t1')).toEqual({ perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: CODE_DEFAULTS.perThreadUsd, approvedAt: null });
    await ledger.dispose();
  });
});

describe('persistence (durableWriteFile, data/gateway-threads.json)', () => {
  it('writes after every change, including the unflushed part', async () => {
    const dir = await tempDir();
    const ledger = createThreadLedger({ dataDir: dir, budget: recorder().budget, clock: fakeClock() });
    await ledger.load();
    ledger.add(charge({ usd: 0.03 }));
    ledger.setCaps('t1', { perTurnUsd: 0.5, perThreadUsd: null });
    await vi.waitFor(async () => {
      const file = await persisted(dir);
      expect(file.version).toBe(1);
      expect(file.threads.t1).toMatchObject({ spentUsd: 0.03, caps: { perTurnUsd: 0.5, perThreadUsd: CODE_DEFAULTS.perThreadUsd }, unflushed: { u1: { byModel: { m: 0.03 } } } });
    });
    await ledger.dispose();
  });

  it('never writes before load(): spend added early is merged with the stored spend', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, THREAD_LEDGER_FILE), JSON.stringify({ version: 1, threads: { t1: { spentUsd: 2, turns: { u0: 2 }, caps: { perTurnUsd: 0.5, perThreadUsd: 4 } } } }));
    const ledger = createThreadLedger({ dataDir: dir, budget: recorder().budget, clock: fakeClock() });
    ledger.add(charge({ usd: 0.05 }));
    ledger.setCaps('t1', { perTurnUsd: 0.75, perThreadUsd: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await persisted(dir)).threads.t1!.spentUsd).toBe(2);
    await ledger.load();
    expect(ledger.spend('t1', 'u0')).toEqual({ turnUsd: 2, threadUsd: expect.closeTo(2.05, 9) });
    expect(ledger.caps('t1')).toMatchObject({ perTurnUsd: 0.5, perThreadUsd: 3 });
    await ledger.dispose();
    expect((await persisted(dir)).threads.t1!.spentUsd).toBeCloseTo(2.05, 9);
  });

  it('an unreadable file starts empty instead of failing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, THREAD_LEDGER_FILE), '{not json');
    const ledger = createThreadLedger({ dataDir: dir, budget: recorder().budget, clock: fakeClock() });
    await ledger.load();
    expect(ledger.spend('t1')).toEqual({ turnUsd: 0, threadUsd: 0 });
    await ledger.dispose();
  });

  it('bad values in the file fall back field by field', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, THREAD_LEDGER_FILE),
      JSON.stringify({ version: 1, threads: { t1: { spentUsd: -4, turns: { a: 'x', b: 1 }, caps: { perTurnUsd: 'no', perThreadUsd: null } }, t2: 7 } }),
    );
    const ledger = createThreadLedger({ dataDir: dir, budget: recorder().budget, clock: fakeClock() });
    await ledger.load();
    expect(ledger.spend('t1', 'b')).toEqual({ turnUsd: 1, threadUsd: 0 });
    expect(ledger.caps('t1')).toMatchObject({ perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: null });
    expect(ledger.spend('t2')).toEqual({ turnUsd: 0, threadUsd: 0 });
    await ledger.dispose();
  });
});

describe('with the real budget and spend ledger: counted once, across a restart and a crash', () => {
  async function app(clock: FakeClock) {
    const tc = await createTestContext({ now: () => new Date(clock.now()) });
    contexts.push(tc);
    const open = async () => {
      const spend = await openSpendLedger(join(tc.ctx.paths.data, 'spend-ledger.json'), { now: () => new Date(clock.now()) });
      const service = await createBudgetService({ ctx: tc.ctx, ledger: spend });
      return { spend, service };
    };
    return { tc, open };
  }

  it('spend counts at once, settling the turn moves it into the ledger without changing the total', async () => {
    const clock = fakeClock();
    const { tc, open } = await app(clock);
    const { spend, service } = await open();
    const ledger = createThreadLedger({ dataDir: tc.ctx.paths.data, budget: service.guard, clock });
    const off = service.sources.register(ledger.source);
    await ledger.load();
    ledger.add(charge({ usd: 0.04, at: clock.now() }));
    ledger.add(charge({ usd: 0.03, modelId: 'flash', at: clock.now() }));
    expect(service.guard.statusSnapshot().spentTodayUsd).toBeCloseTo(0.07, 6);
    ledger.settleTurn('t1', 'u1');
    expect(service.guard.statusSnapshot().spentTodayUsd).toBeCloseTo(0.07, 6);
    expect(spend.all().map((e) => [e.kind, e.modelId, e.ref])).toEqual([
      ['agent', 'm', 'thr:t1/turn:u1'],
      ['agent', 'flash', 'thr:t1/turn:u1'],
    ]);
    expect(spend.totalsSince(new Date(0))).toMatchObject({ agent: 0.07, media: 0, chat: 0 });
    await ledger.dispose();
    off();
    await spend.flush();
    service.dispose();
  });

  it('a restart keeps the thread\'s remaining budget; a crash before the flush is reported once at the next start', async () => {
    const clock = fakeClock();
    const { tc, open } = await app(clock);
    const first = await open();
    const ledger = createThreadLedger({ dataDir: tc.ctx.paths.data, budget: first.service.guard, clock });
    const off = first.service.sources.register(ledger.source);
    await ledger.load();
    ledger.add(charge({ usd: 0.05, at: clock.now() }));
    ledger.settleTurn('t1', 'u1');
    ledger.add(charge({ turnId: 'u2', usd: 0.04, at: clock.now() }));
    ledger.setCaps('t1', { perTurnUsd: 0.5, perThreadUsd: 2 });
    await vi.waitFor(async () => expect((await persisted(tc.ctx.paths.data)).threads.t1!.unflushed).toHaveProperty('u2'));
    await first.spend.flush();
    // Crash: no dispose / flush. The u2 spend is only in gateway-threads.json.
    off();
    first.service.dispose();

    const second = await open();
    expect(second.spend.totalsSince(new Date(0)).agent).toBeCloseTo(0.05, 9);
    const again = createThreadLedger({ dataDir: tc.ctx.paths.data, budget: second.service.guard, clock });
    second.service.sources.register(again.source);
    await again.load();
    expect(again.spend('t1', 'u2')).toEqual({ turnUsd: expect.closeTo(0.04, 9), threadUsd: expect.closeTo(0.09, 9) });
    expect(again.caps('t1')).toMatchObject({ perTurnUsd: 0.5, perThreadUsd: 2 });
    // Remaining thread budget unchanged by the restart.
    expect(again.caps('t1').perThreadUsd! - again.spend('t1').threadUsd).toBeCloseTo(1.91, 9);
    // The crashed turn's spend went into the ledger at load, once.
    expect(second.spend.totalsSince(new Date(0)).agent).toBeCloseTo(0.09, 9);
    expect(again.source.totalSince(new Date(0))).toBe(0);
    expect(second.service.guard.statusSnapshot().spentTodayUsd).toBeCloseTo(0.09, 6);
    await again.dispose();
    await second.spend.flush();
    second.service.dispose();
  });
});
