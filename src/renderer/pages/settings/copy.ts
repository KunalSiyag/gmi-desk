// Settings copy that depends on state. Pure (no React, no DOM) so tests can check it.
import type { SecureStorageBackend } from '@shared/contracts/app';
import type { LockedSecret, OAuthInferenceProbe } from '@shared/contracts/auth';

const NEVER_SHOWN = 'It is never shown again — only the last 4 characters.';

/** Where a key saved from the API key form ends up, matching the Security section's storage badge. */
export function keyStorageNote(backend: SecureStorageBackend): string {
  if (backend === 'os') return `Checked with GMI, then stored in your OS keychain. ${NEVER_SHOWN}`;
  if (backend === 'basic_text') return `Checked with GMI, then saved with weak encryption (no OS keyring was found). ${NEVER_SHOWN}`;
  return `Checked with GMI, then kept in memory only: encryption is unavailable, so paste it again after you quit. ${NEVER_SHOWN}`;
}

/** The same, as a clause for other places that mention the key (e.g. the chat's "add a key" notice). */
export function keyStorageClause(backend: SecureStorageBackend): string {
  if (backend === 'os') return 'it stays in your OS keychain';
  if (backend === 'basic_text') return 'it is saved with weak encryption (no OS keyring was found)';
  return 'it is kept in memory only, so paste it again after you quit';
}

/** Settings › Chat rows. They are copied into each chat when it is created; existing chats keep their own. */
export const CHAT_DEFAULTS_COPY = {
  model: 'New chats start with this model. Automatic: GMI’s first featured chat model.',
  maxTokens: 'Default for new chats (change it for one chat in Chat settings). GMI’s own default is only 2,000.',
  routerMode: 'Default for new chats: how Auto picks a model — cheapest, balanced, or best quality.',
} as const;

/** Why a saved secret is not in use, and what to do (AuthState.lockedSecrets). */
export function lockedSecretNote(secret: LockedSecret): string {
  const what = secret === 'sign_in' ? 'your saved GMI sign-in' : secret === 'compute_key' ? 'your saved Compute key' : 'your saved API key';
  const instead = secret === 'sign_in' ? 'or sign in again' : secret === 'compute_key' ? 'or connect the key again' : 'or paste the key again';
  return `Your OS keychain is locked or unavailable, so GMI Desk could not read ${what}. Nothing was deleted: unlock the keychain and try again, ${instead}.`;
}

/** Settings › API key: whether GMI accepts the sign-in for chat (AuthState.inference.oauthProbe). */
export function oauthProbeLabel(probe: OAuthInferenceProbe): string {
  if (probe === 'supported') return 'Available';
  if (probe === 'unsupported') return 'Not yet';
  if (probe === 'checking') return 'Checking…';
  if (probe === 'error') return 'Couldn’t check';
  return 'Not checked';
}
