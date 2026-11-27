import { beforeEach, describe, expect, it } from 'vitest';
import type { CodeState, CodeThreadSettings, PermissionRule, RiskFlag, RuntimeMode } from '@shared/contracts/code';
import { createPermissionEngine, type HarnessPermissionEngine } from '@harness/perm/engine';
import type { PermissionContext, PermissionSubject, Store } from '@harness/types';
import { fakeClock, memoryStore, sampleApproval } from '../fakes';
import { settings, T0, threadRow } from './helpers';

const WT = '/work/wt';
const HOME = '/home/u';
const OK_SANDBOX: CodeState['sandbox'] = { kind: 'bwrap', ok: true, detail: null, network: 'proxy' };
const NO_SANDBOX: CodeState['sandbox'] = { kind: 'none', ok: false, detail: 'x', network: 'none' };
const NO_PROXY: CodeState['sandbox'] = { kind: 'bwrap', ok: true, detail: null, network: 'shared_per_command' };

let store: Store;
let engine: HarnessPermissionEngine;

function setup(threadSettings: Partial<CodeThreadSettings> = {}, extra: { webAllow?: string[]; mcp?: Record<string, 'allow' | 'ask' | 'deny'> } = {}) {
  store = memoryStore();
  store.threads.insert(threadRow({ settings: settings(threadSettings) }));
  engine = createPermissionEngine({
    store,
    clock: fakeClock(Date.parse(T0)),
    env: { home: HOME, userData: `${HOME}/.config/GMI Desk`, platform: 'linux' },
    webAllowlist: () => extra.webAllow ?? [],
    mcpPolicy: (server, tool) => extra.mcp?.[`${server}/${tool}`] ?? null,
  });
}

function ctx(mode: RuntimeMode = 'auto-accept-edits', over: Partial<PermissionContext> = {}): PermissionContext {
  return { threadId: 'th1', projectId: 'p1', runId: 'run_1', mode, unattended: false, sandbox: OK_SANDBOX, worktree: WT, ...over };
}

const bash = (command: string, network = false): PermissionSubject => ({ tool: 'bash', kind: network ? 'network' : 'command', title: command, command, cwd: WT, risk: [] });
const edit = (path: string, risk: RiskFlag[] = []): PermissionSubject => ({ tool: 'edit', kind: 'file-change', title: 'edit', paths: [path], risk });
const read = (path: string): PermissionSubject => ({ tool: 'read', kind: 'file-read', title: 'read', paths: [path], risk: [] });
const web = (host: string): PermissionSubject => ({ tool: 'web_fetch', kind: 'network', title: 'fetch', host, url: `https://${host}/`, risk: ['network'] });
const mcp = (server: string, tool: string, risk: RiskFlag[] = []): PermissionSubject => ({ tool: `mcp__${server}__${tool}`, kind: 'mcp', title: tool, server, args: { q: 1 }, risk });

function rule(over: Partial<PermissionRule>): PermissionRule {
  return { id: `rule_${Math.random().toString(36).slice(2)}`, tool: 'bash', pattern: null, effect: 'allow', scope: 'project', projectId: 'p1', threadId: null, source: 'user', createdAt: T0, ...over };
}

type Case = [name: string, subject: PermissionSubject, mode: RuntimeMode, expected: 'allow' | 'ask' | 'deny', opts?: { sandbox?: CodeState['sandbox']; settings?: Partial<CodeThreadSettings>; rules?: Array<Partial<PermissionRule>>; unattended?: boolean; profile?: 'readonly' | 'exec' | null; risk?: RiskFlag; webAllow?: string[]; mcp?: Record<string, 'allow' | 'ask' | 'deny'> }];

const CASES: Case[] = [
  // ── Mode table: file edits
  ['edit in approval-required asks', edit(`${WT}/src/a.ts`), 'approval-required', 'ask'],
  ['edit in auto-accept-edits allowed', edit(`${WT}/src/a.ts`), 'auto-accept-edits', 'allow'],
  ['edit in auto allowed', edit(`${WT}/src/a.ts`), 'auto', 'allow'],
  ['edit in full-access allowed', edit(`${WT}/src/a.ts`), 'full-access', 'allow'],
  ['sensitive edit asks in auto-accept-edits', edit(`${WT}/.husky/pre-commit`, ['execution_sensitive']), 'auto-accept-edits', 'ask'],
  ['sensitive edit asks in auto', edit(`${WT}/AGENTS.md`, ['execution_sensitive']), 'auto', 'ask'],
  ['sensitive edit allowed in full-access', edit(`${WT}/AGENTS.md`, ['execution_sensitive']), 'full-access', 'allow'],
  ['outside-worktree edit asks', edit('/work/other/a.ts', ['outside_worktree']), 'auto', 'ask'],
  // ── Reads
  ['read allowed in approval-required', read(`${WT}/src/a.ts`), 'approval-required', 'allow'],
  ['read allowed in auto-accept-edits', read(`${WT}/README.md`), 'auto-accept-edits', 'allow'],
  // ── Hard denies (never overridable)
  ['read .env hard-denied', read(`${WT}/.env`), 'full-access', 'deny', { risk: 'secret_path' }],
  ['read .env.local hard-denied', read(`${WT}/.env.local`), 'auto', 'deny'],
  ['read .env.example allowed', read(`${WT}/.env.example`), 'auto', 'allow'],
  ['read *.pem hard-denied', read(`${WT}/certs/server.pem`), 'full-access', 'deny'],
  ['read *.key hard-denied', read(`${WT}/k.key`), 'auto', 'deny'],
  ['read id_rsa hard-denied', read(`${WT}/id_rsa`), 'auto', 'deny'],
  ['read id_ed25519.pub hard-denied', read(`${WT}/id_ed25519.pub`), 'auto', 'deny'],
  ['read .npmrc hard-denied', read(`${WT}/.npmrc`), 'auto', 'deny'],
  ['read .netrc hard-denied', read(`${WT}/.netrc`), 'auto', 'deny'],
  ['read .pypirc hard-denied', read(`${WT}/.pypirc`), 'auto', 'deny'],
  ['read .git-credentials hard-denied', read(`${WT}/.git-credentials`), 'auto', 'deny'],
  ['read ~/.ssh hard-denied', read(`${HOME}/.ssh/config`), 'full-access', 'deny'],
  ['read ~/.aws hard-denied', read(`${HOME}/.aws/credentials`), 'full-access', 'deny'],
  ['read ~/.gnupg hard-denied', read(`${HOME}/.gnupg/x`), 'full-access', 'deny'],
  ['read ~/.config/gh hard-denied', read(`${HOME}/.config/gh/hosts.yml`), 'full-access', 'deny'],
  ['read ~/.factory hard-denied', read(`${HOME}/.factory/auth.json`), 'full-access', 'deny'],
  ['read ~/.claude.json hard-denied', read(`${HOME}/.claude.json`), 'full-access', 'deny'],
  ['read userData hard-denied', read(`${HOME}/.config/GMI Desk/secure/key.bin`), 'full-access', 'deny'],
  ['write .git/config hard-denied', edit(`${WT}/.git/config`), 'full-access', 'deny'],
  ['write the .git pointer hard-denied', edit(`${WT}/.git`), 'full-access', 'deny'],
  ['read .git/HEAD allowed', read(`${WT}/.git/HEAD`), 'auto', 'allow'],
  ['allow rule cannot beat a hard deny', read(`${WT}/.env`), 'auto', 'deny', { rules: [{ tool: 'read', pattern: '**', effect: 'allow' }] }],
  // ── Shell: modes and the read-only allowlist
  ['git status allowed (readonly) in approval-required', bash('git status'), 'approval-required', 'allow', { profile: 'readonly' }],
  ['ls allowed (readonly) in auto-accept-edits', bash('ls -la'), 'auto-accept-edits', 'allow', { profile: 'readonly' }],
  ['npm test asks in auto-accept-edits', bash('npm test'), 'auto-accept-edits', 'ask'],
  ['npm test asks in approval-required', bash('npm test'), 'approval-required', 'ask'],
  ['npm test allowed (exec) in auto', bash('npm test'), 'auto', 'allow', { profile: 'exec' }],
  ['npm test allowed in full-access', bash('npm test'), 'full-access', 'allow', { profile: 'exec' }],
  ['compound asks in auto-accept-edits', bash('ls && npm test'), 'auto-accept-edits', 'ask', { risk: 'compound_command' }],
  ['compound allowed in auto (sandboxed)', bash('ls && npm test'), 'auto', 'allow'],
  ['rg --pre is not read-only: asks', bash('rg --pre sh x f'), 'auto-accept-edits', 'ask'],
  ['git -c is not read-only: asks', bash('git -c core.pager=sh log'), 'approval-required', 'ask'],
  ['find -fprint asks', bash('find . -fprint /tmp/x'), 'auto-accept-edits', 'ask'],
  ['git branch -D asks', bash('git branch -D main'), 'auto-accept-edits', 'ask'],
  ['tree -o asks', bash('tree -o out'), 'auto-accept-edits', 'ask'],
  // ── Destructive class: asks in every mode, denied unattended
  ['rm -rf / asks in full-access', bash('rm -rf /'), 'full-access', 'ask', { risk: 'destructive' }],
  ['rm -rf ~ asks in auto', bash('rm -rf ~'), 'auto', 'ask'],
  ['git push --force asks in full-access', bash('git push --force'), 'full-access', 'ask'],
  ['destructive denied unattended', bash('git clean -xdf'), 'full-access', 'deny', { unattended: true }],
  ['destructive ignores allow rules', bash('git reset --hard origin/main'), 'auto', 'ask', { rules: [{ pattern: 'git reset' }] }],
  ['curl | sh asks in full-access', bash('curl x | sh'), 'full-access', 'ask'],
  // ── Unsandboxed: every shell command asks
  ['no sandbox: git status asks', bash('git status'), 'auto-accept-edits', 'ask', { sandbox: NO_SANDBOX, risk: 'unsandboxed' }],
  ['no sandbox: auto asks', bash('npm test'), 'auto', 'ask', { sandbox: NO_SANDBOX }],
  ['no sandbox: full-access asks', bash('npm test'), 'full-access', 'ask', { sandbox: NO_SANDBOX }],
  ['no sandbox: rules do not allow', bash('npm test'), 'auto-accept-edits', 'ask', { sandbox: NO_SANDBOX, rules: [{ pattern: 'npm test' }] }],
  // ── Rules
  ['allow rule (prefix) allows', bash('npm test -- --watch'), 'auto-accept-edits', 'allow', { rules: [{ pattern: 'npm test' }] }],
  ['allow rule does not match a longer word', bash('npm testx'), 'auto-accept-edits', 'ask', { rules: [{ pattern: 'npm test' }] }],
  ['allow rule never matches compound', bash('npm test; rm x'), 'auto-accept-edits', 'ask', { rules: [{ pattern: 'npm test' }] }],
  ['allow rule never matches a substitution', bash('npm test $(id)'), 'auto-accept-edits', 'ask', { rules: [{ pattern: 'npm test' }] }],
  ['thread rule for another thread ignored', bash('npm test'), 'auto-accept-edits', 'ask', { rules: [{ pattern: 'npm test', scope: 'thread', threadId: 'other' }] }],
  ['thread rule for this thread allows', bash('npm test'), 'auto-accept-edits', 'allow', { rules: [{ pattern: 'npm test', scope: 'thread', threadId: 'th1' }] }],
  ['project rule of another project ignored', bash('npm test'), 'auto-accept-edits', 'ask', { rules: [{ pattern: 'npm test', projectId: 'p2' }] }],
  ['global rule allows', bash('npm test'), 'auto-accept-edits', 'allow', { rules: [{ pattern: 'npm test', scope: 'global', projectId: null }] }],
  ['deny rule beats allow rule', bash('npm test'), 'full-access', 'deny', { rules: [{ pattern: 'npm test' }, { pattern: 'npm', effect: 'deny' }] }],
  ['deny rule matches a segment of a compound command', bash('ls && npm publish'), 'full-access', 'deny', { rules: [{ pattern: 'npm publish', effect: 'deny' }] }],
  ['deny rule matches inside a substitution', bash('echo "$(npm publish)"'), 'full-access', 'deny', { rules: [{ pattern: 'npm publish', effect: 'deny' }] }],
  ['deny glob rule', bash('docker run x'), 'full-access', 'deny', { rules: [{ pattern: 'docker *', effect: 'deny' }] }],
  ['wildcard tool deny rule', edit(`${WT}/a.ts`), 'full-access', 'deny', { rules: [{ tool: '*', pattern: 'a.ts', effect: 'deny' }] }],
  ['path allow rule', edit(`${WT}/src/x/a.ts`), 'approval-required', 'allow', { rules: [{ tool: 'edit', pattern: 'src/**' }] }],
  ['path allow rule outside its dir', edit(`${WT}/lib/a.ts`), 'approval-required', 'ask', { rules: [{ tool: 'edit', pattern: 'src/**' }] }],
  ['path deny rule', edit(`${WT}/vendor/a.ts`), 'full-access', 'deny', { rules: [{ tool: 'edit', pattern: 'vendor/**', effect: 'deny' }] }],
  // ── Network (shell)
  ['shell network asks in auto', bash('npm install', true), 'auto', 'ask', { risk: 'network' }],
  ['shell network allowed in full-access', bash('npm install', true), 'full-access', 'allow', { profile: 'exec' }],
  ['shell network off → deny', bash('npm install', true), 'auto', 'deny', { settings: { network: 'off' } }],
  ['plain rule does not grant network', bash('npm install', true), 'auto', 'ask', { rules: [{ pattern: 'npm install' }] }],
  ['net: rule grants network', bash('npm install', true), 'auto-accept-edits', 'allow', { rules: [{ pattern: 'net:npm install' }] }],
  ['net: rule also covers the command without network', bash('npm install'), 'auto-accept-edits', 'allow', { rules: [{ pattern: 'net:npm install' }] }],
  ['no proxy: network asks with local_network even in full-access', bash('npm install', true), 'full-access', 'ask', { sandbox: NO_PROXY, risk: 'local_network' }],
  ['no proxy: net: rule does not allow', bash('npm install', true), 'auto', 'ask', { sandbox: NO_PROXY, rules: [{ pattern: 'net:npm install' }] }],
  // ── Web fetch
  ['web off → deny', web('example.com'), 'full-access', 'deny', { settings: { webFetch: 'off' } }],
  ['web ask → ask', web('example.com'), 'auto', 'ask'],
  ['web allowlist default host → allow', web('nodejs.org'), 'auto-accept-edits', 'allow', { settings: { webFetch: 'allowlist' } }],
  ['web allowlist project host → allow', web('docs.example.dev'), 'auto-accept-edits', 'allow', { settings: { webFetch: 'allowlist' }, webAllow: ['*.example.dev'] }],
  ['web allowlist unknown host → ask', web('evil.example'), 'auto-accept-edits', 'ask', { settings: { webFetch: 'allowlist' } }],
  ['web full-access → allow', web('evil.example'), 'full-access', 'allow'],
  ['web host rule → allow', web('example.com'), 'auto', 'allow', { rules: [{ tool: 'web_fetch', pattern: 'example.com' }] }],
  ['web host rule for another host', web('example.org'), 'auto', 'ask', { rules: [{ tool: 'web_fetch', pattern: 'example.com' }] }],
  // ── MCP and paid tools
  ['mcp asks by default', mcp('github', 'search'), 'auto', 'ask'],
  ['mcp server policy allow', mcp('github', 'search'), 'auto-accept-edits', 'allow', { mcp: { 'github/mcp__github__search': 'allow' } }],
  ['mcp server policy allow still asks in approval-required', mcp('github', 'search'), 'approval-required', 'ask', { mcp: { 'github/mcp__github__search': 'allow' } }],
  ['mcp server policy deny', mcp('github', 'search'), 'full-access', 'deny', { mcp: { 'github/mcp__github__search': 'deny' } }],
  ['mcp full-access allowed', mcp('github', 'search'), 'full-access', 'allow'],
  ['costs_money asks in full-access', mcp('gmi', 'submit_generation', ['costs_money']), 'full-access', 'ask'],
  ['costs_money ignores allow rules', mcp('gmi', 'submit_generation', ['costs_money']), 'auto', 'ask', { rules: [{ tool: 'mcp__gmi__submit_generation' }] }],
  ['costs_money denied unattended', mcp('gmi', 'submit_generation', ['costs_money']), 'full-access', 'deny', { unattended: true }],
  // ── Unattended
  ['unattended ask → deny', bash('npm test'), 'auto-accept-edits', 'deny', { unattended: true }],
  ['unattended allow stays allow', bash('git status'), 'auto-accept-edits', 'allow', { unattended: true }],
];

describe('permission engine (§9 table)', () => {
  it.each(CASES)('%s', (_name, subject, mode, expected, opts = {}) => {
    setup(opts.settings, { webAllow: opts.webAllow, mcp: opts.mcp });
    for (const r of opts.rules ?? []) store.rules.insert(rule(r));
    const v = engine.evaluate(subject, ctx(mode, { sandbox: opts.sandbox ?? OK_SANDBOX, unattended: opts.unattended ?? false }));
    expect(v.effect).toBe(expected);
    if (opts.profile !== undefined && v.effect === 'allow') expect(v.profile).toBe(opts.profile);
    if (opts.risk) expect(v.risk).toContain(opts.risk);
  });

  it('has about 80 cases or more', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(80);
  });
});

describe('suggested rules', () => {
  beforeEach(() => setup());

  it('suggests a command prefix, never a wildcard', () => {
    const v = engine.evaluate(bash('npm test -- --watch'), ctx());
    expect(v.effect).toBe('ask');
    if (v.effect === 'ask') expect(v.suggestedRule).toEqual({ tool: 'bash', pattern: 'npm test', effect: 'allow', scope: 'project' });
  });

  it('suggests a net: prefix for network commands', () => {
    const v = engine.evaluate(bash('npm install left-pad', true), ctx());
    if (v.effect === 'ask') expect(v.suggestedRule?.pattern).toBe('net:npm install');
    else throw new Error('expected ask');
  });

  it('suggests nothing for compound, destructive, paid and local-network requests', () => {
    for (const [s, c] of [
      [bash('ls && rm x'), ctx()],
      [bash('rm -rf /'), ctx()],
      [mcp('gmi', 'submit_generation', ['costs_money']), ctx()],
      [bash('npm i', true), ctx('auto', { sandbox: NO_PROXY })],
    ] as Array<[PermissionSubject, PermissionContext]>) {
      const v = engine.evaluate(s, c);
      expect(v.effect).toBe('ask');
      if (v.effect === 'ask') expect(v.suggestedRule).toBeNull();
    }
  });

  it('suggests the directory glob for edits and the host for web', () => {
    const e = engine.evaluate(edit(`${WT}/src/deep/a.ts`), ctx('approval-required'));
    if (e.effect === 'ask') expect(e.suggestedRule?.pattern).toBe('src/deep/**');
    const w = engine.evaluate(web('Example.COM'), ctx());
    if (w.effect === 'ask') expect(w.suggestedRule?.pattern).toBe('example.com');
  });
});

describe('record()', () => {
  beforeEach(() => setup());

  it('allow_thread stores a thread rule with the suggested pattern', () => {
    const r = engine.record(sampleApproval({ threadId: 'th1' }), { kind: 'allow_thread' }, ctx());
    expect(r).toMatchObject({ tool: 'bash', pattern: 'npm test', scope: 'thread', threadId: 'th1', projectId: 'p1', effect: 'allow', source: 'user' });
    expect(engine.evaluate(bash('npm test'), ctx()).effect).toBe('allow');
    expect(engine.evaluate(bash('npm test'), { ...ctx(), threadId: 'th2' }).effect).toBe('ask');
  });

  it('allow_thread without a suggested pattern stores nothing (never "any command")', () => {
    expect(engine.record(sampleApproval({ suggestedRule: null }), { kind: 'allow_thread' }, ctx())).toBeNull();
    expect(engine.listRules()).toHaveLength(0);
  });

  it('allow_always stores the rule; a wildcard or other tool is refused', () => {
    const r = engine.record(sampleApproval(), { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm test', effect: 'allow', scope: 'global' } }, ctx());
    expect(r).toMatchObject({ scope: 'global', projectId: null });
    expect(() => engine.record(sampleApproval(), { kind: 'allow_always', rule: { tool: '*', pattern: null, effect: 'allow', scope: 'global' } }, ctx())).toThrow(/exactly the requested tool/);
    expect(() => engine.record(sampleApproval(), { kind: 'allow_always', rule: { tool: 'edit', pattern: null, effect: 'allow', scope: 'project' } }, ctx())).toThrow();
  });

  it('one-shot kinds (costs_money, destructive, local_network) never become standing grants', () => {
    for (const risk of ['costs_money', 'destructive', 'local_network'] as RiskFlag[]) {
      expect(engine.record(sampleApproval({ risk: [risk] }), { kind: 'allow_thread' }, ctx())).toBeNull();
      expect(engine.record(sampleApproval({ risk: [risk] }), { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm test', effect: 'allow', scope: 'project' } }, ctx())).toBeNull();
    }
    expect(engine.listRules()).toHaveLength(0);
  });

  it('allow_once, deny and answers store nothing', () => {
    expect(engine.record(sampleApproval(), { kind: 'allow_once' }, ctx())).toBeNull();
    expect(engine.record(sampleApproval(), { kind: 'deny', feedback: 'no' }, ctx())).toBeNull();
  });

  it('deleteRule removes a stored rule', () => {
    const r = engine.record(sampleApproval(), { kind: 'allow_thread' }, ctx());
    expect(engine.deleteRule(r?.id ?? '')).toBe(true);
    expect(engine.evaluate(bash('npm test'), ctx()).effect).toBe('ask');
  });
});

describe('project-file rules (§9.1: deny only)', () => {
  beforeEach(() => setup());

  it('keeps denies and ignores allows (a repo cannot pre-approve itself)', () => {
    const ignored = engine.loadProjectRules('p1', [
      { tool: 'bash', pattern: 'npm publish', effect: 'deny', scope: 'project' },
      { tool: 'bash', pattern: 'curl', effect: 'allow', scope: 'project' },
      { tool: '*', pattern: null, effect: 'allow', scope: 'global' },
    ]);
    expect(ignored).toHaveLength(2);
    expect(engine.projectRules('p1')).toHaveLength(1);
    expect(engine.evaluate(bash('npm publish'), ctx('full-access')).effect).toBe('deny');
    expect(engine.evaluate(bash('curl x'), ctx()).effect).toBe('ask');
    expect(engine.listRules({ projectId: 'p1' }).some((r) => r.source === 'project_file')).toBe(true);
  });

  it('a project-file deny applies to its project only', () => {
    engine.loadProjectRules('p2', [{ tool: 'bash', pattern: 'npm publish', effect: 'deny', scope: 'project' }]);
    expect(engine.evaluate(bash('npm publish'), ctx('full-access')).effect).toBe('allow');
  });

  it('reloading replaces the project rules', () => {
    engine.loadProjectRules('p1', [{ tool: 'bash', pattern: 'npm publish', effect: 'deny', scope: 'project' }]);
    engine.loadProjectRules('p1', []);
    expect(engine.evaluate(bash('npm publish'), ctx('full-access')).effect).toBe('allow');
  });
});

describe('darwin case folding', () => {
  it('hard-denies .ENV and ~/.SSH on darwin', () => {
    const s = memoryStore();
    s.threads.insert(threadRow());
    const e = createPermissionEngine({ store: s, clock: fakeClock(0), env: { home: HOME, userData: null, platform: 'darwin' } });
    expect(e.evaluate(read(`${WT}/.ENV`), ctx('full-access')).effect).toBe('deny');
    expect(e.evaluate(read(`${HOME}/.SSH/id`), ctx('full-access')).effect).toBe('deny');
  });
});
