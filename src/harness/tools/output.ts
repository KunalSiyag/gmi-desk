/**
 * Output truncation and spill (harness.md §7.3 layer 0, §8.7).
 *
 * - A tool result the model sees is ≤ 2,000 lines / 50 KiB / 2,000 characters per line. Shell output keeps head 200
 *   + tail 800 lines (errors usually come last); other tools keep the head.
 * - The full output goes to a spill file named by the **internal** tool-call id (`<spill>/<thread>/<tc_id>.txt`,
 *   0600), so repeated provider ids never overwrite each other. The model reads it back as `spill:<tc_id>` with the
 *   read tool, within its own thread only.
 * - The UI gets a 64 KiB preview (`ToolOutputPreview`) and "Open full output" (`readSpill`).
 * - Spill files are deleted after 7 days (`sweepSpills`) or with the thread (`deleteThreadSpills`).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolOutputPreview } from '@shared/contracts/code';
import { harnessPaths, type ToolErrorKind, type ToolResult, type ToolRunContext } from '../types';

export const OUTPUT_LIMITS = {
  maxLines: 2_000,
  maxBytes: 50 * 1024,
  maxLineChars: 2_000,
  shellHeadLines: 200,
  shellTailLines: 800,
  previewBytes: 64 * 1024,
  spillMaxAgeMs: 7 * 24 * 3600 * 1000,
} as const;

const LINE_CUT = ' … [line truncated]';

export type TruncateMode = 'head' | 'head_tail';

export interface Truncated {
  text: string;
  truncated: boolean;
  totalLines: number;
  /** 1-based inclusive line ranges shown. */
  shown: Array<[number, number]>;
}

const fmt = (n: number) => n.toLocaleString('en-US');

function capLine(line: string): string {
  return line.length > OUTPUT_LIMITS.maxLineChars ? line.slice(0, OUTPUT_LIMITS.maxLineChars) + LINE_CUT : line;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Takes lines from the front while the byte budget lasts. */
function takeHead(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const b = Buffer.byteLength(l) + 1;
    if (used + b > budget && out.length > 0) break;
    out.push(b > budget ? l.slice(0, Math.max(0, budget - 1)) : l);
    used += b;
    if (used >= budget) break;
  }
  return out;
}

function takeTail(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i] as string;
    const b = Buffer.byteLength(l) + 1;
    if (used + b > budget && out.length > 0) break;
    out.unshift(l);
    used += b;
  }
  return out;
}

/**
 * Applies the §7.3 limits. `spillRef` (e.g. `spill:tc_…`) is named in the marker when the output was cut.
 * Marker: `[showing lines 1-200 and 8,321-9,120 of 9,120; full output: spill:<id> (use read on it)]`.
 */
export function truncateOutput(text: string, mode: TruncateMode, spillRef: string | null): Truncated {
  const raw = splitLines(text);
  const total = raw.length;
  const lines = raw.map(capLine);
  const linesCut = lines.some((l, i) => l !== raw[i]);
  const fitsLines = total <= OUTPUT_LIMITS.maxLines;
  const bytes = lines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
  if (fitsLines && bytes <= OUTPUT_LIMITS.maxBytes) {
    const body = lines.join('\n');
    if (!linesCut) return { text: body, truncated: false, totalLines: total, shown: total ? [[1, total]] : [] };
    const where = spillRef ? `; full output: ${spillRef} (use read on it)` : '';
    return { text: `${body}\n[long lines were cut at ${fmt(OUTPUT_LIMITS.maxLineChars)} characters${where}]`, truncated: true, totalLines: total, shown: total ? [[1, total]] : [] };
  }
  const where = spillRef ? `; full output: ${spillRef} (use read on it)` : '';
  if (mode === 'head') {
    const head = takeHead(lines.slice(0, OUTPUT_LIMITS.maxLines), OUTPUT_LIMITS.maxBytes);
    const n = head.length;
    return { text: `${head.join('\n')}\n[showing lines 1-${fmt(n)} of ${fmt(total)}${where}]`, truncated: true, totalLines: total, shown: n ? [[1, n]] : [] };
  }
  const headN = Math.min(OUTPUT_LIMITS.shellHeadLines, total);
  const tailN = Math.min(OUTPUT_LIMITS.shellTailLines, Math.max(0, total - headN));
  const head = takeHead(lines.slice(0, headN), Math.floor(OUTPUT_LIMITS.maxBytes * 0.2));
  const tail = takeTail(lines.slice(total - tailN), OUTPUT_LIMITS.maxBytes - head.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0));
  const tailStart = total - tail.length + 1;
  const shown: Array<[number, number]> = [];
  if (head.length) shown.push([1, head.length]);
  if (tail.length) shown.push([tailStart, total]);
  const label = tail.length
    ? `lines 1-${fmt(head.length)} and ${fmt(tailStart)}-${fmt(total)} of ${fmt(total)}`
    : `lines 1-${fmt(head.length)} of ${fmt(total)}`;
  const out = `${head.join('\n')}\n[… ${fmt(Math.max(0, tailStart - head.length - 1))} lines omitted …]\n${tail.join('\n')}\n[showing ${label}${where}]`;
  return { text: out, truncated: true, totalLines: total, shown };
}

// ─── Spill files ──────────────────────────────────────────────────────────────────────────────────────────────

const TC_ID = /^tc_[0-9A-HJKMNP-TV-Z]{26}$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isToolCallId(id: string): boolean {
  return TC_ID.test(id);
}

export function spillRef(toolCallId: string): string {
  return `spill:${toolCallId}`;
}

/** `spill:<tc_id>` → the id, else null. */
export function parseSpillRef(input: string): string | null {
  const m = /^spill:(.*)$/.exec(input.trim());
  if (!m) return null;
  return TC_ID.test(m[1] ?? '') ? (m[1] as string) : '';
}

/** The spill file of a call, or null when an id is malformed (never a path outside the thread's spill dir). */
export function spillPath(dataDir: string, threadId: string, toolCallId: string): string | null {
  if (!THREAD_ID.test(threadId) || !TC_ID.test(toolCallId)) return null;
  return harnessPaths(dataDir).spillFile(threadId, toolCallId);
}

/** Writes the full output (0600, directories 0700). Returns the spill id (= the internal tool-call id). */
export async function writeSpill(dataDir: string, threadId: string, toolCallId: string, text: string): Promise<string> {
  const file = spillPath(dataDir, threadId, toolCallId);
  if (!file) throw new Error('Invalid spill id.');
  await fs.promises.mkdir(harnessPaths(dataDir).spillDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const fh = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await fh.writeFile(text, 'utf8');
  } finally {
    await fh.close();
  }
  return toolCallId;
}

/** Reads a spill file of this thread (O_NOFOLLOW). Null when it does not exist. */
export async function readSpillFile(dataDir: string, threadId: string, toolCallId: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer | null> {
  const file = spillPath(dataDir, threadId, toolCallId);
  if (!file) return null;
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** Deletes spill files older than 7 days. Returns how many were removed. */
export async function sweepSpills(dataDir: string, nowMs: number, maxAgeMs: number = OUTPUT_LIMITS.spillMaxAgeMs): Promise<number> {
  const root = harnessPaths(dataDir).spillDir;
  let removed = 0;
  let threads: fs.Dirent[];
  try {
    threads = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const t of threads) {
    if (!t.isDirectory()) continue;
    const dir = path.join(root, t.name);
    let files: fs.Dirent[];
    try {
      files = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let left = files.length;
    for (const f of files) {
      if (!f.isFile()) continue;
      const p = path.join(dir, f.name);
      try {
        const st = await fs.promises.lstat(p);
        if (nowMs - st.mtimeMs > maxAgeMs) {
          await fs.promises.unlink(p);
          removed += 1;
          left -= 1;
        }
      } catch {
        // gone meanwhile
      }
    }
    if (left === 0) await fs.promises.rmdir(dir).catch(() => undefined);
  }
  return removed;
}

/** "Delete thread" removes its spill files (§5.2). */
export async function deleteThreadSpills(dataDir: string, threadId: string): Promise<void> {
  if (!THREAD_ID.test(threadId)) return;
  await fs.promises.rm(path.join(harnessPaths(dataDir).spillDir, threadId), { recursive: true, force: true });
}

// ─── Results ──────────────────────────────────────────────────────────────────────────────────────────────────

export function previewOf(fullText: string, spillId: string | null, truncated: boolean, exitCode?: number | null): ToolOutputPreview {
  const totalBytes = Buffer.byteLength(fullText);
  let text = fullText;
  if (totalBytes > OUTPUT_LIMITS.previewBytes) {
    text = Buffer.from(fullText).subarray(0, OUTPUT_LIMITS.previewBytes).toString('utf8').replace(/�$/, '');
  }
  const preview: ToolOutputPreview = { text, truncated: truncated || totalBytes > OUTPUT_LIMITS.previewBytes, totalBytes, spillId };
  if (exitCode !== undefined) preview.exitCode = exitCode;
  return preview;
}

export function okResult(content: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, errorKind: null, content, preview: previewOf(content, null, false), ...extra };
}

export function errorResult(kind: ToolErrorKind, message: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: false, errorKind: kind, content: message, preview: previewOf(message, null, false), ...extra };
}

/**
 * A model-facing result from a full output: truncated per §7.3 and spilled (by the internal id) when cut.
 * Used by grep/glob/list here and by H2-E's shell and web tools.
 */
export async function spilledResult(
  ctx: Pick<ToolRunContext, 'dataDir' | 'threadId' | 'call'>,
  fullText: string,
  mode: TruncateMode,
  extra: Partial<ToolResult> = {},
): Promise<ToolResult> {
  const ref = spillRef(ctx.call.id);
  const t = truncateOutput(fullText, mode, ref);
  let spillId: string | null = null;
  let text = t.text;
  if (t.truncated) {
    try {
      spillId = await writeSpill(ctx.dataDir, ctx.threadId, ctx.call.id, fullText);
    } catch {
      // No spill: the marker must not point at a missing file.
      text = truncateOutput(fullText, mode, null).text;
    }
  }
  return { ok: true, errorKind: null, content: text, preview: previewOf(fullText, spillId, t.truncated), spillId, ...extra };
}
