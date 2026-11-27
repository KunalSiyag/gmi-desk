// Compute page (compute.md §15): pure display and validation helpers. No React, no DOM, so tests can check them.
// Main validates everything again and is authoritative (§6.1, §6.3); these give feedback while typing.
import type {
  ComputeAlarmAction,
  ComputeCatalog,
  ComputeKind,
  ComputeOffer,
  ComputePhase,
  ComputeResource,
  ComputeState,
  LeaseAction,
  LeasePolicy,
} from '@shared/contracts/compute';
import { LEASE_LIMITS } from '@shared/contracts/compute';
import { formatUsd } from '@shared/lib/money';

// ---------------------------------------------------------------------------------------------------------------
// Phases

export type PhaseTone = 'working' | 'ok' | 'paused' | 'danger' | 'muted';

export const PHASE_VIEW: Record<ComputePhase, { label: string; tone: PhaseTone }> = {
  creating: { label: 'Starting', tone: 'working' },
  running: { label: 'Running', tone: 'ok' },
  busy: { label: 'Restarting', tone: 'working' },
  pausing: { label: 'Pausing', tone: 'working' },
  paused: { label: 'Paused', tone: 'paused' },
  resuming: { label: 'Resuming', tone: 'working' },
  deleting: { label: 'Deleting', tone: 'working' },
  deleted: { label: 'Deleted', tone: 'muted' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'muted' },
};

/** Phases that are changing on their own (Plates in the badge). */
export function isWorkingPhase(phase: ComputePhase): boolean {
  return PHASE_VIEW[phase].tone === 'working';
}

/** The guard's conservative view of "this bills now" (§6.5, §7.4): everything except paused, failed sandboxes, deleted. */
export function isBilledPhase(resource: Pick<ComputeResource, 'phase' | 'kind'>): boolean {
  if (resource.phase === 'deleted' || resource.phase === 'paused') return false;
  if (resource.phase === 'failed') return resource.kind === 'container';
  return true;
}

export const KIND_LABEL: Record<ComputeKind, string> = { container: 'Container', sandbox: 'Sandbox' };

// ---------------------------------------------------------------------------------------------------------------
// Money and time

/** "$3.35/h", "$0.091/h", "price unknown". */
export function formatPerHour(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return 'price unknown';
  return `${formatUsd(usd)}/h`;
}

/** 45 → "45 min", 240 → "4 h", 90 → "1 h 30 min", 1440 → "1 day", 4320 → "3 days", 1500 → "1 day 1 h". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  const days = `${d} ${d === 1 ? 'day' : 'days'}`;
  return h ? `${days} ${h} h` : days;
}

/** Time left until `iso`: "in 3 h 20 min", "in 40 s" style is avoided ("in under a minute"), "overdue" when past. */
export function formatCountdown(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  if (ms <= 0) return 'overdue';
  if (ms < 60_000) return 'in under a minute';
  return `in ${formatMinutes(Math.floor(ms / 60_000))}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const ms = now - at;
  if (ms < 60_000) return 'just now';
  return `${formatMinutes(Math.floor(ms / 60_000))} ago`;
}

/** Minutes until `iso` (negative when past); null when unknown. */
export function minutesUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? (at - now) / 60_000 : null;
}

const dateTimeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? dateTimeFmt.format(new Date(at)) : null;
}

/** "120 GB", "1.5 MB". */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog

/**
 * GMI's sandbox presets arrive as enum names (X_SMALL, SMALL, MEDIUM, LARGE, X_LARGE). Shown next to "1× H100" and
 * "CPU" they read as shouting, so sizes are words: "X-Small", "Small", "Large". Anything else passes through.
 */
export function sizeName(label: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(label)) return label;
  const parts = label.split('_').filter(Boolean);
  // Words (4+ letters) become title case; short parts are acronyms or prefixes and stay ("X", "XL", "CPU").
  if (!parts.some((part) => /^[A-Z]{4,}$/.test(part))) return label;
  return parts.map((part) => (/^[A-Z]{4,}$/.test(part) ? part[0] + part.slice(1).toLowerCase() : part)).join('-');
}

/**
 * "1× H200 · 16 vCPU · 128 GiB", "Small · 2 vCPU · 4 GiB", "CPU · 8 vCPU". `withTitle: false` drops the leading
 * `offerTitle` for rows that already show it ("16 vCPU · 128 GiB").
 */
export function offerSpecs(
  offer: Pick<ComputeOffer, 'gpuModel' | 'gpuCount' | 'vcpu' | 'memoryGiB' | 'sizeLabel'>,
  { withTitle = true }: { withTitle?: boolean } = {},
): string {
  const parts: string[] = [];
  if (withTitle) parts.push(offerTitle(offer));
  if (offer.vcpu) parts.push(`${offer.vcpu} vCPU`);
  if (offer.memoryGiB) parts.push(`${offer.memoryGiB} GiB`);
  return parts.join(' · ');
}

/** "1× H200", "Small", "CPU": the short name of a size. */
export function offerTitle(offer: Pick<ComputeOffer, 'gpuModel' | 'gpuCount' | 'sizeLabel'>): string {
  if (offer.gpuModel && offer.gpuCount > 0) return `${offer.gpuCount}× ${offer.gpuModel}`;
  return offer.sizeLabel ? sizeName(offer.sizeLabel) : 'CPU';
}

export function isGpuOffer(offer: Pick<ComputeOffer, 'gpuCount'> | null | undefined): boolean {
  return Boolean(offer && offer.gpuCount > 0);
}

/** Cheapest known list price per GPU model across the catalog, for the signed-out "from $X/h" summary. */
export function cheapestByModel(offers: ComputeOffer[], kind: ComputeKind): Array<{ title: string; fromUsdPerHour: number | null; idcs: string[]; offer: ComputeOffer }> {
  const groups = new Map<string, { title: string; fromUsdPerHour: number | null; idcs: Set<string>; offer: ComputeOffer }>();
  for (const offer of offers) {
    if (offer.kind !== kind) continue;
    const title = offerTitle(offer);
    const g = groups.get(title);
    if (!g) {
      groups.set(title, { title, fromUsdPerHour: offer.listUsdPerHour, idcs: new Set([offer.idc]), offer });
      continue;
    }
    g.idcs.add(offer.idc);
    if (offer.listUsdPerHour !== null && (g.fromUsdPerHour === null || offer.listUsdPerHour < g.fromUsdPerHour)) {
      g.fromUsdPerHour = offer.listUsdPerHour;
      g.offer = offer;
    }
  }
  return [...groups.values()]
    .map((g) => ({ title: g.title, fromUsdPerHour: g.fromUsdPerHour, idcs: [...g.idcs].sort(), offer: g.offer }))
    .sort((a, b) => (a.fromUsdPerHour ?? Infinity) - (b.fromUsdPerHour ?? Infinity) || a.title.localeCompare(b.title));
}

/** The resource's size in words ("1× H200 · 16 vCPU · 128 GiB") with GMI's SKU as the hint; the bare SKU if unknown. */
export function sizeFact(catalog: ComputeCatalog | null | undefined, sku: string | null | undefined): { label: string; value: string; hint?: string } {
  const offer = sku ? catalog?.offers.find((o) => o.sku === sku) : undefined;
  if (!offer) return { label: 'Size', value: sku ?? '—' };
  return { label: 'Size', value: offerSpecs(offer), hint: sku ?? undefined };
}

export function idcName(catalog: ComputeCatalog | null | undefined, id: string | null | undefined): string {
  if (!id) return 'Default region';
  return catalog?.idcs.find((i) => i.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------------------------------------------
// Leases (§9.3, §9.4, §7.1)

/** Defaults chosen with the user (DECISIONS "Defaults chosen"): containers 4 h then delete; sandboxes §7.1. */
export function defaultLease(kind: ComputeKind): LeasePolicy {
  return kind === 'container'
    ? { maxLifetimeMin: 240, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' }
    : { maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 20, extendOnActivity: true, onBudget: 'pause' };
}

/** Lease actions a kind supports: containers have no pause in CE. */
export function leaseActionsFor(kind: ComputeKind): LeaseAction[] {
  return kind === 'container' ? ['delete', 'notify'] : ['pause', 'delete', 'notify'];
}

export const LIFETIME_PRESETS_MIN = [60, 120, 240, 480, 1440, 4320, 10080] as const;
export const IDLE_PRESETS_MIN = [10, 20, 30, 60, 120] as const;
export const SANDBOX_TIMEOUT_PRESETS_SEC = [900, 1800, 3600, 7200, 14400] as const;

export const LEASE_ACTION_LABEL: Record<LeaseAction, string> = {
  delete: 'Delete it',
  pause: 'Pause it',
  notify: 'Keep running and notify me',
};

/** "Deletes after 4 h", "Pauses after 8 h", "Notifies after 1 day", "No automatic limit". */
export function leaseSummary(lease: LeasePolicy | null | undefined): string {
  if (!lease) return 'No lease';
  if (lease.maxLifetimeMin === null) return 'No automatic limit';
  const verb = lease.onExpiry === 'delete' ? 'Deletes' : lease.onExpiry === 'pause' ? 'Pauses' : 'Notifies you';
  return `${verb} after ${formatMinutes(lease.maxLifetimeMin)}`;
}

/** What happens when a budget runs out, said plainly (stated in the native dialog too, §9.3). */
export function onBudgetSentence(kind: ComputeKind, action: LeaseAction): string {
  if (action === 'notify')
    return kind === 'container' ? 'Your budget will not stop this container: it keeps running and GMI Desk notifies you.' : 'Your budget will not stop this sandbox: it keeps running and GMI Desk notifies you.';
  if (action === 'pause') return 'When a budget runs out, GMI Desk pauses it (you can resume it).';
  return 'When a budget runs out, GMI Desk deletes it. Files on it are lost.';
}

/** Max list cost of one lease, or null without a limit or a price. */
export function leaseMaxUsd(usdPerHour: number | null, lease: LeasePolicy): number | null {
  if (usdPerHour === null || lease.maxLifetimeMin === null) return null;
  return (usdPerHour * lease.maxLifetimeMin) / 60;
}

/**
 * Whether a lease patch needs main's native confirmation (§9.3): loosening (longer, notify instead of delete, idle off,
 * no limit), or making a delete happen sooner. The UI only says so; main decides and shows the dialog.
 */
export function leaseChangeNotice(before: LeasePolicy, after: LeasePolicy, ranMin: number | null): string | null {
  const notes: string[] = [];
  const longer =
    (before.maxLifetimeMin !== null && after.maxLifetimeMin === null) ||
    (before.maxLifetimeMin !== null && after.maxLifetimeMin !== null && after.maxLifetimeMin > before.maxLifetimeMin);
  if (longer) notes.push('a longer limit');
  if (before.onExpiry === 'delete' && after.onExpiry !== 'delete') notes.push('no delete at the end');
  if (before.idlePauseMin !== null && after.idlePauseMin === null) notes.push('no idle pause');
  if (before.onBudget !== 'notify' && after.onBudget === 'notify') notes.push('keeping it running past the budget');
  const sooner =
    (after.onExpiry === 'delete' && before.onExpiry !== 'delete') ||
    (after.onBudget === 'delete' && before.onBudget !== 'delete') ||
    (after.maxLifetimeMin !== null && ranMin !== null && after.maxLifetimeMin < ranMin + 15);
  if (sooner) notes.push('a delete that can happen sooner');
  if (!notes.length) return null;
  return `GMI Desk asks you to confirm in a system dialog: ${notes.join(', ')}.`;
}

export function sameLease(a: LeasePolicy, b: LeasePolicy): boolean {
  return (
    a.maxLifetimeMin === b.maxLifetimeMin &&
    a.onExpiry === b.onExpiry &&
    a.idlePauseMin === b.idlePauseMin &&
    a.extendOnActivity === b.extendOnActivity &&
    a.onBudget === b.onBudget
  );
}

export function clampLifetime(min: number): number {
  return Math.min(LEASE_LIMITS.maxLifetimeMin, Math.max(LEASE_LIMITS.minLifetimeMin, Math.round(min)));
}

// ---------------------------------------------------------------------------------------------------------------
// Wizard validation (§6.1; main re-validates)

export const NAME_MAX = 40;
const NAME_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_\-. ]*)?[A-Za-z0-9]$/;

export function validateDisplayName(name: string): string | null {
  const t = name.trim();
  if (!t) return 'Give it a name.';
  if (t.length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`;
  if (!NAME_PATTERN.test(t)) return 'Letters, digits, spaces, “-”, “_” and “.”; start and end with a letter or digit.';
  return null;
}

export const ENV_LIMITS = { maxVars: 64, maxValueBytes: 64 * 1024 } as const;
const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function validateEnvName(name: string): string | null {
  if (!name) return 'Name required.';
  if (!ENV_NAME.test(name)) return 'Letters, digits and “_”; not starting with a digit.';
  return null;
}

/** A value that looks like a JWT (GMI keys are JWTs): the wizard warns (§6.1); main refuses stored secrets. */
export function looksLikeJwt(value: string): boolean {
  return /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(value);
}

export const PORT_LIMITS = { max: 5, min: 1, maxPort: 65534 } as const;

export function validatePort(port: number): string | null {
  if (!Number.isInteger(port) || port < PORT_LIMITS.min || port > PORT_LIMITS.maxPort) return `Ports are 1–${PORT_LIMITS.maxPort}.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// IPv4 CIDRs (§6.3)

export interface CidrCheck {
  /** Normalised `a.b.c.d/n` (a bare address becomes /32); null when invalid. */
  cidr: string | null;
  error: string | null;
  /** Broader than /32: main treats it as open and asks natively. */
  open: boolean;
  /** 0.0.0.0/0. */
  allOpen: boolean;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255 || (p.length > 1 && p.startsWith('0'))) return null;
    out.push(n);
  }
  return out;
}

export function isIpv4(text: string): boolean {
  return parseIpv4(text.trim()) !== null;
}

const RESERVED: Array<{ base: number[]; prefix: number; label: string }> = [
  { base: [127, 0, 0, 0], prefix: 8, label: 'loopback' },
  { base: [169, 254, 0, 0], prefix: 16, label: 'link-local' },
  { base: [224, 0, 0, 0], prefix: 4, label: 'multicast' },
  { base: [240, 0, 0, 0], prefix: 4, label: 'reserved' },
  { base: [0, 0, 0, 0], prefix: 8, label: 'reserved' },
];

const toInt = (ip: number[]) => ((ip[0]! << 24) >>> 0) + (ip[1]! << 16) + (ip[2]! << 8) + ip[3]!;
const inRange = (ip: number[], base: number[], prefix: number) => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
};

export function checkCidr(input: string): CidrCheck {
  const t = input.trim();
  const bad = (error: string): CidrCheck => ({ cidr: null, error, open: false, allOpen: false });
  if (!t) return bad('Enter an IPv4 address.');
  const [addr = '', prefixText, ...rest] = t.split('/');
  if (rest.length) return bad('Use an IPv4 address or CIDR, like 203.0.113.7 or 203.0.113.0/24.');
  const ip = parseIpv4(addr);
  if (!ip) return bad(addr.includes(':') ? 'Only IPv4 is supported.' : 'Use an IPv4 address or CIDR, like 203.0.113.7 or 203.0.113.0/24.');
  let prefix = 32;
  if (prefixText !== undefined) {
    if (!/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) return bad('The prefix after “/” is 0–32.');
    prefix = Number(prefixText);
  }
  if (prefix === 0) {
    if (toInt(ip) !== 0) return bad('Use 0.0.0.0/0 for “anyone”.');
    return { cidr: '0.0.0.0/0', error: null, open: true, allOpen: true };
  }
  for (const r of RESERVED) {
    if (inRange(ip, r.base, r.prefix)) return bad(`That is a ${r.label} range; GMI cannot reach you there.`);
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const net = (toInt(ip) & mask) >>> 0;
  const normal = [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.');
  return { cidr: `${normal}/${prefix}`, error: null, open: prefix < 32, allOpen: false };
}

/** The warning shown under a CIDR (null for a single /32 address). */
export function cidrWarning(check: CidrCheck): string | null {
  if (check.error || !check.cidr) return null;
  if (check.allOpen) return 'All Open: anyone on the internet can reach these ports. GMI Desk asks you to confirm in a system dialog.';
  if (check.open) {
    const prefix = Number(check.cidr.split('/')[1]);
    const count = 2 ** (32 - prefix);
    return `Open to ${count.toLocaleString('en-US')} addresses, not just yours. GMI Desk asks you to confirm in a system dialog.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Alarms and banners (§7.5, §9.6)

export const ALARM_ACTION_LABEL: Record<ComputeAlarmAction, string> = {
  open: 'Open',
  extend: 'Extend 1 h',
  pause: 'Pause',
  delete: 'Delete…',
  release_eip: 'Release IP…',
  connect_key: 'Connect Compute',
  open_console: 'Open in console',
  adopt: 'Adopt…',
  dismiss: 'Dismiss',
};

/** "2 containers · 1 EIP are billing in your organization ($27.40/h list)". Null when nothing is billing. Counts only (D-defaults). */
export function orgBillingText(org: ComputeState['org']): string | null {
  if (!org || org.containers + org.eips === 0) return null;
  const parts: string[] = [];
  if (org.containers) parts.push(`${org.containers} ${org.containers === 1 ? 'container' : 'containers'}`);
  if (org.eips) parts.push(`${org.eips} ${org.eips === 1 ? 'EIP' : 'EIPs'}`);
  const verb = org.containers + org.eips === 1 ? 'is' : 'are';
  const rate = org.usdPerHour === null ? '' : ` (${formatPerHour(org.usdPerHour)} list)`;
  return `${parts.join(' · ')} ${verb} billing in your organization${rate}`;
}

/** Most severe first, then newest. */
export function sortAlarms<T extends { severity: 'info' | 'warning' | 'critical'; createdAt: string }>(alarms: readonly T[]): T[] {
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return [...alarms].sort((a, b) => rank[a.severity] - rank[b.severity] || b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------------------------------------------
// Key status

export type ComputeKeyView = 'loading' | 'none' | 'locked' | 'invalid' | 'ready';

// ---------------------------------------------------------------------------------------------------------------
// The next thing that happens to a resource on its own (row and header countdown)

export interface NextEvent {
  /** "Deletes in 3 h 20 min", "Idle pause in 12 min", "GMI pauses it in 40 min". */
  label: string;
  at: string;
  /** Within 15 min (the T−15 warning, §9.4). */
  soon: boolean;
}

export function nextEvent(r: Pick<ComputeResource, 'phase' | 'leaseEndsAt' | 'serverEndsAt' | 'idlePauseAt' | 'lease' | 'kind'>, now: number): NextEvent | null {
  if (r.phase === 'deleted' || r.phase === 'deleting' || r.phase === 'paused' || r.phase === 'pausing') return null;
  const candidates: Array<{ at: string; label: (when: string) => string }> = [];
  if (r.leaseEndsAt) {
    const verb = r.lease?.onExpiry === 'delete' ? 'Deletes' : r.lease?.onExpiry === 'pause' ? 'Pauses' : 'Lease ends';
    candidates.push({ at: r.leaseEndsAt, label: (when) => `${verb} ${when}` });
  }
  if (r.kind === 'sandbox' && r.serverEndsAt) candidates.push({ at: r.serverEndsAt, label: (when) => `GMI timeout ${when}` });
  if (r.kind === 'sandbox' && r.idlePauseAt) candidates.push({ at: r.idlePauseAt, label: (when) => `Idle pause ${when}` });
  const valid = candidates.filter((c) => Number.isFinite(Date.parse(c.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = valid[0];
  if (!first) return null;
  const when = formatCountdown(first.at, now) ?? '';
  const left = minutesUntil(first.at, now) ?? Infinity;
  return { label: first.label(when), at: first.at, soon: left <= 15 };
}

/** "Deleting (retrying, 2 attempts)" for a lease/budget action that has not succeeded yet (§9.4). */
export function actionPendingText(p: ComputeResource['actionPending']): string | null {
  if (!p) return null;
  const verb = p.action === 'delete' ? 'Delete' : p.action === 'pause' ? 'Pause' : 'Notify';
  return `${verb} pending${p.attempts ? ` · ${p.attempts} ${p.attempts === 1 ? 'attempt' : 'attempts'}` : ''}`;
}

export const PENDING_ACTION_LABEL: Record<NonNullable<ComputeResource['pendingAction']>, string> = {
  create: 'Creating',
  delete: 'Deleting',
  restart: 'Restarting',
  pause: 'Pausing',
  resume: 'Resuming',
  extend: 'Extending',
  snapshot: 'Snapshotting',
  network: 'Updating network',
};
