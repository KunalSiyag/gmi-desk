/**
 * Doom-loop detection (harness.md §6.4, RL-10): each signal at its threshold, the actions in the loop
 * (awaiting_user question, hint message, unattended stop), and the golden 30-step empty-content tool loop with
 * varied calls that must trip none.
 */
import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@shared/contracts/gateway';
import { canonicalArgs, DoomDetector, normaliseError, type DoomResult, type DoomStep } from '@harness/loop/doom';
import { PROMPTS } from '@harness/loop/prompts';
import { fakeTool, okResult } from '../fakes';
import { bench, callsReply, MODEL, runTurn, settings, text, THREAD_A } from './helpers';

const ok = (effects?: DoomResult['effects']): DoomResult => ({ ok: true, errorKind: null, content: 'ok', ...(effects ? { effects } : {}) });
const err = (content: string, kind: DoomResult['errorKind'] = 'execution'): DoomResult => ({ ok: false, errorKind: kind, content });
const step = (calls: DoomStep['calls'], results: DoomResult[], t = ''): DoomStep => ({ text: t, calls, results });

describe('helpers', () => {
  it('canonicalises arguments (key order, whitespace)', () => {
    expect(canonicalArgs('{"b":1, "a":{"d":2,"c":3}}')).toBe(canonicalArgs('{"a":{"c":3,"d":2},"b":1}'));
    expect(canonicalArgs('')).toBe('{}');
    expect(canonicalArgs('{bad')).toBe('{bad');
  });

  it('strips digits and paths from errors', () => {
    expect(normaliseError('Error at /src/a.ts:12:4 — expected 3')).toBe(normaliseError('Error at /lib/b.ts:99:1 — expected 7'));
    expect(normaliseError('ENOENT: no such file x/y/z.json')).toBe('enoent: no such file <path>');
  });
});

describe('signals', () => {
  it('identical (tool, canonical args) 3 times in a row → ask', () => {
    const d = new DoomDetector();
    const c = { name: 'read', args: '{"path":"a"}' };
    expect(d.observe(step([c], [ok({ readPaths: ['a'] })]))).toBeNull();
    expect(d.observe(step([{ name: 'read', args: '{ "path": "a" }' }], [ok()]))).toBeNull();
    expect(d.observe(step([c], [ok()]))).toMatchObject({ kind: 'ask', signal: 'identical_calls' });
  });

  it('the same error: hint at the 3rd, ask at the 4th', () => {
    const d = new DoomDetector();
    const s = (n: number) => step([{ name: 'bash', args: `{"command":"npm test ${n}"}` }], [err(`Error in /src/f${n}.ts line ${n}: boom`)]);
    expect(d.observe(s(1))).toBeNull();
    expect(d.observe(s(2))).toBeNull();
    expect(d.observe(s(3))).toEqual({ kind: 'hint', signal: 'same_error' });
    expect(d.observe(s(4))).toMatchObject({ kind: 'ask', signal: 'same_error' });
  });

  it('no new file change, read or command for 8 steps → ask', () => {
    const d = new DoomDetector();
    // Two calls alternating (never three identical in a row): after both were seen once, nothing is new.
    const s = (i: number) => step([{ name: 'read', args: `{"path":"a","offset":${i % 2}}` }], [ok({ readPaths: ['a'] })]);
    expect(d.observe(s(0))).toBeNull();
    expect(d.observe(s(1))).toBeNull();
    for (let i = 0; i < 7; i += 1) expect(d.observe(s(i))).toBeNull();
    expect(d.observe(s(7))).toMatchObject({ kind: 'ask', signal: 'no_progress' });
  });

  it('a file returning to an earlier state twice → ask', () => {
    const d = new DoomDetector();
    const edit = (h: string, i: number) => step([{ name: 'edit', args: `{"i":${i}}` }], [ok({ changedPaths: ['f'], contentHashes: { f: h } })]);
    expect(d.observe(edit('A', 1))).toBeNull();
    expect(d.observe(edit('B', 2))).toBeNull();
    expect(d.observe(edit('A', 3))).toBeNull();
    expect(d.observe(edit('B', 4))).toMatchObject({ kind: 'ask', signal: 'oscillation' });
  });

  it('an identical step signature with non-empty text twice in a row → ask; empty text never matches', () => {
    const d = new DoomDetector();
    const s = (t: string, path: string) => step([{ name: 'read', args: `{"path":"${path}"}` }], [ok({ readPaths: [path] })], t);
    expect(d.observe(s('Let me look.', 'a'))).toBeNull();
    expect(d.observe(s('  let ME look. ', 'a'))).toMatchObject({ kind: 'ask', signal: 'identical_steps' });
    const e = new DoomDetector();
    expect(e.observe(s('', 'a'))).toBeNull();
    expect(e.observe(s('', 'b'))).toBeNull();
    // The same preamble with different calls is normal.
    expect(e.observe(s('Checking.', 'c'))).toBeNull();
    expect(e.observe(s('Checking.', 'd'))).toBeNull();
  });

  it('5 consecutive steps where every result is an execution error → ask; a non-zero exit is not one', () => {
    const d = new DoomDetector();
    for (let i = 0; i < 4; i += 1) expect(d.observe(step([{ name: 'read', args: `{"p":${i}}` }], [err(`missing file number-${'x'.repeat(i)}`, 'execution')]))).toBeNull();
    expect(d.observe(step([{ name: 'read', args: '{"p":9}' }], [err('missing file number-xxxxxxx', 'timeout')]))).toMatchObject({ kind: 'ask', signal: 'failing_steps' });

    const e = new DoomDetector();
    // `npm test` ran and failed (ok:false, kind null): executed, progress.
    for (let i = 0; i < 6; i += 1) expect(e.observe(step([{ name: 'bash', args: `{"c":${i}}` }], [{ ok: false, errorKind: null, content: `${i} failing`, effects: { command: `npm test -- ${i}` } }]))?.signal).not.toBe('failing_steps');
  });

  it('user denials are not execution errors', () => {
    const d = new DoomDetector();
    for (let i = 0; i < 6; i += 1) expect(d.observe(step([{ name: 'edit', args: `{"i":${i}}` }], [{ ...err('Denied by the user.', 'denied'), byUser: true, effects: { readPaths: [`p${i}`] } }]))).toBeNull();
  });

  it('reset after "Continue" starts the signal over', () => {
    const d = new DoomDetector();
    const c = { name: 'read', args: '{"path":"a"}' };
    d.observe(step([c], [ok({ readPaths: ['a'] })]));
    d.observe(step([c], [ok()]));
    expect(d.observe(step([c], [ok()]))?.kind).toBe('ask');
    d.reset('identical_calls');
    expect(d.observe(step([c], [ok()]))).toBeNull();
  });
});

describe('golden: a 30-step empty-content tool loop with varied calls trips no signal', () => {
  const plan = Array.from({ length: 30 }, (_, i) => {
    const kind = i % 3;
    return kind === 0 ? { name: 'read', args: { path: `src/f${i}.ts` } } : kind === 1 ? { name: 'grep', args: { pattern: `sym${i}` } } : { name: 'edit', args: { path: `src/f${i - 2}.ts`, content: `v${i}` } };
  });

  it('in the detector', () => {
    const d = new DoomDetector();
    plan.forEach((c, i) => {
      const effects = c.name === 'read' ? { readPaths: [String(c.args.path)] } : c.name === 'grep' ? { command: `grep ${String(c.args.pattern)}` } : { changedPaths: [String(c.args.path)], contentHashes: { [String(c.args.path)]: `h${i}` } };
      expect(d.observe(step([{ name: c.name, args: JSON.stringify(c.args) }], [ok(effects)], ''))).toBeNull();
    });
  });

  it('through the loop: 30 steps of content "" with calls, then an answer; no awaiting_user, completed', async () => {
    const b = bench({ thread: { settings: settings({ budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 30 } }) } });
    b.tools.register(fakeTool<{ pattern: string }>('search', { readOnly: true, run: (a) => okResult('hits', { effects: { command: `search ${a.pattern}` } }) }));
    const started: GatewayEvent = { type: 'started', attempt: 1, model: MODEL, api: 'chat' };
    plan.forEach((c, i) => {
      const name = c.name === 'grep' ? 'search' : c.name;
      // DeepSeek/GLM/Kimi style: an empty text part with every tool call.
      b.link.gateway.script.push([started, { type: 'text', text: '' }, ...callsReply([{ id: 'call_0', name, args: c.args }], { cost: 0.0001 }).slice(1)]);
      void i;
    });
    b.link.gateway.script.push(text('All done.'));
    await runTurn(b, 'refactor');
    expect(b.link.approvalsAsked).toEqual([]);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
    expect(b.link.gateway.requests).toHaveLength(31);
  });
});

describe('actions in the loop', () => {
  const same = () => callsReply([{ id: 'x', name: 'read', args: { path: 'x.ts' } }]);

  it('asks the user (awaiting_user, wall clock paused); "Continue" resets and goes on', async () => {
    const b = bench();
    const statuses: string[] = [];
    b.link.decide = (req) => {
      statuses.push(b.store.threads.get(THREAD_A)!.status);
      expect(req.kind).toBe('question');
      expect(req.detail.options).toEqual(['Continue', 'Stop']);
      return { kind: 'answer', text: 'Continue' };
    };
    b.link.gateway.script.push(same(), same(), same(), text('ok'));
    await runTurn(b, 'go');
    expect(statuses).toEqual(['awaiting_user']);
    expect(b.store.threads.get(THREAD_A)?.status).toBe('completed');
  });

  it('a hint answer becomes a user message after the results', async () => {
    const b = bench();
    b.link.decide = () => ({ kind: 'answer', text: 'Read y.ts instead.' });
    b.link.gateway.script.push(same(), same(), same(), text('ok'));
    await runTurn(b, 'go');
    const msgs = b.messages();
    const hint = msgs.findIndex((m) => m.role === 'user' && m.content === 'Read y.ts instead.');
    expect(hint).toBeGreaterThan(0);
    expect(msgs[hint - 1]!.role).toBe('tool');
  });

  it('"Stop" stops with doom_loop', async () => {
    const b = bench();
    b.link.decide = () => ({ kind: 'answer', text: 'Stop' });
    b.link.gateway.script.push(same(), same(), same());
    await runTurn(b, 'go');
    expect(b.store.threads.get(THREAD_A)).toMatchObject({ status: 'stopped', statusReason: 'doom_loop' });
    b.assertPaired();
  });

  it('unattended runs stop with doom_loop instead of asking', async () => {
    const b = bench();
    b.link.gateway.script.push(same(), same(), same());
    await b.loop.send(THREAD_A, 'go', { unattended: true });
    await b.loop.idle(THREAD_A);
    expect(b.link.approvalsAsked).toEqual([]);
    expect(b.store.threads.get(THREAD_A)?.statusReason).toBe('doom_loop');
  });

  it('the same error three times injects the hint message once', async () => {
    const b = bench();
    let n = 0;
    b.tools.register(fakeTool('build', { readOnly: true, run: () => ({ ...okResult(`Error: cannot find module ./m${n++}`), ok: false, errorKind: 'execution' }) }));
    b.link.gateway.script.push(
      callsReply([{ id: 'a', name: 'build', args: { i: 1 } }]),
      callsReply([{ id: 'b', name: 'build', args: { i: 2 } }]),
      callsReply([{ id: 'c', name: 'build', args: { i: 3 } }]),
      text('giving up'),
    );
    await runTurn(b, 'go');
    expect(b.messages().filter((m) => m.content === PROMPTS.doomHint)).toHaveLength(1);
  });
});
