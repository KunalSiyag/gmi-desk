/** Permissions (harness.md §9): engine, command classification, hard denies, one-shot call grants. */
export { createPermissionEngine, DEFAULT_WEB_ALLOWLIST, NET_PATTERN_PREFIX, globToRegExp, type HarnessPermissionEngine, type PermissionEngineDeps } from './engine';
export { classifyCommand, commandSegments, isDestructive, lexShell, patternArgv, prefixMatches, readOnlyAllowed, suggestPattern } from './command';
export { hardDenyReason, isSecretFileName, type HardDenyEnv } from './hard';
export { createCallGrants, type CallGrant, type CallGrants } from './grants';
