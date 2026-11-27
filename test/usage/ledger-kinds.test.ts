// F0: the ledger accepts `agent` and `compute` spend in buckets of their own: they count toward the total (budgets)
// and never as media (compute.md §13.2, harness.md §4.3).
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeLedger, openSpendLedger, SPEND_KINDS } from '@main/services/usage/ledger';
import { createTestContext, type TestContext } from '../helpers/context';

const NOW = new Date(2026, 10, 2, 12, 0);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

let t: TestContext | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function ledgerAt(now: () => Date) {
  t = await createTestContext({ now });
  return openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now });
}

describe('ledger kinds', () => {
  it('knows all four kinds', () => {
    expect([...SPEND_KINDS].sort()).toEqual(['agent', 'chat', 'compute', 'media']);
  });

  it('agent and compute entries count toward the total, not toward media', async () => {
    let now = hoursAgo(3);
    const ledger = await ledgerAt(() => now);
    await ledger.append({ kind: 'chat', modelId: 'm1', usd: 0.1 });
    await ledger.append({ kind: 'media', modelId: 'm2', usd: 0.2 });
    await ledger.append({ kind: 'agent', modelId: 'm3', usd: 0.4, ref: 'thr:t1/turn:1' });
    await ledger.append({ kind: 'compute', modelId: 'gmi.sandbox.small', usd: 0.8, ref: 'cr_1' });
    now = NOW;
    expect(ledger.totalsSince(hoursAgo(24))).toEqual({ chat: 0.1, media: 0.2, agent: 0.4, compute: 0.8, total: 1.5 });
    expect(ledger.totalsSince(hoursAgo(1)).total).toBe(0);
  });

  it('localSpend reports agent and compute separately; mediaUsd stays media only', async () => {
    const ledger = await ledgerAt(() => NOW);
    await ledger.append({ kind: 'media', modelId: 'img', usd: 1 });
    await ledger.append({ kind: 'agent', modelId: 'llm', usd: 2 });
    await ledger.append({ kind: 'agent', modelId: 'llm', usd: 0.5 });
    await ledger.append({ kind: 'compute', modelId: 'gpu', usd: 3 });
    const spend = ledger.localSpend(7);
    expect(spend).toMatchObject({ chatUsd: 0, mediaUsd: 1, agentUsd: 2.5, computeUsd: 3, entryCount: 4 });
    expect(spend.byModel).toEqual([
      { modelId: 'gpu', kind: 'compute', usd: 3, count: 1 },
      { modelId: 'llm', kind: 'agent', usd: 2.5, count: 2 },
      { modelId: 'img', kind: 'media', usd: 1, count: 1 },
    ]);
  });

  it('keeps agent/compute rows read from disk and still drops unknown kinds', () => {
    const at = hoursAgo(1).toISOString();
    const rows = [
      { id: 'a', at, kind: 'agent', modelId: 'm', usd: 1, ref: null },
      { id: 'c', at, kind: 'compute', modelId: 'm', usd: 1, ref: null },
      { id: 'x', at, kind: 'gpu', modelId: 'm', usd: 1, ref: null },
    ];
    expect(normalizeLedger(rows, NOW).map((e) => e.kind)).toEqual(['agent', 'compute']);
  });

  it('rejects unknown kinds on append', async () => {
    const ledger = await ledgerAt(() => NOW);
    expect(await ledger.append({ kind: 'other' as never, modelId: 'm', usd: 1 })).toBeNull();
    expect(ledger.all()).toEqual([]);
  });
});
