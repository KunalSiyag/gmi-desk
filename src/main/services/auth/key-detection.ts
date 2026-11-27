/**
 * Clipboard key detection for the Connect dialogs (chat: the inference key; Connect Compute: the Compute key, compute.md
 * §4.1): while one is open, notices a GMI key the user copied in GMI Console. A key already saved (inference or
 * Compute) is never offered again. Runs only between start() and stop() (auto-stop after 10 minutes), checks on start, on
 * every window focus and about once a second while focused. A candidate is never validated or sent anywhere until
 * the user clicks "Use this key"; the renderer only sees its last 4 characters. Nothing about the clipboard is logged.
 */
import { createHash } from 'node:crypto';
import type { KeyDetectionState, KeyTarget } from '@shared/contracts/auth';
import type { Platform } from '../../core/context';
import type { Logger } from '../../core/logger';
import { last4Of, MAX_KEY_LENGTH } from './keys';

export const KEY_DETECTION_TIMEOUT_MS = 10 * 60_000;
export const KEY_DETECTION_POLL_MS = 1_000;
/** A clipboard owner that never answers (a hung app, a clipboard manager) must not stall detection. */
export const CLIPBOARD_READ_TIMEOUT_MS = 2_000;
export const MIN_DETECTED_KEY_LENGTH = 20;

const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** Issuers a GMI key may name (when its payload has a URL `iss` at all). */
const GMI_ISSUER_HOST = /(^|\.)(gmicloud\.ai|gmi-serving\.com)$/i;

const decodeJson = (segment: string): unknown => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether clipboard text looks like a GMI inference key: one token (surrounding whitespace ignored, none inside),
 * 20–4096 characters, a JWT (three base64url segments) whose header says HS256 (GMI's inference keys are HS256 JWTs,
 * docs/RESEARCH.md › Credentials; the GMI sign-in's own access token is ES256 and most other services' tokens are
 * RS256/ES256) and whose payload is a JSON object that names no non-GMI URL issuer. Returns the trimmed key, or null.
 * If GMI changes the algorithm, detection fails quietly and "Paste it instead" still works.
 */
export function keyCandidateOf(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  // Cheap bounds first: the clipboard may hold a whole document.
  if (text.length < MIN_DETECTED_KEY_LENGTH || text.length > MAX_KEY_LENGTH + 64) return null;
  const key = text.trim();
  if (key.length < MIN_DETECTED_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return null;
  const parts = key.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return null;
  try {
    const header = decodeJson(parts[0]!);
    if (!isObject(header) || header.alg !== 'HS256') return null;
    const payload = decodeJson(parts[1]!);
    if (!isObject(payload)) return null;
    // A URL issuer that is not GMI's is some other service's token (a malformed URL throws: also not a key).
    const iss = payload.iss;
    if (typeof iss === 'string' && /^https?:/i.test(iss) && !GMI_ISSUER_HOST.test(new URL(iss).hostname)) return null;
    return key;
  } catch {
    return null;
  }
}

const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

export interface KeyDetectorDeps {
  platform: Pick<Platform, 'readClipboardText' | 'isAppFocused' | 'onAppFocus'>;
  now: () => Date;
  /** The key in use (stored or GMI_API_KEY): copying it again is not a new key. */
  currentKey: () => Promise<string | null>;
  /** Other saved keys (the Compute key): never offered either, whatever the target. */
  storedKeys?: () => Promise<Array<string | null>>;
  /** Broadcasts the new AuthState. */
  emit: () => void;
  log: Logger;
  timeoutMs?: number;
  pollMs?: number;
  /** Gives up on one clipboard read after this long (default CLIPBOARD_READ_TIMEOUT_MS). */
  readTimeoutMs?: number;
}

interface Candidate {
  key: string;
  last4: string;
  detectedAt: string;
}

export class KeyDetector {
  private active = false;
  private target: KeyTarget = 'inference';
  private candidate: Candidate | null = null;
  /** Fingerprints of values the user turned down ("Not this one") or GMI rejected, for this run of the app. */
  private readonly dismissed = new Set<string>();
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private offFocus: (() => void) | null = null;
  private checking = false;
  /** Bumped by every stop: a check that started before it neither reports nor blocks the next run. */
  private run = 0;

  constructor(private readonly deps: KeyDetectorDeps) {}

  state(): KeyDetectionState {
    const candidate = this.candidate ? { last4: this.candidate.last4, detectedAt: this.candidate.detectedAt } : null;
    // `target` only while watching (a stopped detector is the same for both dialogs).
    return this.active ? { active: true, candidate, target: this.target } : { active: false, candidate };
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Which key the found candidate would be stored as (useDetectedKey). */
  get activeTarget(): KeyTarget {
    return this.target;
  }

  /**
   * Starts watching for `target`'s key (or, when already watching, restarts the 10-minute clock and checks now).
   * Switching the target while watching keeps a found candidate: Connect Compute's "Use it for chat instead" moves a
   * found inference key over to chat this way.
   */
  start(target: KeyTarget = 'inference'): void {
    this.armTimeout();
    if (this.active && target !== this.target) {
      this.target = target;
      this.deps.emit();
    }
    this.target = target;
    if (!this.active) {
      this.active = true;
      this.poller = setInterval(() => {
        if (this.deps.platform.isAppFocused()) void this.check();
      }, this.deps.pollMs ?? KEY_DETECTION_POLL_MS);
      this.poller.unref?.();
      this.offFocus = this.deps.platform.onAppFocus(() => void this.check());
      this.deps.emit();
    }
    void this.check();
  }

  /** Stops watching and forgets the candidate. */
  stop(): void {
    if (!this.active && !this.candidate) return;
    this.halt();
    this.deps.emit();
  }

  /** The found key (main process only), or null. */
  take(): string | null {
    return this.candidate?.key ?? null;
  }

  /** "Not this one" (or GMI rejected it): forget it and ignore that value from now on. */
  dismiss(key: string | null = this.candidate?.key ?? null): void {
    if (!key) return;
    this.dismissed.add(fingerprint(key));
    if (this.candidate?.key === key) {
      this.candidate = null;
      this.deps.emit();
    }
  }

  dispose(): void {
    this.halt();
  }

  /** Reads the clipboard once (exposed for tests; the timers and focus events call it). */
  async check(): Promise<void> {
    if (!this.active || this.checking) return;
    this.checking = true;
    const run = this.run;
    const current = () => this.active && run === this.run;
    try {
      let text = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        text = await Promise.race([
          this.deps.platform.readClipboardText(),
          new Promise<string>((_, reject) => {
            timer = setTimeout(() => reject(new Error('clipboard read timed out')), this.deps.readTimeoutMs ?? CLIPBOARD_READ_TIMEOUT_MS);
          }),
        ]);
      } catch {
        return;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!current()) return; // stopped (or restarted) while the clipboard answered
      const key = keyCandidateOf(text);
      if (!key || key === this.candidate?.key || this.dismissed.has(fingerprint(key))) return;
      const inUse = await this.deps.currentKey().catch(() => null);
      const saved = this.deps.storedKeys ? await this.deps.storedKeys().catch(() => []) : [];
      if (!current() || key === inUse || saved.includes(key)) return;
      this.candidate = { key, last4: last4Of(key), detectedAt: this.deps.now().toISOString() };
      this.deps.log.info('found a key-shaped value on the clipboard');
      this.deps.emit();
    } finally {
      // A check from before a stop must not clear the flag of a check the restart began.
      if (run === this.run) this.checking = false;
    }
  }

  private armTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.stop();
    }, this.deps.timeoutMs ?? KEY_DETECTION_TIMEOUT_MS);
    this.timeout.unref?.();
  }

  private halt(): void {
    this.active = false;
    this.target = 'inference';
    this.candidate = null;
    // A read still hanging from this run is abandoned: the next start() can check right away.
    this.run += 1;
    this.checking = false;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.poller) clearInterval(this.poller);
    this.timeout = null;
    this.poller = null;
    this.offFocus?.();
    this.offFocus = null;
  }
}
