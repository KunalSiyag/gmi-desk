// The launch wizard's draft (§6.1, §7.1): steps what → where → size → options → review, validation per step and
// the spec sent to quoteCreate. Pure, so tests can check it. Main validates and prices again (authoritative).
import type {
  ComputeCatalog,
  ComputeCreateSpec,
  ComputeIdc,
  ComputeKind,
  ComputeOffer,
  ComputeTemplate,
  EnvVarInput,
  LeasePolicy,
} from '@shared/contracts/compute';
import { LEASE_LIMITS } from '@shared/contracts/compute';
import { checkCidr, defaultLease, ENV_LIMITS, PORT_LIMITS, validateDisplayName, validateEnvName, validatePort } from '../format';

export const LAUNCH_STEPS = ['template', 'idc', 'size', 'options', 'review'] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

export const STEP_LABEL: Record<LaunchStep, string> = {
  template: 'What',
  idc: 'Where',
  size: 'Size',
  options: 'Options',
  review: 'Review',
};

export function isLaunchStep(value: unknown): value is LaunchStep {
  return typeof value === 'string' && (LAUNCH_STEPS as readonly string[]).includes(value);
}

/** How a container is reached (§6.3). Sandboxes are always reached in GMI Desk (data plane). */
export type AccessMode = 'none' | 'ssh' | 'http';

export interface EnvDraft {
  key: string;
  name: string;
  value: string;
  secret: boolean;
}

export interface LaunchDraft {
  kind: ComputeKind;
  templateId: string | null;
  /** Sandboxes only: launch from a snapshot instead of a template. */
  snapshotId: string | null;
  idc: string | null;
  offerId: string | null;
  displayName: string;
  /** True once the user typed a name (the default then stops following the template). */
  nameTouched: boolean;
  env: EnvDraft[];
  /** Containers: extra exposed ports (official templates already expose theirs). */
  ports: number[];
  access: { mode: AccessMode; cidr: string; httpPorts: string };
  timeoutSec: number;
  onTimeout: 'pause' | 'kill';
  secure: boolean;
  egress: { mode: 'open' | 'allowlist'; hostnames: string };
  lease: LeasePolicy;
}

export function initialDraft(kind: ComputeKind): LaunchDraft {
  return {
    kind,
    templateId: null,
    snapshotId: null,
    idc: null,
    offerId: null,
    displayName: '',
    nameTouched: false,
    env: [],
    ports: [],
    access: { mode: 'none', cidr: '', httpPorts: '' },
    timeoutSec: 3600,
    onTimeout: 'pause',
    secure: true,
    egress: { mode: 'open', hostnames: '' },
    lease: defaultLease(kind),
  };
}

/** Switching kind keeps nothing that does not apply (templates, sizes and leases differ). */
export function withKind(draft: LaunchDraft, kind: ComputeKind): LaunchDraft {
  if (draft.kind === kind) return draft;
  return { ...initialDraft(kind), displayName: draft.nameTouched ? draft.displayName : '', nameTouched: draft.nameTouched, env: draft.env };
}

export function templatesFor(catalog: ComputeCatalog | undefined, kind: ComputeKind): ComputeTemplate[] {
  return (catalog?.templates ?? []).filter((t) => t.kind === kind).sort((a, b) => Number(b.official) - Number(a.official) || a.name.localeCompare(b.name));
}

export function idcsFor(catalog: ComputeCatalog | undefined, kind: ComputeKind): ComputeIdc[] {
  return (catalog?.idcs ?? []).filter((i) => i.kinds.includes(kind));
}

/** Memory a sandbox needs to be picked by default: GMI's small size (4 GiB) is too tight for dev or agent work. */
export const SANDBOX_DEFAULT_MIN_GIB = 8;

/**
 * The size picked when the user has not chosen one: the cheapest priced, enabled size; for a sandbox, the cheapest with
 * at least SANDBOX_DEFAULT_MIN_GIB (GMI's small sandbox runs out of memory on real dev and agent work), else the
 * cheapest. Also what the Size step marks "Recommended" for sandboxes.
 */
export function defaultOffer(catalog: ComputeCatalog | undefined, kind: ComputeKind, idc: string | null): ComputeOffer | null {
  const offers = offersFor(catalog, kind, idc);
  const usable = offers.filter((o) => o.listUsdPerHour !== null && o.entitled !== false);
  const roomy = kind === 'sandbox' ? usable.find((o) => (o.memoryGiB ?? 0) >= SANDBOX_DEFAULT_MIN_GIB) : undefined;
  return roomy ?? usable[0] ?? offers[0] ?? null;
}

/** Sizes for a kind in an IDC, cheapest first (unknown prices last). */
export function offersFor(catalog: ComputeCatalog | undefined, kind: ComputeKind, idc: string | null): ComputeOffer[] {
  return (catalog?.offers ?? [])
    .filter((o) => o.kind === kind && (idc === null || o.idc === idc))
    .sort((a, b) => (a.listUsdPerHour ?? Infinity) - (b.listUsdPerHour ?? Infinity) || b.gpuCount - a.gpuCount);
}

export function selectedOffer(catalog: ComputeCatalog | undefined, draft: LaunchDraft): ComputeOffer | null {
  return catalog?.offers.find((o) => o.id === draft.offerId) ?? null;
}

export function selectedTemplate(catalog: ComputeCatalog | undefined, draft: LaunchDraft): ComputeTemplate | null {
  return catalog?.templates.find((t) => t.id === draft.templateId) ?? null;
}

/** "jupyterlab-pytorch-cuda-12" → at most 24 characters, valid for the name pattern. */
export function defaultName(template: ComputeTemplate | null, kind: ComputeKind): string {
  const base = (template?.name ?? (kind === 'container' ? 'container' : 'sandbox'))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return base || kind;
}

/** Parses "8000, 8080" into ports; null when any entry is invalid. */
export function parsePorts(text: string): number[] | null {
  const parts = text
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (validatePort(n)) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function parseHostnames(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const HOSTNAME = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The first problem on a step, or null when it can continue. */
export function stepError(draft: LaunchDraft, step: LaunchStep, catalog: ComputeCatalog | undefined): string | null {
  switch (step) {
    case 'template':
      if (draft.kind === 'sandbox' && draft.snapshotId) return null;
      if (!draft.templateId) return 'Pick a template.';
      if (!catalog?.templates.some((t) => t.id === draft.templateId && t.kind === draft.kind)) return 'That template is not available any more.';
      return null;
    case 'idc': {
      if (!draft.idc) return draft.kind === 'sandbox' ? null : 'Pick a data centre.';
      const idc = catalog?.idcs.find((i) => i.id === draft.idc);
      if (!idc) return 'That data centre is not available any more.';
      if (idc.status === 'maintenance') return `${idc.name} is under maintenance.`;
      if (idc.status === 'full') return `${idc.name} is full right now.`;
      return null;
    }
    case 'size': {
      const offer = selectedOffer(catalog, draft);
      if (!offer || offer.kind !== draft.kind) return 'Pick a size.';
      if (draft.idc && offer.idc !== draft.idc) return 'Pick a size in this data centre.';
      return null;
    }
    case 'options': {
      const name = validateDisplayName(draft.displayName);
      if (name) return name;
      if (draft.env.length > ENV_LIMITS.maxVars) return `At most ${ENV_LIMITS.maxVars} environment variables.`;
      const seen = new Set<string>();
      for (const e of draft.env) {
        const err = validateEnvName(e.name);
        if (err) return `Environment: ${err}`;
        if (seen.has(e.name)) return `Environment: ${e.name} is set twice.`;
        seen.add(e.name);
        if (new TextEncoder().encode(e.value).length > ENV_LIMITS.maxValueBytes) return `Environment: ${e.name} is longer than 64 KiB.`;
      }
      if (draft.kind === 'container') {
        if (draft.ports.length > PORT_LIMITS.max) return `At most ${PORT_LIMITS.max} ports.`;
        if (draft.access.mode !== 'none') {
          const idc = catalog?.idcs.find((i) => i.id === draft.idc);
          if (idc?.eipAvailable === false) return 'Public access is not offered in this data centre.';
          const cidr = checkCidr(draft.access.cidr);
          if (cidr.error) return cidr.error;
          if (draft.access.mode === 'http') {
            const ports = parsePorts(draft.access.httpPorts);
            if (!ports || ports.length === 0) return 'List the HTTP ports to open (1–65534).';
            if (ports.length > PORT_LIMITS.max) return `At most ${PORT_LIMITS.max} ports.`;
          }
        }
      } else {
        if (draft.timeoutSec < LEASE_LIMITS.sandboxTimeoutMinSec || draft.timeoutSec > LEASE_LIMITS.sandboxTimeoutMaxSec) return 'GMI’s timeout is 1 minute to 24 hours.';
        if (draft.egress.mode === 'allowlist') {
          const bad = parseHostnames(draft.egress.hostnames).find((h) => !HOSTNAME.test(h));
          if (bad) return `“${bad}” is not a host name.`;
        }
      }
      const lease = draft.lease;
      if (lease.maxLifetimeMin !== null && (lease.maxLifetimeMin < LEASE_LIMITS.minLifetimeMin || lease.maxLifetimeMin > LEASE_LIMITS.maxLifetimeMin))
        return 'The lifetime is 10 minutes to 7 days, or no limit.';
      return null;
    }
    case 'review':
      return null;
  }
}

/** The first step (in order) with a problem; `review` when everything is ready. */
export function firstInvalidStep(draft: LaunchDraft, catalog: ComputeCatalog | undefined): LaunchStep {
  for (const step of LAUNCH_STEPS) if (stepError(draft, step, catalog)) return step;
  return 'review';
}

/**
 * Fills what the steps before `upTo` need with sensible defaults (deep links such as `?tab=launch&step=review`):
 * the first official template, the first available data centre with that kind, the cheapest priced size, a name.
 * Never touches what the user already chose.
 */
export function autofill(draft: LaunchDraft, catalog: ComputeCatalog | undefined, upTo: LaunchStep, opts: { preselectSandboxSize?: boolean } = {}): LaunchDraft {
  if (!catalog) return draft;
  const need = (step: LaunchStep) => LAUNCH_STEPS.indexOf(step) < LAUNCH_STEPS.indexOf(upTo);
  let next = draft;
  if (need('template') && !next.templateId && !next.snapshotId) {
    const t = templatesFor(catalog, next.kind)[0];
    if (t) next = { ...next, templateId: t.id, idc: next.idc ?? (next.kind === 'sandbox' ? t.idc : null) };
  }
  if (need('idc') && !next.idc) {
    const withOffers = idcsFor(catalog, next.kind).find((i) => i.status === 'available' && offersFor(catalog, next.kind, i.id).length > 0);
    if (withOffers) next = { ...next, idc: withOffers.id };
  }
  // A size that vanished (the data centre's own list replaced the public one) is picked again.
  // Sandboxes are also preselected on the Size step itself (the recommended size is a safe start; nothing bills before
  // Review). GPU containers are not: the user picks those deliberately.
  // Only from the catalog that decides sizes (the wizard's second pass), or two catalogs would pick in turn forever.
  const sizeNow = need('size') || (opts.preselectSandboxSize !== false && upTo === 'size' && next.kind === 'sandbox');
  if (sizeNow && (!next.offerId || !catalog.offers.some((o) => o.id === next.offerId))) {
    const offer = defaultOffer(catalog, next.kind, next.idc);
    if (offer) next = { ...next, offerId: offer.id, idc: next.idc ?? offer.idc };
  }
  if (LAUNCH_STEPS.indexOf(upTo) >= LAUNCH_STEPS.indexOf('options') && !next.nameTouched && !next.displayName) next = { ...next, displayName: defaultName(selectedTemplate(catalog, next), next.kind) };
  return next;
}

function envInputs(env: EnvDraft[]): EnvVarInput[] | undefined {
  const rows = env.filter((e) => e.name.trim());
  return rows.length ? rows.map((e) => ({ name: e.name.trim(), value: e.value, secret: e.secret })) : undefined;
}

/**
 * The create spec for quoteCreate, or null while a step is invalid or the size has no SKU (signed-out offers are
 * aggregated and cannot be launched; §5.2 rule 3).
 */
export function buildSpec(draft: LaunchDraft, catalog: ComputeCatalog | undefined): ComputeCreateSpec | null {
  if (firstInvalidStep(draft, catalog) !== 'review') return null;
  const offer = selectedOffer(catalog, draft);
  if (!offer?.sku) return null;
  const displayName = draft.displayName.trim();
  if (draft.kind === 'container') {
    if (!draft.templateId || !draft.idc) return null;
    const cidr = checkCidr(draft.access.cidr);
    const tcpPorts = draft.access.mode === 'ssh' ? [22] : draft.access.mode === 'http' ? (parsePorts(draft.access.httpPorts) ?? []) : [];
    return {
      kind: 'container',
      displayName,
      idc: draft.idc,
      sku: offer.sku,
      templateId: draft.templateId,
      env: envInputs(draft.env),
      ports: draft.ports.length ? draft.ports.map((containerPort) => ({ containerPort, protocol: 'TCP' as const })) : undefined,
      ssh: draft.access.mode === 'ssh' ? { mode: 'app_key' } : { mode: 'none' },
      access:
        draft.access.mode === 'none' || !cidr.cidr
          ? { mode: 'none' }
          : { mode: 'public', allowCidrs: [cidr.cidr], tcpPorts, ...(cidr.allOpen ? { allOpen: true } : {}) },
      lease: draft.lease,
    };
  }
  return {
    kind: 'sandbox',
    displayName,
    idc: draft.idc,
    product: offer.sku,
    source: draft.snapshotId ? { snapshotId: draft.snapshotId } : { templateId: draft.templateId! },
    timeoutSec: draft.timeoutSec,
    onTimeout: draft.onTimeout,
    secure: draft.secure,
    egress: draft.egress.mode === 'open' ? { mode: 'open' } : { mode: 'allowlist', hostnames: parseHostnames(draft.egress.hostnames), cidrs: [] },
    env: envInputs(draft.env),
    purpose: 'computer',
    threadId: null,
    lease: draft.lease,
  };
}

/** A daily budget is required before a container or a GPU sandbox (§9.3). */
export function needsDailyBudget(draft: LaunchDraft, offer: ComputeOffer | null): boolean {
  return draft.kind === 'container' || Boolean(offer && offer.gpuCount > 0);
}
