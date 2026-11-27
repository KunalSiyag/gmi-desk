/**
 * The dev-only "Agent runtime mock turn" (harness.md §24 H2: "driven by tests and a dev-only Diagnostics runner").
 * One full agent turn end to end, with nothing real at stake:
 *   - a throwaway git repo under os.tmpdir() (never the user's projects) and a throwaway harness data dir;
 *   - its own supervisor and host (the real utilityProcess in the app; an in-memory process in tests), so the user's
 *     harness database is never touched;
 *   - a scripted model behind the GmiGateway interface (no network, no key, no money): read + grep in parallel, edit,
 *     apply_patch, bash (asks; the real approval broker auto-answers "Allow once"), then a final answer. Step 2 reports a
 *     large prompt, so the context is compacted (the summary request is scripted too).
 * It checks the event log (contiguous thread_seq, the expected items), the worktree, the review diff and that the
 * repo's own checkout is untouched, then removes everything.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalDecision, CodeThreadEvent, CodeThreadSummary, DiffFile, RunStatus, TimelineItem } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { GatewayEvent, GatewayRequest, GatewayStatus } from '@shared/contracts/gateway';
import { turnIdOf } from '@harness/protocol';
import type { GmiGateway } from '../../core/services';
import type { Logger } from '../../core/logger';
import { createApprovalBroker } from './approvals';
import { createRpcRouter, defaultRpcHandlers } from './bridge';
import { createHarnessSupervisor, type HostSpawner, type SupervisorClock } from './supervisor';

export const MOCK_TURN_MODEL = 'gmi-desk/mock-agent';

const PATCH = ['*** Begin Patch', '*** Add File: NOTES.md', '+# Notes', '+sum() now adds (fixed by the mock agent).', '*** End Patch'].join('\n');

/** The model's script, by step (scope.step, 1-based). */
export const MOCK_TURN_SCRIPT: Array<Array<{ name: string; args: Record<string, unknown> }>> = [
  [
    { name: 'read', args: { path: 'src/sum.js' } },
    { name: 'grep', args: { pattern: 'return a', path: 'src' } },
  ],
  [{ name: 'edit', args: { path: 'src/sum.js', old_string: 'return a - b;', new_string: 'return a + b;' } }],
  [{ name: 'apply_patch', args: { patch: PATCH } }],
  [{ name: 'bash', args: { command: 'sh test.sh', description: 'Run the tests' } }],
];

const usage = (promptTokens: number, completionTokens: number): GatewayEvent => ({
  type: 'usage',
  usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, reasoningTokens: null, cachedTokens: null },
  cacheWriteTokens: null,
  costUsd: 0,
  estimated: false,
  maybeBilled: false,
});

/** A GmiGateway with the scripted model: refuses requests outside an open run, like main's run registry. */
export function scriptedAgentGateway(): GmiGateway & { requests: GatewayRequest[] } {
  const open = new Set<string>();
  const requests: GatewayRequest[] = [];
  const status: GatewayStatus = { online: true, tpmLimit: 0, tpmEffective: 0, tpmUsedLastMinute: 0, queued: 0, inFlight: 0, models: [], cacheHitRatio24h: null, last429At: null, updatedAt: new Date(0).toISOString() };
  return {
    requests,
    async *stream(req, signal) {
      requests.push(req);
      const promptTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
      if (!req.scope.runId || !open.has(req.scope.runId)) {
        yield { type: 'error', error: { code: 'invalid_input', message: 'The run is not running.' }, afterOutput: false };
        return;
      }
      if (signal.aborted) {
        yield { type: 'error', error: { code: 'cancelled', message: 'Cancelled.' }, afterOutput: false };
        return;
      }
      yield { type: 'started', attempt: 1, model: req.target && 'model' in req.target ? req.target.model : MOCK_TURN_MODEL, api: 'chat' };
      if (req.purpose === 'compaction') {
        yield { type: 'text', text: '## Objective\n- Fix sum() so the tests pass.\n## Progress\n- Read src/sum.js; edited it to add.' };
        yield usage(promptTokens, 40);
        yield { type: 'finish', reason: 'stop', raw: 'stop' };
        return;
      }
      const step = req.scope.step ?? 1;
      const calls = MOCK_TURN_SCRIPT[step - 1];
      // Step 2 reports a large prompt so the loop compacts before step 3 (thread window 40k).
      const reported = step === 2 ? 30_000 : promptTokens;
      if (calls) {
        yield { type: 'text', text: `Step ${step}.` };
        for (const [i, c] of calls.entries()) yield { type: 'tool_call', call: { id: `call_${step}_${i}`, name: c.name, arguments: JSON.stringify(c.args) } };
        yield usage(reported, 30);
        yield { type: 'finish', reason: 'tool_calls', raw: 'tool_calls' };
        return;
      }
      yield { type: 'text', text: 'Done: sum() adds now and the tests pass.' };
      yield usage(reported, 12);
      yield { type: 'finish', reason: 'stop', raw: 'stop' };
    },
    estimate: () => ({ promptTokens: 0, expectedCachedTokens: 0, reserveUsd: 0, expectedUsd: 0 }),
    status: () => status,
    abortOwner: () => undefined,
    openRun: (scope) => void open.add(scope.runId),
    closeRun: (runId) => void open.delete(runId),
    setThreadCaps: () => undefined,
    approveThreadCaps: () => undefined,
    threadSpend: () => ({ turnUsd: 0, threadUsd: 0 }),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=GMI Desk test', '-c', 'user.email=test@gmi-desk.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A throwaway repo with a failing "test" (sum subtracts). */
export function makeMockRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'sum.js'), 'export function sum(a, b) {\n  return a - b;\n}\n');
  writeFileSync(join(repo, 'test.sh'), "#!/bin/sh\nif grep -q 'return a + b' src/sum.js; then echo PASS; else echo FAIL; exit 1; fi\n");
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return realpathSync(repo);
}

export interface MockTurnResult {
  report: string;
  status: RunStatus;
  events: CodeThreadEvent[];
  problems: string[];
  /** The host's sandbox self-test (bash ran sandboxed when ok). */
  sandbox: { kind: string; ok: boolean } | null;
}

export interface MockTurnDeps {
  spawn: HostSpawner;
  env: () => Record<string, string>;
  clock: SupervisorClock;
  log: Logger;
  /** Parent of the throwaway dirs (default os.tmpdir()). */
  tmpRoot?: string;
  timeoutMs?: number;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'stopped', 'failed', 'cancelled', 'interrupted']);

export async function runMockTurn(deps: MockTurnDeps): Promise<MockTurnResult> {
  const root = realpathSync(mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'gmi-desk-mock-turn-')));
  const events: CodeThreadEvent[] = [];
  const problems: string[] = [];
  let ended: ((s: RunStatus) => void) | null = null;
  const endedP = new Promise<RunStatus>((r) => (ended = r));
  const gateway = scriptedAgentGateway();
  let supervisorRef: ReturnType<typeof createHarnessSupervisor> | null = null;
  const approvals = createApprovalBroker({
    platform: { confirm: async () => false, notify: () => undefined, isAppFocused: () => true } as never,
    emit: ({ request, resolved }) => {
      if (resolved) return;
      const decision: ApprovalDecision = request.kind === 'question' ? { kind: 'answer', text: 'Go ahead.' } : { kind: 'allow_once' };
      deps.clock.setTimeout(() => void approvals.respond(request.requestId, decision).catch(() => undefined), 0);
    },
    deliver: (hostId, requestId, decision) => supervisorRef?.sendDecision(hostId, requestId, decision),
    clock: deps.clock,
    log: deps.log.child('approvals'),
  });
  const supervisor = createHarnessSupervisor({
    spawn: deps.spawn,
    env: deps.env,
    init: () => ({ dataDir: join(root, 'userData', 'data', 'harness'), installId: 'mock-turn', settings: { mock: true, logLevel: 'info' }, platform: process.platform }),
    gateway,
    approvals,
    rpc: createRpcRouter(defaultRpcHandlers(approvals)),
    emitEvent: (e) => {
      events.push(e);
      if (e.type === 'status' && TERMINAL.has(e.status)) ended?.(e.status);
    },
    emitThreads: () => undefined,
    clock: deps.clock,
    log: deps.log,
  });
  supervisorRef = supervisor;
  try {
    const repo = makeMockRepo(root);
    await supervisor.ready();
    const projectId = 'mock-turn-project';
    await supervisor.command({
      op: 'project.add',
      project: { id: projectId, name: 'mock-repo', rootPath: repo, defaultBranch: 'main', trust: { state: 'trusted', configHash: null, trustedAt: null }, worktreeDir: join(root, 'worktrees'), setupCommand: null, addedAt: new Date(deps.clock.now()).toISOString(), threadCount: 0 },
    });
    const thread = (await supervisor.command({
      op: 'thread.create',
      projectId,
      init: { title: 'Fix sum', strategy: { kind: 'worktree', baseRef: 'main' }, settings: { model: MOCK_TURN_MODEL, mode: 'auto-accept-edits', maxContextTokens: 40_000, maxOutputTokens: 4_096 } },
    })) as CodeThreadSummary;
    const started = await supervisor.command({ op: 'run.send', threadId: thread.id, text: 'Fix the failing test in this repo.' });
    const timeoutMs = deps.timeoutMs ?? 90_000;
    let timer: unknown = null;
    const status = await Promise.race([
      endedP,
      new Promise<RunStatus>((_, reject) => {
        timer = deps.clock.setTimeout(() => reject(new GmiError('timeout', 'The mock turn did not finish in time.')), timeoutMs);
      }),
    ]).finally(() => deps.clock.clearTimeout(timer));

    // ── Checks ──
    const durable = events.filter((e) => e.seq !== null);
    const seqs = durable.map((e) => e.seq as number);
    if (seqs.some((s, i) => i > 0 && s !== seqs[i - 1]! + 1)) problems.push(`thread_seq gap in ${seqs.join(',')}`);
    const items = durable.flatMap((e) => (e.type === 'item' ? [e.item] : []));
    const finalTool = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();
    for (const it of items) if (it.kind === 'tool') finalTool.set(it.id, it);
    const tools = [...finalTool.values()];
    for (const name of ['read', 'grep', 'edit', 'apply_patch', 'bash']) {
      const t = tools.find((x) => x.tool === name);
      if (!t) problems.push(`no ${name} call`);
      else if (t.status !== 'succeeded') problems.push(`${name} ${t.status}: ${(t.output?.text ?? '').slice(0, 200)}`);
    }
    const approvalsSeen = items.filter((i): i is Extract<TimelineItem, { kind: 'approval' }> => i.kind === 'approval');
    if (!approvalsSeen.some((a) => a.decision?.kind === 'allow_once')) problems.push('no approval answered');
    if (!items.some((i) => i.kind === 'checkpoint')) problems.push('no checkpoint');
    if (!items.some((i) => i.kind === 'compaction')) problems.push('no compaction');
    if (status !== 'completed') problems.push(`run ended ${status}`);
    const view = (await supervisor.command({ op: 'query', name: 'thread', args: { threadId: thread.id } })) as { worktreePath?: string | null };
    const timeline = (await supervisor.command({ op: 'query', name: 'timeline', args: { threadId: thread.id } })) as { lastSeq: number };
    if (timeline.lastSeq !== (seqs[seqs.length - 1] ?? 0)) problems.push(`timeline lastSeq ${timeline.lastSeq} ≠ forwarded ${seqs[seqs.length - 1] ?? 0}`);
    const diff = (await supervisor.command({ op: 'query', name: 'diff', args: { threadId: thread.id } })) as DiffFile[];
    const changed = diff.map((d) => d.path).sort();
    if (!changed.includes('src/sum.js') || !changed.includes('NOTES.md')) problems.push(`review diff lists ${changed.join(', ') || 'nothing'}`);
    if (!readFileSync(join(repo, 'src', 'sum.js'), 'utf8').includes('a - b') || existsSync(join(repo, 'NOTES.md'))) problems.push('the repo checkout was changed');
    const gwAgent = gateway.requests.filter((r) => r.purpose === 'agent').length;
    const gwCompaction = gateway.requests.filter((r) => r.purpose === 'compaction').length;
    const runId = (started as { runId?: string }).runId ?? '?';
    const sb = supervisor.info().sandbox;
    const report = [
      `Mock turn ${status}: run ${runId}, ${gwAgent} model requests + ${gwCompaction} compaction, ${tools.length} tool calls (${tools.map((t) => `${t.tool} ${t.status}`).join(', ')}), ${approvalsSeen.length > 0 ? 'approval answered' : 'no approval'}, ${durable.length} events (seq 1–${seqs[seqs.length - 1] ?? 0}${problems.some((p) => p.startsWith('thread_seq')) ? ', with gaps' : ', contiguous'}).`,
      `Review diff: ${changed.join(', ') || 'none'}. Worktree: ${view.worktreePath ? 'yes' : 'no'}. Sandbox: ${sb ? `${sb.kind}${sb.ok ? '' : ' (unavailable: bash ran after its approval without it)'}` : 'unknown'}. Turn id ${turnIdOf(thread.id, 1)}.`,
      problems.length ? `Problems: ${problems.join('; ')}.` : 'All checks passed.',
    ].join(' ');
    return { report, status, events, problems, sandbox: sb ? { kind: sb.kind, ok: sb.ok } : null };
  } finally {
    approvals.dispose();
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
