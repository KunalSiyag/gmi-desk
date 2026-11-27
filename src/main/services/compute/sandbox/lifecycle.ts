// Sandbox lifecycle on the v2 control plane (compute.md §7.1, §7.3, §7.4). C1-C.
//
// Create: journal intent → sent → one POST with `Idempotency-Key: <rid>` (the client retries only with that key, in
// this process, inside 2 minutes). An unclear outcome is reconciled ONLY by listing `metadata[rid]=<rid>`, including
// `deleted` (one call for the default states, one for `deleted`); never by re-POSTing (GMI remembers keys 24 h).
// Pause → 202 then poll. Resume (cold, always: token refreshed). Extend → POST /timeout, token refreshed (re-signed [V]).
// Snapshot from `running` only, with the opt-out scrub step. Delete is safe to repeat; the record stays as a tombstone.
// Every native dialog is the service's job: these functions assume the user already approved.
import type { SandboxCreateSpec } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../../core/logger';
import type { Journal } from '../journal';
import { sandboxMetadata } from '../names';
import { blankRecord, defaultLease } from '../registry';
import { observeSandbox, type ComputeSupervisor, type Observation } from '../supervisor';
import type { AlarmCenter, ComputeRecord, PriceBook, Registry } from '../types';
import type { SandboxApi } from './client';
import type { DataPlaneApi, TokenCache } from './dataplane';
import type { V2CreateSandboxRequest, V2SandboxSummary, V2Snapshot } from './dto';
import { ComputeHttpError } from '../errors';

export const SANDBOX_RECONCILE_DELAYS_MS = [0, 5_000, 15_000, 45_000, 120_000] as const;

/** §7.3: removes common credential stores before a snapshot (opt-out). Paths are fixed: nothing user-supplied. */
export const SNAPSHOT_SCRUB_COMMAND = 'rm -rf ~/.git-credentials ~/.config/gh ~/.npmrc ~/.cache/pip';

export interface LifecycleDeps {
  sandbox: SandboxApi;
  tokens: TokenCache | null;
  dataPlane: Pick<DataPlaneApi, 'exec'> | null;
  registry: Registry;
  journal: Journal;
  alarms: AlarmCenter;
  prices: PriceBook;
  supervisor: ComputeSupervisor;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface PreparedSandbox {
  rid: string;
  name: string;
  displayName: string;
  /** Real env values (memory only, until the POST). */
  spec: SandboxCreateSpec;
  templateName: string | null;
  listUsdPerHour: number | null;
  approvedMaxLifetimeMin: number | null;
  /** This install's `inst` label. */
  label: string;
}

const NULL_REMOTE: Observation['remote'] = { createdAt: null, runningAt: null, pausedAt: null, endAt: null, deletionRequestedAt: null };

/** The v2 create body (§7.1): explicit timeout, `auto_pause` from onTimeout, org-visible labels without PII. */
export function sandboxRequest(p: PreparedSandbox): V2CreateSandboxRequest {
  const s = p.spec;
  const env = Object.fromEntries((s.env ?? []).map((e) => [e.name, e.value]));
  return {
    ...('templateId' in s.source ? { template_id: s.source.templateId } : { snapshot_id: s.source.snapshotId }),
    product: s.product,
    ...(s.idc ? { idc_name: s.idc } : {}),
    timeout: Math.round(s.timeoutSec),
    auto_pause: s.onTimeout === 'pause',
    secure: s.secure,
    ...(Object.keys(env).length ? { env_vars: env } : {}),
    metadata: sandboxMetadata({ label: p.label, rid: p.rid, purpose: s.purpose, threadId: s.threadId ?? null }),
    ...(s.egress.mode === 'allowlist'
      ? { egress_control: true, egress: { allowed_hostnames: [...s.egress.hostnames], allowed_cidrs: [...s.egress.cidrs] } }
      : {}),
  };
}

function recordFor(p: PreparedSandbox, at: string, remoteId: string | null, requestedAt: string): ComputeRecord {
  const s = p.spec;
  return blankRecord(
    {
      id: p.rid,
      kind: 'sandbox',
      backend: 'sandbox_v2',
      name: p.name,
      displayName: p.displayName,
      managed: true,
      remoteId,
      installTag: p.label,
      purpose: s.purpose,
      threadId: s.threadId ?? null,
      idc: s.idc,
      sku: s.product,
      templateId: 'templateId' in s.source ? s.source.templateId : null,
      snapshotId: 'snapshotId' in s.source ? s.source.snapshotId : null,
      templateName: p.templateName,
      listUsdPerHour: p.listUsdPerHour,
      requestedAt,
      lease: { ...s.lease },
      approvedMaxLifetimeMin: p.approvedMaxLifetimeMin,
      envNames: (s.env ?? []).map((e) => e.name),
      secure: s.secure,
      egressLocked: s.egress.mode === 'allowlist',
      reason: remoteId ? null : 'GMI did not confirm the create yet; checking whether it exists.',
      history: [{ at, phase: 'creating', note: null }],
    },
    at,
  );
}

export async function createSandbox(
  deps: LifecycleDeps,
  p: PreparedSandbox,
  ctx: { now: () => Date },
): Promise<{ record: ComputeRecord; reconciled: Promise<SandboxReconcileResult> | null }> {
  const at = ctx.now().toISOString();
  await deps.journal.append({ rid: p.rid, kind: 'sandbox', backend: 'sandbox_v2', name: p.name, displayName: p.displayName, idc: p.spec.idc, sku: p.spec.product, at, network: null });
  await deps.journal.update(p.rid, { state: 'sent' });
  const requestedAt = ctx.now().toISOString();
  const outcome = await deps.sandbox.create(sandboxRequest(p), { idempotencyKey: p.rid });
  if (outcome.outcome === 'failed') {
    if (outcome.error instanceof ComputeHttpError && outcome.error.remoteCode === 'Sandbox.IdempotentParameterMismatch') {
      deps.log.child('compute.v2').error('idempotency key reused with other parameters (a GMI Desk bug)', { rid: p.rid });
    }
    await deps.journal.update(p.rid, { state: 'failed', error: outcome.error.code });
    throw outcome.error;
  }
  if (outcome.outcome === 'confirmed') {
    try {
      deps.tokens?.put(outcome.value);
    } catch {
      // A malformed address: the session connects again later.
    }
    await deps.journal.update(p.rid, { state: 'confirmed', remoteId: outcome.value.id });
    const record = await deps.registry.add(recordFor(p, ctx.now().toISOString(), outcome.value.id, requestedAt));
    deps.supervisor.watch(record.id);
    return { record, reconciled: null };
  }
  deps.log.child('compute.v2').warn('sandbox create unclear; reconciling by metadata', { rid: p.rid, code: outcome.error.code });
  await deps.journal.update(p.rid, { state: 'unknown', error: outcome.error.code });
  const record = await deps.registry.add(recordFor(p, ctx.now().toISOString(), null, requestedAt));
  return { record, reconciled: reconcileSandbox(deps, p.rid, { schedule: SANDBOX_RECONCILE_DELAYS_MS }) };
}

export type SandboxReconcileResult = 'confirmed' | 'failed' | 'failed_unknown' | 'pending';

/** Lists `metadata[rid]=<rid>` in the default states and in `deleted` (the default list excludes it [V]). */
export async function findSandboxByRid(sandbox: Pick<SandboxApi, 'listAll'>, rid: string): Promise<V2SandboxSummary[]> {
  const [live, deleted] = await Promise.all([
    sandbox.listAll({ metadata: { app: 'gmi-desk', rid } }),
    sandbox.listAll({ metadata: { app: 'gmi-desk', rid }, states: ['deleted'] }),
  ]);
  const byId = new Map<string, V2SandboxSummary>();
  for (const s of [...deleted, ...live]) byId.set(s.id, s);
  return [...byId.values()];
}

export async function reconcileSandbox(deps: LifecycleDeps, rid: string, opts: { schedule?: readonly number[] } = {}): Promise<SandboxReconcileResult> {
  const log = deps.log.child('compute.v2');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const entry = deps.journal.get(rid);
  if (!entry || entry.backend !== 'sandbox_v2') return 'pending';
  // `confirmed` without a record: the app stopped between the journal write and the registry add; find it again.
  if (entry.state === 'confirmed' && deps.registry.get(rid)) return 'confirmed';
  if (entry.state === 'failed' || entry.state === 'dismissed') return 'failed';
  for (const delay of opts.schedule ?? [0]) {
    if (delay > 0) await sleep(delay);
    let found: V2SandboxSummary[];
    try {
      found = await findSandboxByRid(deps.sandbox, rid);
    } catch (error) {
      const code = error instanceof GmiError ? error.code : 'internal';
      log.warn('sandbox reconcile listing failed', { rid, code });
      if (code === 'no_compute_key' || code === 'invalid_compute_key' || code === 'not_entitled') return 'pending';
      continue;
    }
    const s = found[0];
    if (s) {
      const wasUnresolved = entry.state === 'failed_unknown';
      await deps.journal.update(rid, { state: 'confirmed', remoteId: s.id, error: null });
      if (deps.registry.get(rid)) {
        await deps.registry.update(rid, (r) => ({ ...r, remoteId: s.id, tombstone: null, phase: 'creating', reason: null }));
      } else {
        const at = new Date().toISOString();
        const purpose = s.metadata?.purpose === 'agent' ? 'agent' : 'computer';
        await deps.registry.add(
          blankRecord(
            {
              id: rid,
              kind: 'sandbox',
              backend: 'sandbox_v2',
              name: entry.name,
              displayName: entry.displayName,
              managed: true,
              remoteId: s.id,
              installTag: s.metadata?.inst ?? null,
              purpose,
              idc: entry.idc,
              sku: entry.sku,
              listUsdPerHour: deps.prices.price(entry.sku, entry.idc).usdPerHour,
              requestedAt: entry.at,
              // Same lease as an adopted sandbox (sweep.adoptSandbox): the app lease and idle pause apply.
              lease: defaultLease('sandbox', purpose),
              approvedMaxLifetimeMin: 480,
              leaseChangedAt: at,
            },
            at,
          ),
        );
      }
      // A sandbox that was created and then expired is found `deleted`: its accrual closes at deletion.requested_at.
      let detail: Parameters<typeof observeSandbox>[0] = s;
      try {
        detail = await deps.sandbox.get(s.id);
      } catch {
        // the summary is enough to go on
      }
      await deps.supervisor.observe(rid, observeSandbox(detail), 'reconcile');
      deps.supervisor.watch(rid);
      deps.alarms.resolve('create_unknown', rid);
      if (wasUnresolved && s.state !== 'deleted') {
        deps.alarms.raise({
          kind: 'orphan',
          severity: 'warning',
          resourceId: rid,
          title: `"${entry.displayName}" appeared late`,
          body: 'GMI did not confirm this sandbox at first; it exists now. Keep it, pause it or delete it.',
          usdPerHour: deps.prices.price(entry.sku, entry.idc).usdPerHour,
          actions: ['open', 'pause', 'delete', 'dismiss'],
        });
      }
      return 'confirmed';
    }
  }
  const current = deps.journal.get(rid);
  if (!current) return 'pending';
  // A confirmed create whose resource is gone by now: nothing bills, nothing to raise.
  if (current.state === 'confirmed') return 'confirmed';
  const rec = deps.registry.get(rid);
  if (current.state === 'intent') {
    await deps.journal.update(rid, { state: 'failed', error: 'not_sent' });
    if (rec && !rec.remoteId && !rec.tombstone) await deps.registry.tombstone(rid, new Date().toISOString(), 'The create was never sent.');
    return 'failed';
  }
  if (current.state !== 'failed_unknown') await deps.journal.update(rid, { state: 'failed_unknown' });
  if (rec && !rec.remoteId && !rec.tombstone) await deps.registry.tombstone(rid, new Date().toISOString(), 'GMI never confirmed this create.');
  deps.alarms.raise({
    kind: 'create_unknown',
    severity: 'critical',
    resourceId: rid,
    title: `GMI did not confirm "${current.displayName}"`,
    body: 'This sandbox may still appear in your organization and bill. GMI Desk keeps checking every 10 minutes.',
    usdPerHour: deps.prices.price(current.sku, current.idc).usdPerHour,
    actions: ['open_console', 'dismiss'],
  });
  return 'failed_unknown';
}

function remoteOf(rec: ComputeRecord): string {
  if (rec.kind !== 'sandbox' || !rec.remoteId) throw new GmiError('invalid_input', 'This is not a sandbox GMI Desk can manage yet.');
  return rec.remoteId;
}

/** Applies an accepted lifecycle state (`pausing`, `deleting`, …) at once; the supervisor's fast poll follows. */
async function accepted(deps: LifecycleDeps, rec: ComputeRecord, state: string, note: string | null) {
  await deps.supervisor.observe(rec.id, { ...observeSandbox({ id: rec.remoteId as string, state }), reason: note, serverEndsAt: undefined, pausedExpiresAt: undefined, remote: NULL_REMOTE }, 'action');
}

export async function pauseSandbox(deps: LifecycleDeps, rec: ComputeRecord): Promise<void> {
  const res = await deps.sandbox.pause(remoteOf(rec));
  await accepted(deps, rec, res.state, null);
}

/** Resume (cold, §7.3): the next data-plane call connects again; history notes that processes may be gone. */
export async function resumeSandbox(deps: LifecycleDeps, rec: ComputeRecord, timeoutSec: number | null): Promise<void> {
  const id = remoteOf(rec);
  const res = await deps.sandbox.resume(id, timeoutSec);
  deps.tokens?.invalidate(id);
  await accepted(deps, rec, res.state, 'Resumed: processes and /tmp may be gone (cold resume).');
}

/** POST /timeout (seconds from now). Resolves with GMI's authoritative new end. */
export async function setSandboxTimeout(deps: LifecycleDeps, rec: ComputeRecord, seconds: number): Promise<string> {
  const id = remoteOf(rec);
  const res = await deps.sandbox.setTimeout(id, Math.max(1, Math.min(86_400, Math.round(seconds))));
  deps.tokens?.invalidate(id);
  await deps.registry.update(rec.id, (r) => ({ ...r, serverEndsAt: res.new_end_at }));
  return res.new_end_at;
}

export async function deleteSandbox(deps: LifecycleDeps, rec: ComputeRecord): Promise<void> {
  const id = remoteOf(rec);
  let state = 'deleting';
  try {
    state = (await deps.sandbox.delete(id)).state;
  } catch (error) {
    if (!(error instanceof GmiError && error.code === 'not_found')) throw error;
    state = 'deleted';
  }
  deps.tokens?.invalidate(id);
  await accepted(deps, rec, state, null);
}

/** Snapshot (§7.3): only from running; optional scrub exec first; labelled with this install's metadata. */
export async function snapshotSandbox(
  deps: LifecycleDeps,
  rec: ComputeRecord,
  opts: { name: string; scrub: boolean; label: string },
): Promise<V2Snapshot> {
  const id = remoteOf(rec);
  if (rec.phase !== 'running') throw new GmiError('invalid_input', 'A snapshot can only be taken while the sandbox is running.');
  if (opts.scrub) {
    if (!deps.dataPlane) throw new GmiError('internal', 'The sandbox data plane is not available.');
    // Fixed command, no user input; app-originated (not activity).
    await deps.dataPlane.exec(id, { command: SNAPSHOT_SCRUB_COMMAND, timeoutSec: 60 });
  }
  const out = await deps.sandbox.createSnapshot({ sandbox_id: id, name: opts.name, metadata: { app: 'gmi-desk', inst: opts.label, rid: rec.id } });
  if (out.outcome === 'confirmed') return out.value;
  if (out.outcome === 'failed') throw out.error;
  throw new GmiError('upstream', 'GMI did not confirm the snapshot. Refresh the snapshot list before trying again.', { detail: out.error.code });
}
