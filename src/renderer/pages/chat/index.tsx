import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Boxes, ChevronDown, Copy, Pencil, Plus, RotateCw, Square, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatSettings, ChatThread } from '@shared/contracts/chat';
import { formatUsd } from '@shared/lib/money';
import { chatAccess } from '@renderer/components/connect/access';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { AUTO_MODEL } from '@renderer/components/ModelPicker';
import { TopBarActions } from '@renderer/components/shell/topbar-slot';
import { Button } from '@renderer/components/ui/button';
import { DropdownMenu } from '@renderer/components/ui/menu';
import { DinoLoader } from '@renderer/components/brand/Dino';
import { Skeleton } from '@renderer/components/ui/misc';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { describeError, errorCode } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { useAuth } from '@renderer/lib/hooks';
import { qk } from '@renderer/lib/query';
import { useCommandRegistry, useUi, type PaletteCommand } from '@renderer/lib/store';
import { Composer } from './Composer';
import { keepIdsFromDrafts } from './drafts';
import { EmptyChat } from './EmptyChat';
import { shortModelName, threadAsMarkdown } from './format';
import { useChatStreamSync, useChatUi, useThread, useThreads, useUpdateThreadSettings } from './hooks';
import { shouldStopOnEscape } from './keyboard';
import { DeleteThreadDialog, RenameThreadDialog, type ThreadRef } from './ThreadDialogs';
import { Timeline } from './Timeline';

/** navSeq of the last `?new=1` handled (module scope: survives StrictMode double effects and remounts). */
let handledNewSeq = -1;
/** Guards auto-creating a first thread when there are none. */
let creatingFirst = false;

function notify(title: string, error: unknown) {
  toast.error(title, { description: describeError(error).message || describeError(error).title });
}

function copyText(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`))
    .catch(() => toast.error('Could not copy to the clipboard'));
}

export default function ChatPage() {
  useChatStreamSync();
  const client = useQueryClient();
  const threads = useThreads();
  const auth = useAuth();
  const params = useUi((s) => s.params);
  const navSeq = useUi((s) => s.navSeq);
  const navigate = useUi((s) => s.navigate);
  const register = useCommandRegistry((s) => s.register);
  const updateSettings = useUpdateThreadSettings();

  const creating = params.new === '1';
  const threadId = creating ? null : (params.thread ?? null);
  const threadQuery = useThread(threadId);
  const thread = threadId ? threadQuery.data : undefined;

  const [sendError, setSendError] = useState<unknown>(null);
  /** Warn-only budget reached: set from the last send/regenerate, which went ahead anyway. */
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);
  const [pinSignal, setPinSignal] = useState(0);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // ?new=1[&model=…] → create a thread and select it (once per navigation).
  useEffect(() => {
    if (params.new !== '1' || handledNewSeq === navSeq) return;
    handledNewSeq = navSeq;
    const seq = navSeq;
    const model = params.model;
    const settings: Partial<ChatSettings> | undefined = model === AUTO_MODEL || model === 'auto' ? { mode: 'auto' } : model ? { model } : undefined;
    // Empty chats with unsent text survive (the main process discards other abandoned "New chat" drafts).
    const keepIds = keepIdsFromDrafts(useChatUi.getState().drafts);
    gmi.chat
      .createThread({ ...(settings ? { settings } : {}), ...(keepIds.length > 0 ? { keepIds } : {}) })
      .then((created) => {
        client.setQueryData(qk.thread(created.id), created);
        const ui = useUi.getState();
        if (ui.page === 'chat' && ui.navSeq === seq) ui.setParams({ thread: created.id });
      })
      .catch((error: unknown) => {
        notify('Could not start a new chat', error);
        const ui = useUi.getState();
        if (ui.page === 'chat' && ui.navSeq === seq) ui.setParams({});
      });
  }, [params.new, params.model, navSeq, client]);

  // No thread chosen → the most recent one (or a fresh one). A chosen thread that disappeared → fall back.
  useEffect(() => {
    if (creating || !threads.data) return;
    const list = threads.data;
    const current = params.thread;
    if (current) {
      if (list.some((t) => t.id === current)) return;
      let cancelled = false;
      // The list can lag a just-created thread by a moment: confirm before moving away.
      gmi.chat.getThread(current).catch(() => {
        const ui = useUi.getState();
        if (!cancelled && ui.page === 'chat' && ui.params.thread === current) ui.setParams({});
      });
      return () => {
        cancelled = true;
      };
    }
    const first = list[0];
    if (first) {
      useUi.getState().setParams({ thread: first.id });
      return;
    }
    if (creatingFirst) return;
    creatingFirst = true;
    gmi.chat
      .createThread()
      .then((created) => {
        client.setQueryData(qk.thread(created.id), created);
        const ui = useUi.getState();
        if (ui.page === 'chat' && !ui.params.thread && ui.params.new !== '1') ui.setParams({ thread: created.id });
      })
      .catch((error: unknown) => notify('Could not start a chat', error))
      .finally(() => {
        creatingFirst = false;
      });
  }, [creating, params.thread, threads.data, client]);

  useEffect(() => {
    setSendError(null);
    setBudgetWarning(null);
    setDialog(null);
  }, [threadId]);

  const streaming = thread?.messages.some((m) => m.status === 'streaming') ?? false;
  // A usable key, or GMI accepts the sign-in for chat (no key needed): see components/connect/access.ts.
  const access = chatAccess(auth.data);
  const keyState: 'ok' | 'missing' | 'invalid' = access === 'ready' ? 'ok' : access;

  const send = useCallback(
    async (text: string) => {
      if (!threadId) return;
      setSendError(null);
      setPinSignal((n) => n + 1);
      try {
        const sent = await gmi.chat.send(threadId, text);
        setBudgetWarning(sent.budgetWarning ?? null);
      } catch (error) {
        setSendError(error);
        setBudgetWarning(null);
        throw error;
      }
    },
    [threadId],
  );

  const stop = useCallback(() => {
    if (threadId) void gmi.chat.stop(threadId).catch((error: unknown) => notify('Could not stop the reply', error));
  }, [threadId]);

  const regenerate = useCallback(() => {
    if (!threadId) return;
    setSendError(null);
    setPinSignal((n) => n + 1);
    gmi.chat
      .regenerate(threadId)
      .then((started) => setBudgetWarning(started.budgetWarning ?? null))
      .catch((error: unknown) => {
        setSendError(error);
        setBudgetWarning(null);
      });
  }, [threadId]);

  // Esc stops the reply wherever focus is on the page, not only in the composer (a clicked Send button turns
  // into Stop and a clicked starter card unmounts, both dropping focus). Esc inside dialogs, menus and popovers
  // still only closes them; the composer handles its own Esc first.
  useEffect(() => {
    if (!streaming) return;
    const onKey = (event: KeyboardEvent) => {
      if (!shouldStopOnEscape(event)) return;
      event.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [streaming, stop]);

  const changeSettings = useCallback(
    (patch: Partial<ChatSettings>) => {
      const current = threadId ? client.getQueryData<ChatThread>(qk.thread(threadId)) : undefined;
      if (!current) return;
      updateSettings(current, patch).catch((error: unknown) => notify('Could not update the chat', error));
    },
    [threadId, client, updateSettings],
  );

  const openModelPicker = useCallback(() => {
    // After the palette closes (it restores focus first).
    setTimeout(() => pickerRef.current?.querySelector('button')?.click(), 80);
  }, []);

  // Palette commands for the open chat. Depends on primitives so streaming deltas do not re-register.
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const title = thread?.title;
  const mode = thread?.settings.mode;
  const model = thread?.settings.model ?? null;
  const lastRole = thread?.messages[thread.messages.length - 1]?.role ?? null;
  useEffect(() => {
    if (!threadId || !title) return;
    const modelParam = mode === 'auto' ? AUTO_MODEL : model;
    const commands: PaletteCommand[] = [
      {
        id: 'chat.new-same-model',
        group: 'Chat',
        label: `New chat with ${mode === 'auto' ? 'Auto' : shortModelName(model)}`,
        icon: <Plus />,
        keywords: ['new', 'chat', 'thread', 'same model'],
        run: () => navigate('chat', modelParam ? { new: '1', model: modelParam } : { new: '1' }),
      },
      { id: 'chat.change-model', group: 'Chat', label: 'Change model…', icon: <Boxes />, keywords: ['model', 'switch', 'auto', 'router'], run: openModelPicker },
      { id: 'chat.rename', group: 'Chat', label: 'Rename chat…', icon: <Pencil />, keywords: ['title'], run: () => setDialog('rename') },
      {
        id: 'chat.copy',
        group: 'Chat',
        label: 'Copy chat as Markdown',
        icon: <Copy />,
        keywords: ['export', 'markdown', 'transcript'],
        run: () => {
          if (threadRef.current) copyText(threadAsMarkdown(threadRef.current), 'Chat');
        },
      },
      { id: 'chat.delete', group: 'Chat', label: 'Delete chat…', icon: <Trash2 />, keywords: ['remove'], run: () => setDialog('delete') },
    ];
    if (streaming) commands.unshift({ id: 'chat.stop', group: 'Chat', label: 'Stop generating', icon: <Square />, shortcut: 'Esc', run: stop });
    else if (lastRole === 'assistant' && keyState === 'ok') {
      commands.splice(1, 0, { id: 'chat.regenerate', group: 'Chat', label: 'Regenerate last reply', icon: <RotateCw />, run: regenerate });
    }
    return register('chat', commands);
  }, [threadId, title, mode, model, streaming, lastRole, keyState, register, navigate, openModelPicker, stop, regenerate]);

  const threadRefForDialogs: ThreadRef | null = useMemo(
    () => (thread ? { id: thread.id, title: thread.title, messageCount: thread.messages.length } : null),
    [thread],
  );

  let body: React.ReactNode;
  if (threads.error && !threads.data) {
    body = (
      <div className="mx-auto w-full max-w-chat px-4 py-8">
        <ErrorNotice error={threads.error} onRetry={() => void threads.refetch()} />
      </div>
    );
  } else if (threadQuery.error && errorCode(threadQuery.error) !== 'not_found' && !thread) {
    body = (
      <div className="mx-auto w-full max-w-chat px-4 py-8">
        <ErrorNotice error={threadQuery.error} onRetry={() => void threadQuery.refetch()} />
      </div>
    );
  } else if (!thread) {
    // Opening a known thread: its layout is known, so a skeleton. Anything else (first load, starting a new chat):
    // Dino, which only fades in if the wait is long enough to notice.
    body =
      threadId && threadQuery.isLoading ? (
        <TimelineSkeleton />
      ) : (
        <DinoLoader label={creating ? 'Starting a chat' : 'Loading chats'} className="min-h-0 flex-1 pb-16" />
      );
  } else if (thread.messages.length === 0) {
    body = (
      <EmptyChat
        thread={thread}
        disabled={keyState !== 'ok'}
        onPick={(prompt) => {
          // The clicked card unmounts once the reply starts: keep focus in the composer.
          inputRef.current?.focus();
          void send(prompt).catch(() => undefined);
        }}
      />
    );
  } else {
    body = <Timeline key={thread.id} thread={thread} pinSignal={pinSignal} canRegenerate={keyState === 'ok'} onRegenerate={regenerate} />;
  }

  return (
    <div className="flex h-full flex-col">
      {thread ? (
        <TopBarActions>
          {thread.costUsd > 0 ? (
            <Tooltip label="Estimated cost of this chat (list price × your discount)" side="bottom">
              <span className="px-1 font-mono text-2xs tabular-nums text-muted-foreground">{formatUsd(thread.costUsd)}</span>
            </Tooltip>
          ) : null}
          <DropdownMenu
            trigger={
              <Button variant="ghost" size="sm" aria-label="Chat actions" className="max-w-80 gap-1 font-normal text-foreground">
                <span className="truncate" title={thread.title}>
                  {thread.title}
                </span>
                <ChevronDown className="opacity-60" />
              </Button>
            }
            items={[
              { label: 'Rename…', icon: <Pencil />, onSelect: () => setDialog('rename') },
              { label: 'Copy as Markdown', icon: <Copy />, onSelect: () => copyText(threadAsMarkdown(thread), 'Chat'), disabled: thread.messages.length === 0 },
              {
                label: 'New chat with this model',
                icon: <Plus />,
                onSelect: () => {
                  const m = thread.settings.mode === 'auto' ? AUTO_MODEL : thread.settings.model;
                  navigate('chat', m ? { new: '1', model: m } : { new: '1' });
                },
              },
              'separator',
              { label: 'Delete…', icon: <Trash2 />, onSelect: () => setDialog('delete'), destructive: true },
            ]}
          />
        </TopBarActions>
      ) : null}

      {body}

      {thread ? (
        <div className="shrink-0 px-4 pb-4">
          <div className="mx-auto w-full max-w-chat">
            <Composer
              key={thread.id}
              thread={thread}
              streaming={streaming}
              keyState={keyState}
              error={sendError}
              budgetWarning={budgetWarning}
              onDismissBudgetWarning={() => setBudgetWarning(null)}
              onSend={send}
              onStop={stop}
              onSettingsChange={changeSettings}
              pickerRef={pickerRef}
              inputRef={inputRef}
            />
          </div>
        </div>
      ) : null}

      <RenameThreadDialog thread={dialog === 'rename' ? threadRefForDialogs : null} onClose={() => setDialog(null)} />
      <DeleteThreadDialog thread={dialog === 'delete' ? threadRefForDialogs : null} onClose={() => setDialog(null)} />
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-chat flex-col gap-6 px-4 pt-8">
        <Skeleton className="ml-auto h-9 w-1/2 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </div>
    </div>
  );
}
