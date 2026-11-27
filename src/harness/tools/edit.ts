/**
 * The `edit` tool (harness.md §8.1): exact string replacement.
 *
 * - The file must be unchanged since this context last saw it: the `reads` sha, which this context's own writes
 *   update (§7.3), so chained edits need no re-read; otherwise "re-read first".
 * - `old_string` must match exactly once (or `replace_all`). A CRLF file also matches an LF `old_string`.
 * - A miss returns the 3 closest line windows, with line numbers, so the model can correct itself.
 */
import { checkPath, readChecked, sha256, writeAtomic, type PathPolicyOptions } from '../sandbox/paths';
import type { ParsedArgs, PermissionSubject, ToolDefinition, ToolResult } from '../types';
import {
  deniedRisk,
  MAX_FILE_BYTES,
  noteOwnWrite,
  noteSubjectRisk,
  objectArgs,
  pathErrorResult,
  peekText,
  policyOf,
  reqString,
  splitLines,
  staleness,
  takeSubjectRisk,
  unapprovedRisk,
  unifiedDiff,
  writeRisk,
  type PolicyDeps,
} from './fs';
import { errorResult, okResult } from './output';

export interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export type EditOutcome =
  | { ok: true; content: string; count: number; firstLine: number }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'noop'; count: number };

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Pure replacement (also used by the subject's diff preview). */
export function applyEdit(content: string, oldStr: string, newStr: string, replaceAll: boolean): EditOutcome {
  if (oldStr === newStr) return { ok: false, reason: 'noop', count: 0 };
  let o = oldStr;
  let n = newStr;
  let count = countOccurrences(content, o);
  if (count === 0 && content.includes('\r\n') && !oldStr.includes('\r\n') && oldStr.includes('\n')) {
    o = oldStr.replace(/\n/g, '\r\n');
    n = newStr.replace(/\r?\n/g, '\r\n');
    count = countOccurrences(content, o);
  }
  if (count === 0) return { ok: false, reason: 'not_found', count };
  if (count > 1 && !replaceAll) return { ok: false, reason: 'ambiguous', count };
  const at = content.indexOf(o);
  const firstLine = content.slice(0, at).split('\n').length;
  const next = replaceAll ? content.split(o).join(n) : content.slice(0, at) + n + content.slice(at + o.length);
  return { ok: true, content: next, count: replaceAll ? count : 1, firstLine };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < t.length - 1; i += 1) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, aSize: number, b: Map<string, number>, bSize: number): number {
  if (aSize + bSize === 0) return 1;
  let inter = 0;
  for (const [g, c] of a) inter += Math.min(c, b.get(g) ?? 0);
  return (2 * inter) / (aSize + bSize);
}

/** The `k` best-matching, non-overlapping windows of `old_string`'s line count, as numbered text. */
export function closestWindows(content: string, needle: string, k = 3): Array<{ startLine: number; score: number; text: string }> {
  const lines = splitLines(content);
  const want = Math.max(1, splitLines(needle).length);
  if (!lines.length) return [];
  const target = bigrams(needle);
  const tSize = [...target.values()].reduce((s, c) => s + c, 0);
  const scored: Array<{ start: number; score: number }> = [];
  const maxWindows = 20_000;
  const step = Math.max(1, Math.ceil(Math.max(1, lines.length - want + 1) / maxWindows));
  for (let i = 0; i + want <= Math.max(want, lines.length); i += step) {
    const win = lines.slice(i, i + want).join('\n');
    const g = bigrams(win);
    const gSize = [...g.values()].reduce((s, c) => s + c, 0);
    scored.push({ start: i, score: dice(target, tSize, g, gSize) });
  }
  scored.sort((x, y) => y.score - x.score || x.start - y.start);
  const picked: Array<{ start: number; score: number }> = [];
  for (const s of scored) {
    if (picked.length >= k) break;
    if (s.score <= 0) break;
    if (picked.some((p) => Math.abs(p.start - s.start) < want)) continue;
    picked.push(s);
  }
  return picked.map((p) => ({
    startLine: p.start + 1,
    score: p.score,
    text: lines
      .slice(p.start, p.start + want)
      .map((l, j) => `${String(p.start + j + 1).padStart(6, ' ')}\t${l.replace(/\r$/, '').slice(0, 500)}`)
      .join('\n'),
  }));
}

function missMessage(rel: string, content: string, oldStr: string): string {
  const wins = closestWindows(content, oldStr, 3);
  const head = `old_string was not found in ${rel}. It must match the file exactly, including whitespace and indentation.`;
  if (!wins.length) return head;
  return `${head} The closest passages:\n${wins.map((w, i) => `--- candidate ${i + 1} (line ${w.startLine}) ---\n${w.text}`).join('\n')}`;
}

export function createEditTool(deps: PolicyDeps = {}): ToolDefinition<EditArgs> {
  const plan = (a: EditArgs, opts: PathPolicyOptions) => {
    const c = checkPath(a.path, 'write', opts);
    if (!c.ok) return { c, before: null, outcome: null } as const;
    const before = peekText(c.path, opts);
    const outcome = before === null ? null : applyEdit(before, a.old_string, a.new_string, a.replace_all ?? false);
    return { c, before, outcome } as const;
  };
  return {
    name: 'edit',
    description:
      'Replace an exact string in a file you have read. old_string must match the file exactly (whitespace included) and be unique unless replace_all is true; include enough surrounding lines to make it unique. Your own earlier edits do not require a re-read.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the worktree root.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    class: 'mutate',
    parse(raw): ParsedArgs<EditArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      const p = reqString(o.path, 'path', { max: 4096 });
      if (!p.ok) return p;
      const os = reqString(o.old_string, 'old_string');
      if (!os.ok) return { ok: false, error: os.error === 'old_string must not be empty.' ? 'old_string must not be empty (use write to create a file).' : os.error };
      const ns = reqString(o.new_string, 'new_string', { allowEmpty: true });
      if (!ns.ok) return ns;
      if (o.replace_all !== undefined && typeof o.replace_all !== 'boolean') return { ok: false, error: 'replace_all must be a boolean.' };
      if (os.value === ns.value) return { ok: false, error: 'old_string and new_string are identical.' };
      const args: EditArgs = { path: p.value, old_string: os.value, new_string: ns.value };
      if (o.replace_all !== undefined) args.replace_all = o.replace_all as boolean;
      return { ok: true, args };
    },
    readOnly: () => false,
    mutates: () => true,
    title: (a) => `Edit ${a.path}`,
    subject(a, ctx): PermissionSubject {
      const { c, before, outcome } = plan(a, policyOf(ctx, deps));
      if (!c.ok) {
        const s: PermissionSubject = { tool: 'edit', kind: 'file-change', title: `Edit ${a.path}`, ...(c.abs ? { paths: [c.abs] } : {}), risk: deniedRisk(c.code) };
        noteSubjectRisk(ctx.call.id, s.risk);
        return s;
      }
      const after = outcome?.ok ? outcome.content : before;
      const risk = writeRisk(c.path, before, after);
      noteSubjectRisk(ctx.call.id, risk);
      const s: PermissionSubject = { tool: 'edit', kind: 'file-change', title: `Edit ${c.path.rel}`, paths: [c.path.real], risk };
      if (before !== null && outcome?.ok) s.diff = unifiedDiff(c.path.rel, before, outcome.content);
      return s;
    },
    async run(a, ctx): Promise<ToolResult> {
      const approved = takeSubjectRisk(ctx.call.id);
      const opts = policyOf(ctx, deps);
      const c = checkPath(a.path, 'write', opts);
      if (!c.ok) return errorResult(c.code === 'invalid' ? 'execution' : 'denied', c.reason);
      const p = c.path;
      if (!p.exists) return errorResult('execution', `${p.rel || a.path} does not exist. Use write to create it.`);
      if (p.isDirectory) return errorResult('execution', `${p.rel} is a directory.`);
      if (!p.isFile) return errorResult('execution', `${p.rel} is not a regular file.`);
      try {
        const r = await readChecked(p, opts, MAX_FILE_BYTES);
        if (r.data.includes(0)) return errorResult('execution', `${p.rel} is a binary file; edit cannot change it.`);
        const stale = staleness(ctx, p.real, sha256(r.data), p.rel);
        if (stale) return errorResult('execution', stale);
        const before = r.data.toString('utf8');
        const out = applyEdit(before, a.old_string, a.new_string, a.replace_all ?? false);
        if (!out.ok) {
          if (out.reason === 'ambiguous') return errorResult('execution', `old_string matches ${out.count} places in ${p.rel}. Add surrounding lines to make it unique, or set replace_all.`);
          if (out.reason === 'noop') return errorResult('invalid_args', 'old_string and new_string are identical.');
          return errorResult('execution', missMessage(p.rel, before, a.old_string));
        }
        if (Buffer.byteLength(out.content) > MAX_FILE_BYTES) return errorResult('execution', 'The edited file would be too large.');
        const refusal = unapprovedRisk(writeRisk(p, before, out.content), approved, p.rel);
        if (refusal) return errorResult('denied', refusal);
        const newSha = await writeAtomic(p, out.content, opts, { allowHardLink: approved.has('outside_worktree') });
        noteOwnWrite(ctx, p.real, newSha, Buffer.byteLength(out.content), false);
        const lines = out.count === 1 ? ` at line ${out.firstLine}` : '';
        return okResult(`Edited ${p.rel}: ${out.count} replacement${out.count === 1 ? '' : 's'}${lines}.`, {
          effects: { changedPaths: [p.rel], contentHashes: { [p.rel]: newSha } },
        });
      } catch (err) {
        return pathErrorResult(err);
      }
    },
  };
}
