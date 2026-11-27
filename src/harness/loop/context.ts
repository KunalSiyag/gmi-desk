/**
 * Context building: the byte-stable prefix (the caching contract, harness.md §7.1).
 *
 *   [system]  base prompt vN + tool-use guidance               (NO mode, NO dates)
 *   [tools]   built-ins by name, then MCP tools; canonical JSON  (frozen per turn)
 *   [user#0]  <project-instructions> (trusted snapshot, ≤ 32 KiB) + <environment> (frozen per thread)
 *   [summary] the latest compaction's summary (H2-C stores it in `compactions`), then its pinned rows
 *   [history] append-only user / assistant(+tool_calls, +reasoning) / tool messages after the compaction anchor
 *   [user#N]  the turn's message + <context> date, mode rules, git status, todos, budget — VOLATILE DATA ONLY HERE
 *
 * `[user#N]` is stored once, at turn start, with its <context> block, so it is byte-stable from then on too.
 * Earlier messages are never edited; no randomness or timestamps enter the prefix.
 */
import { createHash } from 'node:crypto';
import type { CodeThreadSettings, TodoItem } from '@shared/contracts/code';
import type { GwMessage, GwToolCall, GwToolDef } from '@shared/contracts/gateway';
import { canonicalJson } from '../protocol';
import type { MessageRow, ProjectRow, Store, ThreadGitRecord, ThreadRow } from '../types';
import { compactedContext } from './compaction';
import { capBytes, GIT_STATUS_MAX_BYTES, INSTRUCTION_FILES, INSTRUCTIONS_MAX_BYTES, MODE_RULES, PROMPT_VERSION, PROMPTS } from './prompts';
import { estimateMessage, estimateTools } from './tokens';

// ─── Prefix ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface Prefix {
  system: GwMessage;
  user0: GwMessage;
  tools: GwToolDef[];
  /** sha256 of the serialised [system]+[tools]+[user#0] (§7.1), sent with every request for diagnostics. */
  hash: string;
  /** Uncalibrated token estimate of the prefix. */
  tokens: number;
  /** Hash of the instruction block alone (thread `instructions_hash`, §7.1 `instructions_changed`). */
  instructionsHash: string;
  promptVersion: string;
}

export function systemMessage(): GwMessage {
  return { role: 'system', content: PROMPTS.system };
}

/** The serialised prefix exactly as hashed (also what the golden test snapshots). */
export function serialisePrefix(parts: { system: GwMessage; tools: readonly GwToolDef[]; user0: GwMessage }): { system: string; tools: string; user0: string } {
  return {
    system: canonicalJson(parts.system),
    tools: canonicalJson(parts.tools),
    user0: canonicalJson(parts.user0),
  };
}

export function buildPrefix(input: { tools: readonly GwToolDef[]; instructions: string; environment: string }): Prefix {
  const system = systemMessage();
  const user0: GwMessage = { role: 'user', content: user0Text(input.instructions, input.environment) };
  // Canonical tool JSON (sorted keys) even when the registry already did it: the prefix must not depend on it.
  const tools = input.tools.map((t) => JSON.parse(canonicalJson(t)) as GwToolDef);
  const s = serialisePrefix({ system, tools, user0 });
  const hash = createHash('sha256').update(s.system).update('\n').update(s.tools).update('\n').update(s.user0).digest('hex');
  return {
    system,
    user0,
    tools,
    hash,
    tokens: estimateMessage(system) + estimateMessage(user0) + estimateTools(tools),
    instructionsHash: createHash('sha256').update(input.instructions).digest('hex'),
    promptVersion: PROMPT_VERSION,
  };
}

export function user0Text(instructions: string, environment: string): string {
  const parts: string[] = [];
  if (instructions) parts.push(`<project-instructions>\n${instructions}\n</project-instructions>`);
  parts.push(`<environment>\n${environment}\n</environment>`);
  return parts.join('\n\n');
}

/**
 * `<project-instructions>` from the TRUSTED snapshot only (§7.1, §12.1), never from the worktree the agent can
 * edit. Untrusted projects have none. Capped at 32 KiB.
 */
export function instructionsFromSnapshot(store: Store, project: ProjectRow): string {
  if (project.trustState === 'untrusted') return '';
  const blocks: string[] = [];
  for (const path of INSTRUCTION_FILES) {
    const f = store.trustedFiles.get(project.id, path);
    if (!f || !f.content.trim()) continue;
    blocks.push(`# ${path}\n${f.content.replace(/\s+$/, '')}`);
  }
  return capBytes(blocks.join('\n\n'), INSTRUCTIONS_MAX_BYTES, '\n[instructions truncated at 32 KiB]');
}

export interface EnvironmentInput {
  platform: NodeJS.Platform;
  shell: string;
  repoName: string;
  worktreePath: string;
  baseBranch: string | null;
  branch: string | null;
  ripgrep: boolean;
  sandbox: string;
}

/** The `<environment>` block, computed once per thread and stored (`threads.env_block`, §7.1). */
export function environmentBlock(e: EnvironmentInput): string {
  return [
    `os: ${e.platform}`,
    `shell: ${e.shell}`,
    `repository: ${e.repoName}`,
    `worktree: ${e.worktreePath}`,
    `base branch: ${e.baseBranch ?? 'none'}`,
    `branch: ${e.branch ?? 'none'}`,
    `tools: ${e.ripgrep ? 'rg' : 'no rg'}`,
    `sandbox: ${e.sandbox}`,
  ].join('\n');
}

// ─── The turn's user message (volatile data) ─────────────────────────────────────────────────────────────────

export interface VolatileInput {
  /** YYYY-MM-DD (fixed in eval mode). */
  date: string;
  mode: CodeThreadSettings['mode'];
  gitStatus: string | null;
  todos: TodoItem[];
  /** A pre-rendered budget line (fixed in eval mode). */
  budget: string;
}

export function volatileBlock(v: VolatileInput): string {
  const lines = [`date: ${v.date}`, `mode: ${MODE_RULES[v.mode] ?? v.mode}`];
  const status = (v.gitStatus ?? '').replace(/\s+$/, '');
  lines.push(status ? `git status:\n${capBytes(status, GIT_STATUS_MAX_BYTES, '\n[git status truncated]')}` : 'git status: clean');
  const open = v.todos.filter((t) => t.status !== 'done');
  if (open.length > 0) lines.push(`open todos:\n${open.map((t) => `- [${t.status === 'in_progress' ? '~' : ' '}] ${t.text}`).join('\n')}`);
  lines.push(`budget: ${v.budget}`);
  return `<context>\n${lines.join('\n')}\n</context>`;
}

export function turnMessage(text: string, volatile: string): string {
  return `${text}\n\n${volatile}`;
}

export function budgetLine(input: { perTurnUsd: number | null; perThreadUsd: number | null; turnSpentUsd: number; threadSpentUsd: number }): string {
  const fmt = (n: number) => `$${Math.max(0, n).toFixed(2)}`;
  const turn = input.perTurnUsd === null ? 'turn: no cap' : `turn: ${fmt(input.perTurnUsd - input.turnSpentUsd)} of ${fmt(input.perTurnUsd)} left`;
  const thread = input.perThreadUsd === null ? 'thread: no cap' : `thread: ${fmt(input.perThreadUsd - input.threadSpentUsd)} of ${fmt(input.perThreadUsd)} left`;
  return `${turn}; ${thread}`;
}

// ─── History ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A model's reasoning family (the id's organisation), matching main's `reasoningFamily`. */
export function reasoningFamily(modelId: string): string {
  const slash = modelId.indexOf('/');
  return (slash > 0 ? modelId.slice(0, slash) : modelId).toLowerCase();
}

/** One stored row → its wire message. `toolNames` maps wire ids to tool names (for families that need `name`). */
export function rowToGw(row: MessageRow, toolNames: ReadonlyMap<string, string>): GwMessage {
  switch (row.role) {
    case 'system':
      // Never written by the loop; sent as user text so a stray row cannot become a second system prompt.
      return { role: 'user', content: row.content };
    case 'tool': {
      const m: GwMessage = { role: 'tool', content: row.content, toolCallId: row.toolCallId ?? '' };
      const name = row.toolCallId ? toolNames.get(row.toolCallId) : undefined;
      if (name) m.name = name;
      return m;
    }
    case 'assistant': {
      const m: GwMessage = { role: 'assistant', content: row.content };
      if (row.toolCalls && row.toolCalls.length > 0) m.toolCalls = row.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
      if (row.reasoning) m.reasoning = { text: row.reasoning, family: row.reasoningFamily ?? '' };
      return m;
    }
    default:
      return { role: 'user', content: row.content };
  }
}

export interface HistoryEntry {
  row: MessageRow;
  msg: GwMessage;
}

export interface HistoryView {
  /** The latest compaction's `[summary]` message, or null. */
  summary: { id: string; msg: GwMessage } | null;
  /** Pinned rows, then the history after the anchor, each in `ord` order (H2-C's `compactedContext` order). */
  entries: HistoryEntry[];
}

/** Rows → wire messages; tool results carry their tool's name (resolved from the assistant calls before them). */
export function toWire(rows: readonly MessageRow[]): HistoryEntry[] {
  const toolNames = new Map<string, string>();
  for (const r of rows) for (const c of r.toolCalls ?? []) toolNames.set(c.id, c.name);
  return rows.map((row) => ({ row, msg: rowToGw(row, toolNames) }));
}

/**
 * What the model sees after `[user#0]`: the compaction summary, the pinned current request, then the in-context
 * history after the anchor. Partial (streaming checkpoint) rows are never sent.
 */
export function historyView(store: Store, contextId: string): HistoryView {
  const view = compactedContext(store, contextId);
  return {
    summary: view.compaction && view.summary ? { id: view.compaction.id, msg: view.summary } : null,
    entries: toWire(view.rows.filter((r) => r.inContext && !r.partial)),
  };
}

export function requestMessages(prefix: Prefix, view: HistoryView): GwMessage[] {
  return [prefix.system, prefix.user0, ...(view.summary ? [view.summary.msg] : []), ...view.entries.map((h) => h.msg)];
}

// ─── Tool-call ids (§7.1) ─────────────────────────────────────────────────────────────────────────────────────

const WIRE_ID_MAX = 128;
const SAFE_ID = /^[\w.:@-]{1,128}$/;

/**
 * The id the model sees: the provider's own when present and not yet used in this context; a missing id becomes
 * `call_<turn>_<step>_<i>`; a repeated one (many open models emit `call_0` every turn) becomes `<id>_t<turn>s<step>`
 * (plus `_<i>` if it still collides). Decided once, when the message is first stored, so history is byte-stable.
 */
export function assignWireIds(input: { calls: readonly GwToolCall[]; turn: number; step: number; isUsed(id: string): boolean }): string[] {
  const taken = new Set<string>();
  const used = (id: string) => taken.has(id) || input.isUsed(id);
  return input.calls.map((c, i) => {
    const raw = typeof c.id === 'string' ? c.id.trim() : '';
    let id = raw && SAFE_ID.test(raw) ? raw : `call_${input.turn}_${input.step}_${i}`;
    if (used(id)) id = `${id.slice(0, WIRE_ID_MAX - 16)}_t${input.turn}s${input.step}`;
    if (used(id)) id = `${id}_${i}`;
    let n = 2;
    while (used(id)) id = `${id}_${n++}`;
    taken.add(id);
    return id;
  });
}

// ─── Git record ───────────────────────────────────────────────────────────────────────────────────────────────

/** The paths recorded at thread creation (git-safe uses only these, §8.2); null when the thread has no worktree. */
export function threadGitRecord(thread: ThreadRow, project: ProjectRow): ThreadGitRecord | null {
  if (!thread.worktreePath || !thread.gitDir || !thread.commonDir) return null;
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    strategy: thread.strategy,
    projectRoot: project.rootPath,
    worktreePath: thread.worktreePath,
    gitDir: thread.gitDir,
    commonDir: thread.commonDir,
    gitPointer: thread.gitPointer,
    objectDir: thread.objectDir,
    branch: thread.branch,
    baseRef: thread.baseRef,
    baseSha: thread.baseSha,
    refFormat: project.refFormat,
  };
}
