import type { CodeThreadSettings } from '@shared/contracts/code';
import type { ThreadRow } from '@harness/types';

export const T0 = '2026-11-02T00:00:00.000Z';

export function settings(over: Partial<CodeThreadSettings> = {}): CodeThreadSettings {
  return {
    runtime: 'gmi',
    model: 'zai-org/GLM-5.3',
    subagentModel: null,
    compactionModel: null,
    sideTaskModel: null,
    mode: 'auto-accept-edits',
    reasoningEffort: null,
    maxOutputTokens: 16_384,
    economy: false,
    maxContextTokens: 160_000,
    webFetch: 'ask',
    network: 'ask',
    budget: { perTurnUsd: 1, perThreadUsd: 5, maxStepsPerTurn: 50, maxTurnMinutes: 30 },
    computerId: null,
    ...over,
  };
}

export function threadRow(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 'th1',
    projectId: 'p1',
    title: 't',
    strategy: 'worktree',
    branch: null,
    baseRef: null,
    baseSha: null,
    worktreePath: '/work/wt',
    gitDir: null,
    commonDir: null,
    gitPointer: null,
    objectDir: null,
    setupState: 'ready',
    settings: settings(),
    status: 'idle',
    statusReason: null,
    costUsd: 0,
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0 },
    archived: false,
    instructionsHash: null,
    envBlock: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}
