/**
 * Copied from the chat slice's think-parser.ts (harness.md §4.2; H1-C deletes the original after switching chat).
 *
 * Some models (DeepSeek R1 style, Qwen thinking variants served raw...) put their reasoning inside
 * `<think>…</think>` in the normal content stream. This splitter routes that text to the reasoning
 * channel. It is streaming-safe: a tag split across chunks (`<thi` + `nk>`) is held back until it
 * can be decided.
 */
export type ThinkChannel = 'content' | 'reasoning';

export interface ThinkSegment {
  channel: ThinkChannel;
  text: string;
}

const OPEN = '<think>';
const CLOSE = '</think>';

/** Length of the longest proper prefix of `tag` that `text` ends with. */
function partialTagSuffix(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k -= 1) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export class ThinkTagSplitter {
  private inThink = false;
  private pending = '';
  /** Drop whitespace right after `<think>` / `</think>` (models put newlines there). */
  private trimReasoning = false;
  private trimContent = false;

  push(text: string): ThinkSegment[] {
    const out: ThinkSegment[] = [];
    let buf = this.pending + text;
    this.pending = '';
    for (;;) {
      if (this.inThink) {
        const idx = buf.indexOf(CLOSE);
        if (idx >= 0) {
          this.emit(out, buf.slice(0, idx));
          buf = buf.slice(idx + CLOSE.length);
          this.inThink = false;
          this.trimContent = true;
          continue;
        }
        const keep = partialTagSuffix(buf, CLOSE);
        this.emit(out, buf.slice(0, buf.length - keep));
        this.pending = buf.slice(buf.length - keep);
        break;
      }
      const open = buf.indexOf(OPEN);
      const stray = buf.indexOf(CLOSE);
      if (stray >= 0 && (open < 0 || stray < open)) {
        // A closing tag without an opening one: drop the tag, keep the text as content.
        this.emit(out, buf.slice(0, stray));
        buf = buf.slice(stray + CLOSE.length);
        continue;
      }
      if (open >= 0) {
        this.emit(out, buf.slice(0, open));
        buf = buf.slice(open + OPEN.length);
        this.inThink = true;
        this.trimReasoning = true;
        continue;
      }
      const keep = Math.max(partialTagSuffix(buf, OPEN), partialTagSuffix(buf, CLOSE));
      this.emit(out, buf.slice(0, buf.length - keep));
      this.pending = buf.slice(buf.length - keep);
      break;
    }
    return mergeSegments(out);
  }

  /** End of stream: whatever was held back is plain text of the current channel. */
  end(): ThinkSegment[] {
    const out: ThinkSegment[] = [];
    this.emit(out, this.pending);
    this.pending = '';
    return out;
  }

  private emit(out: ThinkSegment[], raw: string): void {
    let text = raw;
    if (!text) return;
    const channel: ThinkChannel = this.inThink ? 'reasoning' : 'content';
    if (channel === 'reasoning' && this.trimReasoning) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      this.trimReasoning = false;
    } else if (channel === 'content' && this.trimContent) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      this.trimContent = false;
    }
    out.push({ channel, text });
  }
}

function mergeSegments(segments: ThinkSegment[]): ThinkSegment[] {
  const out: ThinkSegment[] = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.channel === seg.channel) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}
