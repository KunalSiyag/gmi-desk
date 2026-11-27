/**
 * Review diffs (§12.3, §13.1 DiffFile) and the diff parser.
 *
 * The "after" side is always the worktree as it is now, snapshotted into the thread's index in the snapshot repo
 * (checkpoints.ts `currentTree`), so untracked files show up and the agent-writable worktree index is never read.
 * The "before" side is the thread's base commit or a checkpoint. Every diff runs `--no-ext-diff --no-textconv` in the
 * snapshot repo (our config: no drivers) with literal pathspecs. Large patches are parsed in the worker (§5.1).
 */
import { lstat, mkdtemp, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiffFile, DiffLine } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import { isHexSha } from '@shared/lib/git-safe';
import type { CheckpointRow, ThreadGitRecord } from '../types';
import { registerWorkerJob } from '../worker';
import { currentTree, ensureSnapshot } from './checkpoints';
import { snapOpts, snapshotRepoOf, threadOpts, type GitCtx } from './context';
import { splitZ } from './exec';
import { verifyRecord } from './record';
import { hooksPathDir, isSensitivePath, scriptsChanged } from './sensitive';

export interface ParsedFilePatch {
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: Array<{ header: string; lines: DiffLine[] }>;
}

declare module '../types' {
  interface WorkerJobs {
    'git.parseDiff': { input: { text: string }; output: ParsedFilePatch[] };
  }
}

/** Above this many characters a patch is parsed in the worker. */
const WORKER_PARSE_CHARS = 256 * 1024;
/** Above this a single file's patch is not rendered (`tooLarge`). */
export const MAX_FILE_PATCH_CHARS = 2 * 1024 * 1024;
export const MAX_FILE_PATCH_LINES = 20_000;

function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  // C-style quoting (core.quotePath): octal escapes are UTF-8 bytes.
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[i + 1]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p: string, prefix: 'a/' | 'b/'): string | null {
  if (p === '/dev/null') return null;
  const u = unquote(p);
  return u.startsWith(prefix) ? u.slice(2) : u;
}

/** Parses `git diff -p` output (any number of files) into hunks with line numbers. */
export function parseUnifiedDiff(text: string): ParsedFilePatch[] {
  const files: ParsedFilePatch[] = [];
  let cur: ParsedFilePatch | null = null;
  let hunk: { header: string; lines: DiffLine[] } | null = null;
  let oldNo = 0;
  let newNo = 0;
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      cur = { oldPath: null, newPath: null, binary: false, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (hunk === null || !/^[ +\-\\]/.test(line)) {
      if (line.startsWith('--- ')) {
        cur.oldPath = stripPrefix(line.slice(4).replace(/\t$/, ''), 'a/');
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = stripPrefix(line.slice(4).replace(/\t$/, ''), 'b/');
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.oldPath = unquote(line.slice(12));
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.newPath = unquote(line.slice(10));
        continue;
      }
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        cur.binary = true;
        continue;
      }
    }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      continue;
    }
    if (!hunk) continue;
    const tag = line[0];
    if (tag === ' ') hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    else if (tag === '-') hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
    else if (tag === '+') hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
    // '\ No newline at end of file' and anything else: skipped
  }
  return files;
}

registerWorkerJob('git.parseDiff', ({ text }) => parseUnifiedDiff(text));

/** Parses `--name-status -z -M` and `--numstat -z -M` output into DiffFile rows (no hunks). */
export function parseDiffLists(nameStatus: string, numstat: string, hooksPath: string | null = null): DiffFile[] {
  const files: DiffFile[] = [];
  const byPath = new Map<string, DiffFile>();
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; ) {
    const code = ns[i++];
    if (!code) continue;
    const kind = code[0];
    let oldPath: string | null = null;
    let path: string;
    if (kind === 'R' || kind === 'C') {
      oldPath = ns[i++] ?? '';
      path = ns[i++] ?? '';
    } else {
      path = ns[i++] ?? '';
    }
    if (!path) continue;
    const status: DiffFile['status'] = kind === 'A' || kind === 'C' ? 'added' : kind === 'D' ? 'deleted' : kind === 'R' ? 'renamed' : 'modified';
    const f: DiffFile = { path, oldPath: kind === 'R' ? oldPath : null, status, additions: 0, deletions: 0, sensitive: isSensitivePath(path, hooksPath) || (oldPath !== null && isSensitivePath(oldPath, hooksPath)), hunks: null, tooLarge: false };
    files.push(f);
    byPath.set(path, f);
  }
  const nm = numstat.split('\0');
  for (let i = 0; i < nm.length; ) {
    const head = nm[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    let path = m[3]!;
    if (path === '') {
      i += 1; // old path
      path = nm[i++] ?? '';
    }
    const f = byPath.get(path);
    if (!f) continue;
    if (m[1] === '-' || m[2] === '-') {
      f.status = f.status === 'renamed' || f.status === 'deleted' ? f.status : 'binary';
    } else {
      f.additions = Number(m[1]);
      f.deletions = Number(m[2]);
    }
  }
  return files;
}

export interface DiffOpts {
  against?: 'base' | 'checkpoint';
  checkpoint?: CheckpointRow;
}

async function fromRev(ctx: GitCtx, r: ThreadGitRecord, opts: DiffOpts | undefined): Promise<string> {
  if (opts?.against === 'checkpoint') {
    const c = opts.checkpoint;
    if (!c || c.threadId !== r.threadId || !isHexSha(c.commitSha)) throw new GmiError('invalid_input', 'A checkpoint of this thread is required.', { detail: 'diff_checkpoint' });
    return c.commitSha;
  }
  if (isHexSha(r.baseSha)) return r.baseSha;
  throw new GmiError('not_found', 'This thread has no base commit.', { detail: 'diff_no_base' });
}

const DIFF_FLAGS = ['-r', '-z', '-M', '--no-ext-diff', '--no-textconv', '--no-color'];

export async function diffList(ctx: GitCtx, r: ThreadGitRecord, opts?: DiffOpts): Promise<{ files: DiffFile[]; from: string; to: string }> {
  const from = await fromRev(ctx, r, opts);
  const to = await currentTree(ctx, r);
  // The in-repo `core.hooksPath` dir is execution-sensitive like `.husky/` (§8.2.6): the merge dialog lists it.
  const hooksPath = await hooksPathDir(ctx, r);
  const snap = snapshotRepoOf(ctx, r.projectId);
  return ctx.snapMutex.run(snap, async () => {
    const ns = await ctx.exec.run(snapOpts(ctx, r, ['diff-tree', ...DIFF_FLAGS, '--name-status', from, to], { maxBytes: 64 * 1024 * 1024 }));
    const nm = await ctx.exec.run(snapOpts(ctx, r, ['diff-tree', ...DIFF_FLAGS, '--numstat', from, to], { maxBytes: 64 * 1024 * 1024 }));
    const files = parseDiffLists(ns.stdout.toString('utf8'), nm.stdout.toString('utf8'), hooksPath);
    for (const f of files) {
      if (f.path === 'package.json' || f.path.endsWith('/package.json')) {
        const before = f.status === 'added' ? null : await blob(ctx, r, `${from}:${f.oldPath ?? f.path}`);
        const after = f.status === 'deleted' ? null : await blob(ctx, r, `${to}:${f.path}`);
        f.sensitive = scriptsChanged(before, after);
      }
    }
    return { files, from, to };
  });
}

async function blob(ctx: GitCtx, r: ThreadGitRecord, spec: string): Promise<string | null> {
  try {
    const res = await ctx.exec.raw(snapOpts(ctx, r, ['cat-file', 'blob', spec], { maxBytes: 4 * 1024 * 1024 }));
    return res.code === 0 ? res.stdout.toString('utf8') : null;
  } catch {
    return null;
  }
}

export async function fileDiff(ctx: GitCtx, r: ThreadGitRecord, path: string, opts?: DiffOpts): Promise<DiffFile> {
  const { files, from, to } = await diffList(ctx, r, opts);
  const f = files.find((d) => d.path === path);
  if (!f) throw new GmiError('not_found', 'The file is not in the diff.', { detail: 'diff_not_listed' });
  const paths = f.oldPath ? [f.oldPath, f.path] : [f.path];
  const snap = snapshotRepoOf(ctx, r.projectId);
  let res;
  try {
    res = await ctx.snapMutex.run(snap, () =>
      ctx.exec.run(snapOpts(ctx, r, ['diff-tree', '-p', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', from, to], { paths, maxBytes: MAX_FILE_PATCH_CHARS })),
    );
  } catch (err) {
    if (err instanceof GmiError && err.code === 'limit_reached') return { ...f, hunks: [], tooLarge: true };
    throw err;
  }
  const text = res.stdout.toString('utf8');
  if (text.length > MAX_FILE_PATCH_CHARS || text.split('\n').length > MAX_FILE_PATCH_LINES) return { ...f, hunks: [], tooLarge: true };
  const parsed = text.length > WORKER_PARSE_CHARS && ctx.worker ? await ctx.worker.run('git.parseDiff', { text }) : parseUnifiedDiff(text);
  const mine = parsed.find((p) => p.newPath === f.path || p.oldPath === f.path) ?? parsed[0];
  if (mine?.binary) return { ...f, status: f.status === 'renamed' ? f.status : 'binary', hunks: [] };
  return { ...f, hunks: mine?.hunks ?? [] };
}

/** `git diff <base>` of the whole worktree as a patch (binary-safe). */
export async function exportPatch(ctx: GitCtx, r: ThreadGitRecord): Promise<string> {
  const from = await fromRev(ctx, r, undefined);
  const to = await currentTree(ctx, r);
  const snap = snapshotRepoOf(ctx, r.projectId);
  return ctx.snapMutex.run(snap, () => ctx.exec.text(snapOpts(ctx, r, ['diff-tree', '-p', '--binary', '-M', '--no-ext-diff', '--no-textconv', '--no-color', from, to], { maxBytes: 256 * 1024 * 1024 })));
}

/**
 * Restores one file of the current diff (against base) to its base version; an added file is deleted. `path` must be
 * in the diff list; it is used only as a literal name.
 */
export async function discard(ctx: GitCtx, r: ThreadGitRecord, path: string): Promise<void> {
  const { files, from } = await diffList(ctx, r);
  const f = files.find((d) => d.path === path);
  if (!f) throw new GmiError('invalid_input', 'The file is not in the diff.', { detail: 'diff_not_listed' });
  const snap = snapshotRepoOf(ctx, r.projectId);
  await ctx.snapMutex.run(snap, async () => {
    await ensureSnapshot(ctx, r);
    const restore: string[] = [];
    const remove: string[] = [];
    if (f.status === 'added') remove.push(f.path);
    else if (f.status === 'renamed' && f.oldPath) {
      restore.push(f.oldPath);
      remove.push(f.path);
    } else restore.push(f.path);
    for (const rel of remove) {
      const abs = join(r.worktreePath, rel);
      try {
        if (!(await lstat(abs)).isDirectory()) await unlink(abs);
      } catch {
        /* gone */
      }
    }
    if (restore.length) {
      const tmp = await mkdtemp(join(snap, 'tmp-discard-'));
      const indexFile = join(tmp, 'index');
      try {
        await ctx.exec.run(snapOpts(ctx, r, ['read-tree', from], { indexFile }));
        await ctx.exec.run(snapOpts(ctx, r, ['checkout-index', '-f'], { indexFile, paths: restore }));
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
  });
}

/** `git status --short` of the worktree, ≤ 2 KiB (the volatile `<context>` block, §7.1). */
export async function statusShort(ctx: GitCtx, r: ThreadGitRecord): Promise<string> {
  await verifyRecord(r);
  const res = await ctx.exec.raw(
    threadOpts(r, ['status', '--short', '--untracked-files=normal', '--no-renames', '--ignore-submodules=all'], {
      alternates: r.objectDir ? [r.objectDir] : [],
      maxBytes: 1024 * 1024,
    }),
  );
  if (res.code !== 0) return '';
  const text = res.stdout.toString('utf8');
  if (text.length <= 2048) return text;
  const cut = text.lastIndexOf('\n', 2000);
  return `${text.slice(0, cut > 0 ? cut + 1 : 2000)}… (more changes not shown)\n`;
}

export { splitZ };
