// H2-0: the conforming fakes of src/harness/types.ts (test/harness/fakes.ts) behave as the interfaces promise,
// so the parallel H2 slices can rely on them.
import { describe, expect, it } from 'vitest';
import { CODE_DEFAULTS } from '@shared/contracts/code';
import type { GatewayEvent } from '@shared/contracts/gateway';
import { contextIdOf, type CompactionTrigger, type MessageRow, type ThreadRow } from '@harness/types';
import {
  fakeCompactor,
  fakeGitService,
  fakeMainLink,
  fakePermissionEngine,
  fakeSandboxRunner,
  fakeTool,
  inlineWorker,
  memoryLog,
  memoryMutationLock,
  memoryStore,
  memoryToolRegistry,
  sampleApproval,
  sampleRequest,
  scriptedGatewayClient,
  textReply,
  toolCallReply,
} from './fakes';

const T1 = 'c0de0000-0000-4000-8000-000000000001';
const T2 = 'c0de0000-0000-4000-8000-000000000002';

function threadRow(id: string): ThreadRow {
  return {
    id,
    projectId: 'p1',
    title: 't',
    strategy: 'worktree',
    branch: null,
    baseRef: 'main',
    baseSha: null,
    worktreePath: '/w',
    gitDir: null,
    commonDir: null,
    gitPointer: null,
    objectDir: null,
    setupState: 'ready',
    settings: {
      runtime: 'gmi',
      model: 'zai-org/GLM-5.3',
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
      budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 30 },
      computerId: null,
    },
    status: 'idle',
    statusReason: null,
    costUsd: 0,
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
    archived: false,
    instructionsHash: null,
    envBlock: null,
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
  };
}

const msg = (contextId: string, over: Partial<MessageRow> = {}): Omit<MessageRow, 'ord'> => ({
  id: `m_${Math.random().toString(36).slice(2)}`,
  threadId: T1,
  contextId,
  turn: 1,
  role: 'user',
  content: 'x',
  toolCalls: null,
  toolCallId: null,
  reasoning: null,
  reasoningFamily: null,
  model: null,
  inContext: true,
  pinned: false,
  partial: false,
  estTokens: null,
  ...over,
});

describe('memoryStore', () => {
  it('thread_seq is contiguous per thread under interleaving; lists by range and type', () => {
    const s = memoryStore();
    for (let i = 0; i < 6; i += 1) {
      const thread = i % 2 === 0 ? T1 : T2;
      s.events.append({ threadId: thread, contextId: contextIdOf(thread), runId: 'r', turn: 1, step: i, type: i % 3 === 0 ? 'item' : 'status', payload: { i } });
    }
    expect(s.events.list(T1).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.events.list(T2).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.events.list(T1, { afterSeq: 1, types: ['item'] }).map((e) => e.seq)).toEqual([]);
    expect(s.events.lastSeq(T2)).toBe(3);
  });

  it('receipts keep the first result; messages get ords per context; compaction never hides pinned rows', () => {
    const s = memoryStore();
    s.receipts.put('cmd_1', T1, { runId: 'a' });
    s.receipts.put('cmd_1', T1, { runId: 'b' });
    expect(s.receipts.get('cmd_1')?.result).toEqual({ runId: 'a' });
    const ctx = contextIdOf(T1);
    s.messages.append(msg(ctx));
    s.messages.append(msg(ctx, { pinned: true }));
    s.messages.append(msg('child'));
    expect(s.messages.list(ctx).map((m) => m.ord)).toEqual([1, 2]);
    expect(s.messages.markOutOfContext(ctx, 2)).toBe(1);
    expect(s.messages.list(ctx, { inContextOnly: true })).toHaveLength(1);
    expect(s.messages.list('child')).toHaveLength(1);
  });

  it('tool-call wire ids are unique per context, not globally (repeated provider ids, §7.1)', () => {
    const s = memoryStore();
    const row = { wireId: 'call_0', providerCallId: 'call_0', threadId: T1, runId: 'r', turn: 1, step: 0, tool: 'read', args: '{}', status: 'started' as const, resultMessageId: null, spillPath: null, exitCode: null, startedAt: null, finishedAt: null };
    s.toolCalls.insert({ ...row, id: 'tc_1', contextId: contextIdOf(T1) });
    s.toolCalls.insert({ ...row, id: 'tc_2', contextId: contextIdOf(T2), threadId: T2 });
    expect(() => s.toolCalls.insert({ ...row, id: 'tc_3', contextId: contextIdOf(T1) })).toThrow();
    expect(s.toolCalls.unsettled(T1).map((t) => t.id)).toEqual(['tc_1']);
  });

  it('threads: summaries and delete remove every row of the thread', () => {
    const s = memoryStore();
    s.threads.insert(threadRow(T1));
    s.events.append({ threadId: T1, contextId: contextIdOf(T1), runId: null, turn: null, step: null, type: 'status', payload: {} });
    s.approvals.insert({ requestId: 'apr_1', threadId: T1, runId: 'r', toolCallId: null, kind: 'command', request: sampleApproval(), decision: null, decidedAt: null });
    expect(s.threads.summaries()[0]).toMatchObject({ id: T1, pendingApprovals: 1, model: 'zai-org/GLM-5.3' });
    s.threads.delete(T1);
    expect(s.threads.get(T1)).toBeNull();
    expect(s.events.list(T1)).toEqual([]);
    expect(s.approvals.pending(T1)).toEqual([]);
  });
});

describe('memoryMutationLock', () => {
  it('FIFO per thread, independent threads, abort while waiting', async () => {
    const lock = memoryMutationLock();
    const order: string[] = [];
    const r1 = await lock.acquire(T1);
    const other = await lock.acquire(T2);
    const second = lock.acquire(T1).then((r) => {
      order.push('second');
      return r;
    });
    const ac = new AbortController();
    const aborted = lock.acquire(T1, ac.signal).catch((e: unknown) => e);
    const third = lock.acquire(T1).then((r) => {
      order.push('third');
      return r;
    });
    ac.abort();
    expect(await aborted).toMatchObject({ code: 'cancelled' });
    r1();
    r1(); // idempotent
    (await second)();
    (await third)();
    other();
    expect(order).toEqual(['second', 'third']);
    expect(lock.isHeld(T1)).toBe(false);
  });
});

describe('tools, permissions, sandbox, compaction, git fakes', () => {
  it('registry: built-ins by name, then MCP tools; canonical parameter JSON; duplicates refused', () => {
    const reg = memoryToolRegistry();
    reg.register(fakeTool('read'));
    reg.register(fakeTool('mcp__gh__issues'));
    reg.register({ ...fakeTool('edit', { mutates: true }), parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } });
    expect(() => reg.register(fakeTool('read'))).toThrow();
    const defs = reg.definitions();
    expect(defs.map((d) => d.name)).toEqual(['edit', 'read', 'mcp__gh__issues']);
    expect(JSON.stringify(defs[0]?.parameters)).toBe('{"properties":{"path":{"type":"string"}},"required":["path"],"type":"object"}');
  });

  it('permissions: verdicts by tool; record makes thread rules', () => {
    const perm = fakePermissionEngine({ bash: { effect: 'ask', risk: [], suggestedRule: null, reason: 'shell asks' } });
    const ctx = { threadId: T1, projectId: 'p1', runId: 'r', mode: 'auto-accept-edits' as const, unattended: false, sandbox: { kind: 'bwrap' as const, ok: true, detail: null, network: 'proxy' as const }, worktree: '/w' };
    expect(perm.evaluate({ tool: 'bash', kind: 'command', title: 'x', risk: [] }, ctx).effect).toBe('ask');
    expect(perm.evaluate({ tool: 'read', kind: 'file-read', title: 'x', risk: [] }, ctx).effect).toBe('allow');
    expect(perm.classifyCommand('npm test && rm -rf /')).toMatchObject({ compound: true, argv: null });
    expect(perm.record(sampleApproval(), { kind: 'allow_thread' }, ctx)).toMatchObject({ scope: 'thread', threadId: T1, tool: 'bash' });
    expect(perm.record(sampleApproval(), { kind: 'allow_once' }, ctx)).toBeNull();
  });

  it('sandbox: canned results, never spawns, records specs', async () => {
    const sb = fakeSandboxRunner({ 'npm test': { exitCode: 1, output: 'FAIL' } });
    const chunks: string[] = [];
    const spec = { profile: 'exec' as const, threadId: T1, command: 'npm test', cwd: '/w', worktree: '/w', git: null, sensitivePaths: [], sensitiveWrites: false, maskedFiles: [], network: 'off' as const, cacheDir: null, env: {}, timeoutMs: 1_000 };
    const res = await sb.run(spec, { signal: new AbortController().signal, onOutput: (c) => chunks.push(c) });
    expect(res).toMatchObject({ exitCode: 1, output: 'FAIL', cancelled: false });
    expect(chunks).toEqual(['FAIL']);
    expect(sb.buildArgv(spec).slice(-2)).toEqual(['-c', 'npm test']);
  });

  it('compaction: the §7.4 ceiling at the defaults is ≈ 119.6k; triggers', () => {
    const c = fakeCompactor();
    const ceiling = c.ceiling({ modelContextTokens: 1_000_000, maxContextTokens: CODE_DEFAULTS.maxContextTokens, maxOutputTokens: CODE_DEFAULTS.maxOutputTokens, economy: false, tierBoundaryTokens: null, prefixTokens: 5_000 });
    expect(ceiling).toMatchObject({ windowTokens: 160_000, reserveTokens: 40_384, ceilingTokens: 119_616, keepTokens: 20_000 });
    const trig = (sizeTokens: number, messageCount = 10, nextStepCachedUsd: number | null = 0.01): CompactionTrigger | null => c.trigger({ ceiling, sizeTokens, messageCount, nextStepCachedUsd, perTurnUsd: 1 });
    expect(trig(100_000)).toBeNull();
    expect(trig(119_616)).toBe('tokens');
    expect(trig(10, 1_501)).toBe('messages');
    expect(trig(10, 10, 0.06)).toBe('cost');
  });

  it('git: records calls; ref compare finds moved refs', async () => {
    const git = fakeGitService();
    const rec = await git.createWorktree({ threadId: T1, project: { id: 'p1', rootPath: '/r', name: 'r', defaultBranch: 'main', worktreeDir: '/wt', setupCommand: null, trustState: 'trusted', trustHash: null, trustedAt: null, refFormat: 'files', addedAt: 'x' }, strategy: { kind: 'worktree', baseRef: 'main' }, slug: 'fix' });
    const before = await git.refSnapshot(rec);
    git.refs['refs/heads/main'] = 'f'.repeat(40);
    expect(await git.compareRefs(rec, before)).toEqual([{ ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'f'.repeat(40) }]);
    await expect(git.discard(rec, 'not-in-diff')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(git.calls).toEqual([`createWorktree ${T1}`]);
  });
});

describe('gateway client, main link and worker fakes', () => {
  it('scripted gateway client replays scripts, then the fallback; abort throws cancelled', async () => {
    const gw = scriptedGatewayClient();
    gw.script.push(toolCallReply([{ id: 'call_0', name: 'read', args: { path: 'a' } }]));
    const first: GatewayEvent[] = [];
    for await (const e of gw.stream(sampleRequest(), new AbortController().signal)) first.push(e);
    expect(first.find((e) => e.type === 'tool_call')).toMatchObject({ call: { name: 'read', arguments: '{"path":"a"}' } });
    const second: GatewayEvent[] = [];
    for await (const e of gw.stream(sampleRequest({ requestId: 'req_2' }), new AbortController().signal)) second.push(e);
    expect(second).toEqual(textReply('Done.'));
    const ac = new AbortController();
    ac.abort();
    await expect((async () => {
      for await (const _ of gw.stream(sampleRequest({ requestId: 'req_3' }), ac.signal)) void _;
    })()).rejects.toMatchObject({ code: 'cancelled' });
    expect(gw.cancelled).toEqual(['req_3']);
  });

  it('fake main link: approvals decided by a function, RPC answers by method, events recorded', async () => {
    const link = fakeMainLink();
    link.decide = (r) => (r.tool === 'bash' ? { kind: 'deny', feedback: 'no shell' } : { kind: 'allow_once' });
    expect(await link.approvals.request(sampleApproval(), new AbortController().signal)).toEqual({ kind: 'deny', feedback: 'no shell' });
    await expect(link.rpc.call('mcp.oauth.token', { serverId: 'x' })).rejects.toMatchObject({ code: 'not_implemented' });
    link.rpcAnswers['dialog.confirm'] = () => ({ confirmed: true });
    expect(await link.rpc.call('dialog.confirm', { kind: 'trust', subject: { tool: 'x', risk: [] } })).toEqual({ confirmed: true });
    link.events.runEnded(T1, 'run_1');
    expect(link.events.ended).toEqual([{ threadId: T1, runId: 'run_1' }]);
    link.log.child('loop').info('run.transition', { to: 'running' });
    expect(link.log.lines).toEqual([{ level: 'info', scope: 'host.loop', message: 'run.transition', meta: { to: 'running' } }]);
    expect(memoryLog().lines).toEqual([]);
    expect(await inlineWorker().run('echo', 1)).toBe(1);
  });
});
