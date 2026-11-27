/**
 * Search core and the `grep` tool (harness.md §8.1, §8.2 "Host-side ripgrep", threat H-T16).
 *
 * Host-side ripgrep uses a fixed argv only:
 *   rg --no-config --json [-i] [-C <n>] [-g <glob>]… -e <pattern> -- <path>
 *   rg --no-config --files [-g <glob>]… -- <path>
 * with RIPGREP_CONFIG_PATH absent from the env (the env is an allowlist). The pattern goes only after `-e`, globs
 * only after `-g`, paths only after `--` (and are absolute, checked paths), so a pattern such as `--pre=sh` stays a
 * pattern. When the sandbox works, rg runs in its `readonly` profile (§8.3); otherwise it is spawned directly
 * (argv array, no shell). Results in denied files (§8.2.5) are dropped; secret files are also excluded with
 * host-chosen `-g !<glob>` values. Without rg, a JS walker (gitignore-aware) and JS regexes do the same.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkPath, hardDenyReason, isInside, type PathPolicyOptions, type ResolvedPath } from '../sandbox/paths';
import type { ParsedArgs, PermissionSubject, SandboxSpec, ToolDefinition, ToolResult, ToolRunContext } from '../types';
import { deniedRisk, objectArgs, optInt, policyOf, reqString, type PolicyDeps } from './fs';
import { errorResult, okResult, OUTPUT_LIMITS, previewOf, spillRef, writeSpill } from './output';

// ─── ripgrep discovery and argv ───────────────────────────────────────────────────────────────────────────────

/** The absolute path of `rg` on PATH (absolute entries only), or null. */
export function findRipgrep(envPath: string | undefined = process.env.PATH): string | null {
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, exe);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // next
    }
  }
  return null;
}

/** Excluded from content searches (host-chosen values after `-g`): the secret-file names of §8.2.5. */
export const SECRET_EXCLUDE_GLOBS = ['!.env', '!.env.*', '!*.pem', '!*.key', '!id_rsa*', '!id_ed25519*', '!.npmrc', '!.netrc', '!.pypirc', '!.git-credentials'] as const;

export interface GrepArgvInput {
  pattern: string;
  searchPath: string;
  ignoreCase?: boolean;
  context?: number;
  globs?: readonly string[];
}

/** `rg --no-config --json [-i] [-C <n>] [-g <glob>]… -e <pattern> -- <path>` (without the rg binary). */
export function grepArgv(i: GrepArgvInput): string[] {
  const argv = ['--no-config', '--json'];
  if (i.ignoreCase) argv.push('-i');
  if (i.context !== undefined && i.context > 0) argv.push('-C', String(Math.min(5, Math.max(0, Math.floor(i.context)))));
  for (const g of i.globs ?? []) argv.push('-g', g);
  argv.push('-e', i.pattern, '--', i.searchPath);
  return argv;
}

/** `rg --no-config --files [-g <glob>]… -- <path>`. */
export function filesArgv(searchPath: string, globs: readonly string[] = []): string[] {
  const argv = ['--no-config', '--files'];
  for (const g of globs) argv.push('-g', g);
  argv.push('--', searchPath);
  return argv;
}

/** The allowlisted env of a host-side rg (no RIPGREP_CONFIG_PATH, nothing secret). */
export function ripgrepEnv(rgPath: string): Record<string, string> {
  const dirs = [path.dirname(rgPath), '/usr/local/bin', '/usr/bin', '/bin'];
  return { PATH: [...new Set(dirs)].join(path.delimiter), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1' };
}

export interface ProcessResult {
  stdout: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  sandboxed: boolean;
}

export const SEARCH_TIMEOUT_MS = 30_000;
export const SEARCH_CAPTURE_BYTES = 8 * 1024 * 1024;

function sandboxUsable(ctx: ToolRunContext): boolean {
  const st = ctx.sandbox.state();
  return st.ok && st.kind !== 'none';
}

/** Runs rg with a fixed argv: in the `readonly` sandbox profile when it works, else spawned directly. */
export async function runRipgrep(ctx: ToolRunContext, rgPath: string, args: string[], cwd: string): Promise<ProcessResult> {
  const env = ripgrepEnv(rgPath);
  if (sandboxUsable(ctx)) {
    const spec: SandboxSpec = {
      profile: 'readonly',
      threadId: ctx.threadId,
      argv: [rgPath, ...args],
      cwd,
      worktree: ctx.worktree,
      git: null,
      sensitivePaths: [],
      sensitiveWrites: false,
      maskedFiles: [],
      network: 'off',
      cacheDir: null,
      env,
      timeoutMs: SEARCH_TIMEOUT_MS,
    };
    const r = await ctx.sandbox.run(spec, { signal: ctx.signal, maxCaptureBytes: SEARCH_CAPTURE_BYTES });
    return { stdout: r.output, exitCode: r.exitCode, truncated: r.outputTruncated, timedOut: r.timedOut, cancelled: r.cancelled, sandboxed: true };
  }
  return spawnCapture(rgPath, args, cwd, env, ctx.signal, SEARCH_TIMEOUT_MS, SEARCH_CAPTURE_BYTES);
}

/** argv-array spawn (no shell), own process group, killed on abort, timeout or capture overflow. */
export function spawnCapture(file: string, args: string[], cwd: string, env: Record<string, string>, signal: AbortSignal, timeoutMs: number, maxBytes: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ stdout: '', exitCode: null, truncated: false, timedOut: false, cancelled: true, sandboxed: false });
      return;
    }
    const detached = process.platform !== 'win32';
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached, windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    const kill = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 2_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (b: Buffer) => {
      if (truncated) return;
      if (bytes + b.length > maxBytes) {
        chunks.push(b.subarray(0, maxBytes - bytes));
        bytes = maxBytes;
        truncated = true;
        kill();
        return;
      }
      chunks.push(b);
      bytes += b.length;
    });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: code, truncated, timedOut, cancelled, sandboxed: false });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

// ─── gitignore / glob matching and the JS walker (rg fallback) ──────────────────────────────────────────────

/** A gitignore-style glob as a regex source (`**`, `*`, `?`, `[…]`; `{a,b}` when `braces`). */
export function globToRegexSource(glob: string, braces = false): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        if (glob[i + 2] === '/' && atStart) {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close === -1) out += '\\[';
      else {
        let body = glob.slice(i + 1, close);
        let neg = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          neg = true;
          body = body.slice(1);
        }
        out += `[${neg ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/]/g, '\\]')}]`;
        i = close;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      out += (glob[i + 1] as string).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 1;
    } else if (braces && c === '{') {
      depth += 1;
      out += '(?:';
    } else if (braces && c === '}' && depth > 0) {
      depth -= 1;
      out += ')';
    } else if (braces && c === ',' && depth > 0) out += '|';
    else out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  while (depth-- > 0) out += ')';
  return out;
}

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}

/** One gitignore-style pattern (no slash → any depth; a leading or inner slash → anchored to the base). */
export function compileGlobRule(raw: string, braces = false): IgnoreRule | null {
  let p = raw;
  let negate = false;
  if (p.startsWith('!')) {
    negate = true;
    p = p.slice(1);
  } else if (p.startsWith('\\!') || p.startsWith('\\#')) p = p.slice(1);
  let dirOnly = false;
  if (p.endsWith('/') && p.length > 1) {
    dirOnly = true;
    p = p.replace(/\/+$/, '');
  }
  if (!p) return null;
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  const body = globToRegexSource(p, braces);
  try {
    return { negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) };
  } catch {
    return null;
  }
}

export function compileIgnoreFile(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/(?<!\\)\s+$/, '');
    if (!t || t.startsWith('#')) continue;
    const r = compileGlobRule(t);
    if (r) rules.push(r);
  }
  return rules;
}

/** Last matching rule wins; returns null when no rule matched. */
export function matchRules(rules: readonly IgnoreRule[], rel: string, isDir: boolean): boolean | null {
  let result: boolean | null = null;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) result = !r.negate;
  }
  return result;
}

export interface WalkResult {
  /** Absolute paths of regular files. */
  files: string[];
  truncated: boolean;
}

/**
 * rg-like file walk: skips hidden entries, `.git`, symlinks, and what `.gitignore` files ignore (root and nested).
 */
export async function walkFiles(root: string, opts: { signal: AbortSignal; maxFiles?: number; maxDepth?: number }): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? 100_000;
  const maxDepth = opts.maxDepth ?? 64;
  const files: string[] = [];
  let truncated = false;
  const st = await fs.promises.lstat(root);
  if (st.isFile()) return { files: [root], truncated: false };
  const stack: Array<{ base: string; rules: IgnoreRule[] }> = [];
  const ignored = (abs: string, isDir: boolean): boolean => {
    let res = false;
    for (const s of stack) {
      const rel = path.relative(s.base, abs).split(path.sep).join('/');
      const m = matchRules(s.rules, rel, isDir);
      if (m !== null) res = m;
    }
    return res;
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (opts.signal.aborted || truncated || depth > maxDepth) return;
    let rules: IgnoreRule[] = [];
    try {
      rules = compileIgnoreFile(await fs.promises.readFile(path.join(dir, '.gitignore'), 'utf8'));
    } catch {
      rules = [];
    }
    stack.push({ base: dir, rules });
    try {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!ignored(abs, true)) await walk(abs, depth + 1);
        } else if (e.isFile()) {
          if (ignored(abs, false)) continue;
          if (files.length >= maxFiles) {
            truncated = true;
            return;
          }
          files.push(abs);
        }
        if (truncated) return;
      }
    } finally {
      stack.pop();
    }
  };
  await walk(root, 0);
  return { files, truncated };
}

// ─── Shared result plumbing ───────────────────────────────────────────────────────────────────────────────────

export interface SearchDeps extends PolicyDeps {
  /** Absolute path of rg (from `findRipgrep()` at host start), or null for the JS fallback. */
  ripgrep: string | null;
}

/** A checked search root (file or directory; default the worktree). */
export function searchRoot(input: string | undefined, opts: PathPolicyOptions): { ok: true; path: ResolvedPath } | { ok: false; result: ToolResult } {
  const c = checkPath(input ?? '.', 'read', opts);
  if (!c.ok) return { ok: false, result: errorResult(c.code === 'invalid' ? 'execution' : 'denied', c.reason) };
  if (!c.path.exists) return { ok: false, result: errorResult('execution', `${input ?? '.'} does not exist.`) };
  return { ok: true, path: c.path };
}

/** Readable result path (inside the root, not hard-denied) → its display path relative to the worktree, else null. */
export function displayPath(abs: string, root: ResolvedPath, opts: PathPolicyOptions): string | null {
  const platform = opts.platform ?? process.platform;
  if (!isInside(root.rootReal, abs, platform)) return null;
  if (hardDenyReason(abs, 'read', opts)) return null;
  return path.relative(root.rootReal, abs).split(path.sep).join('/') || '.';
}

/** Full text → the model's text (cut at `limitText`) and a spill when anything was cut. */
export async function finishSearch(ctx: ToolRunContext, full: string, shown: string, cut: boolean, marker: string, effects: ToolResult['effects']): Promise<ToolResult> {
  if (!cut) return okResult(full, { effects });
  let spillId: string | null = null;
  try {
    spillId = await writeSpill(ctx.dataDir, ctx.threadId, ctx.call.id, full);
  } catch {
    spillId = null;
  }
  const where = spillId ? `; full results: ${spillRef(spillId)} (use read on it)` : '';
  const content = `${shown}\n[${marker}${where}]`;
  return { ok: true, errorKind: null, content, preview: previewOf(full, spillId, true), spillId, effects };
}

export function searchSubject(tool: string, title: string, input: string | undefined, ctx: ToolRunContext, deps: PolicyDeps): PermissionSubject {
  const c = checkPath(input ?? '.', 'read', policyOf(ctx, deps));
  if (!c.ok) return { tool, kind: 'file-read', title, ...(c.abs ? { paths: [c.abs] } : {}), risk: deniedRisk(c.code) };
  return { tool, kind: 'file-read', title, paths: [c.path.real], risk: [] };
}

// ─── grep ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  context?: number;
}

export const GREP_LIMITS = { maxMatches: 200, maxBytes: OUTPUT_LIMITS.maxBytes, maxLineChars: 500 } as const;

interface Hit {
  file: string;
  line: number;
  text: string;
  match: boolean;
}

function cutLine(t: string): string {
  const s = t.replace(/\r?\n$/, '').replace(/\r$/, '');
  return s.length > GREP_LIMITS.maxLineChars ? `${s.slice(0, GREP_LIMITS.maxLineChars)} …` : s;
}

/** Parses `rg --json` output (other lines, e.g. stderr in a sandbox's combined output, are ignored). */
export function parseRgJson(stdout: string): Array<{ path: string; line: number; text: string; match: boolean }> {
  const out: Array<{ path: string; line: number; text: string; match: boolean }> = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    if (ev.type !== 'match' && ev.type !== 'context') continue;
    const p = ev.data?.path?.text;
    const t = ev.data?.lines?.text;
    const n = ev.data?.line_number;
    if (typeof p !== 'string' || typeof t !== 'string' || typeof n !== 'number') continue;
    out.push({ path: p, line: n, text: t, match: ev.type === 'match' });
  }
  return out;
}

function formatHits(hits: Hit[], maxMatches: number, maxBytes: number): { text: string; matches: number; files: number; cut: boolean } {
  const out: string[] = [];
  let matches = 0;
  let bytes = 0;
  let cut = false;
  let curFile: string | null = null;
  let lastLine = -1;
  const files = new Set<string>();
  for (const h of hits) {
    if (h.match && matches >= maxMatches) {
      cut = true;
      break;
    }
    const lines: string[] = [];
    if (h.file !== curFile) {
      lines.push(h.file);
      curFile = h.file;
      lastLine = -1;
    } else if (lastLine !== -1 && h.line > lastLine + 1) lines.push('  --');
    lines.push(`  ${h.line}${h.match ? ':' : '-'} ${cutLine(h.text)}`);
    const b = lines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
    if (bytes + b > maxBytes && out.length) {
      cut = true;
      break;
    }
    out.push(...lines);
    bytes += b;
    lastLine = h.line;
    if (h.match) {
      matches += 1;
      files.add(h.file);
    }
  }
  return { text: out.join('\n'), matches, files: files.size, cut };
}

const JS_MAX_LINE = 10_000;

async function jsGrep(root: ResolvedPath, a: GrepArgs, ctx: ToolRunContext, opts: PathPolicyOptions): Promise<{ hits: Hit[]; truncated: boolean } | { error: string }> {
  let re: RegExp;
  try {
    re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
  } catch (err) {
    return { error: `Invalid regular expression: ${(err as Error).message}` };
  }
  const walk = await walkFiles(root.real, { signal: ctx.signal });
  const globRule = a.glob ? compileGlobRule(a.glob, true) : null;
  const ctxN = a.context ?? 0;
  const hits: Hit[] = [];
  let matchCount = 0;
  let n = 0;
  for (const abs of walk.files) {
    if (ctx.signal.aborted) break;
    // Yield to the event loop between files (§5.1: no long synchronous blocks on the host).
    if (++n % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const shown = displayPath(abs, root, opts);
    if (shown === null) continue;
    if (globRule) {
      const relToSearch = path.relative(root.isDirectory ? root.real : path.dirname(root.real), abs).split(path.sep).join('/');
      const m = globRule.re.test(relToSearch);
      if (globRule.negate ? m : !m) continue;
    }
    let buf: Buffer;
    try {
      const st = await fs.promises.lstat(abs);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) continue;
      buf = await fs.promises.readFile(abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const keep = new Map<number, boolean>();
    for (let i = 0; i < lines.length; i += 1) {
      // Very long lines are skipped: a JS regex has no time limit (rg, when present, is used instead).
      if ((lines[i] as string).length > JS_MAX_LINE || !re.test(lines[i] as string)) continue;
      keep.set(i, true);
      for (let k = Math.max(0, i - ctxN); k <= Math.min(lines.length - 1, i + ctxN); k += 1) if (!keep.has(k)) keep.set(k, false);
    }
    for (const i of [...keep.keys()].sort((x, y) => x - y)) {
      const match = keep.get(i) as boolean;
      hits.push({ file: shown, line: i + 1, text: lines[i] as string, match });
      if (match) matchCount += 1;
    }
    if (matchCount > 5_000) return { hits, truncated: true };
  }
  return { hits, truncated: walk.truncated };
}

export function createGrepTool(deps: SearchDeps): ToolDefinition<GrepArgs> {
  return {
    name: 'grep',
    description:
      'Search file contents with a regular expression (ripgrep syntax), respecting .gitignore. Returns matching lines grouped by file with line numbers (at most 200 matches). Optional: path (file or directory), glob (e.g. "*.ts" or "src/**/*.py"), ignore_case, context (0-5 lines).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'File or directory relative to the worktree root. Default: the root.' },
        glob: { type: 'string', description: 'Only search files matching this glob.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        context: { type: 'integer', minimum: 0, maximum: 5, description: 'Lines of context around each match.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    class: 'read',
    parse(raw): ParsedArgs<GrepArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      const pat = reqString(o.pattern, 'pattern', { max: 2_000 });
      if (!pat.ok) return pat;
      const args: GrepArgs = { pattern: pat.value };
      if (o.path !== undefined && o.path !== null) {
        const p = reqString(o.path, 'path', { max: 4096 });
        if (!p.ok) return p;
        args.path = p.value;
      }
      if (o.glob !== undefined && o.glob !== null) {
        const g = reqString(o.glob, 'glob', { max: 500 });
        if (!g.ok) return g;
        args.glob = g.value;
      }
      if (o.ignore_case !== undefined && o.ignore_case !== null) {
        if (typeof o.ignore_case !== 'boolean') return { ok: false, error: 'ignore_case must be a boolean.' };
        args.ignore_case = o.ignore_case;
      }
      const c = optInt(o.context, 'context', 0, 5);
      if (!c.ok) return c;
      if (c.value !== undefined) args.context = c.value;
      return { ok: true, args };
    },
    readOnly: () => true,
    mutates: () => false,
    title: (a) => `Grep ${JSON.stringify(a.pattern).slice(0, 80)}${a.path ? ` in ${a.path}` : ''}`,
    subject: (a, ctx) => searchSubject('grep', `Grep ${JSON.stringify(a.pattern).slice(0, 80)}`, a.path, ctx, deps),
    async run(a, ctx): Promise<ToolResult> {
      const opts = policyOf(ctx, deps);
      const r = searchRoot(a.path, opts);
      if (!r.ok) return r.result;
      const root = r.path;
      let hits: Hit[];
      let capTruncated = false;
      if (deps.ripgrep) {
        const globs = [...(a.glob ? [a.glob] : []), ...SECRET_EXCLUDE_GLOBS];
        const cwd = root.isDirectory ? root.real : path.dirname(root.real);
        const argv = grepArgv({ pattern: a.pattern, searchPath: root.real, ignoreCase: a.ignore_case ?? false, globs, ...(a.context !== undefined ? { context: a.context } : {}) });
        const res = await runRipgrep(ctx, deps.ripgrep, argv, cwd);
        if (res.cancelled) return errorResult('cancelled', 'Cancelled.');
        if (res.timedOut) return errorResult('timeout', `The search timed out after ${SEARCH_TIMEOUT_MS / 1000} s; narrow the path or the pattern.`);
        const parsed = parseRgJson(res.stdout);
        if (res.exitCode === 2 && parsed.length === 0) {
          const msg = res.stdout.split('\n').find((l) => l && !l.startsWith('{'));
          return errorResult('execution', `rg failed${msg ? `: ${msg.slice(0, 300)}` : ' (invalid pattern?)'}.`);
        }
        capTruncated = res.truncated;
        hits = [];
        for (const h of parsed) {
          const shown = displayPath(path.resolve(cwd, h.path), root, opts);
          if (shown !== null) hits.push({ file: shown, line: h.line, text: h.text, match: h.match });
        }
      } else {
        const js = await jsGrep(root, a, ctx, opts);
        if ('error' in js) return errorResult('execution', js.error);
        if (ctx.signal.aborted) return errorResult('cancelled', 'Cancelled.');
        hits = js.hits;
        capTruncated = js.truncated;
      }
      const effects = { readPaths: [...new Set(hits.filter((h) => h.match).map((h) => h.file))] };
      if (!hits.some((h) => h.match)) return okResult('No matches.', { effects: { readPaths: [] } });
      const full = formatHits(hits, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      const shown = formatHits(hits, GREP_LIMITS.maxMatches, GREP_LIMITS.maxBytes);
      const cut = shown.cut || capTruncated;
      const total = `${full.matches}${capTruncated ? '+' : ''}`;
      return finishSearch(ctx, full.text, shown.text, cut, `showing ${shown.matches} of ${total} matching lines in ${full.files} files`, effects);
    },
  };
}
