/**
 * Frozen internal interfaces of the harness host (harness.md §5–§9, §24 H2-0). The six H2 slices build against
 * these in parallel:
 *   H2-A Store (§5.2) · H2-B Loop (§6, §7.1–7.2) · H2-C Compactor (§7.3–7.5) · H2-D file tools + ToolRegistry (§8.1,
 *   §8.2, §8.7) · H2-E SandboxRunner + PermissionEngine + shell/web (§8.3–8.5, §9) · H2-G GitService (§7.7, §8.2,
 *   §8.3, §12.2).
 * Conforming fakes for tests: test/harness/fakes.ts (checked by test/harness/types.test.ts).
 *
 * Changes after H2-0 are additive only and go through the H2-0 integration step. A slice that needs a worker job
 * adds it by module augmentation of `WorkerJobs` in its own file (see below), not by editing this file.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  CodeProject,
  CodeState,
  CodeThreadEvent,
  CodeThreadSettings,
  CodeThreadSummary,
  DiffFile,
  PermissionRule,
  PermissionRuleDraft,
  RiskFlag,
  RunStatus,
  RuntimeMode,
  ThreadStrategy,
  TodoItem,
  TokenTotals,
  ToolOutputPreview,
} from '@shared/contracts/code';
import type { GatewayEvent, GatewayRequest, GwToolCall, GwToolDef } from '@shared/contracts/gateway';
import type { HarnessCommand, HostInitSettings, HostPhase, HostRpcMethod, HostRpcParams } from './protocol';

export { turnIdOf } from './protocol';

// ─── Conventions (frozen) ─────────────────────────────────────────────────────────────────────────────────────

/** The thread's main context id (§5.2). A subagent's context id is its child run id. */
export function contextIdOf(threadId: string): string {
  return `ctx_${threadId}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (26 Crockford base-32 characters: 48-bit ms time + 80 random bits). Sorts by creation time. */
export function newUlid(nowMs: number = Date.now()): string {
  let time = '';
  let t = Math.max(0, Math.floor(nowMs));
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let rand = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += CROCKFORD[(acc >> bits) & 31];
    }
  }
  return time + rand;
}

/** Prefixed ids: `tc_` internal tool calls (§7.1), `run_`, `ev_`, `req_` (gateway), `apr_` (approvals), `cmp_`, `ckpt_`. */
export function newId(prefix: 'tc' | 'run' | 'ev' | 'req' | 'apr' | 'cmp' | 'ckpt' | 'msg' | 'rule' | 'rpc', nowMs?: number): string {
  return `${prefix}_${newUlid(nowMs)}`;
}

/** Everything the host stores lives under `init.dataDir` = `<userData>/data/harness` (0700). */
export function harnessPaths(dataDir: string) {
  return {
    root: dataDir,
    /** §5.2: WAL, synchronous=FULL, 0600; the host is the only writer. */
    db: join(dataDir, 'harness.sqlite'),
    /** §8.7: `<spill>/<threadId>/<tc_id>.txt`, 0600, 7 days. */
    spillDir: join(dataDir, 'spill'),
    spillFile: (threadId: string, toolCallId: string) => join(dataDir, 'spill', threadId, `${toolCallId}.txt`),
    /** §7.7 snapshot repos (no sandbox mounts them). */
    snapshotRepo: (projectId: string) => join(dataDir, 'snapshots', `${projectId}.git`),
    /** §8.3 per-thread git object dir (GIT_OBJECT_DIRECTORY inside the sandbox). */
    objectDir: (threadId: string) => join(dataDir, 'objects', threadId),
    /** §8.3 per-thread caches (`.cache`, `npm`, `pip`), the only state that persists between commands. */
    cacheDir: (threadId: string) => join(dataDir, 'cache', threadId),
    /** §5.1 quarantine journal (host.ts): the thread being recovered, fsynced before recovery starts. */
    recoveryJournal: join(dataDir, 'recovery.json'),
  };
}

// ─── Time and logs ────────────────────────────────────────────────────────────────────────────────────────────

/** Injected wherever time matters, so tests use a fake clock (same shape as main's GatewayClock). */
export interface HostClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/**
 * Host logs are forwarded to main as `{t:'log'}` (§21). Messages are fixed strings; `meta` carries ids, counts and
 * codes only (never prompts, outputs, file contents, commands or env values). Main sanitises again.
 */
export interface HostLog {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): HostLog;
}

// ─── Worker (§5.1: no synchronous block over 1 s on the host's event loop) ──────────────────────────────────

/**
 * Jobs the `worker_threads` worker runs (src/harness/worker.ts). Slices add their own by augmentation, e.g.
 *   declare module '@harness/types' { interface WorkerJobs { 'store.migrate': { input: {...}; output: {...} } } }
 * and register the handler with `registerWorkerJob` at module load (the worker loads the same bundle).
 */
export interface WorkerJobs {
  echo: { input: unknown; output: unknown };
  /** sha256 hex of a large string (context hashing above 1 MB, §5.1). */
  sha256: { input: { text: string }; output: string };
}
export type WorkerJobName = keyof WorkerJobs;

export interface Worker {
  run<K extends WorkerJobName>(job: K, input: WorkerJobs[K]['input'], opts?: { signal?: AbortSignal }): Promise<WorkerJobs[K]['output']>;
  /** Terminates the thread; pending jobs reject with `cancelled`. */
  close(): Promise<void>;
}

// ─── Links to main (gateway-client.ts) ───────────────────────────────────────────────────────────────────────

/** Model requests go through main's gateway (§4.1). The host never holds a key. */
export interface GatewayClient {
  /**
   * Streams the request's events. Ends after `finish` or `error` (main guarantees a terminal event). Aborting
   * `signal` sends `gw.cancel` and makes the iteration throw GmiError('cancelled').
   */
  stream(req: GatewayRequest, signal: AbortSignal): AsyncIterable<GatewayEvent>;
}

export interface MainRpc {
  call<M extends HostRpcMethod>(method: M, params: HostRpcParams<M>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
}

/** Approvals are decided in main (card or native dialog) and come back as `approval.decision` (§9.4). */
export interface ApprovalClient {
  /**
   * Sends `approval.request` and waits for the decision. `allowedDecisions` is filled by main (any value sent here
   * is replaced). Aborting `signal` withdraws the request and rejects with GmiError('cancelled').
   */
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  pending(): string[];
}

/** Notifications from the host to main (forwarded to the renderer after zod validation, §6.6). */
export interface MainEvents {
  event(event: CodeThreadEvent): void;
  threads(threads: CodeThreadSummary[]): void;
  runEnded(threadId: string, runId: string): void;
}

export interface MainLink {
  gateway: GatewayClient;
  rpc: MainRpc;
  approvals: ApprovalClient;
  events: MainEvents;
  log: HostLog;
}

// ─── Host runtime: the seam host.ts drives (filled by the H2-0 integration step) ────────────────────────────

export interface HostInit {
  dataDir: string;
  installId: string;
  settings: HostInitSettings;
  platform: NodeJS.Platform;
}

export interface HostReadyInfo {
  sandbox: CodeState['sandbox'];
  git: CodeState['git'];
  ripgrep: boolean;
}

export interface CommandContext {
  /** The command id: receipts make a replayed command idempotent (§5.1). */
  commandId: string;
  signal: AbortSignal;
}

export interface HostRuntime {
  /**
   * Migrations (in the worker), log replay and recovery (§5.1). Reports phases (sent as `pong.phase`); the host
   * answers pings throughout. `skipThreads` are quarantined threads (host.ts' recovery journal): mark them failed
   * (`status_reason: recovery`) and do not recover them. `recovering(threadId)` must be called before each thread's
   * recovery (it is fsynced), and `recovering(null)` when recovery is done.
   */
  start(init: HostInit, io: { phase(phase: HostPhase): void; skipThreads: readonly string[]; recovering(threadId: string | null): Promise<void> }): Promise<HostReadyInfo>;
  /** Commands from main (§13.3). Results are plain data; failures throw GmiError. */
  handle(cmd: HarnessCommand, ctx: CommandContext): Promise<unknown>;
  /** Aborts runs (synthetic results), flushes SQLite (WAL checkpoint). Must finish within graceMs. */
  shutdown(graceMs: number): Promise<void>;
}

export interface HostRuntimeDeps {
  link: MainLink;
  worker: Worker;
  clock: HostClock;
  log: HostLog;
}
export type CreateHostRuntime = (deps: HostRuntimeDeps) => HostRuntime;

// ─── Db (§5.2: node:sqlite behind a small interface) ─────────────────────────────────────────────────────────

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface DbStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = Record<string, SqlValue>>(...params: SqlValue[]): T | undefined;
  all<T = Record<string, SqlValue>>(...params: SqlValue[]): T[];
}

export interface Db {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  /** Synchronous; nested calls become savepoints. Throws roll back. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

// ─── Store (H2-A, §5.2) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Durable event types. The four public ones carry, as payload, the CodeThreadEvent without `threadId` and `seq`
 * (`{type:'item', item}`, `{type:'status', status, reason, queuePosition, queueReason}`, `{type:'todo', todo}`,
 * `{type:'diff', diff}`): main's view-only fallback (readonly-db.ts) reads them that way. The others are internal.
 */
export type PublicEventType = 'item' | 'status' | 'todo' | 'diff';
export type InternalEventType =
  | 'turn.started'
  | 'turn.ended'
  | 'run.transition'
  | 'tool.started'
  | 'tool.finished'
  | 'compaction'
  | 'checkpoint'
  | 'checkpoint.restored'
  | 'notice';
export type DurableEventType = PublicEventType | InternalEventType;

export interface AppendEventInput {
  threadId: string;
  contextId: string;
  runId: string | null;
  turn: number | null;
  step: number | null;
  type: DurableEventType;
  /** Already truncated and redacted: no secrets, outputs ≤ 64 KiB. */
  payload: unknown;
  /** Default: a new `ev_<ulid>`. */
  eventId?: string;
}

export interface StoredEvent extends Required<Omit<AppendEventInput, 'eventId'>> {
  /** The thread's contiguous thread_seq (assigned in the same transaction, §6.6). */
  seq: number;
  eventId: string;
  at: string;
}

export interface ProjectRow {
  id: string;
  rootPath: string;
  name: string;
  defaultBranch: string | null;
  worktreeDir: string;
  setupCommand: string | null;
  trustState: CodeProject['trust']['state'];
  trustHash: string | null;
  trustedAt: string | null;
  refFormat: 'files' | 'reftable';
  addedAt: string;
}

export type ThreadSetupState = 'creating' | 'setting_up' | 'ready' | 'failed';

export interface ThreadRow {
  id: string;
  projectId: string;
  title: string;
  strategy: ThreadStrategy['kind'];
  branch: string | null;
  baseRef: string | null;
  baseSha: string | null;
  worktreePath: string | null;
  /** Recorded at creation; git-safe uses only these (§8.2). */
  gitDir: string | null;
  commonDir: string | null;
  gitPointer: string | null;
  objectDir: string | null;
  setupState: ThreadSetupState;
  settings: CodeThreadSettings;
  status: RunStatus;
  statusReason: string | null;
  costUsd: number;
  tokens: TokenTotals;
  archived: boolean;
  instructionsHash: string | null;
  /** The frozen `<environment>` block of `[user#0]` (§7.1). */
  envBlock: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  threadId: string;
  contextId: string;
  ord: number;
  turn: number | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Stored with their wire ids (§7.1), byte-stable from the first store. */
  toolCalls: GwToolCall[] | null;
  toolCallId: string | null;
  reasoning: string | null;
  reasoningFamily: string | null;
  model: string | null;
  inContext: boolean;
  /** The current turn's request re-inserted after a summary (§7.4). */
  pinned: boolean;
  /** Streaming checkpoint, replaced at step end (§5.2). */
  partial: boolean;
  estTokens: number | null;
  /** A user message queued while a run was active (§6.5). */
  steering?: boolean;
}

export type ToolCallStatus = 'started' | 'succeeded' | 'failed' | 'denied' | 'interrupted' | 'not_executed';

export interface ToolCallRow {
  /** Internal `tc_<ulid>` (spill files, approvals, idempotency keys). */
  id: string;
  wireId: string;
  providerCallId: string | null;
  threadId: string;
  contextId: string;
  runId: string | null;
  turn: number | null;
  step: number | null;
  tool: string;
  /** Raw argument JSON as the model wrote it. */
  args: string;
  status: ToolCallStatus;
  resultMessageId: string | null;
  spillPath: string | null;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApprovalRow {
  requestId: string;
  threadId: string;
  runId: string;
  toolCallId: string | null;
  kind: ApprovalKind;
  request: ApprovalRequest;
  decision: ApprovalDecision | null;
  decidedAt: string | null;
}

export interface CheckpointRow {
  id: string;
  threadId: string;
  turn: number;
  commitSha: string;
  treeSha: string;
  filesChanged: number;
  createdAt: string;
}

export interface CompactionRow {
  id: string;
  threadId: string;
  contextId: string;
  uptoOrd: number;
  summary: string;
  model: string;
  beforeTokens: number;
  afterTokens: number;
  costUsd: number | null;
  createdAt: string;
}

/** Read dedupe ledger (§7.3): lines `[start, end)` of this sha currently in context. */
export interface ReadRow {
  contextId: string;
  path: string;
  sha: string;
  ranges: Array<[number, number]>;
  size: number | null;
  mtimeMs: number | null;
  ord: number | null;
}

export interface UsageStepRow {
  threadId: string;
  contextId: string;
  runId: string | null;
  turn: number | null;
  step: number | null;
  model: string;
  prompt: number;
  cached: number;
  expectedCached: number | null;
  completion: number;
  reasoning: number;
  costUsd: number | null;
  estimated: boolean;
  prefixHash: string | null;
  at: string;
}

export interface McpServerRow {
  id: string;
  scope: 'global' | 'project';
  projectId: string | null;
  config: unknown;
  trustHash: string | null;
  toolHashes: Record<string, string> | null;
  resolvedVersion: string | null;
  enabled: boolean;
}

export interface TrustedFileRow {
  projectId: string;
  path: string;
  sha: string;
  content: string;
}

export interface Store {
  readonly schemaVersion: number;
  /** Synchronous; nested calls are savepoints. Every write method may be used inside or outside one. */
  transaction<T>(fn: () => T): T;
  events: {
    /** Assigns the next contiguous thread_seq in the same transaction (§6.6). */
    append(input: AppendEventInput): StoredEvent;
    list(threadId: string, opts?: { afterSeq?: number; beforeSeq?: number; limit?: number; types?: DurableEventType[] }): StoredEvent[];
    byRun(runId: string): StoredEvent[];
    lastSeq(threadId: string): number;
  };
  /** §5.1: a replayed command returns the stored result instead of running again. */
  receipts: {
    get(commandId: string): { threadId: string | null; at: string; result: unknown } | null;
    put(commandId: string, threadId: string | null, result: unknown): void;
  };
  projects: {
    get(id: string): ProjectRow | null;
    list(): ProjectRow[];
    upsert(row: ProjectRow): void;
    remove(id: string): void;
  };
  trustedFiles: {
    list(projectId: string): TrustedFileRow[];
    get(projectId: string, path: string): TrustedFileRow | null;
    /** Replaces the project's whole snapshot (at trust time, §12.1). */
    replace(projectId: string, files: TrustedFileRow[]): void;
  };
  threads: {
    get(id: string): ThreadRow | null;
    list(opts?: { projectId?: string; archived?: boolean }): ThreadRow[];
    insert(row: ThreadRow): void;
    update(id: string, patch: Partial<Omit<ThreadRow, 'id' | 'projectId' | 'createdAt'>>): ThreadRow;
    /** Removes every row of the thread (events, messages, tool calls, approvals, reads, todos, usage …). */
    delete(id: string): void;
    /** Projection for the renderer (§12.3). */
    summaries(opts?: { projectId?: string; archived?: boolean }): CodeThreadSummary[];
  };
  messages: {
    /** Assigns the next `ord` of the context. */
    append(row: Omit<MessageRow, 'ord'>): MessageRow;
    /** Upserts the one `partial = 1` row of a streaming item (§5.2). */
    upsertPartial(row: Omit<MessageRow, 'ord' | 'partial'>): MessageRow;
    /** Replaces the partial row by the final message. */
    finalizePartial(id: string, row: Omit<MessageRow, 'id' | 'ord' | 'partial'>): MessageRow;
    list(contextId: string, opts?: { inContextOnly?: boolean; afterOrd?: number }): MessageRow[];
    /** Compaction: marks `ord <= uptoOrd` out of context (never edits content, invariant 3). */
    markOutOfContext(contextId: string, uptoOrd: number): number;
    lastOrd(contextId: string): number;
  };
  toolCalls: {
    insert(row: ToolCallRow): void;
    get(id: string): ToolCallRow | null;
    byWireId(contextId: string, wireId: string): ToolCallRow | null;
    update(id: string, patch: Partial<Omit<ToolCallRow, 'id' | 'threadId' | 'contextId' | 'wireId'>>): void;
    /** Calls with `tool.started` but no result (crash recovery, §5.1). */
    unsettled(threadId?: string): ToolCallRow[];
  };
  approvals: {
    insert(row: ApprovalRow): void;
    decide(requestId: string, decision: ApprovalDecision, at: string): void;
    pending(threadId?: string): ApprovalRow[];
    get(requestId: string): ApprovalRow | null;
  };
  rules: {
    list(opts?: { projectId?: string | null; threadId?: string | null }): PermissionRule[];
    insert(rule: PermissionRule): void;
    delete(id: string): boolean;
  };
  checkpoints: {
    insert(row: CheckpointRow): void;
    list(threadId: string): CheckpointRow[];
    get(id: string): CheckpointRow | null;
  };
  compactions: {
    insert(row: CompactionRow): void;
    list(contextId: string): CompactionRow[];
  };
  reads: {
    get(contextId: string, path: string): ReadRow | null;
    put(row: ReadRow): void;
    delete(contextId: string, path: string): void;
    list(contextId: string): ReadRow[];
  };
  usage: {
    insert(row: UsageStepRow): void;
    list(threadId: string, opts?: { runId?: string; contextId?: string }): UsageStepRow[];
  };
  mcpServers: {
    list(opts?: { projectId?: string | null }): McpServerRow[];
    get(id: string): McpServerRow | null;
    upsert(row: McpServerRow): void;
    remove(id: string): void;
  };
  todos: {
    get(contextId: string): TodoItem[];
    put(contextId: string, threadId: string, items: TodoItem[]): void;
  };
  /** §8.2 ref guard: persisted before each run, so a crash does not lose it. */
  refSnapshots: {
    put(runId: string, threadId: string, refs: Record<string, string>): void;
    get(runId: string): { threadId: string; refs: Record<string, string>; at: string } | null;
    delete(runId: string): void;
    list(): Array<{ runId: string; threadId: string }>;
  };
  sensitiveHashes: {
    get(threadId: string): Record<string, string | null>;
    put(threadId: string, hashes: Record<string, string | null>): void;
  };
  /** §12.2 stale-lock detection. */
  gitProcs: {
    add(pid: number, threadId: string | null): void;
    remove(pid: number): void;
    list(): Array<{ pid: number; threadId: string | null; startedAt: string }>;
  };
  /** Online backup to `dest` (before migrations the store copies the file to `harness.sqlite.bak-<v>`). */
  backup(dest: string): Promise<void>;
  close(): void;
}

export interface OpenStoreOptions {
  /** harnessPaths(dataDir).db. Created 0600 in a 0700 directory. */
  file: string;
  worker: Worker;
  clock: HostClock;
  log: HostLog;
  phase(phase: HostPhase): void;
}
export type OpenStore = (opts: OpenStoreOptions) => Promise<Store>;

// ─── Worktree mutation lock (§6.1 invariant 4, §8.6) ─────────────────────────────────────────────────────────

/** One per thread, shared by the parent and its subagents: every mutation (edit, write, apply_patch, bash) holds it. */
export interface MutationLock {
  /** Resolves with the release function in FIFO order; rejects with GmiError('cancelled') if `signal` aborts first. */
  acquire(threadId: string, signal?: AbortSignal): Promise<() => void>;
  isHeld(threadId: string): boolean;
}

// ─── Sandbox (H2-E, §8.3–8.4) ────────────────────────────────────────────────────────────────────────────────

/** `exec`: bash, stdio MCP, setup. `readonly`: the allowlisted read-only commands and host-side rg (§8.3). */
export type SandboxProfile = 'exec' | 'readonly';

/** What GitService.sandboxMounts() returns for a thread (§8.3 mounts; §8.4 git env). */
export interface SandboxGitMounts {
  /** `--ro-bind` (pointer files, the common dir, gitdir/commondir/config.worktree …). */
  readOnly: string[];
  /** `--bind` (this worktree's metadata dir, this thread's ref dirs, the thread object dir). */
  writable: string[];
  /** GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG_COUNT/KEY_0/VALUE_0 (gc.auto=0). */
  env: Record<string, string>;
  /** False for root / existing_worktree threads and reftable repos: all git metadata read-only (§8.3). */
  perThreadRefs: boolean;
}

export interface SandboxSpec {
  profile: SandboxProfile;
  threadId: string;
  /** Run as `/bin/bash --noprofile --norc -c <command>` inside the sandbox … */
  command?: string;
  /** … or exactly this argv (host-side rg, MCP stdio servers, the self-test's `true`). */
  argv?: string[];
  /** Must pass the path policy (inside the worktree). */
  cwd: string;
  worktree: string;
  git: SandboxGitMounts | null;
  /** Existing execution-sensitive and instruction paths, `--ro-bind` unless `sensitiveWrites` (§8.2.6). */
  sensitivePaths: string[];
  sensitiveWrites: boolean;
  /** Secret files found in the worktree, masked with `/dev/null` (§8.3). */
  maskedFiles: string[];
  /** `proxy`: the app's CONNECT proxy; `shared`: `--share-net` per command (`local_network` flag); `off`: none. */
  network: 'off' | 'proxy' | 'shared';
  /** harnessPaths().cacheDir(threadId), or null (readonly profile). */
  cacheDir: string | null;
  /** Already built by sandbox/env.ts from the allowlist (§8.4). */
  env: Record<string, string>;
  timeoutMs: number;
}

export interface SandboxRunIo {
  signal: AbortSignal;
  /** Live output (stdout and stderr interleaved), for the 32 KiB + 1 Hz tail UI stream (§6.6). */
  onOutput?(chunk: string): void;
  /** Full output also goes here (spill, §8.7). */
  spillFile?: string | null;
  /** Bytes kept in `output` (head + tail kept by the tool, not here). Default 1 MiB. */
  maxCaptureBytes?: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  output: string;
  outputBytes: number;
  outputTruncated: boolean;
}

export interface SandboxRunner {
  readonly kind: CodeState['sandbox']['kind'];
  /** Last self-test result. */
  state(): CodeState['sandbox'];
  /** Runs the production `exec` argv with `true` and asserts no host socket, no network, empty HOME, ro git (§8.3). */
  selftest(): Promise<CodeState['sandbox']>;
  /** The exact argv `run` would spawn (snapshot tests; the self-test uses this builder). */
  buildArgv(spec: SandboxSpec): string[];
  /** Kills the process group on abort/timeout (SIGTERM, SIGKILL after 5 s). Never throws for a non-zero exit. */
  run(spec: SandboxSpec, io: SandboxRunIo): Promise<SandboxRunResult>;
}

// ─── Permissions (H2-E, §9) ──────────────────────────────────────────────────────────────────────────────────

/** What the engine sees of one tool call (the tool's `subject()`). */
export interface PermissionSubject {
  tool: string;
  kind: ApprovalKind;
  title: string;
  command?: string;
  cwd?: string;
  /** Absolute, policy-checked paths. */
  paths?: string[];
  host?: string;
  url?: string;
  server?: string;
  args?: unknown;
  diff?: string;
  costUsd?: number | null;
  /** Flags the tool already knows (e.g. execution_sensitive, outside_worktree); the engine adds its own. */
  risk: RiskFlag[];
}

export interface PermissionContext {
  threadId: string;
  projectId: string;
  runId: string;
  mode: RuntimeMode;
  /** Scheduled or eval runs: `ask` becomes `deny` (§6.4, §9.3). */
  unattended: boolean;
  sandbox: CodeState['sandbox'];
  worktree: string;
}

export type PermissionVerdict =
  | { effect: 'allow'; via: 'rule' | 'mode' | 'preset'; ruleId: string | null; risk: RiskFlag[]; profile: SandboxProfile | null }
  | { effect: 'deny'; via: 'hard' | 'rule' | 'unattended'; ruleId: string | null; reason: string; risk: RiskFlag[] }
  | { effect: 'ask'; risk: RiskFlag[]; suggestedRule: PermissionRuleDraft | null; reason: string };

export interface CommandClassification {
  /** Lexed argv of a simple command; null for compound commands. */
  argv: string[] | null;
  compound: boolean;
  destructive: boolean;
  /** On the read-only allowlist with every flag rule satisfied (§9.2) → runs in the `readonly` profile. */
  readOnly: boolean;
  /** Prefix pattern for "Always allow" (`npm test`), never `*`. */
  suggestedPattern: string | null;
}

export interface PermissionEngine {
  evaluate(subject: PermissionSubject, ctx: PermissionContext): PermissionVerdict;
  classifyCommand(command: string): CommandClassification;
  /**
   * Persists the rule a decision implies (allow_thread → a thread rule; allow_always → the decision's rule), after
   * main's broker accepted it. Returns the rule, or null for one-shot decisions.
   */
  record(request: ApprovalRequest, decision: ApprovalDecision, ctx: PermissionContext): PermissionRule | null;
  listRules(opts?: { projectId?: string | null; threadId?: string | null }): PermissionRule[];
  deleteRule(ruleId: string): boolean;
  /** `.gmi-desk/permissions.json` from the trusted snapshot: deny/ask only (§9.1). Returns the rules ignored. */
  loadProjectRules(projectId: string, rules: PermissionRuleDraft[]): PermissionRuleDraft[];
}

// ─── Tools (H2-D registry + file tools; H2-E shell/web; H3 task/mcp; §8) ────────────────────────────────────

export type ToolClass = 'read' | 'mutate' | 'shell' | 'state' | 'user' | 'subagent' | 'network' | 'mcp' | 'remote';

export interface ToolCallInfo {
  /** Internal `tc_<ulid>`. */
  id: string;
  /** The id the model sees (§7.1). */
  wireId: string;
  name: string;
  /** Raw argument JSON. */
  rawArgs: string;
}

export interface ToolRunContext {
  /** Additive (H2 integration): the user's "allow writes to sensitive files" on this call's allow_once (§8.2.6). */
  sensitiveWrites?: boolean;
  /**
   * Additive (H2 integration): asks the user a question through the loop (awaiting_user, wall clock paused; denied
   * at once in unattended runs). The `question` tool uses it when present.
   */
  askUser?(question: { question: string; options?: string[] }): Promise<ApprovalDecision>;
  threadId: string;
  projectId: string;
  contextId: string;
  runId: string;
  turn: number;
  step: number;
  call: ToolCallInfo;
  worktree: string;
  dataDir: string;
  settings: CodeThreadSettings;
  signal: AbortSignal;
  store: Store;
  sandbox: SandboxRunner;
  git: GitService;
  lock: MutationLock;
  perm: PermissionEngine;
  /** Live output for the UI (host batches deltas, §6.6). */
  emitOutput(chunk: string): void;
  clock: HostClock;
  log: HostLog;
}

export type ToolErrorKind = 'invalid_args' | 'execution' | 'denied' | 'timeout' | 'cancelled' | 'not_executed';

export interface ToolResult {
  ok: boolean;
  /** Execution errors count toward the "failing steps" doom signal; a command that ran and exited non-zero is ok:false with kind null (§6.4). */
  errorKind: ToolErrorKind | null;
  /** Model-facing text, already truncated with markers (§7.3, §8.7). */
  content: string;
  preview: ToolOutputPreview;
  exitCode?: number | null;
  spillId?: string | null;
  /** For the doom detector, the file ledger and read dedupe. */
  effects?: {
    readPaths?: string[];
    changedPaths?: string[];
    command?: string | null;
    contentHashes?: Record<string, string>;
    /** Additive (H2 integration): the read-ledger range this result recorded (the loop trims it when the step cap cuts the result). */
    readRange?: { key: string; start: number; end: number };
    /** Additive (H2 integration): execution-sensitive paths a command changed (the loop shows a public notice). */
    sensitiveChanged?: string[];
  };
}

export type ParsedArgs<A> = { ok: true; args: A } | { ok: false; error: string };

export interface ToolDefinition<A = unknown> {
  name: string;
  description: string;
  /** JSON schema; serialised canonically (sorted keys) into the frozen tool block (§7.1). */
  parameters: Record<string, unknown>;
  class: ToolClass;
  parse(raw: unknown): ParsedArgs<A>;
  /** Eligible for a parallel read batch (§6.2). */
  readOnly(args: A): boolean;
  /** Takes the mutation lock and triggers the turn's checkpoint before it runs (§6.1, §7.7). */
  mutates(args: A): boolean;
  /** What the permission engine evaluates. */
  subject(args: A, ctx: ToolRunContext): PermissionSubject;
  title(args: A): string;
  run(args: A, ctx: ToolRunContext): Promise<ToolResult>;
}

export interface ToolRegistry {
  /** Throws on a duplicate name. Returns the unregister function. */
  register<A>(def: ToolDefinition<A>): () => void;
  get(name: string): ToolDefinition | null;
  list(): ToolDefinition[];
  /** Built-ins sorted by name, then MCP tools by server and name; canonical JSON (§7.1). Frozen per turn by the loop. */
  definitions(filter?: (def: ToolDefinition) => boolean): GwToolDef[];
}

// ─── Compaction (H2-C, §7.3–7.5) ─────────────────────────────────────────────────────────────────────────────

export interface CeilingInput {
  /** The catalog's context length; null → 128k (§7.4). */
  modelContextTokens: number | null;
  /** Thread setting (default 160k, DH10); null = the model's full window. */
  maxContextTokens: number | null;
  maxOutputTokens: number;
  economy: boolean;
  /** Next price tier boundary in prompt tokens, or null. */
  tierBoundaryTokens: number | null;
  prefixTokens: number;
}

export interface Ceiling {
  windowTokens: number;
  reserveTokens: number;
  ceilingTokens: number;
  keepTokens: number;
  /** `disabled`: economy requested but the tier is too small (notice `economy_disabled`). */
  economy: 'off' | 'on' | 'disabled';
  tierBoundaryTokens: number | null;
}

export type CompactionTrigger = 'tokens' | 'messages' | 'cost';

export interface TriggerInput {
  ceiling: Ceiling;
  /** S = lastMeasuredPrompt + k·est(new messages) (§7.2). */
  sizeTokens: number;
  messageCount: number;
  /** Projected cached cost of the next step, or null when the price is unknown. */
  nextStepCachedUsd: number | null;
  perTurnUsd: number | null;
}

export interface CompactionRequest {
  threadId: string;
  contextId: string;
  runId: string;
  turn: number;
  /** The thread's model (same-model summaries reuse its prefix). */
  model: string;
  compactionModel: string;
  reason: CompactionTrigger | 'overflow';
  /** Layer 2 (§7.5): the target in tokens (85/70/50/35 % of the rejected size). */
  shrinkToTokens?: number;
  signal: AbortSignal;
}

export interface CompactionResult {
  compactionId: string;
  uptoOrd: number;
  beforeTokens: number;
  afterTokens: number;
  model: string;
  costUsd: number | null;
  layer: 1 | 2;
  usedPrecomputed: boolean;
}

export interface Compactor {
  ceiling(input: CeilingInput): Ceiling;
  trigger(input: TriggerInput): CompactionTrigger | null;
  /** 85 % of a trigger and S ≥ 32k (§7.4). */
  shouldPrecompute(input: TriggerInput): boolean;
  /** Background summary at `idle` priority; at most one per context; superseded ones are dropped. */
  precompute(req: Omit<CompactionRequest, 'signal' | 'reason' | 'shrinkToTokens'>): void;
  /** Swaps in the precomputed summary when allowed, otherwise summarises (`foreground`). Throws context_overflow when nothing fits. */
  compact(req: CompactionRequest): Promise<CompactionResult>;
  /** Range ledger hook (§7.3): drops read ranges whose content left the context. */
  pruneReads(contextId: string, uptoOrd: number): void;
  cancel(contextId: string): void;
}

export interface CompactorDeps {
  store: Store;
  gateway: GatewayClient;
  clock: HostClock;
  log: HostLog;
}
export type CreateCompactor = (deps: CompactorDeps) => Compactor;

// ─── Git (H2-G, §7.7, §8.2, §8.3, §12.2) ─────────────────────────────────────────────────────────────────────

/** Paths recorded at thread creation; every host git call uses only these (git-safe, §8.2). */
export interface ThreadGitRecord {
  threadId: string;
  projectId: string;
  strategy: ThreadStrategy['kind'];
  projectRoot: string;
  worktreePath: string;
  gitDir: string;
  commonDir: string;
  /** Exact contents of `<worktree>/.git` at creation. */
  gitPointer: string | null;
  objectDir: string | null;
  branch: string | null;
  baseRef: string | null;
  baseSha: string | null;
  refFormat: 'files' | 'reftable';
}

export interface RefChange {
  ref: string;
  before: string | null;
  after: string | null;
}

export interface GitRecoveryReport {
  /** Threads whose worktree creation or setup was rolled back or completed. */
  reconciled: Array<{ threadId: string; outcome: 'ready' | 'rolled_back' | 'failed' }>;
  removedLocks: string[];
  reportedLocks: string[];
  movedRefs: Array<{ threadId: string; runId: string; changes: RefChange[] }>;
}

export interface GitService {
  /** `git --version`, or null when git is missing. */
  version(): Promise<string | null>;
  /** Locked worktree under the project's worktree dir, branch `gmi/<id6>/<slug>` (§12.2). */
  createWorktree(input: { threadId: string; project: ProjectRow; strategy: ThreadStrategy; slug: string }): Promise<ThreadGitRecord>;
  removeWorktree(record: ThreadGitRecord, opts: { deleteBranch: boolean }): Promise<void>;
  /** Pointer verification (§8.2): throws GmiError('permission_denied', detail 'git_tampered') on mismatch. */
  verify(record: ThreadGitRecord): Promise<void>;
  sandboxMounts(record: ThreadGitRecord): Promise<SandboxGitMounts>;
  /** Imports the thread object dir into the common store, verified, under the per-repo mutex (§8.3). */
  importObjects(record: ThreadGitRecord): Promise<{ imported: number }>;
  /** Snapshot-repo checkpoint (§7.7); reuses the previous tree when nothing changed. */
  checkpoint(record: ThreadGitRecord, turn: number): Promise<CheckpointRow>;
  restoreCheckpoint(record: ThreadGitRecord, checkpoint: CheckpointRow): Promise<{ removed: string[] }>;
  deleteCheckpoints(record: ThreadGitRecord): Promise<void>;
  diff(record: ThreadGitRecord, opts?: { against?: 'base' | 'checkpoint'; checkpoint?: CheckpointRow }): Promise<DiffFile[]>;
  fileDiff(record: ThreadGitRecord, path: string, opts?: { against?: 'base' | 'checkpoint'; checkpoint?: CheckpointRow }): Promise<DiffFile>;
  /** `path` must be in the current diff list (literal pathspec). */
  discard(record: ThreadGitRecord, path: string): Promise<void>;
  commit(record: ThreadGitRecord, message: string): Promise<{ sha: string }>;
  merge(record: ThreadGitRecord, method: 'merge' | 'squash'): Promise<{ sha: string }>;
  exportPatch(record: ThreadGitRecord): Promise<string>;
  /** `git status --short`, ≤ 2 KiB (the volatile `<context>` block, §7.1). */
  statusShort(record: ThreadGitRecord): Promise<string>;
  /** Ref guard (§8.2). */
  refSnapshot(record: ThreadGitRecord): Promise<Record<string, string>>;
  compareRefs(record: ThreadGitRecord, before: Record<string, string>): Promise<RefChange[]>;
  restoreRef(record: ThreadGitRecord, ref: string, sha: string): Promise<void>;
  /** sha256 of every execution-sensitive and instruction path, tracked and ignored (§8.2.6). Null = absent. */
  sensitiveHashes(record: ThreadGitRecord): Promise<Record<string, string | null>>;
  /** Host start (§5.1): half-made worktrees, stale locks of ours, interrupted runs' ref snapshots. */
  recover(records: ThreadGitRecord[], interrupted: Array<{ runId: string; threadId: string; refs: Record<string, string> }>): Promise<GitRecoveryReport>;
  // Additive (H2 integration; optional so fakes stay valid). The real service (git/index.ts) has all of them.
  /** `git apply` in the worktree (strict). */
  applyPatch?(record: ThreadGitRecord, patch: string, opts?: { check?: boolean }): Promise<{ ok: boolean; error: string | null }>;
  /** Existing sensitive paths (absolute) the sandbox mounts read-only (§8.2.6), including the in-repo hooks dir. */
  listSensitivePaths?(record: ThreadGitRecord): Promise<string[]>;
  /** Repo-local config keys that can run code (main's confirmation before commit and merge). */
  execCapableConfig?(record: ThreadGitRecord): Promise<string[]>;
  clearStaleLocks?(record: ThreadGitRecord): Promise<{ removed: string[]; reported: string[] }>;
  /** The in-repo `core.hooksPath` dir relative to the worktree, or null. */
  hooksPath?(record: ThreadGitRecord): Promise<string | null>;
}

