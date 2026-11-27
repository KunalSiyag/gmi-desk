/**
 * Chat without an API key, the day GMI allows it: asks GMI's inference API whether it accepts the OAuth sign-in
 * (GET /v1/models with the access token as Bearer) and, while it does and no key is stored, hands the access token
 * to chat / GMI Router / the catalog instead of a key. The token only ever goes to GMI hosts (the callers' URLs:
 * api.gmi-serving.com and console.gmicloud.ai) and is never logged.
 */
import { createHash } from 'node:crypto';
import type { AuthStatus, InferenceAccess, OAuthInferenceProbe } from '@shared/contracts/auth';
import { toGmiError } from '@shared/contracts/errors';
import type { Http } from '../../core/http';
import type { Logger } from '../../core/logger';
import type { JsonStore } from '../../core/store';
import { INFERENCE_PROBE_MAX_AGE_MS, INFERENCE_PROBE_TIMEOUT_MS, INFERENCE_PROBE_URL } from './constants';
import type { AuthFile, OAuthInferenceRecord } from './state';

export type ProbeOutcome = OAuthInferenceRecord['status'];

/** 200 with a `data` array → supported; 401/403 → unsupported; anything else (offline, 5xx, odd body) → error. */
export async function probeInferenceWithToken(http: Http, token: string, signal?: AbortSignal): Promise<ProbeOutcome> {
  try {
    const body = await http.json<unknown>(INFERENCE_PROBE_URL, { bearer: token, timeoutMs: INFERENCE_PROBE_TIMEOUT_MS, retries: 0, signal });
    const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
    return Array.isArray(data) ? 'supported' : 'error';
  } catch (error) {
    const err = toGmiError(error);
    // A Cloudflare block (403, error 1010) says nothing about the token.
    if ((err.status === 401 || err.status === 403) && !/cloudflare/i.test(err.message)) return 'unsupported';
    return 'error';
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** OAuth access tokens handed out recently (hashed): a late 401 for an older token still counts. */
const HANDED_OUT_CAP = 8;

export interface OAuthInferenceDeps {
  http: Http;
  file: JsonStore<AuthFile>;
  now: () => Date;
  log: Logger;
  /** A usable access token (refreshed when about to expire); throws when there is no session. */
  accessToken: () => Promise<string>;
  /** Tokens are in memory (a session exists, even while its status is still being announced). */
  hasSession: () => boolean;
  /** Changes on every sign-in / sign-out: an answer about an older session is dropped. */
  epoch: () => number;
  /** A key (stored or GMI_API_KEY) is available: it always wins over the sign-in. */
  hasKey: () => boolean;
  /** The current session's granted scopes, sorted and space separated ('' without a session). */
  grantedScope: () => string;
  emit: () => void;
}

export class OAuthInference {
  private running: Promise<void> | null = null;
  /** The session epoch the probe in flight is about. */
  private runningEpoch = -1;
  private readonly handedOut: string[] = [];

  constructor(private readonly deps: OAuthInferenceDeps) {}

  private get record(): OAuthInferenceRecord | null {
    return this.deps.file.get().oauthInference;
  }

  /** The probe status shown in AuthState. */
  get probe(): OAuthInferenceProbe {
    if (this.running) return 'checking';
    return this.record?.status ?? 'unknown';
  }

  get supported(): boolean {
    return this.record?.status === 'supported';
  }

  access(status: AuthStatus): InferenceAccess {
    const via = this.deps.hasKey() ? 'api_key' : status === 'signed_in' && this.supported ? 'oauth' : null;
    return { via, oauthProbe: this.probe, oauthProbeAt: this.record?.checkedAt ?? null };
  }

  /**
   * Probes now (joins a probe in flight for the same session). Marks `checking` synchronously, so the caller's next
   * emit carries it.
   */
  probeNow(): Promise<void> {
    if (!this.deps.hasSession()) return Promise.resolve();
    const epoch = this.deps.epoch();
    // Join only a probe about this session; one for an older sign-in ends unanswered (its epoch check below).
    if (this.running && this.runningEpoch === epoch) return this.running;
    this.runningEpoch = epoch;
    const run = (async () => {
      let outcome: ProbeOutcome;
      try {
        outcome = await probeInferenceWithToken(this.deps.http, await this.deps.accessToken());
      } catch (error) {
        // No usable token (refresh failed, signed out meanwhile): no answer.
        this.deps.log.debug('OAuth inference probe skipped', { code: toGmiError(error).code });
        outcome = 'error';
      }
      if (epoch !== this.deps.epoch()) return; // the session changed: the answer is about an old sign-in
      const previous = this.record;
      // A blip (offline, 5xx) must not take chat away from a sign-in GMI accepted: keep that answer, and its old
      // checkedAt so the next startup asks again.
      if (outcome === 'error' && previous?.status === 'supported') {
        this.deps.log.info('OAuth inference probe failed; keeping the earlier "supported" answer');
        return;
      }
      // Chat, GMI Router or the models API already refused this sign-in: /v1/models accepting it (models:read)
      // proves nothing until the granted scopes change (a new sign-in that GMI granted more to).
      const rejectedFor = previous?.rejectedForScope ?? null;
      if (outcome === 'supported' && rejectedFor !== null && rejectedFor === this.deps.grantedScope()) {
        this.deps.log.info('OAuth inference probe: /v1/models accepts the sign-in, but chat refused it with the same scopes');
        outcome = 'unsupported';
      }
      if (outcome !== previous?.status) this.deps.log.info(`OAuth inference probe: ${outcome}`);
      const record: OAuthInferenceRecord = {
        status: outcome,
        checkedAt: this.deps.now().toISOString(),
        rejectedForScope: outcome === 'supported' ? null : rejectedFor,
      };
      await this.deps.file.update((f) => ({ ...f, oauthInference: record }));
    })().finally(() => {
      if (this.running === run) this.running = null;
      this.deps.emit();
    });
    this.running = run;
    return run;
  }

  /** At startup: probes when signed in and the last answer is missing or older than a day. */
  maybeProbe(): void {
    const record = this.record;
    const age = record ? this.deps.now().getTime() - Date.parse(record.checkedAt) : Infinity;
    if (this.deps.hasSession() && !(age >= 0 && age < INFERENCE_PROBE_MAX_AGE_MS)) void this.probeNow();
  }

  /** The session ended: the answer belonged to it. */
  async reset(): Promise<void> {
    this.handedOut.length = 0;
    if (this.record) await this.deps.file.update((f) => ({ ...f, oauthInference: null }));
  }

  /** The access token to use for inference when no key is stored and GMI accepts the sign-in; otherwise null. */
  async token(): Promise<string | null> {
    if (this.deps.hasKey() || !this.supported || !this.deps.hasSession()) return null;
    const token = await this.deps.accessToken();
    const h = hash(token);
    if (!this.handedOut.includes(h)) {
      this.handedOut.push(h);
      if (this.handedOut.length > HANDED_OUT_CAP) this.handedOut.shift();
    }
    return token;
  }

  /** Whether `value` is an access token this class handed out for inference. */
  isOAuthToken(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.length > 0 && this.handedOut.includes(hash(value));
  }

  /**
   * GMI answered 401/403 to chat, GMI Router or the models API with the sign-in: back to asking for a key, and
   * remember the scopes it was refused with so the next probe does not flip it back.
   */
  async markUnsupported(reason: string): Promise<void> {
    this.deps.log.info('GMI rejected the sign-in for inference; a key is needed again', { reason: reason.slice(0, 200) });
    this.handedOut.length = 0;
    const record: OAuthInferenceRecord = { status: 'unsupported', checkedAt: this.deps.now().toISOString(), rejectedForScope: this.deps.grantedScope() || null };
    await this.deps.file.update((f) => ({ ...f, oauthInference: record }));
    this.deps.emit();
  }
}
