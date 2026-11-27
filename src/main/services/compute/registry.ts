// The resource registry (compute.md §14 `registry.ts`; the `Registry` interface of types.ts). C1-C.
//
// `data/compute-resources.json`, written with `durableWriteFile` before every mutating call resolves: managed
// resources, leases, `actionPending`, in-flight execution ids, billing intervals, services and tombstones (kept 90
// days so accrual stays right). Never a secret: env values, tokens, the CE shell `urlPath` and registry credentials are
// not part of a record (the reader drops unknown fields, so nothing smuggled in survives a restart either).
import { join } from 'node:path';
import type { ComputeBackend, ComputeNetwork, ComputePhase, ComputerService, LeasePolicy } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../core/logger';
import { durableWriteFile, readJsonFile } from '../../core/store';
import { COMPUTE_DATA_FILES, COMPUTE_TIMING, type ActionPending, type BillingInterval, type ComputeRecord, type InflightExec, type Registry } from './types';

export const REGISTRY_VERSION = 1;
export const HISTORY_MAX = 50;

const PHASES: ReadonlySet<string> = new Set<ComputePhase>(['creating', 'running', 'busy', 'pausing', 'paused', 'resuming', 'deleting', 'deleted', 'failed', 'unknown']);
const LEASE_ACTIONS: ReadonlySet<string> = new Set(['delete', 'pause', 'notify']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function readLease(v: unknown): LeasePolicy | null {
  if (!isObj(v) || !LEASE_ACTIONS.has(String(v.onExpiry)) || !LEASE_ACTIONS.has(String(v.onBudget))) return null;
  return {
    maxLifetimeMin: num(v.maxLifetimeMin),
    onExpiry: v.onExpiry as LeasePolicy['onExpiry'],
    idlePauseMin: num(v.idlePauseMin),
    extendOnActivity: v.extendOnActivity === true,
    onBudget: v.onBudget as LeasePolicy['onBudget'],
  };
}

function readInterval(v: unknown): BillingInterval | null {
  if (!isObj(v) || !iso(v.from)) return null;
  return { from: v.from as string, to: iso(v.to), usdPerHour: num(v.usdPerHour) };
}

function readPending(v: unknown): ActionPending | null {
  if (!isObj(v) || !LEASE_ACTIONS.has(String(v.action)) || !iso(v.dueAt)) return null;
  return { action: v.action as ActionPending['action'], dueAt: v.dueAt as string, attempts: num(v.attempts) ?? 0, lastError: str(v.lastError) };
}

function readExec(v: unknown, resourceId: string): InflightExec | null {
  if (!isObj(v) || !str(v.eid) || !iso(v.startedAt)) return null;
  const origin = v.origin === 'app' || v.origin === 'agent' ? v.origin : 'user';
  return { eid: v.eid as string, resourceId, origin, grantId: str(v.grantId), timeoutSec: num(v.timeoutSec) ?? 0, startedAt: v.startedAt as string };
}

function readService(v: unknown): ComputerService | null {
  if (!isObj(v) || !str(v.name) || typeof v.command !== 'string' || !iso(v.startedAt)) return null;
  return { name: v.name as string, command: v.command, port: num(v.port), startedAt: v.startedAt as string };
}

function readNetwork(v: unknown): ComputeNetwork | null {
  if (!isObj(v)) return null;
  const eip = isObj(v.eip) && str(v.eip.id)
    ? {
        id: v.eip.id as string,
        address: str(v.eip.address),
        managed: v.eip.managed === true,
        status: (['associated', 'disassociated', 'released'].includes(String(v.eip.status)) ? v.eip.status : 'unknown') as NonNullable<ComputeNetwork['eip']>['status'],
      }
    : null;
  const firewalls = Array.isArray(v.firewalls)
    ? v.firewalls.flatMap((f) =>
        isObj(f) && str(f.id)
          ? [{
              id: f.id as string,
              name: str(f.name) ?? '',
              managed: f.managed === true,
              preset: f.preset === true,
              rules: Array.isArray(f.rules)
                ? f.rules.flatMap((r) =>
                    isObj(r) && typeof r.cidr === 'string' && ['tcp', 'udp', 'icmp', 'any'].includes(String(r.protocol))
                      ? [{ protocol: r.protocol as 'tcp', fromPort: num(r.fromPort), toPort: num(r.toPort), cidr: r.cidr }]
                      : [],
                  )
                : [],
            }]
          : [],
      )
    : [];
  const ports = Array.isArray(v.ports)
    ? v.ports.flatMap((p) => (isObj(p) && Number.isInteger(p.containerPort) ? [{ containerPort: p.containerPort as number, nodePort: num(p.nodePort), protocol: p.protocol === 'UDP' ? ('UDP' as const) : ('TCP' as const) }] : []))
    : [];
  return { publicIp: str(v.publicIp), eip, firewalls, ports, degraded: v.degraded === true };
}

/** One record from disk, or null when it is not usable. Unknown fields are dropped. */
export function readRecord(v: unknown): ComputeRecord | null {
  if (!isObj(v) || !str(v.id) || !str(v.name) || !PHASES.has(String(v.phase))) return null;
  const id = v.id as string;
  const backend: ComputeBackend = v.backend === 'sandbox_v2' ? 'sandbox_v2' : 'ce';
  return {
    id,
    kind: v.kind === 'sandbox' ? 'sandbox' : 'container',
    backend,
    remoteId: str(v.remoteId),
    name: v.name as string,
    displayName: str(v.displayName) ?? (v.name as string),
    managed: v.managed === true,
    installTag: str(v.installTag),
    purpose: v.purpose === 'agent' ? 'agent' : v.purpose === 'computer' ? 'computer' : null,
    threadId: str(v.threadId),
    idc: str(v.idc),
    sku: str(v.sku),
    templateId: str(v.templateId),
    templateName: str(v.templateName),
    snapshotId: str(v.snapshotId),
    listUsdPerHour: num(v.listUsdPerHour),
    phase: v.phase as ComputePhase,
    rawState: str(v.rawState),
    reason: str(v.reason),
    requestedAt: iso(v.requestedAt),
    createdAt: iso(v.createdAt),
    runningSince: iso(v.runningSince),
    serverEndsAt: iso(v.serverEndsAt),
    pausedAt: iso(v.pausedAt),
    pausedExpiresAt: iso(v.pausedExpiresAt),
    lastSeenAt: iso(v.lastSeenAt),
    lease: readLease(v.lease),
    approvedMaxLifetimeMin: num(v.approvedMaxLifetimeMin),
    leaseChangedAt: iso(v.leaseChangedAt),
    intervals: Array.isArray(v.intervals) ? v.intervals.map(readInterval).filter((x): x is BillingInterval => x !== null) : [],
    eipIntervals: Array.isArray(v.eipIntervals) ? v.eipIntervals.map(readInterval).filter((x): x is BillingInterval => x !== null) : [],
    actionPending: readPending(v.actionPending),
    inflightExecs: Array.isArray(v.inflightExecs) ? v.inflightExecs.map((e) => readExec(e, id)).filter((x): x is InflightExec => x !== null) : [],
    services: Array.isArray(v.services) ? v.services.map(readService).filter((x): x is ComputerService => x !== null) : [],
    network: readNetwork(v.network),
    logsRangeSupported: typeof v.logsRangeSupported === 'boolean' ? v.logsRangeSupported : null,
    envNames: strings(v.envNames),
    command: typeof v.command === 'string' ? v.command : null,
    args: strings(v.args),
    sshKeyNames: strings(v.sshKeyNames),
    secure: typeof v.secure === 'boolean' ? v.secure : null,
    egressLocked: typeof v.egressLocked === 'boolean' ? v.egressLocked : null,
    lastError: isObj(v.lastError) && typeof v.lastError.code === 'string' && typeof v.lastError.message === 'string'
      ? { code: v.lastError.code as never, message: v.lastError.message, detail: str(v.lastError.detail), status: num(v.lastError.status) }
      : null,
    history: Array.isArray(v.history)
      ? v.history.flatMap((h) => (isObj(h) && iso(h.at) && PHASES.has(String(h.phase)) ? [{ at: h.at as string, phase: h.phase as ComputePhase, note: str(h.note) }] : [])).slice(0, HISTORY_MAX)
      : [],
    tombstone: isObj(v.tombstone) && iso(v.tombstone.at) ? { at: v.tombstone.at as string, reason: str(v.tombstone.reason) ?? 'deleted' } : null,
    updatedAt: iso(v.updatedAt) ?? new Date(0).toISOString(),
  };
}

/** Closes every open interval at `at` (never before its start). */
export function closeIntervals(intervals: BillingInterval[], at: string): BillingInterval[] {
  const t = Date.parse(at);
  return intervals.map((i) => (i.to === null ? { ...i, to: new Date(Math.max(t, Date.parse(i.from))).toISOString() } : i));
}

const clone = <T>(v: T): T => structuredClone(v);

/** Default leases (§6.1, §7.1, D-defaults): containers 4 h then delete; computer sandboxes 8 h, idle pause 20 min. */
export function defaultLease(kind: 'container' | 'sandbox', purpose: 'computer' | 'agent' | null = 'computer'): LeasePolicy {
  if (kind === 'container') return { maxLifetimeMin: 240, onExpiry: 'delete', idlePauseMin: null, extendOnActivity: false, onBudget: 'notify' };
  if (purpose === 'agent') return { maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 10, extendOnActivity: true, onBudget: 'pause' };
  return { maxLifetimeMin: 480, onExpiry: 'pause', idlePauseMin: 20, extendOnActivity: true, onBudget: 'pause' };
}

/** A record with every optional field empty (callers fill in what they know). */
export function blankRecord(init: Pick<ComputeRecord, 'id' | 'kind' | 'backend' | 'name' | 'displayName' | 'managed'> & Partial<ComputeRecord>, at: string): ComputeRecord {
  return {
    remoteId: null,
    installTag: null,
    purpose: null,
    threadId: null,
    idc: null,
    sku: null,
    templateId: null,
    templateName: null,
    snapshotId: null,
    listUsdPerHour: null,
    phase: 'creating',
    rawState: null,
    reason: null,
    requestedAt: null,
    createdAt: null,
    runningSince: null,
    serverEndsAt: null,
    pausedAt: null,
    pausedExpiresAt: null,
    lastSeenAt: null,
    lease: null,
    approvedMaxLifetimeMin: null,
    leaseChangedAt: null,
    intervals: [],
    eipIntervals: [],
    actionPending: null,
    inflightExecs: [],
    services: [],
    network: null,
    logsRangeSupported: null,
    envNames: [],
    command: null,
    args: [],
    sshKeyNames: [],
    secure: null,
    egressLocked: null,
    lastError: null,
    history: [],
    tombstone: null,
    updatedAt: at,
    ...init,
  };
}

export function createRegistry(deps: { dataDir: string; log: Logger; now?: () => Date; write?: typeof durableWriteFile }): Registry {
  const file = join(deps.dataDir, COMPUTE_DATA_FILES.registry);
  const now = deps.now ?? (() => new Date());
  const write = deps.write ?? durableWriteFile;
  const log = deps.log.child('compute.registry');
  const records = new Map<string, ComputeRecord>();
  const listeners = new Set<(ids: string[]) => void>();
  let chain: Promise<void> = Promise.resolve();

  function persist(ids: string[]): Promise<void> {
    const data = JSON.stringify({ version: REGISTRY_VERSION, records: [...records.values()] });
    const next = chain.then(() => write(file, data, 0o600));
    chain = next.catch(() => undefined);
    return next.then(() => {
      for (const l of [...listeners]) {
        try {
          l(ids);
        } catch (error) {
          log.warn('registry listener failed', { error });
        }
      }
    });
  }

  function must(id: string): ComputeRecord {
    const r = records.get(id);
    if (!r) throw new GmiError('not_found', 'GMI Desk does not know this resource.');
    return r;
  }

  const registry: Registry = {
    async load() {
      records.clear();
      let raw: unknown = null;
      try {
        raw = await readJsonFile<unknown>(file);
      } catch (error) {
        log.error('compute registry unreadable; starting empty (the old file is kept)', { code: (error as NodeJS.ErrnoException).code ?? 'parse' });
        try {
          const { rename } = await import('node:fs/promises');
          await rename(file, `${file}.corrupt-${now().getTime()}`);
        } catch {
          // nothing to keep
        }
      }
      const list = isObj(raw) && Array.isArray(raw.records) ? raw.records : [];
      const cutoff = now().getTime() - COMPUTE_TIMING.tombstoneKeepMs;
      for (const item of list) {
        const r = readRecord(item);
        if (!r || records.has(r.id)) continue;
        if (r.tombstone && Date.parse(r.tombstone.at) < cutoff) continue;
        records.set(r.id, r);
      }
    },
    list(opts) {
      return [...records.values()].filter((r) => opts?.includeTombstones || !r.tombstone).map(clone);
    },
    get(id) {
      const r = records.get(id);
      return r ? clone(r) : null;
    },
    findByRemote(backend, remoteId) {
      for (const r of records.values()) if (r.backend === backend && r.remoteId === remoteId) return clone(r);
      return null;
    },
    findByName(name) {
      let found: ComputeRecord | null = null;
      for (const r of records.values()) {
        if (r.name !== name) continue;
        // A live record wins over a tombstone of the same name.
        if (!found || (found.tombstone && !r.tombstone)) found = r;
      }
      return found ? clone(found) : null;
    },
    async add(record) {
      if (records.has(record.id)) throw new GmiError('internal', 'Duplicate compute resource id.');
      const r = clone({ ...record, updatedAt: now().toISOString() });
      records.set(r.id, r);
      await persist([r.id]);
      return clone(r);
    },
    async update(id, mutate) {
      const current = must(id);
      const next = mutate(clone(current));
      if (next.id !== id) throw new GmiError('internal', 'A registry update cannot change the id.');
      next.history = next.history.slice(0, HISTORY_MAX);
      next.updatedAt = now().toISOString();
      records.set(id, clone(next));
      await persist([id]);
      return clone(next);
    },
    async tombstone(id, at, reason) {
      return registry.update(id, (r) => ({
        ...r,
        phase: 'deleted',
        intervals: closeIntervals(r.intervals, at),
        actionPending: null,
        inflightExecs: [],
        tombstone: r.tombstone ?? { at, reason },
        history: r.phase === 'deleted' ? r.history : [{ at, phase: 'deleted' as const, note: reason }, ...r.history],
      }));
    },
    async setActionPending(id, pending) {
      return registry.update(id, (r) => ({ ...r, actionPending: pending ? { ...pending } : null }));
    },
    inflightExecs(resourceId) {
      const out: InflightExec[] = [];
      for (const r of records.values()) if (!resourceId || r.id === resourceId) out.push(...r.inflightExecs.map(clone));
      return out;
    },
    async addInflightExec(exec) {
      const r = must(exec.resourceId);
      if (r.inflightExecs.some((e) => e.eid === exec.eid)) return;
      await registry.update(r.id, (cur) => ({ ...cur, inflightExecs: [...cur.inflightExecs, { ...exec }] }));
    },
    async removeInflightExec(eid) {
      for (const r of records.values()) {
        if (r.inflightExecs.some((e) => e.eid === eid)) {
          await registry.update(r.id, (cur) => ({ ...cur, inflightExecs: cur.inflightExecs.filter((e) => e.eid !== eid) }));
          return;
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: () => chain,
  };
  return registry;
}
