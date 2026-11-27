import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import type { ChatSettings, ChatThread, ChatThreadSummary } from '@shared/contracts/chat';
import { gmi } from '@renderer/lib/gmi';
import { useGmiEvent } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { applyStreamEvent, patchThreadTitle } from './stream-patch';

/** Prefix of every qk.thread(id) key. */
const THREAD_KEY_PREFIX = ['chat', 'thread'] as const;

/** Thread summaries, kept live by `chat:threads` (which also carries renames into cached threads). */
export function useThreads() {
  const client = useQueryClient();
  useGmiEvent('chat:threads', (list) => {
    client.setQueryData<ChatThreadSummary[]>(qk.threads, list);
    for (const [key, cached] of client.getQueriesData<ChatThread>({ queryKey: THREAD_KEY_PREFIX })) {
      if (!cached) continue;
      const next = patchThreadTitle(cached, list);
      if (next !== cached) client.setQueryData(key, next);
    }
  });
  return useQuery({ queryKey: qk.threads, queryFn: () => gmi.chat.listThreads(), staleTime: 0 });
}

/** One thread. Refetched on mount; patched live by useChatStreamSync while the page is open. */
export function useThread(id: string | null) {
  return useQuery({
    queryKey: qk.thread(id ?? '-'),
    queryFn: () => gmi.chat.getThread(id as string),
    enabled: Boolean(id),
    staleTime: 0,
  });
}

/** Applies `chat:stream` events to cached threads (mount once, on the chat page). */
export function useChatStreamSync(): void {
  const client = useQueryClient();
  useGmiEvent('chat:stream', (event) => {
    const key = qk.thread(event.threadId);
    const cached = client.getQueryData<ChatThread>(key);
    if (!cached) return;
    const { thread, refetch } = applyStreamEvent(cached, event);
    if (thread !== cached) client.setQueryData(key, thread);
    if (refetch) void client.invalidateQueries({ queryKey: key });
  });
}

/** Optimistically applies a settings patch, then stores what the main process returns. */
export function useUpdateThreadSettings() {
  const client = useQueryClient();
  return async (thread: ChatThread, patch: Partial<ChatSettings>) => {
    const key = qk.thread(thread.id);
    const previous = client.getQueryData<ChatThread>(key);
    if (previous) {
      const settings = { ...previous.settings, ...patch };
      client.setQueryData<ChatThread>(key, { ...previous, settings, mode: settings.mode, model: settings.mode === 'model' ? settings.model : null });
    }
    try {
      const next = await gmi.chat.updateThread(thread.id, { settings: patch });
      client.setQueryData(key, next);
      return next;
    } catch (error) {
      if (previous) client.setQueryData(key, previous);
      throw error;
    }
  };
}

/** Re-renders every `intervalMs` (relative times). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

interface ChatUiState {
  /** Unsent composer text per thread (survives switching threads). */
  drafts: Record<string, string>;
  setDraft: (threadId: string, text: string) => void;
}

export const useChatUi = create<ChatUiState>((set) => ({
  drafts: {},
  setDraft: (threadId, text) =>
    set((s) => {
      const drafts = { ...s.drafts };
      if (text) drafts[threadId] = text;
      else delete drafts[threadId];
      return { drafts };
    }),
}));
