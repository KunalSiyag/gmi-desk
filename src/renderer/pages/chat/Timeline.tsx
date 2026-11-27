import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { ChatThread } from '@shared/contracts/chat';
import { Plates } from '@renderer/components/brand/Plates';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/cn';
import { AssistantMessage, UserMessage } from './MessageView';

const BOTTOM_SLACK_PX = 48;

/**
 * The message column. Follows the stream while the user is at the bottom; scrolling up stops
 * following and shows "Jump to latest". `pinSignal` changes when the user sends (re-pins).
 * `canRegenerate` is false when no usable inference key is stored (Regenerate/Retry are hidden).
 */
export function Timeline({
  thread,
  pinSignal,
  canRegenerate,
  onRegenerate,
}: {
  thread: ChatThread;
  pinSignal: number;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Mounted per thread (keyed by id): start at the latest message.
  useLayoutEffect(() => {
    toBottom();
  }, []);

  // Content grows while streaming (and when Markdown or reasoning blocks change size).
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (pinSignal === 0) return;
    pinned.current = true;
    setAtBottom(true);
    toBottom();
  }, [pinSignal]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    pinned.current = bottom;
    setAtBottom(bottom);
  };

  const messages = thread.messages;
  const auto = thread.settings.mode === 'auto';
  const streaming = messages.some((m) => m.status === 'streaming');

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto [overflow-anchor:none]">
        <div ref={contentRef} className="mx-auto flex w-full max-w-chat flex-col gap-6 px-4 pb-10 pt-8">
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <UserMessage key={m.id} message={m} />
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                isLast={i === messages.length - 1}
                auto={auto}
                onRegenerate={i === messages.length - 1 && canRegenerate ? onRegenerate : undefined}
              />
            ),
          )}
        </div>
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent" />
      {/* Stays mounted so it can fade and rise in (and out, faster); inert while hidden. */}
      <Button
        variant="outline"
        size="sm"
        inert={atBottom}
        aria-hidden={atBottom || undefined}
        onClick={() => {
          pinned.current = true;
          setAtBottom(true);
          toBottom();
        }}
        className={cn(
          // Floats over the messages, so its surface stays opaque in both themes (the outline variant is see-through on
          // dark, and so is bg-accent).
          'absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-popover pl-2 pr-3 text-foreground shadow-lg shadow-black/10 hover:bg-muted dark:bg-popover dark:shadow-black/40 dark:hover:bg-secondary-hover',
          'transition-[opacity,translate,scale,background-color,border-color] ease-out',
          atBottom ? 'pointer-events-none translate-y-1 opacity-0 duration-100 motion-reduce:translate-y-0' : 'translate-y-0 opacity-100 duration-200',
        )}
      >
        {streaming ? <Plates size="sm" className="mx-1" /> : <ArrowDown />}
        {streaming ? 'Follow reply' : 'Jump to latest'}
      </Button>
    </div>
  );
}
