/**
 * Caps (harness.md §6.3): the step cap's final summary request, the active-time wall clock (paused while awaiting
 * approval, RL-34), the cost caps (summary from the log, no model call).
 */
import { describe, expect, it } from 'vitest';
import { ActiveClock, checkCaps, resolveBudget, summaryFromLog, emptyRunLog } from '@harness/loop/caps';
import { MAX_STEPS_OUTPUT_TOKENS, PROMPTS, SYNTHETIC } from '@harness/loop/prompts';
import { fakeClock, fakeTool, okResult } from '../fakes';
import { bench, callsReply, runTurn, settings, text, THREAD_A } from './helpers';

describe('resolveBudget', () => {
  it('clamps steps to 1–500 and converts minutes', () => {
    expect(resolveBudget(settings({ budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 0, maxTurnMinutes: 30 } }))).toEqual({ maxSteps: 1, maxActiveMs: 1_800_000, perTurnUsd: 1, perThreadUsd: 5 });
    expect(resolveBudget(settings({ budget: { perTurnUsd: null, perThreadUsd: null, maxStepsPerTurn: 9_999, maxTurnMinutes: 1 } })).maxSteps).toBe(500);
  });

  it('checks time, then cost, then steps', () => {
    const budget = resolveBudget(settings());
    expect(checkCaps({ stepsDone: 50, budget, turnCostUsd: 2, threadCostUsd: 0, activeExpired: true })?.reason).toBe('time_cap');
    expect(checkCaps({ stepsDone: 50, budget, turnCostUsd: 1, threadCostUsd: 0, activeExpired: false })?.reason).toBe('cost_cap');
    expect(checkCaps({ stepsDone: 1, budget, turnCostUsd: 0, threadCostUsd: 5, activeExpired: false })?.reason).toBe('cost_cap');
    expect(checkCaps({ stepsDone: 50, budget, turnCostUsd: 0, threadCostUsd: 0, activeExpired: false })?.reason).toBe('step_cap');
    expect(checkCaps({ stepsDone: 49, budget, turnCostUsd: 0.99, threadCostUsd: 4.99, activeExpired: false })).toBeNull();
  });
});

describe('ActiveClock', () => {
  it('counts only active time and pauses (nested) while waiting', () => {
    const clock = fakeClock(0);
    let fired = 0;
    const c = new ActiveClock(clock, 10_000, () => (fired += 1));
    c.start();
    clock.advance(4_000);
    c.pause();
    c.pause();
    clock.advance(1_000_000);
    c.resume();
    expect(c.activeMs()).toBe(4_000);
    clock.advance(1_000_000);
    expect(fired).toBe(0);
    c.resume();
    clock.advance(5_999);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    expect(c.isExpired()).toBe(true);
  });
});

describe('summaryFromLog', () => {
  it('is deterministic and needs no model', () => {
    const log = emptyRunLog();
    log.steps = 3;
    log.toolCalls = 4;
    log.failedCalls = 1;
    log.changedPaths.add('b.ts').add('a.ts');
    log.commands.push('npm test');
    log.lastText = 'Fixed the parser.';
    expect(summaryFromLog(log)).toBe('Steps: 3; tool calls: 4 (1 failed).\nChanged: a.ts, b.ts.\nLast command: npm test\nLast message: Fixed the parser.');
  });
});

describe('the step cap (§6.3)', () => {
  it('sends one final request with tool_choice none and 1,500 output tokens; its calls get synthetic results', async () => {
    const b = bench({ thread: { settings: settings({ budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 2, maxTurnMinutes: 30 } }) } });
    b.link.gateway.script.push(
      callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }]),
      callsReply([{ id: 'b', name: 'grep', args: {} }]),
      callsReply([{ id: 'c', name: 'read', args: { path: 'x.ts' } }], { text: 'Done: read. Left: edit. Next: edit x.' }),
    );
    await runTurn(b, 'go');
    const reqs = b.link.gateway.requests;
    expect(reqs).toHaveLength(3);
    expect(reqs[2]!.toolChoice).toBe('none');
    expect(reqs[2]!.maxOutputTokens).toBe(MAX_STEPS_OUTPUT_TOKENS);
    // The tool block stays (cache), only the choice changes.
    expect(reqs[2]!.tools).toEqual(reqs[0]!.tools);
    expect(reqs[2]!.messages.at(-1)).toEqual({ role: 'user', content: PROMPTS.maxSteps });
    const msgs = b.messages();
    expect(msgs.at(-1)).toMatchObject({ role: 'tool', content: SYNTHETIC.stepCap });
    expect(b.ran).toHaveLength(2);
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status: 'stopped', statusReason: 'step_cap' });
    b.assertPaired();
  });
});

describe('the wall clock (§6.3, RL-34)', () => {
  it('pauses while awaiting approval: a 2-hour approval wait does not stop a 30-minute turn', async () => {
    const b = bench();
    b.perm.evaluate = (s) => (s.tool === 'edit' ? { effect: 'ask', risk: [], suggestedRule: null, reason: 'ask' } : { effect: 'allow', via: 'mode', ruleId: null, risk: [], profile: null });
    b.link.decide = () => {
      b.clock.advance(2 * 60 * 60 * 1000);
      return { kind: 'allow_once' };
    };
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'edit', args: { path: 'x.ts', content: 'n' } }]), text('done'));
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });

  it('aborts in-flight work at the time cap: synthetic results, stopped(time_cap), no summary request', async () => {
    const b = bench({ thread: { settings: settings({ budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 1 } }) } });
    b.tools.register(
      fakeTool('long', {
        readOnly: true,
        run: () =>
          new Promise((resolve) => {
            b.clock.advance(61_000);
            setTimeout(() => resolve(okResult('late')), 5);
          }),
      }),
    );
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'long', args: {} }]));
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status: 'stopped', statusReason: 'time_cap' });
    expect(b.messages().at(-1)).toMatchObject({ role: 'tool', content: SYNTHETIC.timeCapRunning });
    expect(b.link.gateway.requests).toHaveLength(1);
    b.assertPaired();
  });
});

describe('cost caps (§6.3)', () => {
  it('stops with cost_cap and a summary from the log, without a model call, once the turn cost reaches the cap', async () => {
    const b = bench({ thread: { settings: settings({ budget: { perTurnUsd: 0.01, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 30 } }) } });
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }], { cost: 0.02 }));
    await runTurn(b, 'go');
    expect(b.link.gateway.requests).toHaveLength(1);
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status: 'stopped', statusReason: 'cost_cap' });
    const notice = b.link.events.sent.filter((e) => e.type === 'item' && e.item.kind === 'notice').at(-1);
    expect(notice && notice.type === 'item' && notice.item.kind === 'notice' && notice.item.text).toContain('Steps: 1; tool calls: 1');
  });

  it('counts the thread cost across turns', async () => {
    const b = bench({ thread: { costUsd: 5 } });
    await runTurn(b, 'go');
    expect(b.link.gateway.requests).toHaveLength(0);
    expect(b.store.threads.get(THREAD_A)?.statusReason).toBe('cost_cap');
  });
});
