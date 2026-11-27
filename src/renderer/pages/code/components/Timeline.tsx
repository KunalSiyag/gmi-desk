import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronRight, GitCommitHorizontal, Info, Package, Puzzle } from 'lucide-react';
import type { ApprovalDecision, ApprovalRequest, CodeThread, TimelineItem } from '@shared/contracts/code';
import { formatUsd } from '@shared/lib/money';
import { Plates } from '@renderer/components/brand/Plates';
import { Markdown } from '@renderer/components/Markdown';
import { Badge } from '@renderer/components/ui/badge';
import { microLabel } from '@renderer/components/ui/misc';
import { pressMotion, rowPressMotion } from '@renderer/components/ui/motion';
import { cn } from '@renderer/lib/cn';
import { modelName, TOOL_LABEL, timeAgo } from '../format';
import { ApprovalCard } from './ApprovalCard';

function AssistantItem({ item }: { item: Extract<TimelineItem, { kind: 'assistant' }> }) {
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <article className="group flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <span className={microLabel}>{modelName(item.model)}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">step {item.step}</span>
        {item.usage ? <span className="tabular-nums">· {formatUsd(item.usage.costUsd ?? 0)}</span> : null}
        {item.status === 'streaming' ? (
          <span role="status" className="flex items-center gap-1.5">
            <Plates size="sm" /> working…
          </span>
        ) : null}
      </div>
      {item.reasoning ? (
        <div>
          <button
            type="button"
            aria-expanded={showReasoning}
            onClick={() => setShowReasoning((v) => !v)}
            className={cn('-ml-1 flex items-center gap-1 rounded px-1 text-2xs text-muted-foreground hover:text-foreground', pressMotion)}
          >
            <ChevronRight className={cn('size-3 transition-transform duration-150 ease-out', showReasoning && 'rotate-90')} /> Reasoning
          </button>
          {showReasoning ? <div className="mt-1 border-l border-border pl-3 text-xs leading-relaxed text-muted-foreground">{item.reasoning}</div> : null}
        </div>
      ) : null}
      {item.text ? <Markdown className="text-sm [&>*:first-child]:mt-0">{item.text}</Markdown> : null}
      {item.status === 'error' ? <p className="text-xs text-destructive">The step failed.</p> : null}
    </article>
  );
}

function ToolItem({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(item.status === 'failed');
  const output = item.output;
  // Done is brand ink (the one accent green), running pulses the Plates, failures are red.
  const tone =
    item.status === 'failed' || item.status === 'denied'
      ? 'text-destructive'
      : item.status === 'succeeded'
        ? 'text-primary-ink'
        : item.status === 'awaiting_approval'
          ? 'text-warning-foreground'
          : 'text-muted-foreground';
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-card/30">
      {/* A full-width row: hover and press change its background (no scale); the chevron turns in 150 ms. */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn('flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50', rowPressMotion)}
      >
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90" title={item.title}>
          {item.title}
        </span>
        <span className={cn('flex shrink-0 items-center gap-1.5 text-2xs', tone)}>
          {item.status === 'running' ? <Plates size="sm" /> : null}
          {TOOL_LABEL[item.status]}
        </span>
        {item.durationMs !== null ? <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{item.durationMs} ms</span> : null}
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          <pre className="overflow-x-auto font-mono text-2xs leading-5 text-muted-foreground">{item.argsPreview}</pre>
          {output ? (
            <>
              <pre className="max-h-64 overflow-auto rounded bg-foreground/[0.05] p-2 font-mono text-2xs leading-5 text-foreground/80">{output.text}</pre>
              <p className="text-3xs tabular-nums text-muted-foreground">
                {output.totalBytes} bytes{output.truncated ? ' · truncated' : ''}
                {output.exitCode !== undefined && output.exitCode !== null ? ` · exit ${output.exitCode}` : ''}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function NoticeItem({ item }: { item: Extract<TimelineItem, { kind: 'notice' }> }) {
  const Icon = item.level === 'error' ? AlertCircle : Info;
  return (
    <p className={cn('flex items-start gap-2 text-2xs leading-5', item.level === 'error' ? 'text-destructive' : item.level === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground')}>
      <Icon aria-hidden className="mt-[3px] size-3.5 shrink-0" />
      {item.text}
    </p>
  );
}

export function Timeline({
  thread,
  items,
  approvals,
  onDecide,
  deciding,
  pinSignal,
}: {
  thread: CodeThread;
  items: TimelineItem[];
  approvals: Map<string, ApprovalRequest>;
  onDecide: (requestId: string, decision: ApprovalDecision) => void;
  deciding: string | null;
  pinSignal: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const toBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(toBottom, []);
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

  const lastSeq = items.at(-1)?.seq ?? 0;
  void lastSeq;
  const rendered = useMemo(() => items, [items]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          pinned.current = bottom;
          setAtBottom(bottom);
        }}
        className="h-full overflow-y-auto"
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-[54rem] flex-col gap-5 px-4 pb-8 pt-6">
          {rendered.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Send the first message to start this thread.</div>
          ) : null}
          {rendered.map((item) => {
            switch (item.kind) {
              case 'user':
                return (
                  <div key={item.id} className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-secondary px-3.5 py-2.5 text-sm leading-relaxed text-secondary-foreground whitespace-pre-wrap">
                    {item.steering ? (
                      <Badge variant="primary" className="mr-1.5 align-[1px]">
                        Steer
                      </Badge>
                    ) : null}
                    {item.text}
                  </div>
                );
              case 'assistant':
                return <AssistantItem key={item.id} item={item} />;
              case 'tool':
                return <ToolItem key={item.id} item={item} />;
              case 'approval': {
                const live = approvals.get(item.request.requestId);
                return (
                  <ApprovalCard
                    key={item.id}
                    request={live ?? item.request}
                    resolved={live ? null : item.decision}
                    busy={deciding === item.request.requestId}
                    onDecide={(d) => onDecide(item.request.requestId, d)}
                  />
                );
              }
              case 'compaction':
                return (
                  <p key={item.id} className="flex items-start gap-2 text-2xs leading-5 tabular-nums text-muted-foreground">
                    <Package aria-hidden className="mt-[3px] size-3.5 shrink-0" /> Compacted {item.beforeTokens.toLocaleString()} → {item.afterTokens.toLocaleString()} tokens
                    {item.costUsd !== null ? ` · ${formatUsd(item.costUsd)}` : ''}
                  </p>
                );
              case 'checkpoint':
                return (
                  <p key={item.id} className="flex items-start gap-2 text-2xs leading-5 tabular-nums text-muted-foreground">
                    <GitCommitHorizontal aria-hidden className="mt-[3px] size-3.5 shrink-0" /> Checkpoint after turn {item.turn} · {item.filesChanged} file{item.filesChanged === 1 ? '' : 's'} changed
                  </p>
                );
              case 'subagent':
                return (
                  <p key={item.id} className="flex items-start gap-2 text-2xs leading-5 text-muted-foreground">
                    <Puzzle aria-hidden className="mt-[3px] size-3.5 shrink-0" /> {item.agent} · {item.status} {item.summary ? `· ${item.summary}` : ''}
                  </p>
                );
              case 'notice':
                return <NoticeItem key={item.id} item={item} />;
            }
          })}
        </div>
      </div>
      <button
        type="button"
        onClick={toBottom}
        aria-hidden={atBottom}
        tabIndex={atBottom ? -1 : 0}
        className={cn(
          'absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-lg hover:text-foreground',
          'transition-[opacity,color,scale] duration-150 ease-out active:scale-97',
          atBottom && 'pointer-events-none opacity-0',
        )}
      >
        Jump to latest
      </button>
      <span className="sr-only">{thread.status}</span>
    </div>
  );
}
