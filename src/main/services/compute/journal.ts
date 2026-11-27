// The write-ahead create journal (compute.md §6.2, §10, §14 `journal.ts`). C1-C.
//
// `data/compute-journal.json`, written with `durableWriteFile` (write, fsync, rename, fsync the directory) before any
// call resolves. An `intent` entry is on disk before any network I/O; `sent` is on disk before the POST starts.
//
//   intent → sent → confirmed | failed | unknown → (reconcile) confirmed | failed_unknown → (every sweep) confirmed | dismissed
//
// Unresolved entries (intent, sent, unknown, failed_unknown) are never pruned and never dropped by the 200-entry cap.
// Only confirmed, failed and dismissed entries are pruned, after 7 days. Secret values never reach the journal: it
// holds names, ids, the SKU and the public-access plan (CIDRs the user typed and ports), nothing else.
import { join } from 'node:path';
import type { ComputeBackend, ComputeKind } from '@shared/contracts/compute';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../core/logger';
import { durableWriteFile, readJsonFile } from '../../core/store';
import { COMPUTE_DATA_FILES } from './types';

export type JournalState = 'intent' | 'sent' | 'confirmed' | 'failed' | 'unknown' | 'failed_unknown' | 'dismissed';
export const UNRESOLVED_STATES: ReadonlySet<JournalState> = new Set(['intent', 'sent', 'unknown', 'failed_unknown']);
const PRUNABLE_STATES: ReadonlySet<JournalState> = new Set(['confirmed', 'failed', 'dismissed']);
const ALL_STATES: ReadonlySet<string> = new Set<JournalState>(['intent', 'sent', 'confirmed', 'failed', 'unknown', 'failed_unknown', 'dismissed']);

export const JOURNAL_LIMITS = { maxEntries: 200, pruneAfterMs: 7 * 24 * 60 * 60_000 } as const;

/** Public access to set up once the container runs (§6.3). Persisted so the saga survives a restart. */
export interface NetworkPlan {
  cidrs: string[];
  tcpPorts: number[];
  eipSku: string;
  /** pending → done | degraded (a step failed; see the alarm). */
  state: 'pending' | 'done' | 'degraded';
  /** Last step that finished (2 EIP allocated, 3 EIP associated, 4 firewall created, 5 firewall associated). */
  step: number;
}

export interface JournalEntry {
  /** The app resource id (`cr_…`; the v2 Idempotency-Key). */
  rid: string;
  state: JournalState;
  kind: ComputeKind;
  backend: ComputeBackend;
  /** Remote name (containers are reconciled by it). */
  name: string;
  displayName: string;
  idc: string | null;
  sku: string;
  /** When the intent was written. */
  at: string;
  updatedAt: string;
  remoteId: string | null;
  /** Error code of the last outcome (never a message with GMI text). */
  error: string | null;
  network: NetworkPlan | null;
}

interface JournalFile {
  version: 1;
  entries: JournalEntry[];
}

export interface Journal {
  load(): Promise<void>;
  list(): JournalEntry[];
  get(rid: string): JournalEntry | null;
  unresolved(): JournalEntry[];
  /** Writes a new `intent` entry (durable before it resolves). */
  append(entry: Omit<JournalEntry, 'state' | 'updatedAt' | 'remoteId' | 'error'> & { state?: 'intent' }): Promise<JournalEntry>;
  /** Moves an entry on (durable before it resolves). */
  update(rid: string, patch: Partial<Omit<JournalEntry, 'rid' | 'at'>>): Promise<JournalEntry>;
  flush(): Promise<void>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function readPlan(v: unknown): NetworkPlan | null {
  if (!isObj(v) || !Array.isArray(v.cidrs) || !Array.isArray(v.tcpPorts) || typeof v.eipSku !== 'string') return null;
  return {
    cidrs: v.cidrs.filter((c): c is string => typeof c === 'string'),
    tcpPorts: v.tcpPorts.filter((p): p is number => Number.isInteger(p)),
    eipSku: v.eipSku,
    state: v.state === 'done' || v.state === 'degraded' ? v.state : 'pending',
    step: typeof v.step === 'number' ? v.step : 1,
  };
}

/** Defensive read: malformed entries are dropped, never the file. */
export function readJournal(raw: unknown): JournalEntry[] {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return [];
  const out: JournalEntry[] = [];
  for (const e of raw.entries) {
    if (!isObj(e) || !str(e.rid) || !ALL_STATES.has(String(e.state)) || !str(e.name) || !str(e.sku) || !str(e.at)) continue;
    out.push({
      rid: e.rid as string,
      state: e.state as JournalState,
      kind: e.kind === 'sandbox' ? 'sandbox' : 'container',
      backend: e.backend === 'sandbox_v2' ? 'sandbox_v2' : 'ce',
      name: e.name as string,
      displayName: str(e.displayName) ?? (e.name as string),
      idc: str(e.idc),
      sku: e.sku as string,
      at: e.at as string,
      updatedAt: str(e.updatedAt) ?? (e.at as string),
      remoteId: str(e.remoteId),
      error: str(e.error),
      network: readPlan(e.network),
    });
  }
  return out;
}

/** Drops resolved entries older than 7 days, then the oldest resolved ones above the cap. Never an unresolved one. */
export function pruneJournal(entries: JournalEntry[], now: number): JournalEntry[] {
  let kept = entries.filter((e) => !(PRUNABLE_STATES.has(e.state) && now - Date.parse(e.updatedAt) > JOURNAL_LIMITS.pruneAfterMs));
  if (kept.length > JOURNAL_LIMITS.maxEntries) {
    const resolved = kept.filter((e) => PRUNABLE_STATES.has(e.state)).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const excess = kept.length - JOURNAL_LIMITS.maxEntries;
    const drop = new Set(resolved.slice(0, excess).map((e) => e.rid));
    kept = kept.filter((e) => !drop.has(e.rid));
  }
  return kept;
}

export function createJournal(deps: { dataDir: string; log: Logger; now?: () => Date; write?: typeof durableWriteFile }): Journal {
  const file = join(deps.dataDir, COMPUTE_DATA_FILES.journal);
  const now = deps.now ?? (() => new Date());
  const write = deps.write ?? durableWriteFile;
  const log = deps.log.child('compute.journal');
  let entries: JournalEntry[] = [];
  let chain: Promise<void> = Promise.resolve();

  /** Serialised durable write of the current state; resolves (or rejects) once this snapshot is on disk. */
  function persist(): Promise<void> {
    entries = pruneJournal(entries, now().getTime());
    const data = JSON.stringify({ version: 1, entries } satisfies JournalFile);
    const next = chain.then(() => write(file, data, 0o600));
    chain = next.catch(() => undefined);
    return next;
  }

  const find = (rid: string) => entries.find((e) => e.rid === rid) ?? null;

  return {
    async load() {
      try {
        entries = readJournal(await readJsonFile<unknown>(file));
      } catch (error) {
        // A corrupt journal must not be silently replaced: unresolved creates may be in it. Keep the file aside.
        log.error('compute journal unreadable; starting empty (the old file is kept)', { code: (error as NodeJS.ErrnoException).code ?? 'parse' });
        entries = [];
        try {
          const { rename } = await import('node:fs/promises');
          await rename(file, `${file}.corrupt-${now().getTime()}`);
        } catch {
          // nothing to keep
        }
      }
    },
    list: () => entries.map((e) => ({ ...e })),
    get: (rid) => {
      const e = find(rid);
      return e ? { ...e } : null;
    },
    unresolved: () => entries.filter((e) => UNRESOLVED_STATES.has(e.state)).map((e) => ({ ...e })),
    async append(input) {
      if (find(input.rid)) throw new GmiError('internal', 'Duplicate create journal entry.');
      const at = now().toISOString();
      const entry: JournalEntry = { ...input, state: 'intent', updatedAt: at, remoteId: null, error: null };
      entries.push(entry);
      await persist();
      log.info('create.journal', { rid: entry.rid, state: entry.state });
      return { ...entry };
    },
    async update(rid, patch) {
      const e = find(rid);
      if (!e) throw new GmiError('not_found', 'Unknown create journal entry.');
      Object.assign(e, patch, { updatedAt: now().toISOString() });
      await persist();
      if (patch.state) log.info('create.journal', { rid, state: patch.state });
      return { ...e };
    },
    flush: () => chain,
  };
}
