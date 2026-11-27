/**
 * Metering (harness.md §4.3): prices one upstream attempt and records its spend.
 *
 * - Prices: catalog list prices with long-context tiers chosen by prompt tokens (cached included), cache reads and
 *   cache writes at their own rates, then the org discount.
 * - Usage: measured when GMI sent it; otherwise estimated (`estimated: true`) from main's prompt estimate and the
 *   streamed text whenever GMI answered 2xx, or as a prompt-only charge for a maybe-billed attempt. Estimated usage
 *   never assumes cached tokens (worst case).
 * - Recording: agent purposes → ThreadLedger.add (synchronous, so budgets see it at once); `probe` / `eval` and a
 *   thread-less agent request → BudgetGuard.record kind 'agent'; `chat` → BudgetGuard.record kind 'chat' with
 *   ref = the request id (the chat message id), before the attempt's reservation is released, so the spend is
 *   never uncounted in between (the chat slice records a row itself only when the gateway priced nothing).
 */
import type { LlmPricing } from '@shared/contracts/catalog';
import type { TokenUsage } from '@shared/contracts/chat';
import { estimateTokenCostUsd, type PerMTokPricing } from '@shared/lib/money';
import type { Logger } from '../../core/logger';
import type { BudgetGuard } from '../../core/services';
import { AGENT_PURPOSES, type Estimator, type GatewayClock, type Meter, type MeterInput, type MeteredUsage, type ThreadLedger } from './types';

/** Prices that apply to a request with `promptTokens` prompt tokens (cached included), cache-write rate included. */
export function pricesForPrompt(pricing: LlmPricing | null | undefined, promptTokens: number): PerMTokPricing | null {
  if (!pricing || pricing.inputPerMTok === null || pricing.outputPerMTok === null) return null;
  let tier: NonNullable<LlmPricing['tiers']>[number] | null = null;
  for (const t of pricing.tiers ?? []) {
    if (!Number.isFinite(t.minPromptTokens) || t.minPromptTokens <= 0 || promptTokens < t.minPromptTokens) continue;
    if (!tier || t.minPromptTokens >= tier.minPromptTokens) tier = t;
  }
  return {
    inputPerMTok: tier?.inputPerMTok ?? pricing.inputPerMTok,
    outputPerMTok: tier?.outputPerMTok ?? pricing.outputPerMTok,
    cacheReadPerMTok: tier?.cacheReadPerMTok ?? pricing.cacheReadPerMTok,
    cacheWritePerMTok: tier?.cacheWritePerMTok ?? pricing.cacheWritePerMTok,
  };
}

/** Discount as a usable fraction (null / NaN → 0, clamped to 0..1). */
export function discountFraction(discount: number | null | undefined): number {
  if (discount === null || discount === undefined || !Number.isFinite(discount)) return 0;
  return Math.min(1, Math.max(0, discount));
}

/** Measured-usage window for the cache-hit ratio. */
const CACHE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CACHE_SAMPLES_MAX = 50_000;

export interface MeterDeps {
  threads: Pick<ThreadLedger, 'add'>;
  budget: Pick<BudgetGuard, 'record'>;
  estimator: Pick<Estimator, 'textTokens'>;
  clock: Pick<GatewayClock, 'now'>;
  log?: Logger;
}

export function createMeter(deps: MeterDeps): Meter {
  const { threads, budget, estimator, clock, log } = deps;
  /** (at, prompt, cached) of measured requests, oldest first. */
  const samples: Array<{ at: number; prompt: number; cached: number }> = [];

  const price: Meter['price'] = (usage, cacheWriteTokens, pricing, discount) => {
    const prompt = nonNegative(usage.promptTokens);
    const prices = pricesForPrompt(pricing, prompt);
    if (!prices) return null;
    return estimateTokenCostUsd(
      { promptTokens: prompt, completionTokens: nonNegative(usage.completionTokens), cachedTokens: usage.cachedTokens ?? null, cacheWriteTokens: cacheWriteTokens ?? null },
      prices,
      discountFraction(discount),
    );
  };

  const prune = (now: number) => {
    let drop = 0;
    while (drop < samples.length && now - samples[drop]!.at > CACHE_WINDOW_MS) drop += 1;
    if (samples.length - drop > CACHE_SAMPLES_MAX) drop = samples.length - CACHE_SAMPLES_MAX;
    if (drop > 0) samples.splice(0, drop);
  };

  const record = (input: MeterInput, result: MeteredUsage) => {
    const usd = result.costUsd;
    const modelId = input.model ?? 'unknown';
    if (usd === null) {
      if (input.purpose !== 'chat') log?.warn('gateway: no price for a billed request; its spend is not counted', { requestId: input.requestId, model: modelId });
      return;
    }
    if (!(usd > 0)) return;
    if (input.purpose === 'chat') {
      budget.record({ kind: 'chat', modelId, usd, ref: input.requestId }).catch((error: unknown) => {
        log?.error('gateway: could not record chat spend', { requestId: input.requestId, error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (AGENT_PURPOSES.includes(input.purpose) && input.scope.threadId) {
      threads.add({ threadId: input.scope.threadId, turnId: input.scope.turnId, modelId, usd, at: clock.now() });
      return;
    }
    // probe / eval, or an agent purpose without a thread: one ledger row now (the ledger updates memory synchronously).
    const prefix = input.purpose === 'probe' || input.purpose === 'eval' ? input.purpose : 'req';
    budget.record({ kind: 'agent', modelId, usd, ref: `${prefix}:${input.requestId}` }).catch((error: unknown) => {
      log?.error('gateway: could not record spend', { requestId: input.requestId, error: error instanceof Error ? error.message : String(error) });
    });
  };

  return {
    price,
    charge(input) {
      let result: MeteredUsage | null = null;
      if (input.usage) {
        const usage = cleanUsage(input.usage);
        result = {
          usage,
          cacheWriteTokens: input.cacheWriteTokens,
          costUsd: price(usage, input.cacheWriteTokens, input.pricing, input.discount),
          estimated: false,
          maybeBilled: input.maybeBilled,
        };
        if (usage.promptTokens > 0) {
          const now = clock.now();
          prune(now);
          samples.push({ at: now, prompt: usage.promptTokens, cached: Math.min(usage.promptTokens, usage.cachedTokens ?? 0) });
        }
      } else if (input.responded || input.maybeBilled) {
        // GMI answered 2xx (the prompt is billed whatever streamed), or may have billed the prompt (§4.3).
        const prompt = nonNegative(input.estimate.promptTokens);
        const reasoning = input.responded && input.output.reasoning ? estimator.textTokens(input.output.reasoning) : 0;
        const completion = input.responded ? estimator.textTokens(input.output.text) + estimator.textTokens(input.output.toolArguments) + reasoning : 0;
        const usage: TokenUsage = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, reasoningTokens: reasoning > 0 ? reasoning : null, cachedTokens: null };
        result = { usage, cacheWriteTokens: null, costUsd: price(usage, null, input.pricing, input.discount), estimated: true, maybeBilled: input.maybeBilled };
      }
      if (result) record(input, result);
      return result;
    },
    cacheHitRatio24h() {
      prune(clock.now());
      let prompt = 0;
      let cached = 0;
      for (const s of samples) {
        prompt += s.prompt;
        cached += s.cached;
      }
      return prompt > 0 ? cached / prompt : null;
    },
  };
}

function nonNegative(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Usage with every count finite and non-negative (GMI's numbers are untrusted input). */
function cleanUsage(u: TokenUsage): TokenUsage {
  const promptTokens = nonNegative(u.promptTokens);
  const completionTokens = nonNegative(u.completionTokens);
  const opt = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
  return {
    promptTokens,
    completionTokens,
    totalTokens: opt(u.totalTokens) ?? promptTokens + completionTokens,
    reasoningTokens: opt(u.reasoningTokens),
    cachedTokens: opt(u.cachedTokens),
  };
}
