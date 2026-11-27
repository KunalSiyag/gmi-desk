/**
 * Test bench for the agent loop (H2-B): the conforming fakes of test/harness/fakes.ts wired into createAgentLoop,
 * plus a project and a ready thread. No network, no processes, no files.
 */
import { CODE_DEFAULTS, type CodeThreadSettings } from '@shared/contracts/code';
import type { GatewayEvent, GwToolCall } from '@shared/contracts/gateway';
import { createAgentLoop, type AgentLoop, type LoopDeps } from '@harness/loop/runner';
import { contextIdOf, type MessageRow, type ProjectRow, type ThreadRow, type ToolDefinition } from '@harness/types';
import {
  fakeClock,
  fakeCompactor,
  fakeGitService,
  fakeMainLink,
  fakePermissionEngine,
  fakeSandboxRunner,
  fakeTool,
  memoryMutationLock,
  memoryStore,
  memoryToolRegistry,
  okResult,
  scriptedGatewayClient,
  type FakeClock,
  type FakeMainLink,
} from '../fakes';

export const T0 = Date.parse('2026-11-02T10:00:00.000Z');
export const PROJECT_ID = 'p_demo';
export const THREAD_A = 'c0de0000-0000-4000-8000-00000000000a';
export const THREAD_B = 'c0de0000-0000-4000-8000-00000000000b';
export const MODEL = 'zai-org/GLM-5.3';

export function settings(over: Partial<CodeThreadSettings> = {}): CodeThreadSettings {
  return {
    runtime: 'gmi',
    model: MODEL,
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
    budget: { perTurnUsd: CODE_DEFAULTS.perTurnUsd, perThreadUsd: CODE_DEFAULTS.perThreadUsd, maxStepsPerTurn: CODE_DEFAULTS.maxStepsPerTurn, maxTurnMinutes: CODE_DEFAULTS.maxTurnMinutes },
    computerId: null,
    ...over,
  };
}

export function projectRow(over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: PROJECT_ID,
    rootPath: '/work/demo',
    name: 'demo',
    defaultBranch: 'main',
    worktreeDir: '/work/.worktrees',
    setupCommand: null,
    trustState: 'trusted',
    trustHash: 'h',
    trustedAt: '2026-11-01T00:00:00.000Z',
    refFormat: 'files',
    addedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

export function threadRow(id: string, over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    projectId: PROJECT_ID,
    title: 'Fix the test',
    strategy: 'worktree',
    branch: `gmi/${id.slice(0, 6)}/fix`,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    worktreePath: `/work/.worktrees/${id}`,
    gitDir: `/work/demo/.git/worktrees/${id}`,
    commonDir: '/work/demo/.git',
    gitPointer: `gitdir: /work/demo/.git/worktrees/${id}\n`,
    objectDir: `/data/objects/${id}`,
    setupState: 'ready',
    settings: settings(),
    status: 'idle',
    statusReason: null,
    costUsd: 0,
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
    archived: false,
    instructionsHash: null,
    envBlock: null,
    createdAt: '2026-11-02T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    ...over,
  };
}

/** A tool-call reply whose usage numbers are given (prompt grows like a real thread). */
export function callsReply(calls: Array<{ id: string; name: string; args: unknown }>, opts: { text?: string; prompt?: number; cached?: number; cost?: number } = {}): GatewayEvent[] {
  return [
    { type: 'started', attempt: 1, model: MODEL, api: 'chat' },
    ...(opts.text ? [{ type: 'text', text: opts.text } as GatewayEvent] : []),
    ...calls.map((c): GatewayEvent => ({ type: 'tool_call', call: { id: c.id, name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })),
    { type: 'usage', usage: { promptTokens: opts.prompt ?? 1_000, completionTokens: 20, totalTokens: (opts.prompt ?? 1_000) + 20, reasoningTokens: null, cachedTokens: opts.cached ?? 0 }, cacheWriteTokens: null, costUsd: opts.cost ?? 0.001, estimated: false, maybeBilled: false },
    { type: 'finish', reason: 'tool_calls', raw: 'tool_calls' },
  ];
}

export function text(t: string, opts: { reason?: 'stop' | 'length'; cost?: number; prompt?: number } = {}): GatewayEvent[] {
  return [
    { type: 'started', attempt: 1, model: MODEL, api: 'chat' },
    { type: 'text', text: t },
    { type: 'usage', usage: { promptTokens: opts.prompt ?? 1_000, completionTokens: 10, totalTokens: (opts.prompt ?? 1_000) + 10, reasoningTokens: null, cachedTokens: 0 }, cacheWriteTokens: null, costUsd: opts.cost ?? 0.001, estimated: false, maybeBilled: false },
    { type: 'finish', reason: opts.reason ?? 'stop', raw: opts.reason ?? 'stop' },
  ];
}

export interface Bench {
  loop: AgentLoop;
  store: ReturnType<typeof memoryStore>;
  link: FakeMainLink;
  clock: FakeClock;
  tools: ReturnType<typeof memoryToolRegistry>;
  perm: ReturnType<typeof fakePermissionEngine>;
  git: ReturnType<typeof fakeGitService>;
  lock: ReturnType<typeof memoryMutationLock>;
  compactor: ReturnType<typeof fakeCompactor>;
  /** Tool runs in order: `name:argsJSON`. */
  ran: string[];
  /** A small virtual file system the fake read/edit tools use. */
  files: Map<string, string>;
  addThread(id: string, over?: Partial<ThreadRow>): void;
  messages(threadId?: string): MessageRow[];
  /** Asserts invariant 1 on stored history: every stored call has exactly one result before the next assistant/user message. */
  assertPaired(contextId?: string): void;
}

export function bench(opts: { deps?: Partial<LoopDeps>; project?: Partial<ProjectRow>; thread?: Partial<ThreadRow>; tools?: ToolDefinition[] } = {}): Bench {
  const clock = fakeClock(T0);
  const store = memoryStore(clock);
  const gateway = scriptedGatewayClient((req) => text(`fallback ${req.scope.step}`));
  const link = fakeMainLink(gateway);
  const tools = memoryToolRegistry();
  const perm = fakePermissionEngine();
  const git = fakeGitService();
  const lock = memoryMutationLock();
  const compactor = fakeCompactor();
  const ran: string[] = [];
  const files = new Map<string, string>([['x.ts', 'old']]);
  const record = (name: string) => (args: Record<string, unknown>) => {
    ran.push(`${name}:${JSON.stringify(args)}`);
    return okResult(`${name} ok`);
  };
  const defaults: ToolDefinition[] = [
    fakeTool<{ path?: string }>('read', {
      readOnly: true,
      run: (args) => {
        ran.push(`read:${JSON.stringify(args)}`);
        return okResult(files.get(String(args.path)) ?? 'missing', { effects: { readPaths: [String(args.path)] } });
      },
    }) as ToolDefinition,
    fakeTool<{ path?: string; content?: string }>('edit', {
      mutates: true,
      run: (args) => {
        ran.push(`edit:${JSON.stringify(args)}`);
        files.set(String(args.path), String(args.content));
        return okResult('edited', { effects: { changedPaths: [String(args.path)], contentHashes: { [String(args.path)]: String(args.content) } } });
      },
    }) as ToolDefinition,
    fakeTool('grep', { readOnly: true, run: record('grep') }) as ToolDefinition,
    fakeTool('list', { readOnly: true, run: record('list') }) as ToolDefinition,
    { ...(fakeTool('question', { run: record('question') }) as ToolDefinition), class: 'user' },
    { ...(fakeTool('task', { run: record('task') }) as ToolDefinition), class: 'subagent' },
  ];
  for (const t of opts.tools ?? defaults) tools.register(t);
  store.projects.upsert(projectRow(opts.project));
  const loop = createAgentLoop({
    store,
    link,
    tools,
    perm,
    sandbox: fakeSandboxRunner(),
    git,
    lock,
    compactor,
    clock,
    log: link.log,
    dataDir: '/data/harness',
    platform: 'linux',
    ripgrep: true,
    defer: (fn) => queueMicrotask(fn),
    ...opts.deps,
  });
  const b: Bench = {
    loop,
    store,
    link,
    clock,
    tools,
    perm,
    git,
    lock,
    compactor,
    ran,
    files,
    addThread(id, over = {}) {
      store.threads.insert(threadRow(id, { ...opts.thread, ...over }));
    },
    messages(threadId = THREAD_A) {
      return store.messages.list(contextIdOf(threadId));
    },
    assertPaired(contextId = contextIdOf(THREAD_A)) {
      const rows = store.messages.list(contextId).filter((m) => !m.partial);
      for (let i = 0; i < rows.length; i += 1) {
        const m = rows[i]!;
        if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
        const ids = m.toolCalls.map((c: GwToolCall) => c.id);
        const results: string[] = [];
        for (let j = i + 1; j < rows.length && rows[j]!.role === 'tool'; j += 1) results.push(rows[j]!.toolCallId!);
        if (results.length !== ids.length || ids.some((id, k) => results[k] !== id)) {
          throw new Error(`unpaired calls at ord ${m.ord}: calls ${ids.join(',')} results ${results.join(',')}`);
        }
      }
    },
  };
  b.addThread(THREAD_A);
  return b;
}

/** Runs `send` and waits for the run to end. */
export async function runTurn(b: Bench, textIn: string, threadId = THREAD_A) {
  const r = await b.loop.send(threadId, textIn);
  await b.loop.idle(threadId);
  return r;
}
