// H1-B: main's own estimate (harness.md §4.4, §7.2): worst-case reservation, display estimate from the common
// prefix, calibration.
import { describe, expect, it } from 'vitest';
import type { LlmPricing } from '@shared/contracts/catalog';
import type { GatewayScope, GwMessage, GwToolDef } from '@shared/contracts/gateway';
import { commonUnits, contextCeilingTokens, createEstimator, estimateTextTokens, fingerprint, worstCasePromptTokens, worstCaseTextTokens } from '@main/services/gateway/estimate';
import { GATEWAY_LIMITS, type EstimateInput } from '@main/services/gateway/types';
import { describeEstimatorContract } from './contracts';
import { FAKE_PRICING, fakeClock } from './fakes';

describeEstimatorContract('estimate.ts', () => createEstimator({ clock: fakeClock() }));

const scope = (over: Partial<GatewayScope> = {}): GatewayScope => ({ threadId: 't1', turnId: 'u1', runId: 'r1', step: 1, ...over });
const resolved = (over: Partial<EstimateInput['resolved']> = {}): EstimateInput['resolved'] => ({ modelKey: 'm', pricing: FAKE_PRICING, discount: 0.5, maxOutputTokens: 1_000, ...over });
const input = (messages: GwMessage[], over: Partial<EstimateInput> = {}): EstimateInput => ({ scope: scope(), resolved: resolved(), messages, tools: null, purpose: 'agent', ...over });

const SYSTEM: GwMessage = { role: 'system', content: 'You are a careful coding agent. '.repeat(200) };
const TOOLS: GwToolDef[] = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'edit', description: 'Edit a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
];
const user = (text: string): GwMessage => ({ role: 'user', content: text });
const assistant = (text: string, reasoning: string | null = null): GwMessage => ({ role: 'assistant', content: text, reasoning: reasoning ? { text: reasoning, family: 'glm' } : null });

describe('estimateTextTokens', () => {
  it('4 ASCII characters per token, 1 per other character, a surrogate pair once', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abc')).toBe(1);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(estimateTextTokens('日本語')).toBe(3);
    expect(estimateTextTokens('😀')).toBe(1);
  });
});

describe('estimate: P, worst case, tiers', () => {
  it('counts tools, content, tool calls and every assistant reasoning (worst case)', () => {
    const est = createEstimator({ clock: fakeClock() });
    const base = est.estimate(input([SYSTEM, user('hi')])).promptTokens;
    const withTools = est.estimate(input([SYSTEM, user('hi')], { tools: TOOLS })).promptTokens;
    expect(withTools).toBeGreaterThan(base);
    const call: GwMessage = { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read', arguments: '{"path":"src/a.ts"}'.repeat(10) }] };
    expect(est.estimate(input([SYSTEM, user('hi'), call])).promptTokens).toBeGreaterThan(base + 40);
    // Reasoning of an earlier turn still counts for P (some families replay it; calibration corrects the rest).
    const r = 'thinking '.repeat(400);
    const withReasoning = est.estimate(input([SYSTEM, user('a'), assistant('x', r), user('b')])).promptTokens;
    const without = est.estimate(input([SYSTEM, user('a'), assistant('x'), user('b')])).promptTokens;
    expect(withReasoning - without).toBe(estimateTextTokens(r));
  });

  it('the reservation uses the tier P selects and counts cached tokens as 0', () => {
    const tiered: LlmPricing = { ...FAKE_PRICING, tiers: [{ minPromptTokens: 1_000, inputPerMTok: 2.8, outputPerMTok: 8.8, cacheReadPerMTok: 0.52, cacheWritePerMTok: null }] };
    const est = createEstimator({ clock: fakeClock() });
    const small = est.estimate(input([user('x'.repeat(400))], { resolved: resolved({ pricing: tiered, discount: 0 }) }));
    expect(small.promptTokens).toBeLessThan(1_000);
    const smallP = worstCasePromptTokens([user('x'.repeat(400))]);
    expect(smallP).toBeLessThan(1_000);
    expect(small.reserveUsd!).toBeCloseTo((smallP * 1.4 + 1_000 * 4.4) / 1e6, 12);
    const big = est.estimate(input([user('x'.repeat(8_000))], { resolved: resolved({ pricing: tiered, discount: 0 }) }));
    expect(big.promptTokens).toBeGreaterThanOrEqual(1_000);
    expect(big.reserveUsd!).toBeCloseTo((worstCasePromptTokens([user('x'.repeat(8_000))]) * 2.8 + 1_000 * 8.8) / 1e6, 12);
    // The tier follows the reservation's own prompt: 2,000 chars are 500 display tokens but 800 reserved…
    expect(est.estimate(input([user('x'.repeat(2_000))], { resolved: resolved({ pricing: tiered, discount: 0 }) })).reserveUsd!).toBeCloseTo(
      (worstCasePromptTokens([user('x'.repeat(2_000))]) * 1.4 + 1_000 * 4.4) / 1e6,
      12,
    );
    // …and 3,000 chars (750 display) reserve 1,204 tokens, at the long-context tier.
    expect(est.estimate(input([user('x'.repeat(3_000))], { resolved: resolved({ pricing: tiered, discount: 0 }) })).reserveUsd!).toBeCloseTo(
      (worstCasePromptTokens([user('x'.repeat(3_000))]) * 2.8 + 1_000 * 8.8) / 1e6,
      12,
    );
  });

  it('missing input or output price → unpriced', () => {
    const est = createEstimator({ clock: fakeClock() });
    const e = est.estimate(input([user('x')], { resolved: resolved({ pricing: { ...FAKE_PRICING, outputPerMTok: null } }) }));
    expect(e).toMatchObject({ reserveUsd: null, expectedUsd: null });
    expect(e.tpmTokens).toBe(e.promptTokens + 1_000);
  });
});

describe('display estimate: C from the common prefix (§4.4)', () => {
  const turn1 = [SYSTEM, user('Fix the test.'), assistant('', 'Let me look at the file first. '.repeat(50)), { role: 'tool', content: 'file contents '.repeat(300), toolCallId: 'c1' } as GwMessage];

  it('a growing tool loop caches the whole previous request; the display is below the worst case', () => {
    const clock = fakeClock();
    const est = createEstimator({ clock });
    const first = est.estimate(input(turn1, { tools: TOOLS }));
    expect(first.expectedCachedTokens).toBe(0);
    expect(first.expectedUsd!).toBeLessThanOrEqual(first.reserveUsd!);
    est.commit(scope(), 'm', first.prefix, clock.now());
    clock.advance(10_000);
    const next = est.estimate(input([...turn1, assistant('Done.')], { tools: TOOLS }));
    expect(next.expectedCachedTokens).toBe(first.promptTokens);
    expect(next.expectedCachedTokens).toBeLessThanOrEqual(next.promptTokens);
    expect(next.expectedUsd!).toBeLessThan(next.reserveUsd!);
    // Worst case unchanged by the cache.
    expect(next.reserveUsd!).toBeCloseTo(((worstCasePromptTokens([...turn1, assistant('Done.')], TOOLS) * 1.4 + 1_000 * 4.4) / 1e6) * 0.5, 12);
  });

  it('a new user turn drops earlier reasoning: the common prefix ends before that assistant message', () => {
    const clock = fakeClock();
    const est = createEstimator({ clock });
    const first = est.estimate(input(turn1));
    est.commit(scope(), 'm', first.prefix, clock.now());
    const next = est.estimate(input([...turn1, assistant('Fixed.'), user('Now add a test.')]));
    const upToUser = est.estimate(input(turn1.slice(0, 2))).promptTokens;
    expect(next.expectedCachedTokens).toBe(upToUser);
  });

  it('after compaction only the unchanged prefix is cached', () => {
    const clock = fakeClock();
    const est = createEstimator({ clock });
    const long = [...turn1, assistant('a'.repeat(4_000)), user('more'), assistant('b'.repeat(4_000))];
    const first = est.estimate(input(long, { tools: TOOLS }));
    est.commit(scope(), 'm', first.prefix, clock.now());
    const compacted = [SYSTEM, user('Summary: fixed the test, adding another.'), user('more')];
    const next = est.estimate(input(compacted, { tools: TOOLS }));
    const prefixOnly = est.estimate(input([SYSTEM], { tools: TOOLS })).promptTokens;
    expect(next.expectedCachedTokens).toBe(prefixOnly);
    expect(next.promptTokens).toBeLessThan(first.promptTokens);
  });

  it('C = 0 after the cache TTL, for another model, or another thread', () => {
    const clock = fakeClock();
    const est = createEstimator({ clock });
    const first = est.estimate(input(turn1));
    est.commit(scope(), 'm', first.prefix, clock.now());
    expect(est.estimate(input(turn1, { resolved: resolved({ modelKey: 'other' }) })).expectedCachedTokens).toBe(0);
    expect(est.estimate(input(turn1, { scope: scope({ threadId: 't2' }) })).expectedCachedTokens).toBe(0);
    clock.advance(GATEWAY_LIMITS.cacheTtlMs);
    expect(est.estimate(input(turn1)).expectedCachedTokens).toBe(first.promptTokens);
    clock.advance(1);
    expect(est.estimate(input(turn1)).expectedCachedTokens).toBe(0);
  });

  it('estimate() is pure: nothing is remembered until commit()', () => {
    const est = createEstimator({ clock: fakeClock() });
    est.estimate(input(turn1));
    expect(est.estimate(input(turn1)).expectedCachedTokens).toBe(0);
  });

  it('fingerprint / commonUnits', () => {
    const a = fingerprint([SYSTEM, user('a'), user('b')], TOOLS);
    const b = fingerprint([SYSTEM, user('a'), user('c')], TOOLS);
    expect(a.hashes).toHaveLength(5);
    expect(a.tokens[4]).toBeGreaterThan(a.tokens[3]!);
    expect(commonUnits(a, b)).toBe(4);
    expect(commonUnits(a, a)).toBe(5);
    expect(commonUnits(a, fingerprint([user('x')]))).toBe(0);
    // Tool order matters (the host sorts tools canonically).
    expect(commonUnits(a, fingerprint([SYSTEM], [...TOOLS].reverse()))).toBe(0);
  });
});

describe('calibration per (thread, model) (§7.2)', () => {
  it('learns measured / estimated by EMA α 0.3 and clamps to 0.5–2.5', () => {
    const est = createEstimator({ clock: fakeClock() });
    const msgs = [user('x'.repeat(40_000))];
    const p0 = est.estimate(input(msgs)).promptTokens;
    est.observe(scope(), 'm', p0, p0 * 2);
    const p1 = est.estimate(input(msgs)).promptTokens;
    expect(p1 / p0).toBeCloseTo(1.3, 3);
    // Another thread and another model are unaffected.
    expect(est.estimate(input(msgs, { scope: scope({ threadId: 't2' }) })).promptTokens).toBe(p0);
    expect(est.estimate(input(msgs, { resolved: resolved({ modelKey: 'm2' }) })).promptTokens).toBe(p0);
    for (let i = 0; i < 50; i++) {
      const p = est.estimate(input(msgs)).promptTokens;
      est.observe(scope(), 'm', p, p * 10);
    }
    expect(est.estimate(input(msgs)).promptTokens / p0).toBeCloseTo(GATEWAY_LIMITS.calibrationMax, 2);
    for (let i = 0; i < 80; i++) {
      const p = est.estimate(input(msgs)).promptTokens;
      est.observe(scope(), 'm', p, p / 10);
    }
    expect(est.estimate(input(msgs)).promptTokens / p0).toBeCloseTo(GATEWAY_LIMITS.calibrationMin, 2);
  });

  it('ignores nonsense measurements', () => {
    const est = createEstimator({ clock: fakeClock() });
    const msgs = [user('x'.repeat(4_000))];
    const p0 = est.estimate(input(msgs)).promptTokens;
    est.observe(scope(), 'm', p0, 0);
    est.observe(scope(), 'm', p0, Number.NaN);
    est.observe(scope(), 'm', 0, 100);
    expect(est.estimate(input(msgs)).promptTokens).toBe(p0);
  });
});

describe('contextCeilingTokens (§7.4)', () => {
  it('160k default window: C = 160,000 − (24,000 + 16,384)', () => {
    expect(contextCeilingTokens({ contextLength: 1_048_576 })).toBe(160_000 - 24_000 - 16_384);
    expect(contextCeilingTokens({ contextLength: 64_000, maxOutputTokens: 8_000 })).toBe(64_000 - 16_384 - 8_000);
    expect(contextCeilingTokens({ contextLength: null })).toBe(128_000 - 19_200 - 16_384);
    expect(contextCeilingTokens({ contextLength: 1_000_000, maxContextTokens: null })).toBe(1_000_000 - 150_000 - 16_384);
  });
});
