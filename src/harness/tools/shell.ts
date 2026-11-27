/**
 * The `bash` tool (harness.md §8.1, §8.3). The permission engine has already decided (the loop calls `subject()`,
 * then `evaluate`, then the approval broker); this tool runs the command in the sandbox:
 *   - `readonly` profile for allowlisted read-only commands (§9.2), `exec` otherwise;
 *   - network: the app's CONNECT proxy when the call asked for it (`network: true`, approved) or in full-access; the
 *     per-command `--share-net` fallback only when the proxy is unavailable AND the call asked for it (the engine
 *     flagged `local_network` and asked);
 *   - git mounts from GitService.sandboxMounts() (fail closed: a `.git` without a thread record is read-only);
 *   - execution-sensitive files read-only unless this call's approval allowed sensitive writes, and hashed before
 *     and after the run (§8.2.6); secret files masked;
 *   - output: the live stream to the UI, the full output to the spill file, head 200 + tail 800 lines to the model
 *     (§7.3) with the spill marker.
 */
import { realpathSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { CodeThreadSettings } from '@shared/contracts/code';
import type { CallGrants } from '../perm/grants';
import { buildSandboxEnv } from '../sandbox/env';
import { findSensitivePaths, scanMaskedFiles } from '../sandbox/profiles';
import {
  harnessPaths,
  type PermissionSubject,
  type SandboxGitMounts,
  type SandboxRunResult,
  type SandboxSpec,
  type ThreadGitRecord,
  type ToolDefinition,
  type ToolResult,
  type ToolRunContext,
} from '../types';
import { classifyCommand, mentionsSecretFile } from '../perm/command';

export interface ShellArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  description: string;
  /** Ask for network for this command (package installs). Needs an approval unless the thread is in full-access. */
  network?: boolean;
}

export interface ShellToolDeps {
  /** One-shot approval options (sensitive writes), noted by the loop. */
  grants?: CallGrants;
  /** The host's own (scrubbed) env: PATH, HOME, USER, LANG … Default process.env. */
  hostEnv?: Record<string, string | undefined>;
  /** `git config user.name/email` (read by the host). */
  gitAuthor?: () => Promise<{ name: string; email: string } | null>;
  /** Project env allowlist (Settings › Code › Project › Environment) and the secret-like names main confirmed. */
  projectEnv?: (projectId: string) => { names: string[]; confirmedSecretNames: string[] };
}

export const SHELL_LIMITS = {
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  minTimeoutMs: 1_000,
  maxCommandChars: 65_536,
  headLines: 200,
  tailLines: 800,
  maxLineChars: 2_000,
  maxModelBytes: 50 * 1024,
  previewBytes: 64 * 1024,
  captureBytes: 1024 * 1024,
} as const;

const PARAMETERS = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command, run with bash in the sandbox at cwd.' },
    cwd: { type: 'string', description: 'Directory inside the worktree (relative to its root). Default: the root.' },
    timeout_ms: { type: 'integer', minimum: SHELL_LIMITS.minTimeoutMs, maximum: SHELL_LIMITS.maxTimeoutMs, description: 'Default 120000.' },
    description: { type: 'string', description: 'Five to ten words on what the command does, shown to the user.' },
    network: { type: 'boolean', description: 'Set true only when the command needs the internet (package installs). It needs the user’s approval.' },
  },
  required: ['command', 'description'],
  additionalProperties: false,
} as const;

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The cwd inside the worktree (string check here; realpath check before running). */
export function resolveCwd(worktree: string, cwd: string | undefined): string | null {
  if (cwd !== undefined && (cwd.includes('\0') || cwd.startsWith('~'))) return null;
  const p = resolve(worktree, cwd ?? '.');
  return inside(p, worktree) ? p : null;
}

function realCwd(worktree: string, cwd: string): string | null {
  try {
    const wt = realpathSync(worktree);
    const c = realpathSync(cwd);
    return inside(c, wt) ? c : null;
  } catch {
    return null;
  }
}

/** §7.3 shell truncation: head 200 + tail 800 lines, ≤ 2,000 characters per line, ≤ 50 KiB. */
export function truncateShellOutput(text: string, spillId: string | null, totalBytes: number, captureTruncated: boolean): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const clip = (l: string) => (l.length > SHELL_LIMITS.maxLineChars ? `${l.slice(0, SHELL_LIMITS.maxLineChars)} [… line truncated]` : l);
  const n = lines.length;
  const fmt = (x: number) => x.toLocaleString('en-US');
  let out: string;
  let truncated = captureTruncated;
  if (n > SHELL_LIMITS.headLines + SHELL_LIMITS.tailLines) {
    truncated = true;
    const head = lines.slice(0, SHELL_LIMITS.headLines).map(clip);
    const tail = lines.slice(n - SHELL_LIMITS.tailLines).map(clip);
    const marker = `[showing lines 1-${fmt(SHELL_LIMITS.headLines)} and ${fmt(n - SHELL_LIMITS.tailLines + 1)}-${fmt(n)} of ${fmt(n)}${spillId ? `; full output: spill:${spillId} (use read on it)` : ''}]`;
    out = [...head, marker, ...tail].join('\n');
  } else {
    out = lines.map(clip).join('\n');
    if (lines.some((l) => l.length > SHELL_LIMITS.maxLineChars)) truncated = true;
  }
  if (Buffer.byteLength(out) > SHELL_LIMITS.maxModelBytes) {
    truncated = true;
    const half = Math.floor(SHELL_LIMITS.maxModelBytes / 2);
    const buf = Buffer.from(out);
    out = `${buf.subarray(0, half).toString('utf8')}\n[… output truncated${spillId ? `; full output: spill:${spillId} (use read on it)` : ''} …]\n${buf.subarray(buf.length - half).toString('utf8')}`;
  } else if (captureTruncated && spillId) {
    out = `${out}\n[output exceeded ${fmt(totalBytes)} bytes; full output: spill:${spillId} (use read on it)]`;
  }
  return { text: out, truncated };
}

function recordOf(ctx: ToolRunContext): ThreadGitRecord | null {
  const t = ctx.store.threads.get(ctx.threadId);
  if (!t || !t.worktreePath || !t.gitDir || !t.commonDir) return null;
  const p = ctx.store.projects.get(t.projectId);
  return {
    threadId: t.id,
    projectId: t.projectId,
    strategy: t.strategy,
    projectRoot: p?.rootPath ?? t.worktreePath,
    worktreePath: t.worktreePath,
    gitDir: t.gitDir,
    commonDir: t.commonDir,
    gitPointer: t.gitPointer,
    objectDir: t.objectDir,
    branch: t.branch,
    baseRef: t.baseRef,
    baseSha: t.baseSha,
    refFormat: p?.refFormat ?? 'files',
  };
}

function fail(kind: ToolResult['errorKind'], message: string): ToolResult {
  return { ok: false, errorKind: kind, content: message, preview: { text: message, truncated: false, totalBytes: Buffer.byteLength(message), spillId: null } };
}

function changedHashes(before: Record<string, string | null>, after: Record<string, string | null>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => (before[k] ?? null) !== (after[k] ?? null)).sort();
}

export function networkFor(args: Pick<ShellArgs, 'network'>, settings: Pick<CodeThreadSettings, 'mode'>, proxyState: 'proxy' | 'shared_per_command' | 'none'): SandboxSpec['network'] {
  if (args.network === true) return proxyState === 'proxy' ? 'proxy' : 'shared';
  if (settings.mode === 'full-access' && proxyState === 'proxy') return 'proxy';
  return 'off';
}

/** Words of a command line, split on blanks, quotes and shell operators (for the secret-name check only). */
function commandWords(command: string): string[] {
  return command.split(/[\s;&|()<>`'"]+/).filter(Boolean);
}

export function createShellTool(deps: ShellToolDeps = {}): ToolDefinition<ShellArgs> {
  const hostEnv = deps.hostEnv ?? process.env;
  return {
    name: 'bash',
    description:
      'Run a shell command in the sandboxed worktree (bash, no network unless approved, a fresh HOME every time). Use for builds, tests, git and file listing; prefer the read/edit tools for files.',
    parameters: PARAMETERS as unknown as Record<string, unknown>,
    class: 'shell',
    parse(raw) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'arguments must be an object' };
      const r = raw as Record<string, unknown>;
      if (typeof r.command !== 'string' || r.command.trim() === '') return { ok: false, error: '`command` must be a non-empty string' };
      if (r.command.length > SHELL_LIMITS.maxCommandChars || r.command.includes('\0')) return { ok: false, error: '`command` is too long or contains NUL' };
      if (r.cwd !== undefined && typeof r.cwd !== 'string') return { ok: false, error: '`cwd` must be a string' };
      if (r.timeout_ms !== undefined && (typeof r.timeout_ms !== 'number' || !Number.isFinite(r.timeout_ms))) return { ok: false, error: '`timeout_ms` must be a number' };
      if (r.network !== undefined && typeof r.network !== 'boolean') return { ok: false, error: '`network` must be a boolean' };
      const description = typeof r.description === 'string' ? r.description.slice(0, 200) : '';
      const timeout = Math.min(SHELL_LIMITS.maxTimeoutMs, Math.max(SHELL_LIMITS.minTimeoutMs, Math.floor((r.timeout_ms as number | undefined) ?? SHELL_LIMITS.defaultTimeoutMs)));
      return {
        ok: true,
        args: { command: r.command, ...(r.cwd !== undefined ? { cwd: r.cwd as string } : {}), timeout_ms: timeout, description, ...(r.network === true ? { network: true } : {}) },
      };
    },
    readOnly: (args) => args.network !== true && classifyCommand(args.command).readOnly,
    mutates: (args) => !(args.network !== true && classifyCommand(args.command).readOnly),
    title: (args) => (args.description || args.command).slice(0, 120),
    subject(args, ctx): PermissionSubject {
      // Review H2: secret masks are best effort. A command naming a secret file, or one in a worktree too large to
      // scan completely, asks (secret_path) instead of running read-only without a prompt.
      const secretRisk = (a: ShellArgs, c: ToolRunContext): boolean => {
        if (mentionsSecretFile(commandWords(a.command))) return true;
        return !scanMaskedFiles(realCwd(c.worktree, c.worktree) ?? c.worktree).complete;
      };
      const cwd = resolveCwd(ctx.worktree, args.cwd);
      return {
        tool: 'bash',
        kind: args.network === true ? 'network' : 'command',
        title: (args.description || args.command).slice(0, 120),
        command: args.command,
        cwd: cwd ?? args.cwd ?? ctx.worktree,
        risk: [...(cwd === null ? (['outside_worktree'] as const) : []), ...(secretRisk(args, ctx) ? (['secret_path'] as const) : [])],
      };
    },
    async run(args, ctx) {
      const asked = resolveCwd(ctx.worktree, args.cwd);
      const cwd = asked === null ? null : realCwd(ctx.worktree, asked);
      if (cwd === null) return fail('invalid_args', '`cwd` must be an existing directory inside the worktree.');
      const wt = realCwd(ctx.worktree, ctx.worktree) ?? ctx.worktree;
      const settings = ctx.settings;
      if (args.network === true && settings.network === 'off' && settings.mode !== 'full-access') return fail('denied', 'Network is off for this thread. Ask the user to allow network in the thread settings.');
      const state = ctx.sandbox.state();
      const network = networkFor(args, settings, state.network);
      const cls = ctx.perm.classifyCommand(args.command);
      const profile = cls.readOnly && network === 'off' && state.ok ? 'readonly' : 'exec';

      const record = recordOf(ctx);
      let git: SandboxGitMounts | null = null;
      if (record) {
        try {
          git = await ctx.git.sandboxMounts(record);
        } catch (e) {
          return fail('execution', `Git metadata check failed: ${(e as Error).message}`);
        }
      } else {
        // No thread record: still never let the sandbox write a `.git` inside the worktree.
        git = { readOnly: [resolve(wt, '.git')].filter(existsQuiet), writable: [], env: {}, perThreadRefs: false };
      }
      const taken = deps.grants?.take(ctx.call.id) ?? { sensitiveWrites: false };
      // The loop passes the allow_once option on the run context (ToolRunContext.sensitiveWrites); grants are the
      // older path, kept for callers that note decisions themselves.
      const grant = { sensitiveWrites: taken.sensitiveWrites || ctx.sensitiveWrites === true };
      // The readonly profile cannot change anything: no hashing around it.
      const before = record && profile === 'exec' ? await ctx.git.sensitiveHashes(record).catch(() => null) : null;
      const author = (await deps.gitAuthor?.().catch(() => null)) ?? null;
      const proj = deps.projectEnv?.(ctx.projectId) ?? { names: [], confirmedSecretNames: [] };
      const home = hostEnv.HOME && hostEnv.HOME.startsWith('/') ? hostEnv.HOME : '/tmp/home';
      const paths = harnessPaths(ctx.dataDir);
      const cacheDir = profile === 'exec' ? paths.cacheDir(ctx.threadId) : null;
      const spec: SandboxSpec = {
        profile,
        threadId: ctx.threadId,
        command: args.command,
        cwd,
        worktree: wt,
        git,
        sensitivePaths: await sensitivePathsFor(ctx, record, wt),
        sensitiveWrites: grant.sensitiveWrites,
        // Rescanned at run time: files may have changed while the call waited for approval.
        maskedFiles: scanMaskedFiles(wt).files,
        network: profile === 'readonly' ? 'off' : network,
        cacheDir,
        env: buildSandboxEnv({ hostEnv, home, cacheDir, gitEnv: git?.env, gitAuthor: author, network: profile === 'readonly' ? 'off' : network, projectNames: proj.names, confirmedSecretNames: proj.confirmedSecretNames }),
        timeoutMs: args.timeout_ms ?? SHELL_LIMITS.defaultTimeoutMs,
      };
      const spillFile = paths.spillFile(ctx.threadId, ctx.call.id);
      let res: SandboxRunResult;
      try {
        res = await ctx.sandbox.run(spec, { signal: ctx.signal, onOutput: (c) => ctx.emitOutput(c), spillFile, maxCaptureBytes: SHELL_LIMITS.captureBytes });
      } catch (e) {
        return fail('execution', `The command could not run: ${(e as Error).message}`);
      }
      const after = record && before ? await ctx.git.sensitiveHashes(record).catch(() => null) : null;
      const sensitiveChanged = before && after ? changedHashes(before, after) : [];
      // Review H2: reported in `effects.sensitiveChanged`; the loop shows it as a public notice item (an internal event
      // here took a thread_seq the renderer never saw, so it refetched the timeline).

      const lineCount = res.output.split('\n').length;
      const needsSpill = res.outputTruncated || lineCount > SHELL_LIMITS.headLines + SHELL_LIMITS.tailLines || Buffer.byteLength(res.output) > SHELL_LIMITS.maxModelBytes;
      const spillId = needsSpill ? ctx.call.id : null;
      if (!needsSpill) rmSync(spillFile, { force: true });
      const body = truncateShellOutput(res.output, spillId, res.outputBytes, res.outputTruncated);
      const status = res.timedOut
        ? `[timed out after ${Math.round(spec.timeoutMs / 1000)} s; the process group was killed]`
        : res.cancelled
          ? '[cancelled]'
          : res.exitCode === null
            ? `[killed by ${res.signal ?? 'a signal'}]`
            : `[exit code ${res.exitCode}]`;
      const notes: string[] = [];
      if (!state.ok) notes.push('[ran without a sandbox: the OS sandbox is unavailable]');
      if (sensitiveChanged.length) notes.push(`[execution-sensitive files changed: ${sensitiveChanged.slice(0, 10).join(', ')}]`);
      const content = [body.text, status, ...notes].filter((s) => s.length > 0).join('\n');
      const previewText = Buffer.from(res.output).subarray(0, SHELL_LIMITS.previewBytes).toString('utf8');
      return {
        ok: !res.timedOut && !res.cancelled && res.exitCode === 0,
        errorKind: res.timedOut ? 'timeout' : res.cancelled ? 'cancelled' : null,
        content,
        exitCode: res.exitCode,
        spillId,
        preview: { text: previewText, truncated: body.truncated || res.outputBytes > SHELL_LIMITS.previewBytes, totalBytes: res.outputBytes, spillId, exitCode: res.exitCode },
        effects: { command: args.command, ...(sensitiveChanged.length ? { changedPaths: sensitiveChanged, sensitiveChanged: sensitiveChanged.slice(0, 50) } : {}) },
      };
    },
  };
}

/**
 * §8.2.6 read-only binds: the fixed list plus the repo's in-repo `core.hooksPath` dir (review H2: `.githooks/` was
 * writable while `.husky/` was not) and whatever the git service lists for the thread.
 */
async function sensitivePathsFor(ctx: ToolRunContext, record: ThreadGitRecord | null, wt: string): Promise<string[]> {
  if (!record) return findSensitivePaths(wt);
  const hooksPath = (await ctx.git.hooksPath?.(record).catch(() => null)) ?? null;
  const listed = (await ctx.git.listSensitivePaths?.(record).catch(() => [] as string[])) ?? [];
  return [...new Set([...findSensitivePaths(wt, hooksPath ? [hooksPath] : []), ...listed])];
}

function existsQuiet(p: string): boolean {
  try {
    realpathSync(p);
    return true;
  } catch {
    return false;
  }
}
