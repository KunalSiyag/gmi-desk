/**
 * Projections of the event log (harness.md §5.2, §6.6, §13.1). `events` is the source of truth; these are derived:
 *
 * - **Thread status** (`threads.status`, `status_reason`) mirrors the latest durable `status` event.
 * - **Todos** (`todos` row per context) mirror the latest `todo` event of that context.
 *   Both are updated incrementally by `events.append` in the same transaction (`projectEvent`) and can be rebuilt
 *   from the log (`rebuildProjections`); the two must agree (test/harness/store/projections.test.ts).
 * - **Timeline**: `item` events folded by item id; the latest version replaces earlier ones and takes their seq.
 *   `TimelineFold` applies events one by one (what the renderer does with live events); `timelinePage` pages the
 *   log exactly like main's view-only fallback (readonly-db.ts), so both serve the same `getTimeline`.
 * - **Summary / thread view** (`CodeThreadSummary`, `CodeThread`): the thread row plus pending approvals, the latest
 *   `diff` event, checkpoints and the main context's todos.
 */
import { CODE_DEFAULTS, type CodeThread, type ContextMeter, type RunStatus, type TimelineItem } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import { RUN_STATUSES, timelineItemSchema } from '../protocol';
import { contextIdOf, type SqlValue, type StoredEvent } from '../types';
import type { SqliteDb } from './db';
import type { SqliteStore } from './store';

type Row = Record<string, SqlValue>;

/** Same paging limits as main's view-only fallback. */
export const TIMELINE_PAGE = { default: 200, max: 1_000 } as const;

export interface TimelinePage {
  items: TimelineItem[];
  hasMore: boolean;
  lastSeq: number;
}

const isRunStatus = (v: unknown): v is RunStatus => typeof v === 'string' && (RUN_STATUSES as readonly string[]).includes(v);

function parse(v: SqlValue | undefined): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

const num = (v: SqlValue | undefined): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

// ─── Incremental (called by events.append inside its transaction) ─────────────────────────────────────────────

function applyStatus(db: SqliteDb, threadId: string, payload: unknown): void {
  const p = (payload ?? {}) as { status?: unknown; reason?: unknown };
  if (!isRunStatus(p.status)) return;
  db.prepare('UPDATE threads SET status = ?, status_reason = ? WHERE id = ?').run(p.status, typeof p.reason === 'string' ? p.reason : null, threadId);
}

function applyTodo(db: SqliteDb, threadId: string, contextId: string, payload: unknown, at: string): void {
  const p = (payload ?? {}) as { todo?: unknown };
  if (!Array.isArray(p.todo)) return;
  db.prepare(
    `INSERT INTO todos (context_id, thread_id, items, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(context_id) DO UPDATE SET thread_id = excluded.thread_id, items = excluded.items, updated_at = excluded.updated_at`,
  ).run(contextId, threadId, JSON.stringify(p.todo), at);
}

/** Keeps the projected columns in step with one appended event (same transaction as the insert). */
export function projectEvent(db: SqliteDb, event: StoredEvent): void {
  if (event.type === 'status') applyStatus(db, event.threadId, event.payload);
  else if (event.type === 'todo') applyTodo(db, event.threadId, event.contextId, event.payload, event.at);
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Recomputes the projected columns of one thread (or all) from the log. Threads without a `status` event keep
 * their status; contexts without a `todo` event keep their todos (written directly with `todos.put`).
 */
export function rebuildProjections(db: SqliteDb, threadId?: string): number {
  const ids =
    threadId === undefined
      ? db.prepare('SELECT id FROM threads ORDER BY rowid').all<Row>().map((r) => String(r.id))
      : db.prepare('SELECT id FROM threads WHERE id = ?').all<Row>(threadId).map((r) => String(r.id));
  db.transaction(() => {
    for (const id of ids) {
      const status = db.prepare("SELECT payload FROM events WHERE thread_id = ? AND type = 'status' ORDER BY thread_seq DESC LIMIT 1").get<Row>(id);
      if (status) applyStatus(db, id, parse(status.payload));
      const todos = db
        .prepare(
          `SELECT e.context_id, e.payload, e.at FROM events e
           WHERE e.thread_id = ?1 AND e.type = 'todo' AND e.thread_seq = (
             SELECT MAX(x.thread_seq) FROM events x WHERE x.thread_id = ?1 AND x.type = 'todo' AND x.context_id = e.context_id)`,
        )
        .all<Row>(id);
      for (const t of todos) applyTodo(db, id, String(t.context_id), parse(t.payload), String(t.at));
    }
  });
  return ids.length;
}

// ─── Timeline ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Folds `item` events by id, in log order: the latest version replaces earlier ones (and moves to its seq). */
export class TimelineFold {
  private readonly byId = new Map<string, TimelineItem>();
  private last = 0;

  /** Applies one durable event (other types only advance `lastSeq`). Invalid items are skipped, as in the fallback. */
  apply(event: Pick<StoredEvent, 'type' | 'payload' | 'seq'>): void {
    this.last = Math.max(this.last, event.seq);
    if (event.type !== 'item') return;
    const parsed = timelineItemSchema.safeParse((event.payload as { item?: unknown } | null)?.item);
    if (!parsed.success) return;
    const item = { ...parsed.data, seq: event.seq } as TimelineItem;
    this.byId.delete(item.id);
    this.byId.set(item.id, item);
  }

  items(): TimelineItem[] {
    return [...this.byId.values()];
  }

  lastSeq(): number {
    return this.last;
  }
}

export function foldTimeline(events: Iterable<Pick<StoredEvent, 'type' | 'payload' | 'seq'>>): TimelineItem[] {
  const fold = new TimelineFold();
  for (const e of events) fold.apply(e);
  return fold.items();
}

/** `getTimeline` paging: `afterSeq` forward, or `beforeSeq` backward; folding happens within the page. */
export function timelinePage(db: SqliteDb, threadId: string, opts: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): TimelinePage {
  const limit = Math.max(1, Math.min(TIMELINE_PAGE.max, Math.floor(opts.limit ?? TIMELINE_PAGE.default)));
  let rows: Row[];
  let hasMore: boolean;
  if (opts.beforeSeq !== undefined) {
    rows = db
      .prepare("SELECT thread_seq, type, payload FROM events WHERE thread_id = ? AND type = 'item' AND thread_seq < ? ORDER BY thread_seq DESC LIMIT ?")
      .all<Row>(threadId, opts.beforeSeq, limit + 1);
    rows.reverse();
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(1);
  } else {
    rows = db
      .prepare("SELECT thread_seq, type, payload FROM events WHERE thread_id = ? AND type = 'item' AND thread_seq > ? ORDER BY thread_seq ASC LIMIT ?")
      .all<Row>(threadId, opts.afterSeq ?? 0, limit + 1);
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
  }
  const items = foldTimeline(rows.map((r) => ({ type: 'item' as const, payload: parse(r.payload), seq: num(r.thread_seq) })));
  const lastSeq = num(db.prepare('SELECT MAX(thread_seq) AS s FROM events WHERE thread_id = ?').get<Row>(threadId)?.s);
  return { items, hasMore, lastSeq };
}

// ─── Thread view ──────────────────────────────────────────────────────────────────────────────────────────────

/** `getThread`. Without a live meter from the loop, the estimate the view-only fallback shows. */
export function threadView(store: SqliteStore, threadId: string, meter?: ContextMeter): CodeThread {
  const summary = store.projections.summary(threadId);
  const row = store.threads.get(threadId);
  if (!summary || !row) throw new GmiError('not_found', 'Thread not found.');
  const ctx = contextIdOf(threadId);
  const window = row.settings.maxContextTokens ?? CODE_DEFAULTS.maxContextTokens;
  const compactions = num(store.db.prepare('SELECT COUNT(*) AS n FROM compactions WHERE thread_id = ?').get<Row>(threadId)?.n);
  const messageCount = num(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE context_id = ? AND in_context = 1').get<Row>(ctx)?.n);
  return {
    ...summary,
    settings: row.settings,
    baseRef: row.baseRef,
    checkpoints: store.checkpoints.list(threadId).map((c) => ({ id: c.id, turn: c.turn, createdAt: c.createdAt, filesChanged: c.filesChanged })),
    todo: store.todos.get(ctx),
    meter: meter ?? {
      windowTokens: window,
      ceilingTokens: window,
      usedTokens: 0,
      reserveTokens: 0,
      cachedRatio: null,
      compactions,
      tierBoundaryTokens: null,
      messageCount,
      nextStepUsd: null,
      estimated: true,
    },
    lastSeq: store.events.lastSeq(threadId),
  };
}
