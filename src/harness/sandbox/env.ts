/**
 * Environment of sandboxed commands (harness.md §8.4): an allowlist only, never a blocklist. The host's own env is
 * already scrubbed at spawn (§5.1); this is the second, narrower gate.
 */

/** Names refused unless main confirmed them natively (§8.4); values are never logged. */
export const SECRET_LIKE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|GMI_|OPENAI|ANTHROPIC|AWS_|AZURE_|GCP_|GOOGLE_)/i;

/** The in-sandbox forwarder's address (§8.3). */
export const SANDBOX_PROXY_URL = 'http://127.0.0.1:3128';

const PASS_THROUGH = ['USER', 'LOGNAME', 'LANG', 'TZ'] as const;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE = 32_768;

export interface SandboxEnvInput {
  /** The host's (already scrubbed) env. */
  hostEnv: Record<string, string | undefined>;
  /** `$HOME` inside the sandbox: a fresh tmpfs at this path for every command (§8.3). */
  home: string;
  /** The thread's cache dir (`npm_config_cache`, `PIP_CACHE_DIR`, `XDG_CACHE_HOME` point into `$HOME`). Null: none. */
  cacheDir: string | null;
  /** From GitService.sandboxMounts().env (object dirs, gc.auto=0). */
  gitEnv?: Record<string, string>;
  /** `git config user.name/email` read by the host. */
  gitAuthor?: { name: string; email: string } | null;
  /** Network approved (proxy or shared): sets the proxy variables when `proxy`. */
  network: 'off' | 'proxy' | 'shared';
  /** Project-allowlisted names (Settings › Code › Project › Environment). */
  projectNames?: readonly string[];
  /** Secret-like names main confirmed natively for this project (§8.4). */
  confirmedSecretNames?: readonly string[];
}

/** Removes empty, `.` and relative entries. */
export function cleanPath(value: string): string {
  return value
    .split(':')
    .filter((e) => e.startsWith('/') && !e.includes('\0'))
    .join(':');
}

function ok(value: string | undefined): value is string {
  return typeof value === 'string' && value.length <= MAX_VALUE && !value.includes('\0');
}

export function buildSandboxEnv(input: SandboxEnvInput): Record<string, string> {
  const src = input.hostEnv;
  const env: Record<string, string> = {};
  env.PATH = cleanPath(ok(src.PATH) ? src.PATH : '/usr/local/bin:/usr/bin:/bin');
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  env.HOME = input.home;
  for (const n of PASS_THROUGH) if (ok(src[n])) env[n] = src[n] as string;
  for (const [n, v] of Object.entries(src)) if (n.startsWith('LC_') && NAME.test(n) && ok(v)) env[n] = v;
  Object.assign(env, {
    TERM: 'dumb',
    SHELL: '/bin/bash',
    TMPDIR: '/tmp',
    NO_COLOR: '1',
    CI: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  });
  if (input.gitAuthor) {
    env.GIT_AUTHOR_NAME = input.gitAuthor.name;
    env.GIT_AUTHOR_EMAIL = input.gitAuthor.email;
    env.GIT_COMMITTER_NAME = input.gitAuthor.name;
    env.GIT_COMMITTER_EMAIL = input.gitAuthor.email;
  }
  if (input.cacheDir !== null) {
    env.XDG_CACHE_HOME = `${input.home}/.cache`;
    env.npm_config_cache = `${input.home}/.npm`;
    env.PIP_CACHE_DIR = `${input.home}/.cache/pip`;
  }
  for (const [n, v] of Object.entries(input.gitEnv ?? {})) if (/^GIT_[A-Z0-9_]+$/.test(n) && ok(v)) env[n] = v;
  if (input.network === 'proxy') {
    for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[n] = SANDBOX_PROXY_URL;
    env.NO_PROXY = '';
    env.no_proxy = '';
  }
  const confirmed = new Set(input.confirmedSecretNames ?? []);
  for (const n of input.projectNames ?? []) {
    if (!NAME.test(n) || n in env || !ok(src[n])) continue;
    if (SECRET_LIKE_ENV.test(n) && !confirmed.has(n)) continue;
    if (/^(LD_|DYLD_)|^(BASH_ENV|ENV|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|IFS|PS4|GIT_|NODE_OPTIONS$|PYTHONSTARTUP$|ELECTRON_)/.test(n)) continue;
    env[n] = src[n] as string;
  }
  return env;
}
