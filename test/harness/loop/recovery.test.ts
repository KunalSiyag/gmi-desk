/**
 * Host crash and restart (harness.md §5.1, §16 "a host crash"): a process killed between the call's start and its
 * result → synthetic results on replay; runs never resume automatically; "Continue" resumes the same turn.
 * Also subagent contexts (§8.6): a child's messages never reach the parent's context.
 */
import { describe, expect, it } from 'vitest';
import { createAgentLoop } from '@harness/loop/runner';
import { SYNTHETIC, PROMPTS } from '@harness/loop/prompts';
import { contextIdOf } from '@harness/types';
import { fakeSandboxRunner, fakeTool, okResult } from '../fakes';
import { bench, callsReply, runTurn, text, THREAD_A, type Bench } from './helpers';

function restart(b: Bench) {
  // A new loop over the same database: what the restarted host sees.
  return createAgentLoop({
    store: b.store,
    link: b.link,
    tools: b.tools,
    perm: b.perm,
    sandbox: fakeSandboxRunner(),
    git: b.git,
    lock: b.lock,
    compactor: b.compactor,
    clock: b.clock,
    log: b.link.log,
    dataDir: '/data/harness',
    platform: 'linux',
    defer: (fn) => queueMicrotask(fn),
  });
}

async function crashMidTool(b: Bench) {
  b.tools.register(fakeTool('hang', { mutates: true, run: () => new Promise(() => undefined) }));
  b.link.gateway.script.push(
    callsReply([
      { id: 'a', name: 'read', args: { path: 'x.ts' } },
      { id: 'b', name: 'hang', args: {} },
      { id: 'c', name: 'read', args: { path: 'x.ts' } },
    ]),
  );
  await b.loop.send(THREAD_A, 'go');
  for (let i = 0; i < 50 && !b.lock.isHeld(THREAD_A); i += 1) await new Promise((r) => setTimeout(r, 0));
  expect(b.lock.isHeld(THREAD_A)).toBe(true);
  // The host process dies here: nothing else of the old loop runs.
}

describe('crash recovery', () => {
  it('settles calls killed between start and result with synthetic results, in call order, and marks the run interrupted', async () => {
    const b = bench();
    await crashMidTool(b);
    expect(b.store.toolCalls.unsettled(THREAD_A)).toHaveLength(3);
    const loop2 = restart(b);
    expect(loop2.threadsToRecover()).toEqual([THREAD_A]);
    await loop2.recoverThread(THREAD_A);
    const tools = b.messages().filter((m) => m.role === 'tool');
    // The read had run (started) too, but its result was never committed: state unknown.
    expect(tools.map((m) => m.content)).toEqual([SYNTHETIC.restarted, SYNTHETIC.restarted, SYNTHETIC.restartedNotRun]);
    expect(b.store.toolCalls.unsettled()).toEqual([]);
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status: 'interrupted', statusReason: 'interrupted' });
    b.assertPaired();
    // No automatic resume (cost safety).
    expect(b.link.gateway.requests).toHaveLength(1);
    expect(loop2.threadsToRecover()).toEqual([]);
  });

  it('resume continues the same turn with a new run; the model sees the synthetic results', async () => {
    const b = bench();
    await crashMidTool(b);
    const loop2 = restart(b);
    await loop2.recoverThread(THREAD_A);
    b.link.gateway.script.push(text('Re-checked; all good.'));
    const r = await loop2.resume(THREAD_A);
    expect(r.turn).toBe(1);
    await loop2.idle(THREAD_A);
    const req = b.link.gateway.requests.at(-1)!;
    expect(req.scope.runId).toBe(r.runId);
    expect(req.messages.at(-1)).toMatchObject({ role: 'tool', content: SYNTHETIC.restartedNotRun });
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });

  it('resume after a stopped final answer adds a Continue user message; refuses idle or completed threads', async () => {
    const b = bench();
    b.link.gateway.script.push([{ type: 'error', error: { code: 'upstream', message: 'x' }, afterOutput: false }]);
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)?.status).toBe('stopped');
    b.link.gateway.script.push(text('ok'));
    await b.loop.resume(THREAD_A);
    await b.loop.idle(THREAD_A);
    // The last message before the resume was the user's; nothing is added.
    expect(b.messages().map((m) => m.role)).toEqual(['user', 'assistant']);
    await expect(b.loop.resume(THREAD_A)).rejects.toMatchObject({ code: 'invalid_input' });

    const c = bench();
    c.link.gateway.script.push(text('first', { reason: 'length' }), text('second', { reason: 'length' }));
    await runTurn(c, 'go');
    expect(c.store.threads.get(THREAD_A)?.statusReason).toBe('output_limit');
    c.link.gateway.script.push(text('third'));
    await c.loop.resume(THREAD_A);
    await c.loop.idle(THREAD_A);
    expect(c.messages().map((m) => m.content).slice(-2)).toEqual([PROMPTS.resume, 'third']);
  });

  it('shutdown interrupts runs with synthetic results within the grace period', async () => {
    const b = bench();
    b.tools.register(fakeTool('hang', { readOnly: true, run: () => new Promise(() => undefined) }));
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'hang', args: {} }]));
    await b.loop.send(THREAD_A, 'go');
    for (let i = 0; i < 50 && b.link.gateway.requests.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await b.loop.shutdown(2_500);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('interrupted');
    expect(b.messages().at(-1)).toMatchObject({ role: 'tool', content: SYNTHETIC.shutdown });
    b.assertPaired();
  });
});

describe('subagent contexts (§8.6)', () => {
  it("a child's messages and usage stay in its own context and never reach the parent's requests", async () => {
    const b = bench();
    const childCtx = 'run_child0000000000000000001';
    b.tools.register({
      ...fakeTool('task2', {
        run: async () => {
          const parent = b.loop.active(THREAD_A)!;
          const res = await b.loop.runChild({
            threadId: THREAD_A,
            parentRunId: parent.runId,
            contextId: childCtx,
            prompt: 'Find the parser.',
            model: 'deepseek-ai/DeepSeek-V4-Flash',
            maxSteps: 20,
            maxUsd: 0.25,
            toolFilter: (d) => d.name === 'read' || d.name === 'grep',
            signal: new AbortController().signal,
          });
          return okResult(`report: ${res.text}`);
        },
      }),
      class: 'subagent',
    });
    b.link.gateway.script.push(
      callsReply([{ id: 'call_0', name: 'task2', args: {} }]),
      // The child's two steps.
      callsReply([{ id: 'call_0', name: 'read', args: { path: 'x.ts' } }]),
      text('The parser is in x.ts.'),
      // The parent's next step.
      text('Done.'),
    );
    await runTurn(b, 'delegate');
    const reqs = b.link.gateway.requests;
    expect(reqs.map((r) => r.purpose)).toEqual(['agent', 'subagent', 'subagent', 'agent']);
    expect(reqs[1]!.priority).toBe('background');
    expect(reqs[1]!.tools?.map((t) => t.name)).toEqual(['grep', 'read']);
    expect(reqs[1]!.scope.runId).toBe(reqs[0]!.scope.runId);
    // Parent's last request: no child message inside.
    const parentText = JSON.stringify(reqs[3]!.messages);
    expect(parentText).not.toContain('Find the parser.');
    expect(parentText).toContain('report: The parser is in x.ts.');
    const childMsgs = b.store.messages.list(childCtx);
    expect(childMsgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(b.messages().some((m) => m.contextId === childCtx)).toBe(false);
    // Ids are per context: the child reused call_0 without a conflict.
    expect(childMsgs[1]!.toolCalls![0]!.id).toBe('call_0');
    expect(b.store.usage.list(THREAD_A, { contextId: childCtx })).toHaveLength(2);
    // The child's spend counts toward the thread and the parent's turn.
    expect(b.store.threads.get(THREAD_A)!.costUsd).toBeCloseTo(0.004, 6);
    b.assertPaired(contextIdOf(THREAD_A));
    b.assertPaired(childCtx);
  });
});
