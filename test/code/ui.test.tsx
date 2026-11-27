import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, CodeProject, CodeState, CodeThread, CodeThreadSummary, DiffFile, McpServerStatus, PermissionRule, TimelineItem } from '@shared/contracts/code';
import type { GmiBridge } from '@shared/contracts';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() }, Toaster: () => null }));

import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { defaultCodeThreadSettings } from '@shared/contracts/code';
import CodePage from '@renderer/pages/code';
import CodeSettings from '@renderer/pages/code/settings';
import { CodePage as RegisteredPage } from '@renderer/pages/registry.code';

const AT = '2026-11-03T14:21:00.000Z';

const PROJECT: CodeProject = {
  id: 'prj_1',
  name: 'gmi-desk',
  rootPath: '/home/demo/gmi-desk',
  defaultBranch: 'main',
  trust: { state: 'trusted', configHash: 'h', trustedAt: AT },
  worktreeDir: '/home/demo/worktrees',
  setupCommand: null,
  addedAt: AT,
  threadCount: 1,
};

const APPROVAL: ApprovalRequest = {
  requestId: 'apr_1',
  threadId: 'thr_1',
  runId: 'run_1',
  toolCallId: 'c1',
  kind: 'command',
  tool: 'shell',
  title: 'Run the test suite',
  detail: { command: 'npm test' },
  risk: [],
  suggestedRule: { tool: 'shell', pattern: 'npm test', effect: 'allow', scope: 'thread' },
  allowedDecisions: ['allow_once', 'allow_thread', 'allow_always', 'deny', 'cancel_run'],
  createdAt: AT,
  expiresAt: null,
};

const THREAD: CodeThread = {
  id: 'thr_1',
  projectId: 'prj_1',
  title: 'Fix the streaming parser',
  strategy: 'worktree',
  branch: 'gmi/000001/fix-stream',
  worktreePath: '/home/demo/worktrees/000001',
  status: 'awaiting_approval',
  statusReason: null,
  pendingApprovals: 1,
  queuePosition: null,
  queueReason: null,
  model: 'deepseek-ai/deepseek-v3.1',
  mode: 'auto-accept-edits',
  costUsd: 0.42,
  tokens: { input: 48_210, cached: 31_004, output: 7_912, reasoning: 2_140 },
  diff: { files: 1, additions: 4, deletions: 1 },
  createdAt: AT,
  updatedAt: AT,
  archived: false,
  settings: defaultCodeThreadSettings({ model: 'deepseek-ai/deepseek-v3.1' }),
  baseRef: 'main',
  checkpoints: [],
  todo: [{ id: 't1', text: 'Flush the tail', status: 'in_progress' }],
  meter: { windowTokens: 163_840, ceilingTokens: 160_000, usedTokens: 48_210, reserveTokens: 16_384, cachedRatio: 0.64, compactions: 0, tierBoundaryTokens: null, messageCount: 12, nextStepUsd: 0.004, estimated: false },
  lastSeq: 3,
};

const SUMMARY: CodeThreadSummary = (({ settings: _s, baseRef: _b, checkpoints: _c, todo: _t, meter: _m, lastSeq: _l, ...rest }) => rest)(THREAD);

const ITEMS: TimelineItem[] = [
  { kind: 'user', id: 'u1', seq: 1, turn: 1, text: 'Find the dropped tail', steering: false, at: AT },
  { kind: 'assistant', id: 'a1', seq: 2, turn: 1, step: 1, text: 'I added a flush and a regression test.', reasoning: null, model: THREAD.model, usage: null, status: 'complete', at: AT },
  { kind: 'approval', id: 'p1', seq: 3, request: APPROVAL, decision: null },
];

const DIFF: DiffFile[] = [{ path: 'src/streaming/parser.ts', oldPath: null, status: 'modified', additions: 4, deletions: 1, sensitive: false, hunks: null, tooLarge: false }];

const STATE: CodeState = {
  hostState: 'ready',
  viewOnly: false,
  sandbox: { kind: 'bwrap', ok: true, detail: null, network: 'proxy' },
  git: { ok: true, version: '2.43.0' },
  ripgrep: true,
  gateway: { online: true, tpmLimit: 1_000_000, tpmEffective: 1_000_000, tpmUsedLastMinute: 0, queued: 0, inFlight: 0, models: [], cacheHitRatio24h: null, last429At: null, updatedAt: AT },
  pendingApprovals: 1,
  mock: true,
};

const RULES: PermissionRule[] = [{ id: 'r1', tool: 'shell', pattern: 'npm test', effect: 'allow', scope: 'project', projectId: 'prj_1', threadId: null, source: 'user', createdAt: AT }];

const MCP: McpServerStatus[] = [
  {
    id: 'mcp_1',
    name: 'Filesystem',
    scope: 'global',
    projectId: null,
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@1.0.0', '/home/demo'], envNames: [], cwd: null, network: false },
    enabled: true,
    toolPolicy: {},
    state: 'stopped',
    resolvedVersion: null,
    unpinned: false,
    tools: [{ name: 'read_file', changed: false, policy: 'ask' }],
    error: null,
  },
];

function client(seed: { project?: CodeProject } = {}): QueryClient {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  c.setQueryData(qk.codeState, STATE);
  c.setQueryData(qk.codeProjects, [seed.project ?? PROJECT]);
  c.setQueryData([...qk.codeThreads, 'prj_1'], [SUMMARY]);
  c.setQueryData(qk.codeThread('thr_1'), THREAD);
  c.setQueryData(qk.codeTimeline('thr_1'), { items: ITEMS, hasMore: false, lastSeq: 3 });
  c.setQueryData(qk.codeApprovals, [APPROVAL]);
  c.setQueryData(qk.codeDiff('thr_1'), DIFF);
  c.setQueryData(qk.codeRules, RULES);
  c.setQueryData(qk.codeMcp, MCP);
  return c;
}

const render = (node: ReactNode, seed: { project?: CodeProject } = {}) =>
  renderToStaticMarkup(<QueryClientProvider client={client(seed)}>{node}</QueryClientProvider>);

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

beforeEach(() => {
  const bridge: GmiBridge = { invoke: async () => ({ ok: true, data: null }), on: () => () => undefined, platform: 'linux' };
  (globalThis as { window?: unknown }).window = { gmi: bridge, setInterval, clearInterval, setTimeout, clearTimeout };
  useUi.setState({ page: 'code', params: {} });
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  useUi.setState({ page: 'chat', params: {} });
});

describe('registration', () => {
  it('registry.code.ts serves this page, not the stub', () => {
    expect(RegisteredPage).toBe(CodePage);
  });
});

describe('Code page', () => {
  it('shows the thread rail, the timeline, the pending approval and the review panel', () => {
    const html = render(<CodePage />);
    const t = text(html);
    expect(t).toContain('Fix the streaming parser');
    expect(t).toContain('gmi/000001/fix-stream');
    expect(t).toContain('Waiting for you');
    expect(t).toContain('I added a flush and a regression test.');
    expect(t).toContain('Run the test suite');
    expect(t).toContain('npm test');
    expect(t).toContain('Allow once');
    // Diff rows: the folder truncates before the file name; the full path is the row's title.
    expect(html).toContain('title="src/streaming/parser.ts"');
    expect(t).toContain('parser.ts');
    expect(t).toContain('Review');
    expect(t).toContain('Commit');
    expect(t).toContain('Export patch');
    expect(t).toContain('Demo');
    expect(t).not.toMatch(/<select[\s>]|<option[\s>]/);
  });

  it('one lime action in view: the pending approval (new thread is a quiet icon, the empty composer key is grey)', () => {
    const html = render(<CodePage />);
    const enabledLime = (html.match(/<button[^>]*>/g) ?? []).filter((b) => /class="[^"]*\bbg-primary text-primary-foreground\b/.test(b) && !/\sdisabled=""/.test(b));
    expect(enabledLime).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*bg-primary text-primary-foreground[^>]*>Allow once<\/button>/);
    // New thread sits beside the project picker as a ghost icon button, not a full-width lime bar.
    const newThread = /<button[^>]*aria-label="New thread"[^>]*>/.exec(html)?.[0] ?? '';
    expect(newThread).toContain('text-muted-foreground');
    expect(newThread).not.toContain('bg-primary ');
    // The selected thread row carries the app's selection bar and switches instantly.
    expect(html).toMatch(/<button[^>]*aria-current="true"[^>]*transition-none[^>]*><span aria-hidden="true" data-active-bar="inset"/);
  });

  it('asks to trust a project before agents run', () => {
    const untrusted: CodeProject = { ...PROJECT, trust: { state: 'changed', configHash: 'other', trustedAt: AT } };
    const t = text(render(<CodePage />, { project: untrusted }));
    expect(t).toContain('Project configuration changed');
    expect(t).toContain('Review and trust');
    expect(t).not.toContain('Run the test suite');
  });
});

describe('Settings › Code', () => {
  it('shows the sandbox, rules and MCP servers', () => {
    const t = text(render(<CodeSettings />));
    expect(t).toContain('Sandbox');
    expect(t).toContain('bwrap · ready');
    expect(t).toContain('Re-run self-test');
    expect(t).toContain('Permission rules');
    expect(t).toContain('npm test');
    expect(t).toContain('MCP servers');
    expect(t).toContain('Filesystem');
    expect(t).toContain('read_file');
    expect(t).toContain('Add MCP server');
  });
});
