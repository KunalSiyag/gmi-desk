/**
 * OAuth token lifecycle: persisted in the secure store, refreshed proactively (< 60 s left) with a
 * single in-flight refresh shared by every caller. A dead grant (invalid_grant / 401) ends the session.
 */
import { GmiError, toGmiError, type GmiErrorCode } from '@shared/contracts/errors';
import type { Logger } from '../../core/logger';
import type { SecureStore } from '../../core/secure-store';
import { REFRESH_SKEW_MS } from './constants';
import { deleteTokens, readTokensWithStatus, writeTokens, type StoredTokens } from './secrets';

export interface TokenManagerDeps {
  secure: SecureStore;
  now: () => Date;
  log: Logger;
  /** Runs the refresh_token grant. Throws GmiError (`reauth_required` when the grant is dead). */
  refresh(current: StoredTokens): Promise<StoredTokens>;
  /** The session can no longer be refreshed; tokens were already cleared. */
  onReauthRequired(reason: string): void | Promise<void>;
  onRefreshed?(tokens: StoredTokens): void;
  /** A refresh failed for a transient reason (network, upstream); the session is kept. */
  onRefreshFailed?(error: GmiError): void;
  skewMs?: number;
}

/** Failures worth retrying later; anything else needs the user (or never succeeds). */
export const TRANSIENT_CODES: ReadonlySet<GmiErrorCode> = new Set<GmiErrorCode>(['network', 'timeout', 'upstream', 'rate_limited']);

export class TokenManager {
  private tokens: StoredTokens | null = null;
  private loaded = false;
  /** Tokens are saved but the OS keychain would not decrypt them (kept on disk; see reload()). */
  private unreadable = false;
  private loading: Promise<StoredTokens | null> | null = null;
  private inflight: Promise<StoredTokens> | null = null;
  /** Bumped whenever the session changes (sign-in, sign-out, reauth) so stale refreshes are dropped. */
  private generation = 0;

  constructor(private readonly deps: TokenManagerDeps) {}

  /** Current session generation (changes on every sign-in/sign-out). */
  get epoch(): number {
    return this.generation;
  }

  /** Tokens in memory (call load() once at startup). */
  get current(): StoredTokens | null {
    return this.tokens;
  }

  /**
   * True when tokens are saved but could not be read (OS keychain locked or unavailable). The file is kept: only
   * an explicit sign-in (set) or sign-out (clear) replaces it; reload() tries to read it again.
   */
  get storedUnreadable(): boolean {
    return this.unreadable;
  }

  private async read(): Promise<{ tokens: StoredTokens | null; unreadable: boolean }> {
    try {
      const { tokens, status } = await readTokensWithStatus(this.deps.secure);
      return { tokens, unreadable: status === 'unreadable' };
    } catch (error) {
      // An I/O error is not proof that there is no session: keep the file and say it is unreadable.
      this.deps.log.warn('could not read stored tokens', error);
      return { tokens: null, unreadable: true };
    }
  }

  async load(): Promise<StoredTokens | null> {
    if (this.loaded) return this.tokens;
    if (!this.loading) {
      const generation = this.generation;
      const loading = (async () => {
        const { tokens: stored, unreadable } = await this.read();
        // A sign-in or sign-out that happened while reading wins over what was on disk.
        if (generation === this.generation && !this.loaded) {
          this.tokens = stored;
          this.unreadable = unreadable;
          this.loaded = true;
        }
        return this.tokens;
      })();
      this.loading = loading;
      const reset = () => {
        if (this.loading === loading) this.loading = null;
      };
      loading.then(reset, reset);
    }
    return this.loading;
  }

  /**
   * Reads tokens that could not be decrypted earlier again (the user unlocked the keychain). Does nothing when
   * tokens are in memory or nothing was unreadable; a sign-in or sign-out meanwhile wins over what was read.
   */
  async reload(): Promise<StoredTokens | null> {
    await this.load();
    if (this.tokens || !this.unreadable) return this.tokens;
    const generation = this.generation;
    const { tokens, unreadable } = await this.read();
    if (generation === this.generation && !this.tokens) {
      this.tokens = tokens;
      this.unreadable = unreadable;
    }
    return this.tokens;
  }

  /** Starts a new session with fresh tokens (replaces saved tokens, readable or not). */
  async set(tokens: StoredTokens): Promise<void> {
    this.generation += 1;
    this.inflight = null;
    this.tokens = tokens;
    this.unreadable = false;
    this.loaded = true;
    await writeTokens(this.deps.secure, tokens);
  }

  /** Ends the session and deletes the saved tokens (readable or not). */
  async clear(): Promise<void> {
    this.generation += 1;
    this.inflight = null;
    this.tokens = null;
    this.unreadable = false;
    this.loaded = true;
    await deleteTokens(this.deps.secure).catch((error) => this.deps.log.warn('could not delete stored tokens', error));
  }

  isExpiring(tokens: StoredTokens, now = this.deps.now()): boolean {
    return tokens.expires_at !== null && tokens.expires_at - now.getTime() < (this.deps.skewMs ?? REFRESH_SKEW_MS);
  }

  isExpired(tokens: StoredTokens, now = this.deps.now()): boolean {
    return tokens.expires_at !== null && tokens.expires_at <= now.getTime();
  }

  /** A usable access token, refreshed first when it is about to expire. */
  async getAccessToken(): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new GmiError('not_signed_in', 'Sign in with GMI to use this.');
    if (!this.isExpiring(tokens)) return tokens.access_token;
    try {
      return (await this.refreshShared()).access_token;
    } catch (error) {
      const err = toGmiError(error);
      // A proactive refresh that failed transiently still leaves a few valid seconds on the old token.
      if (TRANSIENT_CODES.has(err.code) && this.tokens === tokens && !this.isExpired(tokens)) return tokens.access_token;
      throw err;
    }
  }

  /**
   * Called after GMI answered 401 for `staleAccessToken`. Refreshes once (joining a refresh already in
   * flight) unless another caller already replaced that token.
   */
  async forceRefresh(staleAccessToken: string): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new GmiError('not_signed_in', 'Sign in with GMI to use this.');
    if (tokens.access_token !== staleAccessToken) return tokens.access_token;
    return (await this.refreshShared()).access_token;
  }

  private refreshShared(): Promise<StoredTokens> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const current = this.tokens;
    const run = async (): Promise<StoredTokens> => {
      if (!current) throw new GmiError('not_signed_in', 'Sign in with GMI to use this.');
      if (!current.refresh_token) {
        throw new GmiError('reauth_required', 'Your GMI sign-in expired. Sign in again.');
      }
      const next = await this.deps.refresh(current);
      if (generation !== this.generation) throw new GmiError('cancelled', 'The GMI session changed while it was being refreshed.');
      this.tokens = next;
      await writeTokens(this.deps.secure, next);
      this.deps.onRefreshed?.(next);
      return next;
    };
    const promise = run().catch(async (error: unknown) => {
      const err = toGmiError(error);
      if (generation === this.generation) {
        if (err.code === 'reauth_required') {
          await this.clear();
          await this.deps.onReauthRequired(err.message);
        } else if (err.code !== 'cancelled') {
          this.deps.onRefreshFailed?.(err);
        }
      }
      throw err;
    });
    this.inflight = promise;
    const reset = () => {
      if (this.inflight === promise) this.inflight = null;
    };
    promise.then(reset, reset);
    return promise;
  }
}
