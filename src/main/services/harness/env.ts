/**
 * The harness host's spawn environment (harness.md §5.1, H-T2): an allowlist, never a blocklist. GMI credentials
 * (GMI_API_KEY) and anything that looks like a secret never reach the host, so nothing it spawns can inherit them.
 */

/** Exact names passed through. */
export const HOST_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'USER', 'SHELL', 'GMI_DESK_LOG_LEVEL'] as const;

/** `XDG_*_HOME` (XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME). */
const XDG_HOME = /^XDG_[A-Z]+_HOME$/;

/** Names refused even if a future allowlist entry matched them (defence in depth; §8.4's pattern). */
export const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|OPENAI|ANTHROPIC|AWS_|AZURE_|GCP_|GOOGLE_)/i;

const MAX_VALUE_LENGTH = 32_768;

/** Removes empty, `.` and relative PATH entries (a relative entry resolves against whatever cwd a child gets). */
export function sanitizePath(value: string, delimiter = process.platform === 'win32' ? ';' : ':'): string {
  return value
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== '.' && (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)))
    .join(delimiter);
}

function allowed(name: string): boolean {
  if (SECRET_ENV_NAME.test(name)) return false;
  return (HOST_ENV_ALLOWLIST as readonly string[]).includes(name) || XDG_HOME.test(name);
}

/** The env for `utilityProcess.fork` (it replaces the whole environment). */
export function buildHostEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH || value.includes('\0')) continue;
    if (!allowed(name)) continue;
    env[name] = name === 'PATH' ? sanitizePath(value) : value;
  }
  return env;
}
