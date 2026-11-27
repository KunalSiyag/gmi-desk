// H2-A Store: command receipts make commands idempotent (§5.1, §13.3): a replay returns the stored result instead
// of running again — after a restart too; duplicates in flight run once; a failed command leaves no receipt; a
// store-only command commits its writes and its receipt atomically.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { createReceiptGuard, RECEIPT_RETENTION_MS, type SqliteStore } from '@harness/store';
import { contextIdOf } from '@harness/types';
import { fakeClock, type FakeClock } from '../fakes';
import { messageRow, openTestStore, projectRow, tempDir, threadRow, type TempDir } from './helpers';

let tmp: TempDir;
let clock: FakeClock;
let store: SqliteStore;

beforeEach(async () => {
  tmp = await tempDir('rcpt');
  clock = fakeClock();
  store = (await openTestStore(tmp.dir, clock)).store;
  store.projects.upsert(projectRow());
  store.threads.insert(threadRow('thr_1'));
});
afterEach(async () => {
  store.close();
  await tmp.cleanup();
});

/** A `send`-like command: appends a user message and an event, returns {runId, turn}. */
function sendCommand(s: SqliteStore, text: string) {
  return () => {
    const turn = s.events.lastSeq('thr_1') + 1;
    s.messages.append(messageRow(`msg_${turn}`, 'thr_1', { content: text, turn }));
    s.events.append({ threadId: 'thr_1', contextId: contextIdOf('thr_1'), runId: `run_${turn}`, turn, step: null, type: 'turn.started', payload: {} });
    return { runId: `run_${turn}`, turn };
  };
}

describe('receipts', () => {
  it('a replayed command returns the stored result and does not run again — also after a restart', async () => {
    const guard = createReceiptGuard(store);
    const fn = vi.fn(sendCommand(store, 'hi'));
    const first = await guard.run('cmd_1', 'thr_1', fn);
    const replay = await guard.run('cmd_1', 'thr_1', fn);
    expect(first).toEqual({ runId: 'run_1', turn: 1 });
    expect(replay).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);

    store.close();
    store = (await openTestStore(tmp.dir, clock)).store;
    const afterRestart = createReceiptGuard(store);
    const fn2 = vi.fn(sendCommand(store, 'hi'));
    expect(await afterRestart.run('cmd_1', 'thr_1', fn2)).toEqual(first);
    expect(fn2).not.toHaveBeenCalled();
    expect(store.messages.list(contextIdOf('thr_1'))).toHaveLength(1);
    expect(store.events.lastSeq('thr_1')).toBe(1);
  });

  it('duplicates in flight share one execution', async () => {
    const guard = createReceiptGuard(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fn = vi.fn(async () => {
      await gate;
      return { ok: 1 };
    });
    const a = guard.run('cmd_2', null, fn);
    const b = guard.run('cmd_2', null, fn);
    expect(guard.inFlight()).toEqual(['cmd_2']);
    release();
    expect(await Promise.all([a, b])).toEqual([{ ok: 1 }, { ok: 1 }]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(guard.inFlight()).toEqual([]);
  });

  it('a failed command stores no receipt, so a replay runs it again', async () => {
    const guard = createReceiptGuard(store);
    const fn = vi.fn().mockRejectedValueOnce(new GmiError('conflict', 'busy')).mockResolvedValueOnce('done');
    await expect(guard.run('cmd_3', 'thr_1', fn)).rejects.toMatchObject({ code: 'conflict' });
    expect(store.receipts.get('cmd_3')).toBeNull();
    expect(await guard.run('cmd_3', 'thr_1', fn)).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('void results are stored and replayed as null', async () => {
    const guard = createReceiptGuard(store);
    expect(await guard.run('cmd_4', 'thr_1', () => undefined)).toBeUndefined();
    expect(await guard.run('cmd_4', 'thr_1', () => 'other')).toBeNull();
  });

  it('runSync commits the effect and the receipt together: a crash in between leaves neither', () => {
    const guard = createReceiptGuard(store);
    expect(() =>
      guard.runSync('cmd_5', 'thr_1', () => {
        sendCommand(store, 'x')();
        throw new Error('crash before the receipt');
      }),
    ).toThrow('crash');
    expect(store.receipts.get('cmd_5')).toBeNull();
    expect(store.events.lastSeq('thr_1')).toBe(0);

    const fn = vi.fn(sendCommand(store, 'x'));
    expect(guard.runSync('cmd_5', 'thr_1', fn)).toEqual({ runId: 'run_1', turn: 1 });
    expect(guard.runSync('cmd_5', 'thr_1', fn)).toEqual({ runId: 'run_1', turn: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.receipts.get('cmd_5')).toMatchObject({ threadId: 'thr_1', at: '2026-11-02T10:00:00.000Z' });
  });

  it('receipts older than the retention are pruned at open', async () => {
    store.receipts.put('cmd_old', null, 1);
    clock.advance(RECEIPT_RETENTION_MS - 1_000);
    store.receipts.put('cmd_new', null, 2);
    clock.advance(2_000);
    store.close();
    store = (await openTestStore(tmp.dir, clock)).store;
    expect(store.receipts.get('cmd_old')).toBeNull();
    expect(store.receipts.get('cmd_new')?.result).toBe(2);
  });
});
