/**
 * Main's own request estimate (harness.md §4.4, §7.2). The protocol carries no host-supplied token counts.
 *
 * - P: the calibrated token estimate of what the body will carry (tools + messages). Assistant reasoning is counted
 *   on every assistant message (the worst case for families that replay it); calibration per (thread, model) learns
 *   the real ratio from measured usage (EMA α 0.3, clamped 0.5–2.5).
 * - Reservation (worst case): (Pr × in + maxOut × out) × (1 − discount) at the tier Pr selects, cached counted as 0.
 *   Pr is a conservative prompt, separate from the display P: max(the prompt at 2.5 ASCII characters per token
 *   (code and JSON tokenise at about 2.5–3), raw × max(1, k)), where k is the thread's calibration, or for a thread
 *   with none yet the model's (all threads). Calibration can only raise a reservation, never lower it.
 * - Display estimate: C = the tokens of the longest common unit prefix with the previous request of the same
 *   (thread, model) within the cache TTL (0 otherwise), priced at the cache-read rate; output at maxOut, so the
 *   display never exceeds the reservation. The per-unit hash chain follows the `tool_loop` replay rule (reasoning
 *   is part of the bytes only on assistant messages after the last user message), so a new user turn, which drops
 *   earlier reasoning, shortens the common prefix as it does upstream.
 */
import { createHash } from 'node:crypto';
import type { GatewayScope, GwMessage, GwToolDef } from '@shared/contracts/gateway';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import { discountFraction, pricesForPrompt } from './meter';
import { GATEWAY_LIMITS, type EstimateInput, type Estimator, type GatewayClock, type GatewayEstimate, type PrefixFingerprint } from './types';

/** Role markers and separators every chat message adds (the chat slice's MESSAGE_OVERHEAD_TOKENS). */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Per tool call: id, type and the function wrapper. */
const TOOL_CALL_OVERHEAD_TOKENS = 8;
/** ASCII characters per token for the reservation's conservative prompt. */
const RESERVE_ASCII_CHARS_PER_TOKEN = 2.5;

/** Tokens of `text` for a reservation: 2.5 ASCII characters per token, 1 per other character. */
export function worstCaseTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (code < 0xdc00 || code > 0xdfff) other++;
  }
  return Math.ceil(ascii / RESERVE_ASCII_CHARS_PER_TOKEN) + other;
}

/** Calibration and prefix memories are bounded (least recently used go first). */
const MAX_KEYS = 2_000;

/**
 * Tokens of `text`, on the high side: 4 ASCII characters per token and 1 per other character (a surrogate pair
 * counts once). The same rule as the chat slice's estimateTokens.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (code < 0xdc00 || code > 0xdfff) other++;
  }
  return Math.ceil(ascii / 4) + other;
}

function contentText(content: GwMessage['content']): string {
  if (typeof content === 'string') return content;
  let out = '';
  for (const part of content) if (part && typeof part.text === 'string') out += part.text;
  return out;
}

interface Unit {
  /** Serialised bytes as they affect the upstream prefix. */
  key: string;
  /** Uncalibrated tokens (worst case). */
  tokens: number;
  /** Conservative tokens for the reservation (worstCaseTextTokens). */
  reserveTokens: number;
}

function toolUnit(tool: GwToolDef): Unit {
  const key = JSON.stringify(['tool', tool.name, tool.description, tool.parameters ?? null]);
  return { key, tokens: estimateTextTokens(key), reserveTokens: worstCaseTextTokens(key) };
}

function messageUnit(m: GwMessage, replayReasoning: boolean): Unit {
  const text = contentText(m.content);
  const calls = m.toolCalls ?? [];
  const reasoning = m.role === 'assistant' && m.reasoning && typeof m.reasoning.text === 'string' ? m.reasoning.text : '';
  const count = (fn: (t: string) => number) => {
    let n = MESSAGE_OVERHEAD_TOKENS + fn(text) + fn(reasoning);
    for (const c of calls) n += TOOL_CALL_OVERHEAD_TOKENS + fn(`${c.id}${c.name}${c.arguments}`);
    if (m.toolCallId) n += fn(m.toolCallId);
    if (m.name) n += fn(m.name);
    return n;
  };
  const tokens = count(estimateTextTokens);
  const reserveTokens = count(worstCaseTextTokens);
  const key = JSON.stringify([
    m.role,
    text,
    calls.length > 0 ? calls.map((c) => [c.id, c.name, c.arguments]) : null,
    m.toolCallId ?? null,
    m.name ?? null,
    replayReasoning && reasoning ? reasoning : null,
  ]);
  return { key, tokens, reserveTokens };
}

function unitsOf(messages: readonly GwMessage[], tools?: readonly GwToolDef[] | null): Unit[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  const units: Unit[] = [];
  for (const t of tools ?? []) units.push(toolUnit(t));
  messages.forEach((m, i) => units.push(messageUnit(m, i > lastUser)));
  return units;
}

/** The conservative (reservation) prompt tokens of a request, uncalibrated. */
export function worstCasePromptTokens(messages: readonly GwMessage[], tools?: readonly GwToolDef[] | null): number {
  let sum = 0;
  for (const u of unitsOf(messages, tools)) sum += u.reserveTokens;
  return sum;
}

/** The per-unit hash chain of a request (tools first, then messages) and the uncalibrated cumulative tokens. */
export function fingerprint(messages: readonly GwMessage[], tools?: readonly GwToolDef[] | null): PrefixFingerprint {
  return fingerprintOf(unitsOf(messages, tools));
}

function fingerprintOf(units: readonly Unit[]): PrefixFingerprint {
  const hashes: string[] = [];
  const tokens: number[] = [];
  let prev = '';
  let sum = 0;
  for (const u of units) {
    prev = createHash('sha256').update(prev).update('\u0000').update(u.key).digest('base64');
    sum += u.tokens;
    hashes.push(prev);
    tokens.push(sum);
  }
  return { hashes, tokens };
}

/** Number of leading units two fingerprints share. */
export function commonUnits(a: PrefixFingerprint, b: PrefixFingerprint): number {
  const n = Math.min(a.hashes.length, b.hashes.length);
  // The chain is cumulative: the last equal hash marks the common prefix (binary search on a monotone predicate).
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a.hashes[mid - 1] === b.hashes[mid - 1]) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The compaction ceiling main assumes for a thread (§7.4): W = min(context, maxContextTokens) (unknown context →
 * 128k), reserve R = max(0.15·W, 16,384) + maxOut, C = W − R. At the defaults: 160,000 − (24,000 + 16,384).
 */
export function contextCeilingTokens(opts: { contextLength: number | null; maxContextTokens?: number | null; maxOutputTokens?: number }): number {
  const context = opts.contextLength && opts.contextLength > 0 ? opts.contextLength : 128_000;
  const max = opts.maxContextTokens === undefined ? CODE_DEFAULTS.maxContextTokens : opts.maxContextTokens;
  const window = max === null ? context : Math.min(context, max);
  const maxOut = opts.maxOutputTokens ?? CODE_DEFAULTS.maxOutputTokens;
  return Math.max(0, window - (Math.max(0.15 * window, 16_384) + maxOut));
}

const scopeKey = (scope: GatewayScope, modelKey: string) => `${scope.threadId ?? '-'}\u0000${modelKey}`;

function touch<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEYS) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

export interface EstimatorDeps {
  clock: Pick<GatewayClock, 'now'>;
}

export function createEstimator(deps: EstimatorDeps): Estimator {
  const { clock } = deps;
  const calibration = new Map<string, number>();
  /** Per model over all threads: the seed for a thread's reservation before it has its own calibration. */
  const modelCalibration = new Map<string, number>();
  const previous = new Map<string, { prefix: PrefixFingerprint; at: number }>();

  return {
    textTokens: estimateTextTokens,

    estimate(input: EstimateInput): GatewayEstimate {
      const units = unitsOf(input.messages, input.tools);
      const prefix = fingerprintOf(units);
      const raw = prefix.tokens.at(-1) ?? 0;
      const key = scopeKey(input.scope, input.resolved.modelKey);
      const threadK = calibration.get(key);
      const k = threadK ?? 1;
      const promptTokens = Math.max(1, Math.ceil(raw * k));
      let worstRaw = 0;
      for (const u of units) worstRaw += u.reserveTokens;
      const reserveK = Math.max(1, threadK ?? modelCalibration.get(input.resolved.modelKey) ?? 1);
      const reservePromptTokens = Math.max(promptTokens, worstRaw, Math.ceil(raw * reserveK));
      const maxOutputTokens = Math.max(0, Math.floor(input.resolved.maxOutputTokens));

      let expectedCachedTokens = 0;
      const prev = previous.get(key);
      if (prev && clock.now() - prev.at <= GATEWAY_LIMITS.cacheTtlMs) {
        const shared = commonUnits(prev.prefix, prefix);
        if (shared > 0) expectedCachedTokens = Math.min(promptTokens, Math.ceil((prefix.tokens[shared - 1] ?? 0) * k));
      }

      let reserveUsd: number | null = null;
      let expectedUsd: number | null = null;
      const prices = pricesForPrompt(input.resolved.pricing, promptTokens);
      const reservePrices = pricesForPrompt(input.resolved.pricing, reservePromptTokens);
      if (prices && reservePrices && prices.inputPerMTok !== null && prices.outputPerMTok !== null && reservePrices.inputPerMTok !== null && reservePrices.outputPerMTok !== null) {
        const keep = 1 - discountFraction(input.resolved.discount);
        const out = maxOutputTokens * prices.outputPerMTok;
        reserveUsd = ((reservePromptTokens * reservePrices.inputPerMTok + maxOutputTokens * reservePrices.outputPerMTok) / 1e6) * keep;
        const read = prices.cacheReadPerMTok ?? prices.inputPerMTok;
        expectedUsd = (((promptTokens - expectedCachedTokens) * prices.inputPerMTok + expectedCachedTokens * read + out) / 1e6) * keep;
        if (input.purpose === 'probe') reserveUsd = Math.min(reserveUsd, GATEWAY_LIMITS.probeReserveCapUsd);
        expectedUsd = Math.min(expectedUsd, reserveUsd);
      }

      return { promptTokens, maxOutputTokens, expectedCachedTokens, reserveUsd, expectedUsd, tpmTokens: promptTokens + maxOutputTokens, prefix };
    },

    commit(scope, modelKey, prefix, at) {
      touch(previous, scopeKey(scope, modelKey), { prefix, at });
    },

    observe(scope, modelKey, estimatedPromptTokens, measuredPromptTokens) {
      if (!(estimatedPromptTokens > 0) || !(measuredPromptTokens > 0) || !Number.isFinite(measuredPromptTokens)) return;
      const key = scopeKey(scope, modelKey);
      const k = calibration.get(key) ?? 1;
      // estimated = raw × k, so measured / raw = k × measured / estimated.
      const target = k * (measuredPromptTokens / estimatedPromptTokens);
      const a = GATEWAY_LIMITS.calibrationAlpha;
      const clamp = (v: number) => Math.min(GATEWAY_LIMITS.calibrationMax, Math.max(GATEWAY_LIMITS.calibrationMin, v));
      touch(calibration, key, clamp((1 - a) * k + a * target));
      const mk = modelCalibration.get(modelKey);
      touch(modelCalibration, modelKey, clamp(mk === undefined ? target : (1 - a) * mk + a * target));
    },
  };
}
