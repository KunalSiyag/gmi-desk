/**
 * The host's one git exec (harness.md §8.2): every call is built by `@shared/lib/git-safe` and spawned here, with
 * the pid recorded in `git_procs` (stale-lock detection, §12.2), a timeout, an output cap and abort support.
 *
 * For `strict` calls in a user repo (`neutralizeFrom`), the filter and diff drivers named in that repo's config are
 * switched off (cached per config file mtime), so a `.gitattributes` written by the agent cannot select one.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { GmiError } from '@shared/contracts/errors';
import { buildGitInvocation, neutralizeDrivers, type GitSafeOptions } from '@shared/lib/git-safe';
import type { HostLog, Store } from '../types';

export interface GitExecDeps {
  log: HostLog;
  /** `store.gitProcs` (optional in tests). */
  procs?: Pick<Store['gitProcs'], 'add' | 'remove' | 'list'> | null;
  /** Default `process.env` (already an allowlist in the host, §5.1). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default `git` (looked up on the allowlisted PATH). */
  gitBinary?: string;
  /** Default 120 s. */
  timeoutMs?: number;
}

export interface GitRunOptions extends Omit<GitSafeOptions, 'baseEnv'> {
  /** Default: the work tree, else the git dir. */
  cwd?: string;
  stdin?: string | Buffer | null;
  /** Exit codes treated as success (default [0]). */
  okCodes?: readonly number[];
  timeoutMs?: number;
  /** stdout cap (default 64 MiB): beyond it the process is killed and the call fails. */
  maxBytes?: number;
  signal?: AbortSignal;
  threadId?: string | null;
  /** Strict calls in a user repo: neutralise the drivers named in this git dir's config (and its common dir). */
  neutralizeFrom?: { gitDir: string; commonDir: string } | null;
}

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

const STDERR_CAP = 64 * 1024;

export function gitFailure(subcommand: string, result: { code: number; stderr: string }): GmiError {
  const first = result.stderr.split('\n').find((l) => l.trim()) ?? '';
  return new GmiError('internal', `git ${subcommand} failed.`, { detail: `git_exit:${result.code}: ${first.slice(0, 300)}` });
}

export class GitExec {
  private readonly driverCache = new Map<string, { key: string; pairs: Array<[string, string]> }>();

  constructor(private readonly deps: GitExecDeps) {}

  get baseEnv(): Readonly<Record<string, string | undefined>> {
    return this.deps.env ?? process.env;
  }

  /** Runs git and resolves with the result; throws GmiError on spawn failure, timeout, abort or a non-ok exit code. */
  async run(opts: GitRunOptions): Promise<GitResult> {
    const result = await this.raw(opts);
    const ok = opts.okCodes ?? [0];
    if (!ok.includes(result.code)) throw gitFailure(opts.args[0] ?? 'call', result);
    return result;
  }

  /** stdout as UTF-8 text. */
  async text(opts: GitRunOptions): Promise<string> {
    return (await this.run(opts)).stdout.toString('utf8');
  }

  /** Like run, but never throws for an exit code. */
  async raw(opts: GitRunOptions): Promise<GitResult> {
    const extra = opts.neutralizeFrom && opts.profile === 'strict' ? await this.drivers(opts.neutralizeFrom) : [];
    const inv = buildGitInvocation({ ...opts, config: [...extra, ...(opts.config ?? [])], baseEnv: this.baseEnv });
    const cwd = opts.cwd ?? opts.workTree ?? opts.gitDir ?? undefined;
    return this.spawnGit(inv.argv, inv.env, cwd ?? undefined, opts);
  }

  async version(): Promise<string | null> {
    try {
      const out = await this.text({ profile: 'strict', gitDir: null, args: ['--version'], timeoutMs: 10_000 });
      const line = out.split('\n')[0]?.trim() ?? '';
      return line ? line.replace(/^git version\s+/i, '').slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  private async drivers(src: { gitDir: string; commonDir: string }): Promise<Array<[string, string]>> {
    const files = [join(src.commonDir, 'config'), join(src.gitDir, 'config.worktree')];
    const parts: string[] = [];
    for (const f of files) {
      try {
        const s = await stat(f);
        parts.push(`${f}:${s.mtimeMs}:${s.size}:${s.ino}`);
      } catch {
        parts.push(`${f}:-`);
      }
    }
    const key = parts.join('|');
    const cached = this.driverCache.get(src.gitDir);
    if (cached && cached.key === key) return cached.pairs;
    const result = await this.raw({
      profile: 'strict',
      gitDir: src.gitDir,
      commonDir: src.commonDir,
      args: ['config', '--name-only', '--get-regexp', '^(filter|diff)\\.'],
      okCodes: [0, 1],
      timeoutMs: 15_000,
    });
    if (result.code !== 0 && result.code !== 1) throw gitFailure('config', result);
    const pairs = neutralizeDrivers(result.stdout.toString('utf8').split('\n'));
    this.driverCache.set(src.gitDir, { key, pairs });
    return pairs;
  }

  private spawnGit(argv: string[], env: Record<string, string>, cwd: string | undefined, opts: GitRunOptions): Promise<GitResult> {
    const timeoutMs = opts.timeoutMs ?? this.deps.timeoutMs ?? 120_000;
    const maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    return new Promise<GitResult>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new GmiError('cancelled', 'The git call was cancelled.'));
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.deps.gitBinary ?? 'git', argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (cause) {
        return reject(new GmiError('internal', 'git could not be started.', { detail: 'git_spawn', cause }));
      }
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          this.deps.procs?.add(pid, opts.threadId ?? null);
        } catch (err) {
          this.deps.log.warn('git_procs add failed', { code: (err as { code?: string }).code ?? null });
        }
      }
      const out: Buffer[] = [];
      let outBytes = 0;
      let errText = '';
      let failure: GmiError | null = null;
      const kill = (err: GmiError) => {
        if (!failure) failure = err;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill(new GmiError('timeout', 'A git call took too long.', { detail: `git_timeout:${argv.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''}` })), timeoutMs);
      const onAbort = () => kill(new GmiError('cancelled', 'The git call was cancelled.'));
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxBytes) return kill(new GmiError('limit_reached', 'git output is too large.', { detail: 'git_output_cap' }));
        out.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (errText.length < STDERR_CAP) errText += chunk.toString('utf8').slice(0, STDERR_CAP - errText.length);
      });
      child.stdin!.on('error', () => undefined);
      child.on('error', (cause) => {
        if (!failure) failure = new GmiError('internal', 'git could not be started.', { detail: `git_spawn:${(cause as { code?: string }).code ?? ''}`, cause });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (pid !== undefined) {
          try {
            this.deps.procs?.remove(pid);
          } catch {
            /* the store may be closed during shutdown */
          }
        }
        if (failure) return reject(failure);
        resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: errText });
      });
      if (opts.stdin !== undefined && opts.stdin !== null) child.stdin!.end(opts.stdin);
      else child.stdin!.end();
    });
  }
}

/** Splits NUL-terminated output (`-z`). */
export function splitZ(buf: Buffer | string): string[] {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  const parts = s.split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
