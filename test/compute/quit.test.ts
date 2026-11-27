// C1-D quit check (compute.md §9.7): only billed managed containers ask; Delete all and quit · Keep running and quit ·
// Cancel; the default dialog is two native confirms; registered through core/shutdown.ts before the disposers.
import { afterEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { registerQuitCheck, registeredQuitChecks, runQuitChecks } from '@main/core/shutdown';
import type { QuitChoice } from '@main/services/compute/guard';
import { CONTAINER_LEASE, guardHarness, HOUR, record, SANDBOX_LEASE, type GuardHarness } from './guard-harness';

const NOW = new Date(2026, 10, 15, 12, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const container = (id: string, over = {}) =>
  record({ id, kind: 'container', listUsdPerHour: 3.35, lease: CONTAINER_LEASE, runningSince: ago(HOUR), intervals: [{ from: ago(HOUR), to: null, usdPerHour: 3.35 }], ...over });

let h: GuardHarness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

function scripted(choice: QuitChoice) {
  const asked: Array<{ count: number; usdPerHour: number; message: string }> = [];
  return { asked, dialog: async (info: { count: number; usdPerHour: number; message: string }) => (asked.push(info), choice) };
}

describe('quit check', () => {
  it('quits without asking when no managed container bills (sandboxes are bounded by the server)', async () => {
    const d = scripted('cancel');
    h = await guardHarness({
      now: NOW,
      extra: { quitDialog: d.dialog },
      records: [
        record({ id: 's1', lease: SANDBOX_LEASE, intervals: [{ from: ago(HOUR), to: null, usdPerHour: 0.09 }] }),
        container('c-unmanaged', { managed: false }),
        container('c-deleting', { phase: 'deleting' }),
        container('c-gone', { phase: 'deleted', tombstone: { at: ago(1), reason: 'deleted' } }),
      ],
    });
    expect(await h.guard.quitCheck()).toBe('quit');
    expect(d.asked).toHaveLength(0);
  });

  it('states count and list price; Keep running quits, Cancel stays', async () => {
    const keep = scripted('keep');
    h = await guardHarness({ now: NOW, extra: { quitDialog: keep.dialog }, records: [container('c1'), container('c2')] });
    expect(await h.guard.quitCheck()).toBe('quit');
    expect(keep.asked[0]).toEqual({
      count: 2,
      usdPerHour: 6.7,
      message: '2 containers are still running ($6.70/h list). They keep billing after GMI Desk quits.',
    });
    expect(h.act.calls).toHaveLength(0);
    await h.cleanup();
    const cancel = scripted('cancel');
    h = await guardHarness({ now: NOW, extra: { quitDialog: cancel.dialog }, records: [container('c1')] });
    expect(await h.guard.quitCheck()).toBe('cancel');
    expect(cancel.asked[0]?.message).toBe('1 container is still running ($3.35/h list). It keeps billing after GMI Desk quits.');
  });

  it('Delete all and quit deletes every billed container (no clock gate: the user chose it)', async () => {
    const d = scripted('delete');
    h = await guardHarness({ now: NOW, extra: { quitDialog: d.dialog }, records: [container('c1'), container('c2')] });
    expect(await h.guard.quitCheck()).toBe('quit');
    expect(h.act.calls).toEqual([
      { action: 'delete', id: 'c1', cause: 'quit' },
      { action: 'delete', id: 'c2', cause: 'quit' },
    ]);
  });

  it('a delete that fails asks "Quit anyway?" natively', async () => {
    const d = scripted('delete');
    h = await guardHarness({ now: NOW, extra: { quitDialog: d.dialog }, records: [container('c1')] });
    h.act.fail.delete = new GmiError('network', 'offline');
    h.t.platform.confirmAnswer = false;
    expect(await h.guard.quitCheck()).toBe('cancel');
    expect(h.t.platform.confirms.at(-1)).toEqual({ title: 'Some containers were not deleted', message: 'c1 could not be deleted and keeps billing.' });
    h.t.platform.confirmAnswer = true;
    expect(await h.guard.quitCheck()).toBe('quit');
  });

  it('the default dialog: two native confirms (delete first, then keep or cancel)', async () => {
    h = await guardHarness({ now: NOW, records: [container('c1')] });
    const answers = [false, true];
    h.t.platform.confirm = async (opts) => {
      h!.t.platform.confirms.push({ title: opts.title, message: opts.message });
      return answers.shift() ?? false;
    };
    expect(await h.guard.quitCheck()).toBe('quit');
    expect(h.t.platform.confirms.map((c) => c.title)).toEqual(['Containers are still running', 'Keep containers running?']);
    expect(h.act.calls).toHaveLength(0);
    answers.push(true);
    expect(await h.guard.quitCheck()).toBe('quit');
    expect(h.act.calls).toEqual([{ action: 'delete', id: 'c1', cause: 'quit' }]);
    answers.push(false, false);
    h.act.calls.length = 0;
    expect(await h.guard.quitCheck()).toBe('cancel');
    expect(h.act.calls).toHaveLength(0);
  });

  it('runs through core/shutdown before the disposers', async () => {
    const d = scripted('cancel');
    h = await guardHarness({ now: NOW, extra: { quitDialog: d.dialog }, records: [container('c1')] });
    const off = registerQuitCheck(() => h!.guard.quitCheck());
    try {
      expect(await runQuitChecks(registeredQuitChecks())).toBe('cancel');
    } finally {
      off();
    }
  });
});
