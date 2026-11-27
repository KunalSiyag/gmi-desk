/**
 * OpenAI Responses API on GMI (POST https://api.gmi-serving.com/v1/responses), for models that require it
 * (harness.md DH5). Copied from the chat slice's stream-responses.ts parser and extended with function calls
 * (harness.md §4.2): `response.output_item.added` (type function_call) opens a call, `response.function_call_
 * arguments.delta` streams its arguments, `...arguments.done` / `response.output_item.done` give the final text,
 * and every call is emitted as a `tool_call` part when the response completes.
 */
import { GmiError } from '@shared/contracts/errors';
import { isRecord, parseUsageDetailed, str, streamErrorFrom, ToolCallAssembler, tryParseJson, type StreamParser, type StreamPart } from './common';

function finishFromIncomplete(response: Record<string, unknown>): string {
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
  const reason = str(details.reason);
  return reason === 'max_output_tokens' ? 'length' : (reason ?? 'incomplete');
}

/** The key a function call is tracked by: its output index, else its item id. */
function callKey(json: Record<string, unknown>, item: Record<string, unknown> | null): string | null {
  if (typeof json.output_index === 'number') return `o${json.output_index}`;
  const id = str(json.item_id) ?? (item ? str(item.id) : null);
  return id ? `i${id}` : null;
}

export class ResponsesParser implements StreamParser {
  done = false;
  private model: string | null = null;
  private reasoningSeen = false;
  private reasoningBreak = false;
  private tools = new ToolCallAssembler();
  /** item id → key, for argument events that carry only `item_id`. */
  private keyByItem = new Map<string, string>();

  event(ev: { event: string | null; data: string }): StreamPart[] {
    if (this.done) return [];
    const data = ev.data.trim();
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') this.done = true;
      return [];
    }
    const json = tryParseJson(data);
    if (!isRecord(json)) return ev.event === 'error' ? [{ type: 'error', error: streamErrorFrom(data) }] : [];
    const type = str(json.type) ?? ev.event ?? '';
    const parts: StreamPart[] = [];
    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const model = isRecord(json.response) ? str(json.response.model) : null;
        if (model && model !== this.model) {
          this.model = model;
          parts.push({ type: 'model', model });
        }
        break;
      }
      case 'response.output_text.delta': {
        const delta = str(json.delta);
        if (delta) parts.push({ type: 'content', text: delta });
        break;
      }
      case 'response.reasoning_summary_part.added':
        // Separate consecutive summary parts with a blank line.
        if (this.reasoningSeen) this.reasoningBreak = true;
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = str(json.delta);
        if (delta) {
          parts.push({ type: 'reasoning', text: this.reasoningBreak ? `\n\n${delta}` : delta });
          this.reasoningBreak = false;
          this.reasoningSeen = true;
        }
        break;
      }
      case 'response.output_item.added': {
        const item = isRecord(json.item) ? json.item : null;
        if (item?.type !== 'function_call') break;
        const key = callKey(json, item);
        if (!key) break;
        const itemId = str(item.id);
        if (itemId) this.keyByItem.set(itemId, key);
        const args = typeof item.arguments === 'string' ? item.arguments : '';
        parts.push(this.tools.delta(key, { id: str(item.call_id) ?? itemId, name: str(item.name), argumentsDelta: args }));
        break;
      }
      case 'response.function_call_arguments.delta': {
        const key = this.keyFor(json);
        const delta = typeof json.delta === 'string' ? json.delta : '';
        if (key && delta) parts.push(this.tools.delta(key, { id: null, name: null, argumentsDelta: delta }));
        break;
      }
      case 'response.function_call_arguments.done': {
        const key = this.keyFor(json);
        if (key && typeof json.arguments === 'string') this.tools.finalArguments(key, json.arguments);
        break;
      }
      case 'response.output_item.done': {
        const item = isRecord(json.item) ? json.item : null;
        if (item?.type !== 'function_call') break;
        const key = this.keyFor(json, item);
        if (key && typeof item.arguments === 'string') this.tools.finalArguments(key, item.arguments);
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        this.done = true;
        const response = isRecord(json.response) ? json.response : {};
        parts.push(...this.tools.drain());
        const usage = parseUsageDetailed(response.usage);
        if (usage) parts.push({ type: 'usage', usage: usage.usage, cacheWriteTokens: usage.cacheWriteTokens });
        const finish = type === 'response.completed' ? (this.hadCalls(parts) ? 'tool_calls' : 'stop') : finishFromIncomplete(response);
        parts.push({ type: 'finish', reason: finish });
        break;
      }
      case 'response.failed': {
        this.done = true;
        const response = isRecord(json.response) ? json.response : {};
        parts.push({ type: 'error', error: streamErrorFrom(response.error ?? response, 'The model failed to produce a reply.') });
        break;
      }
      case 'error':
        this.done = true;
        parts.push({ type: 'error', error: streamErrorFrom(json) });
        break;
      default:
        break;
    }
    return parts;
  }

  /** A non-streamed Responses object: output[] items (message content, reasoning summaries, function calls). */
  json(body: unknown): StreamPart[] {
    this.done = true;
    if (!isRecord(body)) throw new GmiError('upstream', 'GMI returned an unexpected response.');
    if (isRecord(body.error)) return [{ type: 'error', error: streamErrorFrom(body.error) }];
    const parts: StreamPart[] = [];
    const model = str(body.model);
    if (model) parts.push({ type: 'model', model });
    const output = Array.isArray(body.output) ? body.output : [];
    for (const [i, item] of output.entries()) {
      if (!isRecord(item)) continue;
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        const text = item.summary
          .map((s) => (isRecord(s) ? (str(s.text) ?? '') : ''))
          .filter(Boolean)
          .join('\n\n');
        if (text) parts.push({ type: 'reasoning', text });
      }
      if (item.type === 'function_call') {
        const args = typeof item.arguments === 'string' ? item.arguments : '';
        parts.push(this.tools.delta(`o${i}`, { id: str(item.call_id) ?? str(item.id), name: str(item.name), argumentsDelta: args }));
      }
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (isRecord(c) && c.type === 'output_text') {
            const text = str(c.text);
            if (text) parts.push({ type: 'content', text });
          }
        }
      }
    }
    if (!parts.some((p) => p.type === 'content')) {
      const text = str(body.output_text);
      if (text) parts.push({ type: 'content', text });
    }
    const calls = this.tools.drain();
    parts.push(...calls);
    const usage = parseUsageDetailed(body.usage);
    if (usage) parts.push({ type: 'usage', usage: usage.usage, cacheWriteTokens: usage.cacheWriteTokens });
    parts.push({ type: 'finish', reason: body.status === 'incomplete' ? finishFromIncomplete(body) : calls.length > 0 ? 'tool_calls' : 'stop' });
    return parts;
  }

  end(): StreamPart[] {
    return [];
  }

  private keyFor(json: Record<string, unknown>, item: Record<string, unknown> | null = null): string | null {
    const itemId = str(json.item_id) ?? (item ? str(item.id) : null);
    if (itemId && this.keyByItem.has(itemId)) return this.keyByItem.get(itemId)!;
    return callKey(json, item);
  }

  private hadCalls(parts: StreamPart[]): boolean {
    return parts.some((p) => p.type === 'tool_call');
  }
}
