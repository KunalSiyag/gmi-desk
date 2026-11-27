/**
 * The `list` tool (harness.md §8.1): a directory tree to `depth ≤ 3`, respecting .gitignore, ≤ 1,000 entries.
 * Files come from `rg --no-config --files -- <path>` (fixed argv, §8.2) or the JS walker; directories are derived
 * from them, so ignored and hidden entries are not shown (as with rg).
 */
import path from 'node:path';
import type { ParsedArgs, ToolDefinition, ToolResult } from '../types';
import { objectArgs, optInt, policyOf, reqString } from './fs';
import { displayPath, filesArgv, finishSearch, runRipgrep, searchRoot, searchSubject, walkFiles, SEARCH_TIMEOUT_MS, type SearchDeps } from './grep';
import { errorResult, okResult } from './output';

export interface ListArgs {
  path?: string;
  depth?: number;
}

export const LIST_MAX_ENTRIES = 1_000;
export const LIST_DEFAULT_DEPTH = 2;

interface Node {
  dirs: Map<string, Node>;
  files: string[];
  count: number;
}

const node = (): Node => ({ dirs: new Map(), files: [], count: 0 });

/** Renders a tree of relative file paths (`/`-separated) to `depth` levels. */
export function renderTree(relFiles: string[], depth: number): string[] {
  const root = node();
  for (const rel of relFiles) {
    const segs = rel.split('/').filter(Boolean);
    let cur = root;
    cur.count += 1;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i] as string;
      let next = cur.dirs.get(s);
      if (!next) {
        next = node();
        cur.dirs.set(s, next);
      }
      next.count += 1;
      cur = next;
    }
    cur.files.push(segs[segs.length - 1] as string);
  }
  const out: string[] = [];
  const emit = (n: Node, level: number) => {
    const pad = '  '.repeat(level);
    for (const name of [...n.dirs.keys()].sort()) {
      const child = n.dirs.get(name) as Node;
      if (level + 1 >= depth) out.push(`${pad}${name}/ (${child.count} file${child.count === 1 ? '' : 's'})`);
      else {
        out.push(`${pad}${name}/`);
        emit(child, level + 1);
      }
    }
    for (const f of n.files.sort()) out.push(`${pad}${f}`);
  };
  emit(root, 0);
  return out;
}

export function createListTool(deps: SearchDeps): ToolDefinition<ListArgs> {
  return {
    name: 'list',
    description:
      'List a directory as a tree (default depth 2, max 3), respecting .gitignore; hidden and ignored files are not shown. Deeper directories show their file count. At most 1,000 entries.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the worktree root. Default: the root.' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Levels to expand. Default 2.' },
      },
      additionalProperties: false,
    },
    class: 'read',
    parse(raw): ParsedArgs<ListArgs> {
      const o = raw === undefined || raw === null ? {} : objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      const args: ListArgs = {};
      if (o.path !== undefined && o.path !== null) {
        const p = reqString(o.path, 'path', { max: 4096 });
        if (!p.ok) return p;
        args.path = p.value;
      }
      const d = optInt(o.depth, 'depth', 1, 3);
      if (!d.ok) return d;
      if (d.value !== undefined) args.depth = d.value;
      return { ok: true, args };
    },
    readOnly: () => true,
    mutates: () => false,
    title: (a) => `List ${a.path ?? '.'}`,
    subject: (a, ctx) => searchSubject('list', `List ${a.path ?? '.'}`, a.path, ctx, deps),
    async run(a, ctx): Promise<ToolResult> {
      const opts = policyOf(ctx, deps);
      const r = searchRoot(a.path, opts);
      if (!r.ok) return r.result;
      const root = r.path;
      if (!root.isDirectory) return errorResult('execution', `${root.rel} is not a directory; use read.`);
      const rels: string[] = [];
      let capTruncated = false;
      const push = (abs: string) => {
        if (displayPath(abs, root, opts) === null) return;
        rels.push(path.relative(root.real, abs).split(path.sep).join('/'));
      };
      if (deps.ripgrep) {
        const res = await runRipgrep(ctx, deps.ripgrep, filesArgv(root.real), root.real);
        if (res.cancelled) return errorResult('cancelled', 'Cancelled.');
        if (res.timedOut) return errorResult('timeout', `Listing timed out after ${SEARCH_TIMEOUT_MS / 1000} s.`);
        capTruncated = res.truncated;
        for (const line of res.stdout.split('\n')) if (line && !line.startsWith('rg:')) push(path.resolve(root.real, line));
      } else {
        const w = await walkFiles(root.real, { signal: ctx.signal });
        capTruncated = w.truncated;
        for (const abs of w.files) push(abs);
      }
      if (ctx.signal.aborted) return errorResult('cancelled', 'Cancelled.');
      const header = `${root.rel || '.'}/`;
      if (!rels.length) return okResult(`${header}\n(no files; hidden and ignored files are not listed)`);
      const tree = renderTree([...new Set(rels)], a.depth ?? LIST_DEFAULT_DEPTH);
      const full = [header, ...tree.map((l) => `  ${l}`)].join('\n');
      const shownLines = tree.slice(0, LIST_MAX_ENTRIES);
      const cut = tree.length > LIST_MAX_ENTRIES || capTruncated;
      const shown = [header, ...shownLines.map((l) => `  ${l}`)].join('\n');
      return finishSearch(ctx, full, shown, cut, `showing ${shownLines.length} of ${tree.length}${capTruncated ? '+' : ''} entries`, {});
    },
  };
}
