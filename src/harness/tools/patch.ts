/**
 * The `apply_patch` tool (harness.md §8.1, §8.2): a unified diff (git or plain) **or** the Codex
 * `*** Begin Patch` format, parsed into one internal form and applied in-process.
 *
 * - Every target path (including rename and move destinations) goes through the path policy first (§8.2), with the
 *   same O_NOFOLLOW + temp-file + rename writes as the other file tools.
 * - All-or-nothing planning: every hunk of every file must apply before anything is written.
 * - Hunks match exactly at the stated position, then at the nearest exact position, then ignoring trailing
 *   whitespace (and, for the Codex format, surrounding whitespace, as Codex does).
 * - Own writes keep the read ledger rows (§7.3); patches need no prior read: their context lines are the check.
 *
 * Deviation from §8.1: the design applies unified diffs with `git apply` through git-safe. git-safe (H2-G) has no
 * frozen apply API, and an in-process apply keeps every write inside the path policy (no symlink or `.git`
 * handling inside git), so both formats are applied here.
 */
import { checkPath, readChecked, unlinkChecked, writeAtomic, type PathPolicyOptions, type ResolvedPath } from '../sandbox/paths';
import type { ParsedArgs, PermissionSubject, ToolDefinition, ToolResult, ToolRunContext } from '../types';
import { MAX_FILE_BYTES, MAX_WRITE_BYTES, noteOwnWrite, noteSubjectRisk, objectArgs, pathErrorResult, peekText, policyOf, reqString, splitLines, takeSubjectRisk, unapprovedRisk, writeRisk, deniedRisk, type PolicyDeps } from './fs';
import { errorResult, okResult } from './output';
import type { RiskFlag } from '@shared/contracts/code';

export interface Hunk {
  /** Codex `@@ <context>` line: the hunk is searched after the first line matching it. */
  anchor: string | null;
  /** Unified `@@ -<oldStart>` (1-based), a position hint. */
  oldStart: number | null;
  oldLines: string[];
  newLines: string[];
  /** Codex `*** End of File`: the hunk must match at the end. */
  eof: boolean;
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; hunks: Hunk[] };

export type ParsedPatch = { ok: true; format: 'unified' | 'codex'; ops: PatchOp[] } | { ok: false; error: string };

const stripCr = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);

// ─── Codex format ─────────────────────────────────────────────────────────────────────────────────────────────

function parseCodex(lines: string[]): ParsedPatch {
  let i = 0;
  while (i < lines.length && (lines[i] as string).trim() === '') i += 1;
  if ((lines[i] ?? '').trim() !== '*** Begin Patch') return { ok: false, error: 'The patch must start with "*** Begin Patch".' };
  i += 1;
  const ops: PatchOp[] = [];
  let ended = false;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === '*** End Patch') {
      ended = true;
      break;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      const content: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] as string).startsWith('***')) {
        const l = lines[i] as string;
        if (!l.startsWith('+')) return { ok: false, error: `Add File ${m[1]}: every content line must start with "+" (line ${i + 1}).` };
        content.push(l.slice(1));
        i += 1;
      }
      ops.push({ kind: 'add', path: (m[1] as string).trim(), content: content.length ? `${content.join('\n')}\n` : '' });
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      ops.push({ kind: 'delete', path: (m[1] as string).trim() });
      i += 1;
      continue;
    }
    if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const path = (m[1] as string).trim();
      i += 1;
      let moveTo: string | null = null;
      const mv = /^\*\*\* Move to: (.+)$/.exec(lines[i] ?? '');
      if (mv) {
        moveTo = (mv[1] as string).trim();
        i += 1;
      }
      const hunks: Hunk[] = [];
      let cur: Hunk | null = null;
      const fresh = (anchor: string | null): Hunk => ({ anchor, oldStart: null, oldLines: [], newLines: [], eof: false, oldNoNewline: false, newNoNewline: false });
      while (i < lines.length) {
        const l = lines[i] as string;
        if (l.startsWith('*** End of File')) {
          if (!cur) return { ok: false, error: `Update File ${path}: "*** End of File" without a hunk (line ${i + 1}).` };
          cur.eof = true;
          i += 1;
          continue;
        }
        if (l.startsWith('***')) break;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          if (cur && cur.oldLines.length === 0 && cur.newLines.length === 0) cur.anchor = [cur.anchor, anchor].filter(Boolean).join('\n') || null;
          else {
            cur = fresh(anchor || null);
            hunks.push(cur);
          }
          i += 1;
          continue;
        }
        if (!cur) {
          cur = fresh(null);
          hunks.push(cur);
        }
        const tag = l[0];
        if (l === '' || tag === ' ') {
          cur.oldLines.push(l.slice(1));
          cur.newLines.push(l.slice(1));
        } else if (tag === '-') cur.oldLines.push(l.slice(1));
        else if (tag === '+') cur.newLines.push(l.slice(1));
        else return { ok: false, error: `Update File ${path}: unexpected line ${i + 1} (lines in a hunk start with " ", "-" or "+").` };
        i += 1;
      }
      const real = hunks.filter((h) => h.oldLines.length || h.newLines.length);
      if (!real.length && !moveTo) return { ok: false, error: `Update File ${path} has no changes.` };
      ops.push({ kind: 'update', path, moveTo, hunks: real });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    return { ok: false, error: `Unexpected line ${i + 1}: expected "*** Add File:", "*** Update File:", "*** Delete File:" or "*** End Patch".` };
  }
  if (!ended) return { ok: false, error: 'The patch must end with "*** End Patch".' };
  if (!ops.length) return { ok: false, error: 'The patch changes no files.' };
  return { ok: true, format: 'codex', ops };
}

// ─── Unified diff ─────────────────────────────────────────────────────────────────────────────────────────────

function unquote(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const nx = body[i + 1] ?? '';
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += 3;
      continue;
    }
    const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
    bytes.push(map[nx] ?? nx.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function headerPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = unquote(p.trim());
  return p === '/dev/null' ? null : p;
}

function stripPrefix(p: string | null, prefix: 'a/' | 'b/'): string | null {
  return p !== null && p.startsWith(prefix) ? p.slice(2) : p;
}

function parseUnified(lines: string[]): ParsedPatch {
  const ops: PatchOp[] = [];
  let i = 0;
  let sawFile = false;
  while (i < lines.length) {
    let line = lines[i] as string;
    let gitHeader = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let newFile = false;
    let deletedFile = false;
    if (line.startsWith('diff --git ')) {
      gitHeader = true;
      i += 1;
      while (i < lines.length && !(lines[i] as string).startsWith('--- ') && !(lines[i] as string).startsWith('diff ')) {
        const h = lines[i] as string;
        if (h.startsWith('rename from ')) renameFrom = unquote(h.slice(12).trim());
        else if (h.startsWith('rename to ')) renameTo = unquote(h.slice(10).trim());
        else if (h.startsWith('new file mode')) newFile = true;
        else if (h.startsWith('deleted file mode')) deletedFile = true;
        else if (h.startsWith('GIT binary patch') || h.startsWith('Binary files')) return { ok: false, error: 'Binary patches are not supported.' };
        i += 1;
      }
      if (renameFrom && renameTo && !(lines[i] ?? '').startsWith('--- ')) {
        ops.push({ kind: 'update', path: renameFrom, moveTo: renameTo, hunks: [] });
        sawFile = true;
        continue;
      }
      if (deletedFile && !(lines[i] ?? '').startsWith('--- ')) return { ok: false, error: 'A deleted file needs its "---"/"+++" headers and hunk.' };
      line = lines[i] ?? '';
    }
    if (!line.startsWith('--- ')) {
      i += 1;
      continue;
    }
    const plus = lines[i + 1] ?? '';
    if (!plus.startsWith('+++ ')) return { ok: false, error: `Line ${i + 2}: expected "+++ <path>" after "--- <path>".` };
    let oldP = headerPath(line.slice(4));
    let newP = headerPath(plus.slice(4));
    const strip = gitHeader || ((oldP === null || oldP.startsWith('a/')) && (newP === null || newP.startsWith('b/')) && (oldP !== null || newP !== null));
    if (strip) {
      oldP = stripPrefix(oldP, 'a/');
      newP = stripPrefix(newP, 'b/');
    }
    if (newFile) oldP = null;
    if (deletedFile) newP = null;
    if (oldP === null && newP === null) return { ok: false, error: `Line ${i + 1}: both sides are /dev/null.` };
    i += 2;
    const hunks: Hunk[] = [];
    while (i < lines.length && (lines[i] as string).startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i] as string);
      if (!hm) return { ok: false, error: `Line ${i + 1}: malformed hunk header.` };
      let oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
      let newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
      const h: Hunk = { anchor: null, oldStart: Number(hm[1]), oldLines: [], newLines: [], eof: false, oldNoNewline: false, newNoNewline: false };
      i += 1;
      let last: ' ' | '-' | '+' | null = null;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] as string).startsWith('\\'))) {
        const l = lines[i] as string;
        if (l.startsWith('\\')) {
          if (last === '-' || last === ' ') h.oldNoNewline = true;
          if (last === '+' || last === ' ') h.newNoNewline = true;
          i += 1;
          continue;
        }
        const tag = l === '' ? ' ' : l[0];
        const body = l === '' ? '' : l.slice(1);
        if (tag === ' ') {
          h.oldLines.push(body);
          h.newLines.push(body);
          oldLeft -= 1;
          newLeft -= 1;
        } else if (tag === '-') {
          h.oldLines.push(body);
          oldLeft -= 1;
        } else if (tag === '+') {
          h.newLines.push(body);
          newLeft -= 1;
        } else return { ok: false, error: `Line ${i + 1}: the hunk is shorter than its header says.` };
        last = tag;
        i += 1;
        if (oldLeft < 0 || newLeft < 0) return { ok: false, error: `Line ${i}: the hunk is longer than its header says.` };
      }
      if (oldLeft > 0 || newLeft > 0) return { ok: false, error: 'The patch ends in the middle of a hunk.' };
      hunks.push(h);
    }
    sawFile = true;
    if (oldP === null) {
      const add = hunks.flatMap((h) => h.newLines);
      const noNl = hunks.some((h) => h.newNoNewline);
      ops.push({ kind: 'add', path: newP as string, content: add.length ? add.join('\n') + (noNl ? '' : '\n') : '' });
    } else if (newP === null) {
      ops.push({ kind: 'delete', path: oldP });
    } else {
      const from = renameFrom ?? oldP;
      const to = renameTo ?? newP;
      if (!hunks.length && from === to) return { ok: false, error: `${from}: no hunks.` };
      ops.push({ kind: 'update', path: from, moveTo: from === to ? null : to, hunks });
    }
  }
  if (!sawFile || !ops.length) return { ok: false, error: 'No file changes found. Use a unified diff ("--- a/x", "+++ b/x", "@@ … @@") or the "*** Begin Patch" format.' };
  return { ok: true, format: 'unified', ops };
}

export function parsePatch(text: string): ParsedPatch {
  const lines = text.split('\n').map(stripCr);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const parsed = text.includes('*** Begin Patch') ? parseCodex(lines) : parseUnified(lines);
  if (!parsed.ok) return parsed;
  const seen = new Set<string>();
  for (const op of parsed.ops) {
    for (const p of [op.path, op.kind === 'update' ? op.moveTo : null]) {
      if (p === null) continue;
      if (seen.has(p)) return { ok: false, error: `${p} appears more than once in the patch.` };
      seen.add(p);
    }
  }
  return parsed;
}

// ─── Applying hunks ───────────────────────────────────────────────────────────────────────────────────────────

type Eq = (a: string, b: string) => boolean;
const exact: Eq = (a, b) => a === b;
const rstrip: Eq = (a, b) => a.trimEnd() === b.trimEnd();
const trim: Eq = (a, b) => a.trim() === b.trim();

function matchesAt(lines: string[], seq: string[], at: number, eq: Eq): boolean {
  if (at < 0 || at + seq.length > lines.length) return false;
  for (let k = 0; k < seq.length; k += 1) if (!eq(lines[at + k] as string, seq[k] as string)) return false;
  return true;
}

/** Nearest match to `hint` at or after `from`; null when none. */
function seek(lines: string[], seq: string[], from: number, hint: number | null, eof: boolean, eqs: Eq[]): number | null {
  for (const eq of eqs) {
    if (eof) {
      const at = lines.length - seq.length;
      if (at >= from && matchesAt(lines, seq, at, eq)) return at;
      continue;
    }
    if (hint !== null) {
      const h = Math.max(from, hint);
      for (let d = 0; h - d >= from || h + d <= lines.length - seq.length; d += 1) {
        if (matchesAt(lines, seq, h - d, eq) && h - d >= from) return h - d;
        if (d > 0 && matchesAt(lines, seq, h + d, eq)) return h + d;
      }
    } else {
      for (let at = from; at + seq.length <= lines.length; at += 1) if (matchesAt(lines, seq, at, eq)) return at;
    }
  }
  return null;
}

export type ApplyResult = { ok: true; content: string } | { ok: false; error: string };

/** Applies the hunks of one file to its content (pure). */
export function applyHunks(content: string, hunks: Hunk[], format: 'unified' | 'codex'): ApplyResult {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = splitLines(content).map(stripCr);
  let trailingNewline = content === '' || content.endsWith('\n');
  let cursor = 0;
  let delta = 0;
  const eqs = format === 'codex' ? [exact, rstrip, trim] : [exact, rstrip];
  for (let n = 0; n < hunks.length; n += 1) {
    const h = hunks[n] as Hunk;
    let from = cursor;
    if (h.anchor) {
      for (const a of h.anchor.split('\n')) {
        const t = a.trim();
        let found = -1;
        for (let k = from; k < lines.length; k += 1) if ((lines[k] as string).trim() === t) { found = k; break; }
        if (found === -1) for (let k = from; k < lines.length; k += 1) if ((lines[k] as string).includes(t)) { found = k; break; }
        if (found === -1) return { ok: false, error: `hunk ${n + 1}: context line "${t.slice(0, 120)}" was not found.` };
        from = found + 1;
      }
    }
    let at: number | null;
    if (h.oldLines.length === 0) {
      if (format === 'unified' && h.oldStart !== null) at = Math.min(lines.length, Math.max(from, h.oldStart + delta));
      else at = lines.length;
    } else {
      const hint = h.oldStart !== null ? h.oldStart - 1 + delta : null;
      at = seek(lines, h.oldLines, from, hint, h.eof, eqs);
      if (at === null) {
        const preview = h.oldLines.slice(0, 6).map((l) => `  ${l.slice(0, 160)}`).join('\n');
        return { ok: false, error: `hunk ${n + 1} does not match the file. Expected lines:\n${preview}${h.oldLines.length > 6 ? '\n  …' : ''}\nRe-read the file and make a new patch.` };
      }
    }
    lines.splice(at, h.oldLines.length, ...h.newLines);
    const end = at + h.newLines.length;
    if (end === lines.length) {
      if (h.newNoNewline) trailingNewline = false;
      else if (h.oldNoNewline) trailingNewline = true;
    }
    cursor = end;
    delta += h.newLines.length - h.oldLines.length;
  }
  return { ok: true, content: lines.length ? lines.join(eol) + (trailingNewline ? eol : '') : '' };
}

// ─── The tool ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface PatchArgs {
  patch: string;
}

interface Target {
  op: PatchOp;
  src: ResolvedPath;
  dest: ResolvedPath | null;
  before: string | null;
  after: string | null;
}

type Fail = { ok: false; kind: 'invalid_args' | 'execution' | 'denied'; error: string; paths: string[]; risk: RiskFlag[] };
type Plan = { ok: true; targets: Target[] } | Fail;
type Resolved = { ok: true; items: Array<{ op: PatchOp; src: ResolvedPath; dest: ResolvedPath | null }> } | Fail;

const fail = (kind: Fail['kind'], error: string, paths: string[] = [], risk: RiskFlag[] = []): Fail => ({ ok: false, kind, error, paths, risk });

/** Path checks for every target (and move destination). */
function resolveTargets(ops: PatchOp[], opts: PathPolicyOptions): Resolved {
  const items: Array<{ op: PatchOp; src: ResolvedPath; dest: ResolvedPath | null }> = [];
  for (const op of ops) {
    const c = checkPath(op.path, 'write', opts);
    if (!c.ok) return fail(c.code === 'invalid' ? 'execution' : 'denied', `${op.path}: ${c.reason}`, c.abs ? [c.abs] : [], deniedRisk(c.code));
    let dest: ResolvedPath | null = null;
    if (op.kind === 'update' && op.moveTo !== null) {
      const d = checkPath(op.moveTo, 'write', opts);
      if (!d.ok) return fail(d.code === 'invalid' ? 'execution' : 'denied', `${op.moveTo}: ${d.reason}`, d.abs ? [d.abs] : [], deniedRisk(d.code));
      dest = d.path;
    }
    items.push({ op, src: c.path, dest });
  }
  return { ok: true, items };
}

/**
 * Computes every target's new content from `befores` (index-aligned; null = unreadable or binary). `strict`
 * (runs) fails on the first problem; the lenient form (subjects) keeps going so the risk is still computed.
 */
function computeTargets(items: Extract<Resolved, { ok: true }>['items'], befores: Array<string | null>, format: 'unified' | 'codex', strict: boolean): Plan {
  const targets: Target[] = [];
  for (let k = 0; k < items.length; k += 1) {
    const { op, src: p, dest } = items[k] as (typeof items)[number];
    const before = befores[k] ?? null;
    if (p.isDirectory) {
      if (strict) return fail('execution', `${p.rel} is a directory.`);
      continue;
    }
    if (dest?.exists && strict) return fail('execution', `${dest.rel} already exists; cannot move ${op.path} there.`);
    if (op.kind === 'add') {
      if (p.exists && strict) return fail('execution', `${p.rel} already exists; use an update instead of adding it.`);
      targets.push({ op, src: p, dest: null, before: p.exists ? before : null, after: op.content });
      continue;
    }
    if (!p.exists) {
      if (strict) return fail('execution', `${p.rel || op.path} does not exist.`);
      continue;
    }
    if (before === null) {
      if (strict) return fail('execution', `${p.rel} cannot be read as text.`);
      targets.push({ op, src: p, dest, before: null, after: null });
      continue;
    }
    if (op.kind === 'delete') {
      targets.push({ op, src: p, dest: null, before, after: null });
      continue;
    }
    const applied = op.hunks.length ? applyHunks(before, op.hunks, format) : ({ ok: true, content: before } as const);
    if (!applied.ok) {
      if (strict) return fail('execution', `${p.rel}: ${applied.error}`);
      targets.push({ op, src: p, dest, before, after: before });
      continue;
    }
    if (strict && Buffer.byteLength(applied.content) > MAX_FILE_BYTES) return fail('execution', `${p.rel}: the result would be too large.`);
    targets.push({ op, src: p, dest, before, after: applied.content });
  }
  return { ok: true, targets };
}

function riskOf(targets: Target[]): RiskFlag[] {
  const set = new Set<RiskFlag>();
  for (const t of targets) {
    if (t.dest) {
      for (const f of writeRisk(t.src, t.before, null)) set.add(f);
      for (const f of writeRisk(t.dest, null, t.after)) set.add(f);
    } else {
      for (const f of writeRisk(t.src, t.before, t.after)) set.add(f);
    }
  }
  return [...set];
}

function summary(targets: Target[]): string {
  return targets
    .map((t) => {
      if (t.op.kind === 'add') return `A ${t.src.rel}`;
      if (t.op.kind === 'delete') return `D ${t.src.rel}`;
      return t.dest ? `R ${t.src.rel} -> ${t.dest.rel}` : `M ${t.src.rel}`;
    })
    .join('\n');
}

async function readTextAsync(p: ResolvedPath, opts: PathPolicyOptions): Promise<string | null> {
  const r = await readChecked(p, opts, MAX_FILE_BYTES);
  return r.data.includes(0) ? null : r.data.toString('utf8');
}

export function createPatchTool(deps: PolicyDeps = {}): ToolDefinition<PatchArgs> {
  return {
    name: 'apply_patch',
    description: [
      'Apply a patch to files in the worktree. Two formats are accepted:',
      '1. A unified diff (as produced by git diff or diff -u): "--- a/path", "+++ b/path", "@@ -l,n +l,n @@" hunks; /dev/null for added or deleted files.',
      '2. The "*** Begin Patch" format: "*** Add File: <path>" (lines prefixed with +), "*** Delete File: <path>", "*** Update File: <path>" (optionally "*** Move to: <path>") with "@@ <optional context line>" hunks of " ", "-" and "+" lines, ending with "*** End Patch".',
      'Context lines must match the current file. Either every file applies or nothing is changed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { patch: { type: 'string', description: 'The patch text.' } },
      required: ['patch'],
      additionalProperties: false,
    },
    class: 'mutate',
    parse(raw): ParsedArgs<PatchArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      const p = reqString(o.patch, 'patch');
      if (!p.ok) return p;
      if (Buffer.byteLength(p.value) > MAX_WRITE_BYTES) return { ok: false, error: 'The patch is larger than 1 MiB; split it.' };
      const parsed = parsePatch(p.value);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, args: { patch: p.value } };
    },
    readOnly: () => false,
    mutates: () => true,
    title: (a) => {
      const parsed = parsePatch(a.patch);
      if (!parsed.ok) return 'Apply patch';
      const files = parsed.ops.map((o) => o.path);
      return files.length === 1 ? `Patch ${files[0]}` : `Patch ${files.length} files`;
    },
    subject(a, ctx): PermissionSubject {
      const opts = policyOf(ctx, deps);
      const parsed = parsePatch(a.patch);
      const diffPreview = a.patch.split('\n').slice(0, 200).join('\n');
      if (!parsed.ok) {
        noteSubjectRisk(ctx.call.id, []);
        return { tool: 'apply_patch', kind: 'file-change', title: 'Apply patch', diff: diffPreview, risk: [] };
      }
      const resolved = resolveTargets(parsed.ops, opts);
      const plan = resolved.ok ? computeTargets(resolved.items, resolved.items.map((i) => (i.src.exists ? peekText(i.src, opts) : null)), parsed.format, false) : resolved;
      if (!plan.ok) {
        noteSubjectRisk(ctx.call.id, plan.risk);
        return { tool: 'apply_patch', kind: 'file-change', title: 'Apply patch', paths: plan.paths, diff: diffPreview, risk: plan.risk };
      }
      const risk = riskOf(plan.targets);
      noteSubjectRisk(ctx.call.id, risk);
      const paths = plan.targets.flatMap((t) => [t.src.real, ...(t.dest ? [t.dest.real] : [])]);
      const title = plan.targets.length === 1 ? `Patch ${plan.targets[0]?.src.rel}` : `Patch ${plan.targets.length} files`;
      return { tool: 'apply_patch', kind: 'file-change', title, paths, diff: diffPreview, risk };
    },
    async run(a, ctx: ToolRunContext): Promise<ToolResult> {
      const approved = takeSubjectRisk(ctx.call.id);
      const opts = policyOf(ctx, deps);
      const parsed = parsePatch(a.patch);
      if (!parsed.ok) return errorResult('invalid_args', parsed.error);
      const resolved = resolveTargets(parsed.ops, opts);
      if (!resolved.ok) return errorResult(resolved.kind, `Patch not applied (no file changed): ${resolved.error}`);
      let plan: Plan;
      try {
        const befores: Array<string | null> = [];
        for (const i of resolved.items) befores.push(i.src.exists && i.src.isFile ? await readTextAsync(i.src, opts) : null);
        plan = computeTargets(resolved.items, befores, parsed.format, true);
      } catch (err) {
        return pathErrorResult(err);
      }
      if (!plan.ok) return errorResult(plan.kind, `Patch not applied (no file changed): ${plan.error}`);
      const needed = riskOf(plan.targets);
      const refusal = unapprovedRisk(needed, approved, plan.targets.map((t) => t.src.rel).join(', '));
      if (refusal) return errorResult('denied', refusal);
      const allowHardLink = approved.has('outside_worktree');
      const changed: string[] = [];
      const hashes: Record<string, string> = {};
      try {
        for (const t of plan.targets) {
          if (t.op.kind === 'delete') {
            await unlinkChecked(t.src, opts);
            ctx.store.reads.delete(ctx.contextId, t.src.real);
            changed.push(t.src.rel);
            continue;
          }
          const content = t.after as string;
          if (t.dest) {
            const sha = await writeAtomic(t.dest, content, opts, { createOnly: true });
            await unlinkChecked(t.src, opts);
            ctx.store.reads.delete(ctx.contextId, t.src.real);
            noteOwnWrite(ctx, t.dest.real, sha, Buffer.byteLength(content), true);
            changed.push(t.src.rel, t.dest.rel);
            hashes[t.dest.rel] = sha;
            continue;
          }
          const sha = await writeAtomic(t.src, content, opts, { allowHardLink, createOnly: t.op.kind === 'add' });
          noteOwnWrite(ctx, t.src.real, sha, Buffer.byteLength(content), t.op.kind === 'add');
          changed.push(t.src.rel);
          hashes[t.src.rel] = sha;
        }
      } catch (err) {
        const r = pathErrorResult(err);
        const done = changed.length ? ` Already changed before the failure: ${changed.join(', ')}.` : '';
        return { ...r, content: `${r.content}${done}`, effects: { changedPaths: changed, contentHashes: hashes } };
      }
      return okResult(`Applied patch (${parsed.format === 'codex' ? 'Begin Patch' : 'unified diff'}):\n${summary(plan.targets)}`, {
        effects: { changedPaths: changed, contentHashes: hashes },
      });
    },
  };
}
