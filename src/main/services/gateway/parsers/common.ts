/**
 * Stream parsing shared by every API family (harness.md §4.2 "Parsers"). Copied from the chat slice's
 * stream-common.ts (H1-A; chat's original stays until H1-C switches chat to the gateway) and extended with:
 *  - tool-call parts (`tool_call_delta`, `tool_call`),
 *  - cache-write usage (`prompt_tokens_details.cache_creation_tokens`, `cache_creation_input_tokens`, `[U]`),
 *  - context-overflow errors inside a stream mapped to `context_overflow` (not `invalid_input`),
 *  - an `onChunk` hook per body chunk (the gateway's first-byte and idle watchdogs).
 */
import type { RoutingInfo, TokenUsage } from '@shared/contracts/chat';
import type { GwToolCall } from '@shared/contracts/gateway';
import { GmiError, type GmiErrorCode } from '@shared/contracts/errors';
import { readSse } from '@shared/lib/sse';
import { codeForStatus } from '../../../core/http';

/** One normalised piece of a streamed reply, whatever API produced it. */
export type StreamPart =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  /** The model the API says it used (chunk `model` field). */
  | { type: 'model'; model: string }
  /** GMI Router's choice (provisional from the first chunk, then the full routing_metadata). */
  | { type: 'routing'; routing: RoutingInfo }
  /** A piece of a tool call; `index` is the call's slot in this reply (0-based, dense). */
  | { type: 'tool_call_delta'; index: number; id: string | null; name: string | null; argumentsDelta: string }
  /** A complete tool call, emitted once the reply finished (finish_reason / response.completed / [DONE]). */
  | { type: 'tool_call'; call: GwToolCall }
  | { type: 'usage'; usage: TokenUsage; cacheWriteTokens: number | null }
  | { type: 'finish'; reason: string }
  /** An error reported inside the stream (the HTTP status was 2xx). */
  | { type: 'error'; error: GmiError };

/** Parses the events of one streaming API into StreamParts. */
export interface StreamParser {
  /** True once the API signalled the end of the reply ([DONE], response.completed...). */
  readonly done: boolean;
  /** One SSE event. */
  event(ev: { event: string | null; data: string }): StreamPart[];
  /** A whole non-streamed JSON body (servers that ignore `stream: true`). */
  json(body: unknown): StreamPart[];
  /** End of input: flushes anything buffered (e.g. a partial think tag). */
  end(): StreamPart[];
}

/** What reading a body needs from the attempt that owns it. */
export interface StreamReadContext {
  signal: AbortSignal;
  /** Called for every chunk of body bytes (first-byte and idle watchdogs). */
  onChunk(): void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const count = (value: number | null): number | null => (value === null ? null : Math.max(0, Math.round(value)));

/**
 * Token usage from either API's shape:
 * chat completions {prompt_tokens, completion_tokens, total_tokens, completion_tokens_details.reasoning_tokens,
 * prompt_tokens_details.cached_tokens} or Responses {input_tokens, output_tokens, output_tokens_details...}.
 */
export function parseUsage(raw: unknown): TokenUsage | null {
  return parseUsageDetailed(raw)?.usage ?? null;
}

/** parseUsage plus the cache-write count, where the server reports one (`[U]` for GMI, harness.md §4.2). */
export function parseUsageDetailed(raw: unknown): { usage: TokenUsage; cacheWriteTokens: number | null } | null {
  if (!isRecord(raw)) return null;
  const prompt = num(raw.prompt_tokens) ?? num(raw.input_tokens);
  const completion = num(raw.completion_tokens) ?? num(raw.output_tokens);
  if (prompt === null && completion === null) return null;
  const completionDetails = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : isRecord(raw.output_tokens_details)
      ? raw.output_tokens_details
      : {};
  const promptDetails = isRecord(raw.prompt_tokens_details)
    ? raw.prompt_tokens_details
    : isRecord(raw.input_tokens_details)
      ? raw.input_tokens_details
      : {};
  const promptTokens = Math.max(0, Math.round(prompt ?? 0));
  const completionTokens = Math.max(0, Math.round(completion ?? 0));
  const reasoning = num(completionDetails.reasoning_tokens) ?? num(raw.reasoning_tokens);
  // DeepSeek-style servers report cache hits as prompt_cache_hit_tokens.
  const cached = num(promptDetails.cached_tokens) ?? num(raw.cached_tokens) ?? num(raw.prompt_cache_hit_tokens);
  const cacheWrite =
    num(promptDetails.cache_creation_tokens) ??
    num(promptDetails.cache_write_tokens) ??
    num(raw.cache_creation_input_tokens) ??
    num(raw.cache_creation_tokens);
  return {
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: Math.max(0, Math.round(num(raw.total_tokens) ?? promptTokens + completionTokens)),
      reasoningTokens: count(reasoning),
      cachedTokens: count(cached),
    },
    cacheWriteTokens: count(cacheWrite),
  };
}

/** GMI Router routing_metadata (snake_case per the docs; camelCase accepted too). */
export function parseRouting(raw: unknown, fallback: Partial<RoutingInfo> = {}): RoutingInfo | null {
  if (!isRecord(raw)) return null;
  const selected = str(raw.selected_model) ?? str(raw.selectedModel) ?? str(raw.model) ?? fallback.selectedModel ?? null;
  if (!selected) return null;
  const fallbacks = raw.fallback_models ?? raw.fallbackModels;
  return {
    selectedModel: selected,
    taskType: str(raw.task_type) ?? str(raw.taskType) ?? fallback.taskType ?? null,
    mode: str(raw.selected_mode) ?? str(raw.selectedMode) ?? str(raw.mode) ?? fallback.mode ?? null,
    fallbackModels: Array.isArray(fallbacks)
      ? fallbacks.filter((m): m is string => typeof m === 'string' && m.length > 0)
      : (fallback.fallbackModels ?? []),
    recommendationId: str(raw.recommendation_id) ?? str(raw.recommendationId) ?? fallback.recommendationId ?? null,
  };
}

/** Provider texts for "the prompt does not fit the context window" (harness.md §4.6). */
/**
 * Text of a context-overflow error. The request parameter `context_length_exceeded_behavior` is excluded: GMI names
 * it when a family rejects the parameter (400 unsupported_parameter), which is not an overflow.
 */
export const CONTEXT_OVERFLOW_PATTERN = /context[\s_-]?length(?![\s_-]?exceeded[\s_-]?behavior)|maximum context|context[\s_-]?window|too many tokens|prompt is too long/i;

/** The request parameter that makes GMI report an overflow instead of truncating (DH6). */
export const CTX_EXCEEDED_PARAM = 'context_length_exceeded_behavior';

const DEFAULT_STREAM_ERROR = 'GMI reported an error while generating the reply.';

/**
 * An error reported inside a 2xx stream (or an error body): `{error:{message,code,type}}`, `{message}`, a
 * Responses `response.failed` error object, or plain text. Maps HTTP-like codes and well-known types to
 * GmiError codes; context-length errors become `context_overflow`.
 */
export function streamErrorFrom(raw: unknown, fallbackMessage = DEFAULT_STREAM_ERROR): GmiError {
  if (typeof raw === 'string') {
    const parsed = tryParseJson(raw);
    if (parsed !== undefined && typeof parsed !== 'string') return streamErrorFrom(parsed, fallbackMessage);
    const text = raw.trim().slice(0, 500) || fallbackMessage;
    return new GmiError(CONTEXT_OVERFLOW_PATTERN.test(text) ? 'context_overflow' : 'upstream', text);
  }
  if (!isRecord(raw)) return new GmiError('upstream', fallbackMessage);
  const inner = isRecord(raw.error) ? raw.error : raw;
  let message = str(inner.message) ?? str(raw.message) ?? (typeof raw.error === 'string' ? raw.error : null) ?? fallbackMessage;
  // GMI's backend errors wrap the provider's message: {error:{message:"Backend request failed…", details:{error:{message}}}}.
  let detail: string | null = null;
  const details = isRecord(inner.details) ? inner.details : null;
  const nestedError = details && isRecord(details.error) ? details.error : null;
  const nested = nestedError ? str(nestedError.message) : details ? str(details.message) : null;
  if (nested && nested !== message) {
    detail = message;
    message = nested;
  }
  const status = num(inner.status) ?? num(inner.code) ?? num(raw.status) ?? num(raw.code);
  const label = `${String(inner.code ?? '')} ${String(inner.type ?? '')} ${String(nestedError?.code ?? '')} ${String(nestedError?.type ?? '')} ${message}`;
  let code: GmiErrorCode = 'upstream';
  if (CONTEXT_OVERFLOW_PATTERN.test(label)) code = 'context_overflow';
  else if (status !== null && status >= 400 && status < 600) code = codeForStatus(status, 'invalid_api_key');
  else if (/rate[\s_-]?limit|too many requests/i.test(label)) code = 'rate_limited';
  else if (/insufficient[\s_-]?(balance|quota|funds|credit)|payment[\s_-]?required/i.test(label)) code = 'payment_required';
  else if (/invalid[\s_-]?request/i.test(label)) code = 'invalid_input';
  return new GmiError(code, message.slice(0, 1000), { detail, status: status !== null && status >= 400 && status < 600 ? status : null });
}

/** GMI's own error code / type in an error body (`unsupported_parameter`, `backend_error`…), or null. */
export function upstreamErrorCode(raw: unknown): string | null {
  const body = typeof raw === 'string' ? tryParseJson(raw) : raw;
  if (!isRecord(body)) return null;
  const inner = isRecord(body.error) ? body.error : body;
  const details = isRecord(inner.details) ? inner.details : null;
  const nested = details && isRecord(details.error) ? details.error : null;
  for (const v of [nested?.code, nested?.type, inner.code, inner.type]) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 100);
  }
  return null;
}

/** The parameter GMI's error body names (`param`, also inside the wrapped `details.error`), or null. */
export function upstreamErrorParam(raw: unknown): string | null {
  const body = typeof raw === 'string' ? tryParseJson(raw) : raw;
  if (!isRecord(body)) return null;
  const inner = isRecord(body.error) ? body.error : body;
  const details = isRecord(inner.details) ? inner.details : null;
  const nested = details && isRecord(details.error) ? details.error : null;
  for (const v of [nested?.param, inner.param]) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 100);
  }
  return null;
}

/** Raw text kept (until the first SSE event) to recognise a JSON document sent without a JSON content type. */
const MAX_UNTYPED_JSON_CHARS = 2_000_000;

/**
 * Reads a streaming 2xx response through `parser`. Handles SSE bodies and servers that answer with a single
 * JSON document despite `stream: true` (with or without a JSON content type).
 */
export async function* readStreamParts(res: Response, parser: StreamParser, rc: StreamReadContext): AsyncGenerator<StreamPart> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    const text = await res.text();
    rc.onChunk();
    const body = tryParseJson(text);
    if (body === undefined) throw new GmiError('upstream', 'GMI returned a response that is not valid JSON.', { detail: text.slice(0, 300) });
    yield* parser.json(body);
    yield* parser.end();
    return;
  }
  if (!res.body) throw new GmiError('upstream', 'GMI returned an empty response.');

  // Every chunk resets the idle timeout; the text is kept until the first SSE event arrives.
  let raw: string | null = '';
  const decoder = new TextDecoder();
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        rc.onChunk();
        if (raw !== null) {
          raw += decoder.decode(chunk, { stream: true });
          if (raw.length > MAX_UNTYPED_JSON_CHARS) raw = null;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  let sawEvent = false;
  try {
    for await (const ev of readSse(body, rc.signal)) {
      sawEvent = true;
      raw = null;
      yield* parser.event(ev);
      if (parser.done) break;
    }
  } finally {
    // After [DONE] (or an early exit) close the connection instead of leaving it to GC.
    void body.cancel().catch(() => undefined);
  }
  if (!sawEvent && raw && !rc.signal.aborted) {
    const text = raw.trim();
    const json = text.startsWith('{') ? tryParseJson(text) : undefined;
    if (isRecord(json)) {
      yield* parser.json(json);
      yield* parser.end();
      return;
    }
    if (/<html|<!doctype html/i.test(text.slice(0, 2_000))) {
      throw new GmiError('upstream', 'GMI answered with a web page instead of a reply. Try again in a moment.', { detail: text.slice(0, 300) });
    }
  }
  yield* parser.end();
}

/** Turns a network failure in the middle of a body read into a readable error. */
export function midStreamError(error: unknown): GmiError {
  if (error instanceof GmiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GmiError('network', 'The connection to GMI dropped before the reply finished.', { detail: message, cause: error });
}

/**
 * Accumulates tool calls from deltas, by the provider's index (chat) or output index (Responses). A delta that
 * carries a different id for an index whose call already has an id starts a new call (servers that reuse index 0).
 */
export class ToolCallAssembler {
  private calls: Array<{ id: string | null; name: string; args: string }> = [];
  private slotByKey = new Map<string, number>();

  /** Adds a delta; returns the part to emit (index = dense slot number). */
  delta(key: string | number, d: { id: string | null; name: string | null; argumentsDelta: string }): StreamPart {
    const k = String(key);
    let slot = this.slotByKey.get(k);
    const current = slot === undefined ? undefined : this.calls[slot];
    if (slot === undefined || (current && d.id && current.id && d.id !== current.id)) {
      slot = this.calls.length;
      this.calls.push({ id: null, name: '', args: '' });
      this.slotByKey.set(k, slot);
    }
    const call = this.calls[slot]!;
    if (d.id && !call.id) call.id = d.id;
    if (d.name) call.name = call.name ? call.name : d.name;
    call.args += d.argumentsDelta;
    return { type: 'tool_call_delta', index: slot, id: d.id, name: d.name, argumentsDelta: d.argumentsDelta };
  }

  /** Replaces a call's arguments with the server's final text (Responses `...arguments.done`). */
  finalArguments(key: string | number, args: string): void {
    const slot = this.slotByKey.get(String(key));
    if (slot !== undefined && this.calls[slot]) this.calls[slot]!.args = args;
  }

  get size(): number {
    return this.calls.length;
  }

  /** Every accumulated call as a `tool_call` part, in slot order; the assembler is then empty. */
  drain(): StreamPart[] {
    const out: StreamPart[] = this.calls.map((c, i) => ({ type: 'tool_call', call: { id: c.id ?? `call_${i}`, name: c.name, arguments: c.args } }));
    this.calls = [];
    this.slotByKey.clear();
    return out;
  }
}
