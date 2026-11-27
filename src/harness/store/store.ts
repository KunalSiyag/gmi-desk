/**
 * The SQLite implementation of the frozen `Store` (src/harness/types.ts; harness.md §5.2). The host is the only
 * writer; main opens the same file read-only for the view-only fallback (readonly-db.ts), which reads these tables.
 *
 * Semantics follow the conforming fake (`memoryStore` in test/harness/fakes.ts), plus what only a database can do:
 * - `events.append` assigns the thread's contiguous `thread_seq` in the same transaction as the insert (§6.6), and in
 *   that transaction also maintains the projections (projections.ts): `threads.status/status_reason` from `status`
 *   events and the `todos` row from `todo` events. `projections.rebuild()` recomputes them from the log.
 * - Transactions roll back (nested calls are savepoints).
 * - `threads.delete` removes every row of the thread, including its subagent contexts' reads.
 * - `projects.remove` removes the project's threads with it (threads.project_id is a foreign key).
 */
import { chmodSync, closeSync, openSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CODE_DEFAULTS, type CodeThread, type CodeThreadSummary, type ContextMeter, type DiffStat, type PermissionRule, type TodoItem } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { GwToolCall } from '@shared/contracts/gateway';
import {
  newId,
  type ApprovalRow,
  type CheckpointRow,
  type CompactionRow,
  type DurableEventType,
  type HostLog,
  type McpServerRow,
  type MessageRow,
  type ProjectRow,
  type ReadRow,
  type SqlValue,
  type Store,
  type StoredEvent,
  type ThreadRow,
  type ToolCallRow,
  type TrustedFileRow,
  type UsageStepRow,
} from '../types';
import { sqlite, type SqliteDb } from './db';
import { readUserVersion } from './migrate';
import { projectEvent, rebuildProjections, threadView, timelinePage, type TimelinePage } from './projections';

type Row = Record<string, SqlValue>;

export interface StoreClock {
  now(): number;
}

/** The SQLite store: the frozen `Store` plus what the host runtime needs beyond it (projections, receipts upkeep, WAL). */
export interface SqliteStore extends Store {
  readonly file: string;
  readonly db: SqliteDb;
  receipts: Store['receipts'] & {
    /** Drops receipts older than `olderThanMs` (a replay only follows a restart). Returns the number removed. */
    prune(olderThanMs: number): number;
  };
  projections: {
    /** Recomputes the projected columns (status, todos) from the event log; returns the threads rebuilt. */
    rebuild(threadId?: string): number;
    /** `getTimeline` (§13.1): the same paging and folding as main's view-only fallback. */
    timeline(threadId: string, opts?: { afterSeq?: number; beforeSeq?: number; limit?: number }): TimelinePage;
    /** One summary (null when the thread does not exist). */
    summary(threadId: string): CodeThreadSummary | null;
    /** `getThread` (§13.1). Without `meter`, an estimated one (as the view-only fallback shows). */
    thread(threadId: string, meter?: ContextMeter): CodeThread;
  };
  /** `PRAGMA wal_checkpoint(TRUNCATE)` (shutdown, §5.1). */
  checkpointWal(): void;
  /** `PRAGMA quick_check`: 'ok' or the first problem. */
  quickCheck(): string;
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────────────────────────────────────

const bool = (v: boolean): number => (v ? 1 : 0);
const json = (v: unknown): string => JSON.stringify(v === undefined ? null : v);
const jsonOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const s = (v: SqlValue | undefined): string | null => (typeof v === 'string' ? v : null);
const n = (v: SqlValue | undefined): number | null => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null);
const n0 = (v: SqlValue | undefined): number => n(v) ?? 0;
const parse = <T>(v: SqlValue | undefined, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** Field → column, for the dynamic `update(patch)` methods. Values are encoded by `enc`. */
type ColumnMap<R> = { [K in keyof R]?: [column: string, enc?: (v: R[K]) => SqlValue] };

function setClause<R>(map: ColumnMap<R>, patch: Partial<R>): { sql: string[]; params: SqlValue[] } {
  const sql: string[] = [];
  const params: SqlValue[] = [];
  for (const key of Object.keys(patch) as Array<keyof R>) {
    const value = patch[key];
    const spec = map[key];
    if (!spec || value === undefined) continue;
    const [column, enc] = spec;
    sql.push(`${column} = ?`);
    params.push(enc ? enc(value as R[typeof key]) : ((value ?? null) as SqlValue));
  }
  return { sql, params };
}

// ─── Row mappers ──────────────────────────────────────────────────────────────────────────────────────────────

const projectFrom = (r: Row): ProjectRow => ({
  id: s(r.id) ?? '',
  rootPath: s(r.root_path) ?? '',
  name: s(r.name) ?? '',
  defaultBranch: s(r.default_branch),
  worktreeDir: s(r.worktree_dir) ?? '',
  setupCommand: s(r.setup_command),
  trustState: (s(r.trust_state) ?? 'untrusted') as ProjectRow['trustState'],
  trustHash: s(r.trust_hash),
  trustedAt: s(r.trusted_at),
  refFormat: s(r.ref_format) === 'reftable' ? 'reftable' : 'files',
  addedAt: s(r.added_at) ?? '',
});

const THREAD_COLUMNS: ColumnMap<ThreadRow> = {
  title: ['title'],
  strategy: ['strategy'],
  branch: ['branch'],
  baseRef: ['base_ref'],
  baseSha: ['base_sha'],
  worktreePath: ['worktree_path'],
  gitDir: ['git_dir'],
  commonDir: ['common_dir'],
  gitPointer: ['git_pointer'],
  objectDir: ['object_dir'],
  setupState: ['setup_state'],
  settings: ['settings', json],
  status: ['status'],
  statusReason: ['status_reason'],
  costUsd: ['cost_usd'],
  tokens: ['tokens', json],
  archived: ['archived', bool],
  instructionsHash: ['instructions_hash'],
  envBlock: ['env_block'],
  updatedAt: ['updated_at'],
};

const threadFrom = (r: Row): ThreadRow => ({
  id: s(r.id) ?? '',
  projectId: s(r.project_id) ?? '',
  title: s(r.title) ?? '',
  strategy: (s(r.strategy) ?? 'worktree') as ThreadRow['strategy'],
  branch: s(r.branch),
  baseRef: s(r.base_ref),
  baseSha: s(r.base_sha),
  worktreePath: s(r.worktree_path),
  gitDir: s(r.git_dir),
  commonDir: s(r.common_dir),
  gitPointer: s(r.git_pointer),
  objectDir: s(r.object_dir),
  setupState: (s(r.setup_state) ?? 'ready') as ThreadRow['setupState'],
  settings: parse(r.settings, {} as ThreadRow['settings']),
  status: (s(r.status) ?? 'idle') as ThreadRow['status'],
  statusReason: s(r.status_reason),
  costUsd: n0(r.cost_usd),
  tokens: parse(r.tokens, { input: 0, cached: 0, output: 0, reasoning: 0 }),
  archived: n0(r.archived) !== 0,
  instructionsHash: s(r.instructions_hash),
  envBlock: s(r.env_block),
  createdAt: s(r.created_at) ?? '',
  updatedAt: s(r.updated_at) ?? '',
});

const messageFrom = (r: Row): MessageRow => {
  const row: MessageRow = {
    id: s(r.id) ?? '',
    threadId: s(r.thread_id) ?? '',
    contextId: s(r.context_id) ?? '',
    ord: n0(r.ord),
    turn: n(r.turn),
    role: (s(r.role) ?? 'user') as MessageRow['role'],
    content: s(r.content) ?? '',
    toolCalls: parse<GwToolCall[] | null>(r.tool_calls, null),
    toolCallId: s(r.tool_call_id),
    reasoning: s(r.reasoning),
    reasoningFamily: s(r.reasoning_family),
    model: s(r.model),
    inContext: n0(r.in_context) !== 0,
    pinned: n0(r.pinned) !== 0,
    partial: n0(r.partial) !== 0,
    estTokens: n(r.est_tokens),
  };
  if (n0(r.steering) !== 0) row.steering = true;
  return row;
};

const TOOL_CALL_COLUMNS: ColumnMap<ToolCallRow> = {
  providerCallId: ['provider_call_id'],
  runId: ['run_id'],
  turn: ['turn'],
  step: ['step'],
  tool: ['tool'],
  args: ['args'],
  status: ['status'],
  resultMessageId: ['result_message_id'],
  spillPath: ['spill_path'],
  exitCode: ['exit_code'],
  startedAt: ['started_at'],
  finishedAt: ['finished_at'],
};

const toolCallFrom = (r: Row): ToolCallRow => ({
  id: s(r.id) ?? '',
  wireId: s(r.wire_id) ?? '',
  providerCallId: s(r.provider_call_id),
  threadId: s(r.thread_id) ?? '',
  contextId: s(r.context_id) ?? '',
  runId: s(r.run_id),
  turn: n(r.turn),
  step: n(r.step),
  tool: s(r.tool) ?? '',
  args: s(r.args) ?? '',
  status: (s(r.status) ?? 'started') as ToolCallRow['status'],
  resultMessageId: s(r.result_message_id),
  spillPath: s(r.spill_path),
  exitCode: n(r.exit_code),
  startedAt: s(r.started_at),
  finishedAt: s(r.finished_at),
});

const approvalFrom = (r: Row): ApprovalRow => ({
  requestId: s(r.request_id) ?? '',
  threadId: s(r.thread_id) ?? '',
  runId: s(r.run_id) ?? '',
  toolCallId: s(r.tool_call_id),
  kind: (s(r.kind) ?? 'other') as ApprovalRow['kind'],
  request: parse(r.request, {} as ApprovalRow['request']),
  decision: parse(r.decision, null),
  decidedAt: s(r.decided_at),
});

const ruleFrom = (r: Row): PermissionRule => ({
  id: s(r.id) ?? '',
  tool: s(r.tool) ?? '',
  pattern: s(r.pattern),
  effect: s(r.effect) === 'allow' ? 'allow' : 'deny',
  scope: (s(r.scope) ?? 'thread') as PermissionRule['scope'],
  projectId: s(r.project_id),
  threadId: s(r.thread_id),
  source: (s(r.source) ?? 'user') as PermissionRule['source'],
  createdAt: s(r.created_at) ?? '',
});

const checkpointFrom = (r: Row): CheckpointRow => ({
  id: s(r.id) ?? '',
  threadId: s(r.thread_id) ?? '',
  turn: n0(r.turn),
  commitSha: s(r.commit_sha) ?? '',
  treeSha: s(r.tree_sha) ?? '',
  filesChanged: n0(r.files_changed),
  createdAt: s(r.created_at) ?? '',
});

const compactionFrom = (r: Row): CompactionRow => ({
  id: s(r.id) ?? '',
  threadId: s(r.thread_id) ?? '',
  contextId: s(r.context_id) ?? '',
  uptoOrd: n0(r.upto_ord),
  summary: s(r.summary) ?? '',
  model: s(r.model) ?? '',
  beforeTokens: n0(r.before_tokens),
  afterTokens: n0(r.after_tokens),
  costUsd: n(r.cost_usd),
  createdAt: s(r.created_at) ?? '',
});

const readFrom = (r: Row): ReadRow => ({
  contextId: s(r.context_id) ?? '',
  path: s(r.path) ?? '',
  sha: s(r.sha) ?? '',
  ranges: parse<Array<[number, number]>>(r.ranges, []),
  size: n(r.size),
  mtimeMs: n(r.mtime_ms),
  ord: n(r.ord),
});

const usageFrom = (r: Row): UsageStepRow => ({
  threadId: s(r.thread_id) ?? '',
  contextId: s(r.context_id) ?? '',
  runId: s(r.run_id),
  turn: n(r.turn),
  step: n(r.step),
  model: s(r.model) ?? '',
  prompt: n0(r.prompt),
  cached: n0(r.cached),
  expectedCached: n(r.expected_cached),
  completion: n0(r.completion),
  reasoning: n0(r.reasoning),
  costUsd: n(r.cost_usd),
  estimated: n0(r.estimated) !== 0,
  prefixHash: s(r.prefix_hash),
  at: s(r.at) ?? '',
});

const mcpFrom = (r: Row): McpServerRow => ({
  id: s(r.id) ?? '',
  scope: s(r.scope) === 'project' ? 'project' : 'global',
  projectId: s(r.project_id),
  config: parse<unknown>(r.config, null),
  trustHash: s(r.trust_hash),
  toolHashes: parse<Record<string, string> | null>(r.tool_hashes, null),
  resolvedVersion: s(r.resolved_version),
  enabled: n0(r.enabled) !== 0,
});

export const eventFrom = (r: Row): StoredEvent => ({
  threadId: s(r.thread_id) ?? '',
  contextId: s(r.context_id) ?? '',
  runId: s(r.run_id),
  turn: n(r.turn),
  step: n(r.step),
  type: (s(r.type) ?? 'notice') as DurableEventType,
  payload: parse<unknown>(r.payload, null),
  seq: n0(r.thread_seq),
  eventId: s(r.event_id) ?? '',
  at: s(r.at) ?? '',
});

// ─── The store ────────────────────────────────────────────────────────────────────────────────────────────────

const EVENT_COLUMNS = 'thread_id, context_id, run_id, turn, step, type, payload, thread_seq, event_id, at';

/** Wraps an open, migrated database (index.ts `openStore` opens and migrates it). */
export function createSqliteStore(db: SqliteDb, deps: { clock: StoreClock; log?: HostLog }): SqliteStore {
  const { clock } = deps;
  const iso = () => new Date(clock.now()).toISOString();
  const schemaVersion = readUserVersion(db);
  let closed = false;

  const one = (sql: string, ...params: SqlValue[]) => db.prepare(sql).get<Row>(...params);
  const many = (sql: string, ...params: SqlValue[]) => db.prepare(sql).all<Row>(...params);
  const run = (sql: string, ...params: SqlValue[]) => db.prepare(sql).run(...params);
  const tx = <T>(fn: () => T): T => db.transaction(fn);

  const lastSeq = (threadId: string) => n0(one('SELECT MAX(thread_seq) AS s FROM events WHERE thread_id = ?', threadId)?.s);
  const lastOrd = (contextId: string) => n0(one('SELECT MAX(ord) AS o FROM messages WHERE context_id = ?', contextId)?.o);

  const insertMessage = (row: Omit<MessageRow, 'ord' | 'partial'>, ord: number, partial: boolean) => {
    run(
      `INSERT INTO messages (id, thread_id, context_id, ord, turn, role, content, tool_calls, tool_call_id, reasoning,
         reasoning_family, model, in_context, pinned, partial, est_tokens, steering)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.threadId,
      row.contextId,
      ord,
      row.turn ?? null,
      row.role,
      row.content,
      jsonOrNull(row.toolCalls),
      row.toolCallId ?? null,
      row.reasoning ?? null,
      row.reasoningFamily ?? null,
      row.model ?? null,
      bool(row.inContext),
      bool(row.pinned),
      bool(partial),
      row.estTokens ?? null,
      bool(row.steering === true),
    );
  };

  const overwriteMessage = (id: string, row: Omit<MessageRow, 'id' | 'ord' | 'partial'>, partial: boolean) => {
    run(
      `UPDATE messages SET thread_id = ?, context_id = ?, turn = ?, role = ?, content = ?, tool_calls = ?, tool_call_id = ?,
         reasoning = ?, reasoning_family = ?, model = ?, in_context = ?, pinned = ?, partial = ?, est_tokens = ?, steering = ?
       WHERE id = ?`,
      row.threadId,
      row.contextId,
      row.turn ?? null,
      row.role,
      row.content,
      jsonOrNull(row.toolCalls),
      row.toolCallId ?? null,
      row.reasoning ?? null,
      row.reasoningFamily ?? null,
      row.model ?? null,
      bool(row.inContext),
      bool(row.pinned),
      bool(partial),
      row.estTokens ?? null,
      bool(row.steering === true),
      id,
    );
  };

  const getMessage = (id: string): MessageRow => {
    const r = one('SELECT * FROM messages WHERE id = ?', id);
    if (!r) throw new GmiError('not_found', 'Message not found.');
    return messageFrom(r);
  };

  const deleteThreadRows = (id: string) => {
    // Contexts of the thread (main + subagents): reads carry no thread id.
    run(
      `DELETE FROM reads WHERE context_id IN (
         SELECT context_id FROM events WHERE thread_id = ?1
         UNION SELECT context_id FROM messages WHERE thread_id = ?1
         UNION SELECT context_id FROM tool_calls WHERE thread_id = ?1
         UNION SELECT context_id FROM todos WHERE thread_id = ?1
         UNION SELECT context_id FROM usage_steps WHERE thread_id = ?1
         UNION SELECT context_id FROM compactions WHERE thread_id = ?1
         UNION SELECT 'ctx_' || ?1)`,
      id,
    );
    for (const table of ['events', 'messages', 'tool_calls', 'approvals', 'checkpoints', 'compactions', 'usage_steps', 'todos', 'ref_snapshots', 'sensitive_hashes', 'git_procs', 'permission_rules']) {
      run(`DELETE FROM ${table} WHERE thread_id = ?`, id);
    }
    run('DELETE FROM threads WHERE id = ?', id);
  };

  const summaryFrom = (r: Row): CodeThreadSummary => {
    const t = threadFrom(r);
    const diff = parse<{ diff?: DiffStat } | null>(r.diff_payload, null)?.diff ?? null;
    return {
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      strategy: t.strategy,
      branch: t.branch,
      worktreePath: t.worktreePath,
      status: t.status,
      statusReason: t.statusReason,
      pendingApprovals: n0(r.pending_approvals),
      queuePosition: null,
      queueReason: null,
      model: t.settings?.model ?? '',
      mode: t.settings?.mode ?? CODE_DEFAULTS.mode,
      costUsd: t.costUsd,
      tokens: t.tokens,
      diff: diff && typeof diff.files === 'number' ? diff : null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      archived: t.archived,
    };
  };

  const SUMMARY_SELECT = `SELECT t.*,
      (SELECT COUNT(*) FROM approvals a WHERE a.thread_id = t.id AND a.decision IS NULL) AS pending_approvals,
      (SELECT e.payload FROM events e WHERE e.thread_id = t.id AND e.type = 'diff' ORDER BY e.thread_seq DESC LIMIT 1) AS diff_payload
    FROM threads t`;

  const threadFilter = (opts: { projectId?: string; archived?: boolean }, alias = '') => {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (opts.projectId !== undefined) {
      where.push(`${alias}project_id = ?`);
      params.push(opts.projectId);
    }
    if (opts.archived !== undefined) {
      where.push(`${alias}archived = ?`);
      params.push(bool(opts.archived));
    }
    return { where: where.length ? ` WHERE ${where.join(' AND ')}` : '', params };
  };

  const store: SqliteStore = {
    file: db.file,
    db,
    schemaVersion,
    transaction: tx,

    events: {
      append(input) {
        return tx(() => {
          const seq = lastSeq(input.threadId) + 1;
          const eventId = input.eventId ?? newId('ev', clock.now());
          const at = iso();
          const payload = json(input.payload);
          run(
            `INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            input.threadId,
            input.contextId,
            input.runId ?? null,
            input.turn ?? null,
            input.step ?? null,
            input.type,
            payload,
            seq,
            eventId,
            at,
          );
          const event: StoredEvent = {
            threadId: input.threadId,
            contextId: input.contextId,
            runId: input.runId ?? null,
            turn: input.turn ?? null,
            step: input.step ?? null,
            type: input.type,
            payload: JSON.parse(payload) as unknown,
            seq,
            eventId,
            at,
          };
          projectEvent(db, event);
          return event;
        });
      },
      list(threadId, opts = {}) {
        if (opts.types && opts.types.length === 0) return [];
        const where = ['thread_id = ?', 'thread_seq > ?'];
        const params: SqlValue[] = [threadId, opts.afterSeq ?? 0];
        if (opts.beforeSeq !== undefined) {
          where.push('thread_seq < ?');
          params.push(opts.beforeSeq);
        }
        if (opts.types) {
          where.push(`type IN (${opts.types.map(() => '?').join(', ')})`);
          params.push(...opts.types);
        }
        let sql = `SELECT ${EVENT_COLUMNS} FROM events WHERE ${where.join(' AND ')} ORDER BY thread_seq`;
        if (opts.limit !== undefined) {
          sql += ' LIMIT ?';
          params.push(Math.max(0, Math.floor(opts.limit)));
        }
        return many(sql, ...params).map(eventFrom);
      },
      byRun: (runId) => many(`SELECT ${EVENT_COLUMNS} FROM events WHERE run_id = ? ORDER BY seq`, runId).map(eventFrom),
      lastSeq,
    },

    receipts: {
      get(commandId) {
        const r = one('SELECT thread_id, at, result FROM command_receipts WHERE command_id = ?', commandId);
        if (!r) return null;
        return { threadId: s(r.thread_id), at: s(r.at) ?? '', result: parse<unknown>(r.result, null) };
      },
      put(commandId, threadId, result) {
        // The first receipt wins: a replay never overwrites the stored result.
        run('INSERT OR IGNORE INTO command_receipts (command_id, thread_id, at, result) VALUES (?, ?, ?, ?)', commandId, threadId, iso(), json(result));
      },
      prune(olderThanMs) {
        const cutoff = new Date(clock.now() - Math.max(0, olderThanMs)).toISOString();
        return Number(run('DELETE FROM command_receipts WHERE at < ?', cutoff).changes);
      },
    },

    projects: {
      get: (id) => {
        const r = one('SELECT * FROM projects WHERE id = ?', id);
        return r ? projectFrom(r) : null;
      },
      list: () => many('SELECT * FROM projects ORDER BY rowid').map(projectFrom),
      upsert(p) {
        run(
          `INSERT INTO projects (id, root_path, name, default_branch, worktree_dir, setup_command, trust_state, trust_hash, trusted_at, ref_format, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, name = excluded.name, default_branch = excluded.default_branch,
             worktree_dir = excluded.worktree_dir, setup_command = excluded.setup_command, trust_state = excluded.trust_state,
             trust_hash = excluded.trust_hash, trusted_at = excluded.trusted_at, ref_format = excluded.ref_format, added_at = excluded.added_at`,
          p.id,
          p.rootPath,
          p.name,
          p.defaultBranch ?? null,
          p.worktreeDir,
          p.setupCommand ?? null,
          p.trustState,
          p.trustHash ?? null,
          p.trustedAt ?? null,
          p.refFormat,
          p.addedAt,
        );
      },
      remove(id) {
        tx(() => {
          for (const r of many('SELECT id FROM threads WHERE project_id = ?', id)) deleteThreadRows(s(r.id) ?? '');
          run('DELETE FROM trusted_files WHERE project_id = ?', id);
          run('DELETE FROM mcp_servers WHERE project_id = ?', id);
          run('DELETE FROM permission_rules WHERE project_id = ?', id);
          run('DELETE FROM projects WHERE id = ?', id);
        });
      },
    },

    trustedFiles: {
      list: (projectId) => many('SELECT * FROM trusted_files WHERE project_id = ? ORDER BY rowid', projectId).map(trustedFrom),
      get: (projectId, path) => {
        const r = one('SELECT * FROM trusted_files WHERE project_id = ? AND path = ?', projectId, path);
        return r ? trustedFrom(r) : null;
      },
      replace(projectId, files) {
        tx(() => {
          run('DELETE FROM trusted_files WHERE project_id = ?', projectId);
          for (const f of files) run('INSERT OR REPLACE INTO trusted_files (project_id, path, sha, content) VALUES (?, ?, ?, ?)', projectId, f.path, f.sha, f.content);
        });
      },
    },

    threads: {
      get: (id) => {
        const r = one('SELECT * FROM threads WHERE id = ?', id);
        return r ? threadFrom(r) : null;
      },
      list(opts = {}) {
        const f = threadFilter(opts);
        return many(`SELECT * FROM threads${f.where} ORDER BY rowid`, ...f.params).map(threadFrom);
      },
      insert(t) {
        if (one('SELECT 1 AS x FROM threads WHERE id = ?', t.id)) throw new GmiError('conflict', 'Thread exists.');
        run(
          `INSERT INTO threads (id, project_id, title, strategy, branch, base_ref, base_sha, worktree_path, git_dir, common_dir, git_pointer,
             object_dir, setup_state, settings, status, status_reason, cost_usd, tokens, archived, instructions_hash, env_block, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          t.id,
          t.projectId,
          t.title,
          t.strategy,
          t.branch ?? null,
          t.baseRef ?? null,
          t.baseSha ?? null,
          t.worktreePath ?? null,
          t.gitDir ?? null,
          t.commonDir ?? null,
          t.gitPointer ?? null,
          t.objectDir ?? null,
          t.setupState,
          json(t.settings),
          t.status,
          t.statusReason ?? null,
          t.costUsd,
          json(t.tokens),
          bool(t.archived),
          t.instructionsHash ?? null,
          t.envBlock ?? null,
          t.createdAt,
          t.updatedAt,
        );
      },
      update(id, patch) {
        return tx(() => {
          if (!one('SELECT 1 AS x FROM threads WHERE id = ?', id)) throw new GmiError('not_found', 'Thread not found.');
          const set = setClause(THREAD_COLUMNS, { ...patch, updatedAt: iso() });
          run(`UPDATE threads SET ${set.sql.join(', ')} WHERE id = ?`, ...set.params, id);
          const r = one('SELECT * FROM threads WHERE id = ?', id);
          if (!r) throw new GmiError('not_found', 'Thread not found.');
          return threadFrom(r);
        });
      },
      delete(id) {
        tx(() => deleteThreadRows(id));
      },
      summaries(opts = {}) {
        const f = threadFilter(opts, 't.');
        return many(`${SUMMARY_SELECT}${f.where} ORDER BY t.updated_at DESC, t.rowid DESC`, ...f.params).map(summaryFrom);
      },
    },

    messages: {
      append(row) {
        return tx(() => {
          const ord = lastOrd(row.contextId) + 1;
          insertMessage(row, ord, row.partial === true);
          return getMessage(row.id);
        });
      },
      upsertPartial(row) {
        return tx(() => {
          if (one('SELECT 1 AS x FROM messages WHERE id = ?', row.id)) overwriteMessage(row.id, row, true);
          else insertMessage(row, lastOrd(row.contextId) + 1, true);
          return getMessage(row.id);
        });
      },
      finalizePartial(id, row) {
        return tx(() => {
          if (!one('SELECT 1 AS x FROM messages WHERE id = ?', id)) throw new GmiError('not_found', 'No partial message.');
          overwriteMessage(id, row, false);
          return getMessage(id);
        });
      },
      list(contextId, opts = {}) {
        const sql = `SELECT * FROM messages WHERE context_id = ? AND ord > ?${opts.inContextOnly ? ' AND in_context = 1' : ''} ORDER BY ord`;
        return many(sql, contextId, opts.afterOrd ?? 0).map(messageFrom);
      },
      markOutOfContext(contextId, uptoOrd) {
        return Number(run('UPDATE messages SET in_context = 0 WHERE context_id = ? AND ord <= ? AND in_context = 1 AND pinned = 0', contextId, uptoOrd).changes);
      },
      lastOrd,
    },

    toolCalls: {
      insert(t) {
        tx(() => {
          if (one('SELECT 1 AS x FROM tool_calls WHERE id = ?', t.id)) throw new GmiError('conflict', 'Tool call exists.');
          if (one('SELECT 1 AS x FROM tool_calls WHERE context_id = ? AND wire_id = ?', t.contextId, t.wireId)) throw new GmiError('conflict', 'Wire id reused in this context.');
          run(
            `INSERT INTO tool_calls (id, wire_id, provider_call_id, thread_id, context_id, run_id, turn, step, tool, args, status,
               result_message_id, spill_path, exit_code, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            t.id,
            t.wireId,
            t.providerCallId ?? null,
            t.threadId,
            t.contextId,
            t.runId ?? null,
            t.turn ?? null,
            t.step ?? null,
            t.tool,
            t.args,
            t.status,
            t.resultMessageId ?? null,
            t.spillPath ?? null,
            t.exitCode ?? null,
            t.startedAt ?? null,
            t.finishedAt ?? null,
          );
        });
      },
      get: (id) => {
        const r = one('SELECT * FROM tool_calls WHERE id = ?', id);
        return r ? toolCallFrom(r) : null;
      },
      byWireId: (contextId, wireId) => {
        const r = one('SELECT * FROM tool_calls WHERE context_id = ? AND wire_id = ?', contextId, wireId);
        return r ? toolCallFrom(r) : null;
      },
      update(id, patch) {
        const set = setClause(TOOL_CALL_COLUMNS, patch);
        if (set.sql.length === 0) return;
        run(`UPDATE tool_calls SET ${set.sql.join(', ')} WHERE id = ?`, ...set.params, id);
      },
      unsettled(threadId) {
        return threadId === undefined
          ? many("SELECT * FROM tool_calls WHERE status = 'started' ORDER BY rowid").map(toolCallFrom)
          : many("SELECT * FROM tool_calls WHERE thread_id = ? AND status = 'started' ORDER BY rowid", threadId).map(toolCallFrom);
      },
    },

    approvals: {
      insert(a) {
        run(
          `INSERT INTO approvals (request_id, thread_id, run_id, tool_call_id, kind, request, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(request_id) DO UPDATE SET thread_id = excluded.thread_id, run_id = excluded.run_id, tool_call_id = excluded.tool_call_id,
             kind = excluded.kind, request = excluded.request, decision = excluded.decision, decided_at = excluded.decided_at`,
          a.requestId,
          a.threadId,
          a.runId,
          a.toolCallId ?? null,
          a.kind,
          json(a.request),
          jsonOrNull(a.decision),
          a.decidedAt ?? null,
        );
      },
      decide(requestId, decision, at) {
        run('UPDATE approvals SET decision = ?, decided_at = ? WHERE request_id = ?', json(decision), at, requestId);
      },
      pending(threadId) {
        return threadId === undefined
          ? many('SELECT * FROM approvals WHERE decision IS NULL ORDER BY rowid').map(approvalFrom)
          : many('SELECT * FROM approvals WHERE thread_id = ? AND decision IS NULL ORDER BY rowid', threadId).map(approvalFrom);
      },
      get: (requestId) => {
        const r = one('SELECT * FROM approvals WHERE request_id = ?', requestId);
        return r ? approvalFrom(r) : null;
      },
    },

    rules: {
      list(opts = {}) {
        const where: string[] = [];
        const params: SqlValue[] = [];
        // Same filter as the fake: a given projectId/threadId also matches the global (null) rules.
        if (opts.projectId !== undefined) {
          where.push('(project_id IS NULL OR project_id = ?)');
          params.push(opts.projectId);
        }
        if (opts.threadId !== undefined) {
          where.push('(thread_id IS NULL OR thread_id = ?)');
          params.push(opts.threadId);
        }
        return many(`SELECT * FROM permission_rules${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`, ...params).map(ruleFrom);
      },
      insert(rule) {
        run(
          `INSERT INTO permission_rules (id, tool, pattern, effect, scope, project_id, thread_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET tool = excluded.tool, pattern = excluded.pattern, effect = excluded.effect, scope = excluded.scope,
             project_id = excluded.project_id, thread_id = excluded.thread_id, source = excluded.source, created_at = excluded.created_at`,
          rule.id,
          rule.tool,
          rule.pattern ?? null,
          rule.effect,
          rule.scope,
          rule.projectId ?? null,
          rule.threadId ?? null,
          rule.source,
          rule.createdAt,
        );
      },
      delete: (id) => Number(run('DELETE FROM permission_rules WHERE id = ?', id).changes) > 0,
    },

    checkpoints: {
      insert(c) {
        run(
          `INSERT INTO checkpoints (id, thread_id, turn, commit_sha, tree_sha, files_changed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id, turn = excluded.turn, commit_sha = excluded.commit_sha,
             tree_sha = excluded.tree_sha, files_changed = excluded.files_changed, created_at = excluded.created_at`,
          c.id,
          c.threadId,
          c.turn,
          c.commitSha,
          c.treeSha,
          c.filesChanged,
          c.createdAt,
        );
      },
      list: (threadId) => many('SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY turn, rowid', threadId).map(checkpointFrom),
      get: (id) => {
        const r = one('SELECT * FROM checkpoints WHERE id = ?', id);
        return r ? checkpointFrom(r) : null;
      },
    },

    compactions: {
      insert(c) {
        run(
          `INSERT INTO compactions (id, thread_id, context_id, upto_ord, summary, model, before_tokens, after_tokens, cost_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id, context_id = excluded.context_id, upto_ord = excluded.upto_ord,
             summary = excluded.summary, model = excluded.model, before_tokens = excluded.before_tokens, after_tokens = excluded.after_tokens,
             cost_usd = excluded.cost_usd, created_at = excluded.created_at`,
          c.id,
          c.threadId,
          c.contextId,
          c.uptoOrd,
          c.summary,
          c.model,
          c.beforeTokens,
          c.afterTokens,
          c.costUsd ?? null,
          c.createdAt,
        );
      },
      list: (contextId) => many('SELECT * FROM compactions WHERE context_id = ? ORDER BY rowid', contextId).map(compactionFrom),
    },

    reads: {
      get: (contextId, path) => {
        const r = one('SELECT * FROM reads WHERE context_id = ? AND path = ?', contextId, path);
        return r ? readFrom(r) : null;
      },
      put(r) {
        run(
          `INSERT INTO reads (context_id, path, sha, ranges, size, mtime_ms, ord) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(context_id, path) DO UPDATE SET sha = excluded.sha, ranges = excluded.ranges, size = excluded.size,
             mtime_ms = excluded.mtime_ms, ord = excluded.ord`,
          r.contextId,
          r.path,
          r.sha,
          json(r.ranges),
          r.size ?? null,
          r.mtimeMs ?? null,
          r.ord ?? null,
        );
      },
      delete: (contextId, path) => void run('DELETE FROM reads WHERE context_id = ? AND path = ?', contextId, path),
      list: (contextId) => many('SELECT * FROM reads WHERE context_id = ? ORDER BY rowid', contextId).map(readFrom),
    },

    usage: {
      insert(u) {
        run(
          `INSERT INTO usage_steps (thread_id, context_id, run_id, turn, step, model, prompt, cached, expected_cached, completion, reasoning,
             cost_usd, estimated, prefix_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          u.threadId,
          u.contextId,
          u.runId ?? null,
          u.turn ?? null,
          u.step ?? null,
          u.model,
          u.prompt,
          u.cached,
          u.expectedCached ?? null,
          u.completion,
          u.reasoning,
          u.costUsd ?? null,
          bool(u.estimated),
          u.prefixHash ?? null,
          u.at,
        );
      },
      list(threadId, opts = {}) {
        const where = ['thread_id = ?'];
        const params: SqlValue[] = [threadId];
        if (opts.runId !== undefined) {
          where.push('run_id = ?');
          params.push(opts.runId);
        }
        if (opts.contextId !== undefined) {
          where.push('context_id = ?');
          params.push(opts.contextId);
        }
        return many(`SELECT * FROM usage_steps WHERE ${where.join(' AND ')} ORDER BY rowid`, ...params).map(usageFrom);
      },
    },

    mcpServers: {
      list(opts = {}) {
        return opts.projectId === undefined
          ? many('SELECT * FROM mcp_servers ORDER BY rowid').map(mcpFrom)
          : many('SELECT * FROM mcp_servers WHERE project_id IS ? ORDER BY rowid', opts.projectId).map(mcpFrom);
      },
      get: (id) => {
        const r = one('SELECT * FROM mcp_servers WHERE id = ?', id);
        return r ? mcpFrom(r) : null;
      },
      upsert(m) {
        run(
          `INSERT INTO mcp_servers (id, scope, project_id, config, trust_hash, tool_hashes, resolved_version, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, project_id = excluded.project_id, config = excluded.config,
             trust_hash = excluded.trust_hash, tool_hashes = excluded.tool_hashes, resolved_version = excluded.resolved_version, enabled = excluded.enabled`,
          m.id,
          m.scope,
          m.projectId ?? null,
          json(m.config),
          m.trustHash ?? null,
          jsonOrNull(m.toolHashes),
          m.resolvedVersion ?? null,
          bool(m.enabled),
        );
      },
      remove: (id) => void run('DELETE FROM mcp_servers WHERE id = ?', id),
    },

    todos: {
      get: (contextId) => parse<TodoItem[]>(one('SELECT items FROM todos WHERE context_id = ?', contextId)?.items, []),
      put(contextId, threadId, items) {
        run(
          `INSERT INTO todos (context_id, thread_id, items, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(context_id) DO UPDATE SET thread_id = excluded.thread_id, items = excluded.items, updated_at = excluded.updated_at`,
          contextId,
          threadId,
          json(items),
          iso(),
        );
      },
    },

    refSnapshots: {
      put(runId, threadId, refs) {
        run(
          `INSERT INTO ref_snapshots (run_id, thread_id, refs, at) VALUES (?, ?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET thread_id = excluded.thread_id, refs = excluded.refs, at = excluded.at`,
          runId,
          threadId,
          json(refs),
          iso(),
        );
      },
      get(runId) {
        const r = one('SELECT * FROM ref_snapshots WHERE run_id = ?', runId);
        return r ? { threadId: s(r.thread_id) ?? '', refs: parse<Record<string, string>>(r.refs, {}), at: s(r.at) ?? '' } : null;
      },
      delete: (runId) => void run('DELETE FROM ref_snapshots WHERE run_id = ?', runId),
      list: () => many('SELECT run_id, thread_id FROM ref_snapshots ORDER BY rowid').map((r) => ({ runId: s(r.run_id) ?? '', threadId: s(r.thread_id) ?? '' })),
    },

    sensitiveHashes: {
      get(threadId) {
        const out: Record<string, string | null> = {};
        for (const r of many('SELECT path, sha FROM sensitive_hashes WHERE thread_id = ? ORDER BY rowid', threadId)) out[s(r.path) ?? ''] = s(r.sha);
        return out;
      },
      put(threadId, hashes) {
        tx(() => {
          run('DELETE FROM sensitive_hashes WHERE thread_id = ?', threadId);
          for (const [path, sha] of Object.entries(hashes)) run('INSERT INTO sensitive_hashes (thread_id, path, sha) VALUES (?, ?, ?)', threadId, path, sha ?? null);
        });
      },
    },

    gitProcs: {
      add(pid, threadId) {
        run(
          'INSERT INTO git_procs (pid, thread_id, started_at) VALUES (?, ?, ?) ON CONFLICT(pid) DO UPDATE SET thread_id = excluded.thread_id, started_at = excluded.started_at',
          pid,
          threadId ?? null,
          iso(),
        );
      },
      remove: (pid) => void run('DELETE FROM git_procs WHERE pid = ?', pid),
      list: () => many('SELECT * FROM git_procs ORDER BY rowid').map((r) => ({ pid: n0(r.pid), threadId: s(r.thread_id), startedAt: s(r.started_at) ?? '' })),
    },

    projections: {
      rebuild: (threadId) => rebuildProjections(db, threadId),
      timeline: (threadId, opts) => timelinePage(db, threadId, opts),
      summary(threadId) {
        const r = one(`${SUMMARY_SELECT} WHERE t.id = ?`, threadId);
        return r ? summaryFrom(r) : null;
      },
      thread: (threadId, meter) => threadView(store, threadId, meter),
    },

    async backup(dest) {
      if (closed) throw new GmiError('internal', 'The agent database is closed.', { detail: 'db_closed' });
      if (resolve(dest) === resolve(db.file)) throw new GmiError('invalid_input', 'A backup cannot overwrite the database itself.');
      // One step (`rate: -1`): a multi-step online backup yields to the event loop between steps, and a write landing
      // there makes node:sqlite fail with SQLite's misleading "not an error". The file is created 0600 first, so the
      // copy is never readable by others, even for a moment. Two retries cover a transient lock.
      for (let attempt = 1; ; attempt += 1) {
        try {
          closeSync(openSync(dest, 'w', 0o600));
          chmodSync(dest, 0o600);
          await sqlite().backup(db.raw, dest, { rate: -1 });
          chmodSync(dest, 0o600);
          return;
        } catch (err) {
          rmSync(dest, { force: true });
          if (attempt >= 3) throw new GmiError('internal', 'Could not back up the agent database.', { cause: err });
        }
      }
    },

    checkpointWal() {
      if (!closed) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },

    quickCheck() {
      const rows = many('PRAGMA quick_check');
      const first = rows[0] ? Object.values(rows[0])[0] : 'ok';
      return typeof first === 'string' ? first : 'ok';
    },

    close() {
      if (closed) return;
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (error) {
        deps.log?.warn('store checkpoint on close failed', { code: error instanceof GmiError ? error.detail : 'unknown' });
      }
      closed = true;
      db.close();
    },
  };

  return store;
}

const trustedFrom = (r: Row): TrustedFileRow => ({ projectId: s(r.project_id) ?? '', path: s(r.path) ?? '', sha: s(r.sha) ?? '', content: s(r.content) ?? '' });

