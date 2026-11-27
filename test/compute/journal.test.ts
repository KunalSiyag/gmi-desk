// C1-C: the write-ahead create journal (§6.2, §10). Durable before resolve; unresolved entries are never pruned or
// dropped by the cap; malformed entries are dropped, never the file.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { durableWriteFile } from '@main/core/store';
import { JOURNAL_LIMITS, createJournal, pruneJournal, readJournal, type JournalEntry } from '@main/services/compute/journal';
import { COMPUTE_DATA_FILES } from '@main/services/compute/types';
import { createTestContext, type TestContext } from '../helpers/context';

let t: TestContext;
afterEach(async () => t?.cleanup());

const file = () => join(t.ctx.paths.data, COMPUTE_DATA_FILES.journal);
const base = (rid: string): Omit<JournalEntry, 'state' | 'updatedAt' | 'remoteId' | 'error'> => ({
  rid,
  kind: 'container',
  backend: 'ce',
  name: `gmid-abcdef-${rid}-q1w2e3`,
  displayName: rid,
  idc: 'asia-east-taiwan3',
  sku: 'gmi.container.nv.H200x1.tw3',
  at: new Date().toISOString(),
  network: null,
});

function entry(rid: string, state: JournalEntry['state'], ageMs: number): JournalEntry {
  const at = new Date(Date.now() - ageMs).toISOString();
  return { ...base(rid), state, at, updatedAt: at, remoteId: null, error: null };
}

describe('journal', () => {
  it('an intent is on disk (durableWriteFile, 0600) before append resolves; every state change too', async () => {
    t = await createTestContext();
    const write = vi.fn(durableWriteFile);
    const j = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger, write: write as typeof durableWriteFile });
    await j.load();
    await j.append(base('cr_a'));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[2]).toBe(0o600);
    expect(JSON.parse(await readFile(file(), 'utf8')).entries[0]).toMatchObject({ rid: 'cr_a', state: 'intent' });
    await j.update('cr_a', { state: 'sent' });
    expect(JSON.parse(await readFile(file(), 'utf8')).entries[0].state).toBe('sent');
    await expect(j.append(base('cr_a'))).rejects.toMatchObject({ code: 'internal' });
    await expect(j.update('cr_missing', { state: 'sent' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('survives a restart; unresolved() = intent, sent, unknown, failed_unknown', async () => {
    t = await createTestContext();
    const j = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger });
    await j.load();
    for (const [rid, state] of [['cr_i', 'intent'], ['cr_s', 'sent'], ['cr_u', 'unknown'], ['cr_f', 'failed_unknown'], ['cr_c', 'confirmed'], ['cr_x', 'failed'], ['cr_d', 'dismissed']] as const) {
      await j.append(base(rid));
      if (state !== 'intent') await j.update(rid, { state });
    }
    const again = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger });
    await again.load();
    expect(again.unresolved().map((e) => e.rid).sort()).toEqual(['cr_f', 'cr_i', 'cr_s', 'cr_u']);
  });

  it('prunes only confirmed/failed/dismissed entries older than 7 days', () => {
    const old = JOURNAL_LIMITS.pruneAfterMs + 60_000;
    const kept = pruneJournal(
      [entry('a', 'confirmed', old), entry('b', 'failed', old), entry('c', 'dismissed', old), entry('d', 'unknown', old), entry('e', 'failed_unknown', old), entry('f', 'confirmed', 1000), entry('g', 'intent', old)],
      Date.now(),
    );
    expect(kept.map((e) => e.rid).sort()).toEqual(['d', 'e', 'f', 'g']);
  });

  it('the 200-entry cap drops the oldest resolved entries, never an unresolved one', () => {
    const list: JournalEntry[] = [];
    for (let i = 0; i < 150; i += 1) list.push(entry(`u${i}`, 'failed_unknown', 10_000_000 + i));
    for (let i = 0; i < 100; i += 1) list.push(entry(`c${i}`, 'confirmed', 1000 + i));
    const kept = pruneJournal(list, Date.now());
    expect(kept).toHaveLength(JOURNAL_LIMITS.maxEntries);
    expect(kept.filter((e) => e.state === 'failed_unknown')).toHaveLength(150);
    // The newest confirmed entries stay.
    expect(kept.some((e) => e.rid === 'c0')).toBe(true);
    expect(kept.some((e) => e.rid === 'c99')).toBe(false);
  });

  it('reads defensively and keeps a corrupt file aside', async () => {
    expect(readJournal({ entries: [{ rid: 'x' }, null, { ...entry('ok', 'sent', 0), extra: 'dropped' }] }).map((e) => e.rid)).toEqual(['ok']);
    expect(readJournal({ entries: [{ ...entry('ok', 'sent', 0), extra: 'secret' }] })[0]).not.toHaveProperty('extra');
    t = await createTestContext();
    await writeFile(file(), 'garbage');
    const j = createJournal({ dataDir: t.ctx.paths.data, log: silentLogger });
    await j.load();
    expect(j.list()).toEqual([]);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(t.ctx.paths.data)).some((f) => f.startsWith(`${COMPUTE_DATA_FILES.journal}.corrupt-`))).toBe(true);
  });
});
