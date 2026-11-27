import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import type { CodeThread, RuntimeMode } from '@shared/contracts/code';
import { Button } from '@renderer/components/ui/button';
import { Select } from '@renderer/components/ui/select';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/cn';
import { modelName } from '../format';

const MODES: Array<{ value: RuntimeMode; label: string }> = [
  { value: 'approval-required', label: 'Approval required' },
  { value: 'auto-accept-edits', label: 'Auto-accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'full-access', label: 'Full access' },
];

export function Composer({
  thread,
  models,
  busy,
  onSend,
  onSteer,
  onStop,
  onMode,
  onModel,
}: {
  thread: CodeThread;
  models: Array<{ value: string; label: string }>;
  busy: boolean;
  onSend: (text: string) => Promise<void>;
  onSteer: (text: string) => Promise<void>;
  onStop: () => void;
  onMode: (mode: RuntimeMode) => void;
  onModel: (model: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = thread.status === 'running' || thread.status === 'queued' || thread.status === 'compacting' || thread.status === 'awaiting_approval';

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    if (running) await onSteer(value);
    else await onSend(value);
  };

  const modelOptions = thread.settings.model && !models.some((m) => m.value === thread.settings.model) ? [{ value: thread.settings.model, label: modelName(thread.settings.model) }, ...models] : models;

  return (
    <div className="border-t border-border/70 bg-background/80 px-4 py-3 backdrop-blur">
      <div className="mx-auto w-full max-w-[54rem]">
        {/* Same box as Chat's composer: card surface, the border firms up on focus (colour eases, nothing moves). */}
        <div className="rounded-xl border border-border bg-card shadow-xs transition-[border-color] duration-150 ease-out focus-within:border-foreground/20 dark:shadow-none dark:focus-within:border-white/[0.16]">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={running ? 'Steer this run after the current step…' : `Message the agent in ${thread.branch ?? 'this worktree'}…`}
            aria-label={running ? 'Steer the run' : 'Message the agent'}
            className="max-h-[220px] min-h-14 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1.5 px-2 pb-2">
            <Select
              variant="ghost"
              value={thread.settings.mode}
              onValueChange={(v) => onMode(v as RuntimeMode)}
              options={MODES}
              aria-label="Permission mode"
            />
            <Select
              variant="ghost"
              value={thread.settings.model}
              onValueChange={onModel}
              options={modelOptions}
              placeholder="Choose a model"
              aria-label="Model"
              className="max-w-52"
            />
            <span className="flex-1" />
            {running ? (
              <Tooltip label="Stop the run">
                <Button size="icon-sm" variant="secondary" onClick={onStop} aria-label="Stop the run" className="rounded-lg border border-input text-foreground">
                  <Square className="size-2.5 fill-current" />
                </Button>
              </Tooltip>
            ) : null}
            {/* Lime only once there is something to send; empty, it is a quiet grey key (as in Chat). */}
            <Button
              size="icon-sm"
              onClick={() => void submit()}
              disabled={!text.trim() || busy}
              aria-label={running ? 'Steer' : 'Send'}
              className="rounded-lg disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none [&_svg]:size-4 [&_svg]:stroke-[2.25]"
            >
              <ArrowUp />
            </Button>
          </div>
        </div>
        <p className={cn('mt-1.5 text-center text-3xs text-muted-foreground', running && text.trim() && 'text-primary-ink')}>
          {running && text.trim() ? 'Enter queues this as steering for the running turn' : 'Enter sends · Shift+Enter for a new line'}
        </p>
      </div>
    </div>
  );
}
