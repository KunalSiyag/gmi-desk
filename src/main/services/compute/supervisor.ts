// Adaptive polling, state mapping, reconcile and the per-resource mutex (compute.md §6.5, §6.6, §7.4, §9.2, §14
// `supervisor.ts`; the `Supervisor` interface of types.ts). C1-C.
//
// - One list call per backend: GET /api/v1/containers (no paging) and GET /api/v2/sandboxes?metadata[app]=gmi-desk
//   (paged). A detail GET only for a sandbox whose state changed (for paused_at / end_at / deletion) or that is
//   missing from the list (404 → deleted).
// - Cadence: 5 s while a managed resource is transitional or watched; 120 s while the window is hidden; 30 s while a
//   computer is open; 60 s otherwise; none while suspended, then a poll at once on resume.
// - Errors: jittered exponential back-off on 429/5xx/network (2 s → 5 min, Retry-After honoured); 5 failures in a row →
//   `degraded`; 30 minutes of failures → `down`. `not_entitled` and a refused key park that backend until the key changes.
// - Billing intervals (§9.2) are opened and closed here, atomically with the phase they follow: CE backdated to the
//   create request, sandboxes to running_at / created_at, closed at GMI's paused_at / deletion.requested_at when known.
// - GMI's clock: the `Date` header of every answer (fed by the clients' `onServerDate`); beyond 2 min of skew, leases
//   and observations use server time.
import type { ComputeAction, ComputeApiHealth, ComputeBackend, ComputeKind, ComputeNetwork, ComputePhase } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import { redact, type Logger } from '../../core/logger';
import type { ComputeKeyProvider } from '../../core/services';
import type { CeApi } from './ce/client';
import { isBillingInitiated, sandboxReasonText } from './errors';
import { closeIntervals } from './registry';
import type { SandboxApi } from './sandbox/client';
import type { V2SandboxDetail, V2SandboxSummary } from './sandbox/dto';
import type { SafeCeContainer } from './sanitize';
import { backfillPrice } from './accrual';
import { COMPUTE_TIMING, type ComputeRecord, type PhaseTransition, type PriceBook, type Registry, type ServerClock, type Supervisor } from './types';

// ─── State mapping (pure) ──────────────────────────────────────────────────────────────────────────────────────────

export const TRANSITIONAL_PHASES: ReadonlySet<ComputePhase> = new Set(['creating', 'busy', 'pausing', 'resuming', 'deleting']);

/** §6.5. `pending` is the action this app is running on the resource (restart vs delete while `terminating`). */
export function cePhase(status: string | null | undefined, pending: ComputeAction | null, current?: ComputePhase | null): ComputePhase {
  switch (status) {
    case 'creating':
      return 'creating';
    case 'running':
      return 'running';
    case 'terminating':
      return pending === 'delete' || current === 'deleting' ? 'deleting' : 'busy';
    case 'error':
    case 'zombie':
      return 'failed';
    default:
      // 'stopped', 'unknown' and anything new: accepted, shown as unknown (still billed, conservative).
      return 'unknown';
  }
}

export function ceReason(c: Pick<SafeCeContainer, 'status' | 'reason'>): string | null {
  if (c.status === 'stopped') return 'Stopped by GMI.';
  if (c.status === 'zombie') return 'GMI reports this container as orphaned.';
  if (c.status === 'error') {
    const text = typeof c.reason === 'string' ? redact(c.reason).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    return text ? `GMI reports an error: ${text}` : 'GMI reports an error.';
  }
  if (c.status === 'terminating') return null;
  return null;
}

/** §7.4, including the SDK extras. */
export function v2Phase(state: string | null | undefined): ComputePhase {
  switch (state) {
    case 'provisioning':
      return 'creating';
    case 'running':
    case 'ready':
    case 'active':
      return 'running';
    case 'updating':
    case 'checkpointing':
      return 'busy';
    case 'pausing':
      return 'pausing';
    case 'paused':
      return 'paused';
    case 'resuming':
      return 'resuming';
    case 'failed':
    case 'error':
      return 'failed';
    case 'deleting':
      return 'deleting';
    case 'deleted':
    case 'cancelled':
      return 'deleted';
    default:
      return 'unknown';
  }
}

/** Whether a phase bills (the guard's accrual follows it): §6.5 for CE, §7.4 for sandboxes. */
export function isBilled(kind: ComputeKind, phase: ComputePhase): boolean {
  if (phase === 'deleted') return false;
  if (kind === 'container') return true;
  return phase !== 'paused' && phase !== 'failed';
}

/** What one remote observation says about a resource. */
export interface Observation {
  phase: ComputePhase;
  rawState: string | null;
  reason: string | null;
  remote: PhaseTransition['remote'];
  serverEndsAt?: string | null;
  pausedExpiresAt?: string | null;
  /** CE only: what the list says about addresses and ports (merged with the managed ids the record holds). */
  network?: Partial<ComputeNetwork> | null;
  /** GMI paused or deleted it for billing reasons (§7.4). */
  billingInitiated?: boolean;
}

const ts = (v: unknown): string | null => (typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

export function observeContainer(c: SafeCeContainer, pending: ComputeAction | null, current?: ComputePhase | null): Observation {
  const address = c.publicIP?.ipAddress || c.eipAddress || null;
  return {
    phase: cePhase(c.status, pending, current),
    rawState: typeof c.status === 'string' ? c.status : null,
    reason: ceReason(c),
    remote: { createdAt: ts(c.createdAt), runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: null },
    network: {
      publicIp: address,
      ports: (c.ports ?? []).map((p) => ({ containerPort: p.containerPort, nodePort: typeof p.port === 'number' ? p.port : null, protocol: p.protocol === 'UDP' ? 'UDP' : 'TCP' })),
      eip: c.eipId ? { id: c.eipId, address: c.eipAddress ?? null, managed: false, status: 'associated' } : null,
    },
  };
}

export function observeSandbox(s: V2SandboxSummary | V2SandboxDetail): Observation {
  const d = s as V2SandboxDetail;
  const phase = v2Phase(s.state);
  let reason: string | null = null;
  if (phase === 'failed') reason = sandboxReasonText(d.failure?.code ?? 'Sandbox.Unknown');
  else if (phase === 'paused' || phase === 'pausing') reason = d.pause?.code && d.pause.code !== 'Sandbox.UserPaused' ? sandboxReasonText(d.pause.code) : null;
  else if (phase === 'deleted' || phase === 'deleting') reason = d.deletion?.code && d.deletion.code !== 'Sandbox.UserDeleted' ? sandboxReasonText(d.deletion.code) : null;
  return {
    phase,
    rawState: typeof s.state === 'string' ? s.state : null,
    reason,
    remote: {
      createdAt: ts(s.created_at),
      runningAt: ts(s.running_at) ?? ts(d.started_at),
      pausedAt: ts(d.paused_at) ?? ts(d.pause?.requested_at),
      endAt: ts(d.end_at),
      deletionRequestedAt: ts(d.deletion?.requested_at),
    },
    serverEndsAt: ts(d.end_at),
    pausedExpiresAt: ts(d.paused_expire_at),
    billingInitiated: isBillingInitiated(d.pause?.initiator ?? d.deletion?.initiator, d.pause?.code ?? d.deletion?.code),
  };
}

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);

/**
 * Applies one observation to a record (pure): phase, reason, timestamps, billing intervals, history and the tombstone
 * of a deletion. `at` is the server-corrected observation time.
 */
export function applyObservation(rec: ComputeRecord, obs: Observation, at: string): ComputeRecord {
  const next: ComputeRecord = { ...rec, intervals: [...rec.intervals], history: [...rec.history] };
  next.phase = obs.phase;
  next.rawState = obs.rawState;
  next.reason = obs.reason;
  next.lastSeenAt = at;
  if (obs.remote.createdAt && !next.createdAt) next.createdAt = obs.remote.createdAt;
  if (obs.serverEndsAt !== undefined) next.serverEndsAt = obs.serverEndsAt;
  if (obs.pausedExpiresAt !== undefined) next.pausedExpiresAt = obs.pausedExpiresAt;
  next.pausedAt = obs.phase === 'paused' ? (obs.remote.pausedAt ?? next.pausedAt ?? at) : obs.phase === 'pausing' ? next.pausedAt : null;
  if (obs.phase === 'running' && !next.runningSince) {
    next.runningSince = rec.kind === 'sandbox' && obs.remote.runningAt ? earlier(obs.remote.runningAt, at) : at;
  }
  if (obs.network && rec.kind === 'container') {
    const base: ComputeNetwork = next.network ?? { publicIp: null, eip: null, firewalls: [], ports: [], degraded: false };
    const eip = base.eip
      ? { ...base.eip, address: obs.network.eip?.address ?? base.eip.address, status: obs.network.eip && obs.network.eip.id === base.eip.id ? ('associated' as const) : base.eip.status }
      : (obs.network.eip ?? null);
    next.network = { ...base, publicIp: obs.network.publicIp ?? null, ports: obs.network.ports ?? base.ports, eip };
  }

  // Billing intervals (§9.2).
  const billed = isBilled(rec.kind, obs.phase) && !(rec.kind === 'sandbox' && obs.phase === 'deleting' && obs.remote.deletionRequestedAt);
  const open = next.intervals.find((i) => i.to === null);
  if (billed && !open) {
    let from = at;
    if (next.intervals.length === 0) {
      from = rec.kind === 'container'
        ? (rec.requestedAt ?? obs.remote.createdAt ?? at)
        : (obs.remote.runningAt ?? obs.remote.createdAt ?? rec.requestedAt ?? at);
      from = earlier(from, at);
    }
    next.intervals.push({ from, to: null, usdPerHour: rec.listUsdPerHour });
  } else if (!billed && !open && next.intervals.length === 0 && rec.kind === 'sandbox') {
    // First seen already paused / deleted (created, then expired while unobserved): it billed from running_at until
    // GMI's paused_at / deletion.requested_at (§7.1).
    const from = obs.remote.runningAt ?? obs.remote.createdAt;
    const to = obs.phase === 'paused' ? obs.remote.pausedAt : obs.remote.deletionRequestedAt;
    if (from && to && Date.parse(to) > Date.parse(from)) next.intervals.push({ from, to: earlier(to, at), usdPerHour: rec.listUsdPerHour });
  } else if (!billed && open) {
    let end = at;
    if (obs.phase === 'paused' && obs.remote.pausedAt) end = obs.remote.pausedAt;
    if ((obs.phase === 'deleting' || obs.phase === 'deleted') && obs.remote.deletionRequestedAt) end = obs.remote.deletionRequestedAt;
    end = later(earlier(end, at), open.from);
    next.intervals = closeIntervals(next.intervals, end);
  }

  if (rec.phase !== obs.phase) next.history.unshift({ at, phase: obs.phase, note: obs.reason });
  if (obs.phase === 'deleted' && !next.tombstone) {
    const end = obs.remote.deletionRequestedAt ?? at;
    next.intervals = closeIntervals(next.intervals, earlier(end, at));
    next.tombstone = { at, reason: obs.reason ?? 'Deleted.' };
    next.actionPending = null;
    next.inflightExecs = [];
  }
  return next;
}

// ─── The server clock ──────────────────────────────────────────────────────────────────────────────────────────────

export interface MutableServerClock extends ServerClock {
  /** Feeds one GMI `Date` header (received just now). */
  observe(serverDate: Date): void;
}

export function createServerClock(localNow: () => Date = () => new Date()): MutableServerClock {
  let offset: number | null = null;
  return {
    observe(serverDate) {
      const t = serverDate.getTime();
      if (Number.isFinite(t)) offset = t - localNow().getTime();
    },
    skewMs: () => offset,
    verified: () => offset !== null,
    now() {
      const local = localNow();
      return offset !== null && Math.abs(offset) > COMPUTE_TIMING.clockSkewMaxMs ? new Date(local.getTime() + offset) : local;
    },
  };
}

// ─── The supervisor ────────────────────────────────────────────────────────────────────────────────────────────────

export interface SupervisorDeps {
  registry: Registry;
  log: Logger;
  keys: ComputeKeyProvider;
  ce: Pick<CeApi, 'listContainers' | 'getContainer'>;
  sandbox: Pick<SandboxApi, 'listAll' | 'get'>;
  clock: ServerClock;
  /** Fills a record's unknown price before an interval opens (a record made before the price feed loaded). */
  prices?: PriceBook;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  random?: () => number;
}

/** The latest org-wide lists (for unmanaged rows and the sweep). */
export interface RemoteSnapshot {
  containers: SafeCeContainer[] | null;
  containersAt: string | null;
  sandboxes: V2SandboxSummary[] | null;
  sandboxesAt: string | null;
}

export interface ComputeSupervisor extends Supervisor {
  /** Applies an observation made by an action (or reconcile / sweep) right away. Null for an unknown id. */
  observe(resourceId: string, obs: Observation, source: PhaseTransition['source']): Promise<ComputeRecord | null>;
  remote(): RemoteSnapshot;
  /** The key changed: parked backends are tried again and a poll runs. */
  resetBackends(): void;
  /** pendingAction changes (UI). */
  onChange(listener: () => void): () => void;
  /** The delay until the next poll (tests, Diagnostics). Null while stopped or suspended. */
  nextDelayMs(): number | null;
}

interface BackendHealth {
  failures: number;
  firstFailureAt: number | null;
  nextAllowedAt: number;
  parked: boolean;
  everOk: boolean;
}

/** Back-off after `failures` consecutive failures: 2 s · 2^(n−1), capped at 5 min, jittered to 50–100 %. */
export function backoffMs(failures: number, random: () => number = Math.random, retryAfterSec?: number | null): number {
  const base = Math.min(COMPUTE_TIMING.pollBackoffMaxMs, COMPUTE_TIMING.pollBackoffMinMs * 2 ** Math.max(0, failures - 1));
  const jittered = Math.round(base * (0.5 + random() / 2));
  return Math.max(jittered, (retryAfterSec ?? 0) * 1000);
}

export function createSupervisor(deps: SupervisorDeps): ComputeSupervisor {
  const log = deps.log.child('compute.supervisor');
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const random = deps.random ?? Math.random;
  const clock = deps.clock;
  const nowMs = () => clock.now().getTime();
  const nowIso = () => clock.now().toISOString();

  const hints = { windowHidden: false, computerOpen: false, suspended: false };
  const watched = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();
  const pending = new Map<string, ComputeAction>();
  const fresh = new Map<string, string>();
  const seenThisRun = new Set<string>();
  const transitionListeners = new Set<(t: PhaseTransition) => void>();
  const changeListeners = new Set<() => void>();
  const health: Record<'ce' | 'sandbox', BackendHealth> = {
    ce: { failures: 0, firstFailureAt: null, nextAllowedAt: 0, parked: false, everOk: false },
    sandbox: { failures: 0, firstFailureAt: null, nextAllowedAt: 0, parked: false, everOk: false },
  };
  const snapshot: RemoteSnapshot = { containers: null, containersAt: null, sandboxes: null, sandboxesAt: null };
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let scheduledDelay: number | null = null;

  const notifyChange = () => {
    for (const l of [...changeListeners]) {
      try {
        l();
      } catch (error) {
        log.warn('supervisor listener failed', { error });
      }
    }
  };

  function emitTransition(t: PhaseTransition) {
    log.info('resource.transition', { rid: t.resourceId, kind: t.kind, from: t.from, to: t.to, raw: t.rawState });
    for (const l of [...transitionListeners]) {
      try {
        l(t);
      } catch (error) {
        log.warn('transition listener failed', { error });
      }
    }
  }

  async function observe(resourceId: string, obs: Observation, source: PhaseTransition['source']): Promise<ComputeRecord | null> {
    const rec = deps.registry.get(resourceId);
    if (!rec) return null;
    const at = nowIso();
    const first = !seenThisRun.has(resourceId);
    seenThisRun.add(resourceId);
    const priced = (r: ComputeRecord): ComputeRecord => (deps.prices ? (backfillPrice(r, deps.prices) ?? r) : r);
    let updated: ComputeRecord;
    if (rec.tombstone && obs.phase !== 'deleted') {
      // Seen alive again (a late answer): revive it.
      updated = await deps.registry.update(resourceId, (r) => applyObservation(priced({ ...r, tombstone: null }), obs, at));
    } else {
      updated = await deps.registry.update(resourceId, (r) => applyObservation(priced(r), obs, at));
    }
    fresh.set(resourceId, at);
    if (first || rec.phase !== obs.phase) {
      emitTransition({
        resourceId,
        kind: rec.kind,
        backend: rec.backend,
        from: first ? null : rec.phase,
        to: obs.phase,
        rawState: obs.rawState,
        at,
        remote: obs.remote,
        source,
      });
    }
    if (!TRANSITIONAL_PHASES.has(obs.phase)) watched.delete(resourceId);
    return updated;
  }

  function markOk(b: 'ce' | 'sandbox') {
    const h = health[b];
    h.failures = 0;
    h.firstFailureAt = null;
    h.nextAllowedAt = 0;
    h.everOk = true;
  }

  function markFailed(b: 'ce' | 'sandbox', error: unknown) {
    const h = health[b];
    if (error instanceof GmiError && (error.code === 'not_entitled' || error.code === 'invalid_compute_key' || error.code === 'no_compute_key')) {
      h.parked = true;
      log.info('backend parked until the key changes', { backend: b, code: error.code });
      return;
    }
    h.failures += 1;
    h.firstFailureAt ??= nowMs();
    const retryAfter = error instanceof GmiError ? error.retryAfterSec : null;
    h.nextAllowedAt = nowMs() + backoffMs(h.failures, random, retryAfter);
    log.warn('poll failed', { backend: b, code: error instanceof GmiError ? error.code : 'internal', failures: h.failures });
  }

  function healthOf(b: 'ce' | 'sandbox'): ComputeApiHealth {
    const h = health[b];
    if (h.parked) return 'unknown';
    if (h.firstFailureAt !== null && nowMs() - h.firstFailureAt >= COMPUTE_TIMING.healthDownAfterMs) return 'down';
    if (h.failures >= COMPUTE_TIMING.healthDegradedAfterFailures) return 'degraded';
    if (h.everOk) return 'ok';
    return h.failures > 0 ? 'degraded' : 'unknown';
  }

  const managed = (backend: ComputeBackend) =>
    deps.registry.list().filter((r) => r.managed && r.backend === backend && r.remoteId !== null);

  async function pollCe(): Promise<void> {
    const list = await deps.ce.listContainers();
    const at = nowIso();
    snapshot.containers = list;
    snapshot.containersAt = at;
    const byId = new Map(list.map((c) => [c.id, c]));
    for (const rec of managed('ce')) {
      const c = byId.get(rec.remoteId as string);
      if (c) {
        await observe(rec.id, observeContainer(c, pending.get(rec.id) ?? null, rec.phase), 'poll');
      } else if (rec.phase === 'creating' && rec.requestedAt && nowMs() - Date.parse(rec.requestedAt) < 2 * 60_000) {
        // Just created: the list may not show it yet [U].
      } else {
        // Missing from the list is not proof (§6.5: deleted = a 404 on the detail GET): a list blip or a late list must
        // never drop a billing container from the lease, budget and quit checks.
        try {
          const d = await deps.ce.getContainer(rec.remoteId as string);
          await observe(rec.id, observeContainer(d, pending.get(rec.id) ?? null, rec.phase), 'poll');
        } catch (error) {
          if (!(error instanceof GmiError && error.code === 'not_found')) {
            log.warn('container missing from the list; detail failed', { rid: rec.id, code: error instanceof GmiError ? error.code : 'internal' });
            continue;
          }
          const closeAt = rec.lastSeenAt ?? at;
          await observe(rec.id, { phase: 'deleted', rawState: null, reason: 'Gone from GMI.', remote: { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: closeAt } }, 'poll');
        }
      }
    }
    // A tombstoned record whose container is listed again (a late answer): revive it so it is enforced again.
    for (const rec of deps.registry.list({ includeTombstones: true })) {
      if (!rec.tombstone || !rec.managed || rec.backend !== 'ce' || !rec.remoteId) continue;
      const c = byId.get(rec.remoteId);
      if (c) await observe(rec.id, observeContainer(c, null, rec.phase), 'poll');
    }
  }

  async function pollSandboxes(): Promise<void> {
    const list = await deps.sandbox.listAll({ metadata: { app: 'gmi-desk' } });
    const at = nowIso();
    snapshot.sandboxes = list;
    snapshot.sandboxesAt = at;
    const byId = new Map(list.map((s) => [s.id, s]));
    for (const rec of managed('sandbox_v2')) {
      const s = byId.get(rec.remoteId as string);
      if (s && s.state === rec.rawState && !TRANSITIONAL_PHASES.has(rec.phase)) {
        await observe(rec.id, { ...observeSandbox({ ...s, ...detailFields(rec) }), reason: rec.reason }, 'poll');
        continue;
      }
      // Changed, transitional or missing from the default list (deleted is excluded there [V]): one detail GET.
      try {
        const d = await deps.sandbox.get(rec.remoteId as string);
        await observe(rec.id, observeSandbox(d), 'poll');
      } catch (error) {
        if (error instanceof GmiError && error.code === 'not_found') {
          const closeAt = rec.lastSeenAt ?? at;
          await observe(rec.id, { phase: 'deleted', rawState: null, reason: 'Gone from GMI.', remote: { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: closeAt } }, 'poll');
        } else if (s) {
          await observe(rec.id, observeSandbox(s), 'poll');
        } else {
          throw error;
        }
      }
    }
  }

  /** Keeps what only the detail knows (end_at, paused_at…) when the summary is unchanged. */
  function detailFields(rec: ComputeRecord): Partial<V2SandboxDetail> {
    return {
      ...(rec.serverEndsAt ? { end_at: rec.serverEndsAt } : {}),
      ...(rec.pausedAt ? { paused_at: rec.pausedAt } : {}),
      ...(rec.pausedExpiresAt ? { paused_expire_at: rec.pausedExpiresAt } : {}),
    };
  }

  async function pollOnce(): Promise<void> {
    let key: string | null = null;
    try {
      key = await deps.keys.getComputeKey();
    } catch {
      key = null;
    }
    if (!key) return;
    const run = async (b: 'ce' | 'sandbox', fn: () => Promise<void>) => {
      const h = health[b];
      if (h.parked || nowMs() < h.nextAllowedAt) return;
      try {
        await fn();
        markOk(b);
      } catch (error) {
        markFailed(b, error);
      }
    };
    await Promise.all([run('ce', pollCe), run('sandbox', pollSandboxes)]);
    notifyChange();
  }

  function cadence(): number | null {
    if (hints.suspended) return null;
    const transitional = watched.size > 0 || deps.registry.list().some((r) => r.managed && TRANSITIONAL_PHASES.has(r.phase));
    if (transitional) return COMPUTE_TIMING.pollTransitionalMs;
    if (hints.windowHidden) return COMPUTE_TIMING.pollHiddenMs;
    if (hints.computerOpen) return COMPUTE_TIMING.pollComputerOpenMs;
    return COMPUTE_TIMING.pollSteadyMs;
  }

  function schedule() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    scheduledDelay = null;
    if (!started) return;
    const delay = cadence();
    if (delay === null) return;
    scheduledDelay = delay;
    timer = timers.setTimeout(() => {
      timer = null;
      void pollNow().catch(() => undefined);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  }

  function pollNow(): Promise<void> {
    if (inflight) return inflight;
    inflight = pollOnce()
      .catch((error: unknown) => log.warn('poll failed', { error }))
      .finally(() => {
        inflight = null;
        schedule();
      });
    return inflight;
  }

  const supervisor: ComputeSupervisor = {
    clock,
    start() {
      if (started) return;
      started = true;
      void pollNow();
    },
    async stop() {
      started = false;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      scheduledDelay = null;
      await inflight?.catch(() => undefined);
    },
    pollNow,
    watch(resourceId) {
      watched.add(resourceId);
      if (started && (scheduledDelay === null || scheduledDelay > COMPUTE_TIMING.pollTransitionalMs) && !inflight) schedule();
    },
    setHints(patch) {
      const wasSuspended = hints.suspended;
      Object.assign(hints, patch);
      if (!started) return;
      if (wasSuspended && !hints.suspended) {
        void pollNow();
        return;
      }
      if (!inflight) schedule();
    },
    async withResourceLock(resourceId, action, fn) {
      const prev = locks.get(resourceId) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prev.then(() => mine);
      locks.set(resourceId, tail);
      await prev.catch(() => undefined);
      pending.set(resourceId, action);
      notifyChange();
      try {
        return await fn();
      } finally {
        pending.delete(resourceId);
        release();
        if (locks.get(resourceId) === tail) locks.delete(resourceId);
        supervisor.watch(resourceId);
        notifyChange();
      }
    },
    pendingAction: (resourceId) => pending.get(resourceId) ?? null,
    freshSince: (resourceId) => fresh.get(resourceId) ?? null,
    health: () => ({ ce: healthOf('ce'), sandbox: healthOf('sandbox') }),
    onTransition(listener) {
      transitionListeners.add(listener);
      return () => transitionListeners.delete(listener);
    },
    observe,
    remote: () => ({ ...snapshot }),
    resetBackends() {
      for (const h of Object.values(health)) Object.assign(h, { parked: false, failures: 0, firstFailureAt: null, nextAllowedAt: 0 });
      snapshot.containers = null;
      snapshot.sandboxes = null;
      if (started) void pollNow();
    },
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    nextDelayMs: () => scheduledDelay,
  };
  return supervisor;
}
