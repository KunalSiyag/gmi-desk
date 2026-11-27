/**
 * Conforming fakes of the harness host's internal interfaces (src/harness/types.ts, H2-0), for the parallel H2
 * slices: H2-B (loop tests against a memory store, scripted gateway, fake tools/sandbox/permissions/git),
 * H2-C (compaction against memoryStore + scriptedGatewayClient), H2-D (tools against memoryStore,
 * fakeSandboxRunner, memoryMutationLock), H2-E (shell/web against fakeMainLink), H2-G (recovery against
 * memoryStore). Each is typed against its interface; test/harness/types.test.ts checks their behaviour.
 *
 * Time: `fakeClock` from test/gateway/fakes.ts satisfies HostClock.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  CodeState,
  CodeThreadEvent,
  CodeThreadSummary,
  DiffFile,
  PermissionRule,
  TodoItem,
  ToolOutputPreview,
} from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayRequest, GwToolDef } from '@shared/contracts/gateway';
import { canonicalJson, type HostRpcMethod } from '@harness/protocol';
import { createInlineWorker } from '@harness/worker';
import {
  newId,
  type ApprovalRow,
  type CheckpointRow,
  type Compactor,
  type CompactionResult,
  type DurableEventType,
  type GatewayClient,
  type GitService,
  type HostLog,
  type MainLink,
  type MessageRow,
  type MutationLock,
  type PermissionEngine,
  type PermissionVerdict,
  type ProjectRow,
  type ReadRow,
  type SandboxRunner,
  type SandboxRunResult,
  type SandboxSpec,
  type StoredEvent,
  type Store,
  type ThreadGitRecord,
  type ThreadRow,
  type ToolCallRow,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
  type UsageStepRow,
  type Worker,
  turnIdOf,
} from '@harness/types';

export { fakeClock, type FakeClock } from '../gateway/fakes';

// ─── Logs ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MemoryLog extends HostLog {
  lines: Array<{ level: string; scope: string; message: string; meta?: Record<string, unknown> }>;
}

export function memoryLog(scope = 'test', sink: MemoryLog['lines'] = []): MemoryLog {
  const at = (level: string) => (message: string, meta?: Record<string, unknown>) => {
    sink.push({ level, scope, message, ...(meta ? { meta } : {}) });
  };
  return { lines: sink, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), child: (s) => memoryLog(`${scope}.${s}`, sink) };
}

// ─── Worker ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs registered worker jobs in the test's thread. */
export function inlineWorker(): Worker {
  return createInlineWorker();
}

// ─── Store (in memory; same semantics the SQLite store must have) ────────────────────────────────────────────

const clone = <T>(v: T): T => structuredClone(v);

export function memoryStore(clock: { now(): number } = { now: () => Date.now() }): Store & { eventLog: StoredEvent[] } {
  const iso = () => new Date(clock.now()).toISOString();
  const eventLog: StoredEvent[] = [];
  const receipts = new Map<string, { threadId: string | null; at: string; result: unknown }>();
  const projects = new Map<string, ProjectRow>();
  const trusted = new Map<string, Map<string, { projectId: string; path: string; sha: string; content: string }>>();
  const threads = new Map<string, ThreadRow>();
  const messages: MessageRow[] = [];
  const toolCalls = new Map<string, ToolCallRow>();
  const approvals = new Map<string, ApprovalRow>();
  const rules = new Map<string, PermissionRule>();
  const checkpoints = new Map<string, CheckpointRow>();
  const compactions: Array<Parameters<Store['compactions']['insert']>[0]> = [];
  const reads = new Map<string, ReadRow>();
  const usage: UsageStepRow[] = [];
  const mcp = new Map<string, Parameters<Store['mcpServers']['upsert']>[0]>();
  const todos = new Map<string, { threadId: string; items: TodoItem[] }>();
  const refSnaps = new Map<string, { threadId: string; refs: Record<string, string>; at: string }>();
  const sensitive = new Map<string, Record<string, string | null>>();
  const gitProcs = new Map<number, { pid: number; threadId: string | null; startedAt: string }>();
  let depth = 0;

  const lastOrd = (contextId: string) => messages.filter((m) => m.contextId === contextId).reduce((max, m) => Math.max(max, m.ord), 0);

  const store: Store & { eventLog: StoredEvent[] } = {
    eventLog,
    schemaVersion: 1,
    transaction(fn) {
      // Snapshot-free: the fake does not roll back; tests that need rollback use the real store (H2-A).
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
      }
    },
    events: {
      append(input) {
        const seq = store.events.lastSeq(input.threadId) + 1;
        const ev: StoredEvent = {
          threadId: input.threadId,
          contextId: input.contextId,
          runId: input.runId,
          turn: input.turn,
          step: input.step,
          type: input.type,
          payload: clone(input.payload),
          seq,
          eventId: input.eventId ?? newId('ev', clock.now()),
          at: iso(),
        };
        if (eventLog.some((e) => e.eventId === ev.eventId)) throw new GmiError('conflict', 'Duplicate event id.');
        eventLog.push(ev);
        return clone(ev);
      },
      list(threadId, opts = {}) {
        let rows = eventLog.filter((e) => e.threadId === threadId && e.seq > (opts.afterSeq ?? 0) && (opts.beforeSeq === undefined || e.seq < opts.beforeSeq));
        if (opts.types) rows = rows.filter((e) => (opts.types as DurableEventType[]).includes(e.type));
        return clone(opts.limit !== undefined ? rows.slice(0, opts.limit) : rows);
      },
      byRun: (runId) => clone(eventLog.filter((e) => e.runId === runId)),
      lastSeq: (threadId) => eventLog.filter((e) => e.threadId === threadId).reduce((max, e) => Math.max(max, e.seq), 0),
    },
    receipts: {
      get: (id) => clone(receipts.get(id) ?? null),
      put(id, threadId, result) {
        if (!receipts.has(id)) receipts.set(id, { threadId, at: iso(), result: clone(result) });
      },
    },
    projects: {
      get: (id) => clone(projects.get(id) ?? null),
      list: () => clone([...projects.values()]),
      upsert: (row) => void projects.set(row.id, clone(row)),
      remove: (id) => void projects.delete(id),
    },
    trustedFiles: {
      list: (projectId) => clone([...(trusted.get(projectId)?.values() ?? [])]),
      get: (projectId, path) => clone(trusted.get(projectId)?.get(path) ?? null),
      replace: (projectId, files) => void trusted.set(projectId, new Map(files.map((f) => [f.path, clone(f)]))),
    },
    threads: {
      get: (id) => clone(threads.get(id) ?? null),
      list: (opts = {}) => clone([...threads.values()].filter((t) => (opts.projectId === undefined || t.projectId === opts.projectId) && (opts.archived === undefined || t.archived === opts.archived))),
      insert(row) {
        if (threads.has(row.id)) throw new GmiError('conflict', 'Thread exists.');
        threads.set(row.id, clone(row));
      },
      update(id, patch) {
        const cur = threads.get(id);
        if (!cur) throw new GmiError('not_found', 'Thread not found.');
        const next = { ...cur, ...clone(patch), updatedAt: iso() };
        threads.set(id, next);
        return clone(next);
      },
      delete(id) {
        threads.delete(id);
        for (let i = eventLog.length - 1; i >= 0; i -= 1) if (eventLog[i]?.threadId === id) eventLog.splice(i, 1);
        for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.threadId === id) messages.splice(i, 1);
        for (const [k, v] of toolCalls) if (v.threadId === id) toolCalls.delete(k);
        for (const [k, v] of approvals) if (v.threadId === id) approvals.delete(k);
        for (const [k, v] of checkpoints) if (v.threadId === id) checkpoints.delete(k);
        for (const [k, v] of todos) if (v.threadId === id) todos.delete(k);
        sensitive.delete(id);
      },
      summaries: (opts = {}) =>
        store.threads.list(opts).map(
          (t): CodeThreadSummary => ({
            id: t.id,
            projectId: t.projectId,
            title: t.title,
            strategy: t.strategy,
            branch: t.branch,
            worktreePath: t.worktreePath,
            status: t.status,
            statusReason: t.statusReason,
            pendingApprovals: [...approvals.values()].filter((a) => a.threadId === t.id && a.decision === null).length,
            queuePosition: null,
            queueReason: null,
            model: t.settings.model,
            mode: t.settings.mode,
            costUsd: t.costUsd,
            tokens: t.tokens,
            diff: null,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            archived: t.archived,
          }),
        ),
    },
    messages: {
      append(row) {
        const m: MessageRow = { ...clone(row), ord: lastOrd(row.contextId) + 1 };
        messages.push(m);
        return clone(m);
      },
      upsertPartial(row) {
        const i = messages.findIndex((m) => m.id === row.id);
        if (i >= 0) {
          const m = { ...(messages[i] as MessageRow), ...clone(row), partial: true };
          messages[i] = m;
          return clone(m);
        }
        const m: MessageRow = { ...clone(row), ord: lastOrd(row.contextId) + 1, partial: true };
        messages.push(m);
        return clone(m);
      },
      finalizePartial(id, row) {
        const i = messages.findIndex((m) => m.id === id);
        if (i < 0) throw new GmiError('not_found', 'No partial message.');
        const m = { ...clone(row), id, ord: (messages[i] as MessageRow).ord, partial: false } as MessageRow;
        messages[i] = m;
        return clone(m);
      },
      list: (contextId, opts = {}) =>
        clone(messages.filter((m) => m.contextId === contextId && (!opts.inContextOnly || m.inContext) && m.ord > (opts.afterOrd ?? 0)).sort((a, b) => a.ord - b.ord)),
      markOutOfContext(contextId, uptoOrd) {
        let n = 0;
        for (const m of messages) {
          if (m.contextId === contextId && m.ord <= uptoOrd && m.inContext && !m.pinned) {
            m.inContext = false;
            n += 1;
          }
        }
        return n;
      },
      lastOrd,
    },
    toolCalls: {
      insert(row) {
        if (toolCalls.has(row.id)) throw new GmiError('conflict', 'Tool call exists.');
        if ([...toolCalls.values()].some((t) => t.contextId === row.contextId && t.wireId === row.wireId)) throw new GmiError('conflict', 'Wire id reused in this context.');
        toolCalls.set(row.id, clone(row));
      },
      get: (id) => clone(toolCalls.get(id) ?? null),
      byWireId: (contextId, wireId) => clone([...toolCalls.values()].find((t) => t.contextId === contextId && t.wireId === wireId) ?? null),
      update(id, patch) {
        const cur = toolCalls.get(id);
        if (cur) toolCalls.set(id, { ...cur, ...clone(patch) });
      },
      unsettled: (threadId) => clone([...toolCalls.values()].filter((t) => t.status === 'started' && (threadId === undefined || t.threadId === threadId))),
    },
    approvals: {
      insert: (row) => void approvals.set(row.requestId, clone(row)),
      decide(requestId, decision, at) {
        const cur = approvals.get(requestId);
        if (cur) approvals.set(requestId, { ...cur, decision: clone(decision), decidedAt: at });
      },
      pending: (threadId) => clone([...approvals.values()].filter((a) => a.decision === null && (threadId === undefined || a.threadId === threadId))),
      get: (id) => clone(approvals.get(id) ?? null),
    },
    rules: {
      list: (opts = {}) =>
        clone(
          [...rules.values()].filter(
            (r) => (opts.projectId === undefined || r.projectId === opts.projectId || r.projectId === null) && (opts.threadId === undefined || r.threadId === opts.threadId || r.threadId === null),
          ),
        ),
      insert: (rule) => void rules.set(rule.id, clone(rule)),
      delete: (id) => rules.delete(id),
    },
    checkpoints: {
      insert: (row) => void checkpoints.set(row.id, clone(row)),
      list: (threadId) => clone([...checkpoints.values()].filter((c) => c.threadId === threadId).sort((a, b) => a.turn - b.turn)),
      get: (id) => clone(checkpoints.get(id) ?? null),
    },
    compactions: {
      insert: (row) => void compactions.push(clone(row)),
      list: (contextId) => clone(compactions.filter((c) => c.contextId === contextId)),
    },
    reads: {
      get: (contextId, path) => clone(reads.get(`${contextId}\0${path}`) ?? null),
      put: (row) => void reads.set(`${row.contextId}\0${row.path}`, clone(row)),
      delete: (contextId, path) => void reads.delete(`${contextId}\0${path}`),
      list: (contextId) => clone([...reads.values()].filter((r) => r.contextId === contextId)),
    },
    usage: {
      insert: (row) => void usage.push(clone(row)),
      list: (threadId, opts = {}) => clone(usage.filter((u) => u.threadId === threadId && (opts.runId === undefined || u.runId === opts.runId) && (opts.contextId === undefined || u.contextId === opts.contextId))),
    },
    mcpServers: {
      list: (opts = {}) => clone([...mcp.values()].filter((m) => opts.projectId === undefined || m.projectId === opts.projectId)),
      get: (id) => clone(mcp.get(id) ?? null),
      upsert: (row) => void mcp.set(row.id, clone(row)),
      remove: (id) => void mcp.delete(id),
    },
    todos: {
      get: (contextId) => clone(todos.get(contextId)?.items ?? []),
      put: (contextId, threadId, items) => void todos.set(contextId, { threadId, items: clone(items) }),
    },
    refSnapshots: {
      put: (runId, threadId, refs) => void refSnaps.set(runId, { threadId, refs: clone(refs), at: iso() }),
      get: (runId) => clone(refSnaps.get(runId) ?? null),
      delete: (runId) => void refSnaps.delete(runId),
      list: () => [...refSnaps].map(([runId, v]) => ({ runId, threadId: v.threadId })),
    },
    sensitiveHashes: {
      get: (threadId) => clone(sensitive.get(threadId) ?? {}),
      put: (threadId, hashes) => void sensitive.set(threadId, clone(hashes)),
    },
    gitProcs: {
      add: (pid, threadId) => void gitProcs.set(pid, { pid, threadId, startedAt: iso() }),
      remove: (pid) => void gitProcs.delete(pid),
      list: () => clone([...gitProcs.values()]),
    },
    async backup() {
      return undefined;
    },
    close() {
      return undefined;
    },
  };
  void depth;
  return store;
}

// ─── Mutation lock (a real FIFO lock: small enough to be the reference implementation) ──────────────────────

export function memoryMutationLock(): MutationLock & { waiting(threadId: string): number } {
  const holders = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const release = (threadId: string) => {
    const queue = queues.get(threadId);
    const next = queue?.shift();
    if (next) next();
    else holders.delete(threadId);
  };
  return {
    acquire(threadId, signal) {
      if (signal?.aborted) return Promise.reject(new GmiError('cancelled', 'Cancelled.'));
      const makeRelease = () => {
        let done = false;
        return () => {
          if (done) return;
          done = true;
          release(threadId);
        };
      };
      if (!holders.has(threadId)) {
        holders.add(threadId);
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve, reject) => {
        const queue = queues.get(threadId) ?? [];
        queues.set(threadId, queue);
        const grant = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(makeRelease());
        };
        const onAbort = () => {
          const i = queue.indexOf(grant);
          if (i >= 0) queue.splice(i, 1);
          reject(new GmiError('cancelled', 'Cancelled.'));
        };
        queue.push(grant);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    isHeld: (threadId) => holders.has(threadId),
    waiting: (threadId) => queues.get(threadId)?.length ?? 0,
  };
}

// ─── Gateway client and main link ────────────────────────────────────────────────────────────────────────────

export interface ScriptedGatewayClient extends GatewayClient {
  requests: GatewayRequest[];
  /** Events for the next stream() calls, in order; when empty, `fallback(req)`. */
  script: GatewayEvent[][];
  cancelled: string[];
}

export function textReply(text: string): GatewayEvent[] {
  return [
    { type: 'started', attempt: 1, model: 'fake/model', api: 'chat' },
    { type: 'text', text },
    { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, reasoningTokens: null, cachedTokens: 0 }, cacheWriteTokens: null, costUsd: 0.0001, estimated: false, maybeBilled: false },
    { type: 'finish', reason: 'stop', raw: 'stop' },
  ];
}

export function toolCallReply(calls: Array<{ id: string; name: string; args: unknown }>): GatewayEvent[] {
  return [
    { type: 'started', attempt: 1, model: 'fake/model', api: 'chat' },
    ...calls.map((c): GatewayEvent => ({ type: 'tool_call', call: { id: c.id, name: c.name, arguments: JSON.stringify(c.args) } })),
    { type: 'usage', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, reasoningTokens: null, cachedTokens: 0 }, cacheWriteTokens: null, costUsd: 0.0001, estimated: false, maybeBilled: false },
    { type: 'finish', reason: 'tool_calls', raw: 'tool_calls' },
  ];
}

export function scriptedGatewayClient(fallback: (req: GatewayRequest) => GatewayEvent[] = () => textReply('Done.')): ScriptedGatewayClient {
  const client: ScriptedGatewayClient = {
    requests: [],
    script: [],
    cancelled: [],
    async *stream(req, signal) {
      client.requests.push(structuredClone(req));
      const events = client.script.shift() ?? fallback(req);
      for (const event of events) {
        await Promise.resolve();
        if (signal.aborted) {
          client.cancelled.push(req.requestId);
          throw new GmiError('cancelled', 'Cancelled.');
        }
        yield event;
      }
    },
  };
  return client;
}

export interface FakeMainLink extends MainLink {
  gateway: ScriptedGatewayClient;
  events: MainLink['events'] & { sent: CodeThreadEvent[]; threadLists: CodeThreadSummary[][]; ended: Array<{ threadId: string; runId: string }> };
  approvalsAsked: ApprovalRequest[];
  /** Decides every approval (default: allow once). */
  decide: (request: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>;
  rpcCalls: Array<{ method: HostRpcMethod; params: unknown }>;
  /** RPC answers by method (default: not_implemented). */
  rpcAnswers: Partial<Record<HostRpcMethod, (params: unknown) => unknown>>;
  log: MemoryLog;
}

export function fakeMainLink(gateway: ScriptedGatewayClient = scriptedGatewayClient()): FakeMainLink {
  const pending = new Set<string>();
  const link: FakeMainLink = {
    gateway,
    approvalsAsked: [],
    decide: () => ({ kind: 'allow_once' }),
    rpcCalls: [],
    rpcAnswers: {},
    log: memoryLog('host'),
    rpc: {
      async call(method, params, opts = {}) {
        if (opts.signal?.aborted) throw new GmiError('cancelled', 'Cancelled.');
        link.rpcCalls.push({ method, params: structuredClone(params) });
        const answer = link.rpcAnswers[method];
        if (!answer) throw new GmiError('not_implemented', `${method} is not available.`);
        return answer(params);
      },
    },
    approvals: {
      async request(request, signal) {
        if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
        link.approvalsAsked.push(structuredClone(request));
        pending.add(request.requestId);
        try {
          return await link.decide(request);
        } finally {
          pending.delete(request.requestId);
        }
      },
      pending: () => [...pending],
    },
    events: {
      sent: [],
      threadLists: [],
      ended: [],
      event: (e) => void link.events.sent.push(structuredClone(e)),
      threads: (t) => void link.events.threadLists.push(structuredClone(t)),
      runEnded: (threadId, runId) => void link.events.ended.push({ threadId, runId }),
    },
  };
  return link;
}

// ─── Tools ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A registry with the §7.1 ordering rules (built-ins by name, then `mcp__*` by server and name; canonical JSON). */
export function memoryToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const order = (a: string, b: string) => {
    const am = a.startsWith('mcp__');
    const bm = b.startsWith('mcp__');
    if (am !== bm) return am ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  return {
    register(def) {
      if (tools.has(def.name)) throw new GmiError('conflict', `Tool ${def.name} is already registered.`);
      tools.set(def.name, def as ToolDefinition);
      return () => {
        if (tools.get(def.name) === (def as ToolDefinition)) tools.delete(def.name);
      };
    },
    get: (name) => tools.get(name) ?? null,
    list: () => [...tools.values()].sort((a, b) => order(a.name, b.name)),
    definitions(filter) {
      return [...tools.values()]
        .filter((d) => !filter || filter(d))
        .sort((a, b) => order(a.name, b.name))
        .map((d): GwToolDef => ({ name: d.name, description: d.description, parameters: JSON.parse(canonicalJson(d.parameters)) as Record<string, unknown> }));
    },
  };
}

export function okResult(content: string, over: Partial<ToolResult> = {}): ToolResult {
  const preview: ToolOutputPreview = { text: content.slice(0, 65_536), truncated: content.length > 65_536, totalBytes: Buffer.byteLength(content), spillId: null };
  return { ok: true, errorKind: null, content, preview, ...over };
}

/** A tool whose behaviour is a function (loop tests). */
export function fakeTool<A = Record<string, unknown>>(name: string, opts: { readOnly?: boolean; mutates?: boolean; run?: (args: A) => ToolResult | Promise<ToolResult> } = {}): ToolDefinition<A> {
  return {
    name,
    description: `Fake ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    class: opts.mutates ? 'mutate' : 'read',
    parse: (raw) => (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ok: true, args: raw as A } : { ok: false, error: 'arguments must be an object' }),
    readOnly: () => opts.readOnly ?? !opts.mutates,
    mutates: () => opts.mutates ?? false,
    subject: () => ({ tool: name, kind: opts.mutates ? 'file-change' : 'file-read', title: name, risk: [] }),
    title: () => name,
    run: async (args) => (opts.run ? opts.run(args) : okResult(`${name} ok`)),
  };
}

// ─── Permissions ──────────────────────────────────────────────────────────────────────────────────────────────

/** Verdicts by tool name (default: allow via mode). Rules are kept in memory. */
export function fakePermissionEngine(verdicts: Record<string, PermissionVerdict> = {}): PermissionEngine & { evaluated: string[] } {
  const rules = new Map<string, PermissionRule>();
  const engine: PermissionEngine & { evaluated: string[] } = {
    evaluated: [],
    evaluate(subject) {
      engine.evaluated.push(subject.tool);
      return verdicts[subject.tool] ?? { effect: 'allow', via: 'mode', ruleId: null, risk: subject.risk, profile: null };
    },
    classifyCommand(command) {
      const compound = /[;&|`$<>()]/.test(command);
      const argv = compound ? null : command.trim().split(/\s+/).filter(Boolean);
      return { argv, compound, destructive: /\brm\s+-rf\b/.test(command), readOnly: !compound && /^(ls|cat|pwd|git status)\b/.test(command.trim()), suggestedPattern: argv?.slice(0, 2).join(' ') ?? null };
    },
    record(request, decision, ctx) {
      if (decision.kind !== 'allow_thread' && decision.kind !== 'allow_always') return null;
      const rule: PermissionRule = {
        id: newId('rule'),
        tool: request.tool,
        pattern: decision.kind === 'allow_always' ? decision.rule.pattern : (request.suggestedRule?.pattern ?? null),
        effect: 'allow',
        scope: decision.kind === 'allow_always' ? decision.rule.scope : 'thread',
        projectId: ctx.projectId,
        threadId: decision.kind === 'allow_thread' ? ctx.threadId : null,
        source: 'user',
        createdAt: new Date().toISOString(),
      };
      rules.set(rule.id, rule);
      return rule;
    },
    listRules: () => [...rules.values()],
    deleteRule: (id) => rules.delete(id),
    loadProjectRules: (_projectId, list) => list.filter((r) => r.effect === 'allow'),
  };
  return engine;
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Canned results by command (default: exit 0, empty output). Never spawns anything. */
export function fakeSandboxRunner(
  results: Record<string, Partial<SandboxRunResult>> = {},
  state: CodeState['sandbox'] = { kind: 'bwrap', ok: true, detail: null, network: 'proxy' },
): SandboxRunner & { runs: SandboxSpec[] } {
  const runner: SandboxRunner & { runs: SandboxSpec[] } = {
    kind: state.kind,
    runs: [],
    state: () => state,
    selftest: async () => state,
    buildArgv: (spec) => ['fake-sandbox', spec.profile, '--', ...(spec.argv ?? ['/bin/bash', '--noprofile', '--norc', '-c', spec.command ?? 'true'])],
    async run(spec, io) {
      runner.runs.push(structuredClone(spec));
      if (io.signal.aborted) return { exitCode: null, signal: 'SIGTERM', timedOut: false, cancelled: true, durationMs: 0, output: '', outputBytes: 0, outputTruncated: false };
      const key = spec.command ?? spec.argv?.join(' ') ?? '';
      const r = results[key] ?? {};
      const output = r.output ?? '';
      if (output) io.onOutput?.(output);
      return { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1, output, outputBytes: Buffer.byteLength(output), outputTruncated: false, ...r };
    },
  };
  return runner;
}

// ─── Compaction ──────────────────────────────────────────────────────────────────────────────────────────────

/** The §7.4 ceiling formula; triggers on tokens/messages/cost; compact() returns a canned result. */
export function fakeCompactor(result: Partial<CompactionResult> = {}): Compactor & { compacted: string[]; precomputed: string[] } {
  const c: Compactor & { compacted: string[]; precomputed: string[] } = {
    compacted: [],
    precomputed: [],
    ceiling(input) {
      const window = Math.min(input.modelContextTokens ?? 128_000, input.maxContextTokens ?? Number.POSITIVE_INFINITY);
      const reserve = Math.max(Math.floor(0.15 * window), 16_384) + input.maxOutputTokens;
      const ceiling = window - reserve;
      return { windowTokens: window, reserveTokens: reserve, ceilingTokens: ceiling, keepTokens: Math.min(20_000, Math.floor(0.25 * ceiling)), economy: input.economy ? 'on' : 'off', tierBoundaryTokens: input.tierBoundaryTokens };
    },
    trigger(input) {
      if (input.sizeTokens >= input.ceiling.ceilingTokens) return 'tokens';
      if (input.messageCount > 1_500) return 'messages';
      if (input.nextStepCachedUsd !== null && input.perTurnUsd !== null && input.nextStepCachedUsd > input.perTurnUsd / 20) return 'cost';
      return null;
    },
    shouldPrecompute: (input) => input.sizeTokens >= 0.85 * input.ceiling.ceilingTokens && input.sizeTokens >= 32_000,
    precompute: (req) => void c.precomputed.push(req.contextId),
    async compact(req) {
      c.compacted.push(req.contextId);
      return { compactionId: newId('cmp'), uptoOrd: 0, beforeTokens: 100_000, afterTokens: 40_000, model: req.compactionModel, costUsd: 0.01, layer: req.reason === 'overflow' ? 2 : 1, usedPrecomputed: false, ...result };
    },
    pruneReads: () => undefined,
    cancel: () => undefined,
  };
  return c;
}

// ─── Git ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Records calls; worktrees are paths under `root` that are never created on disk. */
export function fakeGitService(root = '/tmp/gmi-desk-fake-git'): GitService & { calls: string[]; diffFiles: DiffFile[]; refs: Record<string, string> } {
  let turnSeq = 0;
  const git: GitService & { calls: string[]; diffFiles: DiffFile[]; refs: Record<string, string> } = {
    calls: [],
    diffFiles: [],
    refs: { 'refs/heads/main': 'a'.repeat(40) },
    version: async () => '2.43.0',
    async createWorktree({ threadId, project, strategy }) {
      git.calls.push(`createWorktree ${threadId}`);
      const record: ThreadGitRecord = {
        threadId,
        projectId: project.id,
        strategy: strategy.kind,
        projectRoot: project.rootPath,
        worktreePath: `${root}/${threadId}`,
        gitDir: `${project.rootPath}/.git/worktrees/${threadId}`,
        commonDir: `${project.rootPath}/.git`,
        gitPointer: `gitdir: ${project.rootPath}/.git/worktrees/${threadId}\n`,
        objectDir: `${root}/objects/${threadId}`,
        branch: `gmi/${threadId.slice(0, 6)}/work`,
        baseRef: strategy.kind === 'worktree' ? strategy.baseRef : null,
        baseSha: 'a'.repeat(40),
        refFormat: 'files',
      };
      return record;
    },
    removeWorktree: async (r) => void git.calls.push(`removeWorktree ${r.threadId}`),
    verify: async (r) => void git.calls.push(`verify ${r.threadId}`),
    sandboxMounts: async (r) => ({ readOnly: [r.commonDir], writable: [r.gitDir], env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0' }, perThreadRefs: true }),
    importObjects: async (r) => {
      git.calls.push(`importObjects ${r.threadId}`);
      return { imported: 0 };
    },
    async checkpoint(r, turn) {
      git.calls.push(`checkpoint ${r.threadId} ${turn}`);
      turnSeq += 1;
      return { id: newId('ckpt'), threadId: r.threadId, turn, commitSha: String(turnSeq).padStart(40, 'c'), treeSha: 't'.repeat(40), filesChanged: 0, createdAt: new Date().toISOString() };
    },
    restoreCheckpoint: async (r) => {
      git.calls.push(`restoreCheckpoint ${r.threadId}`);
      return { removed: [] };
    },
    deleteCheckpoints: async (r) => void git.calls.push(`deleteCheckpoints ${r.threadId}`),
    diff: async () => structuredClone(git.diffFiles),
    async fileDiff(_r, path) {
      const f = git.diffFiles.find((d) => d.path === path);
      if (!f) throw new GmiError('not_found', 'Not in the diff.');
      return structuredClone(f);
    },
    async discard(r, path) {
      if (!git.diffFiles.some((d) => d.path === path)) throw new GmiError('invalid_input', 'Not in the diff.');
      git.calls.push(`discard ${r.threadId} ${path}`);
    },
    commit: async (r) => {
      git.calls.push(`commit ${r.threadId}`);
      return { sha: 'b'.repeat(40) };
    },
    merge: async (r) => {
      git.calls.push(`merge ${r.threadId}`);
      return { sha: 'd'.repeat(40) };
    },
    exportPatch: async () => '',
    statusShort: async () => '',
    refSnapshot: async () => ({ ...git.refs }),
    compareRefs: async (_r, before) => {
      const keys = new Set([...Object.keys(before), ...Object.keys(git.refs)]);
      return [...keys].filter((k) => before[k] !== git.refs[k]).map((ref) => ({ ref, before: before[ref] ?? null, after: git.refs[ref] ?? null }));
    },
    restoreRef: async (_r, ref, sha) => {
      git.refs[ref] = sha;
    },
    sensitiveHashes: async () => ({}),
    recover: async () => ({ reconciled: [], removedLocks: [], reportedLocks: [], movedRefs: [] }),
  };
  return git;
}

// ─── Protocol samples (shared by the H2 tests) ───────────────────────────────────────────────────────────────

const T = '2026-11-02T10:00:00.000Z';
const THREAD = 'c0de0000-0000-4000-8000-000000000001';

export function sampleRequest(over: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    requestId: 'req_1',
    purpose: 'agent',
    priority: 'foreground',
    scope: { threadId: THREAD, turnId: turnIdOf(THREAD, 1), runId: 'run_1', step: 0 },
    target: { model: 'zai-org/GLM-5.3' },
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Fix the test.' },
    ],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    maxOutputTokens: 16_384,
    prefixHash: null,
    ...over,
  };
}

export function sampleApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'apr_1',
    threadId: THREAD,
    runId: 'run_1',
    toolCallId: 'tc_1',
    kind: 'command',
    tool: 'bash',
    title: 'Run npm test',
    detail: { command: 'npm test', cwd: '/work' },
    risk: [],
    suggestedRule: { tool: 'bash', pattern: 'npm test', effect: 'allow', scope: 'project' },
    allowedDecisions: ['allow_once', 'allow_thread', 'allow_always', 'deny', 'cancel_run'],
    createdAt: T,
    expiresAt: null,
    ...over,
  };
}

export function sampleSummary(over: Partial<CodeThreadSummary> = {}): CodeThreadSummary {
  return {
    id: THREAD,
    projectId: 'p1',
    title: 'Fix the test',
    strategy: 'worktree',
    branch: 'gmi/c0de00/fix',
    worktreePath: '/work/fix',
    status: 'idle',
    statusReason: null,
    pendingApprovals: 0,
    queuePosition: null,
    queueReason: null,
    model: 'zai-org/GLM-5.3',
    mode: 'auto-accept-edits',
    costUsd: 0.01,
    tokens: { input: 1, cached: 0, output: 1, reasoning: 0 },
    diff: null,
    createdAt: T,
    updatedAt: T,
    archived: false,
    ...over,
  };
}

