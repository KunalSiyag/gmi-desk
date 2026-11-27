-- GMI Desk harness store, schema v1 (harness.md §5.2) with sanitised sample rows. Frozen: never regenerate from
-- src/harness/store/schema.ts; it stands for a database written by a v1 build.
PRAGMA foreign_keys = ON;
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
INSERT INTO projects VALUES ('prj_fixture', '/tmp/gmi-desk-fixture/repo', 'repo', 'main', '/tmp/gmi-desk-fixture/repo-worktrees', NULL, 'trusted', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', '2026-10-30T09:00:00.000Z', 'files', '2026-10-30T09:00:00.000Z');
INSERT INTO trusted_files VALUES ('prj_fixture', 'AGENTS.md', '1111111111111111111111111111111111111111111111111111111111111111', '# Rules
Run npm test.
');
INSERT INTO threads VALUES ('thr_a', 'prj_fixture', 'Fix tests', 'worktree', 'gmi/thr_a0/fix', 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/tmp/gmi-desk-fixture/repo-worktrees/thr_a', '/tmp/gmi-desk-fixture/repo/.git/worktrees/thr_a', '/tmp/gmi-desk-fixture/repo/.git', 'gitdir: /tmp/gmi-desk-fixture/repo/.git/worktrees/thr_a', NULL, 'ready', '{"runtime":"gmi","model":"zai-org/GLM-5.3","subagentModel":null,"compactionModel":null,"sideTaskModel":null,"mode":"auto-accept-edits","reasoningEffort":null,"maxOutputTokens":16384,"economy":false,"maxContextTokens":160000,"webFetch":"off","network":"off","budget":{"perTurnUsd":1,"perThreadUsd":5,"maxStepsPerTurn":50,"maxTurnMinutes":30},"computerId":null}', 'completed', NULL, 0.0123, '{"input":1200,"cached":800,"output":300,"reasoning":40}', 0, NULL, '<environment>os: linux</environment>', '2026-10-30T10:00:00.000Z', '2026-10-30T10:05:00.000Z');
INSERT INTO threads VALUES ('thr_b', 'prj_fixture', 'Explain', 'root', NULL, NULL, NULL, '/tmp/gmi-desk-fixture/repo', '/tmp/gmi-desk-fixture/repo/.git', '/tmp/gmi-desk-fixture/repo/.git', NULL, NULL, 'ready', '{"runtime":"gmi","model":"zai-org/GLM-5.3","subagentModel":null,"compactionModel":null,"sideTaskModel":null,"mode":"auto-accept-edits","reasoningEffort":null,"maxOutputTokens":16384,"economy":false,"maxContextTokens":160000,"webFetch":"off","network":"off","budget":{"perTurnUsd":1,"perThreadUsd":5,"maxStepsPerTurn":50,"maxTurnMinutes":30},"computerId":null}', 'idle', NULL, 0, '{"input":0,"cached":0,"output":0,"reasoning":0}', 1, NULL, NULL, '2026-10-30T11:00:00.000Z', '2026-10-30T11:00:00.000Z');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_a', 1, 'ev_fx1', 'ctx_thr_a', 'run_fx1', 1, NULL, 'item', '2026-10-30T10:00:00.000Z', '{"type":"item","item":{"kind":"user","id":"itm_u1","seq":0,"turn":1,"text":"Fix the failing test","steering":false,"at":"2026-10-30T10:00:00.000Z"}}');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_b', 1, 'ev_fx2', 'ctx_thr_b', NULL, NULL, NULL, 'notice', '2026-10-30T11:00:00.000Z', '{"text":"hello"}');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_a', 2, 'ev_fx3', 'ctx_thr_a', 'run_fx1', 1, 1, 'item', '2026-10-30T10:00:02.000Z', '{"type":"item","item":{"kind":"tool","id":"itm_t1","seq":0,"turn":1,"step":1,"toolCallId":"tc_01JFIXTURE0000000000000001","tool":"bash","title":"npm test","argsPreview":"{\"command\":\"npm test\"}","status":"running","output":null,"durationMs":null,"at":"2026-10-30T10:00:02.000Z"}}');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_a', 3, 'ev_fx4', 'ctx_thr_a', 'run_fx1', 1, 1, 'tool.started', '2026-10-30T10:00:02.000Z', '{"toolCallId":"tc_01JFIXTURE0000000000000001"}');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_a', 4, 'ev_fx5', 'ctx_thr_a', 'run_fx1', 1, 1, 'item', '2026-10-30T10:00:03.000Z', '{"type":"item","item":{"kind":"tool","id":"itm_t1","seq":0,"turn":1,"step":1,"toolCallId":"tc_01JFIXTURE0000000000000001","tool":"bash","title":"npm test","argsPreview":"{\"command\":\"npm test\"}","status":"succeeded","output":{"text":"1 passing","truncated":false,"totalBytes":9,"spillId":null,"exitCode":0},"durationMs":850,"at":"2026-10-30T10:00:03.000Z"}}');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_a', 5, 'ev_fx6', 'ctx_thr_a', 'run_fx1', 1, 1, 'todo', '2026-10-30T10:00:04.000Z', '{"type":"todo","todo":[{"id":"t1","text":"Run the tests","status":"done"}]}');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_a', 6, 'ev_fx7', 'ctx_thr_a', 'run_fx1', 1, 2, 'diff', '2026-10-30T10:00:05.000Z', '{"type":"diff","diff":{"files":2,"additions":10,"deletions":3}}');
INSERT INTO events (thread_id, thread_seq, event_id, context_id, run_id, turn, step, type, at, payload) VALUES ('thr_a', 7, 'ev_fx8', 'ctx_thr_a', 'run_fx1', 1, 2, 'status', '2026-10-30T10:05:00.000Z', '{"type":"status","status":"completed","reason":null,"queuePosition":null,"queueReason":null}');
INSERT INTO command_receipts VALUES ('cmd_fx1', 'thr_a', '2026-10-30T10:00:00.000Z', '{"runId":"run_fx1","turn":1}');
INSERT INTO messages (id, thread_id, context_id, ord, turn, role, content, tool_calls, tool_call_id, reasoning, reasoning_family, model, in_context, pinned, partial, est_tokens) VALUES ('msg_fx1', 'thr_a', 'ctx_thr_a', 1, 1, 'user', 'Fix the failing test', NULL, NULL, NULL, NULL, NULL, 1, 0, 0, 6);
INSERT INTO messages (id, thread_id, context_id, ord, turn, role, content, tool_calls, tool_call_id, reasoning, reasoning_family, model, in_context, pinned, partial, est_tokens) VALUES ('msg_fx2', 'thr_a', 'ctx_thr_a', 2, 1, 'assistant', '', '[{"id":"call_0","name":"bash","arguments":"{\"command\":\"npm test\"}"}]', NULL, 'Run the tests first.', 'deepseek', 'zai-org/GLM-5.3', 1, 0, 0, 30);
INSERT INTO messages (id, thread_id, context_id, ord, turn, role, content, tool_calls, tool_call_id, reasoning, reasoning_family, model, in_context, pinned, partial, est_tokens) VALUES ('msg_fx3', 'thr_a', 'ctx_thr_a', 3, 1, 'tool', '1 passing', NULL, 'call_0', NULL, NULL, NULL, 1, 0, 0, 3);
INSERT INTO tool_calls VALUES ('tc_01JFIXTURE0000000000000001', 'call_0', 'call_0', 'thr_a', 'ctx_thr_a', 'run_fx1', 1, 1, 'bash', '{"command":"npm test"}', 'succeeded', 'msg_fx3', NULL, 0, '2026-10-30T10:00:02.000Z', '2026-10-30T10:00:03.000Z');
INSERT INTO approvals VALUES ('apr_fx1', 'thr_a', 'run_fx1', NULL, 'command', '{"requestId":"apr_fx1","threadId":"thr_a","runId":"run_fx1","toolCallId":null,"kind":"command","tool":"bash","title":"rm -rf build","detail":{"command":"rm -rf build"},"risk":["destructive"],"suggestedRule":null,"allowedDecisions":["allow_once","deny"],"createdAt":"2026-10-30T10:01:00.000Z","expiresAt":null}', NULL, NULL);
INSERT INTO permission_rules VALUES ('rule_fx1', 'bash', 'npm test', 'allow', 'project', 'prj_fixture', NULL, 'user', '2026-10-30T10:00:00.000Z');
INSERT INTO checkpoints VALUES ('ckpt_fx1', 'thr_a', 1, 'cccccccccccccccccccccccccccccccccccccccc', 'dddddddddddddddddddddddddddddddddddddddd', 2, '2026-10-30T10:00:05.000Z');
INSERT INTO compactions VALUES ('cmp_fx1', 'thr_a', 'ctx_thr_a', 1, 'Summary of turn 1', 'zai-org/GLM-5.3', 9000, 1200, 0.001, '2026-10-30T10:04:00.000Z');
INSERT INTO reads VALUES ('ctx_thr_a', 'src/a.ts', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '[[0,120]]', 4096, 1730282400000, 2);
INSERT INTO usage_steps VALUES ('thr_a', 'ctx_thr_a', 'run_fx1', 1, 1, 'zai-org/GLM-5.3', 1200, 800, 800, 300, 40, 0.0123, 0, '9999999999999999999999999999999999999999999999999999999999999999', '2026-10-30T10:00:03.000Z');
INSERT INTO mcp_servers VALUES ('mcp_fx1', 'global', NULL, '{"name":"docs","transport":{"type":"http","url":"https://mcp.example.test/mcp","auth":"none"}}', NULL, '{"search":"abc"}', NULL, 1);
INSERT INTO todos VALUES ('ctx_thr_a', 'thr_a', '[{"id":"t1","text":"Run the tests","status":"done"}]', '2026-10-30T10:00:04.000Z');
INSERT INTO ref_snapshots VALUES ('run_fx1', 'thr_a', '{"refs/heads/main":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}', '2026-10-30T10:00:00.000Z');
INSERT INTO sensitive_hashes VALUES ('thr_a', 'package.json', '7777777777777777777777777777777777777777777777777777777777777777');
INSERT INTO sensitive_hashes VALUES ('thr_a', '.envrc', NULL);
INSERT INTO git_procs VALUES (424242, 'thr_a', '2026-10-30T10:00:00.000Z');
PRAGMA user_version = 1;
