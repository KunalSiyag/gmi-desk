// H2-D: the tool registry (§7.1 ordering and canonical JSON for the byte-stable prefix), the built-in set, todo_write
// and question.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GmiError } from '@shared/contracts/errors';
import { contextIdOf } from '@harness/types';
import { compareToolNames, createToolRegistry, fileTools, registerFileTools } from '@harness/tools/registry';
import { createQuestionTool } from '@harness/tools/question';
import { createTodoTool } from '@harness/tools/todo';
import { fakeMainLink, fakeTool } from '../fakes';
import { call, makeEnv, T1, type ToolEnv } from './env';

let env: ToolEnv;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => env.cleanup());

describe('registry', () => {
  it('orders built-ins by name, then MCP tools by server and tool', () => {
    const names = ['mcp__a__y', 'write', 'mcp__a-b__x', 'bash', 'mcp__a__b', 'read', 'sandbox_exec'];
    expect([...names].sort(compareToolNames)).toEqual(['bash', 'read', 'sandbox_exec', 'write', 'mcp__a__b', 'mcp__a__y', 'mcp__a-b__x']);
  });

  it('serialises parameters canonically and byte-identically across registries', () => {
    const r1 = createToolRegistry();
    const r2 = createToolRegistry();
    const deps = { ripgrep: null, approvals: fakeMainLink().approvals };
    registerFileTools(r1, deps);
    for (const t of [...fileTools(deps)].reverse()) r2.register(t);
    const j1 = JSON.stringify(r1.definitions());
    expect(j1).toBe(JSON.stringify(r2.definitions()));
    const read = r1.definitions().find((d) => d.name === 'read');
    expect(Object.keys(read?.parameters ?? {})).toEqual(['additionalProperties', 'properties', 'required', 'type']);
    expect(r1.definitions().map((d) => d.name)).toEqual(['apply_patch', 'edit', 'glob', 'grep', 'list', 'question', 'read', 'todo_write', 'write']);
  });

  it('refuses duplicates and invalid names; unregister removes only its own tool', () => {
    const r = createToolRegistry();
    const off = r.register(fakeTool('a'));
    expect(() => r.register(fakeTool('a'))).toThrow(GmiError);
    expect(() => r.register(fakeTool('bad name'))).toThrow(/Invalid tool name/);
    expect(() => r.register(fakeTool('x'.repeat(65)))).toThrow(/Invalid tool name/);
    off();
    expect(r.get('a')).toBeNull();
    const off2 = r.register(fakeTool('a'));
    off();
    expect(r.get('a')).not.toBeNull();
    off2();
    expect(r.list()).toEqual([]);
  });

  it('question is registered only with an approval client; definitions take a filter', () => {
    const r = createToolRegistry();
    const off = registerFileTools(r, { ripgrep: null });
    expect(r.get('question')).toBeNull();
    expect(r.definitions((d) => d.class === 'read').map((d) => d.name)).toEqual(['glob', 'grep', 'list', 'read']);
    off();
    expect(r.list()).toEqual([]);
  });

  it('classes and batching flags follow §6.2', () => {
    const tools = Object.fromEntries(fileTools({ ripgrep: null, approvals: fakeMainLink().approvals }).map((t) => [t.name, t]));
    for (const n of ['read', 'grep', 'glob', 'list', 'todo_write']) {
      expect(tools[n]?.readOnly({} as never)).toBe(true);
      expect(tools[n]?.mutates({} as never)).toBe(false);
    }
    for (const n of ['write', 'edit', 'apply_patch']) {
      expect(tools[n]?.readOnly({} as never)).toBe(false);
      expect(tools[n]?.mutates({} as never)).toBe(true);
      expect(tools[n]?.class).toBe('mutate');
    }
    expect(tools.question?.readOnly({} as never)).toBe(false); // a barrier
    expect(tools.question?.class).toBe('user');
  });
});

describe('todo_write', () => {
  it('stores the list per context and renders it', async () => {
    const todo = createTodoTool();
    const r = await call(todo, { items: [{ id: '1', text: 'Read code', status: 'done' }, { id: 2, text: 'Fix\nbug', status: 'in_progress' }] }, env.ctx());
    expect(r.content).toBe('Todo list (1/2 done):\n[x] 1. Read code\n[~] 2. Fix bug');
    expect(env.store.todos.get(contextIdOf(T1))).toEqual([
      { id: '1', text: 'Read code', status: 'done' },
      { id: '2', text: 'Fix bug', status: 'in_progress' },
    ]);
    expect(env.store.todos.get('run_child')).toEqual([]);
  });
  it('validates items', () => {
    const todo = createTodoTool();
    expect(todo.parse({ items: [{ id: '1', text: 'x', status: 'blocked' }] }).ok).toBe(false);
    expect(todo.parse({ items: [{ id: '1', text: 'x', status: 'done' }, { id: '1', text: 'y', status: 'done' }] }).ok).toBe(false);
    expect(todo.parse({ items: Array.from({ length: 101 }, (_, i) => ({ id: String(i), text: 'x', status: 'pending' })) }).ok).toBe(false);
    expect(todo.parse({ items: [] }).ok).toBe(true);
  });
});

describe('question', () => {
  it('asks through the approval broker and returns the answer; the request is persisted', async () => {
    const link = fakeMainLink();
    link.decide = () => ({ kind: 'answer', text: 'Use PostgreSQL.' });
    const q = createQuestionTool({ approvals: link.approvals });
    const ctx = env.ctx();
    const r = await call(q, { question: 'Which database?‮ evil', options: ['SQLite', 'PostgreSQL', 'SQLite'] }, ctx);
    expect(r).toMatchObject({ ok: true, content: 'The user answered:\nUse PostgreSQL.' });
    const asked = link.approvalsAsked[0];
    expect(asked).toMatchObject({ kind: 'question', tool: 'question', toolCallId: ctx.call.id, threadId: T1 });
    expect(asked?.detail).toEqual({ question: 'Which database? evil', options: ['SQLite', 'PostgreSQL'] });
    const row = env.store.approvals.get(asked?.requestId as string);
    expect(row?.decision).toEqual({ kind: 'answer', text: 'Use PostgreSQL.' });
  });
  it('deny, cancel_run and abort', async () => {
    const link = fakeMainLink();
    const q = createQuestionTool({ approvals: link.approvals });
    link.decide = () => ({ kind: 'deny', feedback: 'decide yourself' });
    expect(await call(q, { question: 'Q?' }, env.ctx())).toMatchObject({ ok: false, errorKind: 'denied', content: 'The user declined to answer: decide yourself' });
    link.decide = () => ({ kind: 'cancel_run' });
    expect(await call(q, { question: 'Q?' }, env.ctx())).toMatchObject({ ok: false, errorKind: 'cancelled' });
    const ac = new AbortController();
    ac.abort();
    expect(await call(q, { question: 'Q?' }, env.ctx({ signal: ac.signal }))).toMatchObject({ ok: false, errorKind: 'cancelled' });
  });
  it('validates and its subject is a question', () => {
    const q = createQuestionTool({ approvals: fakeMainLink().approvals });
    expect(q.parse({ question: '   ' }).ok).toBe(false);
    expect(q.parse({ question: 'x', options: Array.from({ length: 9 }, (_, i) => String(i)) }).ok).toBe(false);
    const p = q.parse({ question: 'x' });
    if (!p.ok) throw new Error(p.error);
    expect(q.subject(p.args, env.ctx()).kind).toBe('question');
  });
});
