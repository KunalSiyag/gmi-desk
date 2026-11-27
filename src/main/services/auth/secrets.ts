/**
 * Shapes of the OAuth secrets kept in the secure store, with defensive parsing
 * (a corrupt or foreign value is treated as missing rather than crashing startup).
 */
import type { SecretStatus, SecureStore } from '../../core/secure-store';
import { SECURE_KEYS } from './constants';

/** Dynamic client registration result, saved so later sign-ins reuse it (and its loopback port). */
export interface StoredClient {
  client_id: string;
  redirect_uri: string;
  redirect_port: number;
  /** Authorization server the client was registered with. */
  issuer: string;
  scope: string;
  registered_at: string;
}

export interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  /** Epoch milliseconds; null when GMI did not send `expires_in`. */
  expires_at: number | null;
  /** Space-separated scopes actually granted. */
  scope: string;
  token_type: string;
  /**
   * The OAuth client the tokens were issued to: refresh and revocation must use this one, whatever registration
   * is saved for the next sign-in. Missing in tokens saved by older versions (the saved registration is used).
   */
  client_id?: string;
}

/** Token endpoint response (RFC 6749 §5.1) as returned by the SDK helpers. */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function parseStoredClient(raw: string | null): StoredClient | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!isNonEmptyString(v.client_id) || !isNonEmptyString(v.redirect_uri) || !isNonEmptyString(v.issuer)) return null;
    const port = typeof v.redirect_port === 'number' ? v.redirect_port : Number(v.redirect_port);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return {
      client_id: v.client_id,
      redirect_uri: v.redirect_uri,
      redirect_port: port,
      issuer: v.issuer,
      scope: typeof v.scope === 'string' ? v.scope : '',
      registered_at: typeof v.registered_at === 'string' ? v.registered_at : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function parseStoredTokens(raw: string | null): StoredTokens | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!isNonEmptyString(v.access_token)) return null;
    const expiresAt = typeof v.expires_at === 'number' && Number.isFinite(v.expires_at) ? v.expires_at : null;
    const tokens: StoredTokens = {
      access_token: v.access_token,
      refresh_token: isNonEmptyString(v.refresh_token) ? v.refresh_token : null,
      expires_at: expiresAt,
      scope: typeof v.scope === 'string' ? v.scope : '',
      token_type: isNonEmptyString(v.token_type) ? v.token_type : 'Bearer',
    };
    if (isNonEmptyString(v.client_id)) tokens.client_id = v.client_id;
    return tokens;
  } catch {
    return null;
  }
}

/**
 * Normalises a token endpoint response. RFC 6749 §5.1: an omitted `scope` means the requested
 * scope was granted; an omitted `refresh_token` on refresh means the old one stays valid.
 */
export function tokensFromResponse(
  res: TokenResponse,
  now: Date,
  fallback: { scope: string; refreshToken?: string | null },
): StoredTokens {
  const expiresIn = typeof res.expires_in === 'number' && Number.isFinite(res.expires_in) && res.expires_in > 0 ? res.expires_in : null;
  return {
    access_token: res.access_token,
    refresh_token: res.refresh_token ?? fallback.refreshToken ?? null,
    expires_at: expiresIn === null ? null : now.getTime() + expiresIn * 1000,
    scope: typeof res.scope === 'string' && res.scope.trim() ? res.scope.trim() : fallback.scope,
    token_type: res.token_type || 'Bearer',
  };
}

export function scopesOf(tokens: StoredTokens | null): string[] {
  if (!tokens) return [];
  return [...new Set(tokens.scope.split(/\s+/).filter(Boolean))];
}

export async function readClient(secure: SecureStore): Promise<StoredClient | null> {
  return parseStoredClient(await secure.get(SECURE_KEYS.client));
}

/** The saved registration, or why there is none: `unreadable` = saved but the OS keychain would not decrypt it. */
export async function readClientWithStatus(secure: SecureStore): Promise<{ client: StoredClient | null; status: SecretStatus }> {
  const { value, status } = await secure.getWithStatus(SECURE_KEYS.client);
  const client = parseStoredClient(value);
  return { client, status: status === 'ok' && !client ? 'missing' : status };
}

export async function writeClient(secure: SecureStore, client: StoredClient): Promise<void> {
  await secure.set(SECURE_KEYS.client, JSON.stringify(client));
}

export async function deleteClient(secure: SecureStore): Promise<void> {
  await secure.delete(SECURE_KEYS.client);
}

export async function readTokens(secure: SecureStore): Promise<StoredTokens | null> {
  return (await readTokensWithStatus(secure)).tokens;
}

/**
 * The saved tokens. A value that decrypts but is not valid JSON tokens is deleted (`missing`); one the OS keychain
 * would not decrypt is KEPT (`unreadable`): a locked keyring must not sign the user out for good.
 */
export async function readTokensWithStatus(secure: SecureStore): Promise<{ tokens: StoredTokens | null; status: SecretStatus }> {
  const { value, status } = await secure.getWithStatus(SECURE_KEYS.tokens);
  const tokens = parseStoredTokens(value);
  if (value && !tokens) {
    await secure.delete(SECURE_KEYS.tokens).catch(() => undefined);
    return { tokens: null, status: 'missing' };
  }
  return { tokens, status };
}

export async function writeTokens(secure: SecureStore, tokens: StoredTokens): Promise<void> {
  await secure.set(SECURE_KEYS.tokens, JSON.stringify(tokens));
}

export async function deleteTokens(secure: SecureStore): Promise<void> {
  await secure.delete(SECURE_KEYS.tokens);
}
