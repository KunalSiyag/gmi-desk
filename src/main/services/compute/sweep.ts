// The orphan sweep (compute.md §7.5; startup and every 10 min). C1-C.
//
//  1 list containers (org-wide) and this install's sandboxes; 2 this install's resources missing from the registry are
//  adopted as managed (default lease) with an `orphan` alarm; 3 unresolved journal entries are re-checked (a late
//  container is adopted); 4 billed `gmid-` containers with ANOTHER install tag → read-only `orphan` warning (Adopt needs a
//  native confirmation, done by the service); 5 registry entries gone remotely → tombstone (the supervisor's poll does
//  it too); 6 paused > 24 h → `paused_long`, once a day; 7 disassociated EIPs → `eip_unattached` with the hourly price;
//  8 the org-wide billing banner (counts + list $/h, nothing else); 9 nothing that is not this install's is ever acted on.
import { GmiError } from '@shared/contracts/errors';
import type { ComputeState } from '@shared/contracts/compute';
import type { Logger } from '../../core/logger';
import type { CeApi } from './ce/client';
import type { CeElasticIp } from './ce/dto';
import { reconcileContainer, type CreateDeps } from './ce/create';
import { UNRESOLVED_STATES, type Journal } from './journal';
import { adoptedSandboxId, containerOwnership, displayNameFromRemote, sandboxOwnership, unmanagedId } from './names';
import { blankRecord, defaultLease } from './registry';
import type { SandboxApi } from './sandbox/client';
import type { V2SandboxSummary } from './sandbox/dto';
import { reconcileSandbox, type LifecycleDeps } from './sandbox/lifecycle';
import type { SafeCeContainer } from './sanitize';
import { observeContainer, observeSandbox, type ComputeSupervisor } from './supervisor';
import type { AlarmCenter, ComputeRecord, PriceBook, Registry } from './types';

export const PAUSED_LONG_MS = 24 * 60 * 60_000;

export interface SweepDeps {
  ce: Pick<CeApi, 'listContainers' | 'listEips'>;
  sandbox: Pick<SandboxApi, 'listAll' | 'get'>;
  registry: Registry;
  journal: Journal;
  alarms: AlarmCenter;
  prices: PriceBook;
  supervisor: ComputeSupervisor;
  log: Logger;
  installTag: string;
  installLabel: string;
  /** For journal reconciles (same objects as the service uses). */
  createDeps: CreateDeps;
  lifecycleDeps: LifecycleDeps | null;
}

export interface SweepResult {
  at: string;
  org: ComputeState['org'];
  adopted: string[];
  otherInstall: string[];
  eipsUnattached: string[];
}

const money = (n: number | null) => (n === null ? 'price unknown' : `$${n.toFixed(n > 0 && n < 0.1 ? 4 : 2)}/h`);
const codeOf = (e: unknown) => (e instanceof GmiError ? e.code : 'internal');

export interface Sweeper {
  run(): Promise<SweepResult | null>;
  last(): SweepResult | null;
}

export function createSweeper(deps: SweepDeps): Sweeper {
  const log = deps.log.child('compute.sweep');
  const pausedLongRaisedAt = new Map<string, number>();
  let last: SweepResult | null = null;
  let inflight: Promise<SweepResult | null> | null = null;

  const nowIso = () => deps.supervisor.clock.now().toISOString();
  const nowMs = () => deps.supervisor.clock.now().getTime();

  async function adoptContainer(c: SafeCeContainer, rid?: string | null): Promise<ComputeRecord> {
    const at = nowIso();
    const price = deps.prices.price(c.product, c.idc).usdPerHour;
    const rec = await deps.registry.add(
      blankRecord(
        {
          id: rid && !deps.registry.get(rid) ? rid : `cr_${c.id}`,
          kind: 'container',
          backend: 'ce',
          name: c.name,
          displayName: displayNameFromRemote(c.name),
          managed: true,
          remoteId: c.id,
          installTag: deps.installTag,
          purpose: 'computer',
          idc: c.idc,
          sku: c.product,
          templateId: c.templateId ?? null,
          listUsdPerHour: price,
          // The lease starts now (first observation by this run), so an old container is never deleted at once.
          runningSince: c.status === 'running' ? at : null,
          lease: defaultLease('container'),
          approvedMaxLifetimeMin: 240,
          leaseChangedAt: at,
          envNames: c.envNames ?? [],
          history: [{ at, phase: 'unknown', note: 'Found by the sweep (earlier session).' }],
        },
        at,
      ),
    );
    await deps.supervisor.observe(rec.id, observeContainer(c, null), 'sweep');
    return rec;
  }

  async function adoptSandbox(s: V2SandboxSummary): Promise<ComputeRecord> {
    const at = nowIso();
    const purpose = s.metadata?.purpose === 'agent' ? 'agent' : 'computer';
    const sku = (s as { product?: string }).product ?? null;
    const price = sku ? deps.prices.price(sku, s.idc_name ?? null).usdPerHour : null;
    const id = adoptedSandboxId(s.metadata, (x) => deps.registry.get(x) !== null);
    const rec = await deps.registry.add(
      blankRecord(
        {
          id,
          kind: 'sandbox',
          backend: 'sandbox_v2',
          name: `sandbox-${s.sandbox_key ?? s.id}`,
          displayName: `Sandbox ${s.sandbox_key ?? s.id.slice(0, 8)}`,
          managed: true,
          remoteId: s.id,
          installTag: deps.installLabel,
          purpose,
          idc: s.idc_name ?? null,
          sku,
          templateId: s.template_id ?? null,
          snapshotId: s.snapshot_id ?? null,
          listUsdPerHour: price,
          runningSince: s.state === 'running' ? at : null,
          lease: defaultLease('sandbox', purpose),
          approvedMaxLifetimeMin: 480,
          leaseChangedAt: at,
          history: [{ at, phase: 'unknown', note: 'Found by the sweep (earlier session).' }],
        },
        at,
      ),
    );
    let detail: Parameters<typeof observeSandbox>[0] = s;
    try {
      const d = await deps.sandbox.get(s.id);
      detail = d;
      const product = d.product;
      if (product && product !== rec.sku) {
        const p = deps.prices.price(product, d.idc_name ?? null).usdPerHour;
        await deps.registry.update(rec.id, (r) => ({ ...r, sku: product, listUsdPerHour: p, intervals: r.intervals.map((i) => ({ ...i, usdPerHour: p })) }));
      }
    } catch {
      // the summary is enough
    }
    await deps.supervisor.observe(rec.id, observeSandbox(detail), 'sweep');
    return deps.registry.get(rec.id) ?? rec;
  }

  async function sweepOnce(): Promise<SweepResult | null> {
    const at = nowIso();
    const adopted: string[] = [];
    const otherInstall: string[] = [];
    const eipsUnattached: string[] = [];

    // 3. Unresolved journal entries first (a late container must be adopted under its own rid, not as an orphan).
    for (const entry of deps.journal.unresolved()) {
      if (entry.state !== 'failed_unknown' && entry.state !== 'unknown') continue;
      try {
        if (entry.backend === 'ce') await reconcileContainer(deps.createDeps, entry.rid);
        else if (deps.lifecycleDeps) await reconcileSandbox(deps.lifecycleDeps, entry.rid);
      } catch (error) {
        log.warn('journal re-check failed', { rid: entry.rid, code: codeOf(error) });
      }
    }

    // 1. Lists.
    const [containersRes, sandboxesRes, eipsRes] = await Promise.allSettled([
      deps.ce.listContainers(),
      deps.sandbox.listAll({ metadata: { app: 'gmi-desk', inst: deps.installLabel } }),
      deps.ce.listEips(),
    ]);
    const containers = containersRes.status === 'fulfilled' ? containersRes.value : null;
    const sandboxes = sandboxesRes.status === 'fulfilled' ? sandboxesRes.value : null;
    const eips: CeElasticIp[] | null = eipsRes.status === 'fulfilled' ? eipsRes.value : null;
    for (const r of [containersRes, sandboxesRes, eipsRes]) if (r.status === 'rejected') log.warn('sweep listing failed', { code: codeOf(r.reason) });
    if (!containers && !sandboxes && !eips) {
      const e = containersRes.status === 'rejected' ? containersRes.reason : null;
      if (e instanceof GmiError && (e.code === 'no_compute_key' || e.code === 'invalid_compute_key')) return null;
    }

    // Only an unresolved entry is owned by the journal re-check; a confirmed (crash before the registry add) or
    // dismissed entry whose resource is listed is adopted like any other orphan of this install.
    const journalByName = new Map(deps.journal.list().map((e) => [e.name, e]));
    const journalNames = new Set(journalByName.keys());

    // 2 + 4. Containers.
    if (containers) {
      const listed = new Set(containers.map((c) => c.id));
      for (const c of containers) {
        const known = deps.registry.findByRemote('ce', c.id);
        if (known) {
          if (known.managed) deps.alarms.resolve('orphan', unmanagedId('ce', c.id));
          // Tombstoned but listed again (a list blip or a late answer): revive it so lease, budget and quit apply.
          if (known.managed && known.tombstone) await deps.supervisor.observe(known.id, observeContainer(c, null), 'sweep');
          continue;
        }
        const own = containerOwnership(c.name, deps.installTag);
        if (own === 'this_install' || (own !== 'unmanaged' && journalNames.has(c.name))) {
          const entry = journalByName.get(c.name) ?? null;
          if (entry && UNRESOLVED_STATES.has(entry.state)) continue; // the journal re-check owns it
          const rec = await adoptContainer(c, entry?.rid ?? null);
          adopted.push(rec.id);
          deps.alarms.raise({
            kind: 'orphan',
            severity: 'warning',
            resourceId: rec.id,
            title: 'Found a running container from an earlier session',
            body: `${c.name} was created by this GMI Desk and is billing (${money(rec.listUsdPerHour)} list). It now has a 4-hour lease (then it is deleted). Keep it or delete it.`,
            usdPerHour: rec.listUsdPerHour,
            actions: ['open', 'delete', 'dismiss'],
          });
          log.info('alarm.raised', { kind: 'orphan', rid: rec.id });
        } else if (own === 'other_install') {
          const id = unmanagedId('ce', c.id);
          otherInstall.push(id);
          deps.alarms.raise({
            kind: 'orphan',
            severity: 'warning',
            resourceId: id,
            title: 'A GMI Desk container from another install is billing',
            body: `${c.name} (${money(deps.prices.price(c.product, c.idc).usdPerHour)}) was created by another GMI Desk (a reinstall, a lost profile, or a colleague). GMI Desk does not touch it unless you adopt it.`,
            usdPerHour: deps.prices.price(c.product, c.idc).usdPerHour,
            actions: ['open_console', 'adopt', 'dismiss'],
          });
        }
      }
      // Other-install alarms whose container is gone.
      for (const alarm of deps.alarms.list()) {
        if (alarm.kind !== 'orphan' || !alarm.resourceId?.startsWith('ur_ce_')) continue;
        if (!listed.has(alarm.resourceId.slice('ur_ce_'.length))) deps.alarms.resolve('orphan', alarm.resourceId);
      }
    }

    // 2. This install's sandboxes.
    if (sandboxes) {
      for (const s of sandboxes) {
        if (sandboxOwnership(s.metadata, deps.installLabel) !== 'this_install') continue;
        if (deps.registry.findByRemote('sandbox_v2', s.id)) continue;
        const rid = s.metadata?.rid;
        const entry = rid ? deps.journal.get(rid) : null;
        if (entry && UNRESOLVED_STATES.has(entry.state)) continue; // the journal re-check owns it
        if (s.state === 'deleted' || s.state === 'deleting') continue;
        const rec = await adoptSandbox(s);
        adopted.push(rec.id);
        deps.alarms.raise({
          kind: 'orphan',
          severity: 'warning',
          resourceId: rec.id,
          title: 'Found a running sandbox from an earlier session',
          body: `It was created by this GMI Desk and was not in its records (${money(rec.listUsdPerHour)} list). Keep it, pause it or delete it.`,
          usdPerHour: rec.listUsdPerHour,
          actions: ['open', 'pause', 'delete', 'dismiss'],
        });
      }
    }

    // 6. Paused for more than 24 h: a reminder once a day.
    for (const rec of deps.registry.list()) {
      if (!rec.managed || rec.phase !== 'paused' || !rec.pausedAt) continue;
      if (nowMs() - Date.parse(rec.pausedAt) < PAUSED_LONG_MS) continue;
      const lastAt = pausedLongRaisedAt.get(rec.id) ?? 0;
      if (nowMs() - lastAt < PAUSED_LONG_MS) continue;
      pausedLongRaisedAt.set(rec.id, nowMs());
      deps.alarms.raise({
        kind: 'paused_long',
        severity: 'info',
        resourceId: rec.id,
        title: `${rec.displayName} has been paused for over a day`,
        body: rec.pausedExpiresAt ? `GMI deletes it on ${rec.pausedExpiresAt.slice(0, 10)} unless it is resumed.` : 'Resume it or delete it.',
        usdPerHour: null,
        actions: ['open', 'delete', 'dismiss'],
      });
    }

    // 7. EIPs.
    if (eips) {
      const managedEips = new Map<string, ComputeRecord>();
      for (const rec of deps.registry.list({ includeTombstones: true })) if (rec.network?.eip?.managed) managedEips.set(rec.network.eip.id, rec);
      const seen = new Set<string>();
      for (const e of eips) {
        seen.add(e.id);
        const managed = managedEips.has(e.id) || containerOwnership(e.name ?? '', deps.installTag) === 'this_install';
        if (e.status === 'disassociated') {
          eipsUnattached.push(e.id);
          const price = deps.prices.price(e.product, e.idc).usdPerHour;
          deps.alarms.raise({
            kind: 'eip_unattached',
            severity: 'warning',
            resourceId: e.id,
            title: 'A public IP is not attached to anything',
            body: `${e.name || e.ipAddress || 'An elastic IP'} bills ${money(price)} (list) until it is released.${managed ? '' : ' GMI Desk did not allocate it: release it in the GMI console.'}`,
            usdPerHour: price,
            actions: managed ? ['release_eip', 'open_console', 'dismiss'] : ['open_console', 'dismiss'],
          });
        } else {
          deps.alarms.resolve('eip_unattached', e.id);
        }
      }
      for (const alarm of deps.alarms.list()) {
        if (alarm.kind === 'eip_unattached' && alarm.resourceId && !seen.has(alarm.resourceId) && !deps.registry.get(alarm.resourceId)) deps.alarms.resolve('eip_unattached', alarm.resourceId);
      }
    }

    // 8. The org-wide banner: every container (all CE states bill until deleted) and every EIP the key can see.
    let org: ComputeState['org'] = last?.org ?? null;
    if (containers && eips) {
      let usd = 0;
      let known = false;
      for (const c of containers) {
        const p = deps.prices.price(c.product, c.idc).usdPerHour;
        if (p !== null) {
          usd += p;
          known = true;
        }
      }
      const billedEips = eips.filter((e) => e.status !== 'released');
      for (const e of billedEips) {
        const p = deps.prices.price(e.product, e.idc).usdPerHour;
        if (p !== null) {
          usd += p;
          known = true;
        }
      }
      org = { containers: containers.length, eips: billedEips.length, usdPerHour: known ? Math.round(usd * 10_000) / 10_000 : containers.length + billedEips.length === 0 ? 0 : null };
    }

    last = { at, org, adopted, otherInstall, eipsUnattached };
    log.info('sweep', { adopted: adopted.length, otherInstall: otherInstall.length, eips: eipsUnattached.length });
    return last;
  }

  return {
    run() {
      if (inflight) return inflight;
      inflight = sweepOnce()
        .catch((error: unknown) => {
          log.warn('sweep failed', { code: codeOf(error) });
          return last;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    last: () => last,
  };
}
