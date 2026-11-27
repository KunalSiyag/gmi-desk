// Public access for containers: CIDR rules, the EIP + firewall saga and the teardown order (compute.md §6.3). C1-C.
//
// CIDR rules, enforced in main (create and updateFirewallCidr): IPv4 only; reserved ranges refused; anything broader
// than /32 is "open" whatever `allOpen` says (the caller needs a native confirmation); 0.0.0.0/0 is "All Open".
// Saga: each step is recorded (journal plan step + registry network ids), never retried automatically, and checked by a
// GET before it runs, so a restart or a retry never allocates a second EIP or firewall:
//   1 container running → 2 allocate EIP → 3 associate it → 4 create firewall → 5 associate it
//   a failure → container kept, `network.degraded`, alarm.
// Teardown: disassociate firewall(s) → disassociate EIP → DELETE container → poll until 404 → release the EIP (managed
// and asked) → delete the firewall (managed, asked, nothing else attached). An EIP that is kept raises eip_unattached
// on the next sweep.
import { GmiError } from '@shared/contracts/errors';
import type { ComputeNetwork, FirewallRuleView } from '@shared/contracts/compute';
import type { Logger } from '../../../core/logger';
import type { Journal, NetworkPlan } from '../journal';
import type { AlarmCenter, ComputeRecord, PriceBook, Registry } from '../types';
import type { CeApi } from './client';
import type { CeFirewall, CeFirewallRule } from './dto';
import { closeEipInterval, openEipInterval } from '../accrual';

// ─── CIDRs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CidrCheck {
  /** Normalised `a.b.c.d/n`. */
  cidr: string;
  prefix: number;
  /** Broader than /32: anyone in that range can connect (native confirmation). */
  open: boolean;
  /** 0.0.0.0/0. */
  allOpen: boolean;
}

const RESERVED: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 (only 0.0.0.0/0 itself is accepted)
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xe0000000, 4], // 224.0.0.0/4
  [0xf0000000, 4], // 240.0.0.0/4
];

const maskOf = (prefix: number) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

/** Parses and checks one IPv4 CIDR (a bare address means /32). Throws GmiError('invalid_input'). */
export function checkCidr(input: string): CidrCheck {
  const raw = typeof input === 'string' ? input.trim() : '';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(raw);
  if (!m) throw new GmiError('invalid_input', `"${raw.slice(0, 64)}" is not an IPv4 address or CIDR (IPv6 is not supported).`);
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255) || m.slice(1, 5).some((o) => o.length > 1 && o.startsWith('0'))) {
    throw new GmiError('invalid_input', `"${raw}" is not a valid IPv4 address.`);
  }
  const prefix = m[5] === undefined ? 32 : Number(m[5]);
  if (prefix > 32) throw new GmiError('invalid_input', `"${raw}" has an invalid prefix length.`);
  const addr = (((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
  if ((addr & maskOf(prefix)) >>> 0 !== addr) {
    throw new GmiError('invalid_input', `"${raw}" has host bits set; use the network address of the range.`);
  }
  const allOpen = addr === 0 && prefix === 0;
  if (!allOpen) {
    for (const [net, bits] of RESERVED) {
      if (((addr & maskOf(bits)) >>> 0) === net) throw new GmiError('invalid_input', `"${raw}" is a reserved address range.`);
    }
  }
  return { cidr: `${octets.join('.')}/${prefix}`, prefix, open: prefix < 32, allOpen };
}

/** Checks every CIDR of an access request. `open` ignores the renderer's `allOpen` flag on purpose (§6.3). */
export function checkAccess(cidrs: readonly string[]): { rules: CidrCheck[]; open: boolean; allOpen: boolean } {
  if (!Array.isArray(cidrs) || cidrs.length === 0) throw new GmiError('invalid_input', 'Public access needs at least one source address.');
  if (cidrs.length > 10) throw new GmiError('invalid_input', 'At most 10 source ranges.');
  const rules = cidrs.map(checkCidr);
  return { rules, open: rules.some((r) => r.open), allOpen: rules.some((r) => r.allOpen) };
}

export function describeCidr(c: CidrCheck): string {
  return c.allOpen ? 'All Open: anyone on the internet (0.0.0.0/0)' : c.open ? `${c.cidr} (a whole range: open to everyone in it)` : c.cidr;
}

/** Inbound rules: one TCP rule per (CIDR, port). */
export function inboundRules(cidrs: readonly string[], tcpPorts: readonly number[]): CeFirewallRule[] {
  const out: CeFirewallRule[] = [];
  for (const cidr of cidrs) for (const p of tcpPorts) out.push({ protocol: 'tcp', portRange: { min: p, max: p }, remoteIpPrefix: cidr });
  return out;
}

export function ruleViews(rules: readonly CeFirewallRule[] | undefined): FirewallRuleView[] {
  return (rules ?? []).map((r) =>
    'portRange' in r
      ? { protocol: r.protocol, fromPort: r.portRange.min, toPort: r.portRange.max, cidr: r.remoteIpPrefix }
      : { protocol: r.protocol, fromPort: null, toPort: null, cidr: r.remoteIpPrefix },
  );
}

// ─── Saga ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type NetworkCe = Pick<
  CeApi,
  'listEips' | 'allocateEip' | 'associateEip' | 'disassociateEip' | 'releaseEip' | 'listFirewalls' | 'createFirewall' | 'associateFirewall' | 'disassociateFirewall' | 'updateFirewall' | 'deleteContainer' | 'getContainer' | 'deleteFirewall'
>;

export interface NetworkDeps {
  ce: NetworkCe;
  registry: Registry;
  journal: Journal;
  alarms: AlarmCenter;
  prices: PriceBook;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** How long the saga waits for `running` before it raises an alarm (§6.3 step 1). */
export const SAGA_RUNNING_CAP_MS = 20 * 60_000;
export const TEARDOWN = { pollMs: 5_000, capMs: 10 * 60_000 } as const;

const emptyNetwork = (): ComputeNetwork => ({ publicIp: null, eip: null, firewalls: [], ports: [], degraded: false });

async function setPlan(deps: NetworkDeps, rid: string, patch: Partial<NetworkPlan>): Promise<NetworkPlan | null> {
  const entry = deps.journal.get(rid);
  if (!entry?.network) return null;
  const plan = { ...entry.network, ...patch };
  await deps.journal.update(rid, { network: plan });
  return plan;
}

function raiseDegraded(deps: NetworkDeps, rec: ComputeRecord, eipUnattached: boolean, step: number, eipSku: string | null) {
  const eipUsdPerHour = eipUnattached && eipSku ? deps.prices.price(eipSku, rec.idc).usdPerHour : null;
  // An unattached EIP alarm is keyed by the EIP id (as the sweep's), so Release acts on it and one EIP is one alarm.
  const eipId = eipUnattached ? (deps.registry.get(rec.id)?.network?.eip?.id ?? rec.network?.eip?.id ?? null) : null;
  deps.alarms.raise({
    kind: eipUnattached ? 'eip_unattached' : 'api_unavailable',
    severity: 'warning',
    resourceId: eipId ?? rec.id,
    title: `Network setup for ${rec.displayName} did not finish`,
    body: eipUnattached
      ? 'GMI allocated a public IP but could not attach it. It bills until released. Release it, or delete the container.'
      : `Step ${step} of the public access setup failed. The container keeps running without it.`,
    usdPerHour: eipUsdPerHour,
    actions: eipUnattached ? ['release_eip', 'open', 'dismiss'] : ['open', 'dismiss'],
  });
}

/**
 * Runs (or resumes) the public-access saga of a running container. Never throws: a failure marks the network degraded
 * and raises an alarm. Returns the final plan state.
 */
export async function runNetworkSaga(deps: NetworkDeps, rid: string): Promise<NetworkPlan['state'] | null> {
  const log = deps.log.child('compute.network');
  const entry = deps.journal.get(rid);
  const plan = entry?.network;
  let rec = deps.registry.get(rid);
  if (!plan || plan.state !== 'pending' || !rec?.remoteId || rec.phase !== 'running') return plan?.state ?? null;
  const containerId = rec.remoteId;
  const idc = rec.idc ?? entry.idc ?? '';
  let step = plan.step;
  const saveNetwork = async (fn: (n: ComputeNetwork) => ComputeNetwork) => {
    rec = await deps.registry.update(rid, (r) => ({ ...r, network: fn(r.network ?? emptyNetwork()) }));
  };
  try {
    // 2: the EIP (checked by name first: a previous attempt may have allocated it).
    let eipId = rec.network?.eip?.managed ? rec.network.eip.id : null;
    if (step < 2 || !eipId) {
      const name = `${rec.name}-eip`;
      const existing = (await deps.ce.listEips()).find((e) => e.name === name);
      if (existing) eipId = existing.id;
      else {
        const out = await deps.ce.allocateEip({ idc, count: 1, name, product: plan.eipSku });
        if (out.outcome === 'confirmed') eipId = out.value;
        else {
          const again = (await deps.ce.listEips().catch(() => [])).find((e) => e.name === name);
          if (!again) throw out.error;
          eipId = again.id;
        }
      }
      const id = eipId;
      const eipPrice = deps.prices.price(plan.eipSku, idc).usdPerHour;
      const at = (deps.now ?? (() => new Date()))().toISOString();
      rec = await deps.registry.update(rid, (r) => openEipInterval({ ...r, network: { ...(r.network ?? emptyNetwork()), eip: { id, address: null, managed: true, status: 'disassociated' } } }, eipPrice, at));
      step = 2;
      await setPlan(deps, rid, { step });
    }
    // 3: associate (skipped when it already is).
    if (step < 3) {
      const eip = (await deps.ce.listEips()).find((e) => e.id === eipId);
      if (!eip) throw new GmiError('not_found', 'The public IP disappeared.');
      if (eip.instanceID !== containerId) {
        try {
          await deps.ce.associateEip(eip.id, { instanceID: containerId, instanceType: 'container' });
        } catch (error) {
          await saveNetwork((n) => ({ ...n, degraded: true }));
          await setPlan(deps, rid, { state: 'degraded', step });
          raiseDegraded(deps, rec as ComputeRecord, true, 3, plan.eipSku);
          log.warn('network saga failed', { rid, step: 3, code: error instanceof GmiError ? error.code : 'internal' });
          return 'degraded';
        }
      }
      await saveNetwork((n) => ({ ...n, publicIp: eip.ipAddress || n.publicIp, eip: n.eip ? { ...n.eip, address: eip.ipAddress || null, status: 'associated' } : n.eip }));
      step = 3;
      await setPlan(deps, rid, { step });
    }
    // 4: the firewall (checked by name first).
    let fw: CeFirewall | null = null;
    const fwName = `${rec.name}-fw`;
    if (step < 4) {
      fw = (await deps.ce.listFirewalls(idc)).find((f) => f.name === fwName) ?? null;
      if (!fw) {
        const out = await deps.ce.createFirewall({ idc, name: fwName, inboundRules: inboundRules(plan.cidrs, plan.tcpPorts) });
        if (out.outcome === 'confirmed') fw = out.value;
        else {
          fw = (await deps.ce.listFirewalls(idc).catch(() => [])).find((f) => f.name === fwName) ?? null;
          if (!fw) throw out.error;
        }
      }
      const created = fw;
      await saveNetwork((n) => ({
        ...n,
        firewalls: [...n.firewalls.filter((f) => f.id !== created.id), { id: created.id, name: created.name, managed: true, preset: created.isPreset === true, rules: ruleViews(created.inboundRules) }],
      }));
      step = 4;
      await setPlan(deps, rid, { step });
    }
    // 5: associate the firewall.
    if (step < 5) {
      fw ??= (await deps.ce.listFirewalls(idc)).find((f) => f.name === fwName) ?? null;
      if (!fw) throw new GmiError('not_found', 'The firewall disappeared.');
      if (!(fw.assoContainers ?? []).includes(containerId)) {
        await deps.ce.associateFirewall(fw.id, { instances: [containerId], instanceType: 'container' });
      }
      step = 5;
    }
    await setPlan(deps, rid, { step, state: 'done' });
    await saveNetwork((n) => ({ ...n, degraded: false }));
    deps.alarms.resolve('api_unavailable', rid);
    return 'done';
  } catch (error) {
    log.warn('network saga failed', { rid, step: step + 1, code: error instanceof GmiError ? error.code : 'internal' });
    await saveNetwork((n) => ({ ...n, degraded: true })).catch(() => undefined);
    await setPlan(deps, rid, { state: 'degraded', step }).catch(() => undefined);
    const eipUnattached = step === 2;
    raiseDegraded(deps, rec as ComputeRecord, eipUnattached, step + 1, plan.eipSku);
    return 'degraded';
  }
}

// ─── Teardown ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ignoreGone = (error: unknown) => {
  if (error instanceof GmiError && error.code === 'not_found') return;
  throw error;
};

/**
 * Deletes a managed container in the §6.3 order. Resolves once the DELETE was accepted; `settled` resolves when the
 * container is gone and the asked releases ran (the caller does not wait for it).
 */
export async function teardownContainer(
  deps: NetworkDeps,
  rec: ComputeRecord,
  opts: { releaseEip: boolean; deleteFirewall: boolean },
): Promise<{ settled: Promise<void> }> {
  const log = deps.log.child('compute.network');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const containerId = rec.remoteId;
  if (!containerId) throw new GmiError('invalid_input', 'This container has no GMI id yet.');
  const managedFirewalls = (rec.network?.firewalls ?? []).filter((f) => f.managed);
  const eip = rec.network?.eip ?? null;

  for (const fw of managedFirewalls) {
    await deps.ce.disassociateFirewall(fw.id, { instances: [containerId], instanceType: 'container' }).catch((error: unknown) => {
      log.warn('firewall disassociate failed (continuing)', { code: error instanceof GmiError ? error.code : 'internal' });
    });
  }
  if (eip?.managed && eip.status === 'associated') {
    await deps.ce.disassociateEip(eip.id, { instanceID: containerId, instanceType: 'container' }).catch((error: unknown) => {
      log.warn('EIP disassociate failed (continuing)', { code: error instanceof GmiError ? error.code : 'internal' });
    });
  }
  await deps.ce.deleteContainer(containerId).catch(ignoreGone);

  const settled = (async () => {
    const started = now().getTime();
    for (;;) {
      try {
        await deps.ce.getContainer(containerId);
      } catch (error) {
        if (error instanceof GmiError && error.code === 'not_found') break;
      }
      if (now().getTime() - started > TEARDOWN.capMs) {
        log.warn('container still listed after delete; releases skipped', { rid: rec.id });
        return;
      }
      await sleep(TEARDOWN.pollMs);
    }
    if (eip?.managed && opts.releaseEip) {
      try {
        await deps.ce.releaseEip(eip.id);
        await deps.registry.update(rec.id, (r) => closeEipInterval({ ...r, network: r.network ? { ...r.network, eip: r.network.eip ? { ...r.network.eip, status: 'released' } : null } : null }, now().toISOString())).catch(() => undefined);
      } catch (error) {
        log.warn('EIP release failed', { code: error instanceof GmiError ? error.code : 'internal' });
      }
    }
    if (opts.deleteFirewall) {
      for (const fw of managedFirewalls) {
        try {
          const current = (await deps.ce.listFirewalls(rec.idc)).find((f) => f.id === fw.id);
          if (!current) continue;
          if ((current.assoContainers ?? []).length || (current.assoInstances ?? []).length) continue;
          await deps.ce.deleteFirewall(fw.id);
        } catch (error) {
          log.warn('firewall delete failed', { code: error instanceof GmiError ? error.code : 'internal' });
        }
      }
    }
  })();
  return { settled };
}

/** Replaces the source CIDR of a managed firewall's rules (PUT keeps the name and ports). */
export async function replaceFirewallCidr(deps: Pick<NetworkDeps, 'ce' | 'registry'>, rec: ComputeRecord, cidr: string): Promise<ComputeRecord> {
  const managed = (rec.network?.firewalls ?? []).filter((f) => f.managed && !f.preset);
  if (managed.length === 0) throw new GmiError('invalid_input', 'This container has no firewall managed by GMI Desk.');
  const all = await deps.ce.listFirewalls(rec.idc);
  const updated: ComputeNetwork['firewalls'] = [];
  for (const fw of managed) {
    const current = all.find((f) => f.id === fw.id);
    if (!current) throw new GmiError('not_found', 'The firewall is gone from GMI.');
    const rules: CeFirewallRule[] = (current.inboundRules ?? []).map((r) => ({ ...r, remoteIpPrefix: cidr }));
    const deduped = rules.filter((r, i) => rules.findIndex((x) => JSON.stringify(x) === JSON.stringify(r)) === i);
    await deps.ce.updateFirewall(current.id, { name: current.name, ...(current.description ? { description: current.description } : {}), inboundRules: deduped });
    updated.push({ ...fw, rules: ruleViews(deduped) });
  }
  return deps.registry.update(rec.id, (r) => ({
    ...r,
    network: r.network ? { ...r.network, firewalls: r.network.firewalls.map((f) => updated.find((u) => u.id === f.id) ?? f) } : r.network,
  }));
}
