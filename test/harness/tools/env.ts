// H2-D test environment: a throwaway worktree, userData and HOME under os.tmpdir(), a memory store and a
// ToolRunContext factory. Nothing here touches a real project or the user's home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODE_DEFAULTS, type CodeState } from '@shared/contracts/code';
import { contextIdOf, newId, type ToolDefinition, type ToolResult, type ToolRunContext } from '@harness/types';
import { fakeClock, fakeGitService, fakePermissionEngine, fakeSandboxRunner, memoryLog, memoryMutationLock, memoryStore } from '../fakes';

export const T1 = 'c0de0000-0000-4000-8000-0000000000d1';
export const T2 = 'c0de0000-0000-4000-8000-0000000000d2';

export interface ToolEnv {
  base: string;
  worktree: string;
  /** realpath of the worktree (tmpdir may be a symlink). */
  wt: string;
  userData: string;
  dataDir: string;
  home: string;
  outside: string;
  store: ReturnType<typeof memoryStore>;
  sandbox: ReturnType<typeof fakeSandboxRunner>;
  ctx(over?: Partial<Pick<ToolRunContext, 'threadId' | 'contextId' | 'signal'>> & { callId?: string }): ToolRunContext;
  write(rel: string, content: string | Buffer): string;
  readFile(rel: string): string;
  cleanup(): void;
}

export function makeEnv(opts: { sandbox?: CodeState['sandbox'] } = {}): ToolEnv {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gmid-h2d-')));
  const worktree = path.join(base, 'wt');
  const userData = path.join(base, 'ud');
  const dataDir = path.join(userData, 'data', 'harness');
  const home = path.join(base, 'home');
  const outside = path.join(base, 'outside');
  for (const d of [worktree, dataDir, home, outside]) fs.mkdirSync(d, { recursive: true });
  const store = memoryStore();
  const clock = fakeClock();
  const sandbox = fakeSandboxRunner({}, opts.sandbox ?? { kind: 'none', ok: false, detail: 'test', network: 'none' });
  const env: ToolEnv = {
    base,
    worktree,
    wt: fs.realpathSync(worktree),
    userData,
    dataDir,
    home,
    outside,
    store,
    sandbox,
    ctx(over = {}) {
      const threadId = over.threadId ?? T1;
      const id = over.callId ?? newId('tc');
      return {
        threadId,
        projectId: 'p1',
        contextId: over.contextId ?? contextIdOf(threadId),
        runId: 'run_1',
        turn: 1,
        step: 1,
        call: { id, wireId: `call_${id.slice(-6)}`, name: 'x', rawArgs: '{}' },
        worktree,
        dataDir,
        settings: {
          runtime: 'gmi',
          model: 'm',
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
        },
        signal: over.signal ?? new AbortController().signal,
        store,
        sandbox,
        git: fakeGitService(),
        lock: memoryMutationLock(),
        perm: fakePermissionEngine(),
        emitOutput: () => undefined,
        clock,
        log: memoryLog(),
      };
    },
    write(rel, content) {
      const p = path.join(worktree, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    readFile: (rel) => fs.readFileSync(path.join(worktree, rel), 'utf8'),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
  return env;
}

/** parse → subject → run, as the loop does. Throws on a parse error. */
export async function call<A>(tool: ToolDefinition<A>, raw: unknown, ctx: ToolRunContext): Promise<ToolResult & { subjectRisk: string[] }> {
  const parsed = tool.parse(raw);
  if (!parsed.ok) throw new Error(`parse: ${parsed.error}`);
  const subject = tool.subject(parsed.args, ctx);
  const result = await tool.run(parsed.args, ctx);
  return { ...result, subjectRisk: subject.risk };
}

export const policyHome = (env: ToolEnv) => ({ home: env.home });
