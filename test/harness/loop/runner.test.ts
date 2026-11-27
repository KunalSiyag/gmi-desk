/**
 * The agent loop with a scripted fake gateway (harness.md §6, §16 "Loop"): run states, invariant 1 after every kind
 * of cut, batches, steering, continuation, ids, thread_seq.
 */
import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@shared/contracts/gateway';
import { GmiError } from '@shared/contracts/errors';
import { contextIdOf } from '@harness/types';
import { PROMPTS, SYNTHETIC } from '@harness/loop/prompts';
import type { LoopToolContext } from '@harness/loop/runner';
import { fakeTool, okResult } from '../fakes';
import { bench, callsReply, MODEL, runTurn, text, THREAD_A, THREAD_B } from './helpers';

const started: GatewayEvent = { type: 'started', attempt: 1, model: MODEL, api: 'chat' };

describe('a turn', () => {
  it('runs a text-only turn to completed with contiguous thread_seq and a runEnded', async () => {
    const b = bench();
    b.link.gateway.script.push(text('All done.'));
    const r = await runTurn(b, 'Say hi');
    expect(r.turn).toBe(1);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
    const seqs = b.link.events.sent.filter((e) => e.seq !== null).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(b.link.events.ended).toEqual([{ threadId: THREAD_A, runId: r.runId }]);
    const msgs = b.messages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]!.content.startsWith('Say hi\n\n<context>\n')).toBe(true);
    expect(msgs[1]!.content).toBe('All done.');
    // The user item shows the raw text, without the volatile block.
    const userItem = b.link.events.sent.find((e) => e.type === 'item' && e.item.kind === 'user');
    expect(userItem && userItem.type === 'item' && userItem.item.kind === 'user' && userItem.item.text).toBe('Say hi');
  });

  it('sends the request with the run scope, frozen tools and the prefix hash', async () => {
    const b = bench();
    b.link.gateway.script.push(text('ok'));
    const r = await runTurn(b, 'go');
    const req = b.link.gateway.requests[0]!;
    expect(req.purpose).toBe('agent');
    expect(req.priority).toBe('foreground');
    expect(req.scope).toEqual({ threadId: THREAD_A, turnId: `${THREAD_A}:1`, runId: r.runId, step: 1 });
    expect(req.tools?.map((t) => t.name)).toEqual(['edit', 'grep', 'list', 'question', 'read', 'task']);
    expect(req.prefixHash).toMatch(/^[0-9a-f]{64}$/);
    expect(req.messages[0]!.role).toBe('system');
    expect(req.messages[1]!.role).toBe('user');
    expect(String(req.messages[1]!.content)).toContain('<environment>');
  });

  it('defers the first gateway request until after send() returns (main opens the run on cmd.result)', async () => {
    const b = bench();
    b.link.gateway.script.push(text('ok'));
    await b.loop.send(THREAD_A, 'go');
    expect(b.link.gateway.requests).toHaveLength(0);
    await b.loop.idle(THREAD_A);
    expect(b.link.gateway.requests).toHaveLength(1);
  });

  it('loops through tool calls and stores every call paired with its result', async () => {
    const b = bench();
    b.link.gateway.script.push(callsReply([{ id: 'call_0', name: 'read', args: { path: 'x.ts' } }]), text('Read it.'));
    await runTurn(b, 'read x');
    expect(b.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(b.messages()[2]!.content).toBe('old');
    b.assertPaired();
    expect(b.store.toolCalls.unsettled()).toEqual([]);
    // Only public event types are stored by the loop (every stored event takes a thread_seq the renderer sees).
    expect(new Set(b.store.eventLog.map((e) => e.type))).toEqual(new Set(['item', 'status']));
  });

  it('commits the started call (row + running item) before the tool runs (invariant 2)', async () => {
    const b = bench();
    const seen: Array<{ startedAt: string | null; runningStored: boolean }> = [];
    b.tools.register(
      fakeTool('probe', {
        mutates: true,
        run: () => {
          const row = b.store.toolCalls.byWireId(contextIdOf(THREAD_A), 'p1')!;
          const runningStored = b.store.eventLog.some((e) => e.type === 'item' && (e.payload as { item: { id: string; status?: string } }).item.id === row.id && (e.payload as { item: { status?: string } }).item.status === 'running');
          seen.push({ startedAt: row.startedAt, runningStored });
          return okResult('probed');
        },
      }),
    );
    b.link.gateway.script.push(callsReply([{ id: 'p1', name: 'probe', args: { a: 1 } }]), text('ok'));
    await runTurn(b, 'go');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startedAt).not.toBeNull();
    expect(seen[0]!.runningStored).toBe(true);
    expect(b.store.toolCalls.byWireId(contextIdOf(THREAD_A), 'p1')!.args).toBe('{"a":1}');
  });

  it('refuses a second turn while one runs: the text is queued as steering instead', async () => {
    const b = bench();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.tools.register(fakeTool('slow', { readOnly: true, run: async () => (await gate, okResult('slow ok')) }));
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'slow', args: {} }]), text('done'));
    const r1 = await b.loop.send(THREAD_A, 'first');
    await new Promise((r) => setTimeout(r, 0));
    const r2 = await b.loop.send(THREAD_A, 'also this');
    expect(r2).toEqual({ runId: r1.runId, turn: 1, budgetWarning: null });
    release();
    await b.loop.idle(THREAD_A);
    const roles = b.messages().map((m) => `${m.role}${m.steering ? '*' : ''}`);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user*', 'assistant']);
  });

  it('makes command receipts idempotent', async () => {
    const b = bench();
    b.link.gateway.script.push(text('ok'));
    const a = await b.loop.send(THREAD_A, 'go', { commandId: 'cmd_1' });
    await b.loop.idle(THREAD_A);
    const again = await b.loop.send(THREAD_A, 'go', { commandId: 'cmd_1' });
    expect(again).toEqual(a);
    expect(b.link.gateway.requests).toHaveLength(1);
  });

  it('refuses threads that are archived or not ready', async () => {
    const b = bench();
    b.addThread(THREAD_B, { setupState: 'setting_up' });
    await expect(b.loop.send(THREAD_B, 'go')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(b.loop.send('nope', 'go')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('batches (§6.2 step 6)', () => {
  it('[read X, edit X, read X] returns the old content, applies the edit, then returns the new content', async () => {
    const b = bench();
    b.link.gateway.script.push(
      callsReply([
        { id: 'c1', name: 'read', args: { path: 'x.ts' } },
        { id: 'c2', name: 'edit', args: { path: 'x.ts', content: 'new' } },
        { id: 'c3', name: 'read', args: { path: 'x.ts' } },
      ]),
      text('done'),
    );
    await runTurn(b, 'edit x');
    const tools = b.messages().filter((m) => m.role === 'tool');
    expect(tools.map((m) => m.content)).toEqual(['old', 'edited', 'new']);
    expect(tools.map((m) => m.toolCallId)).toEqual(['c1', 'c2', 'c3']);
    expect(b.ran.map((r) => r.split(':')[0])).toEqual(['read', 'edit', 'read']);
  });

  it('runs read-only calls in parallel (up to 4) and appends results in call order', async () => {
    const b = bench();
    const active = { now: 0, max: 0 };
    let order = 0;
    b.tools.register(
      fakeTool<{ n: number }>('peek', {
        readOnly: true,
        run: async (args) => {
          active.now += 1;
          active.max = Math.max(active.max, active.now);
          // Later calls finish first.
          for (let i = 0; i < 10 - args.n; i += 1) await Promise.resolve();
          active.now -= 1;
          order += 1;
          return okResult(`peek ${args.n} finished ${order}`);
        },
      }),
    );
    b.link.gateway.script.push(callsReply([1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, name: 'peek', args: { n } }))), text('done'));
    await runTurn(b, 'peek');
    expect(active.max).toBe(4);
    const tools = b.messages().filter((m) => m.role === 'tool');
    expect(tools.map((m) => m.toolCallId)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(tools[0]!.content.startsWith('peek 1')).toBe(true);
  });

  it('treats task and question as barriers even when they claim to be read-only', async () => {
    const b = bench();
    const log: string[] = [];
    const track = (name: string) => async () => {
      log.push(`start ${name}`);
      await Promise.resolve();
      await Promise.resolve();
      log.push(`end ${name}`);
      return okResult(name);
    };
    b.tools.register({ ...fakeTool('ask', { readOnly: true, run: track('ask') }), class: 'user' });
    b.tools.register(fakeTool('look', { readOnly: true, run: track('look') }));
    b.link.gateway.script.push(
      callsReply([
        { id: 'a', name: 'look', args: {} },
        { id: 'b', name: 'ask', args: {} },
        { id: 'c', name: 'look', args: {} },
      ]),
      text('done'),
    );
    await runTurn(b, 'go');
    expect(log).toEqual(['start look', 'end look', 'start ask', 'end ask', 'start look', 'end look']);
  });

  it('holds the mutation lock during a mutating call and checkpoints once per turn before the first mutation', async () => {
    const b = bench();
    let heldDuring = false;
    b.tools.register(
      fakeTool('write2', {
        mutates: true,
        run: () => {
          heldDuring = b.lock.isHeld(THREAD_A);
          return okResult('w');
        },
      }),
    );
    b.link.gateway.script.push(
      callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }]),
      callsReply([{ id: 'b', name: 'write2', args: {} }]),
      callsReply([{ id: 'c', name: 'write2', args: {} }]),
      text('done'),
    );
    await runTurn(b, 'go');
    expect(heldDuring).toBe(true);
    expect(b.lock.isHeld(THREAD_A)).toBe(false);
    expect(b.git.calls.filter((c) => c.startsWith('checkpoint'))).toEqual([`checkpoint ${THREAD_A} 1`]);
    expect(b.store.checkpoints.list(THREAD_A)).toHaveLength(1);
  });

  it('caps the step output at 40k tokens, cutting the largest result first', async () => {
    const b = bench();
    b.tools.register(fakeTool<{ n: number }>('dump', { readOnly: true, run: (a) => okResult('x'.repeat(a.n)) }));
    b.link.gateway.script.push(
      callsReply([
        { id: 'a', name: 'dump', args: { n: 200_000 } },
        { id: 'b', name: 'dump', args: { n: 1_000 } },
      ]),
      text('done'),
    );
    await runTurn(b, 'go');
    const tools = b.messages().filter((m) => m.role === 'tool');
    expect(tools[1]!.content).toBe('x'.repeat(1_000));
    expect(tools[0]!.content.length).toBeLessThan(170_000);
    expect(tools[0]!.content).toContain('[step output limit');
  });
});

describe('invalid calls (§6.2 step 5)', () => {
  it('returns the schema and parse error for invalid JSON and unknown tools, and continues', async () => {
    const b = bench();
    b.link.gateway.script.push(
      callsReply([
        { id: 'a', name: 'read', args: '{"path": ' },
        { id: 'b', name: 'nope', args: {} },
      ]),
      text('sorry'),
    );
    await runTurn(b, 'go');
    const tools = b.messages().filter((m) => m.role === 'tool');
    expect(tools[0]!.content).toContain('invalid arguments for read');
    expect(tools[0]!.content).toContain('Expected JSON matching this schema');
    expect(tools[1]!.content).toContain('unknown tool "nope"');
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
    b.assertPaired();
  });

  it('stops with model_error after more than 2 invalid calls in one step; valid ones do not run', async () => {
    const b = bench();
    b.link.gateway.script.push(
      callsReply([
        { id: 'a', name: 'x1', args: {} },
        { id: 'b', name: 'x2', args: {} },
        { id: 'c', name: 'x3', args: {} },
        { id: 'd', name: 'read', args: { path: 'x.ts' } },
      ]),
    );
    await runTurn(b, 'go');
    const t = b.store.threads.get(THREAD_A)!;
    expect(t.status).toBe('stopped');
    expect(t.statusReason).toBe('model_error');
    expect(b.ran).toEqual([]);
    expect(b.messages().filter((m) => m.role === 'tool').at(-1)!.content).toBe(SYNTHETIC.invalidBudget);
    b.assertPaired();
  });
});

describe('length and cut streams (§6.2 steps 4 and 8, RL-22)', () => {
  it('continues once after `length` without tool calls, and stops with output_limit at the second', async () => {
    const b = bench();
    b.link.gateway.script.push(text('part one', { reason: 'length' }), text('part two', { reason: 'length' }));
    await runTurn(b, 'write a lot');
    const msgs = b.messages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs[2]!.content).toBe(PROMPTS.continuationLength);
    expect(b.store.threads.get(THREAD_A)?.statusReason).toBe('output_limit');
  });

  it('drops a call whose arguments were cut by `length`, runs the complete ones, and notes it (no invalid-JSON budget)', async () => {
    const b = bench();
    const cut: GatewayEvent[] = [
      started,
      { type: 'tool_call', call: { id: 'a', name: 'read', arguments: '{"path":"x.ts"}' } },
      { type: 'tool_call', call: { id: 'b', name: 'edit', arguments: '{"path":"x.ts","content":"aaaa' } },
      { type: 'finish', reason: 'length', raw: 'length' },
    ];
    b.link.gateway.script.push(cut, text('ok'));
    await runTurn(b, 'go');
    const msgs = b.messages();
    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.toolCalls?.map((c) => c.id)).toEqual(['a']);
    expect(msgs.find((m) => m.role === 'user' && m.content === PROMPTS.lengthInArgs('edit'))).toBeTruthy();
    expect(b.ran).toEqual(['read:{"path":"x.ts"}']);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
    b.assertPaired();
  });

  it('stops with output_limit the second time arguments are cut in a turn, every stored call paired', async () => {
    const b = bench();
    const cut = (id: string): GatewayEvent[] => [
      started,
      { type: 'tool_call', call: { id: `${id}1`, name: 'read', arguments: '{"path":"x.ts"}' } },
      { type: 'tool_call', call: { id: `${id}2`, name: 'edit', arguments: '{"path":' } },
      { type: 'finish', reason: 'length', raw: 'length' },
    ];
    b.link.gateway.script.push(cut('a'), cut('b'));
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)?.statusReason).toBe('output_limit');
    b.assertPaired();
  });

  it('re-issues the same step once when the stream is cut inside tool-call deltas; the partial is never stored', async () => {
    const b = bench();
    const cutDeltas: GatewayEvent[] = [
      started,
      { type: 'text', text: 'Let me edit' },
      { type: 'tool_call_delta', index: 0, id: 'z', name: 'edit', argumentsDelta: '{"path":"x' },
      { type: 'error', error: { code: 'upstream', message: 'reset' }, afterOutput: true },
    ];
    b.link.gateway.script.push(cutDeltas, text('fine'));
    await runTurn(b, 'go');
    expect(b.link.gateway.requests).toHaveLength(2);
    expect(b.link.gateway.requests[1]!.scope.step).toBe(1);
    const msgs = b.messages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toBe('fine');
    expect(b.link.gateway.requests[1]!.messages).toEqual(b.link.gateway.requests[0]!.messages);
  });

  it('asks for a continuation once when a stream with plain text is cut', async () => {
    const b = bench();
    b.link.gateway.script.push([started, { type: 'text', text: 'Half an ans' }, { type: 'error', error: { code: 'upstream', message: 'reset' }, afterOutput: true }], text('wer.'));
    await runTurn(b, 'go');
    const msgs = b.messages();
    expect(msgs.map((m) => m.content)).toEqual([expect.stringContaining('go'), 'Half an ans', PROMPTS.continuationCut, 'wer.']);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });

  it('stops with Continue after a second cut in the same step', async () => {
    const b = bench();
    const cut: GatewayEvent[] = [started, { type: 'tool_call_delta', index: 0, id: 'z', name: 'edit', argumentsDelta: '{' }, { type: 'error', error: { code: 'upstream', message: 'reset' }, afterOutput: true }];
    b.link.gateway.script.push(cut, cut);
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status: 'stopped', statusReason: 'model_error' });
    b.assertPaired();
  });
});

describe('gateway errors (§6.2 step 8)', () => {
  it.each([
    ['rate_limited', 'stopped', 'rate_limited'],
    ['budget_exceeded', 'stopped', 'budget'],
    ['limit_reached', 'stopped', 'cost_cap'],
    ['upstream', 'stopped', 'model_error'],
    ['network', 'stopped', 'offline'],
    ['invalid_api_key', 'failed', 'model_error'],
  ] as const)('%s → %s(%s), with every call paired', async (code, status, reason) => {
    const b = bench();
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }]), [{ type: 'error', error: { code, message: 'nope' }, afterOutput: false }]);
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status, statusReason: reason });
    b.assertPaired();
  });

  it('takes the layer-2 path on context_overflow: 85/70/50/35 % of the rejected size, then stopped(overflow)', async () => {
    const b = bench();
    const overflow: GatewayEvent[] = [{ type: 'error', error: { code: 'context_overflow', message: 'too big' }, afterOutput: false }];
    const shrinks: number[] = [];
    const compact = b.compactor.compact.bind(b.compactor);
    b.compactor.compact = async (req) => {
      shrinks.push(req.shrinkToTokens ?? -1);
      expect(req.reason).toBe('overflow');
      return compact(req);
    };
    b.link.gateway.script.push(overflow, overflow, overflow, overflow, overflow);
    await runTurn(b, 'go');
    expect(shrinks).toHaveLength(4);
    expect(shrinks[0]! / shrinks[3]!).toBeCloseTo(0.85 / 0.35, 1);
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status: 'stopped', statusReason: 'overflow' });
  });

  it('retries the same step after a successful layer-2 compaction', async () => {
    const b = bench();
    b.link.gateway.script.push([{ type: 'error', error: { code: 'context_overflow', message: 'too big' }, afterOutput: false }], text('fits now'));
    await runTurn(b, 'go');
    expect(b.compactor.compacted).toEqual([contextIdOf(THREAD_A)]);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });
});

describe('cancellation (§6.5)', () => {
  it('interrupt mid-tool gives every unsettled call a synthetic result and ends cancelled', async () => {
    const b = bench();
    b.tools.register(fakeTool('hang', { mutates: true, run: () => new Promise(() => undefined) }));
    b.link.gateway.script.push(
      callsReply([
        { id: 'a', name: 'read', args: { path: 'x.ts' } },
        { id: 'b', name: 'hang', args: {} },
        { id: 'c', name: 'read', args: { path: 'x.ts' } },
      ]),
    );
    await b.loop.send(THREAD_A, 'go');
    for (let i = 0; i < 20 && !b.lock.isHeld(THREAD_A); i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(b.lock.isHeld(THREAD_A)).toBe(true);
    await b.loop.interrupt(THREAD_A);
    const tools = b.messages().filter((m) => m.role === 'tool');
    expect(tools.map((m) => m.content)).toEqual(['old', SYNTHETIC.cancelled, SYNTHETIC.cancelled]);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('cancelled');
    b.assertPaired();
    expect(b.link.events.ended).toHaveLength(1);
  });

  it('interrupt mid-stream aborts the request and keeps the text seen so far', async () => {
    const b = bench();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gw = b.link.gateway;
    const stream = gw.stream.bind(gw);
    gw.stream = async function* (req, signal) {
      gw.requests.push(req);
      yield started;
      yield { type: 'text', text: 'partial' } as GatewayEvent;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        void gate.then(resolve);
      });
      if (signal.aborted) throw new GmiError('cancelled', 'Cancelled.');
      yield* stream(req, signal);
    };
    await b.loop.send(THREAD_A, 'go');
    for (let i = 0; i < 20 && gw.requests.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    await b.loop.interrupt(THREAD_A);
    release();
    expect(b.messages().map((m) => m.content)).toEqual([expect.stringContaining('go'), 'partial']);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('cancelled');
  });

  it('a cancel_run decision on an approval cancels the run', async () => {
    const b = bench();
    b.perm.evaluate = (s) => ({ effect: 'ask', risk: s.risk, suggestedRule: null, reason: 'ask' });
    b.link.decide = () => ({ kind: 'cancel_run' });
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'edit', args: { path: 'x.ts', content: 'n' } }]));
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)?.status).toBe('cancelled');
    expect(b.ran).toEqual([]);
    b.assertPaired();
  });
});

describe('permissions and approvals (§9)', () => {
  it('asks, waits in awaiting_approval, and runs on allow_once', async () => {
    const b = bench();
    b.perm.evaluate = (s) => (s.tool === 'edit' ? { effect: 'ask', risk: ['execution_sensitive'], suggestedRule: { tool: 'edit', pattern: 'x.ts', effect: 'allow', scope: 'project' }, reason: 'ask' } : { effect: 'allow', via: 'mode', ruleId: null, risk: [], profile: null });
    const statuses: string[] = [];
    b.link.decide = (req) => {
      statuses.push(b.store.threads.get(THREAD_A)!.status);
      expect(req.toolCallId).toMatch(/^tc_/);
      expect(req.risk).toEqual(['execution_sensitive']);
      return { kind: 'allow_once' };
    };
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'edit', args: { path: 'x.ts', content: 'n' } }]), text('done'));
    await runTurn(b, 'go');
    expect(statuses).toEqual(['awaiting_approval']);
    expect(b.files.get('x.ts')).toBe('n');
    expect(b.store.approvals.pending()).toEqual([]);
    const approvalItems = b.link.events.sent.filter((e) => e.type === 'item' && e.item.kind === 'approval');
    expect(approvalItems).toHaveLength(2);
  });

  it('a deny with feedback becomes the tool result and the run continues', async () => {
    const b = bench();
    b.perm.evaluate = (s) => ({ effect: 'ask', risk: s.risk, suggestedRule: null, reason: 'ask' });
    b.link.decide = () => ({ kind: 'deny', feedback: 'use the other file' });
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'edit', args: { path: 'x.ts', content: 'n' } }]), text('ok'));
    await runTurn(b, 'go');
    expect(b.messages().find((m) => m.role === 'tool')!.content).toBe('Denied by the user: use the other file');
    expect(b.files.get('x.ts')).toBe('old');
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });

  it('records allow_thread through the engine', async () => {
    const b = bench();
    let asked = 0;
    b.perm.evaluate = (s) => (asked++ === 0 ? { effect: 'ask', risk: s.risk, suggestedRule: { tool: s.tool, pattern: null, effect: 'allow', scope: 'thread' }, reason: 'ask' } : { effect: 'allow', via: 'rule', ruleId: 'r', risk: [], profile: null });
    b.link.decide = () => ({ kind: 'allow_thread' });
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'edit', args: { path: 'x.ts', content: 'n' } }]), text('ok'));
    await runTurn(b, 'go');
    expect(b.perm.listRules()).toHaveLength(1);
  });

  it('denies an ask in unattended runs without asking', async () => {
    const b = bench();
    b.perm.evaluate = (s) => ({ effect: 'ask', risk: s.risk, suggestedRule: null, reason: 'ask' });
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'edit', args: { path: 'x.ts', content: 'n' } }]), text('ok'));
    await b.loop.send(THREAD_A, 'go', { unattended: true });
    await b.loop.idle(THREAD_A);
    expect(b.link.approvalsAsked).toEqual([]);
    expect(b.messages().find((m) => m.role === 'tool')!.content).toContain('unattended');
  });

  it('a hard deny is a tool result, never a prompt', async () => {
    const b = bench();
    b.perm.evaluate = () => ({ effect: 'deny', via: 'hard', ruleId: null, reason: 'path outside the worktree', risk: ['outside_worktree'] });
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'read', args: { path: '/etc/passwd' } }]), text('ok'));
    await runTurn(b, 'go');
    expect(b.messages().find((m) => m.role === 'tool')!.content).toBe('Denied: path outside the worktree');
    expect(b.link.approvalsAsked).toEqual([]);
  });
});

describe('steering (§6.5)', () => {
  it('appends steering after the current step\'s tool results, joined into one user message', async () => {
    const b = bench();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.tools.register(fakeTool('slow', { readOnly: true, run: async () => (await gate, okResult('slow ok')) }));
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'slow', args: {} }]), text('done'));
    await b.loop.send(THREAD_A, 'go');
    for (let i = 0; i < 20 && b.link.gateway.requests.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    b.loop.steer(THREAD_A, 'also check y');
    b.loop.steer(THREAD_A, 'and z');
    release();
    await b.loop.idle(THREAD_A);
    const msgs = b.messages();
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect(msgs[3]).toMatchObject({ content: 'also check y\n\nand z', steering: true });
    // The second request is the first one plus appended messages: the prefix is preserved.
    const [r1, r2] = b.link.gateway.requests;
    expect(r2!.messages.slice(0, r1!.messages.length)).toEqual(r1!.messages);
  });

  it('steering that arrives during a final answer starts another step instead of completing', async () => {
    const b = bench();
    const gw = b.link.gateway;
    const stream = gw.stream.bind(gw);
    let n = 0;
    gw.stream = async function* (req, signal) {
      n += 1;
      if (n === 1) b.loop.steer(THREAD_A, 'one more thing');
      yield* stream(req, signal);
    };
    gw.script.push(text('first answer'), text('second answer'));
    await runTurn(b, 'go');
    expect(b.messages().map((m) => m.content)).toEqual([expect.stringContaining('go'), 'first answer', 'one more thing', 'second answer']);
  });

  it('refuses steer when nothing runs', () => {
    const b = bench();
    expect(() => b.loop.steer(THREAD_A, 'x')).toThrow(/No run is active/);
  });
});

describe('tool-call ids (§7.1, SC-20/RL-8)', () => {
  it('two threads and two turns whose provider repeats call_0: no conflict, distinct internal ids, byte-stable history', async () => {
    const b = bench();
    b.addThread(THREAD_B);
    for (const thread of [THREAD_A, THREAD_B]) {
      for (let turn = 0; turn < 2; turn += 1) {
        b.link.gateway.script.push(callsReply([{ id: 'call_0', name: 'read', args: { path: 'x.ts' } }]), callsReply([{ id: 'call_0', name: 'grep', args: {} }]), text('ok'));
        await runTurn(b, `turn ${turn}`, thread);
      }
    }
    for (const thread of [THREAD_A, THREAD_B]) {
      const calls = b.messages(thread).flatMap((m) => m.toolCalls ?? []);
      const ids = calls.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids[0]).toBe('call_0');
      expect(ids[1]).toBe('call_0_t1s2');
      expect(ids[2]).toBe('call_0_t2s1');
      b.assertPaired(contextIdOf(thread));
    }
    const internal = [THREAD_A, THREAD_B].flatMap((t) => b.messages(t).flatMap((m) => m.toolCalls ?? []).map((c) => b.store.toolCalls.byWireId(contextIdOf(t), c.id)!.id));
    expect(new Set(internal).size).toBe(internal.length);
    // The last request of thread A replays the stored history byte-for-byte.
    const lastA = b.link.gateway.requests.filter((r) => r.scope.threadId === THREAD_A).at(-1)!;
    const replayed = lastA.messages.flatMap((m) => m.toolCalls ?? []).map((c) => c.id);
    expect(replayed).toEqual(b.messages(THREAD_A).flatMap((m) => m.toolCalls ?? []).map((c) => c.id).slice(0, replayed.length));
  });

  it('fills a missing provider id with call_<turn>_<step>_<i>', async () => {
    const b = bench();
    b.link.gateway.script.push(callsReply([{ id: '', name: 'read', args: { path: 'x.ts' } }]), text('ok'));
    await runTurn(b, 'go');
    expect(b.messages().find((m) => m.role === 'assistant')!.toolCalls![0]!.id).toBe('call_1_1_0');
  });
});

describe('events (§6.6)', () => {
  it('thread_seq stays contiguous per thread with two interleaved streaming threads; deltas are never persisted', async () => {
    const b = bench();
    b.addThread(THREAD_B);
    const slowText = (t: string): GatewayEvent[] => [started, ...t.split('').map((c): GatewayEvent => ({ type: 'text', text: c })), { type: 'finish', reason: 'stop', raw: 'stop' }];
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }]), callsReply([{ id: 'b', name: 'read', args: { path: 'x.ts' } }]), slowText('alpha'), slowText('bravo'));
    await Promise.all([b.loop.send(THREAD_A, 'a'), b.loop.send(THREAD_B, 'b')]);
    await Promise.all([b.loop.idle(THREAD_A), b.loop.idle(THREAD_B)]);
    for (const t of [THREAD_A, THREAD_B]) {
      const seqs = b.link.events.sent.filter((e) => e.threadId === t && e.seq !== null).map((e) => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      expect(b.store.eventLog.filter((e) => e.threadId === t).map((e) => e.seq)).toEqual(b.store.eventLog.filter((e) => e.threadId === t).map((_, i) => i + 1));
    }
    expect(b.store.eventLog.some((e) => (e.type as string) === 'delta')).toBe(false);
    const deltas = b.link.events.sent.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    // Batched in the host: one delta per item flush, not one per character.
    expect(deltas.length).toBeLessThan(10);
  });

  it('delta offsets let the renderer rebuild the text exactly', async () => {
    const b = bench();
    b.link.gateway.script.push([started, { type: 'text', text: 'Hel' }, { type: 'reasoning', text: 'think' }, { type: 'text', text: 'lo' }, { type: 'finish', reason: 'stop', raw: 'stop' }]);
    await runTurn(b, 'go');
    let rebuilt = '';
    for (const e of b.link.events.sent) if (e.type === 'delta' && e.field === 'text') rebuilt = rebuilt.slice(0, e.offset) + e.text;
    expect(rebuilt).toBe('Hello');
  });

  it('meter events carry the context meter and are throttled', async () => {
    const b = bench();
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }]), text('ok'));
    await runTurn(b, 'go');
    const meters = b.link.events.sent.filter((e) => e.type === 'meter');
    expect(meters.length).toBe(1);
    const m = meters[0]!;
    expect(m.type === 'meter' && m.meter.windowTokens).toBe(128_000);
    expect(m.type === 'meter' && m.meter.ceilingTokens).toBe(128_000 - (19_200 + 16_384));
  });
});

describe('usage and money', () => {
  it('records usage per step and accumulates thread cost and tokens', async () => {
    const b = bench();
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }], { prompt: 1_000, cached: 0, cost: 0.002 }), text('ok', { prompt: 1_200, cost: 0.001 }));
    await runTurn(b, 'go');
    const t = b.store.threads.get(THREAD_A)!;
    expect(t.costUsd).toBeCloseTo(0.003, 6);
    expect(t.tokens.input).toBe(2_200);
    const usage = b.store.usage.list(THREAD_A);
    expect(usage.map((u) => u.step)).toEqual([1, 2]);
    expect(usage[0]!.prefixHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('side tasks', () => {
  it('derives a free title from the first message when the thread has none and no side-task model', async () => {
    const b = bench({ thread: { title: '' } });
    b.link.gateway.script.push(text('ok'));
    await runTurn(b, '  \nFix the flaky date test in utils\nmore');
    expect(b.store.threads.get(THREAD_A)!.title).toBe('Fix the flaky date test in utils');
    expect(b.link.gateway.requests.map((r) => r.purpose)).toEqual(['agent']);
  });

  it('asks the side-task model for a title at background priority when one is set', async () => {
    const b = bench({ thread: { title: '' } });
    const t = b.store.threads.get(THREAD_A)!;
    b.store.threads.update(THREAD_A, { settings: { ...t.settings, sideTaskModel: 'router' } });
    b.link.gateway.script.push(text('ok'), text('"Flaky date test fix."'));
    await runTurn(b, 'fix it');
    await new Promise((r) => setTimeout(r, 0));
    const title = b.link.gateway.requests.find((r) => r.purpose === 'title')!;
    expect(title.priority).toBe('background');
    expect(title.target).toEqual({ router: 'cost' });
    expect(title.tools).toBeUndefined();
  });
});

describe('token thrift: window, compaction hooks, cache diagnostics (§7.1, §7.4, DH10)', () => {
  const info = (contextTokens: number | null) => ({ contextTokens, tierBoundaryTokens: null, pricing: { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheReadPerMTok: 0.26 } });

  it('works in the 160k default window even when the model offers 1M', async () => {
    const b = bench({ deps: { modelInfo: () => info(1_000_000) } });
    const ceilings: Array<{ window: number; ceiling: number }> = [];
    const ceiling = b.compactor.ceiling.bind(b.compactor);
    b.compactor.ceiling = (input) => {
      const c = ceiling(input);
      ceilings.push({ window: c.windowTokens, ceiling: c.ceilingTokens });
      return c;
    };
    b.link.gateway.script.push(text('ok'));
    await runTurn(b, 'go');
    expect(ceilings[0]).toEqual({ window: 160_000, ceiling: 160_000 - (24_000 + 16_384) });
    const meter = b.link.events.sent.find((e) => e.type === 'meter');
    expect(meter && meter.type === 'meter' && meter.meter.nextStepUsd).toBeGreaterThan(0);
  });

  it('starts a background precompute near the ceiling and compacts at it', async () => {
    const b = bench({ deps: { modelInfo: () => info(128_000) } });
    b.link.gateway.script.push(
      callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }], { prompt: 80_000 }),
      callsReply([{ id: 'b', name: 'grep', args: {} }], { prompt: 95_000 }),
      text('ok'),
    );
    await runTurn(b, 'go');
    expect(b.compactor.precomputed).toEqual([contextIdOf(THREAD_A)]);
    expect(b.compactor.compacted).toEqual([contextIdOf(THREAD_A)]);
    const statuses = b.link.events.sent.filter((e) => e.type === 'status').map((e) => e.type === 'status' && e.status);
    expect(statuses).toContain('compacting');
  });

  it('flags a low cache hit after step 3 once (cache_miss_suspect)', async () => {
    // Only for models with prompt caching (a cache-read price); review H2.
    const b = bench({ deps: { modelInfo: () => ({ contextTokens: null, tierBoundaryTokens: null, pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1 } }) } });
    for (let i = 0; i < 5; i += 1) b.link.gateway.script.push(callsReply([{ id: `c${i}`, name: 'read', args: { path: `f${i}` } }], { prompt: 2_000 + i * 100, cached: 0 }));
    b.link.gateway.script.push(text('ok'));
    await runTurn(b, 'go');
    expect(b.link.log.lines.filter((l) => l.message === 'cache_miss_suspect')).toHaveLength(1);
    expect(b.link.events.sent.filter((e) => e.type === 'item' && e.item.kind === 'notice' && e.item.reason === 'cache_low')).toHaveLength(1);
    expect(b.store.usage.list(THREAD_A)[4]!.expectedCached).toBe(2_300);
  });

  it('gives the compactor the exact frozen prefix and forwards its stored events after flushing deltas', async () => {
    const b = bench();
    let info2: ReturnType<typeof b.loop.compactionContext> = null;
    b.tools.register(
      fakeTool('peek2', {
        readOnly: true,
        run: () => {
          info2 = b.loop.compactionContext({ threadId: THREAD_A, contextId: contextIdOf(THREAD_A), model: MODEL, turn: 1 });
          return okResult('ok');
        },
      }),
    );
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'peek2', args: {} }]), text('ok'));
    await runTurn(b, 'go');
    const req = b.link.gateway.requests[0]!;
    expect(info2).not.toBeNull();
    expect(info2!.prefix!.messages).toEqual(req.messages.slice(0, 2));
    expect(info2!.prefix!.tools).toEqual(req.tools);
    expect(info2!.prefix!.prefixHash).toBe(req.prefixHash);
    expect(b.loop.compactionContext({ threadId: THREAD_A, contextId: contextIdOf(THREAD_A), model: MODEL, turn: 1 })).toBeNull();

    const stored = b.store.events.append({ threadId: THREAD_A, contextId: contextIdOf(THREAD_A), runId: null, turn: 1, step: null, type: 'item', payload: { type: 'item', item: { kind: 'compaction', id: 'cmp_1', seq: 0, beforeTokens: 9, afterTokens: 3, model: 'm', costUsd: null, at: 'x' } } });
    b.loop.forwardStored(stored);
    const last = b.link.events.sent.at(-1)!;
    expect(last).toMatchObject({ threadId: THREAD_A, seq: stored.seq, type: 'item' });
  });
});

describe('tool context extras', () => {
  it('askUser from a tool waits in awaiting_user (clock paused) and returns the answer', async () => {
    const b = bench();
    const statuses: string[] = [];
    b.link.decide = (req) => {
      statuses.push(`${b.store.threads.get(THREAD_A)!.status}:${req.kind}:${req.detail.question}`);
      b.clock.advance(3 * 60 * 60 * 1000);
      return { kind: 'answer', text: 'blue' };
    };
    b.tools.register({
      ...fakeTool('ask2', {
        run: async () => okResult('unused'),
      }),
      class: 'user',
      run: async (_args, ctx) => {
        const d = await (ctx as LoopToolContext).askUser({ question: 'Which colour?', options: ['red', 'blue'] });
        return okResult(d.kind === 'answer' ? `user said ${d.text}` : 'no answer');
      },
    });
    b.link.gateway.script.push(callsReply([{ id: 'q', name: 'ask2', args: {} }]), text('ok'));
    await runTurn(b, 'go');
    expect(statuses).toEqual(['awaiting_user:question:Which colour?']);
    expect(b.messages().find((m) => m.role === 'tool')!.content).toBe('user said blue');
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });

  it('passes allow_once sensitiveWrites to the tool', async () => {
    const b = bench();
    let seen: boolean | null = null;
    b.perm.evaluate = (s) => ({ effect: 'ask', risk: s.risk, suggestedRule: null, reason: 'ask' });
    b.link.decide = () => ({ kind: 'allow_once', sensitiveWrites: true });
    b.tools.register({ ...fakeTool('w3', { mutates: true }), run: async (_a, ctx) => ((seen = (ctx as LoopToolContext).sensitiveWrites), okResult('w')) });
    b.link.gateway.script.push(callsReply([{ id: 'w', name: 'w3', args: {} }]), text('ok'));
    await runTurn(b, 'go');
    expect(seen).toBe(true);
  });
});
