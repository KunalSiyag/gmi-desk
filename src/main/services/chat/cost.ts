/**
 * Estimated cost of one chat reply from its token usage, the model's list prices and the org discount.
 * Long-context tiers (GMI's `overrides`) apply to the whole request once the prompt reaches the tier.
 */
import type { CatalogModel, LlmPricing } from '@shared/contracts/catalog';
import type { TokenUsage } from '@shared/contracts/chat';
import { estimateTokenCostUsd, type PerMTokPricing } from '@shared/lib/money';

/** The prices that apply to a request with `promptTokens` prompt tokens (cached ones included). */
export function pricingForPrompt(pricing: LlmPricing | null | undefined, promptTokens: number): PerMTokPricing | null {
  if (!pricing) return null;
  const base: PerMTokPricing = {
    inputPerMTok: pricing.inputPerMTok,
    outputPerMTok: pricing.outputPerMTok,
    cacheReadPerMTok: pricing.cacheReadPerMTok,
  };
  let tier = null;
  for (const t of pricing.tiers ?? []) {
    if (Number.isFinite(t.minPromptTokens) && t.minPromptTokens > 0 && promptTokens >= t.minPromptTokens) {
      if (!tier || t.minPromptTokens >= tier.minPromptTokens) tier = t;
    }
  }
  if (!tier) return base;
  return {
    inputPerMTok: tier.inputPerMTok ?? base.inputPerMTok,
    outputPerMTok: tier.outputPerMTok ?? base.outputPerMTok,
    cacheReadPerMTok: tier.cacheReadPerMTok ?? base.cacheReadPerMTok,
  };
}

/** USD for one reply, discount applied; null when the model or its prices are unknown. */
export function estimateReplyCostUsd(usage: TokenUsage, model: Pick<CatalogModel, 'llmPricing' | 'discount'> | null | undefined): number | null {
  if (!model) return null;
  return estimateTokenCostUsd(usage, pricingForPrompt(model.llmPricing, usage.promptTokens), model.discount);
}

/** Role markers and separators that every chat message adds to the prompt. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Rough token count of `text`, on the high side: 4 ASCII characters per token (English prose is about 4,
 * code a bit less) and 1 token per other character (CJK, accented letters, emoji...), rounded up.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    // A surrogate pair is one character: count it once (on its high half).
    else if (code < 0xdc00 || code > 0xdfff) other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/**
 * Token usage estimated from the text of a request and its (partial) reply, for replies GMI reported no
 * usage for: a stopped or timed-out stream, a mid-stream failure, or a stream without a usage chunk.
 * GMI still bills the prompt and every generated token, so the budget must count them.
 */
export function estimateUsageFromText(
  prompt: { systemPrompt: string | null; history: ReadonlyArray<{ content: string }> },
  reply: { content: string; reasoning: string | null },
): TokenUsage {
  const texts = prompt.systemPrompt ? [prompt.systemPrompt, ...prompt.history.map((m) => m.content)] : prompt.history.map((m) => m.content);
  const promptTokens = texts.reduce((sum, text) => sum + estimateTokens(text) + MESSAGE_OVERHEAD_TOKENS, 0);
  const reasoningTokens = reply.reasoning ? estimateTokens(reply.reasoning) : null;
  // Like GMI's completion_tokens, the reply count includes the reasoning tokens.
  const completionTokens = estimateTokens(reply.content) + (reasoningTokens ?? 0);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens, cachedTokens: null };
}
