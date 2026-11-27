/**
 * Regression tests for the H2 review (loop / money lens; exploits in .review/h2/loop-money/). Each case is the
 * reviewer's probe with the expectation flipped to the fixed behaviour.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@shared/contracts/code';
import type { GatewayEvent, GatewayRequest } from '@shared/contracts/gateway';
import { requestShapeProblem, createRunRegistry } from '@main/services/gateway/gateway';
import { attachHostSession } from '@main/services/harness/bridge';
import { createMainLink } from '@harness/gateway-client';
import { createCompactor } from '@harness/loop/compaction';
import { DoomDetector, type DoomResult } from '@harness/loop/doom';
import type { AgentLoop, ChildRunResult, LoopDeps, ModelInfo } from '@harness/loop/runner';
import { decodeHostToMain } from '@harness/protocol';
import { createEditTool } from '@harness/tools/edit';
import { createReadTool } from '@harness/tools/fs';
import { createQuestionTool } from '@harness/tools/question';
import { newId, type GatewayClient, type ToolDefinition } from '@harness/types';
import { fakePermissionEngine, fakeTool, okResult, textReply } from '../fakes';
import { bench, callsReply, MODEL, runTurn, settings, text, THREAD_A, type Bench } from '../loop/helpers';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmid-review-loop-')));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

/** A bench with the real compactor (wired like the host runtime: contextInfo, onEvent, onCost). */
function withCompactor(opts: { thread?: NonNullable<Parameters<typeof bench>[0]>['thread']; deps?: Partial<LoopDeps>; credit?: boolean } = {}): Bench & { compactor: ReturnType<typeof createCompactor> } {
  let loop: AgentLoop | null = null;
  let gw: GatewayClient | null = null;
  const holder: { c: ReturnType<typeof createCompactor> | null } = { c: null };
  const lazy = new Proxy({} as ReturnType<typeof createCompactor>, { get: (_t, k) => (holder.c as never)[k] });
  const credit = opts.credit !== false;
  const b = bench({ ...(opts.thread ? { thread: opts.thread } : {}), deps: { compactor: lazy, compactionCostReported: credit, ...opts.deps } });
  gw = b.link.gateway;
  loop = b.loop;
  holder.c = createCompactor(
    { store: b.store, gateway: { stream: (r, s) => gw!.stream(r, s) }, clock: b.clock, log: b.link.log },
    { contextInfo: (r) => loop!.compactionContext(r), onEvent: (e) => loop!.forwardStored(e), ...(credit ? { onCost: (t, c, usd) => loop!.creditCost(t, c || null, usd) } : {}) },
  );
  return Object.assign(b, { compactor: holder.c });
}

describe('invalid tool names never brick a thread (finding 11)', () => {
  for (const badName of ['', 'read file', 'assistant<|channel|>commentary', 'x'.repeat(129)]) {
    it(`name ${JSON.stringify(badName.slice(0, 30))} (${badName.length} chars)`, async () => {
      const b = bench();
      const inner = b.link.gateway.stream.bind(b.link.gateway);
      b.link.gateway.stream = async function* (req, signal) {
        const problem = requestShapeProblem(req);
        if (problem) {
          b.link.gateway.requests.push(structuredClone(req));
          yield { type: 'error', error: { code: 'invalid_input', message: problem }, afterOutput: false } as GatewayEvent;
          return;
        }
        yield* inner(req, signal);
      };
      b.link.gateway.script.push(callsReply([{ id: 'call_0', name: badName, args: { path: 'x.ts' } }]), text('done'));
      await runTurn(b, 'go');
      expect(b.store.threads.get(THREAD_A)!.status).toBe('completed');
      const second = b.link.gateway.requests[1]!;
      expect(requestShapeProblem(second)).toBeNull();
      expect(decodeHostToMain({ t: 'gw.request', reqId: second.requestId, req: second }).ok).toBe(true);
      const result = b.messages().find((m) => m.role === 'tool')!.content;
      expect(result).toMatch(/unknown tool/);
      b.link.gateway.script.push(text('hello'));
      await runTurn(b, 'please continue');
      expect(b.store.threads.get(THREAD_A)!.status).toBe('completed');
    });
  }

  it('the host link ends a request main would drop with an error instead of hanging', async () => {
    const sent: unknown[] = [];
    const link = createMainLink({ send: (m) => void sent.push(m), clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined } });
    const req = { requestId: 'req_1', purpose: 'agent', priority: 'foreground', scope: { threadId: THREAD_A, turnId: `${THREAD_A}:1`, runId: 'run_1', step: 1 }, target: { model: MODEL }, messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: '', arguments: '{}' }] }], maxOutputTokens: 100, prefixHash: null } as unknown as GatewayRequest;
    const events: GatewayEvent[] = [];
    for await (const e of link.gateway.stream(req, new AbortController().signal)) events.push(e);
    expect(events).toEqual([expect.objectContaining({ type: 'error' })]);
    expect(sent.filter((m) => (m as { t: string }).t === 'gw.request')).toHaveLength(0);
  });
});

describe('the cost trigger compacts only when it helps (finding 12)', () => {
  for (const [label, pricing, max] of [
    ['$30/M in, no cache price', { inputPerMTok: 30, outputPerMTok: 180, cacheReadPerMTok: null }, 0],
    ['$2/M in, no cache price', { inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: null }, 0],
    // Hysteresis: not again until the context has doubled since the last compaction (≤ 2 in 9 steps, not 8).
    ['$10/M in, $1/M cached', { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1 }, 2],
  ] as const) {
    it(label, async () => {
      const b = withCompactor({ deps: { modelInfo: (): ModelInfo => ({ contextTokens: 1_000_000, tierBoundaryTokens: null, pricing }) } });
      const big = 'x'.repeat(24_000);
      b.tools.register(fakeTool<{ path: string }>('cat', { readOnly: true, run: (a) => okResult(`${a.path}\n${big}`, { effects: { readPaths: [a.path] } }) }));
      let agentStep = 0;
      const inner = b.link.gateway.stream.bind(b.link.gateway);
      b.link.gateway.stream = async function* (req: GatewayRequest, signal: AbortSignal) {
        if (req.purpose === 'compaction') {
          b.link.gateway.requests.push(structuredClone(req));
          yield* textReply('## Objective\n- keep going\n'.padEnd(2_000, '.'));
          return;
        }
        agentStep += 1;
        const prompt = Math.ceil(JSON.stringify({ m: req.messages, t: req.tools ?? [] }).length / 4);
        b.link.gateway.script.push(agentStep <= 8 ? callsReply([{ id: `c${agentStep}`, name: 'cat', args: { path: `src/f${agentStep}.ts` } }], { prompt, cached: 0, cost: 0.01 }) : text('done', { prompt }));
        yield* inner(req, signal);
      };
      await runTurn(b, 'Review every file under src/.');
      const compactions = b.link.gateway.requests.filter((r) => r.purpose === 'compaction').length;
      expect(compactions).toBeLessThanOrEqual(max);
    });
  }
});

describe('subagent compactions use the parent run scope (finding 13)', () => {
  it('main accepts the child compaction request; the summary comes from the model', async () => {
    const b = withCompactor({ thread: { settings: settings({ maxContextTokens: 40_000 }) } });
    const registry = createRunRegistry({ now: () => b.clock.now() });
    const refused: string[] = [];
    const inner = b.link.gateway.stream.bind(b.link.gateway);
    b.link.gateway.stream = async function* (req: GatewayRequest, signal: AbortSignal) {
      if (req.purpose === 'agent' && req.scope.runId && !registry.get(req.scope.runId)) registry.open({ threadId: req.scope.threadId!, turnId: req.scope.turnId!, runId: req.scope.runId });
      const refusal = registry.validateRequest(req, { hostId: 'host-1' });
      if (refusal) {
        refused.push(req.purpose);
        yield { type: 'error', error: refusal, afterOutput: false } as GatewayEvent;
        return;
      }
      if (req.purpose === 'compaction') {
        b.link.gateway.requests.push(structuredClone(req));
        yield* textReply('## Objective\n- model summary');
        return;
      }
      yield* inner(req, signal);
    };
    const big = 'y'.repeat(24_000);
    b.tools.register(fakeTool<{ path: string }>('cat', { readOnly: true, run: (a) => okResult(`${a.path}\n${big}`, { effects: { readPaths: [a.path] } }) }));
    const childCtx = newId('run');
    let child: ChildRunResult | null = null;
    b.tools.register({
      ...fakeTool('subtask', {
        run: async () => {
          const active = b.loop.active(THREAD_A)!;
          child = await b.loop.runChild({ threadId: THREAD_A, parentRunId: active.runId, contextId: childCtx, prompt: 'explore', model: 'deepseek-ai/DeepSeek-V4-Flash', maxSteps: 6, maxUsd: 0.25, toolFilter: (d) => d.name === 'cat', signal: new AbortController().signal });
          return okResult(child.text || 'child done');
        },
      }),
      class: 'subagent',
    });
    b.link.gateway.script.push(
      callsReply([{ id: 'p1', name: 'subtask', args: {} }]),
      callsReply([{ id: 'k1', name: 'cat', args: { path: 'a.ts' } }], { prompt: 1_000 }),
      callsReply([{ id: 'k2', name: 'cat', args: { path: 'b.ts' } }], { prompt: 7_200 }),
      callsReply([{ id: 'k3', name: 'cat', args: { path: 'c.ts' } }], { prompt: 13_400 }),
      text('child report'),
      text('parent done'),
    );
    await runTurn(b, 'go');
    expect(refused).toEqual([]);
    const compactions = b.store.compactions.list(childCtx);
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0]!.summary).toContain('model summary');
  });
});

describe('approval requests always fit main’s schema (finding 14)', () => {
  function askingBench(subjectExtra: Record<string, unknown>) {
    const tool = { ...(fakeTool('write', { mutates: true }) as ToolDefinition), subject: () => ({ tool: 'write', kind: 'file-change' as const, title: 'Rewrite dist/app.min.js', risk: [], ...subjectExtra }) };
    const b = bench({ tools: [tool], deps: { perm: fakePermissionEngine({ write: { effect: 'ask', risk: [], suggestedRule: null, reason: 'approval-required mode' } }) } });
    const seen: ApprovalRequest[] = [];
    b.link.decide = (req) => {
      seen.push(req);
      return { kind: 'allow_once' };
    };
    return { b, seen };
  }
  for (const [label, extra] of [
    ['a diff with one 300k-character line', { diff: `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${'a'.repeat(150_000)}\n+${'b'.repeat(150_000)}` }],
    ['args JSON longer than 4,096 characters', { args: { blob: 'q'.repeat(5_000) } }],
    ['a 10k-character cwd and paths', { cwd: `/${'c'.repeat(10_000)}`, paths: [`/${'p'.repeat(10_000)}`] }],
  ] as const) {
    it(label, async () => {
      const { b, seen } = askingBench(extra);
      b.link.gateway.script.push(callsReply([{ id: 'w1', name: 'write', args: { path: 'a', content: 'x' } }]), text('ok'));
      await runTurn(b, 'go');
      expect(decodeHostToMain({ t: 'approval.request', request: { ...seen[0]!, allowedDecisions: [] } }).ok).toBe(true);
    });
  }

  it('the host link denies an approval main would drop instead of waiting forever', async () => {
    const link = createMainLink({ send: () => undefined, clock: { now: () => 0, setTimeout: () => 0, clearTimeout: () => undefined } });
    const bad = { requestId: 'apr_1', threadId: THREAD_A, runId: 'run_1', toolCallId: null, kind: 'command', tool: 'bash', title: 't', detail: { args: 'z'.repeat(5_000) }, risk: [], suggestedRule: null, allowedDecisions: [], createdAt: new Date(0).toISOString(), expiresAt: null } as ApprovalRequest;
    await expect(link.approvals.request(bad, new AbortController().signal)).resolves.toMatchObject({ kind: 'deny' });
  });
});

describe('a money refusal during compaction stops the turn resumably (finding 15)', () => {
  for (const code of ['limit_reached', 'budget_exceeded'] as const) {
    it(code, async () => {
      const b = withCompactor({ thread: { settings: settings({ maxContextTokens: 40_000 }) } });
      b.tools.register(fakeTool<{ path: string }>('cat', { readOnly: true, run: (a) => okResult(`${a.path}\n${'w'.repeat(24_000)}`) }));
      const inner = b.link.gateway.stream.bind(b.link.gateway);
      b.link.gateway.stream = async function* (req: GatewayRequest, signal: AbortSignal) {
        if (req.purpose === 'compaction') {
          yield { type: 'error', error: { code, message: 'A cap is reached.' }, afterOutput: false } as GatewayEvent;
          return;
        }
        yield* inner(req, signal);
      };
      b.link.gateway.script.push(callsReply([{ id: 'c1', name: 'cat', args: { path: 'a.ts' } }], { prompt: 7_000 }), text('never'));
      await runTurn(b, 'go');
      const t = b.store.threads.get(THREAD_A)!;
      expect(t.status).toBe('stopped');
      expect(t.statusReason).toBe(code === 'limit_reached' ? 'cost_cap' : 'budget');
      b.link.gateway.stream = inner;
      b.link.gateway.script.push(text('continued'));
      await expect(b.loop.resume(THREAD_A)).resolves.toMatchObject({ turn: 1 });
      await b.loop.idle(THREAD_A);
    });
  }
});

describe('the question tool waits as awaiting_user with the clock paused (finding 16)', () => {
  it('status awaiting_user; the answer arrives after 31 minutes without a time cap', async () => {
    const holder: { approvals: Parameters<typeof createQuestionTool>[0]['approvals'] | null } = { approvals: null };
    const q = createQuestionTool({ approvals: { request: (r, s) => holder.approvals!.request(r, s), pending: () => [] } }) as unknown as ToolDefinition;
    const b = bench({ tools: [q], thread: { settings: settings({ budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 30 } }) } });
    holder.approvals = b.link.approvals;
    const statusWhileAsking: string[] = [];
    b.link.decide = async () => {
      statusWhileAsking.push(b.store.threads.get(THREAD_A)!.status);
      b.clock.advance(31 * 60_000);
      await new Promise((r) => setTimeout(r, 0));
      return { kind: 'answer', text: 'Use PostgreSQL.' };
    };
    b.link.gateway.script.push(callsReply([{ id: 'q1', name: 'question', args: { question: 'Which database?' } }]), text('ok'));
    await runTurn(b, 'set up the db layer');
    expect(statusWhileAsking).toEqual(['awaiting_user']);
    expect(b.store.threads.get(THREAD_A)!.status).toBe('completed');
    expect(b.messages().find((m) => m.role === 'tool')!.content).toContain('PostgreSQL');
  });

  it('an unattended run never waits for an answer', async () => {
    const q = createQuestionTool({ approvals: { request: () => new Promise(() => undefined), pending: () => [] } }) as unknown as ToolDefinition;
    const b = bench({ tools: [q] });
    b.link.gateway.script.push(callsReply([{ id: 'q1', name: 'question', args: { question: 'Which database?' } }]), text('ok'));
    await b.loop.send(THREAD_A, 'go', { unattended: true });
    await b.loop.idle(THREAD_A);
    expect(b.messages().find((m) => m.role === 'tool')!.content).toMatch(/declined|Unattended/);
  });
});

function fileBench(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  const wt = path.join(dir, 'wt');
  const home = path.join(dir, 'home');
  const dataDir = path.join(dir, 'ud', 'data', 'harness');
  for (const d of [wt, home, dataDir]) fs.mkdirSync(d, { recursive: true });
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(wt, rel), content);
  const deps = { home, platform: 'linux' as const };
  const b = bench({ deps: { dataDir }, thread: { worktreePath: wt }, tools: [createReadTool(deps) as unknown as ToolDefinition, createEditTool(deps) as unknown as ToolDefinition] });
  return { b, wt };
}

describe('read dedupe never hides lines the model has not seen (findings 17, 18)', () => {
  it('lines cut by the step cap can be read again', async () => {
    const line = (f: number, i: number) => `file${f} line ${String(i + 1).padStart(4, '0')} abcdefghij`;
    const files: Record<string, string> = {};
    for (let f = 1; f <= 5; f += 1) files[`f${f}.ts`] = `${Array.from({ length: 1_200 }, (_, i) => line(f, i)).join('\n')}\n`;
    const { b } = fileBench(files);
    b.link.gateway.script.push(
      callsReply([1, 2, 3, 4, 5].map((f) => ({ id: `r${f}`, name: 'read', args: { path: `f${f}.ts` } }))),
      callsReply([{ id: 'r6', name: 'read', args: { path: 'f1.ts', offset: 1_150, limit: 50 } }]),
      text('done'),
    );
    await runTurn(b, 'read the files');
    const tools = b.messages().filter((m) => m.role === 'tool');
    expect(tools[0]!.content).toContain('[step output limit');
    expect(tools[0]!.content).not.toContain('read the spill');
    expect(tools[5]!.content).toContain('file1 line 1150');
  });

  it('[read X, edit X, read X] returns the new content', async () => {
    const { b, wt } = fileBench({ 'x.ts': 'export const answer = 41;\n' });
    b.link.gateway.script.push(
      callsReply([
        { id: 'a', name: 'read', args: { path: 'x.ts' } },
        { id: 'b', name: 'edit', args: { path: 'x.ts', old_string: '41', new_string: '42' } },
        { id: 'c', name: 'read', args: { path: 'x.ts' } },
      ]),
      callsReply([{ id: 'd', name: 'read', args: { path: 'x.ts' } }]),
      text('done'),
    );
    await runTurn(b, 'bump the answer');
    const results = b.messages().filter((m) => m.role === 'tool').map((m) => m.content);
    expect(fs.readFileSync(path.join(wt, 'x.ts'), 'utf8')).toContain('42');
    expect(results[0]).toContain('41');
    expect(results[2]).toContain('answer = 42');
    expect(results[3]).toMatch(/^Unchanged since your earlier read/);
  });
});

describe('steering is never lost when the run ends (finding 19)', () => {
  for (const [label, events] of [
    ['rate_limited', [{ type: 'error', error: { code: 'rate_limited', message: '429' }, afterOutput: false }]],
    ['stream cut twice', [{ type: 'started', attempt: 1, model: 'm', api: 'chat' }, { type: 'text', text: 'partial' }, { type: 'error', error: { code: 'upstream', message: 'cut' }, afterOutput: true }]],
  ] as const) {
    it(`stored and shown after ${label}`, async () => {
      const b = bench();
      const inner = b.link.gateway.stream.bind(b.link.gateway);
      let n = 0;
      b.link.gateway.stream = async function* (req, signal) {
        n += 1;
        if (n === 1) {
          yield* inner(req, signal);
          return;
        }
        b.link.gateway.requests.push(structuredClone(req));
        await b.loop.send(THREAD_A, 'Also update the README when you are done.');
        for (const e of events) yield e as never;
      };
      b.link.gateway.script.push(callsReply([{ id: 'r1', name: 'read', args: { path: 'x.ts' } }]));
      await runTurn(b, 'fix the bug');
      expect(b.store.threads.get(THREAD_A)!.status).toBe('stopped');
      expect(b.messages().some((m) => m.role === 'user' && m.content.includes('README'))).toBe(true);
      expect(b.link.events.sent.some((e) => e.type === 'item' && e.item.kind === 'user' && e.item.text.includes('README'))).toBe(true);
    });
  }

  it('steering that arrives during a final text step is answered in the same turn', async () => {
    const b = bench();
    const inner = b.link.gateway.stream.bind(b.link.gateway);
    let n = 0;
    b.link.gateway.stream = async function* (req, signal) {
      n += 1;
      if (n === 1) await b.loop.send(THREAD_A, 'And the README.');
      yield* inner(req, signal);
    };
    b.link.gateway.script.push(text('first answer'), text('README done'));
    await runTurn(b, 'fix the bug');
    const users = b.messages().filter((m) => m.role === 'user' && m.content.includes('README'));
    expect(users).toHaveLength(1);
    expect(b.link.gateway.requests.filter((r) => r.purpose === 'agent')).toHaveLength(2);
    expect(b.store.threads.get(THREAD_A)!.status).toBe('completed');
  });
});

describe('every charge reaches the thread cost (finding 20)', () => {
  const usage = (prompt: number, cost: number): GatewayEvent => ({ type: 'usage', usage: { promptTokens: prompt, completionTokens: 50, totalTokens: prompt + 50, reasoningTokens: null, cachedTokens: 0 }, cacheWriteTokens: null, costUsd: cost, estimated: false, maybeBilled: false });

  it('a dropped precompute is credited', async () => {
    const b = withCompactor();
    let charged = 0;
    const outputs = [60_000, 45_000, 50_000];
    let k = 0;
    b.tools.register(fakeTool<{ path: string }>('cat', { readOnly: true, run: (a) => okResult(`${a.path}\n${'z'.repeat((outputs[k++] ?? 10) * 4)}`, { effects: { readPaths: [a.path] } }) }));
    let agentStep = 0;
    b.link.gateway.stream = async function* (req: GatewayRequest, signal: AbortSignal) {
      b.link.gateway.requests.push(structuredClone(req));
      const prompt = Math.ceil(JSON.stringify(req.messages).length / 4);
      if (req.purpose === 'compaction') {
        charged += 0.02;
        for (const e of [{ type: 'started', attempt: 1, model: 'deepseek-ai/DeepSeek-V4-Flash', api: 'chat' }, { type: 'text', text: '## Objective\n- summary' }, usage(prompt, 0.02), { type: 'finish', reason: 'stop', raw: 'stop' }] as GatewayEvent[]) {
          await Promise.resolve();
          if (signal.aborted) throw new Error('aborted');
          yield e;
        }
        return;
      }
      agentStep += 1;
      charged += 0.05;
      for (const e of agentStep <= 3 ? callsReply([{ id: `c${agentStep}`, name: 'cat', args: { path: `f${agentStep}.ts` } }], { prompt, cost: 0.05 }) : text('done', { prompt, cost: 0.05 })) {
        await Promise.resolve();
        yield e;
      }
    };
    await runTurn(b, 'read the big files');
    await b.compactor.idle();
    expect(b.link.gateway.requests.some((r) => r.purpose === 'compaction' && r.priority === 'idle')).toBe(true);
    expect(b.store.threads.get(THREAD_A)!.costUsd).toBeCloseTo(charged, 6);
  });

  it('usage of an interrupted request reaches the host after gw.cancel', async () => {
    const gateway = {
      async *stream(_req: GatewayRequest, signal: AbortSignal) {
        yield { type: 'started', attempt: 1, model: MODEL, api: 'chat' } as GatewayEvent;
        yield { type: 'text', text: 'partial answer' } as GatewayEvent;
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        yield usage(90_000, 0.126);
        yield { type: 'error', error: { code: 'cancelled', message: 'The request was cancelled.' }, afterOutput: true } as GatewayEvent;
      },
    } as never;
    const clock = { now: () => Date.now(), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (t: unknown) => clearTimeout(t as NodeJS.Timeout) };
    const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as never;
    let host: ReturnType<typeof createMainLink> | null = null;
    const session = attachHostSession('host-1', (msg) => queueMicrotask(() => host!.handle(msg as never)), {
      gateway,
      approvals: { submit() {}, withdraw() {}, dropHost() {} } as never,
      rpc: async () => null,
      emitEvent() {},
      emitThreads() {},
      clock: clock as never,
      log,
    });
    host = createMainLink({ send: (msg) => queueMicrotask(() => session.handle(msg as never)), clock: clock as never });
    const late: Array<{ threadId: string; usd: number | null }> = [];
    host.onLateUsage((scope, ev) => late.push({ threadId: scope.threadId, usd: ev.costUsd }));
    const controller = new AbortController();
    const req = { requestId: 'req_1', purpose: 'agent', priority: 'foreground', scope: { threadId: THREAD_A, turnId: `${THREAD_A}:1`, runId: 'run_1', step: 1 }, target: { model: MODEL }, messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, prefixHash: null } as GatewayRequest;
    try {
      for await (const e of host.gateway.stream(req, controller.signal)) if (e.type === 'text') controller.abort();
    } catch {
      /* cancelled */
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(late).toEqual([{ threadId: THREAD_A, usd: 0.126 }]);
  });
});

describe('no_progress counts what the real tools report (finding 21)', () => {
  it('an ordinary exploration phase does not ask', () => {
    const ok = (effects?: DoomResult['effects']): DoomResult => ({ ok: true, errorKind: null, content: 'ok', ...(effects ? { effects } : {}) });
    const read = (p: string) => ok({ readPaths: [p], contentHashes: { [p]: `sha-${p}` } });
    const steps: Array<[string, unknown, DoomResult]> = [
      ['glob', { pattern: '**/*.ts' }, ok()],
      ['grep', { pattern: 'parseConfig' }, ok({ readPaths: ['src/config/a.ts', 'src/config/b.ts'] })],
      ['read', { path: 'src/config/a.ts' }, read('src/config/a.ts')],
      ['read', { path: 'src/config/b.ts' }, read('src/config/b.ts')],
      ['grep', { pattern: 'ConfigError' }, ok({ readPaths: ['src/config/a.ts'] })],
      ['list', { path: 'src/config' }, ok()],
      ['read', { path: 'src/config/a.ts', offset: 200, limit: 200 }, read('src/config/a.ts')],
      ['web_fetch', { url: 'https://nodejs.org/api/fs.html' }, ok({ command: null })],
      ['grep', { pattern: 'loadConfig' }, ok({ readPaths: [] })],
      ['read', { path: 'src/config/b.ts', offset: 300, limit: 200 }, read('src/config/b.ts')],
    ];
    const d = new DoomDetector();
    const fired = steps.map(([name, args, result]) => d.observe({ text: '', calls: [{ name, args: JSON.stringify(args) }], results: [result] })).filter(Boolean);
    expect(fired).toEqual([]);
  });
});

describe('compaction leaves no thread_seq gap (finding 22)', () => {
  it('forwarded seqs are contiguous and nothing internal is stored', async () => {
    const b = withCompactor({ thread: { settings: settings({ maxContextTokens: 40_000 }) } });
    b.tools.register(fakeTool<{ path: string }>('cat', { readOnly: true, run: (a) => okResult(`${a.path}\n${'v'.repeat(24_000)}`) }));
    const inner = b.link.gateway.stream.bind(b.link.gateway);
    b.link.gateway.stream = async function* (req, signal) {
      if (req.purpose === 'compaction') {
        yield* textReply('## Objective\n- s');
        return;
      }
      yield* inner(req, signal);
    };
    b.link.gateway.script.push(callsReply([{ id: 'c1', name: 'cat', args: { path: 'a.ts' } }], { prompt: 7_000 }), text('done', { prompt: 3_000 }));
    await runTurn(b, 'go');
    expect(b.store.compactions.list(`ctx_${THREAD_A}`).length).toBeGreaterThan(0);
    const seqs = b.link.events.sent.filter((e) => e.seq !== null).map((e) => e.seq as number);
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)).toBe(true);
    expect(b.store.eventLog.filter((e) => !['item', 'status', 'todo', 'diff'].includes(e.type))).toEqual([]);
  });
});

describe('cache_low only for cached models (finding 23)', () => {
  it('a model without a cache-read price never gets the notice', async () => {
    const b = bench({ deps: { modelInfo: () => ({ contextTokens: null, tierBoundaryTokens: null, pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: null } }) } });
    for (let i = 0; i < 5; i += 1) b.link.gateway.script.push(callsReply([{ id: `c${i}`, name: 'read', args: { path: `f${i}` } }], { prompt: 2_000 + i * 100, cached: 0 }));
    b.link.gateway.script.push(text('ok'));
    await runTurn(b, 'go');
    expect(b.link.events.sent.filter((e) => e.type === 'item' && e.item.kind === 'notice' && e.item.reason === 'cache_low')).toHaveLength(0);
  });
});
