/**
 * OpenAI-compatible chat completions on GMI (POST https://api.gmi-serving.com/v1/chat/completions). Copied from the
 * chat slice's stream-chat.ts parser and extended with tool calls (harness.md §4.2):
 * chunks carry choices[0].delta.{content, reasoning_content | reasoning, tool_calls[]}, finish_reason, and a final
 * usage chunk (stream_options.include_usage). `<think>` blocks inside content are routed to reasoning.
 * `delta.tool_calls[i]` are accumulated by `index` and emitted as complete `tool_call` parts at the finish.
 */
import { isRecord, parseUsageDetailed, str, streamErrorFrom, ToolCallAssembler, tryParseJson, type StreamParser, type StreamPart } from './common';
import { ThinkTagSplitter } from './think';

/** Parses chat-completion chunks (also the OpenAI-style chunks GMI Router proxies). */
export class ChatCompletionsParser implements StreamParser {
  done = false;
  private think = new ThinkTagSplitter();
  private model: string | null = null;
  private tools = new ToolCallAssembler();

  event(ev: { event: string | null; data: string }): StreamPart[] {
    if (this.done) return [];
    const data = ev.data.trim();
    if (!data) return [];
    if (data === '[DONE]') {
      this.done = true;
      return [];
    }
    if (ev.event === 'error') return [{ type: 'error', error: streamErrorFrom(data) }];
    const json = tryParseJson(data);
    return json === undefined ? [] : this.chunk(json);
  }

  /** One parsed chunk object. */
  chunk(json: unknown): StreamPart[] {
    const parts: StreamPart[] = [];
    if (!isRecord(json)) return parts;
    if (json.error !== undefined && json.error !== null) {
      parts.push({ type: 'error', error: streamErrorFrom(json) });
      return parts;
    }
    const model = str(json.model);
    if (model && model !== this.model) {
      this.model = model;
      parts.push({ type: 'model', model });
    }
    const choice = Array.isArray(json.choices) ? (json.choices[0] as unknown) : undefined;
    if (isRecord(choice)) {
      const streamed = isRecord(choice.delta);
      const delta = streamed ? (choice.delta as Record<string, unknown>) : isRecord(choice.message) ? choice.message : null;
      if (delta) {
        const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
        if (reasoning) parts.push({ type: 'reasoning', text: reasoning });
        const content = str(delta.content);
        if (content) parts.push(...this.splitContent(content));
        if (Array.isArray(delta.tool_calls)) parts.push(...this.toolDeltas(delta.tool_calls));
      }
      const finish = str(choice.finish_reason);
      if (finish) {
        // Text held back by the think splitter belongs before the calls and the finish.
        parts.push(...this.think.end().map((seg): StreamPart => ({ type: seg.channel, text: seg.text })));
        parts.push(...this.tools.drain());
        parts.push({ type: 'finish', reason: finish });
      }
    }
    const usage = parseUsageDetailed(json.usage);
    if (usage) parts.push({ type: 'usage', usage: usage.usage, cacheWriteTokens: usage.cacheWriteTokens });
    return parts;
  }

  /** A non-streamed `chat.completion` object. */
  json(body: unknown): StreamPart[] {
    this.done = true;
    return this.chunk(body);
  }

  /** End of input: held-back think text; after [DONE], calls whose finish chunk never came. */
  end(): StreamPart[] {
    const parts: StreamPart[] = this.think.end().map((seg) => ({ type: seg.channel, text: seg.text }));
    // A cut stream (no [DONE], no finish) leaves its incomplete calls out: they are never complete calls.
    if (this.done) parts.push(...this.tools.drain());
    return parts;
  }

  private splitContent(content: string): StreamPart[] {
    return this.think.push(content).map((seg) => ({ type: seg.channel, text: seg.text }));
  }

  private toolDeltas(raw: unknown[]): StreamPart[] {
    const parts: StreamPart[] = [];
    for (const [position, item] of raw.entries()) {
      if (!isRecord(item)) continue;
      const fn = isRecord(item.function) ? item.function : {};
      const index = typeof item.index === 'number' && Number.isInteger(item.index) ? item.index : position;
      const args = typeof fn.arguments === 'string' ? fn.arguments : isRecord(fn.arguments) ? JSON.stringify(fn.arguments) : '';
      parts.push(this.tools.delta(index, { id: str(item.id), name: str(fn.name), argumentsDelta: args }));
    }
    return parts;
  }
}

/** True when GMI rejected `max_tokens` for this model and wants `max_completion_tokens`. */
export function wantsMaxCompletionTokens(message: string): boolean {
  return /max_completion_tokens/.test(message);
}
