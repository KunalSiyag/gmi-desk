/**
 * File tools `read` and `write`, plus the helpers the other file tools share (harness.md §7.3, §8.1, §8.2).
 *
 * - Every path goes through the path policy (sandbox/paths.ts); all IO uses the checked real path with O_NOFOLLOW.
 * - `read`: line-numbered, ≤ 2,000 lines / 50 KiB / 2,000 characters per line; read dedupe by line range per
 *   context (`reads` ledger); binary or minified files → a summary line; images and PDFs are not read in v1;
 *   `spill:<tc_id>` reads this thread's spill files (§8.7).
 * - `write`: a new file, or a full rewrite of a file this context has read at its current sha; ≤ 1 MiB.
 * - Own writes keep the ledger row (its sha moves to the post-write hash, ranges unchanged), so chained edits need
 *   no re-read; any other change (bash, a formatter, the user) changes the sha and invalidates the row.
 * - Risk flags (`execution_sensitive`, `outside_worktree` for hard links) are computed in the synchronous
 *   `subject()` and re-checked in `run()`: a flag that appears between the permission check and the write (the file
 *   was swapped or turned sensitive) refuses the call instead of writing without approval.
 */
import os from 'node:os';
import path from 'node:path';
import type { RiskFlag } from '@shared/contracts/code';
import {
  checkPath,
  packageScriptsChanged,
  PathPolicyError,
  readChecked,
  readCheckedSync,
  sha256,
  writeAtomic,
  type PathPolicyOptions,
  type ResolvedPath,
} from '../sandbox/paths';
import type { ParsedArgs, PermissionSubject, ReadRow, ToolDefinition, ToolResult, ToolRunContext } from '../types';
import { errorResult, okResult, OUTPUT_LIMITS, parseSpillRef, readSpillFile } from './output';

// ─── Shared helpers ───────────────────────────────────────────────────────────────────────────────────────────

export interface PolicyDeps {
  /** Defaults to os.homedir(). */
  home?: string;
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** The in-repo `core.hooksPath` (relative), when the integration knows it (§8.2.6). */
  hooksPath?: (ctx: ToolRunContext) => string | null;
}

/** `<userData>` = two levels above `dataDir` (`<userData>/data/harness`). */
export function policyOf(ctx: Pick<ToolRunContext, 'worktree' | 'dataDir'> & Partial<ToolRunContext>, deps: PolicyDeps = {}): PathPolicyOptions {
  return {
    worktree: ctx.worktree,
    userDataDir: path.resolve(ctx.dataDir, '..', '..'),
    home: deps.home ?? os.homedir(),
    platform: deps.platform ?? process.platform,
    hooksPath: deps.hooksPath && 'threadId' in ctx ? deps.hooksPath(ctx as ToolRunContext) : null,
  };
}

/** Max file size the file tools load. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;

const IMAGE_OR_PDF = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic|pdf|svgz)$/i;

/** Text decoding with the §7.3 binary/minified rules: null text and a summary when not shown. */
export function classifyContent(buf: Buffer, rel: string): { text: string | null; summary: string | null } {
  if (IMAGE_OR_PDF.test(rel)) return { text: null, summary: `[${extOf(rel)} file, ${fmtBytes(buf.length)}: images and PDFs are not read]` };
  if (buf.includes(0)) return { text: null, summary: `[binary file, ${fmtBytes(buf.length)}: not shown]` };
  const text = buf.toString('utf8');
  const lines = splitLines(text);
  if (lines.length > 0 && text.length / lines.length > 1_000) {
    return { text: null, summary: `[minified or single-line file, ${fmtBytes(buf.length)}, ${lines.length.toLocaleString('en-US')} lines averaging over 1,000 characters: not shown; use grep]` };
  }
  return { text, summary: null };
}

function extOf(rel: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(rel);
  return m ? (m[1] as string).toUpperCase() : 'binary';
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** Lines without the trailing empty element of a final newline; a trailing `\r` is kept (CRLF files). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Risk flags approved per internal tool-call id between `subject()` and `run()`. Bounded. */
const approvedRisk = new Map<string, Set<RiskFlag>>();

export function noteSubjectRisk(callId: string, risk: readonly RiskFlag[]): void {
  approvedRisk.delete(callId);
  approvedRisk.set(callId, new Set(risk));
  while (approvedRisk.size > 2_000) {
    const first = approvedRisk.keys().next().value;
    if (first === undefined) break;
    approvedRisk.delete(first);
  }
}

/** The flags the evaluated subject carried (empty when `subject()` was not called for this call). */
export function takeSubjectRisk(callId: string): Set<RiskFlag> {
  const r = approvedRisk.get(callId) ?? new Set<RiskFlag>();
  approvedRisk.delete(callId);
  return r;
}

/** Risk of writing `after` to a checked path (§8.2.4 hard link, §8.2.6 execution-sensitive). */
export function writeRisk(p: ResolvedPath, before: string | null, after: string | null): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (p.sensitivity === 'always' || (p.sensitivity === 'package_json' && packageScriptsChanged(before, after))) flags.push('execution_sensitive');
  if (p.exists && p.isFile && p.nlink > 1) flags.push('outside_worktree');
  return flags;
}

/** Flags needed now that the evaluated subject did not carry → a refusal message, else null. */
export function unapprovedRisk(needed: readonly RiskFlag[], approved: Set<RiskFlag>, rel: string): string | null {
  const missing = needed.filter((f) => !approved.has(f));
  if (!missing.length) return null;
  const why = missing.includes('outside_worktree') ? 'has other hard links' : 'is execution-sensitive';
  return `Not executed: ${rel} ${why} and this call was not approved for that (the file changed after the permission check). Call the tool again.`;
}

/** Risk for a path that the policy refuses (the run refuses it again; the engine's hard deny sees `secret_path`). */
export function deniedRisk(code: string): RiskFlag[] {
  if (code === 'secret' || code === 'protected') return ['secret_path'];
  if (code === 'outside' || code === 'symlink') return ['outside_worktree'];
  return [];
}

export function pathErrorResult(err: unknown): ToolResult {
  if (err instanceof PathPolicyError) {
    const kind = err.code === 'invalid' ? 'execution' : 'denied';
    return errorResult(kind, err.message);
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return errorResult('execution', 'The file does not exist.');
  if (code === 'EACCES' || code === 'EPERM') return errorResult('execution', 'Permission denied by the file system.');
  if (code === 'ENOSPC') return errorResult('execution', 'No space left on the device.');
  return errorResult('execution', 'The file operation failed.');
}

/** Sync read of a checked path as text (subjects). Null when absent, unreadable, binary or too large. */
export function peekText(p: ResolvedPath, opts: PathPolicyOptions): string | null {
  if (!p.exists || !p.isFile) return null;
  const buf = readCheckedSync(p, opts, MAX_FILE_BYTES);
  if (!buf || buf.includes(0)) return null;
  return buf.toString('utf8');
}

/** Merges `[start, end)` into sorted, disjoint ranges. */
export function mergeRanges(ranges: Array<[number, number]>, add: [number, number]): Array<[number, number]> {
  const all = [...ranges, add].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function coveredBy(ranges: Array<[number, number]>, want: [number, number]): boolean {
  return ranges.some(([a, b]) => a <= want[0] && want[1] <= b);
}

/**
 * After this context's own successful write: the row's sha becomes the post-write hash (so chained edits need no
 * re-read, §7.3) and its ranges are emptied: the only text of the file in context is the pre-edit version, so a
 * verifying read must return the new content (review H2: [read X, edit X, read X] answered "unchanged").
 * `createIfMissing` adds an empty-range row (a file this context created), so the next edit needs no read.
 */
export function noteOwnWrite(ctx: ToolRunContext, real: string, newSha: string, size: number, createIfMissing: boolean): void {
  const row = ctx.store.reads.get(ctx.contextId, real);
  if (row) {
    ctx.store.reads.put({ ...row, sha: newSha, ranges: [], size, mtimeMs: ctx.clock.now() });
  } else if (createIfMissing) {
    ctx.store.reads.put({ contextId: ctx.contextId, path: real, sha: newSha, ranges: [], size, mtimeMs: ctx.clock.now(), ord: ctx.store.messages.lastOrd(ctx.contextId) });
  }
}

/** Staleness rule of edit/write (§8.1): the file must be unchanged since this context last saw it. */
export function staleness(ctx: ToolRunContext, real: string, currentSha: string, rel: string): string | null {
  const row = ctx.store.reads.get(ctx.contextId, real);
  if (!row) return `You have not read ${rel} in this conversation. Read it first.`;
  if (row.sha !== currentSha) return `${rel} changed since you last read it (by a command, a formatter or the user). Re-read it first.`;
  return null;
}

// ─── Unified diff preview (approval cards, ≤ 200 lines) ──────────────────────────────────────────────────────

type Op = { t: ' ' | '-' | '+'; line: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ t: '+', line }));
  if (m === 0) return a.map((line) => ({ t: '-', line }));
  if (n * m > 1_000_000) return [...a.map((line): Op => ({ t: '-', line })), ...b.map((line): Op => ({ t: '+', line }))];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? (dp[(i + 1) * w + j + 1] as number) + 1 : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i] as string });
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
      ops.push({ t: '-', line: a[i] as string });
      i += 1;
    } else {
      ops.push({ t: '+', line: b[j] as string });
      j += 1;
    }
  }
  while (i < n) ops.push({ t: '-', line: a[i++] as string });
  while (j < m) ops.push({ t: '+', line: b[j++] as string });
  return ops;
}

/** A unified diff of two texts (null = absent), 3 lines of context, cut at `maxLines`. Empty when equal. */
export function unifiedDiff(rel: string, before: string | null, after: string | null, maxLines = 200): string {
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  const ops: Op[] = [
    ...a.slice(0, p).map((line): Op => ({ t: ' ', line })),
    ...lcsOps(a.slice(p, a.length - s), b.slice(p, b.length - s)),
    ...a.slice(a.length - s).map((line): Op => ({ t: ' ', line })),
  ];
  if (!ops.some((o) => o.t !== ' ')) return '';
  const C = 3;
  const out: string[] = [`--- ${before === null ? '/dev/null' : `a/${rel}`}`, `+++ ${after === null ? '/dev/null' : `b/${rel}`}`];
  // Positions of changes → hunks.
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = 1;
  let nn = 1;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(nn);
    if (op.t !== '+') o += 1;
    if (op.t !== '-') nn += 1;
  }
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && (ops[k] as Op).t === ' ') k += 1;
    if (k >= ops.length) break;
    const start = Math.max(0, k - C);
    let end = k;
    let lastChange = k;
    while (end < ops.length) {
      if ((ops[end] as Op).t !== ' ') lastChange = end;
      else if (end - lastChange > 2 * C) break;
      end += 1;
    }
    const stop = Math.min(ops.length, lastChange + C + 1);
    const slice = ops.slice(start, stop);
    const oldLen = slice.filter((x) => x.t !== '+').length;
    const newLen = slice.filter((x) => x.t !== '-').length;
    const os = oldLen ? (oldNo[start] as number) : (oldNo[start] as number) - 1;
    const ns = newLen ? (newNo[start] as number) : (newNo[start] as number) - 1;
    out.push(`@@ -${os},${oldLen} +${ns},${newLen} @@`);
    for (const x of slice) out.push(`${x.t}${x.line.replace(/\r$/, '')}`);
    k = stop;
  }
  if (out.length > maxLines) {
    const more = out.length - maxLines;
    return `${out.slice(0, maxLines).join('\n')}\n… (${more} more diff lines)`;
  }
  return out.join('\n');
}

// ─── Small arg validation (the frozen tool block carries the JSON schemas) ──────────────────────────────────

export function objectArgs(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

export function optInt(v: unknown, name: string, min: number, max: number): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, error: `${name} must be an integer.` };
  if (v < min || v > max) return { ok: false, error: `${name} must be between ${min} and ${max}.` };
  return { ok: true, value: v };
}

export function reqString(v: unknown, name: string, opts: { allowEmpty?: boolean; max?: number } = {}): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof v !== 'string') return { ok: false, error: `${name} must be a string.` };
  if (!opts.allowEmpty && v.length === 0) return { ok: false, error: `${name} must not be empty.` };
  if (opts.max !== undefined && v.length > opts.max) return { ok: false, error: `${name} is too long (max ${opts.max} characters).` };
  return { ok: true, value: v };
}

// ─── read ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReadArgs {
  path: string;
  /** 1-based first line (default 1). */
  offset?: number;
  /** Lines (default and max 2,000). */
  limit?: number;
}

const lineNo = (n: number) => `${String(n).padStart(6, ' ')}\t`;

function formatLines(lines: string[], start: number, end: number): { text: string; end: number; cut: boolean } {
  const out: string[] = [];
  let used = 0;
  let i = start;
  let cut = false;
  for (; i < end; i += 1) {
    let line = (lines[i] as string).replace(/\r$/, '');
    if (line.length > OUTPUT_LIMITS.maxLineChars) line = `${line.slice(0, OUTPUT_LIMITS.maxLineChars)} … [line truncated]`;
    const row = lineNo(i + 1) + line;
    const b = Buffer.byteLength(row) + 1;
    if (used + b > OUTPUT_LIMITS.maxBytes && out.length > 0) {
      cut = true;
      break;
    }
    out.push(row);
    used += b;
  }
  return { text: out.join('\n'), end: i, cut };
}

/** Shared by the file read and the spill read: paging, dedupe by range, ledger update. */
function readText(ctx: ToolRunContext, key: string, display: string, sha: string, text: string, size: number, mtimeMs: number | null, args: ReadArgs): ToolResult {
  const lines = splitLines(text);
  const total = lines.length;
  const start = (args.offset ?? 1) - 1;
  const limit = Math.min(args.limit ?? OUTPUT_LIMITS.maxLines, OUTPUT_LIMITS.maxLines);
  if (total === 0) return okResult(`(${display} is empty)`, { effects: { readPaths: [display], contentHashes: { [display]: sha } } });
  if (start >= total) return { ...errorResult('execution', `offset ${start + 1} is past the end of ${display} (${total} lines).`) };
  const wantEnd = Math.min(total, start + limit);
  const row = ctx.store.reads.get(ctx.contextId, key);
  const effects = { readPaths: [display], contentHashes: { [display]: sha } };
  if (row && row.sha === sha && coveredBy(row.ranges, [start, wantEnd])) {
    return okResult(`Unchanged since your earlier read of ${display} (lines ${start + 1}-${wantEnd}, sha ${sha.slice(0, 12)}). The content is earlier in this conversation.`, { effects });
  }
  const f = formatLines(lines, start, wantEnd);
  let body = f.text;
  if (f.end < total) body += `\n[showing lines ${start + 1}-${f.end} of ${total}; use offset=${f.end + 1} to continue]`;
  const ord = ctx.store.messages.lastOrd(ctx.contextId);
  const next: ReadRow =
    row && row.sha === sha
      ? { ...row, ranges: mergeRanges(row.ranges, [start, f.end]), size, mtimeMs, ord: row.ord === null ? ord : Math.min(row.ord, ord) }
      : { contextId: ctx.contextId, path: key, sha, ranges: [[start, f.end]], size, mtimeMs, ord };
  ctx.store.reads.put(next);
  return okResult(body, { effects: { ...effects, readRange: { key, start, end: f.end } } });
}

/** `ranges` minus `[start, end)` (the loop's step cap removed those lines from the result). */
export function subtractRange(ranges: Array<[number, number]>, cut: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    if (b <= cut[0] || a >= cut[1]) out.push([a, b]);
    else {
      if (a < cut[0]) out.push([a, cut[0]]);
      if (b > cut[1]) out.push([cut[1], b]);
    }
  }
  return out;
}

export function createReadTool(deps: PolicyDeps = {}): ToolDefinition<ReadArgs> {
  return {
    name: 'read',
    description:
      'Read a text file in the worktree. Returns numbered lines (at most 2,000 lines or 50 KiB per call); page with offset (1-based line) and limit. Reading an unchanged range again returns a short "unchanged" note. Truncated tool outputs can be read with path "spill:<id>".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the worktree root, or spill:<id>.' },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based). Default 1.' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Number of lines. Default 2000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    class: 'read',
    parse(raw): ParsedArgs<ReadArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      const p = reqString(o.path, 'path', { max: 4096 });
      if (!p.ok) return p;
      const off = optInt(o.offset, 'offset', 1, 100_000_000);
      if (!off.ok) return off;
      const lim = optInt(o.limit, 'limit', 1, OUTPUT_LIMITS.maxLines);
      if (!lim.ok) return lim;
      const args: ReadArgs = { path: p.value };
      if (off.value !== undefined) args.offset = off.value;
      if (lim.value !== undefined) args.limit = lim.value;
      return { ok: true, args };
    },
    readOnly: () => true,
    mutates: () => false,
    title: (a) => `Read ${a.path}`,
    subject(a, ctx): PermissionSubject {
      if (parseSpillRef(a.path) !== null) return { tool: 'read', kind: 'file-read', title: `Read ${a.path}`, risk: [] };
      const c = checkPath(a.path, 'read', policyOf(ctx, deps));
      if (!c.ok) return { tool: 'read', kind: 'file-read', title: `Read ${a.path}`, ...(c.abs ? { paths: [c.abs] } : {}), risk: deniedRisk(c.code) };
      return { tool: 'read', kind: 'file-read', title: `Read ${c.path.rel || '.'}`, paths: [c.path.real], risk: [] };
    },
    async run(a, ctx): Promise<ToolResult> {
      const spill = parseSpillRef(a.path);
      if (spill !== null) {
        if (!spill) return errorResult('invalid_args', 'Malformed spill id.');
        const buf = await readSpillFile(ctx.dataDir, ctx.threadId, spill);
        if (!buf) return errorResult('execution', `No spill file ${a.path} in this thread.`);
        const text = buf.includes(0) ? buf.toString('utf8').replace(/\0/g, '�') : buf.toString('utf8');
        return readText(ctx, `spill:${spill}`, a.path, sha256(buf), text, buf.length, null, a);
      }
      const opts = policyOf(ctx, deps);
      const c = checkPath(a.path, 'read', opts);
      if (!c.ok) return errorResult(c.code === 'invalid' ? 'execution' : 'denied', c.reason);
      const p = c.path;
      if (!p.exists) return errorResult('execution', `${p.rel || a.path} does not exist.`);
      if (p.isDirectory) return errorResult('execution', `${p.rel || '.'} is a directory; use list.`);
      if (!p.isFile) return errorResult('execution', `${p.rel || a.path} is not a regular file.`);
      try {
        const r = await readChecked(p, opts, MAX_FILE_BYTES);
        const sha = sha256(r.data);
        const cls = classifyContent(r.data, p.rel);
        if (cls.text === null) return okResult(`${p.rel}: ${cls.summary}`, { effects: { readPaths: [p.rel], contentHashes: { [p.rel]: sha } } });
        return readText(ctx, p.real, p.rel, sha, cls.text, r.size, r.mtimeMs, a);
      } catch (err) {
        return pathErrorResult(err);
      }
    },
  };
}

// ─── write ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WriteArgs {
  path: string;
  content: string;
}

export function createWriteTool(deps: PolicyDeps = {}): ToolDefinition<WriteArgs> {
  return {
    name: 'write',
    description:
      'Create a file, or replace the whole content of a file you have read (at most 1 MiB). Prefer edit or apply_patch for changes to existing files. Parent directories are created.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the worktree root.' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    class: 'mutate',
    parse(raw): ParsedArgs<WriteArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      const p = reqString(o.path, 'path', { max: 4096 });
      if (!p.ok) return p;
      const c = reqString(o.content, 'content', { allowEmpty: true });
      if (!c.ok) return c;
      if (Buffer.byteLength(c.value) > MAX_WRITE_BYTES) return { ok: false, error: `content is larger than 1 MiB; write the file in parts with edit or apply_patch.` };
      return { ok: true, args: { path: p.value, content: c.value } };
    },
    readOnly: () => false,
    mutates: () => true,
    title: (a) => `Write ${a.path}`,
    subject(a, ctx): PermissionSubject {
      const opts = policyOf(ctx, deps);
      const c = checkPath(a.path, 'write', opts);
      if (!c.ok) {
        const s: PermissionSubject = { tool: 'write', kind: 'file-change', title: `Write ${a.path}`, ...(c.abs ? { paths: [c.abs] } : {}), risk: deniedRisk(c.code) };
        noteSubjectRisk(ctx.call.id, s.risk);
        return s;
      }
      const before = peekText(c.path, opts);
      const risk = writeRisk(c.path, before, a.content);
      noteSubjectRisk(ctx.call.id, risk);
      return { tool: 'write', kind: 'file-change', title: `${c.path.exists ? 'Rewrite' : 'Create'} ${c.path.rel}`, paths: [c.path.real], diff: unifiedDiff(c.path.rel, c.path.exists ? before : null, a.content), risk };
    },
    async run(a, ctx): Promise<ToolResult> {
      const approved = takeSubjectRisk(ctx.call.id);
      const opts = policyOf(ctx, deps);
      const c = checkPath(a.path, 'write', opts);
      if (!c.ok) return errorResult(c.code === 'invalid' ? 'execution' : 'denied', c.reason);
      const p = c.path;
      if (p.isDirectory) return errorResult('execution', `${p.rel} is a directory.`);
      if (p.exists && !p.isFile) return errorResult('execution', `${p.rel} is not a regular file.`);
      try {
        let before: string | null = null;
        if (p.exists) {
          const r = await readChecked(p, opts, MAX_FILE_BYTES);
          const stale = staleness(ctx, p.real, sha256(r.data), p.rel);
          if (stale) return errorResult('execution', stale.replace('Read it first.', 'Read it before rewriting it (or use edit).'));
          before = r.data.toString('utf8');
        }
        const refusal = unapprovedRisk(writeRisk(p, before, a.content), approved, p.rel);
        if (refusal) return errorResult('denied', refusal);
        const newSha = await writeAtomic(p, a.content, opts, { allowHardLink: approved.has('outside_worktree'), createOnly: !p.exists });
        noteOwnWrite(ctx, p.real, newSha, Buffer.byteLength(a.content), true);
        const lines = splitLines(a.content).length;
        return okResult(`${p.exists ? 'Rewrote' : 'Created'} ${p.rel} (${lines} line${lines === 1 ? '' : 's'}).`, {
          effects: { changedPaths: [p.rel], contentHashes: { [p.rel]: newSha } },
        });
      } catch (err) {
        return pathErrorResult(err);
      }
    },
  };
}
