/**
 * Developer-only environment overrides. A packaged build ignores all of them: anything that can set the
 * app's environment (a modified shortcut, `launchctl setenv`, a wrapper script) could otherwise load a
 * remote page with full IPC access, swap in demo data or another profile, enable DevTools, or replace the
 * inference key.
 */
export const DEV_ENV_VARS = [
  'VITE_DEV_SERVER_URL',
  'GMI_DESK_MOCK',
  'GMI_DESK_MOCK_AUTH',
  'GMI_DESK_MOCK_USAGE',
  'GMI_DESK_SHOTS',
  'GMI_DESK_SHOTS_LIVE',
  'GMI_DESK_SHOTS_PAGES',
  'GMI_DESK_USER_DATA',
  'GMI_DESK_DEVTOOLS',
  'GMI_API_KEY',
  'GMI_DESK_MOCK_COMPUTE',
  'GMI_DESK_MOCK_CODE',
  'GMI_DESK_TRACE',
] as const;

/**
 * Removes the developer overrides from `env` when the app is packaged, so no slice can read them later.
 * Returns the names that were removed (for the log; never the values).
 */
export function stripDevEnv(env: Record<string, string | undefined>, packaged: boolean): string[] {
  if (!packaged) return [];
  const removed: string[] = [];
  for (const name of DEV_ENV_VARS) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
