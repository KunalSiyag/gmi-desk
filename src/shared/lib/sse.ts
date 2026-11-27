import { GmiError } from '../contracts/errors';

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream rules).
 * Used for chat completions, the Responses API and GMI Router streams.
 */

/**
 * Longest line, and largest event (all its data lines), the parser accepts: 8 Mi characters. The largest
 * legitimate line is a Responses API `response.completed` echoing a maximal reply (about 1-3 M characters).
 * Beyond the limit the stream fails with GmiError('upstream') instead of growing memory without bound.
 */
export const SSE_MAX_LINE_CHARS = 8 * 1024 * 1024;

export interface SseEvent {
  /** `event:` field, or null for the default "message" event. */
  event: string | null;
  data: string;
  id: string | null;
  retry: number | null;
}

export class SseParser {
  /** Pieces of the current, not yet terminated line (joined once the line ends: linear in the line length). */
  private parts: string[] = [];
  private partsChars = 0;
  /** The previous chunk ended with CR: an LF at the start of the next chunk completes that CRLF. */
  private skipLeadingLf = false;
  private dataLines: string[] = [];
  private dataChars = 0;
  private eventName: string | null = null;
  private lastEventId: string | null = null;
  private retry: number | null = null;
  private readonly maxLineChars: number;

  constructor(opts: { maxLineChars?: number } = {}) {
    this.maxLineChars = opts.maxLineChars ?? SSE_MAX_LINE_CHARS;
  }

  /**
   * Feeds a decoded text chunk; returns the events completed by it. Only the new chunk is scanned, so a long
   * line arriving in many chunks costs linear time. Throws GmiError('upstream') past SSE_MAX_LINE_CHARS.
   */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    if (chunk.length === 0) return events;
    let start = 0;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (chunk.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < chunk.length; i += 1) {
      const ch = chunk.charCodeAt(i);
      if (ch !== 10 /* \n */ && ch !== 13 /* \r */) continue;
      const piece = chunk.slice(start, i);
      const line = this.parts.length > 0 ? this.parts.join('') + piece : piece;
      this.parts = [];
      this.partsChars = 0;
      if (ch === 13) {
        if (i + 1 < chunk.length) {
          if (chunk.charCodeAt(i + 1) === 10) i += 1;
        } else {
          this.skipLeadingLf = true;
        }
      }
      start = i + 1;
      this.processLine(line, events);
    }
    if (start < chunk.length) {
      this.parts.push(chunk.slice(start));
      this.partsChars += chunk.length - start;
      if (this.partsChars > this.maxLineChars) {
        this.reset();
        throw tooLarge(this.maxLineChars);
      }
    }
    return events;
  }

  /** Call at end of stream: dispatches a final event that lacked the trailing blank line. */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.parts.length > 0) {
      const rest = this.parts.join('');
      this.parts = [];
      this.partsChars = 0;
      this.processLine(rest, events);
    }
    this.skipLeadingLf = false;
    this.dispatch(events);
    return events;
  }

  private reset(): void {
    this.parts = [];
    this.partsChars = 0;
    this.skipLeadingLf = false;
    this.dataLines = [];
    this.dataChars = 0;
    this.eventName = null;
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataChars += value.length + 1;
        if (this.dataChars > this.maxLineChars) {
          this.reset();
          throw tooLarge(this.maxLineChars);
        }
        this.dataLines.push(value);
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number.parseInt(value, 10);
        break;
      default:
        break;
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (this.dataLines.length === 0) {
      this.eventName = null;
      return;
    }
    events.push({
      event: this.eventName,
      data: this.dataLines.join('\n'),
      id: this.lastEventId,
      retry: this.retry,
    });
    this.dataLines = [];
    this.dataChars = 0;
    this.eventName = null;
  }
}

function tooLarge(limit: number): GmiError {
  return new GmiError('upstream', 'GMI sent a streaming event that is too large to process.', {
    detail: `An event-stream line or event exceeded ${limit} characters.`,
  });
}

/** Reads an SSE byte stream (e.g. `response.body`) as parsed events. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) yield event;
    }
    const tail = decoder.decode();
    if (tail) for (const event of parser.push(tail)) yield event;
    for (const event of parser.flush()) yield event;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
