/**
 * Code slice service (harness.md §12, H3-A/B): projects, threads, runs, review, permissions and MCP servers.
 * It forwards CodeApi to the harness host through supervisor.command/query, owns the native confirmations main must
 * show (project trust, loosening, destructive git), keeps thread caps in the gateway, and brokers approvals.
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  ApprovalRequest,
  CodeApi,
  CodeState,
  CodeThread,
  CodeThreadSettings,
  CodeThreadSummary,
  DiffFile,
  McpServerConfig,
  TimelineItem,
  PermissionRule,
  ThreadStrategy,
} from '@shared/contracts/code';
import { defaultCodeThreadSettings } from '@shared/contracts/code';
import { GmiError, toGmiError } from '@shared/contracts/errors';
import type { GatewayRequest } from '@shared/contracts/gateway';
import type { HarnessCommand, HarnessQueryName } from '@harness/protocol';
import type { AppContext } from '../../core/context';
import type { GmiGateway } from '../../core/services';
import type { HarnessSlice } from '../../slices/harness';
import { describeLoosening, looseningMessage } from './loosening';
import { createMcpService } from './mcp';
import { createProjectService } from './projects';

export interface CodeServiceDeps {
  gateway: GmiGateway;
  harness: HarnessSlice;
}

export interface CodeService {
  api: CodeApi;
}

/** True when the host is definitely not able to answer (a stopped host is started by the supervisor). */
function assertHostUsable(info: { hostState: string }): void {
  if (info.hostState === 'crashed') {
    throw new GmiError('internal', 'The agent runtime crashed — Code is view-only until it restarts (Settings › About › Diagnostics).');
  }
}

export function createCodeService(ctx: AppContext, deps: CodeServiceDeps): CodeService {
  const { gateway, harness } = deps;
  const supervisor = harness.supervisor;
  const log = ctx.log.child('code');
  const command = (cmd: HarnessCommand) => supervisor.command(cmd);
  const query = <T>(name: HarnessQueryName, args: unknown = {}): Promise<T> => supervisor.command({ op: 'query', name, args }) as Promise<T>;
  let sandbox: CodeState['sandbox'] | null = null;
  const threadCommands = new Map<string, Promise<unknown>>();
  const inThread = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const next = (threadCommands.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    threadCommands.set(id, next);
    void next.finally(() => { if (threadCommands.get(id) === next) threadCommands.delete(id); }).catch(() => undefined);
    return next;
  };

  const projects = createProjectService(ctx, command, log);
  const mcp = createMcpService(ctx, command);

  const threadOf = async (threadId: string): Promise<CodeThread> => {
    assertHostUsable(supervisor.info());
    return query<CodeThread>('thread', { threadId });
  };

  const confirmLoosening = async (title: string, reasons: string[]): Promise<void> => {
    if (reasons.length === 0) return;
    if (!(await ctx.platform.confirm({ title: 'Widen thread permissions?', message: looseningMessage(title, reasons), confirmLabel: 'Widen permissions', cancelLabel: 'Keep current' }))) {
      throw new GmiError('cancelled', 'Thread settings unchanged.');
    }
  };

  const applyCaps = (threadId: string, settings: CodeThreadSettings, loosened: boolean) => {
    const caps = { perTurnUsd: settings.budget.perTurnUsd, perThreadUsd: settings.budget.perThreadUsd };
    if (loosened) gateway.approveThreadCaps(threadId, caps);
    else gateway.setThreadCaps(threadId, caps);
  };

  const getState = async (): Promise<CodeState> => {
    const info = supervisor.info();
    const pending = harness.approvals.listPending();
    return {
      hostState: info.hostState as CodeState['hostState'],
      viewOnly: info.hostState === 'crashed',
      sandbox: sandbox ?? info.sandbox ?? { kind: 'none', ok: false, detail: 'the runtime has not started yet', network: 'none' },
      git: info.git ?? { ok: false, version: null },
      ripgrep: info.ripgrep ?? false,
      gateway: gateway.status(),
      pendingApprovals: pending.length,
      mock: !!ctx.mock,
    };
  };

  const listThreads = (opts?: { projectId?: string; archived?: boolean }) => query<CodeThreadSummary[]>('threads', opts ?? {});

  const ensureModel = (settings: CodeThreadSettings) => {
    if (!settings.model.trim()) throw new GmiError('invalid_input', 'Choose a model for the thread first.');
  };

  const createThread = async (projectId: string, init: { title?: string; strategy: ThreadStrategy; settings?: Partial<CodeThreadSettings> }): Promise<CodeThread> => {
    assertHostUsable(supervisor.info());
    await projects.requireTrusted(projectId);
    const strategy = init.strategy;
    if (strategy.kind === 'worktree' && !strategy.baseRef.trim()) throw new GmiError('invalid_input', 'Choose a base branch for the worktree.');
    if (strategy.kind === 'existing_worktree' && !strategy.path.startsWith('/')) throw new GmiError('invalid_input', 'The existing worktree must be an absolute path.');
    const settings = defaultCodeThreadSettings(init.settings ?? {});
    if (settings.runtime !== 'gmi') throw new GmiError('not_implemented', 'The OpenCode runtime is not available yet; use the GMI runtime.');
    ensureModel(settings);
    const reasons = describeLoosening(defaultCodeThreadSettings({ model: settings.model }), init.settings ?? {});
    await confirmLoosening(init.title?.trim() || 'the new thread', reasons);
    const summary = (await command({
      op: 'thread.create',
      projectId,
      init: { ...(init.title?.trim() ? { title: init.title.trim() } : {}), strategy, settings },
    })) as CodeThreadSummary;
    applyCaps(summary.id, settings, reasons.length > 0);
    return threadOf(summary.id);
  };

  const updateThread = async (threadId: string, patch: { title?: string; settings?: Partial<CodeThreadSettings> }): Promise<CodeThread> => {
    const current = await threadOf(threadId);
    if (patch.settings && ['running', 'queued', 'awaiting_approval', 'awaiting_user', 'compacting'].includes(current.status)) {
      throw new GmiError('conflict', 'Stop the run before changing its settings.');
    }
    const nextSettings = defaultCodeThreadSettings({ ...current.settings, ...patch.settings, budget: { ...current.settings.budget, ...patch.settings?.budget } });
    if (nextSettings.runtime !== 'gmi') throw new GmiError('not_implemented', 'The OpenCode runtime is not available yet; use the GMI runtime.');
    if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 200)) throw new GmiError('invalid_input', 'A thread title must be 1–200 characters.');
    let loosened = false;
    if (patch.settings) {
      const reasons = describeLoosening(current.settings, patch.settings);
      await confirmLoosening(current.title, reasons);
      loosened = reasons.length > 0;
    }
    const summary = (await command({
      op: 'thread.update',
      threadId,
      patch: { ...(patch.title !== undefined ? { title: patch.title.trim() } : {}), ...(patch.settings ? { settings: patch.settings } : {}) },
    })) as CodeThreadSummary;
    void summary;
    const thread = await threadOf(threadId);
    // Only the settings main approved may widen caps; never trust values returned by the host.
    applyCaps(threadId, nextSettings, loosened);
    return thread;
  };

  const archiveThread = async (threadId: string, opts: { removeWorktree: boolean; deleteBranch: boolean }): Promise<void> => {
    if (opts.removeWorktree || opts.deleteBranch) {
      const thread = await threadOf(threadId);
      const message = [
        `Archive “${thread.title || thread.id.slice(0, 8)}”?`,
        ...(opts.removeWorktree ? ['Its worktree and uncommitted changes are deleted.'] : []),
        ...(opts.deleteBranch && thread.branch ? [`Its branch ${thread.branch} is deleted.`] : []),
      ].join('\n');
      if (!(await ctx.platform.confirm({ title: 'Remove thread files?', message, confirmLabel: 'Archive and remove', cancelLabel: 'Cancel' }))) {
        throw new GmiError('cancelled', 'Thread kept.');
      }
    }
    await command({ op: 'thread.archive', threadId, removeWorktree: opts.removeWorktree, deleteBranch: opts.deleteBranch });
  };

  const deleteThread = async (threadId: string): Promise<void> => {
    const thread = await threadOf(threadId);
    const message = `Delete “${thread.title || thread.id.slice(0, 8)}” and its transcript? The worktree is left on disk. This cannot be undone.`;
    if (!(await ctx.platform.confirm({ title: 'Delete thread?', message, confirmLabel: 'Delete thread', cancelLabel: 'Cancel' }))) {
      throw new GmiError('cancelled', 'Thread kept.');
    }
    await command({ op: 'thread.delete', threadId });
  };

  const requireRunnableThread = async (threadId: string): Promise<CodeThread> => {
    const thread = await threadOf(threadId);
    await projects.requireTrusted(thread.projectId);
    ensureModel(thread.settings);
    applyCaps(threadId, thread.settings, false);
    return thread;
  };

  const send = async (threadId: string, text: string): Promise<{ runId: string; turn: number; budgetWarning: string | null }> => {
    await requireRunnableThread(threadId);
    if (!text.trim()) throw new GmiError('invalid_input', 'Type a message first.');
    const result = (await command({ op: 'run.send', threadId, text })) as { runId: string; turn: number; budgetWarning?: string | null };
    return { runId: result.runId, turn: result.turn, budgetWarning: result.budgetWarning ?? null };
  };

  const resume = async (threadId: string): Promise<{ runId: string }> => {
    await requireRunnableThread(threadId);
    const result = (await command({ op: 'run.resume', threadId })) as { runId: string };
    return { runId: result.runId };
  };

  const getTimeline = (threadId: string, opts?: { afterSeq?: number; beforeSeq?: number; limit?: number }) =>
    query<{ items: TimelineItem[]; hasMore: boolean; lastSeq: number }>('timeline', { threadId, ...opts });

  const getDiff = (threadId: string, opts?: { against?: 'base' | 'checkpoint'; checkpointId?: string }) => query<DiffFile[]>('diff', { threadId, ...opts });

  const getFileDiff = async (threadId: string, path: string, opts?: { against?: 'base' | 'checkpoint'; checkpointId?: string }): Promise<DiffFile> => {
    const files = await getDiff(threadId, opts);
    const file = files.find((f) => f.path === path);
    if (!file) throw new GmiError('not_found', 'That file is not in the thread’s diff.');
    return query<DiffFile>('fileDiff', { threadId, path, ...opts });
  };

  const discardFile = async (threadId: string, path: string): Promise<void> => {
    const message = `Discard every change to ${path}? The agent's uncommitted edits to this file are lost.`;
    if (!(await ctx.platform.confirm({ title: 'Discard changes?', message, confirmLabel: 'Discard changes', cancelLabel: 'Keep' }))) {
      throw new GmiError('cancelled', 'Changes kept.');
    }
    await command({ op: 'git', name: 'discard', args: { threadId, path } });
  };

  const restoreCheckpoint = async (threadId: string, checkpointId: string): Promise<void> => {
    const message = 'Restore the worktree to this checkpoint? Changes made since then are overwritten (a checkpoint of the current state is kept).';
    if (!(await ctx.platform.confirm({ title: 'Restore checkpoint?', message, confirmLabel: 'Restore', cancelLabel: 'Cancel' }))) {
      throw new GmiError('cancelled', 'Checkpoint not restored.');
    }
    await command({ op: 'git', name: 'restore', args: { threadId, checkpointId } });
  };

  const commit = async (threadId: string, message: string): Promise<{ sha: string }> => {
    if (!message.trim()) throw new GmiError('invalid_input', 'A commit needs a message.');
    return (await command({ op: 'git', name: 'commit', args: { threadId, message } })) as { sha: string };
  };

  /** A best-effort subject line: the configured side-task model, or a local fallback when there is no key/model. */
  const suggestCommitMessage = async (threadId: string): Promise<{ message: string; costUsd: number | null }> => {
    const thread = await threadOf(threadId);
    const files = await getDiff(threadId);
    if (files.length === 0) throw new GmiError('invalid_input', 'There is nothing to commit.');
    const fallback = files.length === 1 ? `Update ${basename(files[0]!.path)}` : `Update ${files.length} files`;
    const model = thread.settings.sideTaskModel && thread.settings.sideTaskModel !== 'router' ? thread.settings.sideTaskModel : thread.settings.model;
    if (!model) return { message: fallback, costUsd: null };
    const summary = [
      `Repository: ${basename(thread.worktreePath ?? '') || 'project'}`,
      `Branch: ${thread.branch ?? 'detached'}`,
      `Files (${files.length}):`,
      ...files.slice(0, 60).map((f) => `${f.status} ${f.path} (+${f.additions} −${f.deletions})`),
    ].join('\n');
    const request: GatewayRequest = {
      requestId: randomUUID(),
      purpose: 'commit_message',
      priority: 'background',
      scope: { threadId: null, turnId: null, runId: null, step: null },
      target: { model },
      messages: [
        { role: 'system', content: 'You write Conventional Commits subject lines. Reply with exactly one line, at most 72 characters, no quotes, no trailing period.' },
        { role: 'user', content: summary },
      ],
      maxOutputTokens: 80,
      temperature: 0.2,
      prefixHash: null,
    };
    const controller = new AbortController();
    let text = '';
    let cost: number | null = null;
    try {
      for await (const event of gateway.stream(request, controller.signal)) {
        if (event.type === 'text') text += event.text;
        else if (event.type === 'usage') cost = event.costUsd;
        else if (event.type === 'error') throw GmiError.fromShape(event.error);
        if (event.type === 'finish') break;
      }
    } catch (error) {
      log.warn('commit message suggestion failed; using the local fallback', { code: toGmiError(error).code });
      return { message: fallback, costUsd: null };
    }
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return { message: line && line.length <= 120 ? line : fallback, costUsd: cost };
  };

  const mergeToBase = async (threadId: string, method: 'merge' | 'squash'): Promise<{ sha: string }> => {
    const thread = await threadOf(threadId);
    const project = (await projects.list()).find((p) => p.id === thread.projectId);
    const message = [
      `Merge ${thread.branch ?? 'the thread worktree'} into ${project?.defaultBranch ?? 'the project’s base branch'} (${method}).`,
      'The project root must be clean; nothing is pushed.',
    ].join('\n');
    if (!(await ctx.platform.confirm({ title: 'Merge thread into base?', message, confirmLabel: 'Merge', cancelLabel: 'Cancel' }))) {
      throw new GmiError('cancelled', 'Not merged.');
    }
    return (await command({ op: 'git', name: 'merge', args: { threadId, method } })) as { sha: string };
  };

  const exportPatch = async (threadId: string): Promise<string | null> => {
    const result = (await command({ op: 'git', name: 'exportPatch', args: { threadId } })) as { patch: string };
    const path = await ctx.platform.pickSavePath({ title: 'Export patch', defaultName: `gmi-${threadId.slice(0, 8)}.patch` });
    if (!path) return null;
    await writeFile(path, result.patch, 'utf8');
    return path;
  };

  const revealWorktree = async (threadId: string): Promise<void> => {
    const thread = await threadOf(threadId);
    if (!thread.worktreePath) throw new GmiError('invalid_input', 'This thread has no worktree on disk.');
    ctx.platform.showItemInFolder(thread.worktreePath);
  };

  const readSpill = async (threadId: string, spillId: string): Promise<{ text: string; truncated: boolean }> => {
    const result = await query<{ text: string }>('spill', { threadId, spillId });
    return { text: result.text, truncated: Buffer.byteLength(result.text) >= 4 * 1024 * 1024 - 64 * 1024 };
  };

  const addMcpServer = (config: Omit<McpServerConfig, 'id'>, env?: Record<string, string>) => mcp.add(config, env);

  const api: CodeApi = {
    getState,
    listProjects: () => projects.list().catch(() => []),
    addProject: () => projects.add(),
    removeProject: (projectId, opts) => projects.remove(projectId, opts),
    trustProject: (projectId) => projects.trust(projectId),
    updateProject: (projectId, patch) => projects.update(projectId, patch),
    listThreads,
    getThread: threadOf,
    getTimeline,
    createThread,
    updateThread: (id, patch) => inThread(id, () => updateThread(id, patch)),
    archiveThread: (id, opts) => inThread(id, () => archiveThread(id, opts)),
    deleteThread: (id) => inThread(id, () => deleteThread(id)),
    send: (id, text) => inThread(id, () => send(id, text)),
    steer: async (threadId, text) => {
      if (!text.trim()) throw new GmiError('invalid_input', 'Type a message first.');
      await command({ op: 'run.steer', threadId, text });
    },
    interrupt: async (threadId) => void (await command({ op: 'run.interrupt', threadId })),
    resume: (id) => inThread(id, () => resume(id)),
    respondApproval: (requestId, decision) => harness.approvals.respond(requestId, decision),
    listPendingApprovals: async (): Promise<ApprovalRequest[]> => harness.approvals.listPending(),
    getDiff,
    getFileDiff,
    discardFile,
    restoreCheckpoint,
    commit,
    suggestCommitMessage,
    mergeToBase,
    exportPatch,
    revealWorktree,
    readSpill,
    listRules: (opts) => query<PermissionRule[]>('rules', opts ?? {}),
    deleteRule: async (ruleId) => void (await command({ op: 'rules.delete', ruleId })),
    listMcpServers: (opts) => mcp.list(opts),
    addMcpServer,
    updateMcpServer: (id, patch) => mcp.update(id, patch),
    removeMcpServer: (id) => mcp.remove(id),
    authorizeMcpServer: (id) => mcp.authorize(id),
    getGatewayStatus: async () => gateway.status(),
    checkSandbox: async () => {
      sandbox = (await command({ op: 'sandbox.selftest' })) as CodeState['sandbox'];
      return getState();
    },
  };

  return { api };
}
