/**
 * git-safe: the argv and env builder for every git call the host (and main's project checks) makes
 * (harness.md §8.2, review finding SC-1, threat H-T5 / H-T16).
 *
 * Pure (no Node imports): it is shared by the harness host, main and, through tsconfig.web, type-checked for the
 * renderer too. The process is spawned by `src/harness/git/exec.ts` (host) or by main's own exec.
 *
 * Rules it enforces:
 * - The git dir, common dir and work tree come from the caller's record and are passed explicitly
 *   (`--git-dir`, `GIT_COMMON_DIR`, `--work-tree`), never discovered. They must be absolute.
 * - Always: system config and system attributes off, no terminal prompt, literal pathspecs, no replace objects, no
 *   optional locks, and the fixed `-c` list below (fsmonitor, hooks, attributes file, external diff, pager, signing,
 *   credential helpers, file protocol, ssh command, auto gc, submodule recursion).
 * - `strict` (checkpoint, diff, apply, ref guard, status, object import): global config off too
 *   (`GIT_CONFIG_GLOBAL=/dev/null`), identity from env, and the caller adds the repo's own filter / textconv
 *   drivers to `config` to neutralise them.
 * - `repo` (worktree add / remove, branch refs): the user's global config is kept (LFS smudge on checkout), signing off.
 * - `user` (commit and merge, user actions in Review): the user's global config and signing are kept; main lists the
 *   repo-local keys that can run code before them (`execCapableKeys`).
 * - Values never become options: paths go after `--`; `assertGitValue` rejects values that start with `-`.
 * - The env is an allowlist built from `baseEnv`; every inherited `GIT_*` variable is dropped.
 */
import { GmiError } from '../contracts/errors';

export type GitSafeProfile = 'strict' | 'repo' | 'user';

/** The `-c` overrides on every call (§8.2 "Always", plus submodule recursion, maintenance and editors). */
export const GIT_SAFE_CONFIG: readonly string[] = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.attributesFile=/dev/null',
  'diff.external=',
  'core.pager=cat',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'gpg.program=false',
  'credential.helper=',
  'protocol.file.allow=never',
  'core.sshCommand=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'core.askPass=',
  'core.editor=false',
  'sequence.editor=false',
];

/** Signing stays the user's own for commit and merge (§8.2): these are dropped from the `user` profile. */
const SIGNING_OVERRIDES = new Set(['commit.gpgSign=false', 'tag.gpgSign=false', 'gpg.program=false']);

/** Inherited names every profile keeps (values only from `baseEnv`). */
const BASE_ENV_NAMES = ['HOME', 'USER', 'LOGNAME', 'TZ', 'TMPDIR'] as const;
/** Where git finds the user's global config (`repo` and `user` profiles). */
const GLOBAL_CONFIG_ENV_NAMES = ['XDG_CONFIG_HOME'] as const;
/** gpg / ssh signing and pinentry (`user` profile only). */
const SIGNING_ENV_NAMES = ['GNUPGHOME', 'SSH_AUTH_SOCK', 'GPG_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const;

export const CHECKPOINT_IDENTITY = { name: 'GMI Desk', email: 'gmi-desk@localhost' } as const;

export interface GitIdentity {
  name: string;
  email: string;
  /** Git date (`@<unix seconds> +0000`); default: git's clock. */
  date?: string;
}

export interface GitSafeOptions {
  profile: GitSafeProfile;
  /** Absolute; from the record. Null only for `init`, `--version` and the project probe (`rev-parse` in a user-picked root). */
  gitDir: string | null;
  /** Absolute; sets GIT_COMMON_DIR so `<gitDir>/commondir` is never read. */
  commonDir?: string | null;
  /** Absolute; `--work-tree`. */
  workTree?: string | null;
  /** Subcommand and its options, built by our code. Interpolated values must pass `assertGitValue` first. */
  args: readonly string[];
  /** Literal paths after `--` (GIT_LITERAL_PATHSPECS=1). Values starting with `-` are refused anyway. */
  paths?: readonly string[];
  /** GIT_INDEX_FILE. */
  indexFile?: string | null;
  /** GIT_OBJECT_DIRECTORY. */
  objectDir?: string | null;
  /** GIT_ALTERNATE_OBJECT_DIRECTORIES. */
  alternates?: readonly string[];
  /** Extra command-scope config passed as GIT_CONFIG_COUNT / KEY_n / VALUE_n (any characters are safe there). */
  config?: ReadonlyArray<readonly [string, string]>;
  /** Author and committer (strict profile; checkpoint commits). */
  identity?: GitIdentity | null;
  /** Source of PATH, HOME … (usually `process.env`). Only allowlisted names are copied. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** GIT_CEILING_DIRECTORIES for the discovery probe (`gitDir: null`). */
  ceiling?: string | null;
}

export interface GitInvocation {
  argv: string[];
  env: Record<string, string>;
}

function bad(message: string, detail: string): GmiError {
  return new GmiError('invalid_input', message, { detail });
}

/** Absolute on POSIX or Windows; no NUL or newline. */
export function isAbsolutePath(p: string): boolean {
  return (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) && !/[\0\r\n]/.test(p);
}

function assertAbsolute(p: string, what: string): void {
  if (!isAbsolutePath(p)) throw bad(`The ${what} path is not absolute.`, `git_path:${what}`);
}

/** A value interpolated into git's argv (ref, sha, branch, message after `-m` …): never an option, no NUL / newline. */
export function assertGitValue(value: string, what = 'value'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw bad(`Invalid git ${what}.`, `git_value:${what}`);
  if (value.startsWith('-')) throw bad(`A git ${what} cannot start with "-".`, `git_option:${what}`);
  if (/[\0\r\n]/.test(value)) throw bad(`Invalid characters in a git ${what}.`, `git_value:${what}`);
  return value;
}

/** A literal path after `--`: relative or absolute, never an option, no NUL. */
export function assertGitPath(p: string): string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) throw bad('Invalid path.', 'git_path');
  if (p.startsWith('-')) throw bad('A path cannot start with "-".', 'git_option:path');
  if (p.includes('\0')) throw bad('Invalid characters in a path.', 'git_path');
  return p;
}

export function isHexSha(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function cleanPath(value: string | undefined): string {
  if (!value) return '/usr/local/bin:/usr/bin:/bin';
  const sep = value.includes(';') && !value.includes(':/') ? ';' : ':';
  const kept = value.split(sep).filter((entry) => entry && entry !== '.' && isAbsolutePath(entry));
  return kept.length ? kept.join(sep) : '/usr/local/bin:/usr/bin:/bin';
}

/** Builds the argv (without the `git` binary) and the full env of one git call. */
export function buildGitInvocation(o: GitSafeOptions): GitInvocation {
  if (o.gitDir !== null) assertAbsolute(o.gitDir, 'git dir');
  if (o.commonDir) assertAbsolute(o.commonDir, 'common dir');
  if (o.workTree) assertAbsolute(o.workTree, 'work tree');
  if (o.indexFile) assertAbsolute(o.indexFile, 'index');
  if (o.objectDir) assertAbsolute(o.objectDir, 'object dir');
  for (const alt of o.alternates ?? []) {
    assertAbsolute(alt, 'alternate');
    if (alt.includes(':') && !/^[A-Za-z]:/.test(alt)) throw bad('An object directory path contains ":".', 'git_path:alternate');
  }
  if (o.args.length === 0) throw bad('No git subcommand.', 'git_args');
  for (const arg of o.args) if (typeof arg !== 'string' || arg.includes('\0')) throw bad('Invalid git argument.', 'git_args');

  const argv: string[] = ['--no-pager'];
  if (o.gitDir !== null) argv.push(`--git-dir=${o.gitDir}`);
  if (o.workTree) argv.push(`--work-tree=${o.workTree}`);
  for (const kv of GIT_SAFE_CONFIG) {
    if (o.profile === 'user' && SIGNING_OVERRIDES.has(kv)) continue;
    argv.push('-c', kv);
  }
  argv.push(...o.args);
  if (o.paths) {
    argv.push('--');
    for (const p of o.paths) argv.push(assertGitPath(p));
  }

  const env: Record<string, string> = {};
  env.PATH = cleanPath(o.baseEnv.PATH);
  const names: string[] = [...BASE_ENV_NAMES];
  if (o.profile !== 'strict') names.push(...GLOBAL_CONFIG_ENV_NAMES);
  if (o.profile === 'user') names.push(...SIGNING_ENV_NAMES);
  for (const name of names) {
    const value = o.baseEnv[name];
    if (typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)) env[name] = value;
  }
  env.LC_ALL = 'C';
  env.LANGUAGE = 'C';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LITERAL_PATHSPECS = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PROTOCOL_FROM_USER = '0';
  env.GIT_ASKPASS = '';
  env.SSH_ASKPASS = '';
  if (o.profile === 'strict') {
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    const id = o.identity ?? CHECKPOINT_IDENTITY;
    for (const v of [id.name, id.email]) if (/[\0\r\n<>]/.test(v)) throw bad('Invalid git identity.', 'git_identity');
    env.GIT_AUTHOR_NAME = id.name;
    env.GIT_AUTHOR_EMAIL = id.email;
    env.GIT_COMMITTER_NAME = id.name;
    env.GIT_COMMITTER_EMAIL = id.email;
    if (o.identity?.date) {
      env.GIT_AUTHOR_DATE = o.identity.date;
      env.GIT_COMMITTER_DATE = o.identity.date;
    }
  }
  if (o.commonDir) env.GIT_COMMON_DIR = o.commonDir;
  if (o.indexFile) env.GIT_INDEX_FILE = o.indexFile;
  if (o.objectDir) env.GIT_OBJECT_DIRECTORY = o.objectDir;
  if (o.alternates?.length) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = o.alternates.join(':');
  if (o.gitDir === null && o.ceiling) env.GIT_CEILING_DIRECTORIES = o.ceiling;
  const pairs = o.config ?? [];
  if (pairs.length) {
    env.GIT_CONFIG_COUNT = String(pairs.length);
    pairs.forEach(([key, value], i) => {
      if (!/^[A-Za-z][A-Za-z0-9-]*(\..+)?\.[A-Za-z][A-Za-z0-9-]*$/s.test(key) || /[\0\r\n]/.test(key) || value.includes('\0')) {
        throw bad('Invalid git config key.', 'git_config');
      }
      env[`GIT_CONFIG_KEY_${i}`] = key;
      env[`GIT_CONFIG_VALUE_${i}`] = value;
    });
  }
  return { argv, env };
}

/**
 * Config pairs that switch off the repo's own drivers (strict profile): a `.gitattributes` the agent writes can select
 * `filter=x` or `diff=x`, so every driver named in the repo config gets empty commands. Input: the names printed by
 * `git config --name-only --get-regexp '^(filter|diff)\.'`.
 */
export function neutralizeDrivers(configNames: readonly string[]): Array<[string, string]> {
  const filters = new Set<string>();
  const diffs = new Set<string>();
  for (const raw of configNames) {
    const key = raw.trim();
    const m = /^(filter|diff)\.(.+)\.([^.]+)$/is.exec(key);
    if (!m) continue;
    const section = m[1]!.toLowerCase();
    (section === 'filter' ? filters : diffs).add(m[2]!);
  }
  const out: Array<[string, string]> = [];
  for (const name of filters) {
    out.push([`filter.${name}.clean`, ''], [`filter.${name}.smudge`, ''], [`filter.${name}.process`, ''], [`filter.${name}.required`, 'false']);
  }
  for (const name of diffs) out.push([`diff.${name}.textconv`, ''], [`diff.${name}.command`, '']);
  return out;
}

/**
 * Repo-local config keys that can run code (§8.2: shown in a native confirmation before commit or merge when they
 * were not present at trust time). Input: `git config --local --name-only --list` lines.
 */
export function execCapableKeys(configNames: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of configNames) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    if (
      /^filter\..+\.(clean|smudge|process)$/.test(key) ||
      /^diff\..+\.(textconv|command)$/.test(key) ||
      /^merge\..+\.driver$/.test(key) ||
      /^core\.(pager|editor|sshcommand|fsmonitor|hookspath|askpass|gitproxy|alternaterefscommand)$/.test(key) ||
      /^(gpg|credential)\./.test(key) ||
      /^include(if\..+)?\.path$/.test(key) ||
      key === 'diff.external' ||
      /^sequence\.editor$/.test(key) ||
      /^uploadpack\.packobjectshook$/.test(key)
    ) {
      out.add(key);
    }
  }
  return [...out].sort();
}

/** Parses a `.git` pointer file (`gitdir: <path>`). Null when it is not one. */
export function parseGitPointer(content: string): string | null {
  const m = /^gitdir: (.+?)\r?\n?$/.exec(content);
  if (!m || m[1]!.includes('\0')) return null;
  return m[1]!;
}
