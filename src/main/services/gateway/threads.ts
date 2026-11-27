/**
 * The persisted thread ledger (harness.md §4.3–4.4): per-thread and per-turn agent spend and the thread caps, in
 * `data/gateway-threads.json`, written with durableWriteFile after every change (coalesced) and on quit.
 *
 * - Spend counts at once: add() updates the thread and turn totals and the unflushed part synchronously, and the
 *   unflushed part is the `SpendSource` the budget sums (kind 'agent').
 * - Unflushed spend becomes ledger rows (kind 'agent', ref `thr:<id>/turn:<n>`, one per model) when the turn
 *   settles, when a turn's unflushed spend reaches $0.10, or 60 s after its first unflushed charge, whichever comes
 *   first. The rows and the drop of the unflushed amount happen in the same tick (BudgetGuard.record appends to the
 *   spend ledger's memory synchronously), so the budget never counts the spend twice or misses it.
 * - Unflushed spend is persisted too: after a crash it is reported again and flushed at the next start. (If main
 *   died after writing the rows but before this file, those rows would count twice: the safe direction.)
 * - Caps: a thread never seen has the CODE_DEFAULTS caps. Host caps only tighten, field by field; approveCaps()
 *   (after the code slice's native dialog) stores them as given.
 */
import { join } from 'node:path';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { Logger } from '../../core/logger';
import type { BudgetGuard, SpendSource, ThreadCaps } from '../../core/services';
import { durableWriteFile, readJsonFile, type DurableFs } from '../../core/store';
import { GATEWAY_LIMITS, type GatewayClock, type GatewayTimer, type ThreadCapsRecord, type ThreadLedger, type ThreadSpendCharge } from './types';

export const THREAD_LEDGER_FILE = 'gateway-threads.json';
const FILE_VERSION = 1;
/** Turn key for spend without a turn id. */
const NO_TURN = '-';
/** Burn rate window. */
const HOUR_MS = 3_600_000;

interface Bucket {
  /** USD per model. */
  byModel: Record<string, number>;
  firstAt: number;
  lastAt: number;
}

interface ThreadRecord {
  spentUsd: number;
  turns: Record<string, number>;
  caps: ThreadCaps;
  capsApprovedAt: string | null;
  /** Unflushed spend per turn key. */
  unflushed: Record<string, Bucket>;
  updatedAt: string;
}

interface LedgerFile {
  version: number;
  threads: Record<string, ThreadRecord>;
}

export interface ThreadLedgerDeps {
  /** `<userData>/data` (the file is `<dataDir>/gateway-threads.json`). */
  dataDir: string;
  budget: Pick<BudgetGuard, 'record'>;
  clock: GatewayClock;
  log?: Logger;
  /** Tests: a fake fs for durableWriteFile. */
  fs?: DurableFs;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const money = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const capValue = (v: unknown): number | null | undefined => (v === null ? null : money(v) ?? undefined);

function defaultCaps(): ThreadCaps {
  return { perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: CODE_DEFAULTS.perThreadUsd };
}

/** A thread record read from disk; invalid fields fall back (spend to 0, caps to the defaults). */
function normalizeThread(raw: unknown, nowIso: string): ThreadRecord | null {
  if (!isRecord(raw)) return null;
  const turns: Record<string, number> = {};
  if (isRecord(raw.turns)) for (const [k, v] of Object.entries(raw.turns)) if (money(v) !== null) turns[k] = v as number;
  const caps = defaultCaps();
  if (isRecord(raw.caps)) {
    const t = capValue(raw.caps.perTurnUsd);
    const th = capValue(raw.caps.perThreadUsd);
    if (t !== undefined) caps.perTurnUsd = t;
    if (th !== undefined) caps.perThreadUsd = th;
  }
  const unflushed: Record<string, Bucket> = {};
  if (isRecord(raw.unflushed)) {
    for (const [turn, b] of Object.entries(raw.unflushed)) {
      if (!isRecord(b) || !isRecord(b.byModel)) continue;
      const byModel: Record<string, number> = {};
      for (const [m, v] of Object.entries(b.byModel)) if (money(v)) byModel[m] = v as number;
      if (Object.keys(byModel).length === 0) continue;
      const firstAt = typeof b.firstAt === 'number' && Number.isFinite(b.firstAt) ? b.firstAt : 0;
      const lastAt = typeof b.lastAt === 'number' && Number.isFinite(b.lastAt) ? b.lastAt : firstAt;
      unflushed[turn] = { byModel, firstAt, lastAt };
    }
  }
  return {
    spentUsd: money(raw.spentUsd) ?? 0,
    turns,
    caps,
    capsApprovedAt: typeof raw.capsApprovedAt === 'string' ? raw.capsApprovedAt : null,
    unflushed,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso,
  };
}

function validCaps(caps: ThreadCaps): ThreadCaps {
  if (!isRecord(caps)) throw new GmiError('invalid_input', 'Thread caps must be an object.');
  const out: Partial<ThreadCaps> = {};
  for (const key of ['perTurnUsd', 'perThreadUsd'] as const) {
    const v = capValue(caps[key]);
    if (v === undefined) throw new GmiError('invalid_input', 'A cost cap must be empty (no cap) or an amount of $0 or more.');
    out[key] = v;
  }
  return out as ThreadCaps;
}

export function createThreadLedger(deps: ThreadLedgerDeps): ThreadLedger {
  const { budget, clock, log } = deps;
  const path = join(deps.dataDir, THREAD_LEDGER_FILE);
  const threads = new Map<string, ThreadRecord>();
  /** (at, usd) of recent charges for the burn rate. */
  const recent: Array<{ at: number; usd: number }> = [];
  let loaded = false;
  let loading: Promise<void> | null = null;
  let disposed = false;
  let flushTimer: GatewayTimer | null = null;
  let flushTimerAt = 0;
  /** Durable writes: one at a time; a change while writing schedules exactly one more. */
  let writing: Promise<void> | null = null;
  let dirty = false;
  /** Ledger rows still being appended (awaited by flush()). */
  const pendingRecords = new Set<Promise<void>>();

  const nowIso = () => new Date(clock.now()).toISOString();

  const thread = (id: string): ThreadRecord => {
    let t = threads.get(id);
    if (!t) {
      t = { spentUsd: 0, turns: {}, caps: defaultCaps(), capsApprovedAt: null, unflushed: {}, updatedAt: nowIso() };
      threads.set(id, t);
    }
    return t;
  };

  const capsRecord = (t: ThreadRecord | undefined): ThreadCapsRecord => {
    const caps = t?.caps ?? defaultCaps();
    return { perTurnUsd: caps.perTurnUsd, perThreadUsd: caps.perThreadUsd, approvedAt: t?.capsApprovedAt ?? null };
  };

  const serialize = (): string => {
    const file: LedgerFile = { version: FILE_VERSION, threads: Object.fromEntries(threads) };
    return `${JSON.stringify(file)}\n`;
  };

  const writeLoop = async (): Promise<void> => {
    while (dirty) {
      dirty = false;
      try {
        // A flushed bucket leaves the file only after its ledger rows are on disk: otherwise a crash between the
        // two writes would lose that spend (it is in neither file).
        while (pendingRecords.size > 0) await Promise.all([...pendingRecords]);
        await durableWriteFile(path, serialize(), undefined, deps.fs);
      } catch (error) {
        log?.error('gateway: could not write the thread ledger', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  const persist = (): Promise<void> => {
    dirty = true;
    // Never write before the file was read: that would replace the stored spend and caps.
    if (!loaded) return Promise.resolve();
    if (!writing) {
      writing = writeLoop().finally(() => {
        writing = null;
      });
    }
    return writing;
  };

  /** Ledger rows for one turn's unflushed spend (one per model); synchronous for the budget's view. */
  const flushBucket = (threadId: string, turnKey: string): boolean => {
    const t = threads.get(threadId);
    const bucket = t?.unflushed[turnKey];
    if (!t || !bucket) return false;
    delete t.unflushed[turnKey];
    for (const [modelId, usd] of Object.entries(bucket.byModel)) {
      if (!(usd > 0)) continue;
      const p = budget
        .record({ kind: 'agent', modelId, usd, ref: `thr:${threadId}/turn:${turnKey}` })
        .catch((error: unknown) => {
          log?.error('gateway: could not record agent spend', { threadId, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => pendingRecords.delete(p));
      pendingRecords.add(p);
    }
    return true;
  };

  const unflushedTotal = (since: number): number => {
    let sum = 0;
    for (const t of threads.values()) {
      for (const b of Object.values(t.unflushed)) {
        // A bucket spans at most ~60 s; counting it whole when it reaches into the period errs on the safe side.
        if (b.lastAt < since) continue;
        for (const usd of Object.values(b.byModel)) sum += usd;
      }
    }
    return sum;
  };

  const armFlushTimer = () => {
    if (disposed) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const t of threads.values()) for (const b of Object.values(t.unflushed)) earliest = Math.min(earliest, b.firstAt);
    if (!Number.isFinite(earliest)) {
      if (flushTimer !== null) clock.clearTimeout(flushTimer);
      flushTimer = null;
      return;
    }
    const at = earliest + GATEWAY_LIMITS.agentFlushMs;
    if (flushTimer !== null && flushTimerAt <= at) return;
    if (flushTimer !== null) clock.clearTimeout(flushTimer);
    flushTimerAt = at;
    flushTimer = clock.setTimeout(onFlushTimer, Math.max(0, at - clock.now()));
  };

  function onFlushTimer(): void {
    flushTimer = null;
    const now = clock.now();
    let flushed = false;
    for (const [id, t] of threads) {
      for (const [turn, b] of Object.entries(t.unflushed)) if (now - b.firstAt >= GATEWAY_LIMITS.agentFlushMs) flushed = flushBucket(id, turn) || flushed;
    }
    if (flushed) void persist();
    armFlushTimer();
  }

  const source: SpendSource = {
    kind: 'agent',
    totalSince: (since) => unflushedTotal(since.getTime()),
    burnUsdPerHour() {
      const now = clock.now();
      while (recent.length > 0 && now - recent[0]!.at > HOUR_MS) recent.shift();
      return recent.reduce((a, r) => a + r.usd, 0);
    },
  };

  const load = async (): Promise<void> => {
    let raw: unknown = null;
    try {
      raw = await readJsonFile<unknown>(path);
    } catch (error) {
      log?.error('gateway: the thread ledger was unreadable; thread spend starts from zero', { error: error instanceof Error ? error.message : String(error) });
      raw = null;
    }
    const iso = nowIso();
    if (isRecord(raw) && isRecord(raw.threads)) {
      for (const [id, value] of Object.entries(raw.threads)) {
        const loadedThread = normalizeThread(value, iso);
        if (!loadedThread) continue;
        const current = threads.get(id);
        if (!current) {
          threads.set(id, loadedThread);
          continue;
        }
        // Spend added before load() finished: keep both (never lose spend); caps: the tighter of each.
        const tighter = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
        current.caps = { perTurnUsd: tighter(current.caps.perTurnUsd, loadedThread.caps.perTurnUsd), perThreadUsd: tighter(current.caps.perThreadUsd, loadedThread.caps.perThreadUsd) };
        current.spentUsd += loadedThread.spentUsd;
        for (const [turn, usd] of Object.entries(loadedThread.turns)) current.turns[turn] = (current.turns[turn] ?? 0) + usd;
        for (const [turn, b] of Object.entries(loadedThread.unflushed)) if (!current.unflushed[turn]) current.unflushed[turn] = b;
      }
    }
    loaded = true;
    // Spend a crash left unflushed: into the ledger now (it was reported by the source until this point).
    for (const [id, t] of threads) for (const turn of Object.keys(t.unflushed)) if (flushBucket(id, turn)) dirty = true;
    if (dirty) await persist();
    armFlushTimer();
  };

  const flush = async (): Promise<void> => {
    for (const [id, t] of threads) for (const turn of Object.keys(t.unflushed)) flushBucket(id, turn);
    armFlushTimer();
    await persist();
    await Promise.all([...pendingRecords]);
  };

  return {
    load() {
      if (loaded) return Promise.resolve();
      loading ??= load();
      return loading;
    },

    spend(threadId, turnId) {
      const t = threads.get(threadId);
      if (!t) return { turnUsd: 0, threadUsd: 0 };
      return { threadUsd: t.spentUsd, turnUsd: turnId ? (t.turns[turnId] ?? 0) : 0 };
    },

    caps: (threadId) => capsRecord(threads.get(threadId)),

    setCaps(threadId, caps) {
      const proposed = validCaps(caps);
      const t = thread(threadId);
      const tighter = (stored: number | null, next: number | null) => (next !== null && (stored === null || next < stored) ? next : stored);
      const next = { perTurnUsd: tighter(t.caps.perTurnUsd, proposed.perTurnUsd), perThreadUsd: tighter(t.caps.perThreadUsd, proposed.perThreadUsd) };
      if (next.perTurnUsd !== t.caps.perTurnUsd || next.perThreadUsd !== t.caps.perThreadUsd) {
        t.caps = next;
        t.updatedAt = nowIso();
        void persist();
      }
      return capsRecord(t);
    },

    approveCaps(threadId, caps) {
      const approved = validCaps(caps);
      const t = thread(threadId);
      t.caps = approved;
      t.capsApprovedAt = nowIso();
      t.updatedAt = t.capsApprovedAt;
      void persist();
      return capsRecord(t);
    },

    add(charge: ThreadSpendCharge) {
      const usd = money(charge.usd);
      if (!usd || typeof charge.threadId !== 'string' || !charge.threadId) return;
      const at = Number.isFinite(charge.at) && charge.at > 0 ? charge.at : clock.now();
      const t = thread(charge.threadId);
      const turnKey = charge.turnId ?? NO_TURN;
      t.spentUsd += usd;
      t.turns[turnKey] = (t.turns[turnKey] ?? 0) + usd;
      t.updatedAt = nowIso();
      const bucket = (t.unflushed[turnKey] ??= { byModel: {}, firstAt: at, lastAt: at });
      const modelId = charge.modelId || 'unknown';
      bucket.byModel[modelId] = (bucket.byModel[modelId] ?? 0) + usd;
      bucket.lastAt = Math.max(bucket.lastAt, at);
      recent.push({ at, usd });
      let total = 0;
      for (const v of Object.values(bucket.byModel)) total += v;
      if (total >= GATEWAY_LIMITS.agentFlushUsd - 1e-12) flushBucket(charge.threadId, turnKey);
      void persist();
      armFlushTimer();
    },

    settleTurn(threadId, turnId) {
      if (flushBucket(threadId, turnId)) {
        void persist();
        armFlushTimer();
      }
    },

    source,

    flush,

    async dispose() {
      if (loading) await loading.catch(() => undefined);
      await flush();
      disposed = true;
      if (flushTimer !== null) clock.clearTimeout(flushTimer);
      flushTimer = null;
    },
  };
}
