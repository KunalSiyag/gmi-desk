// H2-A Store: `thread_seq` is contiguous per thread under interleaving (§6.6): several threads and contexts
// appending in random order, inside nested transactions that sometimes roll back, from interleaved async "runs",
// and across a restart. (The global events.seq is not contiguous per thread, which is why thread_seq exists.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteStore } from '@harness/store';
import { contextIdOf, type DurableEventType } from '@harness/types';
import { fakeClock } from '../fakes';
import { openTestStore, prng, projectRow, tempDir, threadRow, type TempDir } from './helpers';

// Thousands of synchronous=FULL commits (fsync each): 6-8 s alone, over 20 s when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const THREADS = ['thr_1', 'thr_2', 'thr_3'];
const TYPES: DurableEventType[] = ['item', 'notice', 'tool.started', 'tool.finished', 'status', 'todo', 'diff'];

let tmp: TempDir;
let store: SqliteStore;

beforeEach(async () => {
  tmp = await tempDir('seq');
  store = (await openTestStore(tmp.dir)).store;
  store.projects.upsert(projectRow());
  for (const t of THREADS) store.threads.insert(threadRow(t));
});
afterEach(async () => {
  store.close();
  await tmp.cleanup();
});

const seqs = (s: SqliteStore, threadId: string) => s.events.list(threadId).map((e) => e.seq);
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function payloadFor(type: DurableEventType, i: number): unknown {
  if (type === 'status') return { type: 'status', status: i % 2 ? 'running' : 'completed', reason: null, queuePosition: null, queueReason: null };
  if (type === 'todo') return { type: 'todo', todo: [{ id: String(i), text: 'x', status: 'pending' }] };
  if (type === 'diff') return { type: 'diff', diff: { files: i, additions: i, deletions: 0 } };
  return { i };
}

describe('thread_seq', () => {
  it('stays contiguous with random interleaving, nested transactions and rollbacks', () => {
    const rand = prng(42);
    const committed = new Map<string, number>(THREADS.map((t) => [t, 0]));
    const append = (threadId: string, i: number) => {
      const type = TYPES[Math.floor(rand() * TYPES.length)] ?? 'notice';
      const contextId = rand() < 0.3 ? `run_child_${threadId}` : contextIdOf(threadId);
      return store.events.append({ threadId, contextId, runId: 'run_1', turn: 1, step: i, type, payload: payloadFor(type, i) });
    };

    for (let i = 0; i < 400; i += 1) {
      const thread = THREADS[Math.floor(rand() * THREADS.length)] ?? 'thr_1';
      const roll = rand();
      if (roll < 0.6) {
        const ev = append(thread, i);
        committed.set(thread, (committed.get(thread) ?? 0) + 1);
        expect(ev.seq).toBe(committed.get(thread));
      } else {
        // A batch over several threads; the inner savepoint or the whole batch may roll back.
        const pending = new Map<string, number>();
        const rollbackOuter = rand() < 0.3;
        try {
          store.transaction(() => {
            for (let k = 0; k < 3; k += 1) {
              const t = THREADS[Math.floor(rand() * THREADS.length)] ?? 'thr_1';
              append(t, i);
              pending.set(t, (pending.get(t) ?? 0) + 1);
            }
            const innerFails = rand() < 0.5;
            const inner = new Map<string, number>();
            try {
              store.transaction(() => {
                for (let k = 0; k < 2; k += 1) {
                  const t = THREADS[Math.floor(rand() * THREADS.length)] ?? 'thr_1';
                  append(t, i);
                  inner.set(t, (inner.get(t) ?? 0) + 1);
                }
                if (innerFails) throw new Error('inner rollback');
              });
              for (const [t, c] of inner) pending.set(t, (pending.get(t) ?? 0) + c);
            } catch {
              // savepoint rolled back; the outer transaction continues
            }
            if (rollbackOuter) throw new Error('outer rollback');
          });
          for (const [t, c] of pending) committed.set(t, (committed.get(t) ?? 0) + c);
        } catch {
          // whole batch rolled back
        }
      }
    }

    for (const t of THREADS) {
      expect(seqs(store, t)).toEqual(range(committed.get(t) ?? 0));
      expect(store.events.lastSeq(t)).toBe(committed.get(t));
    }
    // The global seq interleaves threads, so it is not contiguous per thread.
    const global = store.db.prepare("SELECT seq FROM events WHERE thread_id = 'thr_1' ORDER BY seq").all<{ seq: number }>().map((r) => r.seq);
    expect(global).not.toEqual(range(global.length));
  });

  it('stays contiguous with interleaved async runs (main context + subagent) and continues after a restart', async () => {
    const rand = prng(7);
    const tick = () => (rand() < 0.5 ? Promise.resolve() : new Promise<void>((r) => setImmediate(r)));
    const runLoop = async (threadId: string, contextId: string, steps: number) => {
      for (let i = 0; i < steps; i += 1) {
        await tick();
        store.events.append({ threadId, contextId, runId: `run_${contextId}`, turn: 1, step: i, type: 'item', payload: { i } });
      }
    };
    await Promise.all([
      runLoop('thr_1', contextIdOf('thr_1'), 60),
      runLoop('thr_1', 'run_child_a', 40),
      runLoop('thr_2', contextIdOf('thr_2'), 70),
      runLoop('thr_3', contextIdOf('thr_3'), 30),
      runLoop('thr_3', 'run_child_b', 30),
    ]);
    expect(seqs(store, 'thr_1')).toEqual(range(100));
    expect(seqs(store, 'thr_2')).toEqual(range(70));
    expect(seqs(store, 'thr_3')).toEqual(range(60));
    // Per-context order is preserved within the thread's sequence.
    const childSteps = store.events.list('thr_1').filter((e) => e.contextId === 'run_child_a').map((e) => e.step);
    expect(childSteps).toEqual(Array.from({ length: 40 }, (_, i) => i));

    store.close();
    const reopened = await openTestStore(tmp.dir, fakeClock());
    store = reopened.store;
    const next = store.events.append({ threadId: 'thr_2', contextId: contextIdOf('thr_2'), runId: null, turn: 2, step: null, type: 'turn.started', payload: {} });
    expect(next.seq).toBe(71);
    expect(seqs(store, 'thr_2')).toEqual(range(71));
  });

  it('a duplicate event id is refused without consuming a seq', () => {
    store.events.append({ threadId: 'thr_1', contextId: contextIdOf('thr_1'), runId: null, turn: null, step: null, type: 'notice', payload: 1, eventId: 'ev_same' });
    expect(() => store.events.append({ threadId: 'thr_2', contextId: contextIdOf('thr_2'), runId: null, turn: null, step: null, type: 'notice', payload: 2, eventId: 'ev_same' })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
    expect(store.events.append({ threadId: 'thr_2', contextId: contextIdOf('thr_2'), runId: null, turn: null, step: null, type: 'notice', payload: 3 }).seq).toBe(1);
  });
});
