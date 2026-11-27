import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CodeState, CodeThreadSettings } from '@shared/contracts/code';
import { createCallGrants } from '@harness/perm/grants';
import { createPermissionEngine } from '@harness/perm/engine';
import { createSandboxRunner } from '@harness/sandbox/runner';
import { createShellTool, networkFor, truncateShellOutput, type ShellArgs } from '@harness/tools/shell';
import type { GitService, SandboxRunner, Store, ToolRunContext } from '@harness/types';
import { fakeClock, fakeGitService, fakeSandboxRunner, memoryLog, memoryMutationLock, memoryStore } from '../fakes';
import { settings, T0, threadRow } from '../perm/helpers';
import { HAS_BWRAP, makeRepo } from '../sandbox/live-helpers';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gmid-shell-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeCtx(opts: { worktree: string; store?: Store; sandbox?: SandboxRunner; git?: GitService; settings?: Partial<CodeThreadSettings>; callId?: string; signal?: AbortSignal }): ToolRunContext & { output: string[] } {
  const store = opts.store ?? memoryStore();
  if (!store.threads.get('th1')) store.threads.insert(threadRow({ worktreePath: opts.worktree, settings: settings(opts.settings) }));
  const output: string[] = [];
  return {
    output,
    threadId: 'th1',
    projectId: 'p1',
    contextId: 'ctx_th1',
    runId: 'run_1',
    turn: 1,
    step: 1,
    call: { id: opts.callId ?? 'tc_01TEST', wireId: 'call_0', name: 'bash', rawArgs: '{}' },
    worktree: opts.worktree,
    dataDir: join(root, 'data'),
    settings: settings(opts.settings),
    signal: opts.signal ?? new AbortController().signal,
    store,
    sandbox: opts.sandbox ?? fakeSandboxRunner(),
    git: opts.git ?? fakeGitService(),
    lock: memoryMutationLock(),
    perm: createPermissionEngine({ store, clock: fakeClock(Date.parse(T0)), env: { home: '/home/u', userData: null, platform: 'linux' } }),
    emitOutput: (c) => void output.push(c),
    clock: fakeClock(),
    log: memoryLog(),
  };
}

const tool = createShellTool({ hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/u', GMI_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'x' } });
const parsed = (raw: unknown): ShellArgs => {
  const p = tool.parse(raw);
  if (!p.ok) throw new Error(p.error);
  return p.args;
};

describe('bash tool: parsing and classification', () => {
  it('validates arguments and clamps the timeout', () => {
    expect(tool.parse({ description: 'x' }).ok).toBe(false);
    expect(tool.parse({ command: '', description: 'x' }).ok).toBe(false);
    expect(tool.parse({ command: 'a\0b', description: 'x' }).ok).toBe(false);
    expect(tool.parse({ command: 'ls', network: 'yes' }).ok).toBe(false);
    expect(tool.parse([]).ok).toBe(false);
    expect(parsed({ command: 'ls', description: 'list', timeout_ms: 5 }).timeout_ms).toBe(1_000);
    expect(parsed({ command: 'ls', description: 'list', timeout_ms: 9e9 }).timeout_ms).toBe(600_000);
    expect(parsed({ command: 'ls', description: 'list' }).timeout_ms).toBe(120_000);
  });

  it('read-only allowlisted commands are read-only (parallel batch), others mutate', () => {
    expect(tool.readOnly(parsed({ command: 'git status', description: '' }))).toBe(true);
    expect(tool.mutates(parsed({ command: 'git status', description: '' }))).toBe(false);
    expect(tool.readOnly(parsed({ command: 'npm test', description: '' }))).toBe(false);
    expect(tool.readOnly(parsed({ command: 'git status', description: '', network: true }))).toBe(false);
  });

  it('subject: command or network kind, cwd resolved, outside cwd flagged', () => {
    const wt = join(root, 'wt-subject');
    mkdirSync(wt, { recursive: true });
    const ctx = makeCtx({ worktree: wt });
    expect(tool.subject(parsed({ command: 'npm test', description: 'test', cwd: 'pkg' }), ctx)).toMatchObject({ tool: 'bash', kind: 'command', command: 'npm test', cwd: join(wt, 'pkg'), risk: [] });
    expect(tool.subject(parsed({ command: 'npm i', description: 'i', network: true }), ctx).kind).toBe('network');
    expect(tool.subject(parsed({ command: 'ls', description: '', cwd: '../..' }), ctx).risk).toContain('outside_worktree');
  });

  it('networkFor: approved → proxy (or the shared fallback), full-access → proxy, else off', () => {
    expect(networkFor({ network: true }, { mode: 'auto' }, 'proxy')).toBe('proxy');
    expect(networkFor({ network: true }, { mode: 'auto' }, 'shared_per_command')).toBe('shared');
    expect(networkFor({}, { mode: 'full-access' }, 'proxy')).toBe('proxy');
    expect(networkFor({}, { mode: 'full-access' }, 'shared_per_command')).toBe('off');
    expect(networkFor({}, { mode: 'auto' }, 'proxy')).toBe('off');
  });
});

describe('bash tool: run (fake sandbox)', () => {
  let wt: string;
  beforeEach(() => {
    wt = mkdtempSync(join(root, 'wt-'));
    writeFileSync(join(wt, '.env'), 'X=1');
    writeFileSync(join(wt, 'AGENTS.md'), 'x');
  });

  it('builds the spec: readonly profile for allowlisted commands, scrubbed env, masks and sensitive paths', async () => {
    const sandbox = fakeSandboxRunner({ 'git status': { output: 'clean\n' } });
    const ctx = makeCtx({ worktree: wt, sandbox });
    const res = await tool.run(parsed({ command: 'git status', description: 'status' }), ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toBe('clean\n[exit code 0]');
    const spec = sandbox.runs[0];
    expect(spec?.profile).toBe('readonly');
    expect(spec?.network).toBe('off');
    expect(spec?.cacheDir).toBeNull();
    expect(spec?.maskedFiles).toEqual([join(wt, '.env')]);
    expect(spec?.sensitivePaths).toEqual([join(wt, 'AGENTS.md')]);
    expect(spec?.sensitiveWrites).toBe(false);
    expect(Object.keys(spec?.env ?? {}).some((k) => /KEY|SECRET/.test(k))).toBe(false);
    expect(ctx.output).toEqual(['clean\n']);
  });

  it('exec profile with the thread cache, git mounts from GitService, and the proxy when network was approved', async () => {
    const sandbox = fakeSandboxRunner();
    const store = memoryStore();
    store.threads.insert(threadRow({ worktreePath: wt, gitDir: '/repo/.git/worktrees/x', commonDir: '/repo/.git', settings: settings() }));
    const ctx = makeCtx({ worktree: wt, sandbox, store });
    await tool.run(parsed({ command: 'npm install', description: 'install', network: true }), ctx);
    const spec = sandbox.runs[0];
    expect(spec?.profile).toBe('exec');
    expect(spec?.network).toBe('proxy');
    expect(spec?.cacheDir).toBe(join(root, 'data', 'cache', 'th1'));
    expect(spec?.git?.readOnly).toEqual(['/repo/.git']);
    expect(spec?.env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
  });

  it('without a thread record a .git inside the worktree is still mounted read-only', async () => {
    mkdirSync(join(wt, '.git'));
    const sandbox = fakeSandboxRunner();
    await tool.run(parsed({ command: 'make', description: 'build' }), makeCtx({ worktree: wt, sandbox }));
    expect(sandbox.runs[0]?.git).toEqual({ readOnly: [join(wt, '.git')], writable: [], env: {}, perThreadRefs: false });
  });

  it('refuses network when the thread has it off (unless full-access)', async () => {
    const sandbox = fakeSandboxRunner();
    const res = await tool.run(parsed({ command: 'npm i', description: 'i', network: true }), makeCtx({ worktree: wt, sandbox, settings: { network: 'off' } }));
    expect(res).toMatchObject({ ok: false, errorKind: 'denied' });
    expect(sandbox.runs).toHaveLength(0);
  });

  it('refuses a cwd outside the worktree, including through a symlink', async () => {
    symlinkSync('/etc', join(wt, 'escape'));
    for (const cwd of ['..', '/etc', 'escape', 'missing']) {
      const res = await tool.run(parsed({ command: 'ls', description: '', cwd }), makeCtx({ worktree: wt }));
      expect(res.errorKind, cwd).toBe('invalid_args');
    }
  });

  it('honours a one-shot "allow writes to sensitive files" grant for that call only', async () => {
    const grants = createCallGrants();
    const t = createShellTool({ grants, hostEnv: { PATH: '/usr/bin', HOME: '/home/u' } });
    const sandbox = fakeSandboxRunner();
    grants.note('tc_GRANT', { kind: 'allow_once', sensitiveWrites: true });
    await t.run(parsed({ command: 'husky install', description: '' }), makeCtx({ worktree: wt, sandbox, callId: 'tc_GRANT' }));
    await t.run(parsed({ command: 'husky install', description: '' }), makeCtx({ worktree: wt, sandbox, callId: 'tc_GRANT' }));
    expect(sandbox.runs.map((s) => s.sensitiveWrites)).toEqual([true, false]);
  });

  it('reports non-zero exits as failures without an error kind, and timeouts as timeouts', async () => {
    const sandbox = fakeSandboxRunner({ 'npm test': { exitCode: 1, output: 'FAIL\n' }, 'sleep 99': { exitCode: null, signal: 'SIGKILL', timedOut: true } });
    const a = await tool.run(parsed({ command: 'npm test', description: '' }), makeCtx({ worktree: wt, sandbox }));
    expect(a).toMatchObject({ ok: false, errorKind: null, exitCode: 1 });
    expect(a.content).toContain('[exit code 1]');
    const b = await tool.run(parsed({ command: 'sleep 99', description: '', timeout_ms: 2000 }), makeCtx({ worktree: wt, sandbox }));
    expect(b).toMatchObject({ ok: false, errorKind: 'timeout' });
    expect(b.content).toContain('timed out after 2 s');
  });

  it('long output: head 200 + tail 800 lines with the spill marker (§7.3)', async () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i + 1}`).join('\n');
    const sandbox = fakeSandboxRunner({ 'seq 5000': { output: `${lines}\n`, outputBytes: lines.length + 1 } });
    const res = await tool.run(parsed({ command: 'seq 5000', description: '' }), makeCtx({ worktree: wt, sandbox, callId: 'tc_SPILL' }));
    expect(res.spillId).toBe('tc_SPILL');
    expect(res.content).toContain('[showing lines 1-200 and 4,201-5,000 of 5,000; full output: spill:tc_SPILL (use read on it)]');
    expect(res.content).toContain('line 200\n[showing');
    expect(res.content).not.toContain('line 201\n');
    expect(res.content).toContain('line 4201\n');
    expect(res.preview.spillId).toBe('tc_SPILL');
  });

  it('a change to an execution-sensitive file raises a notice and an effect', async () => {
    const store = memoryStore();
    store.threads.insert(threadRow({ worktreePath: wt, gitDir: '/r/.git/worktrees/x', commonDir: '/r/.git', settings: settings() }));
    const git = fakeGitService();
    let n = 0;
    git.sensitiveHashes = async () => ({ '.husky/pre-commit': n++ === 0 ? 'aaa' : 'bbb', 'AGENTS.md': 'same' });
    const res = await tool.run(parsed({ command: 'npx husky install', description: '' }), makeCtx({ worktree: wt, store, git }));
    expect(res.effects?.changedPaths).toEqual(['.husky/pre-commit']);
    expect(res.content).toContain('[execution-sensitive files changed: .husky/pre-commit]');
    // Review H2: no internal event (it took a thread_seq the renderer never saw); the loop shows a public notice.
    expect(res.effects?.sensitiveChanged).toEqual(['.husky/pre-commit']);
    expect(store.events.list('th1', { types: ['notice'] })).toEqual([]);
  });

  it('notes when it ran without a sandbox', async () => {
    const none: CodeState['sandbox'] = { kind: 'none', ok: false, detail: 'x', network: 'none' };
    const res = await tool.run(parsed({ command: 'npm test', description: '' }), makeCtx({ worktree: wt, sandbox: fakeSandboxRunner({}, none) }));
    expect(res.content).toContain('ran without a sandbox');
  });
});

describe('truncateShellOutput', () => {
  it('clips long lines and caps bytes', () => {
    const r = truncateShellOutput(`${'x'.repeat(3000)}\nok`, null, 3003, false);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('[… line truncated]');
    const big = truncateShellOutput(Array.from({ length: 900 }, () => 'y'.repeat(1500)).join('\n'), 'tc_1', 1_350_000, false);
    expect(Buffer.byteLength(big.text)).toBeLessThan(60 * 1024);
    expect(big.text).toContain('spill:tc_1');
  });
});

describe.skipIf(!HAS_BWRAP)('bash tool: live in bwrap', () => {
  it('runs through the real runner: .env masked, writes stay in the worktree, git metadata read-only', async () => {
    const fx = makeRepo('gmid-shell-live-');
    try {
      const t = fx.addThread('cccccc');
      const store = memoryStore();
      store.threads.insert(threadRow({ worktreePath: t.worktree, gitDir: t.gitDir, commonDir: fx.common, settings: settings() }));
      const git = fakeGitService();
      git.sandboxMounts = async () => t.mounts;
      const runner = createSandboxRunner({ platform: 'linux', dataDir: fx.dataDir, log: memoryLog() });
      const ctx = makeCtx({ worktree: t.worktree, store, git, sandbox: runner });
      const shell = createShellTool({ hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME, GMI_API_KEY: 'leak' } });
      const res = await shell.run(parsed({ command: "cat .env; echo made > made.txt; (echo x > .git) 2>/dev/null || echo POINTER_RO; env | grep -c GMI_API_KEY; true", description: 'probe' }), ctx);
      expect(res.ok).toBe(true);
      expect(res.content).not.toContain('hunter2');
      expect(res.content).toContain('POINTER_RO');
      expect(res.content).toMatch(/^0$/m);
      expect(readFileSync(join(t.worktree, 'made.txt'), 'utf8')).toBe('made\n');
      const st = await shell.run(parsed({ command: 'git status --short', description: 'status' }), ctx);
      expect(st.ok).toBe(true);
      expect(st.content).toContain('made.txt');
      await runner.close();
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
