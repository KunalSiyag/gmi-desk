// Mock Code API (GMI_DESK_MOCK=1): a demo project, two threads, a timeline, diffs, rules and MCP servers. Nothing here
// spawns the harness host or touches the network; state changes live in memory for the session.
import { GmiError } from '@shared/contracts/errors';
import { defaultCodeThreadSettings, type ApprovalRequest, type CodeApi, type CodeProject, type CodeState, type CodeThread, type CodeThreadSettings, type CodeThreadSummary, type DiffFile, type McpServerConfig, type McpServerStatus, type PermissionRule, type TimelineItem } from '@shared/contracts/code';
import type { GmiGateway } from '../core/services';

const PROJECT_ID = 'prj_demo0001';
const THREAD_A = 'thr_demo0001';
const THREAD_B = 'thr_demo0002';
const CREATED = '2026-10-30T09:12:00.000Z';
const UPDATED = '2026-11-03T14:21:00.000Z';

const project: CodeProject = {
  id: PROJECT_ID,
  name: 'gmi-desk',
  rootPath: '/home/demo/gmi-desk',
  defaultBranch: 'main',
  trust: { state: 'trusted', configHash: 'demo', trustedAt: CREATED },
  worktreeDir: '/home/demo/.config/GMI Desk Mock/worktrees',
  setupCommand: 'npm ci',
  addedAt: CREATED,
  threadCount: 2,
};

const settingsFor = (model: string, over: Partial<CodeThreadSettings> = {}) =>
  defaultCodeThreadSettings({ model, mode: 'auto-accept-edits', reasoningEffort: 'medium', ...over });

function summary(over: Partial<CodeThreadSummary> & Pick<CodeThreadSummary, 'id' | 'title'>): CodeThreadSummary {
  return {
    projectId: PROJECT_ID,
    strategy: 'worktree',
    branch: `gmi/${over.id.slice(-6)}/work`,
    worktreePath: `/home/demo/.config/GMI Desk Mock/worktrees/${over.id.slice(-6)}`,
    status: 'idle',
    statusReason: null,
    pendingApprovals: 0,
    queuePosition: null,
    queueReason: null,
    model: 'deepseek-ai/deepseek-v3.1',
    mode: 'auto-accept-edits',
    costUsd: 0.42,
    tokens: { input: 48_210, cached: 31_004, output: 7_912, reasoning: 2_140 },
    diff: { files: 2, additions: 84, deletions: 12 },
    createdAt: CREATED,
    updatedAt: UPDATED,
    archived: false,
    ...over,
  };
}

const threads = new Map<string, CodeThread>();
threads.set(THREAD_A, {
  ...summary({ id: THREAD_A, title: 'Fix the streaming parser', status: 'awaiting_approval', pendingApprovals: 1 }),
  settings: settingsFor('deepseek-ai/deepseek-v3.1'),
  baseRef: 'main',
  checkpoints: [{ id: 'ck_1', turn: 1, createdAt: UPDATED, filesChanged: 2 }],
  todo: [
    { id: 't1', text: 'Reproduce the dropped-close bug', status: 'done' },
    { id: 't2', text: 'Flush the tail on [DONE]', status: 'in_progress' },
    { id: 't3', text: 'Regression test', status: 'pending' },
  ],
  meter: {
    windowTokens: 163_840,
    ceilingTokens: 160_000,
    usedTokens: 48_210,
    reserveTokens: 16_384,
    cachedRatio: 0.64,
    compactions: 0,
    tierBoundaryTokens: 200_000,
    messageCount: 12,
    nextStepUsd: 0.004,
    estimated: false,
  },
  lastSeq: 8,
});
threads.set(THREAD_B, {
  ...summary({ id: THREAD_B, title: 'Add budget guard tests', status: 'running', costUsd: 0.18, diff: null, updatedAt: '2026-11-03T14:22:00.000Z' }),
  settings: settingsFor('openai/gpt-5.4', { mode: 'approval-required' }),
  baseRef: 'main',
  checkpoints: [],
  todo: [],
  meter: {
    windowTokens: 400_000,
    ceilingTokens: 160_000,
    usedTokens: 22_400,
    reserveTokens: 16_384,
    cachedRatio: 0.51,
    compactions: 0,
    tierBoundaryTokens: null,
    messageCount: 4,
    nextStepUsd: 0.006,
    estimated: true,
  },
  lastSeq: 3,
});

const pending: ApprovalRequest[] = [
  {
    requestId: 'apr_demo0001',
    threadId: THREAD_A,
    runId: 'run_demo0001',
    toolCallId: 'call_1',
    kind: 'command',
    tool: 'shell',
    title: 'Run the test suite',
    detail: { command: 'npm test -- test/streaming.test.ts', cwd: '/home/demo/.config/GMI Desk Mock/worktrees/demo0001' },
    risk: [],
    suggestedRule: { tool: 'shell', pattern: 'npm test', effect: 'allow', scope: 'thread' },
    allowedDecisions: ['allow_once', 'allow_thread', 'allow_always', 'deny', 'cancel_run'],
    createdAt: UPDATED,
    expiresAt: null,
  },
];

const timeline = new Map<string, TimelineItem[]>([
  [
    THREAD_A,
    [
      { kind: 'user', id: 'it_1', seq: 1, turn: 1, text: 'Streaming replies sometimes lose the last sentence. Find it and fix it.', steering: false, at: CREATED },
      {
        kind: 'assistant',
        id: 'it_2',
        seq: 2,
        turn: 1,
        step: 1,
        text: 'I will trace the SSE parser and reproduce the truncated tail first.',
        reasoning: 'The final chunk likely arrives with the [DONE] sentinel and is dropped by the flush path.',
        model: 'deepseek-ai/deepseek-v3.1',
        usage: { promptTokens: 2_140, cachedTokens: 1_400, completionTokens: 210, reasoningTokens: 96, costUsd: 0.0012, estimated: false, model: 'deepseek-ai/deepseek-v3.1', latencyMs: 1_840 },
        status: 'complete',
        at: CREATED,
      },
      {
        kind: 'tool',
        id: 'it_3',
        seq: 3,
        turn: 1,
        step: 1,
        toolCallId: 'call_1',
        tool: 'fs_read',
        title: 'Read src/streaming/parser.ts',
        argsPreview: '{"path":"src/streaming/parser.ts"}',
        status: 'succeeded',
        output: { text: 'export function parseChunk(chunk: string) { … }', truncated: false, totalBytes: 4_812, spillId: null },
        durationMs: 42,
        at: CREATED,
      },
      {
        kind: 'assistant',
        id: 'it_4',
        seq: 4,
        turn: 1,
        step: 2,
        text: 'Found it: the parser returns before flushing the buffered event when the stream ends with `[DONE]`. I added a final `flush()` and a regression test; now running the suite.',
        reasoning: null,
        model: 'deepseek-ai/deepseek-v3.1',
        usage: { promptTokens: 3_221, cachedTokens: 2_600, completionTokens: 340, reasoningTokens: 0, costUsd: 0.0018, estimated: false, model: 'deepseek-ai/deepseek-v3.1', latencyMs: 2_140 },
        status: 'complete',
        at: UPDATED,
      },
      { kind: 'approval', id: 'it_5', seq: 5, request: pending[0]!, decision: null },
      { kind: 'checkpoint', id: 'it_6', seq: 6, checkpointId: 'ck_1', turn: 1, filesChanged: 2, at: UPDATED },
      { kind: 'notice', id: 'it_7', seq: 7, level: 'info', reason: 'instructions_changed', text: 'AGENTS.md changed since this thread started; the next turn reloads it.', at: UPDATED },
      { kind: 'compaction', id: 'it_8', seq: 8, beforeTokens: 58_000, afterTokens: 21_000, model: 'deepseek-ai/deepseek-v3.1', costUsd: 0.0004, at: UPDATED },
    ],
  ],
  [
    THREAD_B,
    [
      { kind: 'user', id: 'it_b1', seq: 1, turn: 1, text: 'Add tests for the daily budget guard.', steering: false, at: UPDATED },
      { kind: 'assistant', id: 'it_b2', seq: 2, turn: 1, step: 1, text: 'Reading the budget guard and its existing tests.', reasoning: null, model: 'openai/gpt-5.4', usage: null, status: 'streaming', at: UPDATED },
      { kind: 'tool', id: 'it_b3', seq: 3, turn: 1, step: 1, toolCallId: 'call_b1', tool: 'grep', title: 'Find budget tests', argsPreview: '{"pattern":"evaluateBudget"}', status: 'running', output: null, durationMs: null, at: UPDATED },
    ],
  ],
]);

const diffFiles: DiffFile[] = [
  {
    path: 'src/streaming/parser.ts',
    oldPath: null,
    status: 'modified',
    additions: 12,
    deletions: 2,
    sensitive: false,
    hunks: [
      {
        header: '@@ -88,6 +88,16 @@ export function parseChunk(chunk: string) {',
        lines: [
          { type: 'ctx', oldNo: 88, newNo: 88, text: '  const events = buffer.split(\'\\n\\n\');' },
          { type: 'del', oldNo: 89, newNo: null, text: '  return events.map(parseEvent);' },
          { type: 'add', oldNo: null, newNo: 89, text: '  const parsed = events.map(parseEvent);' },
          { type: 'add', oldNo: null, newNo: 90, text: '  const tail = events.at(-1);' },
          { type: 'add', oldNo: null, newNo: 91, text: '  if (tail && !tail.endsWith(\'\\n\\n\')) flush(tail);' },
          { type: 'add', oldNo: null, newNo: 92, text: '  return parsed;' },
        ],
      },
    ],
    tooLarge: false,
  },
  {
    path: 'test/streaming.test.ts',
    oldPath: null,
    status: 'added',
    additions: 72,
    deletions: 10,
    sensitive: false,
    hunks: null,
    tooLarge: false,
  },
  {
    path: '.github/workflows/ci.yml',
    oldPath: null,
    status: 'modified',
    additions: 2,
    deletions: 2,
    sensitive: true,
    hunks: null,
    tooLarge: false,
  },
];

const diffStat = { files: 3, additions: 86, deletions: 14 };

const rules: PermissionRule[] = [
  { id: 'rule_1', tool: 'shell', pattern: 'npm test', effect: 'allow', scope: 'project', projectId: PROJECT_ID, threadId: null, source: 'user', createdAt: CREATED },
  { id: 'rule_2', tool: 'fs_write', pattern: '.github/**', effect: 'deny', scope: 'global', projectId: null, threadId: null, source: 'preset', createdAt: CREATED },
];

let mcpServers: McpServerStatus[] = [
  {
    id: 'mcp_1',
    name: 'GMI Cloud',
    scope: 'global',
    projectId: null,
    transport: { type: 'http', url: 'https://mcp.gmicloud.ai/mcp', auth: 'oauth' },
    enabled: true,
    toolPolicy: { search_models: 'allow', submit_generation: 'ask' },
    state: 'ready',
    resolvedVersion: null,
    unpinned: false,
    tools: [
      { name: 'search_models', changed: false, policy: 'allow' },
      { name: 'get_model', changed: false, policy: 'allow' },
      { name: 'submit_generation', changed: false, policy: 'ask' },
    ],
    error: null,
  },
  {
    id: 'mcp_2',
    name: 'Filesystem',
    scope: 'project',
    projectId: PROJECT_ID,
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/demo/gmi-desk'], envNames: [], cwd: null, network: false },
    enabled: true,
    toolPolicy: {},
    state: 'stopped',
    resolvedVersion: null,
    unpinned: true,
    tools: [],
    error: null,
  },
];

export function createMockCode(deps: { gateway: Pick<GmiGateway, 'status'> }): CodeApi {
  const findThread = (id: string): CodeThread => {
    const thread = threads.get(id);
    if (!thread) throw new GmiError('not_found', 'Thread not found.');
    return thread;
  };

  const api: CodeApi = {
    async getState() {
      const state: CodeState = {
        hostState: 'ready',
        viewOnly: false,
        sandbox: { kind: 'bwrap', ok: true, detail: null, network: 'proxy' },
        git: { ok: true, version: '2.43.0' },
        ripgrep: true,
        gateway: deps.gateway.status(),
        pendingApprovals: pending.length,
        mock: true,
      };
      return state;
    },
    async listProjects() {
      return [{ ...project, threadCount: threads.size }];
    },
    async addProject() {
      return null;
    },
    async removeProject() {},
    async trustProject(projectId) {
      if (projectId !== PROJECT_ID) throw new GmiError('not_found', 'Project not found.');
      return project;
    },
    async updateProject(_projectId, patch) {
      return { ...project, ...patch };
    },
    async listThreads(opts) {
      return [...threads.values()].filter((t) => !opts?.archived && !t.archived).map(({ settings: _s, ...rest }) => rest);
    },
    async getThread(threadId) {
      return findThread(threadId);
    },
    async getTimeline(threadId, opts) {
      const items = [...(timeline.get(threadId) ?? [])];
      const after = opts?.afterSeq ?? 0;
      const filtered = items.filter((i) => i.seq > after);
      const limit = opts?.limit ?? 200;
      return { items: filtered.slice(-limit), hasMore: filtered.length > limit, lastSeq: items.at(-1)?.seq ?? 0 };
    },
    async createThread(projectId, init) {
      const id = `thr_demo${String(threads.size + 1).padStart(4, '0')}`;
      const thread: CodeThread = {
        ...summary({ id, title: init.title ?? 'New thread', status: 'idle', costUsd: 0, diff: null, tokens: { input: 0, cached: 0, output: 0, reasoning: 0 } }),
        projectId,
        settings: settingsFor(init.settings?.model ?? 'deepseek-ai/deepseek-v3.1', init.settings ?? {}),
        baseRef: init.strategy.kind === 'worktree' ? init.strategy.baseRef : null,
        checkpoints: [],
        todo: [],
        meter: { windowTokens: 163_840, ceilingTokens: 160_000, usedTokens: 0, reserveTokens: 16_384, cachedRatio: null, compactions: 0, tierBoundaryTokens: null, messageCount: 0, nextStepUsd: null, estimated: true },
        lastSeq: 0,
      };
      threads.set(id, thread);
      timeline.set(id, []);
      return thread;
    },
    async updateThread(threadId, patch) {
      const thread = findThread(threadId);
      const next: CodeThread = {
        ...thread,
        title: patch.title ?? thread.title,
        settings: { ...thread.settings, ...(patch.settings ?? {}), budget: { ...thread.settings.budget, ...(patch.settings?.budget ?? {}) } },
        mode: patch.settings?.mode ?? thread.mode,
        model: patch.settings?.model ?? thread.model,
      };
      threads.set(threadId, next);
      return next;
    },
    async archiveThread(threadId) {
      const thread = findThread(threadId);
      threads.set(threadId, { ...thread, archived: true });
    },
    async deleteThread(threadId) {
      threads.delete(threadId);
      timeline.delete(threadId);
    },
    async send(threadId, text) {
      const thread = findThread(threadId);
      const seq = thread.lastSeq + 1;
      const turn = (timeline.get(threadId) ?? []).reduce((max, i) => ('turn' in i ? Math.max(max, i.turn) : max), 0) + 1;
      timeline.get(threadId)?.push({ kind: 'user', id: `it_${seq}`, seq, turn, text, steering: false, at: new Date().toISOString() });
      threads.set(threadId, { ...thread, status: 'running', lastSeq: seq });
      return { runId: `run_${seq}`, turn, budgetWarning: null };
    },
    async steer(threadId) {
      findThread(threadId);
    },
    async interrupt(threadId) {
      const thread = findThread(threadId);
      threads.set(threadId, { ...thread, status: 'stopped' });
    },
    async resume(threadId) {
      findThread(threadId);
      return { runId: 'run_resume' };
    },
    async respondApproval(requestId) {
      const index = pending.findIndex((p) => p.requestId === requestId);
      if (index < 0) throw new GmiError('not_found', 'This approval is no longer pending.');
      pending.splice(index, 1);
    },
    async listPendingApprovals() {
      return [...pending];
    },
    async getDiff() {
      return diffFiles.map((f) => ({ ...f, hunks: null }));
    },
    async getFileDiff(_threadId, path) {
      const file = diffFiles.find((f) => f.path === path);
      if (!file) throw new GmiError('not_found', 'File not in this thread’s diff.');
      return file;
    },
    async discardFile() {},
    async restoreCheckpoint() {},
    async commit(_threadId, _message) {
      return { sha: '0000000000000000000000000000000000000000' };
    },
    async suggestCommitMessage() {
      return { message: 'Flush the buffered SSE event when a stream ends with [DONE]', costUsd: 0.0002 };
    },
    async mergeToBase() {
      return { sha: '0000000000000000000000000000000000000000' };
    },
    async exportPatch() {
      return '/home/demo/gmi-desk/.agent-builds/demo.patch';
    },
    async revealWorktree() {},
    async readSpill() {
      return { text: '…truncated tool output…', truncated: false };
    },
    async listRules() {
      return [...rules];
    },
    async deleteRule(ruleId) {
      rules.splice(0, rules.length, ...rules.filter((r) => r.id !== ruleId));
    },
    async listMcpServers() {
      return mcpServers.map((s) => ({ ...s }));
    },
    async addMcpServer(config) {
      const server: McpServerStatus = {
        ...config,
        id: `mcp_${mcpServers.length + 1}`,
        state: 'stopped',
        resolvedVersion: null,
        unpinned: config.transport.type === 'stdio' && config.transport.args.some((a) => !a.includes('@')),
        tools: [],
        error: null,
      };
      mcpServers = [...mcpServers, server];
      return server;
    },
    async updateMcpServer(id, patch) {
      const index = mcpServers.findIndex((s) => s.id === id);
      if (index < 0) throw new GmiError('not_found', 'MCP server not found.');
      const next = { ...mcpServers[index]!, ...patch };
      mcpServers = mcpServers.map((s, i) => (i === index ? next : s));
      return next;
    },
    async removeMcpServer(id) {
      mcpServers = mcpServers.filter((s) => s.id !== id);
    },
    async authorizeMcpServer() {
      throw new GmiError('not_implemented', 'MCP OAuth arrives with the MCP transport milestone.');
    },
    async getGatewayStatus() {
      return deps.gateway.status();
    },
    async checkSandbox() {
      return api.getState();
    },
  };
  return api;
}

/** Nothing is spawned in mock mode; kept for parity with the other mock modules. */
export function disposeMockCode(): void {
  pending.splice(0, pending.length);
}

export type { McpServerConfig };
