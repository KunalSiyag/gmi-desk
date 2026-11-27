/**
 * The `glob` tool (harness.md §8.1): files matching a glob, respecting .gitignore, ≤ 1,000 results.
 * `rg --no-config --files -g <glob> -- <path>` (fixed argv, §8.2), or the JS walker without rg.
 */
import path from 'node:path';
import type { ParsedArgs, ToolDefinition, ToolResult } from '../types';
import { objectArgs, policyOf, reqString } from './fs';
import { compileGlobRule, displayPath, filesArgv, finishSearch, runRipgrep, searchRoot, searchSubject, walkFiles, SEARCH_TIMEOUT_MS, type SearchDeps } from './grep';
import { errorResult, okResult } from './output';

export interface GlobArgs {
  pattern: string;
  path?: string;
}

export const GLOB_MAX_RESULTS = 1_000;

export function createGlobTool(deps: SearchDeps): ToolDefinition<GlobArgs> {
  return {
    name: 'glob',
    description:
      'Find files by name with a glob pattern (e.g. "**/*.test.ts", "src/**/index.{js,ts}"), respecting .gitignore. A pattern without "/" matches file names at any depth. Returns paths relative to the worktree root (at most 1,000).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, relative to the search directory.' },
        path: { type: 'string', description: 'Directory to search, relative to the worktree root. Default: the root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    class: 'read',
    parse(raw): ParsedArgs<GlobArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      const p = reqString(o.pattern, 'pattern', { max: 500 });
      if (!p.ok) return p;
      const args: GlobArgs = { pattern: p.value };
      if (o.path !== undefined && o.path !== null) {
        const d = reqString(o.path, 'path', { max: 4096 });
        if (!d.ok) return d;
        args.path = d.value;
      }
      return { ok: true, args };
    },
    readOnly: () => true,
    mutates: () => false,
    title: (a) => `Glob ${a.pattern}${a.path ? ` in ${a.path}` : ''}`,
    subject: (a, ctx) => searchSubject('glob', `Glob ${a.pattern}`, a.path, ctx, deps),
    async run(a, ctx): Promise<ToolResult> {
      const opts = policyOf(ctx, deps);
      const r = searchRoot(a.path, opts);
      if (!r.ok) return r.result;
      const root = r.path;
      if (!root.isDirectory) return errorResult('execution', `${root.rel} is not a directory.`);
      let files: string[] = [];
      let capTruncated = false;
      if (deps.ripgrep) {
        const res = await runRipgrep(ctx, deps.ripgrep, filesArgv(root.real, [a.pattern]), root.real);
        if (res.cancelled) return errorResult('cancelled', 'Cancelled.');
        if (res.timedOut) return errorResult('timeout', `The search timed out after ${SEARCH_TIMEOUT_MS / 1000} s; narrow the path.`);
        capTruncated = res.truncated;
        for (const line of res.stdout.split('\n')) {
          if (!line || line.startsWith('rg:')) continue;
          const shown = displayPath(path.resolve(root.real, line), root, opts);
          if (shown !== null) files.push(shown);
        }
      } else {
        const rule = compileGlobRule(a.pattern, true);
        if (!rule) return errorResult('invalid_args', 'Invalid glob pattern.');
        const w = await walkFiles(root.real, { signal: ctx.signal });
        capTruncated = w.truncated;
        for (const abs of w.files) {
          const rel = path.relative(root.real, abs).split(path.sep).join('/');
          const m = rule.re.test(rel);
          if (rule.negate ? m : !m) continue;
          const shown = displayPath(abs, root, opts);
          if (shown !== null) files.push(shown);
        }
      }
      if (ctx.signal.aborted) return errorResult('cancelled', 'Cancelled.');
      files = [...new Set(files)].sort();
      if (!files.length) return okResult('No files found.');
      const shown = files.slice(0, GLOB_MAX_RESULTS);
      const cut = files.length > GLOB_MAX_RESULTS || capTruncated;
      return finishSearch(ctx, files.join('\n'), shown.join('\n'), cut, `showing ${shown.length} of ${files.length}${capTruncated ? '+' : ''} files`, {});
    },
  };
}
