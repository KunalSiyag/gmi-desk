// C1-D: the Usage "This device" compute row (compute.md §9.3, §21 C1-D): month and today at list price, what bills
// now, hidden while the compute slice has nothing to show. Markup only (react-dom/server).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ComputeState } from '@shared/contracts/compute';
import type { LocalSpend as LocalSpendData } from '@shared/contracts/usage';
import { COMPUTE_SWATCH, ComputeSpendRow, LocalSpend } from '@renderer/pages/usage/LocalSpend';

const state = (over: Partial<ComputeState> = {}): ComputeState =>
  ({
    running: { count: 2, usdPerHour: 3.4411 },
    todayUsd: 6.79,
    monthUsd: 41.2,
    alarms: [],
    apiHealth: { ce: 'ok', sandbox: 'ok' },
    org: null,
    dailyBudgetSet: true,
    lastSweepAt: null,
    mock: true,
    ...over,
  }) as ComputeState;

describe('compute row on Usage', () => {
  it('shows month, today and the running burn at list price', () => {
    const html = renderToStaticMarkup(<ComputeSpendRow state={state()} />);
    expect(html).toContain('data-compute-spend');
    expect(html).toContain('$41.20');
    expect(html).toContain('$6.79 today');
    expect(html).toContain('2 running at $3.44/h');
    expect(html).toContain('this month · list price');
    expect(html).toContain('counted in your budget');
    expect(html).toContain(COMPUTE_SWATCH);
    // Brand rule: no lime text on the row.
    expect(html).not.toContain('text-primary');
  });

  it('is hidden without compute state or when nothing ran', () => {
    expect(renderToStaticMarkup(<ComputeSpendRow state={null} />)).toBe('');
    expect(renderToStaticMarkup(<ComputeSpendRow state={state({ monthUsd: 0, todayUsd: 0, running: { count: 0, usdPerHour: 0 } })} />)).toBe('');
    // Running but nothing accrued yet (first minute) still shows.
    expect(renderToStaticMarkup(<ComputeSpendRow state={state({ monthUsd: 0, todayUsd: 0 })} />)).toContain('2 running');
  });

  it('LocalSpend renders without a QueryClientProvider (no compute row, no fetch)', () => {
    const spend: LocalSpendData = { days: 7, chatUsd: 1, mediaUsd: 0, computeUsd: 0, byModel: [], entries: [], entryCount: 0 };
    const html = renderToStaticMarkup(<LocalSpend spend={spend} loading={false} periodLabel="Last 7 days" />);
    expect(html).toContain('Nothing spent from this device');
    expect(html).not.toContain('data-compute-spend');
  });

  it('labels compute ledger entries with their own icon and swatch', () => {
    const spend: LocalSpendData = {
      days: 7,
      chatUsd: 0,
      mediaUsd: 0,
      computeUsd: 1.2,
      byModel: [{ modelId: 'gmi.sandbox.small', kind: 'compute', usd: 1.2, count: 1 }],
      entries: [{ id: 'e1', at: new Date().toISOString(), kind: 'compute', modelId: 'gmi.sandbox.small', usd: 1.2, ref: null }],
      entryCount: 1,
    };
    const html = renderToStaticMarkup(<LocalSpend spend={spend} loading={false} periodLabel="Last 7 days" />);
    expect(html).toMatch(/lucide-server/);
    expect(html).toContain('Compute');
  });
});
