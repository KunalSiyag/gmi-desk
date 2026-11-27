// The `compute` API (compute.md §6, §7, §13.1 `ComputeApi`), the guard's `ResourceActions` and the secret-substring
// check (`SecretScreen`). C1-C. Guard-specific work (prices × budgets, lease assessments, accrual, alarms, idle) is
// delegated to the C1-D `Guard` interface.
//
// Every action that starts or extends billing beyond what was approved needs a NATIVE confirmation shown by main
// (DC4): create, resume, delete, extend beyond the approved lease, open CIDRs, insecure sandboxes, lease loosening or
// deleting sooner, release EIP, adopt, dismissing an unresolved create. The renderer's review step is UX only.
// Secret env values live in the quote (main memory) until the create request, never in the journal, registry, logs or
// the quote returned to the renderer.
import { randomUUID } from 'node:crypto';
import {
  LEASE_LIMITS,
  type ComputeAlarm,
  type ComputeApi,
  type ComputeCapabilities,
  type ComputeCreateSpec,
  type ComputeNetworkInventory,
  type ComputeResource,
  type ComputeResourceDetail,
  type ComputeSnapshot,
  type ComputeState,
  type ContainerCreateSpec,
  type CreateQuote,
  type EnvVarInput,
  type LeasePolicy,
  type SandboxCreateSpec,
  type SnapshotState,
} from '@shared/contracts/compute';
import type { ComputeKeyInfo } from '@shared/contracts/auth';
import { GmiError, type GmiErrorShape } from '@shared/contracts/errors';
import { consoleDeepLink, consoleUrl, UUID_PATTERN } from '@shared/app';
import type { Platform } from '../../core/context';
import type { Logger } from '../../core/logger';
import type { SecureStore } from '../../core/secure-store';
import type { AuthService, ComputeKeyProvider } from '../../core/services';
import { readTokens } from '../auth/secrets';
import { SECURE_KEYS } from '../auth/constants';
import type { ComputeCatalogService } from './catalog';
import type { CeApi } from './ce/client';
import { createContainer, reconcileContainer, type CreateDeps, type PreparedContainer } from './ce/create';
import { checkAccess, checkCidr, describeCidr, replaceFirewallCidr, runNetworkSaga, SAGA_RUNNING_CAP_MS, teardownContainer, type NetworkDeps } from './ce/network';
import { UNRESOLVED_STATES, type Journal, type NetworkPlan } from './journal';
import { DISPLAY_NAME_MAX, DISPLAY_NAME_PATTERN, containerOwnership, displayNameFromRemote, installLabel, installTag, parseUnmanagedId, remoteName, sandboxOwnership, slug, unmanagedId } from './names';
import { closeEipInterval } from './accrual';
import { blankRecord, defaultLease } from './registry';
import type { SandboxApi } from './sandbox/client';
import type { DataPlaneApi, TokenCache } from './sandbox/dataplane';
import type { V2SandboxSummary, V2Snapshot } from './sandbox/dto';
import { createSandbox, deleteSandbox, pauseSandbox, reconcileSandbox, resumeSandbox, setSandboxTimeout, snapshotSandbox, type LifecycleDeps, type PreparedSandbox } from './sandbox/lifecycle';
import type { SafeCeContainer } from './sanitize';
import { cePhase, observeContainer, observeSandbox, v2Phase, type ComputeSupervisor } from './supervisor';
import type { Sweeper } from './sweep';
import { COMPUTE_TIMING, type ComputeRecord, type Guard, type GuardCause, type QuoteAssessment, type QuoteAssessmentInput, type ResourceActions, type SecretScreen } from './types';

// ─── Secret screen (§6.1, T15) ─────────────────────────────────────────────────────────────────────────────────────

/** Shorter values are not treated as secrets (they would match ordinary text). */
const MIN_SECRET_LENGTH = 12;

export function createSecretScreen(deps: { secure: SecureStore; keys: ComputeKeyProvider; env?: Record<string, string | undefined> }): SecretScreen {
  async function collect(): Promise<string[]> {
    const out: string[] = [];
    const add = (v: string | null | undefined) => {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t.length >= MIN_SECRET_LENGTH) out.push(t);
    };
    add(await deps.secure.get(SECURE_KEYS.inferenceKey).catch(() => null));
    const tokens = await readTokens(deps.secure).catch(() => null);
    add(tokens?.access_token);
    add(tokens?.refresh_token);
    add(await deps.keys.getComputeKey().catch(() => null));
    add((deps.env ?? process.env).GMI_API_KEY);
    return out;
  }
  return {
    async assertNoSecrets(values) {
      if (values.length === 0) return;
      const secrets = await collect();
      if (secrets.length === 0) return;
      for (const { label, value } of values) {
        const v = typeof value === 'string' ? value.trim() : '';
        if (!v) continue;
        if (secrets.some((s) => v.includes(s))) {
          throw new GmiError('invalid_input', `${label} contains one of your GMI keys or sign-in tokens. GMI Desk never sends them to a container or sandbox.`);
        }
      }
    },
  };
}

/** Hosts that accept uploads: never allowed by default (§7.1); named in the create dialog when a user adds them. */
export const NEVER_DEFAULT_EGRESS: ReadonlySet<string> = new Set(['github.com', 'api.github.com', 'uploads.github.com', 'upload.pypi.org']);

const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

// ─── Validation (§6.1; main is authoritative) ──────────────────────────────────────────────────────────────────────

const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const CREATE_LIMITS = { envMax: 64, envValueMaxBytes: 64 * 1024, portsMax: 5, portMin: 1, portMax: 65_534, argsMax: 64, argMaxBytes: 4096, commandMaxBytes: 16 * 1024, hostnamesMax: 64 } as const;
const HOSTNAME = /^(\*\.)?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const bad = (message: string) => new GmiError('invalid_input', message);

export function validateDisplayName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > DISPLAY_NAME_MAX || !DISPLAY_NAME_PATTERN.test(n)) {
    throw bad(`The name must be 1–${DISPLAY_NAME_MAX} characters: letters, digits, spaces, "-", "_" or ".", starting and ending with a letter or digit.`);
  }
  return n;
}

export function validateLease(kind: 'container' | 'sandbox', lease: LeasePolicy): LeasePolicy {
  if (!lease || typeof lease !== 'object') throw bad('A lease is required.');
  const actions = ['delete', 'pause', 'notify'];
  if (!actions.includes(lease.onExpiry) || !actions.includes(lease.onBudget)) throw bad('Unknown lease action.');
  const max = lease.maxLifetimeMin;
  if (max !== null && (!Number.isInteger(max) || max < LEASE_LIMITS.minLifetimeMin || max > LEASE_LIMITS.maxLifetimeMin)) {
    throw bad(`The lifetime must be ${LEASE_LIMITS.minLifetimeMin} minutes to 7 days, or no limit.`);
  }
  if (kind === 'container') {
    if (lease.onExpiry === 'pause' || lease.onBudget === 'pause') throw bad('Containers cannot be paused: choose delete or notify.');
    return { maxLifetimeMin: max, onExpiry: lease.onExpiry, idlePauseMin: null, extendOnActivity: false, onBudget: lease.onBudget };
  }
  const idle = lease.idlePauseMin;
  if (idle !== null && (!Number.isInteger(idle) || idle < LEASE_LIMITS.minIdlePauseMin || idle > LEASE_LIMITS.maxIdlePauseMin)) {
    throw bad(`Idle pause must be ${LEASE_LIMITS.minIdlePauseMin} minutes to 24 hours, or off.`);
  }
  return { maxLifetimeMin: max, onExpiry: lease.onExpiry, idlePauseMin: idle, extendOnActivity: lease.extendOnActivity === true, onBudget: lease.onBudget };
}

export function validateEnv(env: EnvVarInput[] | undefined): EnvVarInput[] {
  const list = env ?? [];
  if (!Array.isArray(list) || list.length > CREATE_LIMITS.envMax) throw bad(`At most ${CREATE_LIMITS.envMax} environment variables.`);
  const seen = new Set<string>();
  return list.map((e) => {
    if (!e || typeof e.name !== 'string' || !ENV_NAME.test(e.name) || e.name.length > 256) throw bad(`"${String(e?.name).slice(0, 40)}" is not a valid variable name.`);
    if (seen.has(e.name)) throw bad(`${e.name} is set twice.`);
    seen.add(e.name);
    if (typeof e.value !== 'string' || bytes(e.value) > CREATE_LIMITS.envValueMaxBytes) throw bad(`${e.name} is longer than 64 KiB.`);
    return { name: e.name, value: e.value, secret: e.secret === true };
  });
}

function validatePorts(ports: number[], what: string): number[] {
  if (!Array.isArray(ports) || ports.length > CREATE_LIMITS.portsMax) throw bad(`At most ${CREATE_LIMITS.portsMax} ${what}.`);
  const out = [...new Set(ports)];
  for (const p of out) if (!Number.isInteger(p) || p < CREATE_LIMITS.portMin || p > CREATE_LIMITS.portMax) throw bad(`Port ${String(p)} is outside 1–65534.`);
  return out;
}

/** Secret values replaced by '••••' (what the renderer gets back). */
export function maskSpec<T extends ComputeCreateSpec>(spec: T): T {
  return { ...spec, ...(spec.env ? { env: spec.env.map((e) => (e.secret ? { ...e, value: '••••' } : { ...e })) } : {}) };
}

// ─── The service ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ComputeServiceCore {
  platform: Platform;
  log: Logger;
  installId: string;
  mock: boolean;
  now: () => Date;
}

export interface ComputeApiDeps {
  core: ComputeServiceCore;
  keys: ComputeKeyProvider;
  auth: AuthService;
  catalog: ComputeCatalogService;
  ce: CeApi;
  sandbox: SandboxApi;
  dataPlane: DataPlaneApi | null;
  tokens: TokenCache | null;
  registry: import('./types').Registry;
  journal: Journal;
  supervisor: ComputeSupervisor;
  guard: Guard;
  sweeper: Sweeper;
  secrets: SecretScreen;
  /** One opt-in call to a public IP echo service (disclosed in the UI). */
  detectIp: () => Promise<{ ip: string | null; service: string }>;
  sleep?: (ms: number) => Promise<void>;
}

interface StoredQuote {
  quoteId: string;
  spec: ComputeCreateSpec;
  input: QuoteAssessmentInput;
  expiresAt: number;
  templateName: string | null;
  /** Ports the template exposes by itself (official CE templates: 22, 8888); named in the native dialog. */
  templatePorts: Array<{ port: number; protocol: 'TCP' | 'UDP'; label: string | null }>;
  sshKeyIds: string[];
  network: NetworkPlan | null;
  openCidrs: string[];
  priced: QuoteAssessment;
}

export interface ComputeServiceInstance {
  api: ComputeApi;
  actions: ResourceActions;
  toResource(rec: ComputeRecord): ComputeResource;
  listManaged(): ComputeResource[];
  /** Managed + the unmanaged rows already known, without a network call (the `compute:resources` event). */
  listVisible(): ComputeResource[];
  getState(): Promise<ComputeState>;
  /** Entitlement probe (§4.1 step 5): two free GETs. */
  checkAccess(): Promise<void>;
  /** Reconciles every unresolved journal entry (startup, before the supervisor starts). */
  reconcileJournal(): Promise<void>;
  /** Network sagas waiting for `running`. */
  resumeSagas(): void;
  onChange(listener: () => void): () => void;
  /** Background work (reconciles, teardown polls); tests await it. */
  idle(): Promise<void>;
}

const QUOTES_MAX = 20;
const CREATE_RATE = { windowMs: 10 * 60_000, max: 3 } as const;

const usd = (n: number | null, digits = 2) => (n === null ? 'price unknown' : `$${n.toFixed(n > 0 && n < 0.1 ? 4 : digits)}`);
/** The create dialog's line for a sandbox's outbound traffic (every host and CIDR is named). */
export function egressLine(egress: SandboxCreateSpec['egress']): string {
  if (egress.mode === 'open') return 'Egress: open (it can reach any host on the internet).';
  const all = [...egress.hostnames, ...egress.cidrs];
  return all.length ? `Egress: only ${all.join(', ')}.` : 'Egress: all outbound traffic blocked.';
}

const hoursText = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);

const CAPS_NONE: ComputeCapabilities = { terminal: false, files: false, previews: false, logs: false, restart: false, pause: false, snapshot: false, extend: false, network: false };

export function capabilitiesOf(rec: Pick<ComputeRecord, 'kind' | 'managed' | 'phase' | 'remoteId'>): ComputeCapabilities {
  if (!rec.managed || !rec.remoteId || rec.phase === 'deleted' || rec.phase === 'deleting') return { ...CAPS_NONE };
  if (rec.kind === 'container') {
    // Terminal and files for containers come with C2-E (gated on probe P-CE).
    return { ...CAPS_NONE, logs: true, restart: rec.phase !== 'creating', extend: true, network: true };
  }
  return { terminal: true, files: true, previews: true, logs: false, restart: false, pause: rec.phase === 'running', snapshot: rec.phase === 'running', extend: true, network: false };
}

export function createComputeService(deps: ComputeApiDeps): ComputeServiceInstance {
  const { core, registry, journal, supervisor, guard } = deps;
  const log = core.log.child('compute');
  const tag = installTag(core.installId);
  const label = installLabel(core.installId);
  const quotes = new Map<string, StoredQuote>();
  const createTimes: number[] = [];
  const background = new Set<Promise<unknown>>();
  const listeners = new Set<() => void>();
  const entitlement: { containers: ComputeState['access']['containers']; sandboxes: ComputeState['access']['sandboxes']; checkedAt: string | null } = {
    containers: 'unknown',
    sandboxes: 'unknown',
    checkedAt: null,
  };
  const sagaRunning = new Set<string>();
  const nowIso = () => supervisor.clock.now().toISOString();
  const nowMs = () => supervisor.clock.now().getTime();

  const changed = () => {
    for (const l of [...listeners]) {
      try {
        l();
      } catch (error) {
        log.warn('compute listener failed', { error });
      }
    }
  };

  function track<T>(p: Promise<T>): Promise<T> {
    const q = p.catch((error: unknown) => {
      log.warn('background compute task failed', { code: error instanceof GmiError ? error.code : 'internal' });
    });
    background.add(q);
    void q.finally(() => background.delete(q));
    return p;
  }

  const networkDeps = (): NetworkDeps => ({ ce: deps.ce, registry, journal, alarms: guard.alarms, prices: deps.catalog, log: core.log, ...(deps.sleep ? { sleep: deps.sleep } : {}), now: () => supervisor.clock.now() });
  const createDeps: CreateDeps = { ce: deps.ce, registry, journal, alarms: guard.alarms, prices: deps.catalog, supervisor, log: core.log, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  const lifecycleDeps: LifecycleDeps = { sandbox: deps.sandbox, tokens: deps.tokens, dataPlane: deps.dataPlane, registry, journal, alarms: guard.alarms, prices: deps.catalog, supervisor, log: core.log, ...(deps.sleep ? { sleep: deps.sleep } : {}) };

  // ── records → contract shapes ──

  function toResource(rec: ComputeRecord): ComputeResource {
    let cost = { accruedUsd: 0, accruedTodayUsd: 0, leaseEndsAt: null as string | null, idlePauseAt: null as string | null };
    try {
      cost = guard.cost(rec.id);
    } catch {
      // the guard does not know it (yet)
    }
    return {
      id: rec.id,
      kind: rec.kind,
      backend: rec.backend,
      remoteId: rec.remoteId,
      name: rec.name,
      displayName: rec.displayName,
      managed: rec.managed,
      purpose: rec.purpose,
      threadId: rec.threadId,
      phase: rec.phase,
      rawState: rec.rawState,
      reason: rec.reason,
      idc: rec.idc,
      sku: rec.sku,
      templateName: rec.templateName,
      listUsdPerHour: rec.listUsdPerHour,
      createdAt: rec.createdAt,
      runningSince: rec.runningSince,
      serverEndsAt: rec.serverEndsAt,
      leaseEndsAt: cost.leaseEndsAt,
      pausedExpiresAt: rec.pausedExpiresAt,
      idlePauseAt: cost.idlePauseAt,
      lease: rec.lease ? { ...rec.lease } : null,
      accruedUsd: cost.accruedUsd,
      accruedTodayUsd: cost.accruedTodayUsd,
      network: rec.network ? structuredClone(rec.network) : null,
      secure: rec.secure,
      egressLocked: rec.egressLocked,
      capabilities: capabilitiesOf(rec),
      pendingAction: supervisor.pendingAction(rec.id),
      actionPending: rec.actionPending ? { ...rec.actionPending } : null,
      updatedAt: rec.updatedAt,
    };
  }

  function toDetail(rec: ComputeRecord): ComputeResourceDetail {
    return {
      ...toResource(rec),
      envNames: [...rec.envNames],
      command: rec.command,
      args: [...rec.args],
      sshKeyNames: [...rec.sshKeyNames],
      snapshotId: rec.snapshotId,
      lastError: rec.lastError,
      history: rec.history.slice(0, 50),
    };
  }

  /** A read-only org row (not in the registry). */
  function unmanagedContainer(c: SafeCeContainer): ComputeRecord {
    return blankRecord(
      {
        id: unmanagedId('ce', c.id),
        kind: 'container',
        backend: 'ce',
        name: c.name,
        displayName: containerOwnership(c.name, tag) === 'unmanaged' ? c.name : displayNameFromRemote(c.name),
        managed: false,
        remoteId: c.id,
        idc: c.idc,
        sku: c.product,
        listUsdPerHour: deps.catalog.price(c.product, c.idc).usdPerHour,
        phase: cePhase(c.status, null),
        rawState: typeof c.status === 'string' ? c.status : null,
        createdAt: c.createdAt ?? null,
        envNames: c.envNames ?? [],
      },
      nowIso(),
    );
  }

  function unmanagedSandbox(s: V2SandboxSummary): ComputeRecord {
    const sku = (s as { product?: string }).product ?? null;
    return blankRecord(
      {
        id: unmanagedId('sandbox_v2', s.id),
        kind: 'sandbox',
        backend: 'sandbox_v2',
        name: `sandbox-${s.sandbox_key ?? s.id}`,
        displayName: `Sandbox ${s.sandbox_key ?? s.id.slice(0, 8)}`,
        managed: false,
        remoteId: s.id,
        purpose: s.metadata?.purpose === 'agent' ? 'agent' : s.metadata?.purpose === 'computer' ? 'computer' : null,
        idc: s.idc_name ?? null,
        sku,
        listUsdPerHour: sku ? deps.catalog.price(sku, s.idc_name ?? null).usdPerHour : null,
        phase: v2Phase(s.state),
        rawState: s.state,
        createdAt: s.created_at ?? null,
      },
      nowIso(),
    );
  }

  function listManaged(): ComputeResource[] {
    return registry.list().filter((r) => r.managed).map(toResource);
  }

  /** The org-wide sandbox listing of the last `listResources({includeUnmanaged})` (null: none yet / no key). */
  let orgSandboxes: V2SandboxSummary[] | null = null;

  /** Managed rows plus the unmanaged ones already known (no network): what `compute:resources` carries. */
  function listVisible(): ComputeResource[] {
    const out = listManaged();
    const snap = supervisor.remote();
    for (const c of snap.containers ?? []) if (!registry.findByRemote('ce', c.id)) out.push(toResource(unmanagedContainer(c)));
    for (const sb of orgSandboxes ?? snap.sandboxes ?? []) if (!registry.findByRemote('sandbox_v2', sb.id)) out.push(toResource(unmanagedSandbox(sb)));
    return out;
  }

  function mustManaged(id: string): ComputeRecord {
    const rec = typeof id === 'string' ? registry.get(id) : null;
    if (!rec || rec.tombstone) {
      if (typeof id === 'string' && parseUnmanagedId(id)) throw bad('This resource is not managed by this GMI Desk. Adopt it first.');
      throw new GmiError('not_found', 'GMI Desk does not know this resource.');
    }
    if (!rec.managed) throw bad('This resource is not managed by this GMI Desk. Adopt it first.');
    return rec;
  }

  const mustRemote = (rec: ComputeRecord): string => {
    if (!rec.remoteId) throw bad('GMI has not confirmed this resource yet. Wait for the check to finish.');
    return rec.remoteId;
  };

  async function confirm(title: string, message: string, detail: string[], confirmLabel: string): Promise<void> {
    const ok = await core.platform.confirm({ title, message, detail: detail.filter(Boolean).join('\n'), confirmLabel, cancelLabel: 'Cancel' });
    if (!ok) throw new GmiError('cancelled', 'Cancelled.');
  }

  function refusalError(shape: GmiErrorShape): GmiError {
    return new GmiError(shape.code, shape.message, { detail: shape.detail ?? null, status: shape.status ?? null });
  }

  // ── state ──

  function accessKey(): ComputeKeyInfo {
    const info = deps.auth.getState().computeKey;
    return info ?? { status: 'missing', last4: null, keyId: null, orgId: null, orgMatchesAccount: null, validatedAt: null, error: null };
  }

  async function getState(): Promise<ComputeState> {
    let totals = { todayUsd: 0, monthUsd: 0, running: { count: 0, usdPerHour: 0 } };
    try {
      totals = guard.totals();
    } catch {
      // guard not ready
    }
    let alarms: ComputeAlarm[] = [];
    try {
      alarms = guard.alarms.list();
    } catch {
      alarms = [];
    }
    const sweep = deps.sweeper.last();
    return {
      access: { key: accessKey(), containers: entitlement.containers, sandboxes: entitlement.sandboxes, checkedAt: entitlement.checkedAt },
      running: totals.running,
      todayUsd: totals.todayUsd,
      monthUsd: totals.monthUsd,
      alarms,
      apiHealth: supervisor.health(),
      org: sweep?.org ?? null,
      dailyBudgetSet: guard.dailyBudgetSet(),
      lastSweepAt: sweep?.at ?? null,
      mock: core.mock,
    };
  }

  async function checkAccessNow(): Promise<void> {
    const key = await deps.keys.getComputeKey().catch(() => null);
    if (!key) {
      entitlement.containers = 'unknown';
      entitlement.sandboxes = 'unknown';
      entitlement.checkedAt = null;
      changed();
      return;
    }
    entitlement.containers = 'checking';
    entitlement.sandboxes = 'checking';
    changed();
    const verdict = (r: PromiseSettledResult<unknown>): ComputeState['access']['containers'] => {
      if (r.status === 'fulfilled') return 'entitled';
      return r.reason instanceof GmiError && r.reason.code === 'not_entitled' ? 'not_entitled' : 'error';
    };
    const [c, s] = await Promise.allSettled([deps.ce.listContainers(), deps.sandbox.list({ pageSize: 1 })]);
    entitlement.containers = verdict(c);
    entitlement.sandboxes = verdict(s);
    entitlement.checkedAt = nowIso();
    changed();
  }

  // ── quotes ──

  function purgeQuotes() {
    const t = nowMs();
    for (const [id, q] of quotes) if (q.expiresAt <= t) quotes.delete(id);
    while (quotes.size >= QUOTES_MAX) {
      const oldest = quotes.keys().next().value;
      if (oldest === undefined) break;
      quotes.delete(oldest);
    }
  }

  async function prepareContainer(spec: ContainerCreateSpec, warnings: string[]): Promise<Omit<StoredQuote, 'quoteId' | 'expiresAt' | 'priced'>> {
    if (typeof spec.idc !== 'string' || typeof spec.sku !== 'string' || typeof spec.templateId !== 'string') throw bad('Choose a data centre, a size and a template.');
    const catalog = await deps.catalog.getCatalog({ idc: spec.idc });
    const idc = catalog.idcs.find((i) => i.id === spec.idc);
    if (!idc) throw bad('Unknown data centre.');
    if (idc.status !== 'available') throw bad(`${idc.name} is ${idc.status === 'maintenance' ? 'under maintenance' : 'not accepting new containers'} right now.`);
    const offer = catalog.offers.find((o) => o.kind === 'container' && o.sku === spec.sku && o.idc === spec.idc);
    if (!offer || offer.entitled === false) throw bad('This size is not available to your organization in that data centre.');
    const template = catalog.templates.find((t) => t.kind === 'container' && t.id === spec.templateId);
    if (!template) throw bad('Unknown template.');
    const env = validateEnv(spec.env);
    const command = spec.command == null ? null : String(spec.command);
    if (command !== null && bytes(command) > CREATE_LIMITS.commandMaxBytes) throw bad('The command is too long.');
    const args = spec.args ?? [];
    if (!Array.isArray(args) || args.length > CREATE_LIMITS.argsMax || args.some((a) => typeof a !== 'string' || bytes(a) > CREATE_LIMITS.argMaxBytes)) throw bad('Too many or too long arguments.');
    const ports = (spec.ports ?? []).map((p) => ({ containerPort: p.containerPort, protocol: p.protocol === 'UDP' ? ('UDP' as const) : ('TCP' as const) }));
    validatePorts(ports.map((p) => p.containerPort), 'ports');
    let sshKeyIds: string[] = [];
    if (spec.ssh?.mode === 'account_keys') {
      const keys = await deps.ce.listSshKeys();
      sshKeyIds = [...new Set(spec.ssh.keyIds)];
      if (sshKeyIds.length === 0 || sshKeyIds.some((k) => !keys.some((x) => x.id === k))) throw bad('Choose SSH keys from your GMI account.');
    } else if (spec.ssh?.mode === 'app_key') {
      throw bad('SSH with a key made by GMI Desk is not available yet. Use one of your account keys.');
    } else if (!spec.ssh || spec.ssh.mode !== 'none') {
      throw bad('Choose how SSH works.');
    }
    const lease = validateLease('container', spec.lease);
    let network: NetworkPlan | null = null;
    let openCidrs: string[] = [];
    let access: ContainerCreateSpec['access'] = { mode: 'none' };
    if (spec.access?.mode === 'public') {
      const checked = checkAccess(spec.access.allowCidrs);
      const tcpPorts = validatePorts(spec.access.tcpPorts, 'public ports');
      if (tcpPorts.length === 0) throw bad('Choose at least one public port.');
      const eip = deps.catalog.eipSku(spec.idc);
      if (!eip) throw bad('Public access is not available in this data centre.');
      network = { cidrs: checked.rules.map((r) => r.cidr), tcpPorts, eipSku: eip.sku, state: 'pending', step: 1 };
      openCidrs = checked.rules.filter((r) => r.open).map((r) => r.cidr);
      access = { mode: 'public', allowCidrs: network.cidrs, tcpPorts, allOpen: checked.allOpen };
      if (checked.open) warnings.push(`Open to ${checked.rules.filter((r) => r.open).map(describeCidr).join(', ')}.`);
    } else if (spec.access && spec.access.mode !== 'none') {
      throw bad('Unknown access mode.');
    }
    if (lease.maxLifetimeMin === null) warnings.push('No automatic limit: it keeps billing until you delete it.');
    if (lease.onBudget === 'notify') warnings.push('Your budget will not stop this container.');
    const normalized: ContainerCreateSpec = {
      kind: 'container',
      displayName: validateDisplayName(spec.displayName),
      idc: spec.idc,
      sku: spec.sku,
      templateId: spec.templateId,
      command,
      args: [...args],
      env,
      ports,
      ssh: spec.ssh.mode === 'account_keys' ? { mode: 'account_keys', keyIds: sshKeyIds } : { mode: 'none' },
      access,
      lease,
    };
    const lines: QuoteAssessmentInput['lines'] = [{ sku: spec.sku, label: `${offer.gpuCount ? `${offer.gpuCount}×${offer.gpuModel ?? 'GPU'}` : 'CPU'} container`, idc: spec.idc }];
    if (network) lines.push({ sku: network.eipSku, label: 'Public IP (until released)', idc: spec.idc });
    return {
      spec: normalized,
      input: { action: 'create', kind: 'container', lines, hours: (lease.maxLifetimeMin ?? 24 * 60) / 60, gpu: offer.gpuCount > 0, resourceId: null },
      templateName: template.name,
      templatePorts: template.defaultPorts.map((p) => ({ port: p.port, protocol: p.protocol, label: p.label })),
      sshKeyIds,
      network,
      openCidrs,
    };
  }

  async function prepareSandbox(spec: SandboxCreateSpec, warnings: string[]): Promise<Omit<StoredQuote, 'quoteId' | 'expiresAt' | 'priced'>> {
    if (typeof spec.product !== 'string' || !/^gmi\.sandbox\.[a-z0-9._-]+$/i.test(spec.product)) throw bad('Choose a sandbox size.');
    const catalog = await deps.catalog.getCatalog({ idc: spec.idc ?? null });
    const offer = catalog.offers.find((o) => o.kind === 'sandbox' && o.sku === spec.product && (!spec.idc || o.idc === spec.idc));
    if (!offer || offer.entitled === false) throw bad('This sandbox size is not available to your organization.');
    if (spec.idc) {
      const idc = catalog.idcs.find((i) => i.id === spec.idc);
      if (idc && idc.status === 'maintenance') throw bad(`${idc.name} is under maintenance right now.`);
    }
    let templateName: string | null = null;
    if (spec.source && 'templateId' in spec.source) {
      const templateId = spec.source.templateId;
      if (typeof templateId !== 'string' || !templateId) throw bad('Choose a template.');
      const t = catalog.templates.find((x) => x.kind === 'sandbox' && x.id === templateId);
      if (t) templateName = t.name;
      else if (catalog.templates.some((x) => x.kind === 'sandbox')) throw bad('Unknown sandbox template.');
    } else if (spec.source && 'snapshotId' in spec.source) {
      if (typeof spec.source.snapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.source.snapshotId)) throw bad('Unknown snapshot.');
    } else throw bad('Choose a template or a snapshot.');
    if (!Number.isInteger(spec.timeoutSec) || spec.timeoutSec < LEASE_LIMITS.sandboxTimeoutMinSec || spec.timeoutSec > LEASE_LIMITS.sandboxTimeoutMaxSec) {
      throw bad('The sandbox timeout must be 1 minute to 24 hours.');
    }
    if (spec.onTimeout !== 'pause' && spec.onTimeout !== 'kill') throw bad('Choose what happens at the timeout.');
    const purpose = spec.purpose === 'agent' ? 'agent' : 'computer';
    let egress: SandboxCreateSpec['egress'] = { mode: 'open' };
    if (spec.egress?.mode === 'allowlist') {
      const hostnames = [...new Set((spec.egress.hostnames ?? []).map((h) => (typeof h === 'string' ? h.trim().toLowerCase() : h)))];
      if (hostnames.length > CREATE_LIMITS.hostnamesMax || hostnames.some((h) => typeof h !== 'string' || !HOSTNAME.test(h))) throw bad('An allowed host name is not valid.');
      const cidrs = [...new Set((spec.egress.cidrs ?? []).map((c) => checkCidr(c).cidr))];
      // §7.1: an agent sandbox starts with deny-all egress. Hosts are added later, per thread, each with its own native
      // confirmation (H4); the create path never widens it, whoever asks (renderer or broker).
      if (purpose === 'agent' && (hostnames.length > 0 || cidrs.length > 0)) {
        throw bad('Agent sandboxes start with all outbound traffic blocked. Allow hosts per thread after it starts.');
      }
      const never = hostnames.filter((h) => NEVER_DEFAULT_EGRESS.has(h as string));
      if (never.length) warnings.push(`Outbound traffic to ${never.join(', ')} is allowed: these hosts accept uploads.`);
      egress = { mode: 'allowlist', hostnames: hostnames as string[], cidrs };
    } else if (purpose === 'agent') {
      throw bad('Agent sandboxes always start with all outbound traffic blocked (an allowlist).');
    } else if (spec.egress && spec.egress.mode !== 'open') {
      throw bad('Unknown egress mode.');
    }
    const lease = validateLease('sandbox', spec.lease);
    const env = validateEnv(spec.env);
    if (!spec.secure) warnings.push('Port previews will be reachable without a token.');
    const normalized: SandboxCreateSpec = {
      kind: 'sandbox',
      displayName: validateDisplayName(spec.displayName),
      idc: spec.idc ?? null,
      product: spec.product,
      source: 'templateId' in spec.source ? { templateId: spec.source.templateId } : { snapshotId: spec.source.snapshotId },
      timeoutSec: spec.timeoutSec,
      onTimeout: spec.onTimeout,
      secure: spec.secure !== false,
      egress,
      env,
      purpose,
      threadId: typeof spec.threadId === 'string' ? spec.threadId : null,
      lease,
    };
    const leaseHours = (lease.maxLifetimeMin ?? 24 * 60) / 60;
    const hours = lease.extendOnActivity ? leaseHours : Math.min(leaseHours, spec.timeoutSec / 3600);
    return {
      spec: normalized,
      input: { action: 'create', kind: 'sandbox', lines: [{ sku: spec.product, label: `Sandbox ${offer.sizeLabel ?? ''}`.trim(), idc: offer.idc }], hours, gpu: offer.gpuCount > 0, resourceId: null },
      templateName,
      templatePorts: [],
      sshKeyIds: [],
      network: null,
      openCidrs: [],
    };
  }

  async function quoteCreate(spec: ComputeCreateSpec): Promise<CreateQuote> {
    await deps.keys.requireComputeKey();
    if (!spec || (spec.kind !== 'container' && spec.kind !== 'sandbox')) throw bad('Unknown resource kind.');
    const warnings: string[] = [];
    const prepared = spec.kind === 'container' ? await prepareContainer(spec, warnings) : await prepareSandbox(spec, warnings);
    const s = prepared.spec;
    const screened = [
      ...(s.env ?? []).map((e) => ({ label: `Variable ${e.name}`, value: e.value })),
      ...(s.kind === 'container' ? [...(s.command ? [{ label: 'The command', value: s.command }] : []), ...(s.args ?? []).map((a, i) => ({ label: `Argument ${i + 1}`, value: a }))] : []),
    ];
    await deps.secrets.assertNoSecrets(screened);
    for (const e of s.env ?? []) if (JWT_SHAPE.test(e.value)) warnings.push(`${e.name} looks like an access token: anyone with access to this ${s.kind} can read it.`);
    const priced = await guard.assessQuote(prepared.input);
    purgeQuotes();
    const quoteId = randomUUID();
    const expiresAt = nowMs() + COMPUTE_TIMING.quoteTtlMs;
    quotes.set(quoteId, { ...prepared, quoteId, expiresAt, priced });
    return {
      quoteId,
      spec: maskSpec(s),
      lines: priced.lines,
      usdPerHour: priced.usdPerHour,
      maxUsd: priced.maxUsd,
      priceSource: priced.priceSource,
      priceAgeSec: priced.priceAgeSec,
      budget: priced.budget,
      warnings: [...(priced.refusal ? [priced.refusal.message] : []), ...priced.warnings, ...warnings],
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** "Try again" after an unclear create (§6.2): list first, then ask natively before a second one. */
  async function checkEarlierAttempt(q: StoredQuote): Promise<string[]> {
    const s = q.spec;
    const sku = s.kind === 'container' ? s.sku : s.product;
    const similar = journal.unresolved().filter((e) => (e.state === 'unknown' || e.state === 'failed_unknown') && e.kind === s.kind && e.sku === sku && e.displayName === s.displayName);
    const still: string[] = [];
    for (const e of similar) {
      const result = e.backend === 'ce' ? await reconcileContainer(createDeps, e.rid) : await reconcileSandbox(lifecycleDeps, e.rid);
      if (result !== 'confirmed') still.push(e.name);
    }
    return still;
  }

  function dialogFor(q: StoredQuote, priced: QuoteAssessment): { title: string; message: string; detail: string[]; confirmLabel: string } {
    const s = q.spec;
    const lease = s.lease;
    const rate = priced.usdPerHour;
    const where = s.kind === 'container' ? s.idc : (s.idc ?? 'the default data centre');
    const what = priced.lines[0]?.label ?? (s.kind === 'container' ? 'container' : 'sandbox');
    const detail: string[] = [];
    const maxText = priced.maxUsd !== null ? ` (≤ ${usd(priced.maxUsd)})` : '';
    if (lease.maxLifetimeMin === null) {
      detail.push(`No automatic limit: this keeps billing ${usd(rate)}/h until you delete it.`);
    } else {
      const verb = lease.onExpiry === 'delete' ? 'auto-delete' : lease.onExpiry === 'pause' ? 'auto-pause' : 'notify you';
      detail.push(`${verb} after ${hoursText(lease.maxLifetimeMin)}${maxText}.`);
    }
    if (s.kind === 'sandbox') detail.push(`GMI ${s.onTimeout === 'pause' ? 'pauses' : 'deletes'} it after ${hoursText(Math.round(s.timeoutSec / 60))} unless it is extended.`);
    if (s.kind === 'sandbox') detail.push(egressLine(s.egress));
    const onBudget = lease.onBudget === 'notify' ? 'keep running and notify' : lease.onBudget === 'pause' ? 'pause it' : 'delete it';
    detail.push(`If the budget runs out: ${onBudget}.`);
    if (s.kind === 'container' && lease.onBudget === 'notify') detail.push('Your budget will not stop this container.');
    if (s.kind === 'container' && s.access.mode === 'public' && q.network) {
      const eipLine = priced.lines.find((l) => l.label.startsWith('Public IP'));
      detail.push(`Public IP: +${usd(eipLine?.usdPerHour ?? null)}/h until released.`);
      detail.push(`Open to ${q.network.cidrs.map((c) => describeCidr(checkCidr(c))).join(', ')} on TCP ${q.network.tcpPorts.join(', ')}.`);
    }
    if (s.kind === 'container') {
      // §6.3: every exposed port, including the ones an official template pre-exposes (22, 8888).
      const exposed = new Map<string, string>();
      for (const p of q.templatePorts) exposed.set(`${p.protocol} ${p.port}`, `${p.protocol} ${p.port}${p.label ? ` (${p.label}, from the template)` : ' (from the template)'}`);
      for (const p of s.ports ?? []) if (!exposed.has(`${p.protocol} ${p.containerPort}`)) exposed.set(`${p.protocol} ${p.containerPort}`, `${p.protocol} ${p.containerPort}`);
      if (exposed.size) detail.push(`Exposed container ports: ${[...exposed.values()].join(', ')}.`);
    }
    for (const w of priced.warnings) detail.push(w);
    if (!priced.budget.allowed || priced.budget.reason) detail.push(priced.budget.reason ?? '');
    const projected = (priced.maxUsd ?? 0) + priced.committedUsd;
    if (projected > 100) detail.push(`This may cost more than $100 (${usd(projected)} with what is already running).`);
    const recent = createTimes.filter((t) => nowMs() - t < CREATE_RATE.windowMs).length;
    if (recent >= CREATE_RATE.max) detail.push(`You started ${recent} resources in the last 10 minutes.`);
    detail.push('List price; your organization may pay less.');
    return {
      title: `Create ${s.kind === 'container' ? 'container' : 'sandbox'}`,
      message: `Create ${what} in ${where} · ${usd(rate)}/h list`,
      detail,
      confirmLabel: projected > 100 && rate !== null ? `Create (${usd(rate)}/h)` : 'Create',
    };
  }

  async function create(quoteId: string): Promise<ComputeResource> {
    purgeQuotes();
    const q = typeof quoteId === 'string' ? quotes.get(quoteId) : undefined;
    if (!q || q.expiresAt <= nowMs()) throw bad('This quote expired. Review the launch again.');
    quotes.delete(quoteId);
    await deps.keys.requireComputeKey();
    const s = q.spec;
    // Re-check what may have changed since the quote: stored secrets and the budget.
    await deps.secrets.assertNoSecrets((s.env ?? []).map((e) => ({ label: `Variable ${e.name}`, value: e.value })).concat(s.kind === 'container' ? [...(s.command ? [{ label: 'The command', value: s.command }] : []), ...(s.args ?? []).map((a, i) => ({ label: `Argument ${i + 1}`, value: a }))] : []));
    const priced = await guard.assessQuote(q.input);
    if (priced.refusal) throw refusalError(priced.refusal);

    const earlier = await checkEarlierAttempt(q);
    if (earlier.length) {
      await confirm(
        'Create another one?',
        `An earlier attempt (${earlier.join(', ')}) may still appear in your organization and bill.`,
        ['GMI did not confirm it, and GMI Desk has not found it yet. Create another one anyway?'],
        'Create another',
      );
    }
    const d = dialogFor(q, priced);
    await confirm(d.title, d.message, d.detail, d.confirmLabel);
    if (q.openCidrs.length) {
      await confirm(
        'Open to the internet?',
        q.openCidrs.includes('0.0.0.0/0') ? 'All Open: anyone on the internet can connect.' : `Anyone in ${q.openCidrs.join(', ')} can connect.`,
        [`Ports: TCP ${q.network?.tcpPorts.join(', ') ?? ''}.`, 'Use your own address (/32) unless you need more.'],
        'Open it',
      );
    }
    if (s.kind === 'sandbox' && s.egress.mode === 'allowlist') {
      const wide = s.egress.cidrs.map(checkCidr).filter((c) => c.open);
      const never = s.egress.hostnames.filter((h) => NEVER_DEFAULT_EGRESS.has(h));
      if (wide.length || never.length) {
        await confirm(
          'Allow this outbound traffic?',
          wide.some((c) => c.allOpen) ? 'The sandbox can send data anywhere on the internet (0.0.0.0/0).' : 'The sandbox can send data to these destinations.',
          [
            ...wide.map((c) => `Outbound to ${describeCidr(c)}.`),
            ...never.map((h) => `Outbound to ${h}: it accepts uploads, so code in the sandbox can send files there.`),
            'An allowlist limits where data can go, not what is sent.',
          ],
          'Allow',
        );
      }
    }
    if (s.kind === 'sandbox' && !s.secure) {
      await confirm('Previews without a token?', 'Anyone who learns a preview address can open it.', ['Secure previews need a token that GMI Desk adds for you.'], 'Turn off');
    }
    createTimes.push(nowMs());
    while (createTimes.length > 20) createTimes.shift();

    const rid = `cr_${randomUUID()}`;
    const name = remoteName(core.installId, s.displayName);
    const approved = s.lease.maxLifetimeMin;
    if (s.kind === 'container') {
      const p: PreparedContainer = { rid, name, displayName: s.displayName, spec: s, templateName: q.templateName, listUsdPerHour: priced.lines[0]?.usdPerHour ?? null, sshKeyIds: q.sshKeyIds, network: q.network, approvedMaxLifetimeMin: approved };
      const { record, reconciled } = await createContainer(createDeps, p, { installTag: tag, now: () => supervisor.clock.now() });
      if (reconciled) track(reconciled.then(() => changed()));
      changed();
      return toResource(registry.get(record.id) ?? record);
    }
    const p: PreparedSandbox = { rid, name, displayName: s.displayName, spec: s, templateName: q.templateName, listUsdPerHour: priced.lines[0]?.usdPerHour ?? null, approvedMaxLifetimeMin: approved, label };
    const { record, reconciled } = await createSandbox(lifecycleDeps, p, { now: () => supervisor.clock.now() });
    if (reconciled) track(reconciled.then(() => changed()));
    changed();
    return toResource(registry.get(record.id) ?? record);
  }

  // ── lifecycle ──

  const fresh = (id: string): ComputeResource => {
    const rec = registry.get(id);
    if (!rec) throw new GmiError('not_found', 'GMI Desk does not know this resource.');
    return toResource(rec);
  };

  async function deleteResource(id: string, opts: { releaseEip?: boolean; deleteFirewall?: boolean } = {}): Promise<ComputeResource> {
    const rec = mustManaged(id);
    mustRemote(rec);
    if (rec.kind === 'container' && (rec.phase === 'creating' || rec.rawState === 'terminating')) {
      throw new GmiError('conflict', 'GMI cannot delete a container while it is starting or stopping. Try again in a minute.');
    }
    const eip = rec.network?.eip;
    await confirm(
      `Delete ${rec.displayName}?`,
      `${rec.name} is deleted on GMI. This cannot be undone.`,
      [
        rec.kind === 'container' ? 'Files outside mounted storage are lost.' : 'Its files are lost (take a snapshot first to keep them).',
        eip?.managed ? (opts.releaseEip ? 'Its public IP is released too.' : `Its public IP is kept and keeps billing until you release it.`) : '',
      ],
      'Delete',
    );
    await performDelete(rec.id, { releaseEip: opts.releaseEip === true, deleteFirewall: opts.deleteFirewall === true });
    changed();
    return fresh(rec.id);
  }

  async function performDelete(id: string, opts: { releaseEip: boolean; deleteFirewall: boolean }): Promise<void> {
    await supervisor.withResourceLock(id, 'delete', async () => {
      const rec = mustManaged(id);
      if (rec.kind === 'container') {
        const { settled } = await teardownContainer(networkDeps(), rec, opts);
        track(settled.then(() => supervisor.pollNow()).then(() => changed()));
        await supervisor.observe(id, { phase: 'deleting', rawState: 'terminating', reason: null, remote: { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: null } }, 'action');
      } else {
        await deleteSandbox(lifecycleDeps, rec);
      }
    });
  }

  async function restart(id: string): Promise<ComputeResource> {
    const rec = mustManaged(id);
    if (rec.kind !== 'container') throw bad('Only containers can be restarted.');
    const remote = mustRemote(rec);
    if (rec.phase === 'creating' || rec.phase === 'deleting') throw new GmiError('conflict', 'Wait until it has started.');
    await supervisor.withResourceLock(id, 'restart', async () => {
      await deps.ce.restartContainer(remote);
      await supervisor.observe(id, { phase: 'busy', rawState: 'terminating', reason: 'Restarting…', remote: { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: null } }, 'action');
    });
    changed();
    return fresh(id);
  }

  async function pause(id: string): Promise<ComputeResource> {
    const rec = mustManaged(id);
    if (rec.kind !== 'sandbox') throw bad('Containers cannot be paused (GMI has no pause for them).');
    mustRemote(rec);
    if (rec.phase !== 'running') throw new GmiError('conflict', 'Only a running sandbox can be paused.');
    await supervisor.withResourceLock(id, 'pause', async () => pauseSandbox(lifecycleDeps, mustManaged(id)));
    changed();
    return fresh(id);
  }

  /** Lease end of a record (first running + max lifetime); null without a limit. */
  function leaseEnd(rec: ComputeRecord, maxMin = rec.lease?.maxLifetimeMin ?? null): number | null {
    if (maxMin === null || maxMin === undefined) return null;
    const start = rec.runningSince ? Date.parse(rec.runningSince) : nowMs();
    return start + maxMin * 60_000;
  }

  async function resume(id: string): Promise<ComputeResource> {
    const rec = mustManaged(id);
    if (rec.kind !== 'sandbox') throw bad('Only sandboxes can be resumed.');
    mustRemote(rec);
    if (rec.phase !== 'paused') throw new GmiError('conflict', 'Only a paused sandbox can be resumed.');
    const end = leaseEnd(rec);
    const remainingSec = end === null ? 3600 : Math.round((end - nowMs()) / 1000);
    if (end !== null && remainingSec < 60) throw bad('Its lease has ended. Extend the lease first.');
    const timeoutSec = Math.max(60, Math.min(LEASE_LIMITS.sandboxTimeoutMaxSec, remainingSec));
    const priced = await guard.assessQuote({ action: 'resume', kind: 'sandbox', lines: [{ sku: rec.sku ?? '', label: rec.displayName, idc: rec.idc }], hours: timeoutSec / 3600, gpu: false, resourceId: rec.id });
    if (priced.refusal) throw refusalError(priced.refusal);
    const until = new Date(nowMs() + timeoutSec * 1000);
    await confirm(
      `Resume ${rec.displayName}?`,
      `${usd(priced.usdPerHour)}/h list until ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${priced.maxUsd !== null ? ` (≤ ${usd(priced.maxUsd)})` : ''}.`,
      ['Processes and /tmp may be gone after a pause (cold resume).', ...priced.warnings, 'List price; your organization may pay less.'],
      'Resume',
    );
    await supervisor.withResourceLock(id, 'resume', async () => resumeSandbox(lifecycleDeps, mustManaged(id), timeoutSec));
    changed();
    return fresh(id);
  }

  async function extend(id: string, minutes: number): Promise<ComputeResource> {
    const rec = mustManaged(id);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > LEASE_LIMITS.maxLifetimeMin) throw bad('Extend by 1 minute to 7 days.');
    if (rec.kind === 'sandbox') {
      mustRemote(rec);
      // A paused sandbox whose lease ended is extended (lease only) so it can be resumed; resume sets GMI's timeout.
      if (rec.phase !== 'running' && rec.phase !== 'paused') throw new GmiError('conflict', 'Only a running or paused sandbox can be extended.');
    }
    const lease = rec.lease ?? defaultLease(rec.kind, rec.purpose);
    const unlimited = lease.maxLifetimeMin === null;
    const runningSince = rec.runningSince ? Date.parse(rec.runningSince) : nowMs();
    const currentEnd = leaseEnd(rec, lease.maxLifetimeMin);
    const newEnd = unlimited ? null : Math.max(currentEnd ?? nowMs(), nowMs()) + minutes * 60_000;
    const newMax = newEnd === null ? null : Math.ceil((newEnd - runningSince) / 60_000);
    if (newMax !== null && newMax > LEASE_LIMITS.maxLifetimeMin) throw bad('A lease cannot be longer than 7 days.');
    const beyond = newMax !== null && (rec.approvedMaxLifetimeMin === null || newMax > rec.approvedMaxLifetimeMin);
    const priced = await guard.assessQuote({ action: 'extend', kind: rec.kind, lines: [{ sku: rec.sku ?? '', label: rec.displayName, idc: rec.idc }], hours: minutes / 60, gpu: false, resourceId: rec.id });
    if (priced.refusal) throw refusalError(priced.refusal);
    if (beyond) {
      await confirm(
        `Extend ${rec.displayName}?`,
        `${minutes} more minutes at ${usd(priced.usdPerHour)}/h list${priced.maxUsd !== null ? ` (≤ ${usd(priced.maxUsd)})` : ''}.`,
        [`This is longer than the ${rec.approvedMaxLifetimeMin === null ? '' : hoursText(rec.approvedMaxLifetimeMin) + ' '}you approved.`, ...priced.warnings, 'List price; your organization may pay less.'],
        'Extend',
      );
    }
    await supervisor.withResourceLock(id, 'extend', async () => {
      const cur = mustManaged(id);
      if (cur.kind === 'sandbox' && cur.phase === 'running') {
        const serverBase = cur.serverEndsAt ? Math.max(Date.parse(cur.serverEndsAt), nowMs()) : nowMs();
        const target = newEnd ?? serverBase + minutes * 60_000;
        await setSandboxTimeout(lifecycleDeps, cur, (target - nowMs()) / 1000);
      }
      await registry.update(id, (r) => ({
        ...r,
        lease: { ...(r.lease ?? lease), maxLifetimeMin: newMax ?? (r.lease?.maxLifetimeMin ?? null) },
        approvedMaxLifetimeMin: beyond ? newMax : r.approvedMaxLifetimeMin,
        history: [{ at: nowIso(), phase: r.phase, note: `Extended by ${minutes} min.` }, ...r.history],
      }));
    });
    changed();
    return fresh(id);
  }

  async function setLease(id: string, patch: Partial<LeasePolicy>): Promise<ComputeResource> {
    const rec = mustManaged(id);
    if (!patch || typeof patch !== 'object') throw bad('Nothing to change.');
    const current = rec.lease ?? defaultLease(rec.kind, rec.purpose);
    const allowed: Array<keyof LeasePolicy> = ['maxLifetimeMin', 'onExpiry', 'idlePauseMin', 'extendOnActivity', 'onBudget'];
    const clean: Partial<LeasePolicy> = {};
    for (const k of allowed) if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];
    const next = validateLease(rec.kind, { ...current, ...clean });
    const verdict = guard.assessLeaseChange(rec, clean);
    if (verdict.loosens || verdict.deletesSooner) {
      await confirm(
        `Change the lease of ${rec.displayName}?`,
        verdict.deletesSooner ? 'GMI Desk may delete it sooner than before.' : 'This loosens a cost limit.',
        [...verdict.reasons, rec.listUsdPerHour !== null ? `It bills ${usd(rec.listUsdPerHour)}/h list.` : ''],
        'Change lease',
      );
    }
    await supervisor.withResourceLock(id, 'extend', async () => {
      await registry.update(id, (r) => ({
        ...r,
        lease: next,
        leaseChangedAt: nowIso(),
        approvedMaxLifetimeMin: verdict.loosens && (next.maxLifetimeMin === null || (r.approvedMaxLifetimeMin ?? 0) < next.maxLifetimeMin) ? next.maxLifetimeMin : r.approvedMaxLifetimeMin,
        history: [{ at: nowIso(), phase: r.phase, note: 'Lease changed.' }, ...r.history],
      }));
    });
    changed();
    return fresh(id);
  }

  // ── logs ──

  async function getLogs(id: string, opts: { tailBytes?: number } = {}) {
    const rec = mustManaged(id);
    if (rec.kind !== 'container') throw bad('Logs are available for containers.');
    const remote = mustRemote(rec);
    const res = await deps.ce.getLogs(remote, { ...(typeof opts.tailBytes === 'number' ? { tailBytes: opts.tailBytes } : {}), rangeSupported: rec.logsRangeSupported });
    if (res.rangeSupported !== rec.logsRangeSupported && (rec.logsRangeSupported === null || rec.logsRangeSupported === true)) {
      await registry.update(id, (r) => ({ ...r, logsRangeSupported: res.rangeSupported })).catch(() => undefined);
    }
    return { text: res.text, truncated: res.truncated, fetchedAt: res.fetchedAt };
  }

  async function saveLogs(id: string): Promise<string | null> {
    const rec = mustManaged(id);
    if (rec.kind !== 'container') throw bad('Logs are available for containers.');
    const remote = mustRemote(rec);
    const path = await core.platform.pickSavePath({ title: 'Save container log', defaultName: `${slug(rec.displayName, 40)}.log` });
    if (!path) return null;
    await deps.ce.saveLogs(remote, path);
    return path;
  }

  // ── snapshots ──

  const SNAP_STATES: ReadonlySet<string> = new Set<SnapshotState>(['creating', 'ready', 'error', 'deleting', 'delete_failed']);

  function toSnapshot(s: V2Snapshot): ComputeSnapshot {
    const managed = sandboxOwnership(s.metadata, label) === 'this_install';
    const byRid = managed && s.metadata?.rid ? registry.get(s.metadata.rid) : null;
    const bySource = s.source_sandbox_id ? registry.findByRemote('sandbox_v2', s.source_sandbox_id) : null;
    return {
      id: s.snapshot_id,
      name: s.name ?? s.snapshot_id,
      sourceResourceId: (byRid ?? bySource)?.id ?? null,
      sourceRemoteId: s.source_sandbox_id ?? null,
      idc: s.idc_name ?? null,
      state: SNAP_STATES.has(String(s.status)) ? (s.status as SnapshotState) : 'unknown',
      createdAt: s.created_at ?? null,
      sizeBytes: null,
      managed,
    };
  }

  async function listSnapshots(): Promise<ComputeSnapshot[]> {
    await deps.keys.requireComputeKey();
    return (await deps.sandbox.listSnapshots()).map(toSnapshot);
  }

  async function createSnapshot(id: string, opts: { name?: string; scrub?: boolean } = {}): Promise<ComputeSnapshot> {
    const rec = mustManaged(id);
    if (rec.kind !== 'sandbox') throw bad('Snapshots are available for sandboxes.');
    mustRemote(rec);
    let name = typeof opts.name === 'string' ? opts.name.trim() : '';
    if (name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) throw bad('Snapshot names use letters, digits, ".", "-" and "_" (at most 63).');
    if (!name) name = `${slug(rec.displayName, 32)}-${nowIso().slice(0, 16).replace(/[-:T]/g, '')}`;
    const snap = await supervisor.withResourceLock(id, 'snapshot', async () => snapshotSandbox(lifecycleDeps, mustManaged(id), { name, scrub: opts.scrub !== false, label }));
    changed();
    return toSnapshot(snap);
  }

  async function deleteSnapshot(snapshotId: string): Promise<void> {
    if (typeof snapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshotId)) throw bad('Unknown snapshot.');
    const snap = await deps.sandbox.getSnapshot(snapshotId);
    if (sandboxOwnership(snap.metadata, label) !== 'this_install') throw bad('This snapshot was not made by this GMI Desk. Delete it in the GMI console.');
    try {
      await deps.sandbox.deleteSnapshot(snapshotId);
    } catch (error) {
      if (error instanceof GmiError && error.code === 'conflict') throw new GmiError('conflict', 'Sandboxes started from this snapshot still exist. Delete them first.');
      throw error;
    }
  }

  // ── network ──

  function managedEipIds(): Set<string> {
    const ids = new Set<string>();
    for (const r of registry.list({ includeTombstones: true })) if (r.network?.eip?.managed) ids.add(r.network.eip.id);
    return ids;
  }

  async function getNetwork(): Promise<ComputeNetworkInventory> {
    await deps.keys.requireComputeKey();
    const [eips, firewalls] = await Promise.all([deps.ce.listEips(), deps.ce.listFirewalls()]);
    const managedEips = managedEipIds();
    const managedFw = new Set<string>();
    for (const r of registry.list({ includeTombstones: true })) for (const f of r.network?.firewalls ?? []) if (f.managed) managedFw.add(f.id);
    return {
      eips: eips.map((e) => {
        const attached = e.instanceID ? registry.findByRemote('ce', e.instanceID) : null;
        return {
          id: e.id,
          name: e.name,
          idc: e.idc,
          address: e.ipAddress || null,
          status: (['associated', 'disassociated', 'released'].includes(e.status) ? e.status : 'unknown') as 'associated',
          attachedTo: attached?.id ?? null,
          managed: managedEips.has(e.id) || containerOwnership(e.name ?? '', tag) === 'this_install',
          listUsdPerHour: deps.catalog.price(e.product, e.idc).usdPerHour,
        };
      }),
      firewalls: firewalls.map((f) => ({
        id: f.id,
        name: f.name,
        idc: f.idc,
        preset: f.isPreset === true,
        managed: managedFw.has(f.id) || containerOwnership(f.name ?? '', tag) === 'this_install',
        attachedCount: (f.assoContainers?.length ?? 0) + (f.assoInstances?.length ?? 0),
        status: (['active', 'building', 'error'].includes(String(f.status)) ? f.status : 'unknown') as 'active',
      })),
      fetchedAt: nowIso(),
    };
  }

  async function releaseEip(idIn: string): Promise<void> {
    // An EIP id, or a managed container's id (its own managed EIP; older alarms were keyed by the container).
    const owner = typeof idIn === 'string' && idIn.startsWith('cr_') ? registry.get(idIn) : null;
    const eipId = owner?.network?.eip?.managed ? owner.network.eip.id : idIn;
    if (typeof eipId !== 'string' || !UUID_PATTERN.test(eipId)) throw bad('Unknown public IP.');
    await deps.keys.requireComputeKey();
    const eip = (await deps.ce.listEips()).find((e) => e.id === eipId);
    if (!eip) throw new GmiError('not_found', 'GMI does not list this public IP any more.');
    const managed = managedEipIds().has(eipId) || containerOwnership(eip.name ?? '', tag) === 'this_install';
    if (!managed) throw bad('GMI Desk did not allocate this public IP. Release it in the GMI console.');
    const price = deps.catalog.price(eip.product, eip.idc).usdPerHour;
    await confirm(
      `Release ${eip.ipAddress || eip.name}?`,
      `The address is returned to GMI and stops billing (${usd(price)}/h list). This cannot be undone.`,
      [eip.status === 'associated' ? 'It is attached to a container now: that container loses its public address.' : ''],
      'Release',
    );
    if (eip.status === 'associated' && eip.instanceID) {
      await deps.ce.disassociateEip(eip.id, { instanceID: eip.instanceID, instanceType: eip.instanceType ?? 'container' });
    }
    await deps.ce.releaseEip(eip.id);
    for (const r of registry.list({ includeTombstones: true })) {
      if (r.network?.eip?.id === eipId) {
        await registry.update(r.id, (cur) =>
          closeEipInterval({ ...cur, network: cur.network ? { ...cur.network, publicIp: cur.network.eip?.id === eipId ? null : cur.network.publicIp, eip: cur.network.eip ? { ...cur.network.eip, status: 'released' } : null } : null }, nowIso()),
        );
        guard.alarms.resolve('eip_unattached', r.id);
      }
    }
    guard.alarms.resolve('eip_unattached', eipId);
    changed();
  }

  async function updateFirewallCidr(id: string, cidr: string): Promise<ComputeResource> {
    const rec = mustManaged(id);
    if (rec.kind !== 'container') throw bad('Firewalls apply to containers.');
    mustRemote(rec);
    const c = checkCidr(cidr);
    if (c.open) {
      const ports = (rec.network?.firewalls ?? []).flatMap((f) => f.rules.map((r) => (r.fromPort === r.toPort ? `${r.protocol.toUpperCase()} ${r.fromPort ?? ''}` : `${r.protocol.toUpperCase()} ${r.fromPort}-${r.toPort}`)));
      await confirm('Open to the internet?', `${describeCidr(c)} will be able to connect to ${rec.displayName}.`, [`Ports: ${[...new Set(ports)].join(', ') || 'as configured'}.`, 'Use your own address (/32) unless you need more.'], 'Open it');
    }
    await supervisor.withResourceLock(id, 'network', async () => {
      await replaceFirewallCidr({ ce: deps.ce, registry }, mustManaged(id), c.cidr);
    });
    changed();
    return fresh(id);
  }

  // ── adopt ──

  async function adopt(id: string): Promise<ComputeResource> {
    const parsed = typeof id === 'string' ? parseUnmanagedId(id) : null;
    if (!parsed) throw bad('Only resources of another GMI Desk can be adopted.');
    await deps.keys.requireComputeKey();
    if (registry.findByRemote(parsed.backend, parsed.remoteId)) throw bad('This resource is already managed here.');
    const at = nowIso();
    if (parsed.backend === 'ce') {
      const c = (await deps.ce.listContainers()).find((x) => x.id === parsed.remoteId);
      if (!c) throw new GmiError('not_found', 'GMI does not list this container any more.');
      if (containerOwnership(c.name, tag) !== 'other_install') throw bad('Only containers made by another GMI Desk can be adopted.');
      const price = deps.catalog.price(c.product, c.idc).usdPerHour;
      await confirm(
        `Adopt ${c.name}?`,
        "This may belong to a colleague's GMI Desk.",
        [`It bills ${usd(price)}/h list. Once adopted, GMI Desk manages it from this computer: a 4-hour lease starts now, and you are notified when it ends (nothing is deleted automatically).`],
        'Adopt',
      );
      const rec = await registry.add(
        blankRecord(
          {
            id: `cr_${c.id}`,
            kind: 'container',
            backend: 'ce',
            name: c.name,
            displayName: displayNameFromRemote(c.name),
            managed: true,
            remoteId: c.id,
            installTag: tag,
            purpose: 'computer',
            idc: c.idc,
            sku: c.product,
            templateId: c.templateId ?? null,
            listUsdPerHour: price,
            runningSince: c.status === 'running' ? at : null,
            lease: { ...defaultLease('container'), onExpiry: 'notify' },
            approvedMaxLifetimeMin: 240,
            leaseChangedAt: at,
            envNames: c.envNames ?? [],
            history: [{ at, phase: 'unknown', note: 'Adopted from another GMI Desk.' }],
          },
          at,
        ),
      );
      await supervisor.observe(rec.id, observeContainer(c, null), 'sweep');
      guard.alarms.resolve('orphan', id);
      changed();
      return fresh(rec.id);
    }
    const s = (await deps.sandbox.listAll({ metadata: { app: 'gmi-desk' } })).find((x) => x.id === parsed.remoteId);
    if (!s) throw new GmiError('not_found', 'GMI does not list this sandbox any more.');
    if (sandboxOwnership(s.metadata, label) !== 'other_install') throw bad('Only sandboxes made by another GMI Desk can be adopted.');
    const detail = await deps.sandbox.get(s.id).catch(() => null);
    const sku = detail?.product ?? null;
    const price = sku ? deps.catalog.price(sku, s.idc_name ?? null).usdPerHour : null;
    await confirm(`Adopt this sandbox?`, "This may belong to a colleague's GMI Desk.", [`It bills ${usd(price)}/h list while running. Once adopted, GMI Desk manages it from this computer (idle pause and an 8-hour lease, then it is paused).`], 'Adopt');
    const purpose = s.metadata?.purpose === 'agent' ? 'agent' : 'computer';
    const rec = await registry.add(
      blankRecord(
        {
          id: `cr_${randomUUID()}`,
          kind: 'sandbox',
          backend: 'sandbox_v2',
          name: `sandbox-${s.sandbox_key ?? s.id}`,
          displayName: `Sandbox ${s.sandbox_key ?? s.id.slice(0, 8)}`,
          managed: true,
          remoteId: s.id,
          purpose,
          idc: s.idc_name ?? null,
          sku,
          listUsdPerHour: price,
          runningSince: s.state === 'running' ? at : null,
          lease: defaultLease('sandbox', purpose),
          approvedMaxLifetimeMin: 480,
          leaseChangedAt: at,
          history: [{ at, phase: 'unknown', note: 'Adopted from another GMI Desk.' }],
        },
        at,
      ),
    );
    await supervisor.observe(rec.id, observeSandbox(detail ?? s), 'sweep');
    guard.alarms.resolve('orphan', id);
    changed();
    return fresh(rec.id);
  }

  // ── alarms, console ──

  async function dismissAlarm(alarmId: string): Promise<ComputeState> {
    const alarm = guard.alarms.list().find((a) => a.id === alarmId);
    if (alarm?.kind === 'create_unknown' && alarm.resourceId) {
      const entry = journal.get(alarm.resourceId);
      if (entry && UNRESOLVED_STATES.has(entry.state)) {
        await confirm(
          'Stop checking for this create?',
          `If GMI did create ${entry.name}, it keeps billing and GMI Desk will not watch it.`,
          ['Check the GMI console before you dismiss this.'],
          'Stop checking',
        );
        await journal.update(entry.rid, { state: 'dismissed' });
      }
    }
    if (alarm) guard.alarms.dismiss(alarmId);
    changed();
    return getState();
  }

  async function openInConsole(id: string, view: 'detail' | 'logs' | 'monitor' | 'reconfigure' | 'renew'): Promise<void> {
    const rec = typeof id === 'string' ? registry.get(id) : null;
    const unmanaged = typeof id === 'string' ? parseUnmanagedId(id) : null;
    let url: string;
    if (rec?.kind === 'container' && rec.remoteId && UUID_PATTERN.test(rec.remoteId)) url = consoleDeepLink('container', rec.remoteId, view);
    else if (unmanaged?.backend === 'ce' && UUID_PATTERN.test(unmanaged.remoteId)) url = consoleDeepLink('container', unmanaged.remoteId, view);
    else if (rec || unmanaged) url = consoleUrl(rec?.kind === 'container' ? 'containers' : 'computeHome');
    else if (typeof id === 'string' && journal.get(id)) url = consoleUrl(journal.get(id)?.kind === 'container' ? 'containers' : 'computeHome');
    else if (typeof id === 'string' && UUID_PATTERN.test(id)) url = consoleUrl('elasticIps');
    else throw new GmiError('not_found', 'GMI Desk does not know this resource.');
    await core.platform.openExternal(url);
  }

  // ── resource actions for the guard (approved already; no dialogs) ──

  const actions: ResourceActions = {
    async pause(resourceId, cause: GuardCause) {
      const rec = mustManaged(resourceId);
      if (rec.kind !== 'sandbox') throw bad('Containers cannot be paused.');
      log.info('guard.action', { rid: resourceId, action: 'pause', reason: cause, usdPerHour: rec.listUsdPerHour });
      await supervisor.withResourceLock(resourceId, 'pause', async () => pauseSandbox(lifecycleDeps, mustManaged(resourceId)));
      changed();
    },
    async delete(resourceId, cause: GuardCause) {
      const rec = mustManaged(resourceId);
      log.info('guard.action', { rid: resourceId, action: 'delete', reason: cause, usdPerHour: rec.listUsdPerHour });
      // The approved bundle included the public IP: a guard delete releases what this app allocated.
      await performDelete(resourceId, { releaseEip: true, deleteFirewall: true });
      changed();
    },
    async extendServerTimeout(resourceId, seconds) {
      const rec = mustManaged(resourceId);
      if (rec.kind !== 'sandbox') throw bad('Only sandboxes have a server timeout.');
      const end = leaseEnd(rec);
      const cap = end === null ? LEASE_LIMITS.sandboxTimeoutMaxSec : Math.floor((end - nowMs()) / 1000);
      const s = Math.min(seconds, cap, LEASE_LIMITS.sandboxTimeoutMaxSec);
      if (s < 60) throw bad('The approved lease has ended.');
      return supervisor.withResourceLock(resourceId, 'extend', async () => setSandboxTimeout(lifecycleDeps, mustManaged(resourceId), s));
    },
  };

  // ── API ──

  const api: ComputeApi = {
    getState,
    async getCatalog(opts) {
      return deps.catalog.getCatalog(opts ?? {});
    },
    async listResources(opts) {
      if (!opts?.includeUnmanaged) return listManaged();
      try {
        if (await deps.keys.getComputeKey()) orgSandboxes = await deps.sandbox.listAll({});
        else orgSandboxes = null;
      } catch (error) {
        log.warn('org sandbox listing failed', { code: error instanceof GmiError ? error.code : 'internal' });
      }
      return listVisible();
    },
    async getResource(id) {
      const rec = typeof id === 'string' ? registry.get(id) : null;
      if (rec) return toDetail(rec);
      const parsed = typeof id === 'string' ? parseUnmanagedId(id) : null;
      if (parsed) {
        const snap = supervisor.remote();
        if (parsed.backend === 'ce') {
          const c = snap.containers?.find((x) => x.id === parsed.remoteId);
          if (c) return toDetail(unmanagedContainer(c));
        } else {
          const s = snap.sandboxes?.find((x) => x.id === parsed.remoteId);
          if (s) return toDetail(unmanagedSandbox(s));
        }
      }
      throw new GmiError('not_found', 'GMI Desk does not know this resource.');
    },
    async refresh() {
      await supervisor.pollNow();
      changed();
    },
    quoteCreate,
    create,
    delete: deleteResource,
    restart,
    pause,
    resume,
    extend,
    setLease,
    getLogs,
    saveLogs,
    listSnapshots,
    createSnapshot,
    deleteSnapshot,
    getNetwork,
    releaseEip,
    updateFirewallCidr,
    adopt,
    detectPublicIp: () => deps.detectIp(),
    async sweep() {
      await deps.sweeper.run();
      changed();
      return getState();
    },
    dismissAlarm,
    openInConsole,
  };

  // ── startup helpers ──

  async function reconcileJournal(): Promise<void> {
    for (const entry of journal.unresolved()) {
      try {
        if (entry.backend === 'ce') await reconcileContainer(createDeps, entry.rid);
        else await reconcileSandbox(lifecycleDeps, entry.rid);
      } catch (error) {
        log.warn('startup reconcile failed', { rid: entry.rid, code: error instanceof GmiError ? error.code : 'internal' });
      }
    }
  }

  function startSaga(rid: string) {
    if (sagaRunning.has(rid)) return;
    const entry = journal.get(rid);
    if (!entry?.network || entry.network.state !== 'pending') return;
    sagaRunning.add(rid);
    track(
      runNetworkSaga(networkDeps(), rid).finally(() => {
        sagaRunning.delete(rid);
        changed();
      }),
    );
  }

  const sagaStuckAlarmed = new Set<string>();
  /** Starts sagas whose container runs; raises an alarm once for one still not running after 20 min (§6.3 step 1). */
  function resumeSagas() {
    for (const e of journal.list()) {
      if (e.network?.state !== 'pending' || !e.remoteId) continue;
      const rec = registry.get(e.rid);
      if (!rec || rec.tombstone) continue;
      if (rec.phase === 'running') startSaga(e.rid);
      else if (!sagaStuckAlarmed.has(e.rid) && nowMs() - Date.parse(rec.requestedAt ?? e.at) > SAGA_RUNNING_CAP_MS) {
        sagaStuckAlarmed.add(e.rid);
        guard.alarms.raise({
          kind: 'api_unavailable',
          severity: 'warning',
          resourceId: e.rid,
          title: `${rec.displayName} has not started after 20 minutes`,
          body: 'Public access is set up once it runs. It bills while GMI starts it; delete it if it stays stuck.',
          usdPerHour: rec.listUsdPerHour,
          actions: ['open', 'delete', 'dismiss'],
        });
      }
    }
  }

  // Public access starts once the container runs (§6.3 step 1); 20 min without `running` raises an alarm.
  supervisor.onTransition((t) => {
    if (t.kind !== 'container') return;
    if (t.to === 'running') startSaga(t.resourceId);
  });

  return {
    api,
    actions,
    toResource,
    listManaged,
    listVisible,
    getState,
    checkAccess: checkAccessNow,
    reconcileJournal,
    resumeSagas,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async idle() {
      while (background.size) await Promise.all([...background]);
    },
  };
}

