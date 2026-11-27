/**
 * Schema migrations of the harness store (harness.md §5.2), tracked with `PRAGMA user_version`.
 *
 * - v1 is the §5.2 schema exactly as designed (the shape main's view-only fallback reads, readonly-db.ts).
 * - v2 adds what the frozen interfaces (src/harness/types.ts) need beyond §5.2 — `messages.steering` (§6.5) — and
 *   the indexes the store's queries use.
 *
 * Migrations are additive and run in order, each in its own transaction that also sets `user_version`. They run in
 * the worker thread (migrate.ts), after the file is copied to `harness.sqlite.bak-<v>`. Never edit a released
 * migration: append a new one.
 */

export interface Migration {
  version: number;
  sql: string;
}

const V1 = `
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  thread_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  context_id TEXT NOT NULL,
  run_id TEXT, turn INTEGER, step INTEGER,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(thread_id, thread_seq)
);
CREATE INDEX events_run ON events(run_id, seq);
CREATE TABLE command_receipts (command_id TEXT PRIMARY KEY, thread_id TEXT, at TEXT NOT NULL, result TEXT);
CREATE TABLE projects (id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, name TEXT, default_branch TEXT,
  worktree_dir TEXT NOT NULL, setup_command TEXT, trust_state TEXT NOT NULL, trust_hash TEXT, trusted_at TEXT,
  ref_format TEXT NOT NULL,
  added_at TEXT NOT NULL);
CREATE TABLE trusted_files (project_id TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY(project_id, path));
CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT, strategy TEXT,
  branch TEXT, base_ref TEXT, base_sha TEXT, worktree_path TEXT,
  git_dir TEXT, common_dir TEXT, git_pointer TEXT, object_dir TEXT,
  setup_state TEXT,
  settings TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT, cost_usd REAL NOT NULL DEFAULT 0,
  tokens TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, instructions_hash TEXT, env_block TEXT, created_at TEXT,
  updated_at TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, context_id TEXT NOT NULL, ord INTEGER NOT NULL,
  turn INTEGER, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, reasoning TEXT,
  reasoning_family TEXT, model TEXT, in_context INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0,
  est_tokens INTEGER, UNIQUE(context_id, ord));
CREATE TABLE tool_calls (id TEXT PRIMARY KEY,
  wire_id TEXT NOT NULL,
  provider_call_id TEXT,
  thread_id TEXT NOT NULL, context_id TEXT NOT NULL, run_id TEXT, turn INTEGER, step INTEGER, tool TEXT, args TEXT,
  status TEXT, result_message_id TEXT, spill_path TEXT, exit_code INTEGER, started_at TEXT, finished_at TEXT,
  UNIQUE(context_id, wire_id));
CREATE TABLE approvals (request_id TEXT PRIMARY KEY, thread_id TEXT, run_id TEXT, tool_call_id TEXT, kind TEXT,
  request TEXT NOT NULL, decision TEXT, decided_at TEXT);
CREATE TABLE permission_rules (id TEXT PRIMARY KEY, tool TEXT NOT NULL, pattern TEXT, effect TEXT NOT NULL,
  scope TEXT NOT NULL, project_id TEXT, thread_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE checkpoints (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn INTEGER NOT NULL, commit_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL, files_changed INTEGER, created_at TEXT NOT NULL);
CREATE TABLE compactions (id TEXT PRIMARY KEY, thread_id TEXT, context_id TEXT, upto_ord INTEGER, summary TEXT,
  model TEXT, before_tokens INTEGER, after_tokens INTEGER, cost_usd REAL, created_at TEXT);
CREATE TABLE reads (context_id TEXT NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL,
  ranges TEXT NOT NULL,
  size INTEGER, mtime_ms INTEGER, ord INTEGER, PRIMARY KEY(context_id, path));
CREATE TABLE usage_steps (thread_id TEXT, context_id TEXT, run_id TEXT, turn INTEGER, step INTEGER, model TEXT,
  prompt INTEGER, cached INTEGER, expected_cached INTEGER, completion INTEGER, reasoning INTEGER, cost_usd REAL,
  estimated INTEGER, prefix_hash TEXT, at TEXT);
CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, scope TEXT, project_id TEXT, config TEXT NOT NULL, trust_hash TEXT,
  tool_hashes TEXT, resolved_version TEXT, enabled INTEGER NOT NULL);
CREATE TABLE todos (context_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, items TEXT NOT NULL, updated_at TEXT);
CREATE TABLE ref_snapshots (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, refs TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE sensitive_hashes (thread_id TEXT NOT NULL, path TEXT NOT NULL, sha TEXT, PRIMARY KEY(thread_id, path));
CREATE TABLE git_procs (pid INTEGER PRIMARY KEY, thread_id TEXT, started_at TEXT);
`;

const V2 = `
ALTER TABLE messages ADD COLUMN steering INTEGER NOT NULL DEFAULT 0;
CREATE INDEX events_thread_type ON events(thread_id, type, thread_seq);
CREATE INDEX messages_thread ON messages(thread_id);
CREATE INDEX tool_calls_thread ON tool_calls(thread_id, status);
CREATE INDEX approvals_thread ON approvals(thread_id, decision);
CREATE INDEX threads_project ON threads(project_id, archived);
CREATE INDEX checkpoints_thread ON checkpoints(thread_id, turn);
CREATE INDEX compactions_context ON compactions(context_id);
CREATE INDEX usage_thread ON usage_steps(thread_id, run_id);
CREATE INDEX todos_thread ON todos(thread_id);
CREATE INDEX command_receipts_at ON command_receipts(at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: V1 },
  { version: 2, sql: V2 },
];

/** The schema version this build writes. */
export const STORE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
