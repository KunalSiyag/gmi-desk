import { memo, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, RotateCw, Wand2 } from 'lucide-react';
import type { ChatMessage } from '@shared/contracts/chat';
import { GmiError } from '@shared/contracts/errors';
import { formatNumber, formatTokens } from '@shared/lib/format';
import { formatUsd } from '@shared/lib/money';
import { Plates } from '@renderer/components/brand/Plates';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Markdown, useCopy } from '@renderer/components/Markdown';
import { Button } from '@renderer/components/ui/button';
import { microLabel } from '@renderer/components/ui/misc';
import { pressMotion } from '@renderer/components/ui/motion';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { lengthNotice, replyDuration, routingLabel, shortModelName, taskLabel } from './format';

/** Prefix for figures estimated from the text because GMI reported no token counts. */
const APPROX = '≈ ';

/** Hover-revealed message actions: fade in quickly, never shift layout. */
const revealOnHover = 'transition-opacity duration-150 ease-out opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100';

function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <Tooltip label={copied ? 'Copied' : label}>
      <Button variant="ghost" size="icon-xs" aria-label={label} onClick={copy} className={className}>
        {copied ? <Check className="text-primary-ink" /> : <Copy />}
      </Button>
    </Tooltip>
  );
}

export const UserMessage = memo(function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="group/msg flex justify-end">
      <div className="relative max-w-[85%]">
        <div className={cn('absolute right-full top-1 mr-1.5', revealOnHover)}>
          <CopyButton text={message.content} label="Copy message" />
        </div>
        <div className="whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-2 text-[14px] leading-relaxed text-foreground">
          {message.content}
        </div>
      </div>
    </div>
  );
});

function ReasoningBlock({ text, active, tokens, estimated }: { text: string | null; active: boolean; tokens: number | null; estimated?: boolean }) {
  const [open, setOpen] = useState(active);
  const touched = useRef(false);
  // Follow the stream (open while thinking, collapse when the answer starts) until the user toggles it.
  useEffect(() => {
    if (!touched.current) setOpen(active);
  }, [active]);
  const body = (text ?? '').trim();
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((v) => !v);
        }}
        className={cn('-ml-1 flex h-6 w-fit items-center gap-1.5 rounded-md pl-1 pr-1.5 text-2xs font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground', pressMotion)}
      >
        <ChevronRight className={cn('size-3.5 transition-transform duration-150 ease-out', open && 'rotate-90')} />
        {active ? (
          <>
            <span>Thinking</span>
            <Plates size="sm" />
          </>
        ) : (
          <span>Reasoning</span>
        )}
        {!active && tokens ? (
          <span className="font-mono font-normal tabular-nums text-muted-foreground">
            <span aria-hidden className="mr-1.5 text-muted-foreground/45">
              ·
            </span>
            {estimated ? APPROX : ''}
            {formatTokens(tokens)} tokens
          </span>
        ) : null}
      </button>
      {open && body ? (
        <div className="mb-1 ml-[6px] mt-1.5 whitespace-pre-wrap break-words border-l border-input pl-4 text-[13px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      ) : null}
    </div>
  );
}

function ModelLabel({ message }: { message: ChatMessage }) {
  if (message.routing) {
    const r = message.routing;
    const task = taskLabel(r.taskType);
    const detail = [
      `GMI Router picked ${r.selectedModel}${task ? ` for a ${task} task` : ''}${r.mode ? ` (${r.mode} mode)` : ''}.`,
      r.fallbackModels.length ? `Backup: ${r.fallbackModels.join(', ')}.` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <Tooltip label={detail}>
        <span className="flex min-w-0 items-center gap-1 text-foreground/80">
          <Wand2 className="size-3 shrink-0 text-primary-ink" />
          <span className="truncate">{routingLabel(r)}</span>
        </span>
      </Tooltip>
    );
  }
  if (!message.model) return <span>Auto</span>;
  return (
    <Tooltip label={message.model}>
      <span className="min-w-0 truncate text-foreground/80">{shortModelName(message.model)}</span>
    </Tooltip>
  );
}

function UsageLabel({ message }: { message: ChatMessage }) {
  const u = message.usage;
  if (!u) return null;
  const estimated = message.usageEstimated === true;
  const approx = estimated ? APPROX : '';
  const seconds = replyDuration(message);
  const rate = seconds && u.completionTokens ? Math.round(u.completionTokens / seconds) : null;
  const lines = [
    estimated ? 'GMI sent no token counts for this reply; estimated from its length' : null,
    `Prompt ${approx}${formatNumber(u.promptTokens)} tokens${u.cachedTokens ? ` (${formatNumber(u.cachedTokens)} cached)` : ''}`,
    `Reply ${approx}${formatNumber(u.completionTokens)} tokens${u.reasoningTokens ? ` (${formatNumber(u.reasoningTokens)} reasoning)` : ''}`,
    seconds ? `${seconds.toFixed(1)}s${rate && !estimated ? ` · ${formatNumber(rate)} tokens/s` : ''}` : null,
  ].filter(Boolean);
  return (
    <Tooltip label={lines.join(' · ')}>
      <span className="shrink-0 whitespace-nowrap">
        {approx}
        {formatTokens(u.promptTokens)} in · {formatTokens(u.completionTokens)} out
      </span>
    </Tooltip>
  );
}

const Dot = () => (
  <span aria-hidden className="shrink-0 text-muted-foreground/45">
    ·
  </span>
);

export interface AssistantMessageProps {
  message: ChatMessage;
  isLast: boolean;
  /** Thread is in Auto mode (shows "Routing" before the model is known). */
  auto: boolean;
  onRegenerate?: () => void;
}

export const AssistantMessage = memo(function AssistantMessage({ message, isLast, auto, onRegenerate }: AssistantMessageProps) {
  const streaming = message.status === 'streaming';
  const thinking = streaming && !message.content;
  const showReasoning = Boolean(message.reasoning);
  const error = message.status === 'error' && message.error ? GmiError.fromShape(message.error) : null;
  const cutOff = lengthNotice(message);
  const estimated = message.usageEstimated === true;

  let pending: string | null = null;
  if (streaming && !message.content && !message.reasoning) pending = auto && !message.routing ? 'Routing' : 'Thinking';

  return (
    <div className="group/msg flex flex-col gap-1.5">
      {showReasoning ? (
        <ReasoningBlock text={message.reasoning} active={thinking} tokens={message.usage?.reasoningTokens ?? null} estimated={estimated} />
      ) : null}
      {message.content ? <Markdown className="text-foreground [&>*:first-child]:mt-0">{message.content}</Markdown> : null}
      {pending ? (
        <div role="status" className="flex h-6 items-center gap-2.5 text-muted-foreground">
          <Plates />
          <span className={microLabel}>{pending}</span>
        </div>
      ) : null}
      {!streaming && !message.content && message.status === 'stopped' ? (
        <p className="text-[13px] text-muted-foreground">Stopped before any text arrived.</p>
      ) : null}
      {!streaming && !message.content && message.status === 'complete' ? (
        <p className="text-[13px] text-muted-foreground">The model returned an empty reply.</p>
      ) : null}
      {error ? (
        <ErrorNotice
          compact
          error={error}
          onRetry={isLast ? onRegenerate : undefined}
          // The gateway's breaker fast fail (detail `breaker_open`): retrying forces one probe request.
          retryLabel={message.error?.detail === 'breaker_open' ? 'Try anyway' : undefined}
          className="mt-1"
        />
      ) : null}
      {cutOff ? <p className="text-2xs text-warning-foreground">{cutOff}</p> : null}

      {/* While nothing has arrived yet the pending row says it all; the meta line appears with the first token. */}
      <div className={cn('flex h-6 min-w-0 items-center gap-1.5 font-mono text-2xs tabular-nums text-muted-foreground', pending && 'hidden')}>
        <ModelLabel message={message} />
        {streaming && message.content ? (
          <>
            <Dot />
            <span className="flex shrink-0 items-center gap-1.5">
              <Plates size="sm" />
              Writing
            </span>
          </>
        ) : null}
        {message.usage ? (
          <>
            <Dot />
            <UsageLabel message={message} />
          </>
        ) : null}
        {message.costUsd !== null && message.costUsd > 0 ? (
          <>
            <Dot />
            <Tooltip
              label={
                estimated
                  ? 'Estimated from the length of the conversation and the reply (GMI sent no token counts), at list prices and your discount'
                  : 'Estimated from list prices and your discount'
              }
            >
              <span className="shrink-0 whitespace-nowrap">
                {estimated ? APPROX : ''}
                {formatUsd(message.costUsd)}
              </span>
            </Tooltip>
          </>
        ) : null}
        {message.status === 'stopped' ? (
          <>
            <Dot />
            <span className="shrink-0">Stopped</span>
          </>
        ) : null}
        {!streaming ? (
          <div className={cn('ml-auto flex shrink-0 items-center gap-0.5 font-sans', isLast ? 'opacity-100' : revealOnHover)}>
            {message.content ? <CopyButton text={message.content} label="Copy reply" /> : null}
            {isLast && onRegenerate && !error ? (
              <Tooltip label="Regenerate">
                <Button variant="ghost" size="icon-xs" aria-label="Regenerate reply" onClick={onRegenerate}>
                  <RotateCw />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});
