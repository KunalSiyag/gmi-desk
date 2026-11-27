/**
 * Main ↔ harness host protocol (harness.md §5.1, §13.3). Not a renderer contract: both ends are ours, but the host
 * handles untrusted data, so main validates every HostToMain message, and the host validates every MainToHost
 * message, with the zod schemas below. Messages travel over one MessagePort (structured clone), at most
 * MAX_MESSAGE_BYTES each; anything unknown, malformed or oversized is dropped and logged by the receiver.
 *
 * Imported by the host bundle (src/harness) and by main (src/main/services/harness). Keep it free of Electron and
 * of main-only modules (type imports are fine: they are erased).
 */
import { z } from 'zod';
import type { RouterMode } from '@shared/contracts/app';
import type { ReasoningEffort, RoutingInfo, TokenUsage } from '@shared/contracts/chat';
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  CodeProject,
  CodeState,
  CodeThreadEvent,
  CodeThreadSettings,
  CodeThreadSummary,
  ContextMeter,
  DiffStat,
  McpServerConfig,
  NoticeReason,
  PermissionRuleDraft,
  QueueReason,
  RiskFlag,
  RunStatus,
  RuntimeMode,
  StepUsage,
  ThreadBudget,
  ThreadStrategy,
  TimelineItem,
  TodoItem,
  TokenTotals,
  ToolOutputPreview,
  ToolStatus,
} from '@shared/contracts/code';
import type { GmiErrorCode, GmiErrorShape } from '@shared/contracts/errors';
import type {
  GatewayEvent,
  GatewayFinishReason,
  GatewayPriority,
  GatewayPurpose,
  GatewayRequest,
  GwMessage,
  GwToolCall,
  GwToolDef,
} from '@shared/contracts/gateway';
import type { GmiToolName } from '@main/core/services';

export const HARNESS_PROTOCOL = 1;
/** Largest message either side sends or accepts (§5.1, §20). Measured as UTF-8 JSON bytes. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

// ─── Types (§13.3) ────────────────────────────────────────────────────────────────────────────────────────────

export type HarnessCommand =
  | { op: 'project.add'; project: CodeProject }
  | { op: 'project.update'; project: CodeProject }
  | { op: 'project.remove'; projectId: string; removeWorktrees: boolean }
  | { op: 'thread.create'; projectId: string; init: { title?: string; strategy: ThreadStrategy; settings?: Partial<CodeThreadSettings> } }
  | { op: 'thread.update'; threadId: string; patch: { title?: string; settings?: Partial<CodeThreadSettings> } }
  | { op: 'thread.archive'; threadId: string; removeWorktree: boolean; deleteBranch: boolean }
  | { op: 'thread.delete'; threadId: string }
  | { op: 'run.send'; threadId: string; text: string }
  | { op: 'run.steer'; threadId: string; text: string }
  | { op: 'run.interrupt'; threadId: string }
  | { op: 'run.resume'; threadId: string }
  | { op: 'query'; name: HarnessQueryName; args: unknown }
  | { op: 'git'; name: HarnessGitAction; args: unknown }
  | { op: 'rules.delete'; ruleId: string }
  | { op: 'mcp.upsert'; server: StoredMcpServer }
  | { op: 'mcp.remove'; serverId: string }
  | { op: 'sandbox.selftest' };

/** An MCP server row as the host stores it: main's config plus the trust/pinning metadata the host owns. */
export interface StoredMcpServer extends McpServerConfig {
  trustHash: string | null;
  toolHashes: Record<string, string> | null;
  resolvedVersion: string | null;
}

export type HarnessCommandOp = HarnessCommand['op'];
export const HARNESS_QUERY_NAMES = ['projects', 'threads', 'thread', 'timeline', 'diff', 'fileDiff', 'rules', 'mcp', 'spill', 'approvals'] as const;
export type HarnessQueryName = (typeof HARNESS_QUERY_NAMES)[number];
export const HARNESS_GIT_ACTIONS = ['discard', 'restore', 'commit', 'merge', 'exportPatch'] as const;
export type HarnessGitAction = (typeof HARNESS_GIT_ACTIONS)[number];

/**
 * `cmd.result` data of the commands that start a run (frozen H2-0 convention): main opens the run with the gateway
 * (`openRun`, turnId = turnIdOf(threadId, turn)) when it receives this result, before it reads the host's next
 * message, so the run's first `gw.request` (sent after the result on the same port) is accepted.
 */
export interface RunStartedResult {
  runId: string;
  turn: number;
  budgetWarning?: string | null;
}

/** The scope's turn id for a thread's turn (gateway `GatewayScope.turnId`, `openRun`). */
export function turnIdOf(threadId: string, turn: number): string {
  return `${threadId}:${turn}`;
}

export interface HostInitSettings {
  /** Main runs in mock mode (GMI_DESK_MOCK=1): the host uses its mock paths (demo project, fake runner). */
  mock: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export type MainToHost =
  | { t: 'init'; protocol: 1; dataDir: string; installId: string; settings: unknown; platform: NodeJS.Platform }
  | { t: 'cmd'; id: string; cmd: HarnessCommand }
  | { t: 'gw.events'; reqId: string; events: GatewayEvent[] }
  | { t: 'rpc.result'; id: string; ok: true; data: unknown }
  | { t: 'rpc.result'; id: string; ok: false; error: GmiErrorShape }
  | { t: 'approval.decision'; requestId: string; decision: ApprovalDecision }
  | { t: 'ping'; at: number }
  | { t: 'shutdown'; graceMs: number };

export type ConfirmKind = 'trust' | 'destructive' | 'sensitive_write';
export interface ConfirmSubject {
  tool: string;
  command?: string;
  cwd?: string;
  paths?: string[];
  risk: RiskFlag[];
}

export type HostRpc =
  | { method: 'models.info'; params: { models: string[] } }
  /** Paid tools: main checks its one-shot token for requestId (§10.3). */
  | { method: 'mcp.gmi.call'; params: { tool: GmiToolName; args: Record<string, unknown>; requestId: string | null } }
  | { method: 'mcp.oauth.token'; params: { serverId: string } }
  | { method: 'secrets.mcpEnv'; params: { serverId: string } }
  /** Main derives the Idempotency-Key (§10.4). */
  | { method: 'compute.call'; params: { grantId: string; op: string; args: unknown; toolCallId: string } }
  /** No 'loosen' kind and no free text: main builds the dialog from these validated fields (§13.3, H-T17). */
  | { method: 'dialog.confirm'; params: { kind: ConfirmKind; subject: ConfirmSubject } };
export type HostRpcMethod = HostRpc['method'];
export type HostRpcParams<M extends HostRpcMethod> = Extract<HostRpc, { method: M }>['params'];

export type HostPhase = 'starting' | 'migrating' | 'recovering' | 'ready';

export type HostToMain =
  | { t: 'ready'; protocol: 1; version: string; sandbox: CodeState['sandbox']; git: CodeState['git']; ripgrep: boolean }
  | { t: 'cmd.result'; id: string; ok: true; data: unknown }
  | { t: 'cmd.result'; id: string; ok: false; error: GmiErrorShape }
  | { t: 'gw.request'; reqId: string; req: GatewayRequest }
  | { t: 'gw.cancel'; reqId: string }
  | { t: 'rpc'; id: string; call: HostRpc }
  | { t: 'event'; event: CodeThreadEvent }
  | { t: 'threads'; threads: CodeThreadSummary[] }
  | { t: 'approval.request'; request: ApprovalRequest }
  | { t: 'approval.withdrawn'; requestId: string }
  | { t: 'run.ended'; threadId: string; runId: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; scope: string; message: string; meta?: Record<string, unknown> }
  | { t: 'pong'; at: number; phase: HostPhase };

// ─── Enumerations (each checked against its contract type at compile time) ───────────────────────────────────

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const exact = <T extends true>(_proof: T): void => undefined;

export const GMI_ERROR_CODES = [
  'not_signed_in',
  'reauth_required',
  'insufficient_scope',
  'no_api_key',
  'invalid_api_key',
  'unauthorized',
  'payment_required',
  'budget_exceeded',
  'confirmation_required',
  'rate_limited',
  'upstream',
  'network',
  'timeout',
  'cancelled',
  'not_found',
  'invalid_input',
  'not_implemented',
  'internal',
  'no_compute_key',
  'invalid_compute_key',
  'not_entitled',
  'quota_exceeded',
  'conflict',
  'context_overflow',
  'limit_reached',
  'permission_denied',
] as const;
exact<Exact<(typeof GMI_ERROR_CODES)[number], GmiErrorCode>>(true);

export const GMI_TOOL_NAMES = [
  'search_models',
  'get_model',
  'estimate_generation',
  'submit_generation',
  'get_generation',
  'list_generations',
  'upload_media',
  'get_account_summary',
  'search_docs',
  'create_support_request',
] as const;
exact<Exact<(typeof GMI_TOOL_NAMES)[number], GmiToolName>>(true);

export const RISK_FLAGS = [
  'network',
  'outside_worktree',
  'destructive',
  'execution_sensitive',
  'secret_path',
  'unsandboxed',
  'costs_money',
  'compound_command',
  'changed_tool',
  'local_network',
  'unpinned',
] as const;
exact<Exact<(typeof RISK_FLAGS)[number], RiskFlag>>(true);

export const APPROVAL_KINDS = ['command', 'file-change', 'file-read', 'network', 'mcp', 'mcp-elicitation', 'compute', 'question'] as const;
exact<Exact<(typeof APPROVAL_KINDS)[number], ApprovalKind>>(true);

export const APPROVAL_DECISION_KINDS = ['allow_once', 'allow_thread', 'allow_always', 'deny', 'answer', 'cancel_run'] as const;
exact<Exact<(typeof APPROVAL_DECISION_KINDS)[number], ApprovalDecision['kind']>>(true);

export const RUN_STATUSES = ['idle', 'queued', 'running', 'awaiting_approval', 'awaiting_user', 'compacting', 'completed', 'stopped', 'failed', 'cancelled', 'interrupted'] as const;
exact<Exact<(typeof RUN_STATUSES)[number], RunStatus>>(true);

const QUEUE_REASONS = ['tpm', 'concurrency', 'breaker', 'budget', 'offline'] as const;
exact<Exact<(typeof QUEUE_REASONS)[number], QueueReason>>(true);

const NOTICE_REASONS = [
  'step_cap',
  'cost_cap',
  'time_cap',
  'budget',
  'doom_loop',
  'overflow',
  'output_limit',
  'interrupted',
  'sandbox_unavailable',
  'rate_limited',
  'model_error',
  'checkpoint_restored',
  'instructions_changed',
  'ref_changed',
  'cache_low',
  'execution_sensitive',
  'git_tampered',
  'economy_disabled',
  'offline',
] as const;
exact<Exact<(typeof NOTICE_REASONS)[number], NoticeReason>>(true);

const TOOL_STATUSES = ['pending', 'awaiting_approval', 'running', 'succeeded', 'failed', 'denied', 'interrupted'] as const;
exact<Exact<(typeof TOOL_STATUSES)[number], ToolStatus>>(true);

const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
exact<Exact<(typeof RUNTIME_MODES)[number], RuntimeMode>>(true);

const PURPOSES = ['chat', 'agent', 'subagent', 'compaction', 'title', 'commit_message', 'probe', 'eval'] as const;
exact<Exact<(typeof PURPOSES)[number], GatewayPurpose>>(true);
const PRIORITIES = ['interactive', 'foreground', 'background', 'idle'] as const;
exact<Exact<(typeof PRIORITIES)[number], GatewayPriority>>(true);
const FINISH_REASONS = ['stop', 'length', 'tool_calls', 'content_filter', 'other'] as const;
exact<Exact<(typeof FINISH_REASONS)[number], GatewayFinishReason>>(true);
const ROUTER_MODES = ['cost', 'balanced', 'quality'] as const;
exact<Exact<(typeof ROUTER_MODES)[number], RouterMode>>(true);
const EFFORTS = ['low', 'medium', 'high'] as const;
exact<Exact<(typeof EFFORTS)[number], ReasoningEffort>>(true);

// ─── Schemas ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Ids crossing the port (thread, run, request, command, tool-call ids …). */
export const ID_PATTERN = /^[\w.:@-]{1,128}$/;
const id = z.string().regex(ID_PATTERN);
const short = z.string().max(1_024);
const nonNegInt = z.number().int().nonnegative();
const finite = z.number().refine(Number.isFinite, 'not finite');
const iso = z.string().max(64);

export const gmiErrorShapeSchema: z.ZodType<GmiErrorShape> = z.object({
  code: z.enum(GMI_ERROR_CODES),
  message: z.string().max(8_192),
  detail: z.string().max(8_192).nullable().optional(),
  status: z.number().int().nullable().optional(),
  retryAfterSec: finite.nullable().optional(),
});

const riskSchema = z.array(z.enum(RISK_FLAGS)).max(RISK_FLAGS.length);

const ruleDraftSchema: z.ZodType<PermissionRuleDraft> = z.object({
  tool: z.string().min(1).max(256),
  pattern: z.string().max(2_048).nullable(),
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['thread', 'project', 'global']),
});

export const approvalDecisionSchema: z.ZodType<ApprovalDecision> = z.union([
  z.object({ kind: z.literal('allow_once'), sensitiveWrites: z.boolean().optional() }),
  z.object({ kind: z.literal('allow_thread') }),
  z.object({ kind: z.literal('allow_always'), rule: ruleDraftSchema }),
  z.object({ kind: z.literal('deny'), feedback: z.string().max(8_192).optional() }),
  z.object({ kind: z.literal('answer'), text: z.string().max(16_384) }),
  z.object({ kind: z.literal('cancel_run') }),
]);

export const approvalRequestSchema: z.ZodType<ApprovalRequest> = z.object({
  requestId: id,
  threadId: id,
  runId: id,
  toolCallId: id.nullable(),
  kind: z.enum(APPROVAL_KINDS),
  tool: z.string().min(1).max(256),
  title: short,
  detail: z.object({
    command: z.string().max(65_536).optional(),
    cwd: z.string().max(4_096).optional(),
    paths: z.array(z.string().max(4_096)).max(1_000).optional(),
    diff: z.string().max(262_144).optional(),
    url: z.string().max(8_192).optional(),
    host: z.string().max(1_024).optional(),
    server: z.string().max(256).optional(),
    args: z.string().max(4_096).optional(),
    costUsd: finite.nullable().optional(),
    question: z.string().max(16_384).optional(),
    options: z.array(short).max(20).optional(),
  }),
  risk: riskSchema,
  suggestedRule: ruleDraftSchema.nullable(),
  allowedDecisions: z.array(z.enum(APPROVAL_DECISION_KINDS)).max(APPROVAL_DECISION_KINDS.length),
  createdAt: iso,
  expiresAt: iso.nullable(),
});

const tokenTotalsSchema: z.ZodType<TokenTotals> = z.object({ input: nonNegInt, cached: nonNegInt, output: nonNegInt, reasoning: nonNegInt });
const diffStatSchema: z.ZodType<DiffStat> = z.object({ files: nonNegInt, additions: nonNegInt, deletions: nonNegInt });
const todoSchema: z.ZodType<TodoItem> = z.object({ id: z.string().max(128), text: z.string().max(4_096), status: z.enum(['pending', 'in_progress', 'done']) });
const stepUsageSchema: z.ZodType<StepUsage> = z.object({
  promptTokens: nonNegInt,
  cachedTokens: nonNegInt,
  completionTokens: nonNegInt,
  reasoningTokens: nonNegInt,
  costUsd: finite.nullable(),
  estimated: z.boolean(),
  model: short,
  latencyMs: finite.nullable(),
});
const outputPreviewSchema: z.ZodType<ToolOutputPreview> = z.object({
  text: z.string(),
  truncated: z.boolean(),
  totalBytes: nonNegInt,
  spillId: id.nullable(),
  exitCode: z.number().int().nullable().optional(),
});
const meterSchema: z.ZodType<ContextMeter> = z.object({
  windowTokens: nonNegInt,
  ceilingTokens: z.number().int(),
  usedTokens: nonNegInt,
  reserveTokens: nonNegInt,
  cachedRatio: finite.nullable(),
  compactions: nonNegInt,
  tierBoundaryTokens: nonNegInt.nullable(),
  messageCount: nonNegInt,
  nextStepUsd: finite.nullable(),
  estimated: z.boolean(),
});

const runStatusSchema = z.enum(RUN_STATUSES);

export const timelineItemSchema: z.ZodType<TimelineItem> = z.union([
  z.object({ kind: z.literal('user'), id, seq: nonNegInt, turn: nonNegInt, text: z.string(), steering: z.boolean(), at: iso }),
  z.object({
    kind: z.literal('assistant'),
    id,
    seq: nonNegInt,
    turn: nonNegInt,
    step: nonNegInt,
    text: z.string(),
    reasoning: z.string().nullable(),
    model: short,
    usage: stepUsageSchema.nullable(),
    status: z.enum(['streaming', 'complete', 'stopped', 'error']),
    at: iso,
  }),
  z.object({
    kind: z.literal('tool'),
    id,
    seq: nonNegInt,
    turn: nonNegInt,
    step: nonNegInt,
    toolCallId: id,
    tool: z.string().max(256),
    title: short,
    argsPreview: z.string().max(65_536),
    status: z.enum(TOOL_STATUSES),
    output: outputPreviewSchema.nullable(),
    durationMs: finite.nullable(),
    at: iso,
  }),
  z.object({ kind: z.literal('approval'), id, seq: nonNegInt, request: approvalRequestSchema, decision: approvalDecisionSchema.nullable() }),
  z.object({ kind: z.literal('compaction'), id, seq: nonNegInt, beforeTokens: nonNegInt, afterTokens: nonNegInt, model: short, costUsd: finite.nullable(), at: iso }),
  z.object({ kind: z.literal('checkpoint'), id, seq: nonNegInt, checkpointId: id, turn: nonNegInt, filesChanged: nonNegInt, at: iso }),
  z.object({ kind: z.literal('subagent'), id, seq: nonNegInt, toolCallId: id, agent: short, model: short, status: runStatusSchema, summary: z.string().nullable(), costUsd: finite.nullable() }),
  z.object({ kind: z.literal('notice'), id, seq: nonNegInt, level: z.enum(['info', 'warning', 'error']), reason: z.enum(NOTICE_REASONS), text: z.string().max(16_384), at: iso }),
]);

export const codeThreadEventSchema: z.ZodType<CodeThreadEvent> = z.union([
  z.object({ threadId: id, seq: nonNegInt, type: z.literal('item'), item: timelineItemSchema }),
  z.object({
    threadId: id,
    seq: nonNegInt,
    type: z.literal('status'),
    status: runStatusSchema,
    reason: z.string().max(4_096).nullable(),
    queuePosition: nonNegInt.nullable(),
    queueReason: z.enum(QUEUE_REASONS).nullable(),
  }),
  z.object({ threadId: id, seq: nonNegInt, type: z.literal('todo'), todo: z.array(todoSchema).max(500) }),
  z.object({ threadId: id, seq: nonNegInt, type: z.literal('diff'), diff: diffStatSchema }),
  z.object({
    threadId: id,
    seq: z.null(),
    type: z.literal('delta'),
    itemId: id,
    field: z.enum(['text', 'reasoning', 'output', 'args']),
    text: z.string(),
    offset: nonNegInt,
  }),
  z.object({ threadId: id, seq: z.null(), type: z.literal('meter'), meter: meterSchema, tokens: tokenTotalsSchema, costUsd: finite }),
]);

export const threadSummarySchema: z.ZodType<CodeThreadSummary> = z.object({
  id,
  projectId: id,
  title: short,
  strategy: z.enum(['worktree', 'existing_worktree', 'root']),
  branch: z.string().max(1_024).nullable(),
  worktreePath: z.string().max(4_096).nullable(),
  status: runStatusSchema,
  statusReason: z.string().max(4_096).nullable(),
  pendingApprovals: nonNegInt,
  queuePosition: nonNegInt.nullable(),
  queueReason: z.enum(QUEUE_REASONS).nullable(),
  model: short,
  mode: z.enum(RUNTIME_MODES),
  costUsd: finite,
  tokens: tokenTotalsSchema,
  diff: diffStatSchema.nullable(),
  createdAt: iso,
  updatedAt: iso,
  archived: z.boolean(),
});

const projectSchema: z.ZodType<CodeProject> = z.object({
  id,
  name: short,
  rootPath: z.string().min(1).max(4_096),
  defaultBranch: z.string().max(1_024).nullable(),
  trust: z.object({ state: z.enum(['untrusted', 'trusted', 'changed']), configHash: z.string().max(256).nullable(), trustedAt: iso.nullable() }),
  worktreeDir: z.string().min(1).max(4_096),
  setupCommand: z.string().max(8_192).nullable(),
  addedAt: iso,
  threadCount: nonNegInt,
});

const mcpPolicySchema = z.enum(['allow', 'ask', 'deny']);
const mcpTransportSchema: z.ZodType<McpServerConfig['transport']> = z.union([
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(256),
    envNames: z.array(z.string().min(1).max(256)).max(256),
    cwd: z.string().min(1).max(4_096).nullable(),
    network: z.boolean(),
  }),
  z.object({ type: z.literal('http'), url: z.string().url().max(4_096), auth: z.enum(['none', 'bearer', 'oauth']) }),
]);
const mcpServerFields = {
  id,
  name: short,
  scope: z.enum(['global', 'project']),
  projectId: id.nullable(),
  transport: mcpTransportSchema,
  enabled: z.boolean(),
  toolPolicy: z.record(z.string().max(512), mcpPolicySchema),
};
const mcpServerConfigSchema: z.ZodType<McpServerConfig> = z.object(mcpServerFields);
const storedMcpServerSchema: z.ZodType<StoredMcpServer> = z.object({
  ...mcpServerFields,
  trustHash: z.string().max(256).nullable(),
  toolHashes: z.record(z.string().max(512), z.string().max(128)).nullable(),
  resolvedVersion: z.string().max(256).nullable(),
});

const strategySchema: z.ZodType<ThreadStrategy> = z.union([
  z.object({ kind: z.literal('worktree'), baseRef: z.string().min(1).max(1_024), branch: z.string().max(256).nullable().optional() }),
  z.object({ kind: z.literal('existing_worktree'), path: z.string().min(1).max(4_096) }),
  z.object({ kind: z.literal('root') }),
]);

const budgetSchema: z.ZodType<ThreadBudget> = z.object({
  perTurnUsd: z.number().finite().nonnegative().nullable(),
  perThreadUsd: z.number().finite().nonnegative().nullable(),
  maxStepsPerTurn: z.number().int().min(1).max(500),
  maxTurnMinutes: z.number().finite().positive().max(1_440),
});

const settingsPartialSchema: z.ZodType<Partial<CodeThreadSettings>> = z
  .object({
    runtime: z.enum(['gmi', 'opencode']),
    model: short,
    subagentModel: short.nullable(),
    compactionModel: short.nullable(),
    sideTaskModel: short.nullable(),
    mode: z.enum(RUNTIME_MODES),
    reasoningEffort: z.enum(EFFORTS).nullable(),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
    economy: z.boolean(),
    maxContextTokens: z.number().int().positive().nullable(),
    webFetch: z.enum(['off', 'ask', 'allowlist']),
    network: z.enum(['off', 'ask']),
    budget: budgetSchema,
    computerId: id.nullable(),
  })
  .partial();

const commandSchemas = {
  'project.add': z.object({ op: z.literal('project.add'), project: projectSchema }),
  'project.update': z.object({ op: z.literal('project.update'), project: projectSchema }),
  'project.remove': z.object({ op: z.literal('project.remove'), projectId: id, removeWorktrees: z.boolean() }),
  'thread.create': z.object({
    op: z.literal('thread.create'),
    projectId: id,
    init: z.object({ title: short.optional(), strategy: strategySchema, settings: settingsPartialSchema.optional() }),
  }),
  'thread.update': z.object({ op: z.literal('thread.update'), threadId: id, patch: z.object({ title: short.optional(), settings: settingsPartialSchema.optional() }) }),
  'thread.archive': z.object({ op: z.literal('thread.archive'), threadId: id, removeWorktree: z.boolean(), deleteBranch: z.boolean() }),
  'thread.delete': z.object({ op: z.literal('thread.delete'), threadId: id }),
  'run.send': z.object({ op: z.literal('run.send'), threadId: id, text: z.string().min(1).max(1_048_576) }),
  'run.steer': z.object({ op: z.literal('run.steer'), threadId: id, text: z.string().min(1).max(1_048_576) }),
  'run.interrupt': z.object({ op: z.literal('run.interrupt'), threadId: id }),
  'run.resume': z.object({ op: z.literal('run.resume'), threadId: id }),
  query: z.object({ op: z.literal('query'), name: z.enum(HARNESS_QUERY_NAMES), args: z.unknown() }),
  git: z.object({ op: z.literal('git'), name: z.enum(HARNESS_GIT_ACTIONS), args: z.unknown() }),
  'rules.delete': z.object({ op: z.literal('rules.delete'), ruleId: id }),
  'mcp.upsert': z.object({ op: z.literal('mcp.upsert'), server: storedMcpServerSchema }),
  'mcp.remove': z.object({ op: z.literal('mcp.remove'), serverId: id }),
  'sandbox.selftest': z.object({ op: z.literal('sandbox.selftest') }),
} as const satisfies Record<HarnessCommandOp, z.ZodType>;

export const harnessCommandSchema = z.custom<HarnessCommand>((value) => {
  const op = isObject(value) && typeof value.op === 'string' ? value.op : null;
  const schema = op !== null && Object.hasOwn(commandSchemas, op) ? commandSchemas[op as HarnessCommandOp] : null;
  return schema !== null && schema.safeParse(value).success;
}, 'invalid command');

// Gateway types (the host's requests; main's events back)

const gwToolCallSchema: z.ZodType<GwToolCall> = z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(128), arguments: z.string() });
const gwMessageSchema: z.ZodType<GwMessage> = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() }))]),
  toolCalls: z.array(gwToolCallSchema).optional(),
  toolCallId: z.string().min(1).max(256).optional(),
  name: z.string().max(128).optional(),
  reasoning: z.object({ text: z.string(), family: z.string().max(128) }).nullable().optional(),
});
const gwToolDefSchema: z.ZodType<GwToolDef> = z.object({ name: z.string().min(1).max(128), description: z.string(), parameters: z.record(z.string(), z.unknown()) });

export const gatewayRequestSchema: z.ZodType<GatewayRequest> = z.object({
  requestId: id,
  purpose: z.enum(PURPOSES),
  priority: z.enum(PRIORITIES),
  scope: z.object({ threadId: id.nullable(), turnId: id.nullable(), runId: id.nullable(), step: nonNegInt.nullable() }),
  target: z.union([z.strictObject({ model: z.string().min(1).max(256) }), z.strictObject({ router: z.enum(ROUTER_MODES) })]),
  messages: z.array(gwMessageSchema).min(1),
  tools: z.array(gwToolDefSchema).optional(),
  toolChoice: z.enum(['auto', 'none', 'required']).optional(),
  parallelToolCalls: z.boolean().optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
  temperature: finite.nullable().optional(),
  reasoningEffort: z.enum(EFFORTS).nullable().optional(),
  prefixHash: z.string().max(256).nullable(),
  cacheKey: z.string().max(256).nullable().optional(),
});

const tokenUsageSchema: z.ZodType<TokenUsage> = z.object({
  promptTokens: nonNegInt,
  completionTokens: nonNegInt,
  totalTokens: nonNegInt,
  reasoningTokens: nonNegInt.nullable(),
  cachedTokens: nonNegInt.nullable(),
});
const routingSchema: z.ZodType<RoutingInfo> = z.object({
  selectedModel: short,
  taskType: short.nullable(),
  mode: short.nullable(),
  fallbackModels: z.array(short).max(64),
  recommendationId: short.nullable(),
});

export const gatewayEventSchema: z.ZodType<GatewayEvent> = z.union([
  z.object({ type: z.literal('queued'), position: nonNegInt, etaMs: finite.nullable(), reason: z.enum(QUEUE_REASONS) }),
  z.object({ type: z.literal('started'), attempt: nonNegInt, model: short.nullable(), api: z.enum(['chat', 'responses', 'router']) }),
  z.object({ type: z.literal('retry'), attempt: nonNegInt, delayMs: finite, code: short }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool_call_delta'), index: nonNegInt, id: z.string().max(256).nullable(), name: z.string().max(128).nullable(), argumentsDelta: z.string() }),
  z.object({ type: z.literal('tool_call'), call: gwToolCallSchema }),
  z.object({ type: z.literal('model'), model: short }),
  z.object({ type: z.literal('routing'), routing: routingSchema }),
  z.object({
    type: z.literal('usage'),
    usage: tokenUsageSchema,
    cacheWriteTokens: nonNegInt.nullable(),
    costUsd: finite.nullable(),
    estimated: z.boolean(),
    maybeBilled: z.boolean(),
  }),
  z.object({ type: z.literal('finish'), reason: z.enum(FINISH_REASONS), raw: z.string().max(256).nullable() }),
  z.object({ type: z.literal('error'), error: gmiErrorShapeSchema, afterOutput: z.boolean() }),
]);

// Host RPCs

const confirmSubjectSchema: z.ZodType<ConfirmSubject> = z.object({
  tool: z.string().min(1).max(256),
  command: z.string().max(65_536).optional(),
  cwd: z.string().max(4_096).optional(),
  paths: z.array(z.string().max(4_096)).max(1_000).optional(),
  risk: riskSchema,
});

const rpcSchemas = {
  'models.info': z.object({ method: z.literal('models.info'), params: z.object({ models: z.array(z.string().min(1).max(512)).max(8) }) }),
  'mcp.gmi.call': z.object({
    method: z.literal('mcp.gmi.call'),
    params: z.object({ tool: z.enum(GMI_TOOL_NAMES), args: z.record(z.string(), z.unknown()), requestId: id.nullable() }),
  }),
  'mcp.oauth.token': z.object({ method: z.literal('mcp.oauth.token'), params: z.object({ serverId: id }) }),
  'secrets.mcpEnv': z.object({ method: z.literal('secrets.mcpEnv'), params: z.object({ serverId: id }) }),
  'compute.call': z.object({
    method: z.literal('compute.call'),
    params: z.object({ grantId: id, op: z.string().min(1).max(64), args: z.unknown(), toolCallId: id }),
  }),
  'dialog.confirm': z.object({
    method: z.literal('dialog.confirm'),
    params: z.object({ kind: z.enum(['trust', 'destructive', 'sensitive_write']), subject: confirmSubjectSchema }),
  }),
} as const satisfies Record<HostRpcMethod, z.ZodType>;
export const HOST_RPC_METHODS = Object.keys(rpcSchemas) as HostRpcMethod[];

export const hostRpcSchema = z.custom<HostRpc>((value) => {
  const method = isObject(value) && typeof value.method === 'string' ? value.method : null;
  const schema = method !== null && Object.hasOwn(rpcSchemas, method) ? rpcSchemas[method as HostRpcMethod] : null;
  return schema !== null && schema.safeParse(value).success;
}, 'invalid rpc');

// Envelopes, looked up by `t` (zod's discriminated unions need distinct discriminators; cmd.result and
// rpc.result have two shapes each).

const sandboxStateSchema: z.ZodType<CodeState['sandbox']> = z.object({
  kind: z.enum(['bwrap', 'seatbelt', 'none']),
  ok: z.boolean(),
  detail: z.string().max(4_096).nullable(),
  network: z.enum(['proxy', 'shared_per_command', 'none']),
});
const gitStateSchema: z.ZodType<CodeState['git']> = z.object({ ok: z.boolean(), version: z.string().max(256).nullable() });
const phaseSchema = z.enum(['starting', 'migrating', 'recovering', 'ready']);

const hostToMainSchemas = {
  ready: z.object({ t: z.literal('ready'), protocol: z.literal(HARNESS_PROTOCOL), version: short, sandbox: sandboxStateSchema, git: gitStateSchema, ripgrep: z.boolean() }),
  'cmd.result': z.union([
    z.object({ t: z.literal('cmd.result'), id, ok: z.literal(true), data: z.unknown() }),
    z.object({ t: z.literal('cmd.result'), id, ok: z.literal(false), error: gmiErrorShapeSchema }),
  ]),
  'gw.request': z.object({ t: z.literal('gw.request'), reqId: id, req: gatewayRequestSchema }),
  'gw.cancel': z.object({ t: z.literal('gw.cancel'), reqId: id }),
  rpc: z.object({ t: z.literal('rpc'), id, call: hostRpcSchema }),
  event: z.object({ t: z.literal('event'), event: codeThreadEventSchema }),
  threads: z.object({ t: z.literal('threads'), threads: z.array(threadSummarySchema).max(10_000) }),
  'approval.request': z.object({ t: z.literal('approval.request'), request: approvalRequestSchema }),
  'approval.withdrawn': z.object({ t: z.literal('approval.withdrawn'), requestId: id }),
  'run.ended': z.object({ t: z.literal('run.ended'), threadId: id, runId: id }),
  log: z.object({
    t: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    scope: z.string().max(128),
    message: z.string().max(4_096),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  pong: z.object({ t: z.literal('pong'), at: finite, phase: phaseSchema }),
} as const satisfies Record<HostToMain['t'], z.ZodType>;

const mainToHostSchemas = {
  init: z.object({
    t: z.literal('init'),
    protocol: z.literal(HARNESS_PROTOCOL),
    dataDir: z.string().min(1).max(4_096),
    installId: z.string().min(1).max(128),
    settings: z.unknown(),
    platform: z.string().min(1).max(32),
  }),
  cmd: z.object({ t: z.literal('cmd'), id, cmd: harnessCommandSchema }),
  'gw.events': z.object({ t: z.literal('gw.events'), reqId: id, events: z.array(gatewayEventSchema).max(10_000) }),
  'rpc.result': z.union([
    z.object({ t: z.literal('rpc.result'), id, ok: z.literal(true), data: z.unknown() }),
    z.object({ t: z.literal('rpc.result'), id, ok: z.literal(false), error: gmiErrorShapeSchema }),
  ]),
  'approval.decision': z.object({ t: z.literal('approval.decision'), requestId: id, decision: approvalDecisionSchema }),
  ping: z.object({ t: z.literal('ping'), at: finite }),
  shutdown: z.object({ t: z.literal('shutdown'), graceMs: z.number().int().min(0).max(60_000) }),
} as const satisfies Record<MainToHost['t'], z.ZodType>;

// ─── Decoding ─────────────────────────────────────────────────────────────────────────────────────────────────

export type DecodeResult<T> = { ok: true; msg: T } | { ok: false; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * UTF-8 bytes of the message as JSON (a close upper bound of the structured-clone payload for our plain data).
 * Returns Infinity for values JSON cannot represent (cycles, BigInt): such a message is never valid anyway.
 */
export function messageBytes(message: unknown): number {
  try {
    const text = JSON.stringify(message);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function decode<T>(raw: unknown, schemas: Record<string, z.ZodType>, maxBytes: number): DecodeResult<T> {
  if (!isObject(raw)) return { ok: false, reason: 'not an object' };
  const t = raw.t;
  if (typeof t !== 'string' || !Object.hasOwn(schemas, t)) return { ok: false, reason: `unknown message type ${typeof t === 'string' ? t.slice(0, 32) : typeof t}` };
  const bytes = messageBytes(raw);
  if (bytes > maxBytes) return { ok: false, reason: `${t}: message too large (${bytes} bytes)` };
  const parsed = (schemas[t] as z.ZodType).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `${t}: invalid ${issue ? `${issue.path.join('.') || 'message'} (${issue.message})` : 'message'}` };
  }
  return { ok: true, msg: parsed.data as T };
}

/** Main's check of every message from the host (§13.3): unknown, malformed or oversized → `{ok: false}`. */
export function decodeHostToMain(raw: unknown, maxBytes = MAX_MESSAGE_BYTES): DecodeResult<HostToMain> {
  return decode<HostToMain>(raw, hostToMainSchemas, maxBytes);
}

/** The host's check of every message from main. */
export function decodeMainToHost(raw: unknown, maxBytes = MAX_MESSAGE_BYTES): DecodeResult<MainToHost> {
  return decode<MainToHost>(raw, mainToHostSchemas, maxBytes);
}

/** Whether a `cmd.result` payload of run.send / run.resume names a run (RunStartedResult). */
export function runStartedResult(data: unknown): RunStartedResult | null {
  if (!isObject(data)) return null;
  const { runId, turn } = data;
  if (typeof runId !== 'string' || !ID_PATTERN.test(runId)) return null;
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) return null;
  const warning = data.budgetWarning;
  return { runId, turn, budgetWarning: typeof warning === 'string' ? warning : null };
}

/** Canonical JSON: object keys sorted recursively (tool definitions, one-shot token hashes, prefix hashing). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = value[key];
    if (v !== undefined) out[key] = sortKeys(v);
  }
  return out;
}
