// H2 integration (harness.md §24 "integration by H2-0"): one full agent turn end to end through main's supervisor,
// bridge and approval broker, the protocol over a structured-clone "utilityProcess", the REAL host runtime (store on
// node:sqlite, loop, compactor, file tools, sandbox, permissions, git) and the scripted model behind the GmiGateway
// interface — the same runner as the dev-only Diagnostics action. Throwaway repo and data dir under os.tmpdir().
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '@main/core/logger';
import { runMockTurn } from '@main/services/harness/mock-turn';
import { systemSupervisorClock, type HostProcess, type HostSpawner } from '@main/services/harness';
import { createHost, memoryJournalIo, type Host } from '@harness/host';
import { createRealHostRuntime } from '@harness/host-runtime';
import type { HostToMain, MainToHost } from '@harness/protocol';
import { systemHostClock } from '@harness/host';
import { createInlineWorker } from '@harness/worker';
import { HAS_BWRAP } from '../sandbox/live-helpers';

/** An in-memory utilityProcess running the real host and runtime (structured clone both ways). */
function inMemorySpawner(): HostSpawner {
  return (async () => {
    const toMain: Array<(data: unknown) => void> = [];
    const backlog: unknown[] = [];
    const exitListeners: Array<(code: number) => void> = [];
    let exited = false;
    const deliver = (data: unknown) => {
      if (toMain.length === 0) backlog.push(data);
      else for (const l of toMain) l(data);
    };
    let host: Host | null = null;
    const exit = (code: number) => {
      if (exited) return;
      exited = true;
      queueMicrotask(() => {
        for (const l of exitListeners) l(code);
      });
    };
    const proc: HostProcess = {
      pid: 4242,
      postMessage(message: MainToHost) {
        if (exited) throw new Error('port closed');
        const copy = structuredClone(message);
        queueMicrotask(() => host?.receive(copy));
      },
      onMessage(listener) {
        toMain.push(listener);
        for (const m of backlog.splice(0)) listener(m);
      },
      onExit(listener) {
        exitListeners.push(listener);
      },
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => exit(-9),
    };
    host = createHost({
      send: (msg: HostToMain) => {
        if (exited) return;
        const copy = structuredClone(msg);
        queueMicrotask(() => deliver(copy));
      },
      clock: systemHostClock,
      worker: createInlineWorker(),
      createRuntime: (deps) => createRealHostRuntime(deps, { hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' } }),
      journal: () => memoryJournalIo(),
      exit,
      version: '0.0.0-test',
    });
    return proc;
  }) as unknown as HostSpawner;
}

describe('H2 integration: a full mock turn through supervisor → host → loop → tools → sandbox → git', () => {
  it('read, grep, edit, apply_patch and sandboxed bash with an approval, a checkpoint and a compaction', async () => {
    const result = await runMockTurn({ spawn: inMemorySpawner(), env: () => ({}), clock: systemSupervisorClock, log: silentLogger, timeoutMs: 60_000 });
    expect(result.problems, result.report).toEqual([]);
    expect(result.status).toBe('completed');
    const kinds = result.events.flatMap((e) => (e.type === 'item' ? [e.item.kind] : []));
    expect(kinds).toEqual(expect.arrayContaining(['user', 'assistant', 'tool', 'approval', 'checkpoint', 'compaction']));
    expect(result.events.some((e) => e.type === 'meter')).toBe(true);
    if (HAS_BWRAP) expect(result.sandbox).toEqual({ kind: 'bwrap', ok: true });
  }, 120_000);
});
