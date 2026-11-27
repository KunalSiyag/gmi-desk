// H1-B: the defaults test (harness.md §16, DH10): at CODE_DEFAULTS the working window is ≤ 160k, and a cache-cold
// step at the compaction ceiling fits the per-turn cap for GLM-5.3 and DeepSeek-V4-Flash. Also pins the gateway
// numbers of §4.4–4.6 that both halves of H1 rely on.
import { describe, expect, it } from 'vitest';
import type { LlmPricing } from '@shared/contracts/catalog';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import { contextCeilingTokens, createEstimator, worstCasePromptTokens } from '@main/services/gateway/estimate';
import { GATEWAY_LIMITS } from '@main/services/gateway/types';
import { fakeClock } from './fakes';

/** List prices per 1M tokens (docs/research/harness.md §1.3), context windows from the catalog. */
const MODELS: Array<{ id: string; contextLength: number; pricing: LlmPricing }> = [
  { id: 'zai-org/GLM-5.3', contextLength: 1_048_576, pricing: { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26, cacheWritePerMTok: null } },
  { id: 'deepseek-ai/DeepSeek-V4-Flash', contextLength: 1_048_575, pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28, cacheReadPerMTok: 0.028, cacheWritePerMTok: null } },
];

/** A request whose estimate is exactly `tokens` prompt tokens (one user message: 4 overhead + chars / 4). */
function requestOf(tokens: number) {
  return [{ role: 'user' as const, content: 'x'.repeat((tokens - 4) * 4) }];
}

function coldStep(model: (typeof MODELS)[number], promptTokens: number) {
  const est = createEstimator({ clock: fakeClock() });
  return est.estimate({
    scope: { threadId: 't1', turnId: 'u1', runId: 'r1', step: 1 },
    // No org discount: the list price is the worst case.
    resolved: { modelKey: model.id, pricing: model.pricing, discount: null, maxOutputTokens: CODE_DEFAULTS.maxOutputTokens },
    messages: requestOf(promptTokens),
    purpose: 'agent',
  });
}

describe('defaults (DH10): 160k working window', () => {
  it('CODE_DEFAULTS: 160k window, 16,384 output, $1 per turn, $5 per thread', () => {
    expect(CODE_DEFAULTS.maxContextTokens).toBe(160_000);
    expect(CODE_DEFAULTS.maxOutputTokens).toBe(16_384);
    expect(CODE_DEFAULTS.perTurnUsd).toBe(1);
    expect(CODE_DEFAULTS.perThreadUsd).toBe(5);
  });

  for (const model of MODELS) {
    it(`${model.id}: the ceiling is ≤ 160k and a cache-cold step there fits the per-turn cap`, () => {
      const ceiling = contextCeilingTokens({ contextLength: model.contextLength });
      expect(ceiling).toBeLessThanOrEqual(CODE_DEFAULTS.maxContextTokens);
      expect(ceiling).toBe(119_616);
      const step = coldStep(model, ceiling);
      expect(step.promptTokens).toBe(ceiling);
      expect(step.expectedCachedTokens).toBe(0);
      // The worst-case reservation (cached = 0, full output) is what admission checks against the turn cap.
      expect(step.reserveUsd!).toBeLessThanOrEqual(CODE_DEFAULTS.perTurnUsd);
      // The reservation counts the prompt conservatively (2.5 ASCII characters per token), never below P.
      const reserveP = worstCasePromptTokens(requestOf(ceiling));
      expect(reserveP).toBeGreaterThanOrEqual(ceiling);
      expect(step.reserveUsd!).toBeCloseTo((reserveP * model.pricing.inputPerMTok! + CODE_DEFAULTS.maxOutputTokens * model.pricing.outputPerMTok!) / 1e6, 9);
      // And it uses well under the T1 TPM bucket per request.
      expect(step.tpmTokens).toBeLessThan(0.2 * 1_000_000);
    });
  }

  it('why not the model\'s full window: at the old 1M ceiling a cold GLM-5.3 step exceeds the $1 turn cap', () => {
    const glm = MODELS[0]!;
    const ceiling = contextCeilingTokens({ contextLength: glm.contextLength, maxContextTokens: null });
    expect(ceiling).toBeGreaterThan(700_000);
    expect(coldStep(glm, ceiling).reserveUsd!).toBeGreaterThan(CODE_DEFAULTS.perTurnUsd);
  });
});

describe('gateway numbers (§4.4–4.6, §21)', () => {
  it('match the design', () => {
    expect(GATEWAY_LIMITS.concurrency).toMatchObject({ global: 16, perModel: 6, perThread: { agent: 1, subagent: 2, compaction: 1 } });
    expect(GATEWAY_LIMITS.tpm).toEqual({ windowMs: 60_000, aimdFloor: 0.25, aimdDecrease: 0.7, aimdIncrease: 0.05, aimdQuietMs: 60_000 });
    expect(GATEWAY_LIMITS.agingStepMs).toBe(30_000);
    expect(GATEWAY_LIMITS.headOfLineMaxWaitMs).toBe(120_000);
    expect(GATEWAY_LIMITS.retry).toEqual({
      backoffBaseMs: 1_000,
      backoffFactor: 2,
      backoffCapMs: 20_000,
      maybeBilledRetries: 1,
      maybeBilledMaxPromptTokens: 32_000,
      rateLimitGiveUpMs: 600_000,
      rateLimitGiveUpInteractiveMs: 60_000,
    });
    expect(GATEWAY_LIMITS.watchdog).toEqual({ firstByteBaseMs: 90_000, firstBytePerTenKPromptMs: 1_000, idleMs: 120_000, totalMs: 900_000 });
    expect(GATEWAY_LIMITS.breaker).toEqual({ failures: 5, windowMs: 60_000, openMs: 30_000, maxOpenMs: 300_000 });
    expect(GATEWAY_LIMITS.agentFlushUsd).toBe(0.1);
    expect(GATEWAY_LIMITS.agentFlushMs).toBe(60_000);
    expect(GATEWAY_LIMITS.cacheTtlMs).toBe(300_000);
    expect(GATEWAY_LIMITS.probeReserveCapUsd).toBe(0.05);
    expect(GATEWAY_LIMITS.traceRing).toBe(1_000);
  });
});
