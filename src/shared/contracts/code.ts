/**
 * Code tab: projects (git repos), parallel agent threads on git worktrees, approvals, review.
 * The agent loop runs in the harness host; model traffic goes through the GMI gateway in main.
 */
import type { ReasoningEffort } from './chat';
import type { GatewayStatus } from './gateway';

export type RuntimeId = 'gmi' | 'opencode';
export type RuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';

export interface CodeProject {
  id: string;
  name: string;
  /** Absolute, realpath. */
  rootPath: string;
  defaultBranch: string | null;
  trust: { state: 'untrusted' | 'trusted' | 'changed'; configHash: string | null; trustedAt: string | null };
  worktreeDir: string;
  setupCommand: string | null;
  addedAt: string;
  threadCount: number;
}

export type ThreadStrategy =
  /** A user-chosen branch name becomes `gmi/<id6>/<name>` (one ref directory per thread, §12.2). */
  | { kind: 'worktree'; baseRef: string; branch?: string | null }
  | { kind: 'existing_worktree'; path: string }
  | { kind: 'root' };

export interface ThreadBudget {
  perTurnUsd: number | null;
  perThreadUsd: number | null;
  maxStepsPerTurn: number;
  maxTurnMinutes: number;
}

export interface CodeThreadSettings {
  runtime: RuntimeId;
  model: string;
  subagentModel: string | null;
  compactionModel: string | null;
  /** Titles and commit messages: a cheap model id, or GMI Router ('router'). */
  sideTaskModel: string | null;
  mode: RuntimeMode;
  reasoningEffort: ReasoningEffort | null;
  maxOutputTokens: number;
  /** Keep prompts below the model's next long-context price tier (switched off per model when the tier is too small). */
  economy: boolean;
  /** Working window, default 160k (DH10). Null = the model's full window. Raising it is a loosening (native dialog). */
  maxContextTokens: number | null;
  webFetch: 'off' | 'ask' | 'allowlist';
  /** Shell network inside the sandbox, always through the app's proxy (§8.3). */
  network: 'off' | 'ask';
  budget: ThreadBudget;
  /** compute.md resource bound to this thread (H4). */
  computerId: string | null;
}

export const CODE_DEFAULTS = {
  maxStepsPerTurn: 50,
  /** Active minutes: paused while awaiting approval or the user. */
  maxTurnMinutes: 30,
  perTurnUsd: 1,
  perThreadUsd: 5,
  maxOutputTokens: 16_384,
  maxContextTokens: 160_000,
  /** Compact when the next step's cached cost would exceed perTurnUsd / this. */
  compactCostDivisor: 20,
  /** Compact above this many messages in context (main refuses 2,048). */
  compactMessageCount: 1_500,
  mode: 'auto-accept-edits',
} as const satisfies Partial<ThreadBudget> & {
  maxOutputTokens: number;
  maxContextTokens: number;
  compactCostDivisor: number;
  compactMessageCount: number;
  mode: RuntimeMode;
};

/** Host and main share the thread defaults: a new thread's settings when the user changes nothing. */
export function defaultCodeThreadSettings(over: Partial<CodeThreadSettings> = {}): CodeThreadSettings {
  return {
    runtime: 'gmi',
    model: '',
    subagentModel: null,
    compactionModel: null,
    sideTaskModel: null,
    mode: CODE_DEFAULTS.mode,
    reasoningEffort: null,
    maxOutputTokens: CODE_DEFAULTS.maxOutputTokens,
    economy: false,
    maxContextTokens: CODE_DEFAULTS.maxContextTokens,
    webFetch: 'off',
    network: 'off',
    computerId: null,
    ...over,
    budget: {
      perTurnUsd: CODE_DEFAULTS.perTurnUsd,
      perThreadUsd: CODE_DEFAULTS.perThreadUsd,
      maxStepsPerTurn: CODE_DEFAULTS.maxStepsPerTurn,
      maxTurnMinutes: CODE_DEFAULTS.maxTurnMinutes,
      ...(over.budget ?? {}),
    },
  };
}

export type RunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_user'
  | 'compacting'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type QueueReason = 'tpm' | 'concurrency' | 'breaker' | 'budget' | 'offline';

export interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

export interface CodeThreadSummary {
  id: string;
  projectId: string;
  title: string;
  strategy: ThreadStrategy['kind'];
  branch: string | null;
  worktreePath: string | null;
  status: RunStatus;
  statusReason: string | null;
  pendingApprovals: number;
  /** Position in the gateway queue while `queued`. */
  queuePosition: number | null;
  queueReason: QueueReason | null;
  model: string;
  mode: RuntimeMode;
  costUsd: number;
  tokens: TokenTotals;
  diff: DiffStat | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

export interface ContextMeter {
  windowTokens: number;
  ceilingTokens: number;
  usedTokens: number;
  reserveTokens: number;
  /** cached / prompt of the last request. */
  cachedRatio: number | null;
  compactions: number;
  tierBoundaryTokens: number | null;
  messageCount: number;
  /** Main's display estimate of the next step at the expected cache share (§4.4). Null: unknown price. */
  nextStepUsd: number | null;
  /** usedTokens is an estimate (no measured usage yet since the last change). */
  estimated: boolean;
}

export interface StepUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  estimated: boolean;
  model: string;
  latencyMs: number | null;
}

export type ToolStatus = 'pending' | 'awaiting_approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'interrupted';

export interface ToolOutputPreview {
  text: string;
  truncated: boolean;
  totalBytes: number;
  spillId: string | null;
  exitCode?: number | null;
}

export type NoticeReason =
  | 'step_cap'
  | 'cost_cap'
  | 'time_cap'
  | 'budget'
  | 'doom_loop'
  | 'overflow'
  | 'output_limit'
  | 'interrupted'
  | 'sandbox_unavailable'
  | 'rate_limited'
  | 'model_error'
  | 'checkpoint_restored'
  | 'instructions_changed'
  | 'ref_changed'
  | 'cache_low'
  | 'execution_sensitive'
  | 'git_tampered'
  | 'economy_disabled'
  | 'offline';

export type ApprovalKind = 'command' | 'file-change' | 'file-read' | 'network' | 'mcp' | 'mcp-elicitation' | 'compute' | 'question';

export type RiskFlag =
  | 'network'
  | 'outside_worktree'
  | 'destructive'
  | 'execution_sensitive'
  | 'secret_path'
  | 'unsandboxed'
  | 'costs_money'
  | 'compound_command'
  | 'changed_tool'
  /** Network without the proxy: reaches localhost and the LAN (§8.3). */
  | 'local_network'
  /** MCP server whose package version is not pinned (§10.2). */
  | 'unpinned';

export interface PermissionRuleDraft {
  tool: string;
  pattern: string | null;
  effect: 'allow' | 'deny';
  scope: 'thread' | 'project' | 'global';
}

export interface PermissionRule extends PermissionRuleDraft {
  id: string;
  projectId: string | null;
  threadId: string | null;
  source: 'preset' | 'user' | 'project_file';
  createdAt: string;
}

export interface ApprovalRequest {
  requestId: string;
  threadId: string;
  runId: string;
  toolCallId: string | null;
  kind: ApprovalKind;
  tool: string;
  title: string;
  detail: {
    command?: string;
    cwd?: string;
    paths?: string[];
    /** Unified diff preview, ≤ 200 lines. */
    diff?: string;
    url?: string;
    host?: string;
    server?: string;
    /** Pretty JSON, ≤ 4 KiB. */
    args?: string;
    costUsd?: number | null;
    question?: string;
    options?: string[];
  };
  risk: RiskFlag[];
  suggestedRule: PermissionRuleDraft | null;
  /** Filled by main; any other decision is refused (§9.4). */
  allowedDecisions: Array<ApprovalDecision['kind']>;
  createdAt: string;
  expiresAt: string | null;
}

export type ApprovalDecision =
  /** sensitiveWrites: lets this one command write execution-sensitive files (§8.2.6). */
  | { kind: 'allow_once'; sensitiveWrites?: boolean }
  | { kind: 'allow_thread' }
  | { kind: 'allow_always'; rule: PermissionRuleDraft }
  | { kind: 'deny'; feedback?: string }
  | { kind: 'answer'; text: string }
  | { kind: 'cancel_run' };

/** `seq` on timeline items and durable events = the thread's contiguous thread_seq (§6.6). */
export type TimelineItem =
  | { kind: 'user'; id: string; seq: number; turn: number; text: string; steering: boolean; at: string }
  | {
      kind: 'assistant';
      id: string;
      seq: number;
      turn: number;
      step: number;
      text: string;
      reasoning: string | null;
      model: string;
      usage: StepUsage | null;
      status: 'streaming' | 'complete' | 'stopped' | 'error';
      at: string;
    }
  | {
      kind: 'tool';
      id: string;
      seq: number;
      turn: number;
      step: number;
      toolCallId: string;
      tool: string;
      title: string;
      argsPreview: string;
      status: ToolStatus;
      output: ToolOutputPreview | null;
      durationMs: number | null;
      at: string;
    }
  | { kind: 'approval'; id: string; seq: number; request: ApprovalRequest; decision: ApprovalDecision | null }
  | { kind: 'compaction'; id: string; seq: number; beforeTokens: number; afterTokens: number; model: string; costUsd: number | null; at: string }
  | { kind: 'checkpoint'; id: string; seq: number; checkpointId: string; turn: number; filesChanged: number; at: string }
  | { kind: 'subagent'; id: string; seq: number; toolCallId: string; agent: string; model: string; status: RunStatus; summary: string | null; costUsd: number | null }
  | { kind: 'notice'; id: string; seq: number; level: 'info' | 'warning' | 'error'; reason: NoticeReason; text: string; at: string };

export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  /** Execution-sensitive path (hooks, workflows, scripts, .envrc …). */
  sensitive: boolean;
  /** Null in list views; filled by getFileDiff. */
  hunks: Array<{ header: string; lines: DiffLine[] }> | null;
  tooLarge: boolean;
}

export interface CheckpointInfo {
  id: string;
  turn: number;
  createdAt: string;
  filesChanged: number;
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface CodeThread extends CodeThreadSummary {
  settings: CodeThreadSettings;
  baseRef: string | null;
  checkpoints: CheckpointInfo[];
  todo: TodoItem[];
  meter: ContextMeter;
  /** Last thread_seq. */
  lastSeq: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  scope: 'global' | 'project';
  projectId: string | null;
  transport:
    | { type: 'stdio'; command: string; args: string[]; envNames: string[]; cwd: string | null; network: boolean }
    | { type: 'http'; url: string; auth: 'none' | 'bearer' | 'oauth' };
  enabled: boolean;
  toolPolicy: Record<string, 'allow' | 'ask' | 'deny'>;
}

export interface McpServerStatus extends McpServerConfig {
  state: 'stopped' | 'starting' | 'ready' | 'needs_trust' | 'needs_auth' | 'error';
  /** npx/uvx/pipx package version resolved at first start; `unpinned` when the command names none (§10.2). */
  resolvedVersion: string | null;
  unpinned: boolean;
  tools: Array<{ name: string; changed: boolean; policy: 'allow' | 'ask' | 'deny' }>;
  error: string | null;
}

export interface CodeState {
  hostState: 'starting' | 'ready' | 'restarting' | 'crashed' | 'stopped';
  /** Main serves threads read-only from the database while the host is crashed (§5.1). */
  viewOnly: boolean;
  sandbox: { kind: 'bwrap' | 'seatbelt' | 'none'; ok: boolean; detail: string | null; network: 'proxy' | 'shared_per_command' | 'none' };
  git: { ok: boolean; version: string | null };
  ripgrep: boolean;
  gateway: GatewayStatus;
  pendingApprovals: number;
  mock: boolean;
}

/** Durable events carry `seq` = the thread's contiguous thread_seq; ephemeral ones (delta, meter) carry null (§6.6). */
export type CodeThreadEvent =
  | { threadId: string; seq: number; type: 'item'; item: TimelineItem }
  | { threadId: string; seq: number; type: 'status'; status: RunStatus; reason: string | null; queuePosition: number | null; queueReason: QueueReason | null }
  | { threadId: string; seq: number; type: 'todo'; todo: TodoItem[] }
  | { threadId: string; seq: number; type: 'diff'; diff: DiffStat }
  | { threadId: string; seq: null; type: 'delta'; itemId: string; field: 'text' | 'reasoning' | 'output' | 'args'; text: string; offset: number }
  | { threadId: string; seq: null; type: 'meter'; meter: ContextMeter; tokens: TokenTotals; costUsd: number };

export interface CodeApi {
  getState(): Promise<CodeState>;
  listProjects(): Promise<CodeProject[]>;
  /** Native folder picker in main; must be a git repository. Null when cancelled. */
  addProject(): Promise<CodeProject | null>;
  removeProject(projectId: string, opts?: { removeWorktrees?: boolean }): Promise<void>;
  /** Native dialog listing the instruction files, MCP commands and permission files to trust. */
  trustProject(projectId: string): Promise<CodeProject>;
  updateProject(projectId: string, patch: { name?: string; setupCommand?: string | null; worktreeDir?: string }): Promise<CodeProject>;
  listThreads(opts?: { projectId?: string; archived?: boolean }): Promise<CodeThreadSummary[]>;
  getThread(threadId: string): Promise<CodeThread>;
  getTimeline(threadId: string, opts?: { afterSeq?: number; beforeSeq?: number; limit?: number }): Promise<{ items: TimelineItem[]; hasMore: boolean; lastSeq: number }>;
  createThread(projectId: string, init: { title?: string; strategy: ThreadStrategy; settings?: Partial<CodeThreadSettings> }): Promise<CodeThread>;
  /** Loosening (isLoosening, §9.4: mode, caps, network, webFetch, computerId, window) shows a native confirmation in main. */
  updateThread(threadId: string, patch: { title?: string; settings?: Partial<CodeThreadSettings> }): Promise<CodeThread>;
  archiveThread(threadId: string, opts: { removeWorktree: boolean; deleteBranch: boolean }): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  send(threadId: string, text: string): Promise<{ runId: string; turn: number; budgetWarning: string | null }>;
  /** Queued into the running turn after the current step. */
  steer(threadId: string, text: string): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  /** Continues an interrupted or stopped run. */
  resume(threadId: string): Promise<{ runId: string }>;
  /** Main refuses decisions outside `allowedDecisions` and shows a native dialog for persistent or broader grants. */
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  listPendingApprovals(): Promise<ApprovalRequest[]>;
  getDiff(threadId: string, opts?: { against?: 'base' | 'checkpoint'; checkpointId?: string }): Promise<DiffFile[]>;
  getFileDiff(threadId: string, path: string, opts?: { against?: 'base' | 'checkpoint'; checkpointId?: string }): Promise<DiffFile>;
  /** `path` must be in the thread's current diff list (literal pathspec). */
  discardFile(threadId: string, path: string): Promise<void>;
  restoreCheckpoint(threadId: string, checkpointId: string): Promise<void>;
  commit(threadId: string, message: string): Promise<{ sha: string }>;
  suggestCommitMessage(threadId: string): Promise<{ message: string; costUsd: number | null }>;
  /** Native confirmation; the project root must be clean. */
  mergeToBase(threadId: string, method: 'merge' | 'squash'): Promise<{ sha: string }>;
  /** Native save dialog. Null when cancelled. */
  exportPatch(threadId: string): Promise<string | null>;
  revealWorktree(threadId: string): Promise<void>;
  readSpill(threadId: string, spillId: string): Promise<{ text: string; truncated: boolean }>;
  listRules(opts?: { projectId?: string }): Promise<PermissionRule[]>;
  deleteRule(ruleId: string): Promise<void>;
  listMcpServers(opts?: { projectId?: string }): Promise<McpServerStatus[]>;
  /** stdio servers need a native confirmation showing the exact command; env values go to the secure store. */
  addMcpServer(config: Omit<McpServerConfig, 'id'>, env?: Record<string, string>): Promise<McpServerStatus>;
  /** Enabling a server or setting a tool to 'allow' is a loosening (native confirmation). */
  updateMcpServer(id: string, patch: Partial<Pick<McpServerConfig, 'enabled' | 'toolPolicy' | 'name'>>): Promise<McpServerStatus>;
  removeMcpServer(id: string): Promise<void>;
  /** OAuth in the system browser (main). */
  authorizeMcpServer(id: string): Promise<McpServerStatus>;
  getGatewayStatus(): Promise<GatewayStatus>;
  /** Re-runs the sandbox self-test. */
  checkSandbox(): Promise<CodeState>;
}

/** Every CodeApi method name (checked against the interface at compile time; used by stubs and contract tests). */
export const CODE_API_METHODS = [
  'getState',
  'listProjects',
  'addProject',
  'removeProject',
  'trustProject',
  'updateProject',
  'listThreads',
  'getThread',
  'getTimeline',
  'createThread',
  'updateThread',
  'archiveThread',
  'deleteThread',
  'send',
  'steer',
  'interrupt',
  'resume',
  'respondApproval',
  'listPendingApprovals',
  'getDiff',
  'getFileDiff',
  'discardFile',
  'restoreCheckpoint',
  'commit',
  'suggestCommitMessage',
  'mergeToBase',
  'exportPatch',
  'revealWorktree',
  'readSpill',
  'listRules',
  'deleteRule',
  'listMcpServers',
  'addMcpServer',
  'updateMcpServer',
  'removeMcpServer',
  'authorizeMcpServer',
  'getGatewayStatus',
  'checkSandbox',
] as const satisfies readonly (keyof CodeApi)[];

/** Compile-time proof that CODE_API_METHODS names every method (a missing one makes this `false`). */
export type CodeApiMethodsComplete = [Exclude<keyof CodeApi, (typeof CODE_API_METHODS)[number]>] extends [never] ? true : false;
const codeMethodsComplete: CodeApiMethodsComplete = true;
void codeMethodsComplete;
