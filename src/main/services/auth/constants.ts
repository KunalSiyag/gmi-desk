import { GMI_URLS } from '@shared/app';
import { GMI_SCOPES } from '@shared/contracts/auth';

/** GMI's OAuth 2.1 authorization server (also hosts the MCP endpoint). */
export const GMI_OAUTH_ISSUER = 'https://mcp.gmicloud.ai';

/** RFC 8707 resource indicator sent with authorization and token requests. */
export const GMI_MCP_RESOURCE = GMI_URLS.mcp;

/**
 * The six scopes the app knows; always requested. At sign-in the app also asks for the inference / read-only key
 * scopes the authorization server advertises (requestedScopeFor), so a future inference or key scope is granted
 * without an app update.
 */
export const REQUESTED_SCOPE = GMI_SCOPES.join(' ');

/** RFC 6749 §3.3 scope-token: printable ASCII except space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const MAX_EXTRA_SCOPES = 32;
/**
 * Extra advertised scopes worth asking for (least privilege): inference / chat / router access and read-only key
 * access. Anything else GMI advertises (admin, writes, openid, another resource's scopes) is never requested.
 */
const EXTRA_SCOPE_ALLOWED = /^(?:ie_model|inference|chat|router|completions?)(?::[a-z_]+)?$|^(?:api[_-]?keys?|keys):read$/i;

/**
 * The scope string requested at sign-in: the known scopes first (in their usual order), then the advertised
 * inference / key-read scopes in the server metadata's `scopes_supported`, deduplicated. Malformed, unrelated or
 * excessive entries are ignored.
 */
export function requestedScopeFor(metadata: { scopes_supported?: unknown } | null | undefined): string {
  const scopes: string[] = [...GMI_SCOPES];
  const seen = new Set<string>(scopes);
  const advertised = metadata?.scopes_supported;
  if (Array.isArray(advertised)) {
    let extra = 0;
    for (const scope of advertised) {
      if (typeof scope !== 'string' || !SCOPE_TOKEN.test(scope) || seen.has(scope) || !EXTRA_SCOPE_ALLOWED.test(scope)) continue;
      if (extra >= MAX_EXTRA_SCOPES) break;
      seen.add(scope);
      scopes.push(scope);
      extra += 1;
    }
  }
  return scopes.join(' ');
}

/** A scope string as a set (order and duplicates ignored), for comparing registrations. */
export function scopeSet(scope: string): string {
  return [...new Set(scope.split(' ').filter(Boolean))].sort().join(' ');
}

/** GMI's OpenAI-compatible model list: the OAuth inference probe (and the catalog with a key). */
export const INFERENCE_PROBE_URL = `${GMI_URLS.inference}/models`;
export const INFERENCE_PROBE_TIMEOUT_MS = 10_000;
/** The probe runs after sign-in, on demand, and at startup at most once per this period. */
export const INFERENCE_PROBE_MAX_AGE_MS = 24 * 3_600_000;

/** Inference key check: 200 → key + organisation, 401 → invalid/expired. */
export const KEY_VALIDATION_URL = `${GMI_URLS.consoleApi}/me/api-keys/current`;

export const SECURE_KEYS = {
  client: 'oauth.client',
  tokens: 'oauth.tokens',
  inferenceKey: 'inference.key',
  /** The Compute key (`ce_resource`, compute.md DC1). Absent while it is kept for this session only. */
  computeKey: 'compute.key',
} as const;

/** The saved Compute key is re-checked with GMI at startup when its last check is older than this. */
export const COMPUTE_KEY_REVALIDATE_MS = 24 * 3_600_000;

export const COMPUTE_KEY_LOCKED_MESSAGE =
  'Your OS keychain is locked or unavailable, so GMI Desk could not read your saved Compute key. Nothing was deleted: unlock the keychain and choose Try again in Settings, or add the key again.';

/** A saved secret exists but the OS keychain would not decrypt it (see AuthState.lockedSecrets). */
export const SIGN_IN_LOCKED_MESSAGE =
  'Your OS keychain is locked or unavailable, so GMI Desk could not read your saved GMI sign-in. Nothing was deleted: unlock the keychain and choose Try again in Settings, or sign in again.';
export const KEY_LOCKED_MESSAGE =
  'Your OS keychain is locked or unavailable, so GMI Desk could not read your saved inference API key. Nothing was deleted: unlock the keychain and choose Try again in Settings, or paste the key again.';

/** How long the loopback redirect waits for the browser. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** Access tokens are refreshed when fewer than this many ms remain. */
export const REFRESH_SKEW_MS = 60_000;

/** Per-request timeout for OAuth calls (discovery, registration, token, revocation). */
export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export const MCP_DEFAULT_TIMEOUT_MS = 60_000;

/** Placeholder organisation used by mock mode and fixtures. */
export const MOCK_ORG_ID = '00000000-0000-0000-0000-000000000000';
