// H2-A Store: projections. The incremental projection (maintained by events.append in the same transaction) equals
// the projection rebuilt from the log; the live timeline fold equals the paged getTimeline; and the host's views
// equal what main's view-only fallback (readonly-db.ts) reads from the same file while the store is open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeThreadSummary, TimelineItem } from '@shared/contracts/code';
import { openReadOnlyHarnessDb } from '@main/services/harness/readonly-db';
import { foldTimeline, TimelineFold, type SqliteStore } from '@harness/store';
import { contextIdOf, type AppendEventInput, type StoredEvent } from '@harness/types';
import { fakeClock, type FakeClock } from '../fakes';
import { openTestStore, prng, projectRow, tempDir, threadRow, toolItem, userItem, type TempDir } from './helpers';

// Thousands of synchronous=FULL commits (fsync each): 6-8 s alone, over 20 s when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const THREADS = ['thr_1', 'thr_2'];

let tmp: TempDir;
let store: SqliteStore;
let clock: FakeClock;

beforeEach(async () => {
  tmp = await tempDir('proj');
  clock = fakeClock();
  store = (await openTestStore(tmp.dir, clock)).store;
  store.projects.upsert(projectRow());
  for (const t of THREADS) store.threads.insert(threadRow(t));
});
afterEach(async () => {
  store.close();
  await tmp.cleanup();
});

/** A random but valid durable event stream: items (with later versions of earlier items), status, todo, diff, internal. */
function randomEvents(seed: number, count: number): AppendEventInput[] {
  const rand = prng(seed);
  const out: AppendEventInput[] = [];
  const statuses = ['running', 'awaiting_approval', 'running', 'completed', 'stopped', 'interrupted'] as const;
  const items = new Map<string, string[]>(THREADS.map((t) => [t, []]));
  for (let i = 0; i < count; i += 1) {
    const threadId = THREADS[Math.floor(rand() * THREADS.length)] ?? 'thr_1';
    const child = rand() < 0.2;
    const contextId = child ? `run_child_${threadId}` : contextIdOf(threadId);
    const base = { threadId, contextId, runId: 'run_1', turn: 1, step: i };
    const r = rand();
    const known = items.get(threadId) ?? [];
    if (r < 0.45) {
      // A new item, or a later version of an earlier one.
      if (known.length > 0 && rand() < 0.4) {
        const id = known[Math.floor(rand() * known.length)] ?? 'x';
        out.push({ ...base, type: 'item', payload: { type: 'item', item: toolItem(id, rand() < 0.5 ? 'succeeded' : 'failed') } });
      } else {
        const id = `itm_${threadId}_${i}`;
        known.push(id);
        out.push({ ...base, type: 'item', payload: { type: 'item', item: rand() < 0.5 ? toolItem(id, 'running') : userItem(id, 1, `text ${i}`) } });
      }
    } else if (r < 0.6) {
      const status = statuses[Math.floor(rand() * statuses.length)] ?? 'running';
      out.push({ ...base, contextId: contextIdOf(threadId), type: 'status', payload: { type: 'status', status, reason: status === 'stopped' ? 'step_cap' : null, queuePosition: null, queueReason: null } });
    } else if (r < 0.72) {
      out.push({ ...base, type: 'todo', payload: { type: 'todo', todo: [{ id: `t${i}`, text: `todo ${i}`, status: rand() < 0.5 ? 'pending' : 'done' }] } });
    } else if (r < 0.8) {
      out.push({ ...base, type: 'diff', payload: { type: 'diff', diff: { files: i % 5, additions: i, deletions: i % 3 } } });
    } else if (r < 0.85) {
      // An invalid item payload: skipped by every timeline reader alike.
      out.push({ ...base, type: 'item', payload: { type: 'item', item: { kind: 'bogus', id: `bad_${i}` } } });
    } else {
      out.push({ ...base, type: rand() < 0.5 ? 'tool.started' : 'notice', payload: { i } });
    }
  }
  return out;
}

function projected(s: SqliteStore) {
  return THREADS.map((t) => ({
    summary: s.projections.summary(t),
    thread: s.threads.get(t),
    todos: [contextIdOf(t), `run_child_${t}`].map((c) => s.todos.get(c)),
    timeline: s.projections.timeline(t, { limit: 1_000 }),
  }));
}

describe('incremental projection = rebuilt projection', () => {
  it.each([1, 2, 3])('random event stream (seed %i)', (seed) => {
    const live = new Map<string, TimelineFold>(THREADS.map((t) => [t, new TimelineFold()]));
    for (const input of randomEvents(seed, 300)) {
      const ev = store.events.append(input);
      live.get(ev.threadId)?.apply(ev);
    }
    const incremental = projected(store);

    // Wipe the projected state, rebuild it from the log alone.
    store.db.exec("UPDATE threads SET status = 'idle', status_reason = NULL; DELETE FROM todos;");
    expect(store.threads.get('thr_1')?.status).toBe('idle');
    expect(store.projections.rebuild()).toBe(THREADS.length);
    const rebuilt = projected(store);
    expect(rebuilt).toEqual(incremental);

    // Rebuilding again changes nothing (idempotent); a per-thread rebuild agrees too.
    store.projections.rebuild('thr_2');
    expect(projected(store)).toEqual(incremental);

    for (const t of THREADS) {
      const all = store.events.list(t);
      const lastStatus = [...all].reverse().find((e) => e.type === 'status')?.payload as { status: string; reason: string | null } | undefined;
      if (lastStatus) expect(store.threads.get(t)).toMatchObject({ status: lastStatus.status, statusReason: lastStatus.reason });
      // The live fold (renderer-style, event by event) = the fold of the whole log = the getTimeline page.
      const fold = live.get(t);
      expect(fold?.items()).toEqual(foldTimeline(all));
      expect(fold?.items()).toEqual(store.projections.timeline(t, { limit: 1_000 }).items);
      expect(fold?.lastSeq()).toBe(store.events.lastSeq(t));
    }
  });

  it('a later item version replaces the earlier one and takes its seq; invalid items are skipped', () => {
    const add = (payload: unknown) => store.events.append({ threadId: 'thr_1', contextId: contextIdOf('thr_1'), runId: 'run_1', turn: 1, step: 1, type: 'item', payload });
    add({ type: 'item', item: userItem('u1', 1, 'hello') });
    add({ type: 'item', item: toolItem('t1', 'running') });
    add({ type: 'item', item: { kind: 'nope' } });
    add({ type: 'item', item: toolItem('t1', 'succeeded') });
    const page = store.projections.timeline('thr_1');
    expect(page.items.map((i: TimelineItem) => [i.id, i.seq, i.kind === 'tool' ? i.status : null])).toEqual([
      ['u1', 1, null],
      ['t1', 4, 'succeeded'],
    ]);
    expect(page).toMatchObject({ hasMore: false, lastSeq: 4 });
  });
});

describe('the host views equal main’s view-only fallback on the same file', () => {
  it('listThreads, getThread and every getTimeline page agree while the store is open', async () => {
    let i = 0;
    for (const input of randomEvents(9, 250)) {
      store.events.append(input);
      clock.advance(1_000);
      if (++i % 50 === 0) store.threads.update(input.threadId, { title: `Title ${i}`, costUsd: i / 1000, tokens: { input: i, cached: i / 2, output: 3, reasoning: 1 } });
    }
    store.checkpoints.insert({ id: 'ckpt_1', threadId: 'thr_1', turn: 1, commitSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), filesChanged: 4, createdAt: '2026-11-02T10:00:00.000Z' });
    store.compactions.insert({ id: 'cmp_1', threadId: 'thr_1', contextId: contextIdOf('thr_1'), uptoOrd: 0, summary: 's', model: 'm', beforeTokens: 9, afterTokens: 1, costUsd: null, createdAt: '2026-11-02T10:00:00.000Z' });
    store.threads.insert(threadRow('thr_3', 'prj_1', { archived: true, updatedAt: '2026-11-01T00:00:00.000Z' }));

    const ro = await openReadOnlyHarnessDb(store.file);
    try {
      const noDiff = (list: CodeThreadSummary[]) => list.map((t) => ({ ...t, diff: null }));
      // The fallback has no diff stat (it shows none); everything else is identical.
      expect(noDiff(store.threads.summaries())).toEqual(ro.listThreads());
      expect(noDiff(store.threads.summaries({ archived: false }))).toEqual(ro.listThreads({ archived: false }));
      for (const t of [...THREADS, 'thr_3']) {
        expect({ ...store.projections.thread(t), diff: null }).toEqual(ro.getThread(t));
        for (const opts of [{}, { limit: 7 }, { afterSeq: 40, limit: 25 }, { beforeSeq: 90, limit: 10 }, { beforeSeq: 3, limit: 50 }, { afterSeq: 10_000 }]) {
          expect([t, opts, store.projections.timeline(t, opts)]).toEqual([t, opts, ro.getTimeline(t, opts)]);
        }
      }
      // A write committed by the host is visible to the reader at once (WAL).
      const ev = store.events.append({ threadId: 'thr_1', contextId: contextIdOf('thr_1'), runId: null, turn: 9, step: null, type: 'item', payload: { type: 'item', item: userItem('late', 9, 'late') } });
      expect(ro.getTimeline('thr_1', { afterSeq: ev.seq - 1 }).items.map((x) => x.id)).toEqual(['late']);
    } finally {
      ro.close();
    }
    await expect(openReadOnlyHarnessDb(store.file)).resolves.toBeTruthy();
  });

  it('getThread: a live meter replaces the estimate; unknown threads are not_found', () => {
    const meter = { windowTokens: 1, ceilingTokens: 1, usedTokens: 1, reserveTokens: 0, cachedRatio: 0.5, compactions: 0, tierBoundaryTokens: null, messageCount: 1, nextStepUsd: 0.01, estimated: false };
    expect(store.projections.thread('thr_1', meter).meter).toEqual(meter);
    expect(() => store.projections.thread('missing')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(store.projections.summary('missing')).toBeNull();
  });
});

describe('todo and status projection details', () => {
  it('todos follow the latest todo event per context; a todo event never touches another context', () => {
    const ev = (contextId: string, todo: unknown): StoredEvent =>
      store.events.append({ threadId: 'thr_1', contextId, runId: null, turn: 1, step: 1, type: 'todo', payload: { type: 'todo', todo } });
    ev(contextIdOf('thr_1'), [{ id: '1', text: 'a', status: 'pending' }]);
    ev('run_child_x', [{ id: 'c', text: 'child', status: 'pending' }]);
    ev(contextIdOf('thr_1'), [{ id: '1', text: 'a', status: 'done' }]);
    ev(contextIdOf('thr_1'), 'not a list'); // ignored
    expect(store.todos.get(contextIdOf('thr_1'))).toEqual([{ id: '1', text: 'a', status: 'done' }]);
    expect(store.todos.get('run_child_x')).toEqual([{ id: 'c', text: 'child', status: 'pending' }]);
    expect(store.projections.thread('thr_1').todo).toEqual([{ id: '1', text: 'a', status: 'done' }]);
  });

  it('a status event with an unknown status is stored but not projected; a rollback undoes the projection too', () => {
    const status = (s: unknown) => store.events.append({ threadId: 'thr_2', contextId: contextIdOf('thr_2'), runId: null, turn: 1, step: null, type: 'status', payload: { type: 'status', status: s, reason: 'r', queuePosition: null, queueReason: null } });
    status('running');
    status('exploded');
    expect(store.threads.get('thr_2')).toMatchObject({ status: 'running', statusReason: 'r' });
    expect(() =>
      store.transaction(() => {
        status('completed');
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(store.threads.get('thr_2')?.status).toBe('running');
    expect(store.events.lastSeq('thr_2')).toBe(2);
  });
});
