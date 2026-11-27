import { Code2, Lightbulb, PenLine, Scale, Wand2, type LucideIcon } from 'lucide-react';
import type { ChatThread } from '@shared/contracts/chat';
import { Dino } from '@renderer/components/brand/Dino';
import { modelPriceLabel } from '@renderer/components/ModelPicker';
import { microLabel } from '@renderer/components/ui/misc';
import { cn } from '@renderer/lib/cn';
import { useCatalog } from '@renderer/lib/hooks';
import { shortModelName } from './format';

interface Starter {
  icon: LucideIcon;
  title: string;
  prompt: string;
}

const STARTERS: Starter[] = [
  { icon: Scale, title: 'Compare models', prompt: 'Compare GLM-5.3 and DeepSeek V4 Pro for coding' },
  { icon: Code2, title: 'Write code', prompt: 'Write a Python script that streams a chat reply from GMI' },
  { icon: Lightbulb, title: 'Explain a concept', prompt: 'Explain KV cache in 5 bullets' },
  { icon: PenLine, title: 'Draft copy', prompt: 'Draft a launch tweet for our GPU cluster' },
];

/** New, empty thread: Dino, a greeting, the model in use, starter prompts. */
export function EmptyChat({ thread, onPick, disabled }: { thread: ChatThread; onPick: (prompt: string) => void; disabled?: boolean }) {
  const catalog = useCatalog();
  const auto = thread.settings.mode === 'auto';
  const model = !auto && thread.settings.model ? (catalog.data?.models.find((m) => m.id === thread.settings.model) ?? null) : null;
  const price = model ? modelPriceLabel(model) : null;
  const modelName = model?.name ?? shortModelName(thread.settings.model);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-8">
      {/* m-auto (not justify-center) centres it without clipping the top when the window is short. */}
      <div className="m-auto w-full max-w-chat">
        <div className="flex flex-col items-center text-center">
          {/* Dino stands on GMI's faint grid floor. */}
          <div className="relative mb-5 flex items-end justify-center">
            <div aria-hidden className="grid-floor pointer-events-none absolute -inset-x-24 -inset-y-10" />
            <Dino mood="idle" size={76} className="relative" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">What are we working on?</h1>
          {auto ? (
            <p className="mt-2 flex max-w-full flex-wrap items-center justify-center gap-x-1.5 text-[13px] text-muted-foreground">
              <Wand2 aria-hidden className="size-3.5 shrink-0 text-primary-ink" />
              <span className="font-medium text-foreground">Auto · GMI Router</span>
              <span>picks the best model for each message</span>
            </p>
          ) : (
            <p className="mt-2 flex max-w-full flex-wrap items-center justify-center gap-x-1.5 text-[13px] text-muted-foreground">
              <span>Chatting with</span>
              <span className="max-w-80 truncate font-medium text-foreground" title={thread.settings.model ?? undefined}>
                {modelName}
              </span>
              {price ? (
                <>
                  <span aria-hidden className="text-muted-foreground/50">
                    ·
                  </span>
                  <span className="font-mono text-2xs tabular-nums">{price}</span>
                </>
              ) : null}
            </p>
          )}
        </div>

        <div className="mt-9">
          <p className={cn('mb-2 px-0.5 text-muted-foreground', microLabel)}>Start with</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {STARTERS.map(({ icon: Icon, title, prompt }) => (
              <button
                key={title}
                type="button"
                disabled={disabled}
                onClick={() => onPick(prompt)}
                title={prompt}
                className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-[background-color,border-color,scale] duration-150 ease-out hover:border-primary-ink/35 hover:bg-accent/40 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors duration-150 ease-out group-hover:border-primary-ink/30 group-hover:text-primary-ink">
                  <Icon aria-hidden className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-foreground">{title}</span>
                  <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{prompt}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {auto ? null : (
          <p className="mt-5 flex items-center justify-center gap-1.5 text-2xs text-muted-foreground">
            <Wand2 aria-hidden className="size-3 shrink-0" />
            <span>
              Tip: pick <span className="font-medium text-foreground">Auto</span> in the model menu to let GMI Router choose per message.
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
