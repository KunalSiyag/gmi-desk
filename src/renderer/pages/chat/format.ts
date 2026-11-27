/** Chat-page formatting helpers (pure). */
import type { ChatMessage, ChatThread, ChatThreadSummary, RoutingInfo } from '@shared/contracts/chat';
import { formatNumber } from '@shared/lib/format';

/** "zai-org/GLM-5.3" → "GLM-5.3", "Qwen/Qwen3-235B-A22B-Instruct-2507-FP8" → "Qwen3-235B-A22B-Instruct-2507". */
export function shortModelName(id: string | null | undefined): string {
  if (!id) return 'Unknown model';
  const last = id.split('/').pop() || id;
  return last.replace(/-FP8$/i, '');
}

/** "creative_writing" → "creative writing". */
export function taskLabel(task: string | null | undefined): string | null {
  if (!task) return null;
  return task.replace(/[_-]+/g, ' ').trim().toLowerCase() || null;
}

/** "Auto → GLM-5.3 · coding" */
export function routingLabel(routing: RoutingInfo | null): string {
  if (!routing) return 'Auto';
  const task = taskLabel(routing.taskType);
  return `Auto → ${shortModelName(routing.selectedModel)}${task ? ` · ${task}` : ''}`;
}

export type ThreadGroupLabel = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Groups summaries (already sorted newest first) by local calendar day. */
export function groupThreads(threads: ChatThreadSummary[], now: Date): Array<{ label: ThreadGroupLabel; threads: ChatThreadSummary[] }> {
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const week = today - 7 * 86_400_000;
  const order: ThreadGroupLabel[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
  const buckets = new Map<ThreadGroupLabel, ChatThreadSummary[]>();
  for (const t of threads) {
    const at = Date.parse(t.updatedAt);
    const label: ThreadGroupLabel = Number.isNaN(at) ? 'Older' : at >= today ? 'Today' : at >= yesterday ? 'Yesterday' : at >= week ? 'Previous 7 days' : 'Older';
    const list = buckets.get(label) ?? [];
    list.push(t);
    buckets.set(label, list);
  }
  return order.filter((label) => buckets.has(label)).map((label) => ({ label, threads: buckets.get(label) ?? [] }));
}

/** Compact sidebar time: "now", "5m", "3h", "2d", "Oct 12". */
export function compactTime(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (sec < 60) return 'now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  if (sec < 7 * 86_400) return `${Math.floor(sec / 86_400)}d`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The note under a reply GMI cut off at its output limit (finishReason `length`), or null. Names the limit the
 * reply was actually sent with: GMI Router takes none (the routed model stops at its own limit) and replies
 * saved before the limit was recorded name no number rather than the thread's current setting.
 */
export function lengthNotice(message: Pick<ChatMessage, 'finishReason' | 'routing' | 'maxTokens'>): string | null {
  if (message.finishReason !== 'length') return null;
  if (message.routing || message.maxTokens === null) {
    const model = message.routing ? shortModelName(message.routing.selectedModel) : null;
    return model
      ? `The routed model (${model}) stopped at its own output limit. Pick ${model} directly and raise “Max tokens” for longer answers.`
      : 'The model GMI Router picked stopped at its own output limit. Pick a model directly and raise “Max tokens” for longer answers.';
  }
  const limit = typeof message.maxTokens === 'number' ? `${formatNumber(message.maxTokens)}-token` : 'output';
  return `The reply hit the ${limit} limit and was cut off. Raise “Max tokens” in the chat settings to allow longer answers.`;
}

/** Seconds between the reply's start and end ("4.2s"), when known. */
export function replyDuration(message: ChatMessage): number | null {
  if (!message.completedAt) return null;
  const ms = Date.parse(message.completedAt) - Date.parse(message.createdAt);
  return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
}

/** The whole thread as Markdown (for "Copy chat"). */
export function threadAsMarkdown(thread: ChatThread): string {
  const parts = [`# ${thread.title}`];
  for (const m of thread.messages) {
    if (m.role === 'user') parts.push(`## You\n\n${m.content}`);
    else if (m.content) {
      const who = m.routing ? routingLabel(m.routing) : shortModelName(m.model);
      parts.push(`## ${who}\n\n${m.content}`);
    }
  }
  return `${parts.join('\n\n')}\n`;
}
