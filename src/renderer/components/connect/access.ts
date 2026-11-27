// Connect chat: whether chat can run, and the dialog's copy. Pure (no React, no DOM) so tests can check it.
import type { AuthState } from '@shared/contracts/auth';

/**
 * Whether chat and GMI Router can authenticate:
 * `ready` = a usable key, or no key while GMI accepts the sign-in (`via === 'oauth'`);
 * `missing` = nothing to chat with; `invalid` = the key in use was rejected.
 * Unknown state (still loading) counts as ready so nothing nags before the answer arrives.
 */
export type ChatAccess = 'ready' | 'missing' | 'invalid';

export function chatAccess(state: AuthState | null | undefined): ChatAccess {
  if (!state) return 'ready';
  const key = state.inferenceKey.status;
  if (key === 'invalid') return 'invalid';
  if (key === 'valid' || key === 'unverified') return 'ready';
  return state.inference?.via === 'oauth' ? 'ready' : 'missing';
}

/** Chat runs on the GMI sign-in (no key stored, GMI accepts the sign-in for inference). */
export function chatViaSignIn(state: AuthState | null | undefined): boolean {
  return state?.inference?.via === 'oauth' && state.inferenceKey.status === 'missing';
}

/** What the dialog shows. */
export type ConnectView =
  /** GMI accepts the sign-in for chat: nothing to do. */
  | 'oauth'
  /** A usable key is already saved (the dialog offers to replace it). */
  | 'connected'
  /** The guided steps (sign in → create a key → we pick it up). */
  | 'steps';

export function connectView(state: AuthState | null | undefined, replacing: boolean): ConnectView {
  if (replacing || !state) return 'steps';
  if (chatViaSignIn(state)) return 'oauth';
  const key = state.inferenceKey.status;
  return key === 'valid' || key === 'unverified' ? 'connected' : 'steps';
}

/** Step 3's state, from the clipboard watcher (AuthState.keyDetection) and the dialog's own progress. */
export type DetectStage = 'listening' | 'found' | 'verifying' | 'stopped';

export function detectStage(state: AuthState | null | undefined, verifying: boolean): DetectStage {
  if (verifying) return 'verifying';
  const detection = state?.keyDetection;
  if (detection?.candidate) return 'found';
  return detection && !detection.active ? 'stopped' : 'listening';
}

export const CONNECT_COPY = {
  title: 'Connect chat',
  description: 'Chat needs an API key from GMI Console. It takes about 30 seconds.',
  consoleSteps: ['Create API key', 'name it “GMI Desk”', 'Copy'] as const,
  listening: 'Watching your clipboard while this dialog is open',
  listeningDetail: 'Nothing is sent anywhere until you confirm.',
  stopped: 'Stopped watching after 10 minutes',
  why: 'GMI’s sign-in doesn’t cover chat yet. Once it does, GMI Desk switches over by itself.',
  codingPlan: 'On a Coding Plan? Use your plan’s key.',
  oauthTitle: 'Chat works with your GMI sign-in',
  oauthBody: 'No key needed: GMI accepts your sign-in for chat and GMI Router.',
  ready: 'Chat is ready',
} as const;

/** "Found a key ending ••abcd". */
export function foundKeyLabel(last4: string): string {
  return `Found a key ending ••${last4}`;
}

/** The success line under "Chat is ready". */
export function savedKeyNote(last4: string | null, clipboardCleared: boolean, storage: AuthState['secureStorage']): string {
  const where = storage === 'os' ? 'your OS keychain' : storage === 'basic_text' ? 'this computer (weak encryption: no OS keyring)' : 'memory until you quit';
  const key = last4 ? `Key ••${last4}` : 'Your key';
  return `${key} is saved in ${where}.${clipboardCleared ? ' We cleared it from your clipboard (clipboard history apps may keep a copy).' : ''}`;
}
