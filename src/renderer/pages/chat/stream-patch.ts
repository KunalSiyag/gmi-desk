/**
 * Applies `chat:stream` events to a cached thread without refetching per delta.
 * Pure (no React, no DOM) so it can be unit-tested from the node test suite.
 */
import type { ChatMessage, ChatStreamEvent, ChatThread, ChatThreadSummary } from '@shared/contracts/chat';

export interface PatchResult {
  /** The patched thread (the same object when nothing changed). */
  thread: ChatThread;
  /** True when the cache cannot be patched reliably and the thread should be refetched. */
  refetch: boolean;
}

/**
 * Appends `text` that the main process placed at `offset`. Deltas already applied (e.g. included in a
 * refetch, or delivered to two listeners) are skipped; a gap (missed delta) asks for a refetch.
 */
export function appendAt(current: string, text: string, offset: number | undefined): { text: string; gap: boolean } {
  if (offset === undefined || offset === current.length) return { text: current + text, gap: false };
  if (offset < current.length) {
    const end = offset + text.length;
    if (end <= current.length) return { text: current, gap: false };
    return { text: current + text.slice(current.length - offset), gap: false };
  }
  return { text: current, gap: true };
}

/**
 * A cached thread with the title from the matching `chat:threads` summary (the same object when it already
 * matches or is not listed). Keeps the open chat's header and Rename dialog in step with renames made
 * elsewhere, e.g. inline in the sidebar.
 */
export function patchThreadTitle(thread: ChatThread, summaries: readonly ChatThreadSummary[]): ChatThread {
  const summary = summaries.find((s) => s.id === thread.id);
  return summary && summary.title !== thread.title ? { ...thread, title: summary.title } : thread;
}

function withMessage(thread: ChatThread, index: number, message: ChatMessage): ChatThread {
  const messages = thread.messages.slice();
  messages[index] = message;
  return { ...thread, messages };
}

export function applyStreamEvent(thread: ChatThread, event: ChatStreamEvent): PatchResult {
  if (thread.id !== event.threadId) return { thread, refetch: false };
  const index = thread.messages.findIndex((m) => m.id === event.messageId);
  const message = index >= 0 ? thread.messages[index] : undefined;

  switch (event.type) {
    case 'start':
      // The new user message and placeholder come with the refetch.
      return { thread, refetch: !message };
    case 'delta': {
      if (!message) return { thread, refetch: true };
      let content = message.content;
      let reasoning = message.reasoning;
      let gap = false;
      if (event.content) {
        const r = appendAt(content, event.content, event.contentOffset);
        content = r.text;
        gap ||= r.gap;
      }
      if (event.reasoning) {
        const r = appendAt(reasoning ?? '', event.reasoning, event.reasoningOffset);
        reasoning = r.text || null;
        gap ||= r.gap;
      }
      if (content === message.content && reasoning === message.reasoning) return { thread, refetch: gap };
      return { thread: withMessage(thread, index, { ...message, content, reasoning }), refetch: gap };
    }
    case 'routing':
      if (!message) return { thread, refetch: true };
      return { thread: withMessage(thread, index, { ...message, routing: event.routing, model: event.routing.selectedModel }), refetch: false };
    case 'done':
    case 'error': {
      if (!message) return { thread, refetch: true };
      // Thread totals (cost, updatedAt) are recomputed by the main process: refetch once at the end.
      return { thread: withMessage(thread, index, event.message), refetch: true };
    }
    default:
      return { thread, refetch: false };
  }
}
