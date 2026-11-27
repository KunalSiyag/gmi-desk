/**
 * The `todo_write` tool (harness.md §8.1): the agent's todo list, stored per context (`todos`), shown in the UI, never
 * in the prompt prefix (the open list goes into the volatile `<context>` block, §7.1). Replaces the whole list.
 * Read-only for batching (§6.2): it touches no file.
 *
 * The durable `todo` event for the renderer is the loop's job (it owns event emission); the result's content is the
 * rendered list.
 */
import type { TodoItem } from '@shared/contracts/code';
import type { ParsedArgs, ToolDefinition, ToolResult } from '../types';
import { objectArgs } from './fs';
import { okResult } from './output';

export interface TodoArgs {
  items: TodoItem[];
}

export const TODO_LIMITS = { maxItems: 100, maxText: 500, maxId: 64 } as const;

const STATUSES: ReadonlyArray<TodoItem['status']> = ['pending', 'in_progress', 'done'];

export function renderTodos(items: TodoItem[]): string {
  if (!items.length) return 'Todo list cleared.';
  const mark = { pending: '[ ]', in_progress: '[~]', done: '[x]' } as const;
  const done = items.filter((i) => i.status === 'done').length;
  return [`Todo list (${done}/${items.length} done):`, ...items.map((i) => `${mark[i.status]} ${i.id}. ${i.text}`)].join('\n');
}

export function createTodoTool(): ToolDefinition<TodoArgs> {
  return {
    name: 'todo_write',
    description:
      'Replace your todo list for this task. Use it for multi-step work: keep exactly one item in_progress, mark items done as soon as they are finished. Each item has an id, a short text and a status (pending, in_progress, done).',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: TODO_LIMITS.maxItems,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              status: { type: 'string', enum: [...STATUSES] },
            },
            required: ['id', 'text', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    class: 'state',
    parse(raw): ParsedArgs<TodoArgs> {
      const o = objectArgs(raw);
      if (!o) return { ok: false, error: 'Arguments must be a JSON object.' };
      if (!Array.isArray(o.items)) return { ok: false, error: 'items must be an array.' };
      if (o.items.length > TODO_LIMITS.maxItems) return { ok: false, error: `At most ${TODO_LIMITS.maxItems} items.` };
      const items: TodoItem[] = [];
      const ids = new Set<string>();
      for (const [n, it] of o.items.entries()) {
        const x = objectArgs(it);
        if (!x) return { ok: false, error: `items[${n}] must be an object.` };
        const id = typeof x.id === 'number' ? String(x.id) : x.id;
        if (typeof id !== 'string' || !id.trim() || id.length > TODO_LIMITS.maxId) return { ok: false, error: `items[${n}].id must be a short non-empty string.` };
        if (ids.has(id)) return { ok: false, error: `Duplicate id ${id}.` };
        ids.add(id);
        if (typeof x.text !== 'string' || !x.text.trim()) return { ok: false, error: `items[${n}].text must be a non-empty string.` };
        if (x.text.length > TODO_LIMITS.maxText) return { ok: false, error: `items[${n}].text is too long (max ${TODO_LIMITS.maxText}).` };
        if (typeof x.status !== 'string' || !STATUSES.includes(x.status as TodoItem['status'])) return { ok: false, error: `items[${n}].status must be pending, in_progress or done.` };
        items.push({ id, text: x.text.replace(/[\r\n]+/g, ' ').trim(), status: x.status as TodoItem['status'] });
      }
      return { ok: true, args: { items } };
    },
    readOnly: () => true,
    mutates: () => false,
    title: () => 'Update todo list',
    subject: () => ({ tool: 'todo_write', kind: 'file-read', title: 'Update todo list', risk: [] }),
    async run(a, ctx): Promise<ToolResult> {
      ctx.store.todos.put(ctx.contextId, ctx.threadId, a.items);
      return okResult(renderTodos(a.items));
    },
  };
}
