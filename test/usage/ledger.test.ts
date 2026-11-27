import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_SPEND_MAX_ENTRIES } from '@shared/contracts/usage';
import { LEDGER_RETENTION_DAYS, normalizeLedger, openSpendLedger, trimLedger } from '@main/services/usage/ledger';
import { createUsageSlice } from '@main/services/usage';
import { createTestContext, type TestContext } from '../helpers/context';
import { clock, fakeAuth, fakeMcp } from './fakes';

const DAY = 86_400_000;
const NOW = new Date('2026-10-31T12:00:00Z');
const daysAgo = (n: number, from = NOW) => new Date(from.getTime() - n * DAY).toISOString();

let t: TestContext | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('ledger trimming and validation', () => {
  it('keeps the last 120 days and drops malformed rows', () => {
    const rows = [
      { id: 'old', at: daysAgo(200), kind: 'chat', modelId: 'm', usd: 1, ref: null },
      { id: 'edge', at: daysAgo(LEDGER_RETENTION_DAYS - 1), kind: 'media', modelId: 'm', usd: 2, ref: null },
      { id: 'recent', at: daysAgo(1), kind: 'chat', modelId: 'm', usd: 0.5, ref: 'x' },
      { id: 'zero', at: daysAgo(1), kind: 'chat', modelId: 'm', usd: 0, ref: null },
      { id: 'kind', at: daysAgo(1), kind: 'other', modelId: 'm', usd: 1, ref: null },
      { id: 'date', at: 'yesterday', kind: 'chat', modelId: 'm', usd: 1, ref: null },
      'garbage',
    ];
    expect(normalizeLedger(rows, NOW).map((e) => e.id)).toEqual(['edge', 'recent']);
    expect(normalizeLedger({ not: 'an array' }, NOW)).toEqual([]);
    expect(trimLedger(normalizeLedger(rows, NOW), new Date(NOW.getTime() + 2 * DAY)).map((e) => e.id)).toEqual(['recent']);
  });

  it('trims old entries from disk on open and on the next append', async () => {
    const c = clock(NOW);
    t = await createTestContext({ now: c.now });
    const path = join(t.ctx.paths.data, 'spend-ledger.json');
    await writeFile(
      path,
      JSON.stringify([
        { id: 'a', at: daysAgo(130), kind: 'chat', modelId: 'm', usd: 1, ref: null },
        { id: 'b', at: daysAgo(119), kind: 'chat', modelId: 'm', usd: 1, ref: null },
        { id: 'c', at: daysAgo(3), kind: 'media', modelId: 'm', usd: 1, ref: null },
      ]),
    );
    const ledger = await openSpendLedger(path, { now: c.now });
    expect(ledger.all().map((e) => e.id)).toEqual(['b', 'c']);
    c.advance(2 * DAY);
    await ledger.append({ kind: 'chat', modelId: 'openai/gpt-6.1-sol', usd: 0.25 });
    await ledger.flush();
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as Array<{ id: string }>;
    expect(onDisk.map((e) => e.id).slice(0, 1)).toEqual(['c']);
    expect(onDisk).toHaveLength(2);
  });
});

describe('ledger writes', () => {
  it('serialises concurrent appends: every entry lands on disk, atomically', async () => {
    t = await createTestContext({ now: () => NOW });
    const path = join(t.ctx.paths.data, 'spend-ledger.json');
    const ledger = await openSpendLedger(path, { now: () => NOW });
    const saved = await Promise.all(
      Array.from({ length: 50 }, (_, i) => ledger.append({ kind: i % 2 ? 'chat' : 'media', modelId: `model-${i % 5}`, usd: 0.01 * (i + 1) })),
    );
    expect(saved.every((e) => e !== null)).toBe(true);
    expect(new Set(saved.map((e) => e?.id)).size).toBe(50);
    await ledger.flush();
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as unknown[];
    expect(onDisk).toHaveLength(50);
    expect((await readdir(t.ctx.paths.data)).filter((f) => f.includes('.tmp-'))).toEqual([]);
    const reopened = await openSpendLedger(path, { now: () => NOW });
    expect(reopened.all()).toHaveLength(50);
  });

  it('ignores zero, negative and non-finite amounts and unknown kinds', async () => {
    t = await createTestContext({ now: () => NOW });
    const ledger = await openSpendLedger(join(t.ctx.paths.data, 'spend-ledger.json'), { now: () => NOW });
    for (const usd of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await ledger.append({ kind: 'chat', modelId: 'm', usd })).toBeNull();
    }
    expect(await ledger.append({ kind: 'bogus' as never, modelId: 'm', usd: 1 })).toBeNull();
    expect(ledger.all()).toEqual([]);
    const entry = await ledger.append({ kind: 'media', modelId: '  ', usd: 1.5, ref: '  job-1 ' });
    expect(entry).toMatchObject({ kind: 'media', modelId: 'unknown', usd: 1.5, ref: 'job-1', at: NOW.toISOString() });
  });
});

describe('getLocalSpend', () => {
  it('sums a rolling window by kind and model, newest first', async () => {
    const c = clock(new Date(NOW.getTime() - 10 * DAY));
    t = await createTestContext({ now: c.now });
    const slice = await createUsageSlice(t.ctx, { auth: fakeAuth().auth, mcp: fakeMcp().mcp });
    const at = async (msAgo: number, kind: 'chat' | 'media', modelId: string, usd: number) => {
      c.set(new Date(NOW.getTime() - msAgo));
      await slice.budget.record({ kind, modelId, usd });
    };
    await at(8 * DAY, 'media', 'wan3.0-video', 4); // outside 7d
    await at(5 * DAY, 'media', 'wan3.0-video', 1.6);
    await at(2 * DAY, 'chat', 'openai/gpt-6.1-sol', 0.2);
    await at(DAY / 2, 'chat', 'openai/gpt-6.1-sol', 0.1);
    await at(60_000, 'media', 'seedance-2-5-260628', 1.155);
    c.set(NOW);

    const week = await slice.usage.getLocalSpend(7);
    expect(week).toMatchObject({ days: 7, chatUsd: 0.3, mediaUsd: 2.755, entryCount: 4 });
    expect(week.byModel).toEqual([
      { modelId: 'wan3.0-video', kind: 'media', usd: 1.6, count: 1 },
      { modelId: 'seedance-2-5-260628', kind: 'media', usd: 1.155, count: 1 },
      { modelId: 'openai/gpt-6.1-sol', kind: 'chat', usd: 0.3, count: 2 },
    ]);
    expect(week.entries.map((e) => e.modelId)).toEqual(['seedance-2-5-260628', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol', 'wan3.0-video']);

    const day = await slice.usage.getLocalSpend(1);
    expect(day).toMatchObject({ chatUsd: 0.1, mediaUsd: 1.155, entryCount: 2 });
    await expect(slice.usage.getLocalSpend(0)).rejects.toMatchObject({ code: 'invalid_input' });
    await slice.dispose();
  });

  it('caps the returned entries but not the totals', async () => {
    t = await createTestContext({ now: () => NOW });
    const slice = await createUsageSlice(t.ctx, { auth: fakeAuth().auth, mcp: fakeMcp().mcp });
    await Promise.all(Array.from({ length: LOCAL_SPEND_MAX_ENTRIES + 10 }, () => slice.budget.record({ kind: 'chat', modelId: 'm', usd: 0.01 })));
    const spend = await slice.usage.getLocalSpend(1);
    expect(spend.entries).toHaveLength(LOCAL_SPEND_MAX_ENTRIES);
    expect(spend.entryCount).toBe(LOCAL_SPEND_MAX_ENTRIES + 10);
    expect(spend.chatUsd).toBeCloseTo(0.01 * (LOCAL_SPEND_MAX_ENTRIES + 10), 6);
    await slice.dispose();
  });
});
