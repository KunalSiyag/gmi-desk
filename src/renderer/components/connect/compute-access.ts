// Connect Compute (compute.md §4.1): what the dialog and Settings › Compute key show for each state, and the copy.
// Pure (no React, no DOM) so tests can check it.
import type { SecureStorageBackend } from '@shared/contracts/app';
import type { AuthState, ComputeKeyInfo } from '@shared/contracts/auth';
import type { ComputeAccess, ComputeEntitlement } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';

/** `GmiError.detail` from main when the key checked for Compute is an inference key (services/auth/compute-keys.ts). */
export const INFERENCE_SCOPE_DETAIL = 'scope:ie_model';

const NO_COMPUTE_KEY: ComputeKeyInfo = { status: 'missing', last4: null, keyId: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };

/** The Compute key metadata (absent from main processes without it: treated as no key). */
export function computeKeyOf(state: AuthState | null | undefined): ComputeKeyInfo {
  return state?.computeKey ?? NO_COMPUTE_KEY;
}

/** The key is saved, but the OS keychain would not decrypt it right now. */
export function computeKeyLocked(state: AuthState | null | undefined): boolean {
  return state?.lockedSecrets?.includes('compute_key') ?? false;
}

/**
 * The key is kept in memory for this session only (weak keyring and the user chose not to store it, or no encryption
 * at all). Sent by main as an extra `sessionOnly` field until the contract has it (C1-A report).
 */
export function computeKeySessionOnly(state: AuthState | null | undefined): boolean {
  const key = computeKeyOf(state);
  if (key.status === 'missing') return false;
  return (key as ComputeKeyInfo & { sessionOnly?: unknown }).sessionOnly === true || state?.secureStorage === 'unavailable';
}

/** The error says the key is an inference (chat) key: Connect Compute offers "Use it for chat instead". */
export function isInferenceKeyError(error: unknown): boolean {
  return error instanceof GmiError && error.code === 'invalid_input' && error.detail === INFERENCE_SCOPE_DETAIL;
}

/** What the dialog shows. */
export type ComputeConnectView =
  /** A usable (or locked) Compute key is saved: status, access, "Use a different key". */
  | 'connected'
  /** The guided steps (create a key → we pick it up). */
  | 'steps';

export function computeConnectView(state: AuthState | null | undefined, replacing: boolean): ComputeConnectView {
  if (replacing || !state) return 'steps';
  if (computeKeyLocked(state)) return 'connected';
  const status = computeKeyOf(state).status;
  return status === 'valid' || status === 'unverified' ? 'connected' : 'steps';
}

export const COMPUTE_COPY = {
  title: 'Connect Compute',
  description: 'Containers and sandboxes need a Compute API key from GMI Console. It takes about 30 seconds.',
  explain:
    'A Compute key lets GMI Desk create and manage containers and sandboxes for your whole organization. It stays in your OS keychain; GMI Desk asks before anything that costs money.',
  consoleSteps: ['Create API key', 'name it “GMI Desk – <this computer>”', 'Copy'] as const,
  dedicated: 'Use a key just for GMI Desk, so you can revoke it on its own.',
  listening: 'Watching your clipboard while this dialog is open',
  listeningDetail: 'Nothing is sent anywhere until you confirm.',
  stopped: 'Stopped watching after 10 minutes',
  inferenceTitle: 'This is an inference (chat) key',
  inferenceBody: 'Compute needs a key with the Compute scope. You can use this one for chat instead.',
  ready: 'Compute is connected',
  chatReady: 'Chat is ready',
  keepBilling: 'Anything already running keeps running and billing in GMI until you delete it.',
} as const;

/** Where a Compute key ends up, before it is saved (Connect Compute's paste form and the weak-keyring warning). */
export function computeStorageNote(backend: SecureStorageBackend): string {
  if (backend === 'os') return 'Checked with GMI, then stored in your OS keychain. Only the last 4 characters are ever shown.';
  if (backend === 'basic_text')
    return 'No OS keyring was found: after GMI checks the key, GMI Desk asks whether to store it with weak encryption or keep it for this session only.';
  return 'Encryption is unavailable on this computer: the key is kept in memory until you quit.';
}

/** The success line under "Compute is connected". */
export function savedComputeKeyNote(last4: string | null, clipboardCleared: boolean, backend: SecureStorageBackend, sessionOnly: boolean): string {
  const key = last4 ? `Key ••${last4}` : 'Your key';
  const where = sessionOnly
    ? 'is kept in memory for this session only: add it again after you quit'
    : backend === 'os'
      ? 'is saved in your OS keychain'
      : 'is saved on this computer with weak encryption (no OS keyring)';
  return `${key} ${where}.${clipboardCleared ? ' We cleared it from your clipboard (clipboard history apps may keep a copy).' : ''}`;
}

/** "Containers: Enabled" etc. for an entitlement chip. */
export function entitlementLabel(entitlement: ComputeEntitlement): string {
  if (entitlement === 'entitled') return 'Enabled';
  if (entitlement === 'not_entitled') return 'Not enabled';
  if (entitlement === 'checking') return 'Checking…';
  if (entitlement === 'error') return 'Couldn’t check';
  return 'Not checked';
}

/** The entitlement chips to show: null while the compute slice cannot say (not built yet, or no answer). */
export function entitlementRows(access: ComputeAccess | null | undefined): Array<{ id: 'containers' | 'sandboxes'; label: string; value: ComputeEntitlement }> | null {
  if (!access) return null;
  return [
    { id: 'containers', label: 'Containers', value: access.containers },
    { id: 'sandboxes', label: 'Sandboxes', value: access.sandboxes },
  ];
}

/** Metadata line under the key: when it was verified. */
export function computeKeySubtitle(key: ComputeKeyInfo, locked: boolean, formatAgo: (iso: string) => string): string {
  if (locked) return 'Saved on this computer, but the OS keychain did not unlock it';
  if (key.status === 'missing') return 'Create one in GMI Console and GMI Desk picks it up from your clipboard.';
  if (!key.validatedAt) return 'Not verified with GMI yet';
  return `${key.status === 'invalid' ? 'Checked' : 'Verified'} ${formatAgo(key.validatedAt)} · Compute scope (ce_resource)`;
}
