// H2-C: layer-1 compaction (§7.4), the pinned current request, precompute swaps, layer 2 (§7.5), failures, the
// range ledger (§7.3) and the file ledger. Memory store + scripted gateway (no network).
import { describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import type { GwMessage } from '@shared/contracts/gateway';
import { computeCeiling, compactedContext, defaultToWire, fileLedger, latestCompaction } from '@harness/loop/compaction';
import { FILE_LEDGER_HEADING, SUMMARY_HEADER, SUMMARY_SYSTEM } from '@harness/loop/summary-prompt';
import { textReply } from '../fakes';
import { CTX, DEFAULT_CEILING, errorReply, FLASH, MODEL_SUMMARY, pairedAndOrdered, PREFIX_TOKENS, setup, T, THREAD_MODEL } from './helpers';

const C = DEFAULT_CEILING.ceilingTokens; // 119,616

function viewTokens(rows: ReturnType<typeof compactedContext>['rows']): number {
  return rows.reduce((a, m) => a + (m.estTokens ?? 0), 0);
}

describe('layer 1: threshold summary', () => {
  it('summarises up to an anchor that keeps ≥ keep tokens, marks the rest out of context and lands ≤ 0.5·C', async () => {
    const s = setup();
    s.h.user('Fix the failing parser test.', 1, { tokens: 500 });
    s.h.steps(1, 60); // 120k tokens
    const r = await s.compactor.compact(s.req());
    expect(r).toMatchObject({ layer: 1, usedPrecomputed: false, model: FLASH, costUsd: 0.0001 });
    const view = compactedContext(s.store, CTX);
    const tail = view.history;
    expect(viewTokens(tail)).toBeGreaterThanOrEqual(DEFAULT_CEILING.keepTokens);
    // The last boundary that keeps ≥ keep: dropping one more step would keep < 20k.
    expect(viewTokens(tail) - 2_000).toBeLessThan(DEFAULT_CEILING.keepTokens);
    expect(r.afterTokens).toBeLessThanOrEqual(0.5 * C);
    expect(r.beforeTokens).toBeGreaterThan(120_000);
    // Hysteresis: right after a compaction no trigger fires and no precompute starts.
    expect(s.compactor.trigger({ ceiling: DEFAULT_CEILING, sizeTokens: r.afterTokens, messageCount: view.rows.length, nextStepCachedUsd: 0.001, perTurnUsd: 1 })).toBeNull();
    expect(s.compactor.shouldPrecompute({ ceiling: DEFAULT_CEILING, sizeTokens: r.afterTokens, messageCount: view.rows.length, nextStepCachedUsd: 0.001, perTurnUsd: 1 })).toBe(false);
    // Content is never edited (invariant 3); rows are only marked.
    const all = s.store.messages.list(CTX);
    expect(all.filter((m) => !m.inContext).every((m) => m.ord <= r.uptoOrd)).toBe(true);
    expect(all.find((m) => m.ord === 1)?.content).toBe('Fix the failing parser test.');
    // The summary is stored and becomes the [summary] message.
    const row = latestCompaction(s.store, CTX);
    expect(row).toMatchObject({ id: r.compactionId, uptoOrd: r.uptoOrd, model: FLASH, beforeTokens: r.beforeTokens, afterTokens: r.afterTokens });
    expect(view.summary).toEqual({ role: 'user', content: `${SUMMARY_HEADER}\n\n${row?.summary}` });
    expect(row?.summary.startsWith(MODEL_SUMMARY)).toBe(true);
  });

  it('runs at foreground priority on the compaction model, scoped to the run, with no tools', async () => {
    const s = setup();
    s.h.user('Do the thing.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    await s.compactor.compact(s.req());
    expect(s.gateway.requests).toHaveLength(1);
    const req = s.gateway.requests[0];
    expect(req).toMatchObject({ purpose: 'compaction', priority: 'foreground', target: { model: FLASH }, scope: { threadId: T, turnId: `${T}:1`, runId: 'run_1', step: null }, maxOutputTokens: 8_192, prefixHash: null });
    expect(req?.tools).toBeUndefined();
    expect(req?.messages[0]).toEqual({ role: 'system', content: SUMMARY_SYSTEM });
    expect(req?.messages).toHaveLength(2);
  });

  it('the anchor never falls between a tool call and its result (parallel calls, any keep size)', async () => {
    for (const keep of [1_000, 3_333, 7_777, 20_000]) {
      const ceiling = { ...DEFAULT_CEILING, keepTokens: keep };
      const s = setup({ ceiling });
      s.h.user('Refactor.', 1, { tokens: 50 });
      for (let i = 0; i < 30; i++) s.h.step(1, { calls: (i % 4) + 1, tokens: 1_000 + 97 * i });
      s.h.text(1, 'Looking at the results.', 300);
      for (let i = 0; i < 10; i++) s.h.step(1, { calls: 3, tokens: 1_500 });
      const r = await s.compactor.compact(s.req());
      const view = compactedContext(s.store, CTX);
      expect(pairedAndOrdered(view.history)).toBe(true);
      expect(['user', 'assistant']).toContain(view.history[0]?.role);
      // The summarised region is closed too: every call before the anchor has its result before the anchor.
      const region = s.store.messages.list(CTX).filter((m) => m.ord <= r.uptoOrd && !m.pinned && m.ord > 1);
      expect(pairedAndOrdered(region)).toBe(true);
    }
  });

  it('nothing to summarise → context_overflow', async () => {
    const s = setup();
    await expect(s.compactor.compact(s.req())).rejects.toMatchObject({ code: 'context_overflow' });
  });

  it('the message-count trigger leaves at most 750 messages (far from main 2,048 cap)', async () => {
    const s = setup();
    s.h.user('Many small steps.', 1, { tokens: 20 });
    for (let i = 0; i < 800; i++) s.h.step(1, { tokens: 20 });
    expect(compactedContext(s.store, CTX).rows.length).toBe(1_601);
    await s.compactor.compact(s.req({ reason: 'messages' }));
    expect(compactedContext(s.store, CTX).rows.length).toBeLessThanOrEqual(750);
  });

  it('a second compaction updates the previous summary (passed in, without its file ledger)', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.step(1, { tool: 'edit', args: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } });
    s.h.steps(1, 60);
    await s.compactor.compact(s.req());
    expect(latestCompaction(s.store, CTX)?.summary).toContain(FILE_LEDGER_HEADING);
    s.h.steps(1, 50);
    const r2 = await s.compactor.compact(s.req());
    const text = String(s.gateway.requests[1]?.messages[1]?.content);
    expect(text).toContain('<previous_summary>');
    expect(text).toContain('Located the bug in src/parser.ts.');
    expect(text.split('<previous_summary>')[1]?.split('</previous_summary>')[0]).not.toContain(FILE_LEDGER_HEADING);
    expect(text).toContain('newer history takes precedence');
    expect(latestCompaction(s.store, CTX)?.id).toBe(r2.compactionId);
    expect(s.store.compactions.list(CTX)).toHaveLength(2);
  });

  it('stores only a public timeline item whose seq is its own thread_seq (no seq gap)', async () => {
    const s = setup();
    s.store.events.append({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, step: 0, type: 'status', payload: {} });
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    const r = await s.compactor.compact(s.req());
    const events = s.store.events.list(T);
    // Review H2: no internal `compaction` event (it took a thread_seq the renderer never saw).
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.type)).toEqual(['status', 'item']);
    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0]).toMatchObject({ type: 'item', seq: 2, payload: { type: 'item', item: { kind: 'compaction', id: r.compactionId, seq: 2, beforeTokens: r.beforeTokens, afterTokens: r.afterTokens, model: FLASH, costUsd: 0.0001 } } });
    expect(s.log.lines.some((l) => l.message === 'compaction' && l.meta?.before === r.beforeTokens && l.meta?.after === r.afterTokens)).toBe(true);
  });

  it('a subagent context compacts without a timeline item', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    // Move every row to a child context id by re-appending (the memory store keeps contexts apart).
    for (const m of s.store.messages.list(CTX)) s.store.messages.append({ ...m, id: `${m.id}c`, contextId: 'run_child' });
    await s.compactor.compact(s.req({ contextId: 'run_child' }));
    expect(s.emitted).toHaveLength(0);
    expect(s.store.compactions.list('run_child')).toHaveLength(1);
    expect(compactedContext(s.store, CTX).rows.length).toBe(121);
  });

  it('without contextInfo it uses the thread settings (160k, unknown window → 128k)', async () => {
    const s = setup({ noInfo: true });
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    const r = await s.compactor.compact(s.req());
    const ceiling = computeCeiling({ modelContextTokens: null, maxContextTokens: 160_000, maxOutputTokens: 16_384, economy: false, tierBoundaryTokens: null, prefixTokens: 0 });
    expect(r.afterTokens).toBeLessThanOrEqual(0.5 * ceiling.ceilingTokens);
  });
});

describe('the pinned current request (§7.4, RL-23)', () => {
  it('stays byte-identical through repeated compactions inside a 50-step turn', async () => {
    const request = 'Rename `parseLine` to `parseRow` everywhere.\n\nKeep the exports — and the ü/中文 comments — intact.';
    const steering = 'Also update the README.';
    const s = setup({ ceiling: { ...DEFAULT_CEILING, ceilingTokens: 40_000, keepTokens: 10_000 } });
    s.h.user('An earlier turn.', 0, { tokens: 50 });
    s.h.text(0, 'Done.', 10);
    const original = s.h.user(request, 1);
    s.h.steps(1, 10);
    const steer = s.h.user(steering, 1, { steering: true });
    let compactions = 0;
    for (let step = 0; step < 50; step++) {
      s.h.step(1, { tokens: 1_800 });
      const size = PREFIX_TOKENS + viewTokens(compactedContext(s.store, CTX).rows);
      if (size < 40_000) continue;
      await s.compactor.compact(s.req());
      compactions += 1;
      const view = compactedContext(s.store, CTX);
      // Exactly the request and its steering message, verbatim, right after the summary.
      expect(view.pinned.map((m) => m.content)).toEqual([request, steering]);
      expect(view.rows.slice(0, 2).map((m) => m.content)).toEqual([request, steering]);
      expect(view.pinned.map((m) => m.turn)).toEqual([1, 1]);
      expect(view.pinned[1]?.steering).toBe(true);
      expect(view.history.some((m) => m.id === original.id || m.id === steer.id)).toBe(false);
      expect(pairedAndOrdered(view.history)).toBe(true);
    }
    expect(compactions).toBeGreaterThanOrEqual(3);
    // The summariser was told the request is pinned and saw it labelled.
    const last = String(s.gateway.requests.at(-1)?.messages[1]?.content);
    expect(last).toContain('shown verbatim after your summary');
    expect(last).toContain('current request, kept verbatim after the summary');
  });

  it('is not pinned while the request is still in the kept tail', async () => {
    const s = setup();
    s.h.user('Old turn.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    s.h.user('New request.', 2, { tokens: 100 });
    s.h.steps(2, 3);
    await s.compactor.compact(s.req({ turn: 2 }));
    const view = compactedContext(s.store, CTX);
    expect(view.pinned).toHaveLength(0);
    expect(view.history.some((m) => m.content === 'New request.')).toBe(true);
  });

  it("an earlier turn's pinned block leaves the view at the next turn's compaction (even if the store keeps pinned rows in context)", async () => {
    const s = setup({ ceiling: { ...DEFAULT_CEILING, keepTokens: 10_000 } });
    s.h.user('Turn one request.', 1, { tokens: 100 });
    s.h.steps(1, 40);
    await s.compactor.compact(s.req({ turn: 1 }));
    expect(compactedContext(s.store, CTX).pinned.map((m) => m.content)).toEqual(['Turn one request.']);
    s.h.user('Turn two request.', 2, { tokens: 100 });
    s.h.steps(2, 40);
    await s.compactor.compact(s.req({ turn: 2 }));
    const view = compactedContext(s.store, CTX);
    expect(view.pinned.map((m) => m.content)).toEqual(['Turn two request.']);
    // The memory store never clears in_context on pinned rows; the view excludes them by the anchor anyway.
    const oldPin = s.store.messages.list(CTX).find((m) => m.pinned && m.turn === 1);
    expect(oldPin?.inContext).toBe(true);
    expect(view.rows.some((m) => m.id === oldPin?.id)).toBe(false);
  });

  it('a request longer than 8k tokens is pinned truncated, with a pointer to the full text', async () => {
    const s = setup();
    const huge = 'x'.repeat(60_000); // 15k tokens
    const original = s.h.user(huge, 1);
    s.h.steps(1, 60);
    await s.compactor.compact(s.req());
    const pin = compactedContext(s.store, CTX).pinned[0];
    expect(pin?.content.startsWith('x'.repeat(30_000))).toBe(true);
    expect(pin?.content).toContain(`the full text is message ${original.id}`);
    expect(pin?.estTokens).toBeLessThanOrEqual(8_192 + 4);
  });
});

describe('same-model summaries reuse the thread prefix (cache hit)', () => {
  const prefix = {
    messages: [
      { role: 'system', content: 'SYSTEM v1' },
      { role: 'user', content: '<project-instructions>…</project-instructions>' },
    ] satisfies GwMessage[],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    prefixHash: 'abc123',
  };

  it('sends the thread bytes up to the anchor, then the instruction; tools with toolChoice none', async () => {
    const s = setup({ prefix });
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    const before = compactedContext(s.store, CTX);
    const r = await s.compactor.compact(s.req({ compactionModel: THREAD_MODEL }));
    const req = s.gateway.requests[0];
    expect(req).toMatchObject({ target: { model: THREAD_MODEL }, toolChoice: 'none', prefixHash: 'abc123', tools: prefix.tools });
    const threadBytes = [...prefix.messages, ...defaultToWire(before.rows.filter((m) => m.ord <= r.uptoOrd))];
    expect(req?.messages.slice(0, threadBytes.length)).toEqual(threadBytes);
    expect(req?.messages).toHaveLength(threadBytes.length + 1);
    expect(req?.messages.at(-1)).toMatchObject({ role: 'user' });
    expect(String(req?.messages.at(-1)?.content)).toContain('conversation above');
  });

  it('a different compaction model gets a transcript instead', async () => {
    const s = setup({ prefix });
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    await s.compactor.compact(s.req());
    expect(s.gateway.requests[0]?.messages[0]).toEqual({ role: 'system', content: SUMMARY_SYSTEM });
    expect(s.gateway.requests[0]?.tools).toBeUndefined();
  });
});

describe('precompute (§7.4)', () => {
  it('runs at idle priority and is swapped in when the tail since its anchor is short', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 52); // ≈ 104k: past 85 % of C
    s.compactor.precompute({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH });
    s.compactor.precompute({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH }); // at most one per context
    await s.compactor.idle();
    expect(s.gateway.requests.map((r) => r.priority)).toEqual(['idle']);
    s.h.steps(1, 4); // +8k: the tail since the anchor is ≈ 28k ≤ min(max(2·keep, 30k), 0.25·C = 29,904)
    const r = await s.compactor.compact(s.req());
    expect(r).toMatchObject({ usedPrecomputed: true, layer: 1, costUsd: 0.0001 });
    expect(s.gateway.requests).toHaveLength(1);
    expect(compactedContext(s.store, CTX).history.length).toBeGreaterThan(0);
    // Used once: the next compaction summarises again.
    s.h.steps(1, 60);
    expect((await s.compactor.compact(s.req())).usedPrecomputed).toBe(false);
  });

  it('a finished precompute that is still swappable is not recomputed every step', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 52);
    const pre = { threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH };
    s.compactor.precompute(pre);
    await s.compactor.idle();
    s.h.steps(1, 2);
    s.compactor.precompute(pre);
    await s.compactor.idle();
    expect(s.gateway.requests).toHaveLength(1);
    s.h.steps(1, 30); // the tail is now too long to swap → a new precompute supersedes it
    s.compactor.precompute(pre);
    await s.compactor.idle();
    expect(s.gateway.requests).toHaveLength(2);
  });

  it('not swapped when the tail since its anchor exceeds max(2·keep, 30k) or 25 % of C', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 52);
    s.compactor.precompute({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH });
    await s.compactor.idle();
    s.h.steps(1, 6); // tail ≈ 20k + 12k = 32k > 0.25·C = 29,904
    const r = await s.compactor.compact(s.req());
    expect(r.usedPrecomputed).toBe(false);
    expect(s.gateway.requests.map((q) => q.priority)).toEqual(['idle', 'foreground']);
  });

  it('not swapped for another compaction model, or in a later turn when it summarised a pinned request', async () => {
    const s = setup({ ceiling: { ...DEFAULT_CEILING, keepTokens: 4_000 } });
    s.h.user('Turn one.', 1, { tokens: 100 });
    s.h.steps(1, 52);
    s.compactor.precompute({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH });
    await s.compactor.idle();
    expect((await s.compactor.compact(s.req({ compactionModel: 'other/model' }))).usedPrecomputed).toBe(false);

    const s2 = setup({ ceiling: { ...DEFAULT_CEILING, keepTokens: 4_000 } });
    s2.h.user('Turn one.', 1, { tokens: 100 });
    s2.h.steps(1, 52);
    s2.compactor.precompute({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH });
    await s2.compactor.idle();
    s2.h.user('Turn two.', 2, { tokens: 100 });
    expect((await s2.compactor.compact(s2.req({ turn: 2 }))).usedPrecomputed).toBe(false);
  });

  it('cancel() aborts an in-flight precompute; compact() supersedes one', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 52);
    s.compactor.precompute({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH });
    s.compactor.cancel(CTX);
    await s.compactor.idle();
    expect(s.gateway.cancelled).toHaveLength(1);
    s.compactor.precompute({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, model: THREAD_MODEL, compactionModel: FLASH });
    const r = await s.compactor.compact(s.req());
    expect(r.usedPrecomputed).toBe(false);
    expect(s.gateway.cancelled).toHaveLength(2);
  });
});

describe('layer 2: provider overflow (§7.5)', () => {
  it('each shrink level lands at or below its target (85/70/50/35 % of the rejected size)', async () => {
    for (const f of [0.85, 0.7, 0.5, 0.35]) {
      const s = setup();
      s.h.user('Task.', 1, { tokens: 100 });
      s.h.steps(1, 50); // 100k + prefix
      const rejected = PREFIX_TOKENS + 100_100;
      const target = Math.floor(rejected * f);
      const r = await s.compactor.compact(s.req({ reason: 'overflow', shrinkToTokens: target }));
      expect(r.layer).toBe(2);
      expect(r.afterTokens).toBeLessThanOrEqual(target);
      expect(s.gateway.requests[0]?.maxOutputTokens).toBeLessThanOrEqual(8_192);
      expect(pairedAndOrdered(compactedContext(s.store, CTX).history)).toBe(true);
    }
  });

  it('keeps fewer tail messages when the target is tight, down to the pinned request', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 50);
    const r = await s.compactor.compact(s.req({ reason: 'overflow', shrinkToTokens: PREFIX_TOKENS + 6_000 }));
    expect(r.afterTokens).toBeLessThanOrEqual(PREFIX_TOKENS + 6_000);
    expect(s.gateway.requests[0]?.maxOutputTokens).toBeLessThan(8_192);
    expect(compactedContext(s.store, CTX).history).toHaveLength(0);
    expect(compactedContext(s.store, CTX).pinned.map((m) => m.content)).toEqual(['Task.']);
  });

  it("main's size refusals (more than 2,048 messages) take the same path and end far below the cap", async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 10 });
    for (let i = 0; i < 1_100; i++) s.h.step(1, { tokens: 10 });
    const size = PREFIX_TOKENS + 11_010;
    const r = await s.compactor.compact(s.req({ reason: 'overflow', shrinkToTokens: Math.floor(size * 0.85) }));
    expect(r.layer).toBe(2);
    expect(compactedContext(s.store, CTX).rows.length).toBeLessThanOrEqual(750);
  });

  it('never reuses the overflowed prefix; the retry after an overflow drops old tool outputs', async () => {
    const s = setup({ prefix: { messages: [{ role: 'system', content: 'S' }], tools: [], prefixHash: 'h' } });
    s.h.user('Task.', 1, { tokens: 100 });
    for (let i = 0; i < 50; i++) s.h.step(1, { output: 'y'.repeat(3_000) });
    s.gateway.script.push(errorReply('context_overflow'));
    const r = await s.compactor.compact(s.req({ compactionModel: THREAD_MODEL, reason: 'overflow', shrinkToTokens: 60_000 }));
    expect(r.layer).toBe(2);
    expect(s.gateway.requests).toHaveLength(2);
    for (const q of s.gateway.requests) expect(q.messages[0]).toEqual({ role: 'system', content: SUMMARY_SYSTEM });
    expect(String(s.gateway.requests[0]?.messages[1]?.content)).toContain('y'.repeat(3_000));
    expect(String(s.gateway.requests[1]?.messages[1]?.content)).not.toContain('y'.repeat(3_000));
    expect(String(s.gateway.requests[1]?.messages[1]?.content)).toContain('output dropped');
  });

  it('nothing fits (the prefix alone is above the target) → context_overflow, nothing changed', async () => {
    const s = setup({ prefixTokens: 40_000 });
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 50);
    await expect(s.compactor.compact(s.req({ reason: 'overflow', shrinkToTokens: 35_000 }))).rejects.toMatchObject({ code: 'context_overflow' });
    expect(s.gateway.requests).toHaveLength(0);
    expect(s.store.compactions.list(CTX)).toHaveLength(0);
    expect(s.store.messages.list(CTX, { inContextOnly: true })).toHaveLength(101);
  });
});

describe('failures', () => {
  it('two failed summaries → a summary built from the log (layer 2); the run continues', async () => {
    const s = setup();
    s.h.user('Please fix the tokenizer bug.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    s.gateway.script.push(errorReply('upstream'), errorReply('upstream'));
    const r = await s.compactor.compact(s.req());
    expect(r.layer).toBe(2);
    expect(s.gateway.requests).toHaveLength(2);
    const summary = latestCompaction(s.store, CTX)?.summary ?? '';
    expect(summary).toContain('Please fix the tokenizer bug.');
    expect(summary).toContain(FILE_LEDGER_HEADING);
    expect(s.log.lines.filter((l) => l.message === 'compaction summary failed')).toHaveLength(2);
  });

  it('an empty summary counts as a failure; the second attempt does not reuse the prefix', async () => {
    const s = setup({ prefix: { messages: [{ role: 'system', content: 'S' }], tools: [{ name: 'read', description: 'r', parameters: {} }], prefixHash: 'h' } });
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    s.gateway.script.push(textReply('   '));
    const r = await s.compactor.compact(s.req({ compactionModel: THREAD_MODEL }));
    expect(r.layer).toBe(1);
    expect(s.gateway.requests[0]?.toolChoice).toBe('none');
    expect(s.gateway.requests[1]?.tools).toBeUndefined();
  });

  it('money stops are not retried and change nothing', async () => {
    for (const code of ['budget_exceeded', 'limit_reached']) {
      const s = setup();
      s.h.user('Task.', 1, { tokens: 100 });
      s.h.steps(1, 60);
      s.gateway.script.push(errorReply(code));
      await expect(s.compactor.compact(s.req())).rejects.toMatchObject({ code });
      expect(s.gateway.requests).toHaveLength(1);
      expect(s.store.compactions.list(CTX)).toHaveLength(0);
      expect(s.store.messages.list(CTX, { inContextOnly: true })).toHaveLength(121);
    }
  });

  it('cancellation rejects with cancelled and changes nothing', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    const ac = new AbortController();
    const p = s.compactor.compact(s.req({ signal: ac.signal }));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(GmiError);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(s.store.compactions.list(CTX)).toHaveLength(0);
    const pre = new AbortController();
    pre.abort();
    await expect(s.compactor.compact(s.req({ signal: pre.signal }))).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('one compaction at a time per context', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    const first = s.compactor.compact(s.req());
    await expect(s.compactor.compact(s.req())).rejects.toMatchObject({ code: 'conflict' });
    await first;
  });
});

describe('range ledger (§7.3) and file ledger (§7.4)', () => {
  it('pruneReads drops the read rows whose lines left the context', () => {
    const s = setup();
    const put = (path: string, ord: number | null) => s.store.reads.put({ contextId: CTX, path, sha: 'sha', ranges: [[1, 100]], size: 10, mtimeMs: 1, ord });
    put('a.ts', 3);
    put('b.ts', 10);
    put('c.ts', 11);
    put('d.ts', null);
    s.store.reads.put({ contextId: 'other', path: 'a.ts', sha: 'sha', ranges: [[1, 2]], size: 1, mtimeMs: 1, ord: 1 });
    s.compactor.pruneReads(CTX, 10);
    expect(s.store.reads.list(CTX).map((r) => r.path)).toEqual(['c.ts']);
    expect(s.store.reads.list('other')).toHaveLength(1);
  });

  it('compact() prunes the ledger at its anchor', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.steps(1, 60);
    s.store.reads.put({ contextId: CTX, path: 'early.ts', sha: 's', ranges: [[1, 50]], size: 1, mtimeMs: 1, ord: 5 });
    s.store.reads.put({ contextId: CTX, path: 'late.ts', sha: 's', ranges: [[1, 50]], size: 1, mtimeMs: 1, ord: 115 });
    const r = await s.compactor.compact(s.req());
    expect(r.uptoOrd).toBeGreaterThan(5);
    expect(r.uptoOrd).toBeLessThan(115);
    expect(s.store.reads.list(CTX).map((x) => x.path)).toEqual(['late.ts']);
  });

  it('the file ledger comes from succeeded tool calls and tool.finished effects, not from the model', async () => {
    const s = setup();
    s.h.user('Task.', 1, { tokens: 100 });
    s.h.step(1, { tool: 'read', args: { path: 'src/read.ts' } });
    s.h.step(1, { tool: 'read', args: { path: 'src/both.ts' } });
    s.h.step(1, { tool: 'edit', args: { path: 'src/both.ts', old_string: 'a', new_string: 'b' } });
    s.h.step(1, { tool: 'write', args: { path: 'src/failed.ts', content: 'x' }, status: 'failed' });
    s.h.step(1, { tool: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: src/patched.ts\n@@\n-a\n+b\n*** End Patch' } });
    s.h.step(1, { tool: 'apply_patch', args: { patch: '--- a/src/unified.ts\n+++ b/src/unified.ts\n@@ -1 +1 @@\n-a\n+b\n' } });
    s.h.step(1, { tool: 'read', args: { path: 'spill:tc_123' } });
    s.h.step(1, { tool: 'bash', args: { command: 'npm run fmt' } });
    s.store.events.append({ threadId: T, contextId: CTX, runId: 'run_1', turn: 1, step: 8, type: 'tool.finished', payload: { tool: 'bash', effects: { changedPaths: ['src/formatted.ts'], readPaths: [] } } });
    s.store.events.append({ threadId: T, contextId: 'run_child', runId: 'run_1', turn: 1, step: 8, type: 'tool.finished', payload: { effects: { changedPaths: ['src/child.ts'] } } });
    const ledger = fileLedger(s.store, T, CTX);
    expect(ledger.modified.sort()).toEqual(['src/both.ts', 'src/formatted.ts', 'src/patched.ts', 'src/unified.ts']);
    expect(ledger.read).toEqual(['src/read.ts']);
    for (let i = 0; i < 60; i++) s.h.step(1, { tool: 'grep', args: { pattern: 'x' } });
    await s.compactor.compact(s.req());
    const summary = latestCompaction(s.store, CTX)?.summary ?? '';
    const ledgerText = summary.split(FILE_LEDGER_HEADING)[1] ?? '';
    expect(ledgerText).toContain('src/patched.ts');
    expect(ledgerText).toContain('src/read.ts');
    expect(ledgerText.split('- Read:')[1]).not.toContain('src/both.ts');
    expect(ledgerText).not.toContain('src/failed.ts');
    expect(ledgerText).not.toContain('spill:');
  });
});
