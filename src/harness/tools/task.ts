import { z } from 'zod';
import type { AgentLoop } from '../loop/runner';
import { contextIdOf, newId, type ToolDefinition } from '../types';
import { errorResult, okResult } from './output';

const schema = z.object({
  agent: z.enum(['explore', 'general']),
  prompt: z.string().trim().min(1).max(16_000),
}).strict();
type Args = z.infer<typeof schema>;
const READ_TOOLS = new Set(['read', 'list', 'glob', 'grep', 'web_fetch']);

/** One-level delegation; the child loop shares main's run scope, caps, permissions and mutation lock. */
export function createTaskTool(loop: () => Pick<AgentLoop, 'runChild'>): ToolDefinition<Args> {
  const active = new Map<string, { explore: number; general: number }>();
  return {
    name: 'task', class: 'subagent',
    description: 'Delegate a bounded task with its own context. Explore can only read/search. General inherits your permissions. Provide a self-contained prompt; only a short report returns.',
    parameters: z.toJSONSchema(schema),
    parse(raw) {
      const parsed = schema.safeParse(raw);
      return parsed.success ? { ok: true, args: parsed.data } : { ok: false, error: 'task needs agent (explore/general) and a prompt of 1–16000 characters.' };
    },
    // A barrier, but not itself a worktree mutation. Holding the lock here deadlocks child edits.
    readOnly: () => false, mutates: () => false,
    title: (a) => `Delegate to ${a.agent}`,
    subject: (a) => ({ tool: 'task', kind: a.agent === 'explore' ? 'file-read' : 'command', title: `Delegate to ${a.agent}`, args: a, risk: [] }),
    async run(a, ctx) {
      if (ctx.contextId !== contextIdOf(ctx.threadId)) return errorResult('denied', 'Subagents cannot delegate further.');
      if (ctx.signal.aborted) return errorResult('cancelled', 'Cancelled.');
      const counts = active.get(ctx.threadId) ?? { explore: 0, general: 0 };
      if (counts[a.agent] >= (a.agent === 'explore' ? 2 : 1)) return errorResult('denied', `The ${a.agent} concurrency limit has been reached.`);
      active.set(ctx.threadId, counts);
      counts[a.agent]++;
      const settings = ctx.store.threads.get(ctx.threadId)?.settings ?? ctx.settings;
      const model = settings.subagentModel || settings.model;
      const budget = settings.budget.perTurnUsd;
      const maxUsd = Math.min(a.agent === 'explore' ? 0.25 : 1, budget ?? Infinity);
      try {
        const result = await loop().runChild({
          threadId: ctx.threadId, parentRunId: ctx.runId,
          contextId: newId('run', ctx.clock.now()), toolCallId: ctx.call.id, prompt: a.prompt, model,
          maxSteps: Math.min(20, settings.budget.maxStepsPerTurn), maxUsd,
          signal: ctx.signal,
          toolFilter: (d) => d.name !== 'task' && d.class !== 'subagent' && (a.agent !== 'explore' || READ_TOOLS.has(d.name)),
        });
        // A conservative character bound also covers non-ASCII output. Child history never joins the parent.
        const clipped = result.text.length > 2_000;
        return okResult(`${a.agent}: ${result.status} (${result.steps} steps)\n${result.text.slice(0, 2_000)}${clipped ? '\n[report truncated]' : ''}`);
      } finally {
        counts[a.agent]--;
        if (!counts.explore && !counts.general) active.delete(ctx.threadId);
      }
    },
  };
}
