/**
 * Context building (harness.md §7.1, §7.2): instructions only from the trusted snapshot, the frozen environment
 * block, volatile data only in the turn's message, wire ids, the compaction view order, token accounting, batch
 * planning and the per-step output cap, steering joins, side-task helpers.
 */
import { describe, expect, it } from 'vitest';
import type { GatewayEvent } from '@shared/contracts/gateway';
import { capStepResults, isParallelEligible, planBatches } from '@harness/loop/batch';
import { assignWireIds, buildPrefix, budgetLine, environmentBlock, historyView, instructionsFromSnapshot, reasoningFamily, requestMessages, threadGitRecord, volatileBlock } from '@harness/loop/context';
import { capBytes, PROMPT_VERSION } from '@harness/loop/prompts';
import { cleanCommitMessage, cleanTitle, fallbackTitle, suggestCommitMessage } from '@harness/loop/side-tasks';
import { joinSteering, SteerQueue } from '@harness/loop/steer';
import { Calibration, estimateMessage, estimateTokens, sizeEstimate } from '@harness/loop/tokens';
import { contextIdOf, type MessageRow } from '@harness/types';
import { memoryStore, scriptedGatewayClient } from '../fakes';
import { bench, callsReply, projectRow, runTurn, text, THREAD_A, threadRow } from './helpers';

const ENV = environmentBlock({ platform: 'linux', shell: 'bash', repoName: 'demo', worktreePath: '/w', baseBranch: 'main', branch: 'gmi/abc/x', ripgrep: true, sandbox: 'bwrap, network proxy' });

describe('the prefix', () => {
  it('hashes [system]+[tools]+[user#0] and changes with any of them', () => {
    const tools = [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { b: {}, a: {} } } }];
    const p = buildPrefix({ tools, instructions: 'Use pnpm.', environment: ENV });
    expect(p.promptVersion).toBe(PROMPT_VERSION);
    expect(buildPrefix({ tools, instructions: 'Use pnpm.', environment: ENV }).hash).toBe(p.hash);
    expect(buildPrefix({ tools, instructions: 'Use npm.', environment: ENV }).hash).not.toBe(p.hash);
    expect(buildPrefix({ tools: [], instructions: 'Use pnpm.', environment: ENV }).hash).not.toBe(p.hash);
    // Canonical tool JSON: key order of the registry does not matter.
    const reordered = [{ parameters: { properties: { a: {}, b: {} }, type: 'object' }, description: 'Read', name: 'read' }];
    expect(buildPrefix({ tools: reordered, instructions: 'Use pnpm.', environment: ENV }).hash).toBe(p.hash);
  });

  it('has no date, mode or budget in the system prompt or [user#0]', () => {
    const p = buildPrefix({ tools: [], instructions: '', environment: ENV });
    const all = `${p.system.content as string}\n${p.user0.content as string}`;
    expect(all).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(all).not.toMatch(/auto-accept-edits|full-access|approval-required/);
    expect(all).not.toMatch(/\$\d/);
  });

  it('takes instructions from the trusted snapshot only, in order, capped at 32 KiB', () => {
    const store = memoryStore();
    const project = projectRow();
    store.trustedFiles.replace(project.id, [
      { projectId: project.id, path: 'CLAUDE.md', sha: 's2', content: 'Claude rules\n' },
      { projectId: project.id, path: 'AGENTS.md', sha: 's1', content: 'Agent rules' },
      { projectId: project.id, path: 'README.md', sha: 's3', content: 'not an instruction file' },
    ]);
    expect(instructionsFromSnapshot(store, project)).toBe('# AGENTS.md\nAgent rules\n\n# CLAUDE.md\nClaude rules');
    expect(instructionsFromSnapshot(store, { ...project, trustState: 'untrusted' })).toBe('');
    store.trustedFiles.replace(project.id, [{ projectId: project.id, path: 'AGENTS.md', sha: 's', content: 'x'.repeat(40_000) }]);
    expect(Buffer.byteLength(instructionsFromSnapshot(store, project))).toBeLessThanOrEqual(32 * 1024);
  });

  it('computes the environment block once per thread and stores it; the instructions change only at a turn, with a notice', async () => {
    const b = bench();
    b.store.trustedFiles.replace('p_demo', [{ projectId: 'p_demo', path: 'AGENTS.md', sha: 's1', content: 'v1' }]);
    b.link.gateway.script.push(text('ok'), text('ok'));
    await runTurn(b, 'one');
    const env = b.store.threads.get(THREAD_A)!.envBlock;
    expect(env).toContain('worktree: /work/.worktrees/');
    b.store.trustedFiles.replace('p_demo', [{ projectId: 'p_demo', path: 'AGENTS.md', sha: 's2', content: 'v2' }]);
    await runTurn(b, 'two');
    expect(b.store.threads.get(THREAD_A)!.envBlock).toBe(env);
    const [r1, r2] = b.link.gateway.requests;
    expect(r1!.messages[1]!.content).toContain('v1');
    expect(r2!.messages[1]!.content).toContain('v2');
    expect(b.link.events.sent.some((e) => e.type === 'item' && e.item.kind === 'notice' && e.item.reason === 'instructions_changed')).toBe(true);
  });

  it('uses the eval fixtures for <environment>, date and budget (deterministic requests)', async () => {
    const b = bench({ deps: { evalMode: { date: '2000-01-01', environment: 'os: eval\nworktree: /work/task', budget: 'fixed' } } });
    b.link.gateway.script.push(text('ok'));
    await runTurn(b, 'go');
    const req = b.link.gateway.requests[0]!;
    expect(req.messages[1]!.content).toContain('os: eval');
    expect(req.messages[2]!.content).toContain('date: 2000-01-01');
    expect(req.messages[2]!.content).toContain('budget: fixed');
  });
});

describe('the turn message (volatile data)', () => {
  it('holds date, mode rules, git status (≤ 2 KiB), open todos and the budget', () => {
    const v = volatileBlock({ date: '2026-11-02', mode: 'auto', gitStatus: ` M a.ts\n${'?? x\n'.repeat(1_000)}`, todos: [{ id: '1', text: 'a', status: 'done' }, { id: '2', text: 'b', status: 'in_progress' }, { id: '3', text: 'c', status: 'pending' }], budget: 'turn: $1.00 of $1.00 left' });
    expect(v.startsWith('<context>\ndate: 2026-11-02\nmode: auto:')).toBe(true);
    expect(v).toContain('open todos:\n- [~] b\n- [ ] c');
    expect(v).not.toContain('- [ ] a');
    expect(v).toContain('[git status truncated]');
    expect(volatileBlock({ date: 'd', mode: 'auto', gitStatus: null, todos: [], budget: 'b' })).toContain('git status: clean');
  });

  it('formats the budget line', () => {
    expect(budgetLine({ perTurnUsd: 1, perThreadUsd: 5, turnSpentUsd: 0.25, threadSpentUsd: 6 })).toBe('turn: $0.75 of $1.00 left; thread: $0.00 of $5.00 left');
    expect(budgetLine({ perTurnUsd: null, perThreadUsd: null, turnSpentUsd: 0, threadSpentUsd: 0 })).toBe('turn: no cap; thread: no cap');
  });

  it('is stored once, so a later turn replays it byte-for-byte', async () => {
    const b = bench();
    b.git.statusShort = async () => ' M x.ts';
    b.link.gateway.script.push(text('ok'), text('ok'));
    await runTurn(b, 'one');
    b.git.statusShort = async () => ' M y.ts';
    b.clock.advance(86_400_000);
    await runTurn(b, 'two');
    const [r1, r2] = b.link.gateway.requests;
    expect(r2!.messages.slice(0, r1!.messages.length)).toEqual([...r1!.messages.slice(0, 3), ...r2!.messages.slice(3, r1!.messages.length)]);
    expect(r2!.messages[2]).toEqual(r1!.messages[2]);
    expect(String(r2!.messages.at(-1)!.content)).toContain(' M y.ts');
  });
});

describe('history', () => {
  const row = (ord: number, over: Partial<MessageRow>): MessageRow => ({ id: `m${ord}`, threadId: 't', contextId: 'ctx_t', ord, turn: 1, role: 'user', content: `c${ord}`, toolCalls: null, toolCallId: null, reasoning: null, reasoningFamily: null, model: null, inContext: true, pinned: false, partial: false, estTokens: null, ...over });

  it('follows the compaction view: summary, pinned rows, then the history after the anchor; partial rows never sent', () => {
    const store = memoryStore();
    const add = (over: Partial<MessageRow>) => store.messages.append({ ...row(0, { contextId: 'ctx_t', ...over }) });
    add({ id: 'u1', content: 'old request' });
    add({ id: 'a1', role: 'assistant', content: 'old answer' });
    add({ id: 'u2', content: 'current request' });
    add({ id: 'a2', role: 'assistant', content: '', toolCalls: [{ id: 'k', name: 'read', arguments: '{}' }] });
    add({ id: 't2', role: 'tool', content: 'r', toolCallId: 'k' });
    store.compactions.insert({ id: 'cmp_1', threadId: 't', contextId: 'ctx_t', uptoOrd: 3, summary: 'did stuff', model: 'm', beforeTokens: 10, afterTokens: 2, costUsd: 0, createdAt: 'x' });
    store.messages.markOutOfContext('ctx_t', 3);
    add({ id: 'p2', content: 'current request', pinned: true });
    store.messages.upsertPartial({ ...row(0, { id: 'partial', role: 'assistant', content: 'stream…' }) });
    const view = historyView(store, 'ctx_t');
    expect(view.summary?.msg.content).toBe('Summary of earlier work in this thread:\n\ndid stuff');
    expect(view.entries.map((e) => e.row.id)).toEqual(['p2', 'a2', 't2']);
    expect(view.entries[2]!.msg).toEqual({ role: 'tool', content: 'r', toolCallId: 'k', name: 'read' });
    const prefix = buildPrefix({ tools: [], instructions: '', environment: ENV });
    expect(requestMessages(prefix, view).map((m) => m.role)).toEqual(['system', 'user', 'user', 'user', 'assistant', 'tool']);
  });

  it('replays reasoning with its family (the gateway applies the replay rule)', () => {
    const store = memoryStore();
    store.messages.append({ ...row(0, { id: 'a', role: 'assistant', content: 'x', reasoning: 'why', reasoningFamily: 'deepseek-ai' }) });
    expect(historyView(store, 'ctx_t').entries[0]!.msg.reasoning).toEqual({ text: 'why', family: 'deepseek-ai' });
    expect(reasoningFamily('deepseek-ai/DeepSeek-V4')).toBe('deepseek-ai');
  });
});

describe('wire ids (§7.1)', () => {
  it('keeps unused provider ids, fills missing ones, renames repeats, and never collides inside one message', () => {
    const used = new Set(['call_0']);
    const ids = assignWireIds({
      calls: [
        { id: 'call_0', name: 'a', arguments: '{}' },
        { id: '', name: 'b', arguments: '{}' },
        { id: 'toolu_x', name: 'c', arguments: '{}' },
        { id: 'toolu_x', name: 'd', arguments: '{}' },
        { id: 'bad id with spaces', name: 'e', arguments: '{}' },
      ],
      turn: 3,
      step: 7,
      isUsed: (id) => used.has(id),
    });
    expect(ids).toEqual(['call_0_t3s7', 'call_3_7_1', 'toolu_x', 'toolu_x_t3s7', 'call_3_7_4']);
  });
});

describe('the git record', () => {
  it('uses only the paths recorded at creation', () => {
    const t = threadRow(THREAD_A);
    expect(threadGitRecord(t, projectRow())).toMatchObject({ worktreePath: t.worktreePath, gitDir: t.gitDir, commonDir: t.commonDir, gitPointer: t.gitPointer, refFormat: 'files' });
    expect(threadGitRecord({ ...t, gitDir: null }, projectRow())).toBeNull();
  });
});

describe('tokens (§7.2)', () => {
  it('estimates 4 ASCII chars per token and 1 per other character', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('日本')).toBe(2);
    expect(estimateTokens('😀')).toBe(1);
    expect(estimateMessage({ role: 'user', content: 'abcd' })).toBe(5);
  });

  it('calibrates k by EMA (α 0.3), clamped to 0.5–2.5', () => {
    const c = new Calibration();
    expect(c.get('t', 'm')).toBe(1);
    expect(c.observe('t', 'm', 2_000, 1_000)).toBeCloseTo(1.3, 6);
    for (let i = 0; i < 50; i += 1) c.observe('t', 'm', 100_000, 1_000);
    expect(c.get('t', 'm')).toBeCloseTo(2.5, 6);
    for (let i = 0; i < 50; i += 1) c.observe('t', 'm', 1, 1_000);
    expect(c.get('t', 'm')).toBeCloseTo(0.5, 6);
    expect(c.get('t', 'other')).toBe(1);
    expect(c.observe('t', 'x', 0, 100)).toBe(1);
  });

  it('S = lastMeasuredPrompt + k·est(messages since then); falls back to k·est(all) after a compaction or prefix change', () => {
    const messages = [{ ord: 1, est: 100 }, { ord: 2, est: 50 }, { ord: 3, est: 20 }];
    const baseline = { measuredPrompt: 1_000, uptoOrd: 2, prefixHash: 'h', compactions: 0 };
    expect(sizeEstimate({ baseline, prefixHash: 'h', compactions: 0, k: 2, prefixTokens: 500, messages })).toEqual({ tokens: 1_040, estimated: true });
    expect(sizeEstimate({ baseline: { ...baseline, uptoOrd: 3 }, prefixHash: 'h', compactions: 0, k: 2, prefixTokens: 500, messages })).toEqual({ tokens: 1_000, estimated: false });
    expect(sizeEstimate({ baseline, prefixHash: 'h', compactions: 1, k: 2, prefixTokens: 500, messages }).tokens).toBe(1_340);
    expect(sizeEstimate({ baseline, prefixHash: 'other', compactions: 0, k: 1, prefixTokens: 500, messages }).tokens).toBe(670);
  });

  it('feeds the compactor the measured size: a big measured prompt fires the token trigger', async () => {
    const b = bench();
    const sizes: number[] = [];
    const trigger = b.compactor.trigger.bind(b.compactor);
    b.compactor.trigger = (input) => {
      sizes.push(input.sizeTokens);
      return trigger(input);
    };
    b.link.gateway.script.push(callsReply([{ id: 'a', name: 'read', args: { path: 'x.ts' } }], { prompt: 100_000 }), text('ok'));
    await runTurn(b, 'go');
    expect(sizes[1]).toBeGreaterThanOrEqual(100_000);
    expect(b.compactor.compacted).toEqual([contextIdOf(THREAD_A)]);
  });
});

describe('batches', () => {
  it('splits into maximal read runs (chunks of 4) and single barriers', () => {
    const p = (index: number, parallel: boolean) => ({ index, parallel });
    expect(planBatches([p(0, true), p(1, true), p(2, false), p(3, true), p(4, true), p(5, true), p(6, true), p(7, true)])).toEqual([[0, 1], [2], [3, 4, 5, 6], [7]]);
    expect(isParallelEligible({ known: true, parsed: true, readOnly: true, toolClass: 'subagent' })).toBe(false);
    expect(isParallelEligible({ known: true, parsed: true, readOnly: true, toolClass: 'user' })).toBe(false);
    expect(isParallelEligible({ known: true, parsed: true, readOnly: true, toolClass: 'mcp' })).toBe(true);
    expect(isParallelEligible({ known: true, parsed: true, readOnly: false, toolClass: 'read' })).toBe(false);
    expect(isParallelEligible({ known: false, parsed: false, readOnly: false, toolClass: null })).toBe(true);
  });

  it('cuts the largest results first, down to one level, within the step cap', () => {
    const out = capStepResults(['a'.repeat(400_000), 'b'.repeat(100_000), 'c'.repeat(4_000)], 40_000);
    const total = out.reduce((s, c) => s + estimateTokens(c), 0);
    expect(total).toBeLessThanOrEqual(40_000);
    expect(out[2]).toBe('c'.repeat(4_000));
    expect(out[0]!.length).toBeLessThan(400_000);
    expect(out[1]!.length).toBeLessThan(100_000);
    expect(capStepResults(['small'], 40_000)).toEqual(['small']);
  });
});

describe('steering queue', () => {
  it('joins queued messages once and ignores empty ones', () => {
    const q = new SteerQueue();
    expect(q.push('t', '   ', 0)).toBe(false);
    q.push('t', 'one', 0);
    q.push('t', ' two ', 1);
    expect(q.pending('t')).toBe(2);
    expect(q.drain('t')).toEqual({ text: joinSteering(['one', 'two']), parts: ['one', 'two'] });
    expect(q.drain('t')).toBeNull();
  });
});

describe('side tasks', () => {
  it('cleans titles and commit messages', () => {
    expect(cleanTitle('"Fix the flaky test."\n')).toBe('Fix the flaky test');
    expect(fallbackTitle('')).toBe('New thread');
    expect(fallbackTitle('x'.repeat(200)).length).toBe(80);
    expect(cleanCommitMessage('```\nFix parser\n\n- handle EOF\n```')).toBe('Fix parser\n\n- handle EOF');
  });

  it('asks for a commit message with purpose commit_message at background priority', async () => {
    const gw = scriptedGatewayClient();
    gw.script.push(text('Fix the parser') as GatewayEvent[]);
    const r = await suggestCommitMessage(gw, { scope: { threadId: 't', turnId: 't:1', runId: 'run_1', step: null }, model: 'deepseek-ai/DeepSeek-V4-Flash', diff: 'diff --git a b', signal: new AbortController().signal });
    expect(r.message).toBe('Fix the parser');
    expect(gw.requests[0]).toMatchObject({ purpose: 'commit_message', priority: 'background', maxOutputTokens: 200 });
  });

  it('capBytes never splits a character', () => {
    expect(capBytes('ééé', 4, '')).toBe('éé');
    expect(capBytes('abc', 10)).toBe('abc');
  });
});
