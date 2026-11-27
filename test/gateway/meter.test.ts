// H1-B: metering (harness.md §4.3) and the per-request trace (§4.3, §21).
import { describe, expect, it } from 'vitest';
import type { LlmPricing } from '@shared/contracts/catalog';
import type { GatewayScope } from '@shared/contracts/gateway';
import { sanitize, SECRET_KEY_PATTERN, type Logger } from '@main/core/logger';
import type { BudgetGuard } from '@main/core/services';
import { createEstimator } from '@main/services/gateway/estimate';
import { createMeter, pricesForPrompt } from '@main/services/gateway/meter';
import { createGatewayTrace, traceLogLine } from '@main/services/gateway/trace';
import type { GatewayEstimate, GatewayTraceRecord, MeterInput, ThreadSpendCharge } from '@main/services/gateway/types';
import { describeMeterContract } from './contracts';
import { FAKE_PRICING, fakeClock } from './fakes';

type Row = Parameters<BudgetGuard['record']>[0];

function setup() {
  const clock = fakeClock();
  const charges: ThreadSpendCharge[] = [];
  const rows: Row[] = [];
  const warnings: string[] = [];
  const log = { debug: () => undefined, info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined, child: () => log } as Logger;
  const meter = createMeter({
    threads: { add: (c) => charges.push(c) },
    budget: { record: async (r) => void rows.push(r) },
    estimator: createEstimator({ clock }),
    clock,
    log,
  });
  return { clock, meter, charges, rows, warnings };
}

describeMeterContract('meter.ts', () => {
  const s = setup();
  return { meter: s.meter, threadCharges: () => s.charges };
});

const scope = (over: Partial<GatewayScope> = {}): GatewayScope => ({ threadId: 't1', turnId: 'u1', runId: 'r1', step: 1, ...over });
const estimate: GatewayEstimate = { promptTokens: 2_000, maxOutputTokens: 500, expectedCachedTokens: 0, reserveUsd: 0.01, expectedUsd: 0.01, tpmTokens: 2_500, prefix: { hashes: [], tokens: [] } };
const input = (over: Partial<MeterInput> = {}): MeterInput => ({
  requestId: 'q1',
  purpose: 'agent',
  scope: scope(),
  model: 'zai-org/GLM-5.3',
  pricing: FAKE_PRICING,
  discount: 0.5,
  estimate,
  usage: null,
  cacheWriteTokens: null,
  responded: true,
  maybeBilled: false,
  output: { text: '', reasoning: '', toolArguments: '' },
  ...over,
});
const usage = (prompt: number, completion: number, cached: number | null = null) => ({ promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, reasoningTokens: null, cachedTokens: cached });

describe('price (§4.3 formula)', () => {
  const tiered: LlmPricing = {
    inputPerMTok: 0.9,
    outputPerMTok: 3,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.2,
    tiers: [{ minPromptTokens: 32_000, inputPerMTok: 1.62, outputPerMTok: 5.4, cacheReadPerMTok: 0.18, cacheWritePerMTok: null }],
  };

  it('the tier is chosen by prompt tokens including cached ones', () => {
    const { meter } = setup();
    // 40k prompt, 30k cached: still the ≥ 32k tier.
    expect(meter.price(usage(40_000, 1_000, 30_000), null, tiered, 0)).toBeCloseTo((10_000 * 1.62 + 30_000 * 0.18 + 1_000 * 5.4) / 1e6, 9);
    expect(meter.price(usage(31_999, 1_000), null, tiered, 0)).toBeCloseTo((31_999 * 0.9 + 1_000 * 3) / 1e6, 9);
  });

  it('cache writes at their own rate (the tier inherits a missing one), discount last', () => {
    const { meter } = setup();
    expect(meter.price(usage(10_000, 0, 2_000), 3_000, tiered, 0.25)).toBeCloseTo(((5_000 * 0.9 + 2_000 * 0.1 + 3_000 * 1.2) / 1e6) * 0.75, 9);
    expect(pricesForPrompt(tiered, 50_000)).toMatchObject({ inputPerMTok: 1.62, cacheWritePerMTok: 1.2 });
    expect(pricesForPrompt(null, 1)).toBeNull();
  });

  it('cache reads default to the input price when unknown', () => {
    const { meter } = setup();
    expect(meter.price(usage(1_000, 0, 1_000), null, { ...FAKE_PRICING, cacheReadPerMTok: null }, 0)).toBeCloseTo((1_000 * 1.4) / 1e6, 9);
  });
});

describe('charge', () => {
  it('measured usage is cleaned (GMI numbers are untrusted)', () => {
    const { meter } = setup();
    const r = meter.charge(input({ usage: { promptTokens: -5, completionTokens: Number.NaN, totalTokens: Number.POSITIVE_INFINITY, reasoningTokens: -1, cachedTokens: 3 } }));
    expect(r!.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: null, cachedTokens: 3 });
  });

  it('a 2xx with streamed output and no usage: prompt + streamed text, reasoning and tool arguments (estimated, no cache)', () => {
    const { meter } = setup();
    const r = meter.charge(input({ output: { text: 'abcd'.repeat(10), reasoning: 'efgh'.repeat(5), toolArguments: '{"a":1}' } }))!;
    expect(r.estimated).toBe(true);
    expect(r.usage).toEqual({ promptTokens: 2_000, completionTokens: 10 + 5 + 2, totalTokens: 2_017, reasoningTokens: 5, cachedTokens: null });
    expect(r.costUsd).toBeCloseTo(((2_000 * 1.4 + 17 * 4.4) / 1e6) * 0.5, 9);
  });

  it('a cancel during prefill after the 2xx: the prompt is charged although no token arrived', () => {
    const s = setup();
    const r = s.meter.charge(input())!;
    expect(r.usage.completionTokens).toBe(0);
    expect(r.costUsd).toBeCloseTo(((2_000 * 1.4) / 1e6) * 0.5, 9);
    expect(s.charges).toHaveLength(1);
  });

  it('maybe-billed attempt without a 2xx: an estimated prompt charge, flagged', () => {
    const s = setup();
    const r = s.meter.charge(input({ responded: false, maybeBilled: true, output: { text: 'ignored', reasoning: '', toolArguments: '' } }))!;
    expect(r).toMatchObject({ estimated: true, maybeBilled: true, usage: { completionTokens: 0, promptTokens: 2_000 } });
    expect(s.charges[0]).toMatchObject({ threadId: 't1', turnId: 'u1', modelId: 'zai-org/GLM-5.3' });
    expect(s.charges[0]!.usd).toBeCloseTo(r.costUsd!, 12);
  });

  it('not responded and not maybe billed → nothing billable, nothing recorded', () => {
    const s = setup();
    expect(s.meter.charge(input({ responded: false }))).toBeNull();
    expect(s.charges).toEqual([]);
    expect(s.rows).toEqual([]);
  });

  it('where spend goes: agent → thread ledger; probe/eval, thread-less and chat → ledger rows', () => {
    const s = setup();
    for (const purpose of ['agent', 'subagent', 'compaction', 'title', 'commit_message'] as const) s.meter.charge(input({ purpose, usage: usage(100, 10) }));
    expect(s.charges).toHaveLength(5);
    expect(s.charges.every((c) => c.at === s.clock.now())).toBe(true);
    // Chat: one 'chat' row per billed attempt, ref = the request (= chat message) id, written before the release.
    s.meter.charge(input({ requestId: 'msg-1', purpose: 'chat', scope: scope({ threadId: null, turnId: null, runId: null }), usage: usage(100, 10) }));
    expect(s.charges).toHaveLength(5);
    expect(s.rows.map((r) => [r.kind, r.ref])).toEqual([['chat', 'msg-1']]);
    s.rows.length = 0;
    s.meter.charge(input({ requestId: 'p1', purpose: 'probe', scope: scope({ threadId: null, turnId: null, runId: null }), usage: usage(100, 10) }));
    s.meter.charge(input({ requestId: 'e1', purpose: 'eval', scope: scope({ threadId: null, turnId: null, runId: null }), usage: usage(100, 10) }));
    s.meter.charge(input({ requestId: 'a1', purpose: 'agent', scope: scope({ threadId: null }), usage: usage(100, 10) }));
    expect(s.rows.map((r) => [r.kind, r.ref])).toEqual([
      ['agent', 'probe:p1'],
      ['agent', 'eval:e1'],
      ['agent', 'req:a1'],
    ]);
  });

  it('an unpriced billed request: cost null, nothing recorded, a warning (never chat)', () => {
    const s = setup();
    const r = s.meter.charge(input({ pricing: null, usage: usage(100, 10) }))!;
    expect(r.costUsd).toBeNull();
    expect(s.charges).toEqual([]);
    expect(s.warnings).toHaveLength(1);
    s.meter.charge(input({ purpose: 'chat', pricing: null, usage: usage(100, 10) }));
    expect(s.warnings).toHaveLength(1);
  });
});

describe('cacheHitRatio24h', () => {
  it('cached / prompt over measured requests of the last 24 h', () => {
    const s = setup();
    expect(s.meter.cacheHitRatio24h()).toBeNull();
    s.meter.charge(input({ usage: usage(1_000, 10, 900) }));
    s.clock.advance(12 * 3_600_000);
    s.meter.charge(input({ purpose: 'chat', usage: usage(1_000, 10, 100) }));
    s.meter.charge(input()); // estimated: not a measurement
    expect(s.meter.cacheHitRatio24h()).toBeCloseTo(0.5, 9);
    s.clock.advance(12 * 3_600_000 + 1);
    expect(s.meter.cacheHitRatio24h()).toBeCloseTo(0.1, 9);
    s.clock.advance(24 * 3_600_000);
    expect(s.meter.cacheHitRatio24h()).toBeNull();
  });
});

describe('trace (§4.3, §21)', () => {
  const record = (i: number): GatewayTraceRecord => ({
    requestId: `q${i}`,
    purpose: 'agent',
    priority: 'foreground',
    threadId: 't1',
    runId: 'r1',
    step: i,
    model: 'm',
    api: 'chat',
    attempts: 1,
    queueMs: 5,
    ttfbMs: 300,
    totalMs: 900,
    promptTokens: 1_000,
    cachedTokens: 800,
    cacheWriteTokens: null,
    completionTokens: 50,
    reasoningTokens: null,
    costUsd: 0.001,
    estimated: false,
    maybeBilled: false,
    status: 'ok',
    code: null,
    prefixHash8: 'abcdef0123456789',
    at: '2026-11-02T10:00:00.000Z',
  });

  it('a ring of the newest records, newest first', () => {
    const trace = createGatewayTrace({ size: 3 });
    for (let i = 1; i <= 5; i++) trace.record(record(i));
    expect(trace.recent().map((r) => r.requestId)).toEqual(['q5', 'q4', 'q3']);
    expect(trace.recent(1).map((r) => r.requestId)).toEqual(['q5']);
    expect(trace.recent()[0]!.prefixHash8).toBe('abcdef01');
  });

  it('one gateway.request info line whose token counts survive the logger\'s secret-key redaction', () => {
    const lines: Array<{ message: string; meta: unknown }> = [];
    const log = { debug: () => undefined, info: (message: string, meta?: unknown) => lines.push({ message, meta }), warn: () => undefined, error: () => undefined, child: () => log } as Logger;
    createGatewayTrace({ log }).record(record(1));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe('gateway.request');
    const meta = sanitize(lines[0]!.meta) as Record<string, unknown>;
    expect(meta).toMatchObject({ reqId: 'q1', prompt: 1_000, cached: 800, completion: 50, costUsd: 0.001, status: 'ok' });
    expect(Object.keys(traceLogLine(record(1))).filter((k) => SECRET_KEY_PATTERN.test(k))).toEqual([]);
  });
});
