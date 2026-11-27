// Shared helpers for the H2-A store tests: throwaway directories under os.tmpdir(), a store opened through the
// real `openStore` (inline worker, fake clock), and row builders with sanitised data.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_DEFAULTS, type CodeThreadSettings, type TimelineItem } from '@shared/contracts/code';
import type { HostPhase } from '@harness/protocol';
import { openSqliteStore, type SqliteStore } from '@harness/store';
import { contextIdOf, harnessPaths, type MessageRow, type ProjectRow, type ThreadRow, type ToolCallRow } from '@harness/types';
import { fakeClock, inlineWorker, memoryLog, type FakeClock } from '../fakes';

export interface TempDir {
  dir: string;
  cleanup(): Promise<void>;
}

export async function tempDir(tag: string): Promise<TempDir> {
  const dir = await mkdtemp(join(tmpdir(), `gmi-desk-h2a-${tag}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface Opened {
  store: SqliteStore;
  file: string;
  clock: FakeClock;
  phases: HostPhase[];
  log: ReturnType<typeof memoryLog>;
}

/** Opens (and migrates) `<dataDir>/harness.sqlite` with the inline worker. */
export async function openTestStore(dataDir: string, clock: FakeClock = fakeClock()): Promise<Opened> {
  const file = harnessPaths(dataDir).db;
  const phases: HostPhase[] = [];
  const log = memoryLog('host');
  const store = await openSqliteStore({ file, worker: inlineWorker(), clock, log, phase: (p) => phases.push(p) });
  return { store, file, clock, phases, log };
}

export function settings(over: Partial<CodeThreadSettings> = {}): CodeThreadSettings {
  return {
    runtime: 'gmi',
    model: 'zai-org/GLM-5.3',
    subagentModel: null,
    compactionModel: null,
    sideTaskModel: null,
    mode: CODE_DEFAULTS.mode,
    reasoningEffort: null,
    maxOutputTokens: CODE_DEFAULTS.maxOutputTokens,
    economy: false,
    maxContextTokens: CODE_DEFAULTS.maxContextTokens,
    webFetch: 'off',
    network: 'off',
    budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 30 },
    computerId: null,
    ...over,
  };
}

export function projectRow(id = 'prj_1', over: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id,
    rootPath: `/tmp/gmi-desk-fixture/${id}`,
    name: `Project ${id}`,
    defaultBranch: 'main',
    worktreeDir: `/tmp/gmi-desk-fixture/${id}-worktrees`,
    setupCommand: null,
    trustState: 'trusted',
    trustHash: 'h'.repeat(64),
    trustedAt: '2026-11-02T09:00:00.000Z',
    refFormat: 'files',
    addedAt: '2026-11-02T09:00:00.000Z',
    ...over,
  };
}

export function threadRow(id: string, projectId = 'prj_1', over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    strategy: 'worktree',
    branch: `gmi/${id.slice(0, 6)}/work`,
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    worktreePath: `/tmp/gmi-desk-fixture/wt/${id}`,
    gitDir: `/tmp/gmi-desk-fixture/${projectId}/.git/worktrees/${id}`,
    commonDir: `/tmp/gmi-desk-fixture/${projectId}/.git`,
    gitPointer: `gitdir: /tmp/gmi-desk-fixture/${projectId}/.git/worktrees/${id}\n`,
    objectDir: null,
    setupState: 'ready',
    settings: settings(),
    status: 'idle',
    statusReason: null,
    costUsd: 0,
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
    archived: false,
    instructionsHash: null,
    envBlock: '<environment>\nos: linux\n</environment>',
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    ...over,
  };
}

export function messageRow(id: string, threadId: string, over: Partial<Omit<MessageRow, 'ord'>> = {}): Omit<MessageRow, 'ord'> {
  return {
    id,
    threadId,
    contextId: contextIdOf(threadId),
    turn: 1,
    role: 'user',
    content: `content of ${id}`,
    toolCalls: null,
    toolCallId: null,
    reasoning: null,
    reasoningFamily: null,
    model: null,
    inContext: true,
    pinned: false,
    partial: false,
    estTokens: 10,
    ...over,
  };
}

export function toolCallRow(id: string, threadId: string, wireId: string, over: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    id,
    wireId,
    providerCallId: 'call_0',
    threadId,
    contextId: contextIdOf(threadId),
    runId: 'run_1',
    turn: 1,
    step: 1,
    tool: 'read',
    args: '{"path":"src/a.ts"}',
    status: 'started',
    resultMessageId: null,
    spillPath: null,
    exitCode: null,
    startedAt: '2026-11-02T10:00:01.000Z',
    finishedAt: null,
    ...over,
  };
}

export function userItem(id: string, turn: number, text: string): TimelineItem {
  return { kind: 'user', id, seq: 0, turn, text, steering: false, at: '2026-11-02T10:00:00.000Z' };
}

export function toolItem(id: string, status: 'running' | 'succeeded' | 'failed', over: { turn?: number; step?: number } = {}): TimelineItem {
  return {
    kind: 'tool',
    id,
    seq: 0,
    turn: over.turn ?? 1,
    step: over.step ?? 1,
    toolCallId: `tc_${id}`,
    tool: 'bash',
    title: 'npm test',
    argsPreview: '{"command":"npm test"}',
    status,
    output: status === 'running' ? null : { text: 'ok', truncated: false, totalBytes: 2, spillId: null, exitCode: 0 },
    durationMs: status === 'running' ? null : 120,
    at: '2026-11-02T10:00:02.000Z',
  };
}

/** A tiny deterministic PRNG (mulberry32) for the interleaving tests. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
