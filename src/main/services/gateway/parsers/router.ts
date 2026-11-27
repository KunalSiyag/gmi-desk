/**
 * GMI Router "autoroute" stream (POST https://console.gmicloud.ai/api/v1/ie/recommendation/autoroute). Copied from
 * the chat slice's stream-router.ts parser (harness.md §4.2, §4.7). Plain chat only: the router ignores tools,
 * temperature and max_tokens. "Chunks are proxied as they arrive, followed by a routing_metadata event, then
 * [DONE]". A mid-stream failure keeps the partial output, sends an error event and closes the stream.
 *
 * The streamed shapes are not fully documented, so this parser accepts:
 *  - OpenAI-style chunks (choices[0].delta.content / reasoning_content; `model` = the routed model)
 *  - `event: routing_metadata` with the metadata as data (or wrapped in {routing_metadata})
 *  - data objects carrying `routing_metadata` next to other fields
 *  - non-stream style objects {model, message:{content}, routing_metadata}
 *  - `event: error` / {error:{message}}
 *  - a plain JSON (non-SSE) response body.
 */
import type { RouterMode } from '@shared/contracts/app';
import type { RoutingInfo } from '@shared/contracts/chat';
import { GmiError } from '@shared/contracts/errors';
import { ChatCompletionsParser } from './chat';
import { isRecord, parseRouting, parseUsageDetailed, str, streamErrorFrom, tryParseJson, type StreamParser, type StreamPart } from './common';

function sameRouting(a: RoutingInfo | null, b: RoutingInfo): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export class RouterStreamParser implements StreamParser {
  done = false;
  routing: RoutingInfo | null = null;
  private chat = new ChatCompletionsParser();

  constructor(private readonly opts: { mode: RouterMode | string | null; recommendationId: string | null }) {}

  event(ev: { event: string | null; data: string }): StreamPart[] {
    if (this.done) return [];
    const name = (ev.event ?? '').toLowerCase();
    const data = ev.data.trim();
    if (!data) return [];
    if (data === '[DONE]') {
      this.done = true;
      return [];
    }
    const json = tryParseJson(data);
    if (name === 'error') {
      this.done = true;
      return [{ type: 'error', error: streamErrorFrom(json === undefined ? data : json) }];
    }
    if (name === 'routing_metadata' || name === 'routing') {
      return this.routingParts(isRecord(json) && isRecord(json.routing_metadata) ? json.routing_metadata : json);
    }
    return isRecord(json) ? this.object(json) : [];
  }

  json(body: unknown): StreamPart[] {
    if (!isRecord(body)) throw new GmiError('upstream', 'GMI Router returned an unexpected response.');
    const parts = this.object(body);
    this.done = true;
    if (!parts.some((p) => p.type === 'error' || p.type === 'finish')) parts.push({ type: 'finish', reason: 'stop' });
    return parts;
  }

  end(): StreamPart[] {
    return this.chat.end();
  }

  private object(json: Record<string, unknown>): StreamPart[] {
    if (json.error !== undefined && json.error !== null) {
      this.done = true;
      return [{ type: 'error', error: streamErrorFrom(json) }];
    }
    const parts: StreamPart[] = [];
    if (isRecord(json.routing_metadata)) parts.push(...this.routingParts(json.routing_metadata));
    else if (json.type === 'routing_metadata' || (str(json.selected_model) && !Array.isArray(json.choices))) parts.push(...this.routingParts(json));

    if (Array.isArray(json.choices)) {
      parts.push(...this.fromChat(this.chat.chunk(json)));
    } else if (isRecord(json.message)) {
      parts.push(
        ...this.fromChat(
          this.chat.chunk({ model: json.model, choices: [{ message: json.message, finish_reason: json.finish_reason ?? null }], usage: json.usage }),
        ),
      );
    } else {
      const usage = parseUsageDetailed(json.usage);
      if (usage) parts.push({ type: 'usage', usage: usage.usage, cacheWriteTokens: usage.cacheWriteTokens });
    }
    return parts;
  }

  /** The routed model shows up in chunk.model before routing_metadata arrives: use it right away. */
  private fromChat(parts: StreamPart[]): StreamPart[] {
    const out: StreamPart[] = [];
    for (const part of parts) {
      if (part.type !== 'model') {
        out.push(part);
        continue;
      }
      if (this.routing || !part.model.includes('/')) continue;
      out.push(...this.routingParts({ selected_model: part.model }));
    }
    return out;
  }

  private routingParts(raw: unknown): StreamPart[] {
    const base: Partial<RoutingInfo> = this.routing ?? { mode: this.opts.mode, recommendationId: this.opts.recommendationId };
    const next = parseRouting(raw, base);
    if (!next || sameRouting(this.routing, next)) return [];
    this.routing = next;
    return [{ type: 'routing', routing: next }];
  }
}
