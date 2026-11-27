// Install tag, remote names, metadata labels and the match rules of the orphan sweep (compute.md §6.1, §7.1, §7.5).
// C1-C. Pure: no I/O.
//
//   container name   gmid-<inst6>-<slug(displayName, 24)>-<nonce6>     inst6 = first 6 base32 chars of sha256(installId)
//   sandbox metadata {app: 'gmi-desk', inst: <16 hex of sha256(installId)>, rid, purpose, thr?}   (org-visible: no PII)
//   resource id      cr_<uuid>   (also the v2 Idempotency-Key and the `rid` label)
//   unmanaged rows   ur_ce_<remoteId> / ur_sb_<remoteId>  (read-only, never stored; `adopt` takes them)
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ComputeBackend } from '@shared/contracts/compute';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Lowercase RFC 4648 base32 of `bytes` (no padding). */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** `inst6`: the first 6 base32 characters of sha256(installId). Random (installId is random), never PII. */
export function installTag(installId: string): string {
  return base32(sha256(installId)).slice(0, 6);
}

/** The `inst` metadata label of this install's sandboxes: 16 hex characters of sha256(installId). */
export function installLabel(installId: string): string {
  return sha256(installId).toString('hex').slice(0, 16);
}

export const NAME_PREFIX = 'gmid-';
/** `gmid-<inst6>-…`: any GMI Desk install's container. */
export const GMID_NAME = /^gmid-([a-z2-7]{6})-/;
/** The display name rule of the wizard (= the CE name pattern), 1–40 characters (§6.1). */
export const DISPLAY_NAME_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_\-. ]*)?[A-Za-z0-9]$/;
export const DISPLAY_NAME_MAX = 40;
export const SLUG_MAX = 24;

/** Lowercase `[a-z0-9-]`, at most `max` characters, never empty. */
export function slug(displayName: string, max = SLUG_MAX): string {
  const s = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'box';
}

/** Six random lowercase base32 characters. */
export function nonce6(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  return base32(random(4)).slice(0, 6);
}

/** The remote name of a new resource: `gmid-<inst6>-<slug>-<nonce6>`. */
export function remoteName(installId: string, displayName: string, random?: (n: number) => Uint8Array): string {
  return `${NAME_PREFIX}${installTag(installId)}-${slug(displayName)}-${nonce6(random)}`;
}

/** The slug part of a `gmid-` name (what the UI shows for an adopted resource). */
export function displayNameFromRemote(name: string): string {
  const m = /^gmid-[a-z2-7]{6}-(.+)-[a-z2-7]{6}$/.exec(name);
  return m?.[1] ?? name;
}

export type Ownership = 'this_install' | 'other_install' | 'unmanaged';

/** Whose container this is, by its name alone (journal and registry matches are checked by the caller). */
export function containerOwnership(name: string, tag: string): Ownership {
  const m = GMID_NAME.exec(name);
  if (!m) return 'unmanaged';
  return m[1] === tag ? 'this_install' : 'other_install';
}

/** The install tag inside a `gmid-` name; null for any other name. */
export function tagOfName(name: string): string | null {
  return GMID_NAME.exec(name)?.[1] ?? null;
}

export const APP_LABEL = 'gmi-desk';

/** Whose sandbox this is, by its metadata labels. */
export function sandboxOwnership(metadata: Record<string, string> | null | undefined, label: string): Ownership {
  if (!metadata || metadata.app !== APP_LABEL) return 'unmanaged';
  return metadata.inst === label ? 'this_install' : 'other_install';
}

/** The 5 short labels every sandbox this install creates carries (§7.1). No hostname, no user name. */
export function sandboxMetadata(opts: { label: string; rid: string; purpose: 'computer' | 'agent'; threadId?: string | null }): Record<string, string> {
  return {
    app: APP_LABEL,
    inst: opts.label,
    rid: opts.rid,
    purpose: opts.purpose,
    ...(opts.threadId ? { thr: opts.threadId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) } : {}),
  };
}

export const RESOURCE_ID = /^cr_[A-Za-z0-9-]{8,64}$/;
const UNMANAGED_ID = /^ur_(ce|sb)_([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;

export function newResourceId(): string {
  return `cr_${randomUUID()}`;
}

/** The read-only id of an org resource that is not in the registry. */
export function unmanagedId(backend: ComputeBackend, remoteId: string): string {
  return `ur_${backend === 'ce' ? 'ce' : 'sb'}_${remoteId}`;
}

export function parseUnmanagedId(id: string): { backend: ComputeBackend; remoteId: string } | null {
  const m = UNMANAGED_ID.exec(id);
  if (!m?.[1] || !m[2]) return null;
  return { backend: m[1] === 'ce' ? 'ce' : 'sandbox_v2', remoteId: m[2] };
}

/** A usable record id for an adopted sandbox: its `rid` label when well-formed, else a new one. */
export function adoptedSandboxId(metadata: Record<string, string> | null | undefined, taken: (id: string) => boolean): string {
  const rid = metadata?.rid;
  if (typeof rid === 'string' && /^cr_[A-Za-z0-9_-]{3,64}$/.test(rid) && !taken(rid)) return rid;
  return newResourceId();
}
