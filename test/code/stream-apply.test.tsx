import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, TimelineItem } from '@shared/contracts/code';
import { applyTimelineEvent, type TimelineState } from '@renderer/pages/code/stream-apply';

const request: ApprovalRequest = {
  requestId: 'apr_1',
  threadId: 'thr_1',
  runId: 'run_1',
  toolCallId: null,
  kind: 'command',
  tool: 'shell',
  title: 'Run tests',
  detail: {},
  risk: [],
  suggestedRule: null,
  allowedDecisions: ['allow_once', 'deny'],
  createdAt: '2026-11-01T00:00:00.000Z',
  expiresAt: null,
};

type AssistantItem = Extract<TimelineItem, { kind: 'assistant' }>;

const user = (seq: number): TimelineItem => ({ kind: 'user', id: `u${seq}`, seq, turn: 1, text: `m${seq}`, steering: false, at: '2026-11-01T00:00:00.000Z' });
const assistant = (seq: number, text = ''): AssistantItem => ({ kind: 'assistant', id: `a${seq}`, seq, turn: 1, step: 1, text, reasoning: null, model: 'm', usage: null, status: 'streaming', at: '2026-11-01T00:00:00.000Z' });

describe('applyTimelineEvent', () => {
  it('inserts items in seq order and replaces an existing id', () => {
    let state = { items: [user(2)], lastSeq: 2 };
    state = applyTimelineEvent(state, { threadId: 'thr_1', seq: 3, type: 'item', item: assistant(3) });
    state = applyTimelineEvent(state, { threadId: 'thr_1', seq: 1, type: 'item', item: user(1) });
    expect(state.items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(state.lastSeq).toBe(3);
    const updated = { ...assistant(3, 'done'), status: 'complete' as const };
    state = applyTimelineEvent(state, { threadId: 'thr_1', seq: 3, type: 'item', item: updated });
    expect(state.items).toHaveLength(3);
    expect(state.items[2]).toEqual(updated);
  });

  it('appends deltas to assistant text and reasoning only for the addressed item', () => {
    const state = { items: [user(1), assistant(2, 'Hel')], lastSeq: 2 };
    const next = applyTimelineEvent(state, { threadId: 'thr_1', seq: null, type: 'delta', itemId: 'a2', field: 'text', text: 'lo', offset: 3 });
    expect(next.items[1]).toMatchObject({ text: 'Hello' });
    expect(next.items[0]).toEqual(user(1));
    const reasoned = applyTimelineEvent(next, { threadId: 'thr_1', seq: null, type: 'delta', itemId: 'a2', field: 'reasoning', text: 'why', offset: 0 });
    expect(reasoned.items[1]).toMatchObject({ reasoning: 'why' });
  });

  it('appends tool args and output text and ignores unknown items and other event types', () => {
    const tool: TimelineItem = {
      kind: 'tool',
      id: 't1',
      seq: 3,
      turn: 1,
      step: 1,
      toolCallId: 'c1',
      tool: 'shell',
      title: 'Run',
      argsPreview: '{"cmd":',
      status: 'running',
      output: { text: 'a', truncated: false, totalBytes: 1, spillId: null },
      durationMs: null,
      at: '2026-11-01T00:00:00.000Z',
    };
    let state: TimelineState = { items: [tool], lastSeq: 3 };
    state = applyTimelineEvent(state, { threadId: 'thr_1', seq: null, type: 'delta', itemId: 't1', field: 'args', text: '"x"}', offset: 7 });
    state = applyTimelineEvent(state, { threadId: 'thr_1', seq: null, type: 'delta', itemId: 't1', field: 'output', text: 'b', offset: 1 });
    expect(state.items[0]).toMatchObject({ argsPreview: '{"cmd":"x"}', output: { text: 'ab', totalBytes: 2 } });
    const delta = { threadId: 'thr_1', seq: null, type: 'delta', itemId: 'missing', field: 'text', text: 'x', offset: 0 } as const;
    expect(applyTimelineEvent(state, delta)).toBe(state);
    const approval: TimelineItem = { kind: 'approval', id: 'p1', seq: 4, request, decision: null };
    const withApproval = applyTimelineEvent(state, { threadId: 'thr_1', seq: 4, type: 'item', item: approval });
    expect(withApproval.items).toHaveLength(2);
  });
});
