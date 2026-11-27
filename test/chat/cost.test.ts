import { afterEach, describe, expect, it } from 'vitest';
import type { LlmPricing } from '@shared/contracts/catalog';
import type { TokenUsage } from '@shared/contracts/chat';
import { createChatSlice } from '@main/services/chat';
import { estimateReplyCostUsd, estimateTokens, estimateUsageFromText, pricingForPrompt } from '@main/services/chat/cost';
import { createTestContext } from '../helpers/context';
import { createFakeFetch, sseData, sseResponse } from '../helpers/fetch';
import { fakeBudget, fakeCatalog, fakeKeys, llm, waitForEnd } from './fakes';

const usage = (promptTokens: number, completionTokens: number, cachedTokens: number | null = null): TokenUsage => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
  reasoningTokens: null,
  cachedTokens,
});

const tiered: LlmPricing = {
  inputPerMTok: 2,
  outputPerMTok: 12,
  cacheReadPerMTok: 0.2,
  cacheWritePerMTok: null,
  tiers: [
    { minPromptTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18, cacheReadPerMTok: null, cacheWritePerMTok: null },
    { minPromptTokens: 500_000, inputPerMTok: 6, outputPerMTok: null, cacheReadPerMTok: 0.6, cacheWritePerMTok: null },
  ],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('reply cost', () => {
  it('uses the base prices below the first long-context tier', () => {
    expect(pricingForPrompt(tiered, 199_999)).toEqual({ inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2 });
    expect(pricingForPrompt({ ...tiered, tiers: undefined }, 900_000)).toEqual({ inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2 });
    expect(pricingForPrompt(null, 10)).toBeNull();
  });

  it('switches the whole request to the highest tier the prompt reaches, filling gaps from the base', () => {
    expect(pricingForPrompt(tiered, 200_000)).toEqual({ inputPerMTok: 4, outputPerMTok: 18, cacheReadPerMTok: 0.2 });
    expect(pricingForPrompt(tiered, 650_000)).toEqual({ inputPerMTok: 6, outputPerMTok: 12, cacheReadPerMTok: 0.6 });
  });

  it('prices cached prompt tokens at the cache rate and applies the org discount', () => {
    // (600 × 2 + 400 × 0.2 + 1000 × 12) / 1M × (1 − 0.25)
    expect(estimateReplyCostUsd(usage(1000, 1000, 400), { llmPricing: tiered, discount: 0.25 })).toBeCloseTo(0.00996, 9);
    // Long prompt: (250k × 4 + 2k × 18) / 1M, no discount.
    expect(estimateReplyCostUsd(usage(250_000, 2_000), { llmPricing: tiered, discount: null })).toBeCloseTo(1.036, 9);
  });

  it('is unknown (null) without a model or without prices', () => {
    expect(estimateReplyCostUsd(usage(10, 10), null)).toBeNull();
    expect(estimateReplyCostUsd(usage(10, 10), { llmPricing: null, discount: 0.5 })).toBeNull();
    expect(
      estimateReplyCostUsd(usage(10, 10), { llmPricing: { inputPerMTok: null, outputPerMTok: 1, cacheReadPerMTok: null, cacheWritePerMTok: null }, discount: 0 }),
    ).toBeNull();
  });

  it('records the tiered cost of a long-context reply with the budget guard', async () => {
    const model = 'google/gemini-3.1-pro-preview';
    const fake = createFakeFetch([
      {
        match: '/chat/completions',
        respond: () =>
          sseResponse([
            sseData({ model, choices: [{ index: 0, delta: { content: 'Summary.' }, finish_reason: 'stop' }] }),
            sseData({ model, choices: [], usage: { prompt_tokens: 300_000, completion_tokens: 1_000, total_tokens: 301_000 } }),
            'data: [DONE]\n\n',
          ]),
      },
    ]);
    const t = await createTestContext({ fetch: fake.fetch });
    cleanups.push(() => t.cleanup());
    const { budget, recorded } = fakeBudget();
    const slice = await createChatSlice(
      t.ctx,
      { keys: fakeKeys().keys, catalog: fakeCatalog([llm(model, { llmPricing: tiered, discount: 0 })]), budget },
      { flushIntervalMs: 0 },
    );
    cleanups.unshift(async () => {
      await slice.dispose();
    });
    const thread = await slice.api.createThread({ settings: { model } });
    const { assistantMessageId } = await slice.api.send(thread.id, 'Summarise this long document');
    const end = await waitForEnd(t, assistantMessageId);
    // (300k × 4 + 1k × 18) / 1M
    expect(end.type === 'done' ? end.message.costUsd : null).toBeCloseTo(1.218, 9);
    expect(recorded).toEqual([{ kind: 'chat', modelId: model, usd: 1.218, ref: assistantMessageId }]);
  });
});

describe('usage estimated from text (replies GMI reported no usage for)', () => {
  it('counts about 4 ASCII characters per token and every other character as a token (rounded up)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    // CJK and accented letters: one token each; an emoji (a surrogate pair) is one character.
    expect(estimateTokens('日本語')).toBe(3);
    expect(estimateTokens('café')).toBe(2);
    expect(estimateTokens('🚀🚀')).toBe(2);
  });

  it('prices the prompt it was sent with (system prompt + history, 4 tokens a message) and the partial reply', () => {
    const usage = estimateUsageFromText(
      { systemPrompt: 'Be brief.', history: [{ content: 'x'.repeat(400) }, { content: 'ok' }, { content: 'y'.repeat(40) }] },
      { content: 'z'.repeat(80), reasoning: 'r'.repeat(20) },
    );
    expect(usage).toEqual({
      promptTokens: 3 + 100 + 1 + 10 + 4 * 4,
      // Like GMI's completion_tokens, reasoning is part of the reply count.
      completionTokens: 20 + 5,
      totalTokens: 130 + 25,
      reasoningTokens: 5,
      cachedTokens: null,
    });
    const noSystem = estimateUsageFromText({ systemPrompt: null, history: [{ content: 'abcd' }] }, { content: '', reasoning: null });
    expect(noSystem).toEqual({ promptTokens: 5, completionTokens: 0, totalTokens: 5, reasoningTokens: null, cachedTokens: null });
  });
});
