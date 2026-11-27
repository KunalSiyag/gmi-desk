// Container create + reconcile (compute.md §6.2, §11; DC3). C1-C.
//
//   journal intent (durable) → journal sent (durable, before the fetch) → POST /api/v1/containers {count: 1} exactly once
//     confirmed            → journal confirmed → registry record → supervisor.watch
//     failed (definite)    → journal failed → GmiError
//     unknown (timeout, 409, 429, 5xx, HTML, odd 200)  → journal unknown → reconcile by name: list now, then at
//                            +5 s, +15 s, +45 s, +120 s → found: confirmed; none: failed_unknown + alarm create_unknown,
//                            re-checked on every sweep. Never POSTed again.
// At startup every unresolved entry is reconciled before anything else (an `intent` that is not found was never sent).
import type { ContainerCreateSpec } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../../core/logger';
import type { Journal, JournalEntry, NetworkPlan } from '../journal';
import { blankRecord, defaultLease } from '../registry';
import type { SafeCeContainer } from '../sanitize';
import { observeContainer, type ComputeSupervisor } from '../supervisor';
import type { AlarmCenter, ComputeRecord, PriceBook, Registry } from '../types';
import type { CeApi } from './client';
import type { CeContainerCreateRequest } from './dto';

/** Reconcile delays after an unclear create (§6.2): now, then +5 s, +15 s, +45 s, +120 s. */
export const RECONCILE_DELAYS_MS = [0, 5_000, 15_000, 45_000, 120_000] as const;

export interface CreateDeps {
  ce: Pick<CeApi, 'createContainer' | 'listContainers'>;
  registry: Registry;
  journal: Journal;
  alarms: AlarmCenter;
  prices: PriceBook;
  supervisor: ComputeSupervisor;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

/** Everything create needs, validated by the service (secret env values in memory only). */
export interface PreparedContainer {
  rid: string;
  name: string;
  displayName: string;
  spec: ContainerCreateSpec;
  templateName: string | null;
  listUsdPerHour: number | null;
  sshKeyIds: string[];
  network: NetworkPlan | null;
  approvedMaxLifetimeMin: number | null;
}

const errorCode = (e: unknown) => (e instanceof GmiError ? e.code : 'internal');

function recordFor(p: PreparedContainer, installTag: string, at: string, remoteId: string | null, requestedAt: string): ComputeRecord {
  return blankRecord(
    {
      id: p.rid,
      kind: 'container',
      backend: 'ce',
      name: p.name,
      displayName: p.displayName,
      managed: true,
      remoteId,
      installTag,
      purpose: 'computer',
      idc: p.spec.idc,
      sku: p.spec.sku,
      templateId: p.spec.templateId,
      templateName: p.templateName,
      listUsdPerHour: p.listUsdPerHour,
      requestedAt,
      lease: { ...p.spec.lease },
      approvedMaxLifetimeMin: p.approvedMaxLifetimeMin,
      envNames: (p.spec.env ?? []).map((e) => e.name),
      command: p.spec.command ?? null,
      args: p.spec.args ?? [],
      reason: remoteId ? null : 'GMI did not confirm the create yet; checking whether it exists.',
      history: [{ at, phase: 'creating', note: null }],
    },
    at,
  );
}

/** The CE request body: `count` 1, env values only here (never stored). */
export function containerRequest(p: PreparedContainer): CeContainerCreateRequest {
  const s = p.spec;
  return {
    count: 1,
    name: p.name,
    idc: s.idc,
    product: s.sku,
    templateId: s.templateId,
    ...(s.command ? { command: s.command } : {}),
    ...(s.args?.length ? { args: s.args } : {}),
    ...(s.env?.length ? { envs: s.env.map((e) => ({ name: e.name, value: e.value })) } : {}),
    ...(s.ports?.length ? { ports: s.ports.map((x) => ({ containerPort: x.containerPort, protocol: x.protocol })) } : {}),
    ...(p.sshKeyIds.length ? { sshKeyIdList: p.sshKeyIds } : {}),
  };
}

/**
 * Creates one container. Resolves with the registry record (phase `creating`; `remoteId` null while unresolved).
 * Rejects only for a definite failure, before any record exists.
 */
export async function createContainer(deps: CreateDeps, p: PreparedContainer, ctx: { installTag: string; now: () => Date }): Promise<{ record: ComputeRecord; reconciled: Promise<ReconcileResult> | null }> {
  const at = ctx.now().toISOString();
  await deps.journal.append({ rid: p.rid, kind: 'container', backend: 'ce', name: p.name, displayName: p.displayName, idc: p.spec.idc, sku: p.spec.sku, at, network: p.network });
  await deps.journal.update(p.rid, { state: 'sent' });
  const requestedAt = ctx.now().toISOString();
  const outcome = await deps.ce.createContainer(containerRequest(p));
  if (outcome.outcome === 'failed') {
    await deps.journal.update(p.rid, { state: 'failed', error: outcome.error.code });
    throw outcome.error;
  }
  if (outcome.outcome === 'confirmed') {
    await deps.journal.update(p.rid, { state: 'confirmed', remoteId: outcome.value });
    const record = await deps.registry.add(recordFor(p, ctx.installTag, ctx.now().toISOString(), outcome.value, requestedAt));
    deps.supervisor.watch(record.id);
    return { record, reconciled: null };
  }
  deps.log.child('compute.ce').warn('container create unclear; reconciling by name', { rid: p.rid, code: outcome.error.code, status: outcome.error.status });
  await deps.journal.update(p.rid, { state: 'unknown', error: outcome.error.code });
  const record = await deps.registry.add(recordFor(p, ctx.installTag, ctx.now().toISOString(), null, requestedAt));
  const reconciled = reconcileContainer(deps, p.rid, { schedule: RECONCILE_DELAYS_MS });
  return { record, reconciled };
}

export type ReconcileResult = 'confirmed' | 'failed' | 'failed_unknown' | 'pending';

/**
 * Looks for the journal entry's container by name. `schedule` lists the delays before each listing (the first is
 * usually 0). An `intent` that is not found was never sent → `failed`. Never POSTs.
 */
export async function reconcileContainer(deps: CreateDeps, rid: string, opts: { schedule?: readonly number[] } = {}): Promise<ReconcileResult> {
  const log = deps.log.child('compute.ce');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const entry = deps.journal.get(rid);
  if (!entry || entry.backend !== 'ce') return 'pending';
  // `confirmed` without a record: the app stopped between the journal write and the registry add; find it again.
  if (entry.state === 'confirmed' && deps.registry.get(rid)) return 'confirmed';
  if (entry.state === 'failed' || entry.state === 'dismissed') return 'failed';
  const schedule = opts.schedule ?? [0];
  for (const delay of schedule) {
    if (delay > 0) await sleep(delay);
    let list: SafeCeContainer[];
    try {
      list = await deps.ce.listContainers();
    } catch (error) {
      log.warn('reconcile listing failed', { rid, code: errorCode(error) });
      if (errorCode(error) === 'no_compute_key' || errorCode(error) === 'invalid_compute_key' || errorCode(error) === 'not_entitled') return 'pending';
      continue;
    }
    const matches = list.filter((c) => c.name === entry.name);
    if (matches.length > 0) {
      await confirmContainers(deps, entry, matches);
      return 'confirmed';
    }
  }
  const current = deps.journal.get(rid);
  if (!current) return 'pending';
  // A confirmed create whose resource is gone by now: nothing bills, nothing to raise.
  if (current.state === 'confirmed') return 'confirmed';
  if (current.state === 'intent') {
    await deps.journal.update(rid, { state: 'failed', error: 'not_sent' });
    await dropUnresolvedRecord(deps, rid, 'The create was never sent.');
    return 'failed';
  }
  if (current.state !== 'failed_unknown') {
    await deps.journal.update(rid, { state: 'failed_unknown' });
    log.warn('create.journal', { rid, state: 'failed_unknown' });
  }
  await dropUnresolvedRecord(deps, rid, 'GMI never confirmed this create.');
  raiseCreateUnknown(deps, current);
  return 'failed_unknown';
}

export function raiseCreateUnknown(deps: Pick<CreateDeps, 'alarms' | 'prices'>, entry: JournalEntry) {
  const price = deps.prices.price(entry.sku, entry.idc).usdPerHour;
  deps.alarms.raise({
    kind: 'create_unknown',
    severity: 'critical',
    resourceId: entry.rid,
    title: `GMI did not confirm "${entry.displayName}"`,
    body: `An earlier create (${entry.name}) may still appear in your organization and bill. GMI Desk keeps checking every 10 minutes.`,
    usdPerHour: price,
    actions: ['open_console', 'dismiss'],
  });
}

async function dropUnresolvedRecord(deps: Pick<CreateDeps, 'registry'>, rid: string, reason: string) {
  const rec = deps.registry.get(rid);
  if (rec && !rec.remoteId && !rec.tombstone) await deps.registry.tombstone(rid, new Date().toISOString(), reason);
}

/** Records found containers for a journal entry: the first one under its rid, any extra adopted with an alarm. */
async function confirmContainers(deps: CreateDeps, entry: JournalEntry, matches: SafeCeContainer[]) {
  const [first, ...extra] = matches;
  if (!first) return;
  const wasUnresolved = entry.state === 'failed_unknown';
  await deps.journal.update(entry.rid, { state: 'confirmed', remoteId: first.id, error: null });
  const at = new Date().toISOString();
  if (deps.registry.get(entry.rid)) {
    await deps.registry.update(entry.rid, (r) => ({ ...r, remoteId: first.id, tombstone: null, phase: 'creating', reason: null }));
  } else {
    await deps.registry.add(
      blankRecord(
        {
          id: entry.rid,
          kind: 'container',
          backend: 'ce',
          name: entry.name,
          displayName: entry.displayName,
          managed: true,
          remoteId: first.id,
          idc: entry.idc,
          sku: entry.sku,
          listUsdPerHour: deps.prices.price(entry.sku, entry.idc).usdPerHour,
          requestedAt: entry.at,
          lease: defaultLease('container'),
          approvedMaxLifetimeMin: 240,
          history: [{ at, phase: 'creating', note: 'Found after an unclear create.' }],
        },
        at,
      ),
    );
  }
  await deps.supervisor.observe(entry.rid, observeContainer(first, null), 'reconcile');
  deps.supervisor.watch(entry.rid);
  deps.alarms.resolve('create_unknown', entry.rid);
  if (wasUnresolved) {
    deps.alarms.raise({
      kind: 'orphan',
      severity: 'warning',
      resourceId: entry.rid,
      title: `"${entry.displayName}" appeared late`,
      body: 'GMI did not confirm this create at first; it exists now and is billing. Keep it or delete it.',
      usdPerHour: deps.prices.price(entry.sku, entry.idc).usdPerHour,
      actions: ['open', 'delete', 'dismiss'],
    });
  }
  for (const c of extra) {
    const rid = `${entry.rid}-x${c.id.slice(0, 8)}`;
    if (deps.registry.findByRemote('ce', c.id)) continue;
    await deps.registry.add(
      blankRecord(
        { id: rid, kind: 'container', backend: 'ce', name: c.name, displayName: entry.displayName, managed: true, remoteId: c.id, idc: c.idc, sku: c.product, listUsdPerHour: deps.prices.price(c.product, c.idc).usdPerHour, requestedAt: entry.at, lease: defaultLease('container'), approvedMaxLifetimeMin: 240 },
        at,
      ),
    );
    await deps.supervisor.observe(rid, observeContainer(c, null), 'reconcile');
    deps.alarms.raise({
      kind: 'orphan',
      severity: 'critical',
      resourceId: rid,
      title: `A second "${entry.displayName}" exists`,
      body: 'GMI shows more than one container with this name. Both bill; delete the one you do not need.',
      usdPerHour: deps.prices.price(c.product, c.idc).usdPerHour,
      actions: ['open', 'delete', 'dismiss'],
    });
  }
}
