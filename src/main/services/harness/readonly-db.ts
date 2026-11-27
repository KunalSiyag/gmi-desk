/**
 * View-only fallback (harness.md §5.1, §17): while the host is `crashed` (or its database cannot be opened by it),
 * main opens `<userData>/data/harness/harness.sqlite` itself with node:sqlite `{readOnly: true}` and serves
 * listThreads, getThread and getTimeline. No writes, no runs. The host stays the only writer (§5.2).
 *
 * It reads the §5.2 schema and the frozen event convention of src/harness/types.ts: durable `item` events carry
 * `{type: 'item', item: TimelineItem}` as payload. Rows that do not validate are skipped, never forwarded.
 * node:sqlite is imported lazily, so main never loads it unless the fallback is used.
 */
import { access } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import {
  CODE_DEFAULTS,
  type CheckpointInfo,
  type CodeThread,
  type CodeThreadSettings,
  type CodeThreadSummary,
  type TimelineItem,
  type TodoItem,
  type TokenTotals,
} from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import { RUN_STATUSES, timelineItemSchema } from '@harness/protocol';

export interface ReadOnlyHarnessDb {
  listThreads(opts?: { projectId?: string; archived?: boolean }): CodeThreadSummary[];
  getThread(threadId: string): CodeThread;
  getTimeline(threadId: string, opts?: { afterSeq?: number; beforeSeq?: number; limit?: number }): { items: TimelineItem[]; hasMore: boolean; lastSeq: number };
  close(): void;
}

export const TIMELINE_PAGE = { default: 200, max: 1_000 } as const;

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function settingsOf(raw: unknown): CodeThreadSettings {
  const s = json<Partial<CodeThreadSettings>>(raw, {});
  return {
    runtime: s.runtime ?? 'gmi',
    model: s.model ?? '',
    subagentModel: s.subagentModel ?? null,
    compactionModel: s.compactionModel ?? null,
    sideTaskModel: s.sideTaskModel ?? null,
    mode: s.mode ?? CODE_DEFAULTS.mode,
    reasoningEffort: s.reasoningEffort ?? null,
    maxOutputTokens: s.maxOutputTokens ?? CODE_DEFAULTS.maxOutputTokens,
    economy: s.economy ?? false,
    maxContextTokens: s.maxContextTokens === undefined ? CODE_DEFAULTS.maxContextTokens : s.maxContextTokens,
    webFetch: s.webFetch ?? 'off',
    network: s.network ?? 'off',
    budget: s.budget ?? {
      perTurnUsd: CODE_DEFAULTS.perTurnUsd,
      perThreadUsd: CODE_DEFAULTS.perThreadUsd,
      maxStepsPerTurn: CODE_DEFAULTS.maxStepsPerTurn,
      maxTurnMinutes: CODE_DEFAULTS.maxTurnMinutes,
    },
    computerId: s.computerId ?? null,
  };
}

function tokensOf(raw: unknown): TokenTotals {
  const t = json<Partial<TokenTotals>>(raw, {});
  return { input: num(t.input), cached: num(t.cached), output: num(t.output), reasoning: num(t.reasoning) };
}

const STRATEGIES = ['worktree', 'existing_worktree', 'root'] as const;

export type SqliteLoader = () => Promise<{ DatabaseSync: typeof DatabaseSync }>;
const defaultLoader: SqliteLoader = () => import('node:sqlite');

/** Throws not_found when the file does not exist, internal when it cannot be opened. */
export async function openReadOnlyHarnessDb(file: string, loader: SqliteLoader = defaultLoader): Promise<ReadOnlyHarnessDb> {
  try {
    await access(file);
  } catch {
    throw new GmiError('not_found', 'There is no agent database yet.');
  }
  let db: DatabaseSync;
  try {
    const { DatabaseSync: Sqlite } = await loader();
    db = new Sqlite(file, { readOnly: true });
    db.exec('PRAGMA query_only = 1');
  } catch (error) {
    throw new GmiError('internal', 'The agent database cannot be opened.', { cause: error });
  }

  const all = (sql: string, ...params: Array<string | number>): Row[] => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, ...params: Array<string | number>): Row | undefined => db.prepare(sql).get(...params) as Row | undefined;

  const lastSeq = (threadId: string) => num(get('SELECT MAX(thread_seq) AS s FROM events WHERE thread_id = ?', threadId)?.s);
  const pendingApprovals = (threadId: string) => num(get('SELECT COUNT(*) AS n FROM approvals WHERE thread_id = ? AND decision IS NULL', threadId)?.n);

  const summaryOf = (r: Row): CodeThreadSummary => {
    const settings = settingsOf(r.settings);
    const id = str(r.id) ?? '';
    const status = RUN_STATUSES.find((s) => s === r.status) ?? 'idle';
    const strategy = STRATEGIES.find((s) => s === r.strategy) ?? 'worktree';
    return {
      id,
      projectId: str(r.project_id) ?? '',
      title: str(r.title) ?? '',
      strategy,
      branch: str(r.branch),
      worktreePath: str(r.worktree_path),
      status,
      statusReason: str(r.status_reason),
      pendingApprovals: pendingApprovals(id),
      queuePosition: null,
      queueReason: null,
      model: settings.model,
      mode: settings.mode,
      costUsd: num(r.cost_usd),
      tokens: tokensOf(r.tokens),
      diff: null,
      createdAt: str(r.created_at) ?? '',
      updatedAt: str(r.updated_at) ?? '',
      archived: num(r.archived) !== 0,
    };
  };

  return {
    listThreads(opts = {}) {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (opts.projectId !== undefined) {
        where.push('project_id = ?');
        params.push(opts.projectId);
      }
      if (opts.archived !== undefined) {
        where.push('archived = ?');
        params.push(opts.archived ? 1 : 0);
      }
      const sql = `SELECT * FROM threads${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
      return all(sql, ...params).map(summaryOf);
    },

    getThread(threadId) {
      const row = get('SELECT * FROM threads WHERE id = ?', threadId);
      if (!row) throw new GmiError('not_found', 'Thread not found.');
      const summary = summaryOf(row);
      const settings = settingsOf(row.settings);
      const checkpoints: CheckpointInfo[] = all('SELECT id, turn, created_at, files_changed FROM checkpoints WHERE thread_id = ? ORDER BY turn', threadId).map((c) => ({
        id: str(c.id) ?? '',
        turn: num(c.turn),
        createdAt: str(c.created_at) ?? '',
        filesChanged: num(c.files_changed),
      }));
      const todo = json<TodoItem[]>(get('SELECT items FROM todos WHERE context_id = ?', `ctx_${threadId}`)?.items, []);
      const window = settings.maxContextTokens ?? CODE_DEFAULTS.maxContextTokens;
      const messageCount = num(get('SELECT COUNT(*) AS n FROM messages WHERE context_id = ? AND in_context = 1', `ctx_${threadId}`)?.n);
      return {
        ...summary,
        settings,
        baseRef: str(row.base_ref),
        checkpoints,
        todo: Array.isArray(todo) ? todo : [],
        meter: {
          windowTokens: window,
          ceilingTokens: window,
          usedTokens: 0,
          reserveTokens: 0,
          cachedRatio: null,
          compactions: num(get('SELECT COUNT(*) AS n FROM compactions WHERE thread_id = ?', threadId)?.n),
          tierBoundaryTokens: null,
          messageCount,
          nextStepUsd: null,
          estimated: true,
        },
        lastSeq: lastSeq(threadId),
      };
    },

    getTimeline(threadId, opts = {}) {
      const limit = Math.max(1, Math.min(TIMELINE_PAGE.max, Math.floor(opts.limit ?? TIMELINE_PAGE.default)));
      let rows: Row[];
      let hasMore: boolean;
      if (opts.beforeSeq !== undefined) {
        rows = all("SELECT thread_seq, payload FROM events WHERE thread_id = ? AND type = 'item' AND thread_seq < ? ORDER BY thread_seq DESC LIMIT ?", threadId, opts.beforeSeq, limit + 1);
        rows.reverse();
        hasMore = rows.length > limit;
        if (hasMore) rows = rows.slice(1);
      } else {
        rows = all("SELECT thread_seq, payload FROM events WHERE thread_id = ? AND type = 'item' AND thread_seq > ? ORDER BY thread_seq ASC LIMIT ?", threadId, opts.afterSeq ?? 0, limit + 1);
        hasMore = rows.length > limit;
        if (hasMore) rows = rows.slice(0, limit);
      }
      // Later versions of an item (a tool going from running to succeeded) replace earlier ones, by id.
      const items = new Map<string, TimelineItem>();
      for (const r of rows) {
        const payload = json<{ item?: unknown }>(r.payload, {});
        const parsed = timelineItemSchema.safeParse(payload.item);
        if (!parsed.success) continue;
        const item = { ...parsed.data, seq: num(r.thread_seq) } as TimelineItem;
        items.delete(item.id);
        items.set(item.id, item);
      }
      return { items: [...items.values()], hasMore, lastSeq: lastSeq(threadId) };
    },

    close() {
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}
