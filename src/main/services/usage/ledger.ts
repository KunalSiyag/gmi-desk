import { randomUUID } from 'node:crypto';
import { LOCAL_SPEND_MAX_ENTRIES, type LocalSpend, type SpendEntry, type SpendKind } from '@shared/contracts/usage';
import type { Logger } from '../../core/logger';
import { openJsonStore } from '../../core/store';
import { DAY_MS, fileExists, isRecord, nonEmptyString, roundUsd } from './util';

/** Local spend is kept this long (covers the 90-day view and the current month). */
export const LEDGER_RETENTION_DAYS = 120;
/** Safety valve so a very chatty install never grows the file without bound. */
export const LEDGER_MAX_ENTRIES = 20_000;

export interface SpendInput {
  kind: SpendKind;
  modelId: string;
  usd: number;
  ref?: string | null;
}

/** A seed entry for mock mode (written once, on first run). */
export type SeedEntry = SpendInput & { at: string };

/** Every kind has its own bucket: compute and agent spend never count as media. */
export const SPEND_KINDS: readonly SpendKind[] = ['chat', 'media', 'compute', 'agent'];
const KINDS: ReadonlySet<string> = new Set<SpendKind>(SPEND_KINDS);

function cleanModelId(value: unknown): string {
  return (nonEmptyString(value) ?? 'unknown').slice(0, 200);
}

function cleanRef(value: unknown): string | null {
  const ref = nonEmptyString(value);
  return ref ? ref.slice(0, 300) : null;
}

function validEntry(raw: unknown): SpendEntry | null {
  if (!isRecord(raw)) return null;
  const { id, at, kind, usd } = raw;
  if (typeof id !== 'string' || !id || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  return { id, at: new Date(at).toISOString(), kind: kind as SpendKind, modelId: cleanModelId(raw.modelId), usd, ref: cleanRef(raw.ref) };
}

/** Drops entries older than the retention window and caps the count (oldest go first). */
export function trimLedger(entries: SpendEntry[], now: Date): SpendEntry[] {
  const cutoff = now.getTime() - LEDGER_RETENTION_DAYS * DAY_MS;
  const kept = entries.filter((e) => Date.parse(e.at) >= cutoff);
  return kept.length > LEDGER_MAX_ENTRIES ? kept.slice(kept.length - LEDGER_MAX_ENTRIES) : kept;
}

/** Validates a ledger read from disk, oldest first, trimmed. Invalid rows are dropped. */
export function normalizeLedger(raw: unknown, now: Date): SpendEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw.map(validEntry).filter((e): e is SpendEntry => e !== null);
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return trimLedger(entries, now);
}

export interface SpendTotals {
  chat: number;
  media: number;
  compute: number;
  agent: number;
  /** Every kind. */
  total: number;
}

/** Sums entries at or after `from` (ms) into per-kind buckets, rounded. */
function sumByKind(entries: readonly SpendEntry[], from: number): SpendTotals {
  const sums: Record<SpendKind, number> = { chat: 0, media: 0, compute: 0, agent: 0 };
  for (const e of entries) {
    if (Date.parse(e.at) < from) continue;
    sums[e.kind] += e.usd;
  }
  const total = sums.chat + sums.media + sums.compute + sums.agent;
  return { chat: roundUsd(sums.chat), media: roundUsd(sums.media), compute: roundUsd(sums.compute), agent: roundUsd(sums.agent), total: roundUsd(total) };
}

export interface SpendLedger {
  readonly path: string;
  all(): readonly SpendEntry[];
  /** Appends one spend. Ignores non-positive or non-finite amounts (returns null). */
  append(input: SpendInput): Promise<SpendEntry | null>;
  totalsSince(since: Date): SpendTotals;
  /** Rolling window of `days` × 24 h ending now. */
  localSpend(days: number): LocalSpend;
  flush(): Promise<void>;
}

export async function openSpendLedger(
  path: string,
  opts: { now: () => Date; log?: Logger; seed?: (now: Date) => SeedEntry[] },
): Promise<SpendLedger> {
  const firstRun = !(await fileExists(path));
  const store = await openJsonStore<SpendEntry[]>(path, [], {
    log: opts.log,
    normalize: (raw) => normalizeLedger(raw, opts.now()),
  });

  if (firstRun && opts.seed) {
    const seeded = opts.seed(opts.now()).map((s) =>
      validEntry({ id: randomUUID(), at: s.at, kind: s.kind, modelId: s.modelId, usd: s.usd, ref: s.ref ?? null }),
    );
    await store.set(normalizeLedger(seeded.filter(Boolean), opts.now()));
  }

  const totalsSince = (since: Date): SpendTotals => sumByKind(store.get(), since.getTime());

  return {
    path,
    all: () => store.get(),
    async append(input) {
      const usd = typeof input?.usd === 'number' ? input.usd : Number.NaN;
      if (!Number.isFinite(usd) || usd <= 0) return null;
      if (!KINDS.has(input.kind)) return null;
      const now = opts.now();
      const entry: SpendEntry = {
        id: randomUUID(),
        at: now.toISOString(),
        kind: input.kind,
        modelId: cleanModelId(input.modelId),
        usd,
        ref: cleanRef(input.ref),
      };
      // The store applies updates in memory synchronously and serialises the disk writes.
      await store.update((entries) => trimLedger([...entries, entry], now));
      return entry;
    },
    totalsSince,
    localSpend(days) {
      const now = opts.now();
      const from = now.getTime() - days * DAY_MS;
      const inWindow = store.get().filter((e) => Date.parse(e.at) >= from);
      const byModel = new Map<string, { modelId: string; kind: SpendKind; usd: number; count: number }>();
      const totals = sumByKind(inWindow, from);
      for (const e of inWindow) {
        const key = `${e.kind}\u0000${e.modelId}`;
        const row = byModel.get(key) ?? { modelId: e.modelId, kind: e.kind, usd: 0, count: 0 };
        row.usd += e.usd;
        row.count += 1;
        byModel.set(key, row);
      }
      const newestFirst = [...inWindow].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return {
        days,
        chatUsd: totals.chat,
        mediaUsd: totals.media,
        computeUsd: totals.compute,
        agentUsd: totals.agent,
        byModel: [...byModel.values()]
          .map((row) => ({ ...row, usd: roundUsd(row.usd) }))
          .sort((a, b) => b.usd - a.usd || a.modelId.localeCompare(b.modelId)),
        entries: newestFirst.slice(0, LOCAL_SPEND_MAX_ENTRIES),
        entryCount: inWindow.length,
      };
    },
    flush: () => store.flush(),
  };
}
