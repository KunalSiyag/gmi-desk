// H2-A Store: the SQLite store has the semantics of the conforming fake (memoryStore, test/harness/fakes.ts) —
// checked differentially, operation by operation — plus what only the database gives: rollback, savepoints,
// constraint errors as GmiError, whole-thread deletion and the project cascade.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalRequest, PermissionRule } from '@shared/contracts/code';
import { GmiError } from '@shared/contracts/errors';
import type { SqliteStore } from '@harness/store';
import { contextIdOf, type ApprovalRow, type Store } from '@harness/types';
import { fakeClock, memoryStore, type FakeClock } from '../fakes';
import { messageRow, openTestStore, projectRow, tempDir, threadRow, toolCallRow, type TempDir } from './helpers';

const A = 'thr_a';
const B = 'thr_b';
const CA = contextIdOf(A);
const CB = contextIdOf(B);
const CHILD = 'run_child_1';

function approvalRow(requestId: string, threadId: string, over: Partial<ApprovalRow> = {}): ApprovalRow {
  const request: ApprovalRequest = {
    requestId,
    threadId,
    runId: 'run_1',
    toolCallId: null,
    kind: 'command',
    tool: 'bash',
    title: 'npm install',
    detail: { command: 'npm install', cwd: '/tmp/gmi-desk-fixture/wt' },
    risk: ['network'],
    suggestedRule: { tool: 'bash', pattern: 'npm install', effect: 'allow', scope: 'thread' },
    allowedDecisions: ['allow_once', 'allow_thread', 'deny'],
    createdAt: '2026-11-02T10:00:00.000Z',
    expiresAt: null,
  };
  return { requestId, threadId, runId: 'run_1', toolCallId: null, kind: 'command', request, decision: null, decidedAt: null, ...over };
}

function rule(id: string, over: Partial<PermissionRule> = {}): PermissionRule {
  return { id, tool: 'bash', pattern: 'npm test', effect: 'allow', scope: 'global', projectId: null, threadId: null, source: 'user', createdAt: '2026-11-02T10:00:00.000Z', ...over };
}

const outcome = (fn: () => unknown): unknown => {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: error instanceof GmiError ? error.code : String(error) };
  }
};

/** Operations applied to both stores; each returns what is compared. */
const OPS: Array<[string, (s: Store) => unknown]> = [
  ['projects.upsert/list', (s) => (s.projects.upsert(projectRow('prj_1')), s.projects.upsert(projectRow('prj_2', { trustState: 'untrusted', trustHash: null, refFormat: 'reftable' })), s.projects.list())],
  ['projects.upsert (update)', (s) => (s.projects.upsert(projectRow('prj_1', { name: 'Renamed', setupCommand: 'npm ci' })), [s.projects.get('prj_1'), s.projects.get('nope'), s.projects.list().map((p) => p.id)])],
  ['trustedFiles', (s) => {
    s.trustedFiles.replace('prj_1', [{ projectId: 'prj_1', path: 'AGENTS.md', sha: '1'.repeat(64), content: 'a' }, { projectId: 'prj_1', path: '.gmi-desk/permissions.json', sha: '2'.repeat(64), content: '{}' }]);
    const first = s.trustedFiles.list('prj_1');
    s.trustedFiles.replace('prj_1', [{ projectId: 'prj_1', path: 'CLAUDE.md', sha: '3'.repeat(64), content: 'c' }]);
    return [first, s.trustedFiles.list('prj_1'), s.trustedFiles.get('prj_1', 'AGENTS.md'), s.trustedFiles.get('prj_1', 'CLAUDE.md')];
  }],
  ['threads.insert/list', (s) => {
    s.threads.insert(threadRow(A, 'prj_1'));
    s.threads.insert(threadRow(B, 'prj_1', { strategy: 'root', branch: null, archived: true }));
    s.threads.insert(threadRow('thr_c', 'prj_2'));
    return [s.threads.list(), s.threads.list({ projectId: 'prj_1' }).map((t) => t.id), s.threads.list({ archived: true }).map((t) => t.id), s.threads.list({ projectId: 'prj_1', archived: false }).map((t) => t.id)];
  }],
  ['threads.insert duplicate', (s) => outcome(() => s.threads.insert(threadRow(A, 'prj_1')))],
  ['threads.update', (s) => [
    s.threads.update(A, { title: 'Renamed', status: 'running', statusReason: null, tokens: { input: 5, cached: 1, output: 2, reasoning: 0 }, costUsd: 0.25, settings: threadRow(A).settings, envBlock: null }),
    outcome(() => s.threads.update('missing', { title: 'x' })),
    s.threads.get(A),
  ]],
  ['events.append/list', (s) => {
    const out = [];
    for (let i = 0; i < 6; i += 1) {
      const thread = i % 2 === 0 ? A : B;
      out.push(s.events.append({ threadId: thread, contextId: i === 4 ? CHILD : contextIdOf(thread), runId: i < 3 ? 'run_1' : 'run_2', turn: 1, step: i, type: i % 3 === 0 ? 'item' : 'notice', payload: { i, nested: { list: [1, 'two', null] } }, eventId: `ev_${i}` }));
    }
    return [
      out,
      s.events.list(A),
      s.events.list(A, { afterSeq: 1 }),
      s.events.list(A, { beforeSeq: 3 }),
      s.events.list(A, { limit: 2 }),
      s.events.list(A, { types: ['item'] }),
      s.events.list(A, { types: [] }),
      s.events.list(B, { afterSeq: 1, beforeSeq: 3, types: ['notice'] }),
      s.events.byRun('run_2').map((e) => e.eventId),
      s.events.lastSeq(A),
      s.events.lastSeq('none'),
      outcome(() => s.events.append({ threadId: A, contextId: CA, runId: null, turn: null, step: null, type: 'notice', payload: null, eventId: 'ev_0' })),
      s.events.lastSeq(A),
    ];
  }],
  ['receipts', (s) => (s.receipts.put('cmd_1', A, { runId: 'a' }), s.receipts.put('cmd_1', A, { runId: 'b' }), s.receipts.put('cmd_2', null, null), [s.receipts.get('cmd_1'), s.receipts.get('cmd_2'), s.receipts.get('cmd_3')])],
  ['messages.append/list', (s) => [
    s.messages.append(messageRow('m1', A)),
    s.messages.append(messageRow('m2', A, { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'read', arguments: '{"path":"a"}' }], reasoning: 'think', reasoningFamily: 'deepseek', model: 'm' })),
    s.messages.append(messageRow('m3', A, { pinned: true })),
    s.messages.append(messageRow('m4', A, { role: 'tool', toolCallId: 'call_0', steering: true })),
    s.messages.append(messageRow('c1', A, { contextId: CHILD })),
    s.messages.append(messageRow('b1', B)),
    s.messages.list(CA),
    s.messages.list(CHILD),
    s.messages.lastOrd(CA),
    s.messages.lastOrd('nope'),
  ]],
  ['messages.partials', (s) => [
    s.messages.upsertPartial(messageRow('p1', A, { role: 'assistant', content: 'Hel' })),
    s.messages.upsertPartial(messageRow('p1', A, { role: 'assistant', content: 'Hello wor' })),
    s.messages.finalizePartial('p1', { ...messageRow('p1', A, { role: 'assistant', content: 'Hello world', estTokens: 3 }) }),
    outcome(() => s.messages.finalizePartial('nope', messageRow('nope', A))),
    s.messages.list(CA, { afterOrd: 4 }),
  ]],
  ['messages.markOutOfContext', (s) => [s.messages.markOutOfContext(CA, 4), s.messages.markOutOfContext(CA, 4), s.messages.list(CA, { inContextOnly: true }).map((m) => m.id), s.messages.list(CHILD, { inContextOnly: true }).map((m) => m.id)]],
  ['toolCalls', (s) => {
    s.toolCalls.insert(toolCallRow('tc_1', A, 'call_0'));
    s.toolCalls.insert(toolCallRow('tc_2', A, 'call_1', { tool: 'bash' }));
    s.toolCalls.insert(toolCallRow('tc_3', B, 'call_0')); // same wire id, other context
    s.toolCalls.insert(toolCallRow('tc_4', A, 'call_0', { contextId: CHILD })); // same wire id, child context
    const dupId = outcome(() => s.toolCalls.insert(toolCallRow('tc_1', B, 'call_9')));
    const dupWire = outcome(() => s.toolCalls.insert(toolCallRow('tc_5', A, 'call_0')));
    s.toolCalls.update('tc_1', { status: 'succeeded', exitCode: 0, finishedAt: '2026-11-02T10:00:05.000Z', resultMessageId: 'm4', spillPath: '/tmp/gmi-desk-fixture/spill/tc_1.txt' });
    s.toolCalls.update('missing', { status: 'failed' });
    return [dupId, dupWire, s.toolCalls.get('tc_1'), s.toolCalls.get('nope'), s.toolCalls.byWireId(CA, 'call_0')?.id, s.toolCalls.byWireId(CHILD, 'call_0')?.id, s.toolCalls.unsettled().map((t) => t.id), s.toolCalls.unsettled(A).map((t) => t.id)];
  }],
  ['approvals', (s) => {
    s.approvals.insert(approvalRow('apr_1', A));
    s.approvals.insert(approvalRow('apr_2', A));
    s.approvals.insert(approvalRow('apr_3', B));
    const before = s.approvals.pending().map((a) => a.requestId);
    s.approvals.decide('apr_1', { kind: 'allow_always', rule: { tool: 'bash', pattern: 'npm install', effect: 'allow', scope: 'project' } }, '2026-11-02T10:01:00.000Z');
    s.approvals.decide('missing', { kind: 'deny' }, '2026-11-02T10:01:00.000Z');
    return [before, s.approvals.pending(A), s.approvals.get('apr_1'), s.approvals.get('nope')];
  }],
  ['rules', (s) => {
    s.rules.insert(rule('rule_g'));
    s.rules.insert(rule('rule_p', { scope: 'project', projectId: 'prj_1' }));
    s.rules.insert(rule('rule_p2', { scope: 'project', projectId: 'prj_2', effect: 'deny', pattern: null, source: 'project_file' }));
    s.rules.insert(rule('rule_t', { scope: 'thread', projectId: 'prj_1', threadId: A }));
    return [
      s.rules.list().map((r) => r.id),
      s.rules.list({ projectId: 'prj_1' }).map((r) => r.id),
      s.rules.list({ projectId: null }).map((r) => r.id),
      s.rules.list({ projectId: 'prj_1', threadId: A }).map((r) => r.id),
      s.rules.list({ threadId: null }).map((r) => r.id),
      s.rules.list({ projectId: 'prj_2' }),
      s.rules.delete('rule_g'),
      s.rules.delete('rule_g'),
      s.rules.list().map((r) => r.id),
    ];
  }],
  ['checkpoints', (s) => {
    s.checkpoints.insert({ id: 'ckpt_2', threadId: A, turn: 2, commitSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), filesChanged: 1, createdAt: '2026-11-02T10:02:00.000Z' });
    s.checkpoints.insert({ id: 'ckpt_1', threadId: A, turn: 1, commitSha: 'e'.repeat(40), treeSha: 'f'.repeat(40), filesChanged: 3, createdAt: '2026-11-02T10:01:00.000Z' });
    return [s.checkpoints.list(A), s.checkpoints.list(B), s.checkpoints.get('ckpt_1'), s.checkpoints.get('nope')];
  }],
  ['compactions', (s) => {
    s.compactions.insert({ id: 'cmp_1', threadId: A, contextId: CA, uptoOrd: 3, summary: 'S', model: 'm', beforeTokens: 100, afterTokens: 10, costUsd: null, createdAt: '2026-11-02T10:03:00.000Z' });
    s.compactions.insert({ id: 'cmp_2', threadId: A, contextId: CHILD, uptoOrd: 1, summary: 'C', model: 'm', beforeTokens: 50, afterTokens: 5, costUsd: 0.001, createdAt: '2026-11-02T10:03:00.000Z' });
    return [s.compactions.list(CA), s.compactions.list(CHILD), s.compactions.list('nope')];
  }],
  ['reads', (s) => {
    s.reads.put({ contextId: CA, path: '/w/a.ts', sha: '1'.repeat(64), ranges: [[0, 100]], size: 10, mtimeMs: 1, ord: 2 });
    s.reads.put({ contextId: CA, path: '/w/b.ts', sha: '2'.repeat(64), ranges: [[0, 50], [200, 260]], size: null, mtimeMs: null, ord: null });
    s.reads.put({ contextId: CHILD, path: '/w/a.ts', sha: '3'.repeat(64), ranges: [[10, 20]], size: 10, mtimeMs: 2, ord: 1 });
    s.reads.put({ contextId: CA, path: '/w/a.ts', sha: '4'.repeat(64), ranges: [[0, 100], [100, 180]], size: 12, mtimeMs: 3, ord: 5 });
    const list = s.reads.list(CA);
    s.reads.delete(CA, '/w/b.ts');
    return [list, s.reads.get(CA, '/w/a.ts'), s.reads.get(CA, '/w/b.ts'), s.reads.list(CHILD)];
  }],
  ['usage', (s) => {
    const row = { threadId: A, contextId: CA, runId: 'run_1', turn: 1, step: 1, model: 'm', prompt: 1000, cached: 800, expectedCached: 900, completion: 50, reasoning: 5, costUsd: 0.0012, estimated: false, prefixHash: 'p', at: '2026-11-02T10:00:00.000Z' };
    s.usage.insert(row);
    s.usage.insert({ ...row, step: 2, contextId: CHILD, costUsd: null, estimated: true, expectedCached: null, prefixHash: null });
    s.usage.insert({ ...row, runId: 'run_2', turn: 2, step: 1 });
    return [s.usage.list(A), s.usage.list(A, { runId: 'run_1' }).length, s.usage.list(A, { contextId: CHILD }), s.usage.list(A, { runId: 'run_1', contextId: CA }).length, s.usage.list(B)];
  }],
  ['mcpServers', (s) => {
    s.mcpServers.upsert({ id: 'mcp_g', scope: 'global', projectId: null, config: { name: 'g', transport: { type: 'http', url: 'https://mcp.example.test' } }, trustHash: null, toolHashes: null, resolvedVersion: null, enabled: true });
    s.mcpServers.upsert({ id: 'mcp_p', scope: 'project', projectId: 'prj_1', config: { name: 'p' }, trustHash: 'h', toolHashes: { a: '1' }, resolvedVersion: '1.2.3', enabled: false });
    s.mcpServers.upsert({ id: 'mcp_g', scope: 'global', projectId: null, config: { name: 'g2' }, trustHash: 't', toolHashes: {}, resolvedVersion: null, enabled: false });
    const all = s.mcpServers.list();
    s.mcpServers.remove('mcp_p');
    return [all, s.mcpServers.list({ projectId: null }).map((m) => m.id), s.mcpServers.list({ projectId: 'prj_1' }), s.mcpServers.get('mcp_g')];
  }],
  ['todos', (s) => {
    const empty = s.todos.get(CA);
    s.todos.put(CA, A, [{ id: '1', text: 'a', status: 'pending' }]);
    s.todos.put(CA, A, [{ id: '1', text: 'a', status: 'done' }, { id: '2', text: 'b', status: 'in_progress' }]);
    s.todos.put(CHILD, A, [{ id: 'x', text: 'child', status: 'pending' }]);
    return [empty, s.todos.get(CA), s.todos.get(CHILD)];
  }],
  ['refSnapshots', (s) => {
    s.refSnapshots.put('run_1', A, { 'refs/heads/main': 'a'.repeat(40) });
    s.refSnapshots.put('run_2', B, {});
    s.refSnapshots.put('run_1', A, { 'refs/heads/main': 'b'.repeat(40), 'refs/heads/gmi/x': 'c'.repeat(40) });
    const all = s.refSnapshots.list();
    s.refSnapshots.delete('run_2');
    return [all, s.refSnapshots.get('run_1'), s.refSnapshots.get('run_2'), s.refSnapshots.list()];
  }],
  ['sensitiveHashes', (s) => {
    const empty = s.sensitiveHashes.get(A);
    s.sensitiveHashes.put(A, { 'package.json': '1'.repeat(64), '.envrc': null, '.github/workflows/ci.yml': '2'.repeat(64) });
    const first = s.sensitiveHashes.get(A);
    s.sensitiveHashes.put(A, { 'package.json': '3'.repeat(64) });
    return [empty, first, s.sensitiveHashes.get(A), s.sensitiveHashes.get(B)];
  }],
  ['gitProcs', (s) => {
    s.gitProcs.add(1001, A);
    s.gitProcs.add(1002, null);
    s.gitProcs.add(1001, B);
    const all = s.gitProcs.list();
    s.gitProcs.remove(1002);
    return [all, s.gitProcs.list()];
  }],
  ['threads.summaries', (s) => {
    const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id);
    return [s.threads.summaries().sort(byId), s.threads.summaries({ projectId: 'prj_1', archived: false }).map((t) => t.id)];
  }],
];

let tmp: TempDir;
let clock: FakeClock;
let sql: SqliteStore;
let mem: Store;

beforeEach(async () => {
  tmp = await tempDir('store');
  clock = fakeClock();
  sql = (await openTestStore(tmp.dir, clock)).store;
  mem = memoryStore(clock);
});
afterEach(async () => {
  sql.close();
  await tmp.cleanup();
});

describe('same semantics as the conforming fake', () => {
  it.each(OPS.map(([name], i) => [name, i] as const))('%s', (_name, upto) => {
    // Replay every earlier operation first (each test starts from fresh stores), advancing the clock in step.
    for (let i = 0; i < upto; i += 1) {
      OPS[i]?.[1](mem);
      OPS[i]?.[1](sql);
      clock.advance(1_000);
    }
    const fn = OPS[upto]?.[1];
    if (!fn) throw new Error('missing op');
    const expected = outcome(() => fn(mem));
    const actual = outcome(() => fn(sql));
    expect(actual).toEqual(expected);
  });
});

describe('what only the database gives', () => {
  const seed = (s: Store) => {
    s.projects.upsert(projectRow('prj_1'));
    s.projects.upsert(projectRow('prj_2'));
    s.threads.insert(threadRow(A, 'prj_1'));
    s.threads.insert(threadRow(B, 'prj_1'));
    s.threads.insert(threadRow('thr_c', 'prj_2'));
  };

  it('a throwing transaction rolls everything back; a nested one only its savepoint', () => {
    seed(sql);
    expect(() =>
      sql.transaction(() => {
        sql.events.append({ threadId: A, contextId: CA, runId: null, turn: null, step: null, type: 'notice', payload: 1 });
        sql.messages.append(messageRow('m1', A));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(sql.events.lastSeq(A)).toBe(0);
    expect(sql.messages.list(CA)).toEqual([]);

    sql.transaction(() => {
      sql.events.append({ threadId: A, contextId: CA, runId: null, turn: null, step: null, type: 'notice', payload: 1 });
      expect(() =>
        sql.transaction(() => {
          sql.events.append({ threadId: A, contextId: CA, runId: null, turn: null, step: null, type: 'notice', payload: 2 });
          throw new Error('inner');
        }),
      ).toThrow('inner');
      sql.events.append({ threadId: A, contextId: CA, runId: null, turn: null, step: null, type: 'notice', payload: 3 });
    });
    expect(sql.events.list(A).map((e) => [e.seq, e.payload])).toEqual([
      [1, 1],
      [2, 3],
    ]);
  });

  it('refuses async transaction callbacks (they would commit before the awaited work)', () => {
    seed(sql);
    expect(() =>
      sql.transaction(() => {
        sql.messages.append(messageRow('m1', A));
        return Promise.resolve(1);
      }),
    ).toThrow(/synchronous/);
    expect(sql.messages.list(CA)).toEqual([]);
    // The connection is usable afterwards.
    sql.messages.append(messageRow('m2', A));
    expect(sql.messages.lastOrd(CA)).toBe(1);
  });

  it('a constraint violation is a GmiError conflict and leaves no partial write', () => {
    seed(sql);
    sql.projects.upsert(projectRow('prj_3'));
    const err = outcome(() => sql.projects.upsert(projectRow('prj_4', { rootPath: projectRow('prj_3').rootPath })));
    expect(err).toEqual({ error: 'conflict' });
    expect(sql.projects.get('prj_4')).toBeNull();
    // threads.project_id is a foreign key
    expect(outcome(() => sql.threads.insert(threadRow('thr_x', 'prj_missing')))).toEqual({ error: 'conflict' });
  });

  it('messages: partial rows keep their ord; tool calls stay byte-identical; steering survives', () => {
    seed(sql);
    sql.messages.append(messageRow('m1', A));
    const p = sql.messages.upsertPartial(messageRow('p1', A, { role: 'assistant', content: 'par' }));
    sql.messages.append(messageRow('m2', A, { steering: true }));
    const args = '{"path":"src/ä.ts","note":"\\u00e9 \\"q\\"" }';
    const done = sql.messages.finalizePartial('p1', messageRow('p1', A, { role: 'assistant', content: 'partial → final ✓', toolCalls: [{ id: 'call_0', name: 'read', arguments: args }] }));
    expect(p).toMatchObject({ ord: 2, partial: true });
    expect(done).toMatchObject({ ord: 2, partial: false, content: 'partial → final ✓' });
    expect(done.toolCalls?.[0]?.arguments).toBe(args);
    expect(sql.messages.list(CA).map((m) => [m.id, m.ord, m.steering === true])).toEqual([
      ['m1', 1, false],
      ['p1', 2, false],
      ['m2', 3, true],
    ]);
  });

  it('threads.delete removes every row of the thread (subagent contexts included) and nothing of others', () => {
    seed(sql);
    for (const t of [A, B]) {
      const ctx = contextIdOf(t);
      const child = `${CHILD}_${t}`;
      sql.events.append({ threadId: t, contextId: ctx, runId: 'run_1', turn: 1, step: 1, type: 'item', payload: {} });
      sql.events.append({ threadId: t, contextId: child, runId: child, turn: 1, step: 1, type: 'notice', payload: {} });
      sql.messages.append(messageRow(`m_${t}`, t));
      sql.messages.append(messageRow(`mc_${t}`, t, { contextId: child }));
      sql.toolCalls.insert(toolCallRow(`tc_${t}`, t, 'call_0'));
      sql.approvals.insert(approvalRow(`apr_${t}`, t));
      sql.rules.insert(rule(`rule_${t}`, { scope: 'thread', threadId: t }));
      sql.checkpoints.insert({ id: `ckpt_${t}`, threadId: t, turn: 1, commitSha: 'c', treeSha: 't', filesChanged: 1, createdAt: 'x' });
      sql.compactions.insert({ id: `cmp_${t}`, threadId: t, contextId: ctx, uptoOrd: 1, summary: 's', model: 'm', beforeTokens: 1, afterTokens: 1, costUsd: null, createdAt: 'x' });
      sql.reads.put({ contextId: ctx, path: '/a', sha: 's', ranges: [[0, 1]], size: 1, mtimeMs: 1, ord: 1 });
      sql.reads.put({ contextId: child, path: '/a', sha: 's', ranges: [[0, 1]], size: 1, mtimeMs: 1, ord: 1 });
      sql.usage.insert({ threadId: t, contextId: child, runId: 'r', turn: 1, step: 1, model: 'm', prompt: 1, cached: 0, expectedCached: null, completion: 1, reasoning: 0, costUsd: null, estimated: true, prefixHash: null, at: 'x' });
      sql.todos.put(ctx, t, [{ id: '1', text: 'x', status: 'pending' }]);
      sql.refSnapshots.put(`run_${t}`, t, {});
      sql.sensitiveHashes.put(t, { a: null });
      sql.gitProcs.add(t === A ? 1 : 2, t);
    }
    sql.receipts.put('cmd_del', A, null);
    sql.threads.delete(A);

    const countFor = (table: string, where: string, ...params: string[]) => Number(sql.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get<{ n: number }>(...params)?.n);
    for (const table of ['events', 'messages', 'tool_calls', 'approvals', 'permission_rules', 'checkpoints', 'compactions', 'usage_steps', 'todos', 'ref_snapshots', 'sensitive_hashes', 'git_procs']) {
      expect([table, countFor(table, 'thread_id = ?', A)]).toEqual([table, 0]);
      expect([table, countFor(table, 'thread_id = ?', B) > 0]).toEqual([table, true]);
    }
    expect(countFor('threads', 'id = ?', A)).toBe(0);
    expect(sql.reads.list(CA)).toEqual([]);
    expect(sql.reads.list(`${CHILD}_${A}`)).toEqual([]);
    expect(sql.reads.list(CB)).toHaveLength(1);
    expect(sql.reads.list(`${CHILD}_${B}`)).toHaveLength(1);
    // A replayed delete command still finds its receipt.
    expect(sql.receipts.get('cmd_del')).not.toBeNull();
  });

  it('projects.remove removes the project with its threads, trusted files, project MCP servers and rules', () => {
    seed(sql);
    sql.trustedFiles.replace('prj_1', [{ projectId: 'prj_1', path: 'AGENTS.md', sha: 's', content: 'c' }]);
    sql.mcpServers.upsert({ id: 'mcp_p', scope: 'project', projectId: 'prj_1', config: {}, trustHash: null, toolHashes: null, resolvedVersion: null, enabled: true });
    sql.rules.insert(rule('rule_p', { scope: 'project', projectId: 'prj_1' }));
    sql.rules.insert(rule('rule_g'));
    sql.events.append({ threadId: A, contextId: CA, runId: null, turn: null, step: null, type: 'notice', payload: {} });
    sql.projects.remove('prj_1');
    expect(sql.projects.list().map((p) => p.id)).toEqual(['prj_2']);
    expect(sql.threads.list().map((t) => t.id)).toEqual(['thr_c']);
    expect(sql.events.lastSeq(A)).toBe(0);
    expect(sql.trustedFiles.list('prj_1')).toEqual([]);
    expect(sql.mcpServers.list()).toEqual([]);
    expect(sql.rules.list().map((r) => r.id)).toEqual(['rule_g']);
  });

  it('threads.update stamps updatedAt from the clock and ignores fields it does not own', () => {
    seed(sql);
    clock.advance(60_000);
    const updated = sql.threads.update(A, { archived: true, ...({ id: 'other', projectId: 'prj_2', createdAt: 'x' } as object) });
    expect(updated).toMatchObject({ id: A, projectId: 'prj_1', archived: true, createdAt: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-02T10:01:00.000Z' });
  });

  it('summaries list the most recently updated first, with pending approvals and the latest diff', () => {
    seed(sql);
    clock.advance(1_000);
    sql.threads.update(B, { title: 'touched' });
    sql.approvals.insert(approvalRow('apr_1', A));
    sql.approvals.insert(approvalRow('apr_2', A));
    sql.approvals.decide('apr_2', { kind: 'deny' }, 'x');
    sql.events.append({ threadId: A, contextId: CA, runId: null, turn: 1, step: 1, type: 'diff', payload: { type: 'diff', diff: { files: 1, additions: 2, deletions: 0 } } });
    sql.events.append({ threadId: A, contextId: CA, runId: null, turn: 1, step: 2, type: 'diff', payload: { type: 'diff', diff: { files: 3, additions: 5, deletions: 1 } } });
    const list = sql.threads.summaries({ projectId: 'prj_1' });
    expect(list.map((t) => t.id)).toEqual([B, A]);
    expect(list[1]).toMatchObject({ pendingApprovals: 1, diff: { files: 3, additions: 5, deletions: 1 }, model: 'zai-org/GLM-5.3', mode: 'auto-accept-edits' });
    expect(list[0]).toMatchObject({ pendingApprovals: 0, diff: null });
  });
});
