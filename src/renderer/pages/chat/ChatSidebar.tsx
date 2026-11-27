import { memo, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatThreadSummary } from '@shared/contracts/chat';
import { Plates } from '@renderer/components/brand/Plates';
import { ActiveBar } from '@renderer/components/ui/active-bar';
import { DropdownMenu } from '@renderer/components/ui/menu';
import { MicroLabel, SectionLabel, Skeleton } from '@renderer/components/ui/misc';
import { pressMotion, rowPressMotion } from '@renderer/components/ui/motion';
import { cn } from '@renderer/lib/cn';
import { describeError } from '@renderer/lib/errors';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { useUi } from '@renderer/lib/store';
import { compactTime, groupThreads } from './format';
import { useNow, useThreads } from './hooks';
import { DeleteThreadDialog, type ThreadRef } from './ThreadDialogs';

const VISIBLE_LIMIT = 50;

/** Recent chats, shown in the app sidebar under the navigation. */
export function ChatSidebar() {
  const threads = useThreads();
  const page = useUi((s) => s.page);
  const activeThread = useUi((s) => (s.page === 'chat' ? (s.params.thread ?? null) : null));
  const navigate = useUi((s) => s.navigate);
  const now = useNow(60_000);
  const groupId = useId();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreadRef | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (threads.isLoading) {
    return (
      <div className="flex flex-col gap-1.5 px-2 pt-1">
        <SectionLabel className="px-0">Recent</SectionLabel>
        {[70, 85, 60].map((w) => (
          <Skeleton key={w} className="h-4" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  if (threads.error) {
    return (
      <div className="px-2">
        <SectionLabel className="px-0">Recent</SectionLabel>
        <button type="button" className="text-2xs text-muted-foreground hover:text-foreground" onClick={() => void threads.refetch()}>
          Could not load chats. Retry
        </button>
      </div>
    );
  }

  const list = threads.data ?? [];
  const visible = showAll ? list : list.slice(0, VISIBLE_LIMIT);
  const groups = groupThreads(visible, now);

  return (
    <nav aria-label="Recent chats" className="flex flex-col">
      {/* With chats, the date groups (Today, Yesterday…) are the headings; "Recent" names the list only while empty. */}
      {list.length === 0 ? (
        <>
          <SectionLabel>Recent</SectionLabel>
          <p className="px-2 py-1 text-2xs text-muted-foreground">Your chats will show up here.</p>
        </>
      ) : null}
      {groups.map((group, i) => (
        <div key={group.label} className="flex flex-col">
          <MicroLabel as="div" id={`${groupId}-${i}`} className="px-2 pb-1 pt-2">
            {group.label}
          </MicroLabel>
          <ul aria-labelledby={`${groupId}-${i}`} className="flex flex-col gap-px">
            {group.threads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                active={page === 'chat' && t.id === activeThread}
                time={compactTime(t.updatedAt, now)}
                renaming={renamingId === t.id}
                onOpen={() => navigate('chat', { thread: t.id })}
                onRename={() => setRenamingId(t.id)}
                onRenameDone={() => setRenamingId(null)}
                onDelete={() => setDeleting({ id: t.id, title: t.title, messageCount: t.messageCount })}
              />
            ))}
          </ul>
        </div>
      ))}
      {list.length > VISIBLE_LIMIT && !showAll ? (
        <button type="button" onClick={() => setShowAll(true)} className={cn('mt-1 h-7 rounded-md px-2 text-left text-2xs text-muted-foreground hover:bg-accent/60 hover:text-foreground', rowPressMotion)}>
          Show {list.length - VISIBLE_LIMIT} older chats
        </button>
      ) : null}
      <DeleteThreadDialog thread={deleting} onClose={() => setDeleting(null)} />
    </nav>
  );
}

interface ThreadRowProps {
  thread: ChatThreadSummary;
  active: boolean;
  time: string;
  renaming: boolean;
  onOpen: () => void;
  onRename: () => void;
  onRenameDone: () => void;
  onDelete: () => void;
}

const ThreadRow = memo(function ThreadRow({ thread, active, time, renaming, onOpen, onRename, onRenameDone, onDelete }: ThreadRowProps) {
  return (
    // Selection is instant (the selected row has no transition): it follows clicks and keyboard navigation.
    <li
      className={cn(
        'group/row relative flex h-7 items-center rounded-md text-[13px]',
        // Other rows take the kit's row press (background, no scale); the open row's styles never ease.
        active ? 'bg-accent font-medium text-foreground' : cn('text-sidebar-foreground hover:bg-accent/60 hover:text-foreground', rowPressMotion),
      )}
    >
      {active ? <ActiveBar /> : null}
      {renaming ? (
        <RenameInput thread={thread} onDone={onRenameDone} />
      ) : (
        <button
          type="button"
          onClick={onOpen}
          onDoubleClick={onRename}
          aria-current={active ? 'page' : undefined}
          title={thread.title}
          className="flex h-full min-w-0 flex-1 items-center rounded-md pl-2 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {thread.streaming ? <span className="sr-only">(replying)</span> : null}
        </button>
      )}
      {renaming ? null : (
        <div className="relative flex h-full w-9 shrink-0 items-center justify-end pr-1.5">
          {/* The trigger comes first so the time/spinner after it can hide (peer) while the menu is open or focused. */}
          <DropdownMenu
            align="start"
            trigger={
              <button
                type="button"
                aria-label={`Actions for ${thread.title}`}
                className={cn(
                  'peer/menu absolute right-0.5 flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover/row:opacity-100 data-[popup-open]:opacity-100',
                  pressMotion,
                )}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
            items={[
              { label: 'Rename', icon: <Pencil />, onSelect: onRename },
              'separator',
              { label: 'Delete', icon: <Trash2 />, onSelect: onDelete, destructive: true },
            ]}
          />
          {/* pointer-events-none: hidden at opacity 0, they still paint above the trigger and would take its clicks. */}
          {thread.streaming ? (
            <Plates
              size="sm"
              className="pointer-events-none group-hover/row:opacity-0 peer-focus-visible/menu:opacity-0 peer-data-[popup-open]/menu:opacity-0"
            />
          ) : (
            <span className="pointer-events-none font-mono text-3xs font-normal tabular-nums text-muted-foreground group-hover/row:opacity-0 peer-focus-visible/menu:opacity-0 peer-data-[popup-open]/menu:opacity-0">
              {time}
            </span>
          )}
        </div>
      )}
    </li>
  );
});

function RenameInput({ thread, onDone }: { thread: ChatThreadSummary; onDone: () => void }) {
  const client = useQueryClient();
  const done = useRef(false);
  const commit = (raw: string) => {
    if (done.current) return;
    done.current = true;
    const title = raw.trim();
    onDone();
    if (!title || title === thread.title) return;
    gmi.chat
      .updateThread(thread.id, { title })
      // The open chat's header and Rename dialog read the cached thread, not the summaries.
      .then((next) => client.setQueryData(qk.thread(thread.id), next))
      .catch((error: unknown) => {
        toast.error('Could not rename the chat', { description: describeError(error).message || undefined });
      });
  };
  return (
    <input
      autoFocus
      aria-label="Chat title"
      defaultValue={thread.title}
      maxLength={200}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onDone();
        }
      }}
      className="mx-0.5 h-6 min-w-0 flex-1 rounded border border-ring/60 bg-background px-1.5 text-[13px] text-foreground outline-none"
    />
  );
}
