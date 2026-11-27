/**
 * Token accounting in the host (harness.md §7.2). The host's numbers drive only the compaction triggers and the
 * meter; main keeps its own calibrated estimate for reservations (§4.4), so nothing here is trusted for money.
 *
 * - Estimator: 4 ASCII characters ≈ 1 token, other characters 1 each (chat's `estimateTokens` rule), cached per
 *   message id.
 * - Calibration: a per-(thread, model) factor k (EMA α 0.3) = measured prompt_tokens / estimated, clamped 0.5–2.5.
 * - Size before a request: S = lastMeasuredPrompt + k·est(messages since then).
 */
import type { GwMessage, GwToolDef } from '@shared/contracts/gateway';

export const TOKENS = {
  emaAlpha: 0.3,
  kMin: 0.5,
  kMax: 2.5,
  /** Per-message framing overhead (role, separators). */
  messageOverhead: 4,
  /** Per-tool-call framing overhead (id, type, name wrapper). */
  callOverhead: 8,
} as const;

/** Rough token count, on the high side (same rule as the chat slice's estimateTokens). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii += 1;
    // A surrogate pair is one character: count it once (on its high half).
    else if (code < 0xdc00 || code > 0xdfff) other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

function contentText(content: GwMessage['content']): string {
  return typeof content === 'string' ? content : content.map((p) => p.text).join('');
}

/** Uncalibrated tokens of one wire message (content, tool calls, replayed reasoning). */
export function estimateMessage(m: GwMessage): number {
  let n = TOKENS.messageOverhead + estimateTokens(contentText(m.content));
  for (const c of m.toolCalls ?? []) n += TOKENS.callOverhead + estimateTokens(c.name) + estimateTokens(c.arguments) + estimateTokens(c.id);
  if (m.toolCallId) n += estimateTokens(m.toolCallId);
  if (m.reasoning?.text) n += estimateTokens(m.reasoning.text);
  return n;
}

/** Uncalibrated tokens of the tool block (serialised definitions). */
export function estimateTools(tools: readonly GwToolDef[]): number {
  let n = 0;
  for (const t of tools) n += TOKENS.callOverhead + estimateTokens(t.name) + estimateTokens(t.description) + estimateTokens(JSON.stringify(t.parameters));
  return n;
}

/** Message-estimate cache by message id (§20: the context build stays < 50 ms for a 200k-token thread). */
export class EstimateCache {
  private readonly byId = new Map<string, number>();
  get(id: string, m: GwMessage): number {
    let n = this.byId.get(id);
    if (n === undefined) {
      n = estimateMessage(m);
      this.byId.set(id, n);
    }
    return n;
  }
  forget(id: string): void {
    this.byId.delete(id);
  }
  get size(): number {
    return this.byId.size;
  }
}

/** Calibration factor k per (thread, model). */
export class Calibration {
  private readonly k = new Map<string, number>();
  private key(threadId: string, model: string): string {
    return `${threadId}\0${model}`;
  }
  get(threadId: string, model: string): number {
    return this.k.get(this.key(threadId, model)) ?? 1;
  }
  /** Learns from one measured request. Ignores unusable samples (no estimate, no or estimated usage). */
  observe(threadId: string, model: string, measuredPrompt: number, estimatedPrompt: number): number {
    const cur = this.get(threadId, model);
    if (!(estimatedPrompt > 0) || !(measuredPrompt > 0)) return cur;
    const sample = clamp(measuredPrompt / estimatedPrompt, TOKENS.kMin, TOKENS.kMax);
    const next = clamp(cur + TOKENS.emaAlpha * (sample - cur), TOKENS.kMin, TOKENS.kMax);
    this.k.set(this.key(threadId, model), next);
    return next;
  }
  forgetThread(threadId: string): void {
    for (const key of [...this.k.keys()]) if (key.startsWith(`${threadId}\0`)) this.k.delete(key);
  }
}

/**
 * S = lastMeasuredPrompt + k·est(messages since then), per context. The baseline is dropped when the in-context
 * set changed under it (compaction) or the prefix changed (new tools / instructions at a turn boundary).
 */
export interface SizeBaseline {
  measuredPrompt: number;
  /** Highest message ord the measured request contained. */
  uptoOrd: number;
  prefixHash: string;
  /** Number of compactions of the context when measured. */
  compactions: number;
}

export interface SizeInput {
  baseline: SizeBaseline | null;
  prefixHash: string;
  compactions: number;
  k: number;
  /** Uncalibrated tokens of the prefix ([system] + [tools] + [user#0]). */
  prefixTokens: number;
  /** In-context messages with their ord and uncalibrated estimate. */
  messages: ReadonlyArray<{ ord: number; est: number }>;
}

export function sizeEstimate(input: SizeInput): { tokens: number; estimated: boolean } {
  const b = input.baseline;
  if (b && b.prefixHash === input.prefixHash && b.compactions === input.compactions) {
    let since = 0;
    for (const m of input.messages) if (m.ord > b.uptoOrd) since += m.est;
    return { tokens: Math.ceil(b.measuredPrompt + input.k * since), estimated: since > 0 };
  }
  let all = input.prefixTokens;
  for (const m of input.messages) all += m.est;
  return { tokens: Math.ceil(input.k * all), estimated: true };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
