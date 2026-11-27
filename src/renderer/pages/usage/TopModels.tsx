import { ChevronRight, CircleDashed, MessageSquarePlus } from 'lucide-react';
import type { AccountSummary } from '@shared/contracts/usage';
import { formatNumber, formatTokens } from '@shared/lib/format';
import { formatUsd } from '@shared/lib/money';
import { useUi } from '@renderer/lib/store';
import { cn } from '@renderer/lib/cn';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, microLabel, Skeleton } from '@renderer/components/ui/misc';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { ACCOUNT_EMPTY, BAR_FILL, Panel } from './parts';

const GRID = 'grid grid-cols-[1.25rem_minmax(0,1fr)_minmax(3rem,7.5rem)_4.75rem_3.75rem_3rem] items-center gap-3';

/** "openai/gpt-6-astra" → provider "openai/" (quiet) + model "gpt-6-astra". */
function splitModel(id: string): [string, string] {
  const i = id.lastIndexOf('/');
  return i > 0 ? [id.slice(0, i + 1), id.slice(i + 1)] : ['', id];
}

/** Ranked horizontal bars of LLM spend per model (one brand hue on a faint track; every value is also printed in its row). */
export function TopModels({
  summary,
  loading,
  periodLabel,
}: {
  summary: AccountSummary | undefined;
  loading: boolean;
  periodLabel: string;
}) {
  const navigate = useUi((s) => s.navigate);
  const models = summary?.topModels ?? [];
  const max = models.reduce((m, r) => Math.max(m, r.costUsd), 0);
  const total = summary?.llmTokenCostUsd ?? null;

  return (
    <Panel title="Top models" meta={`LLM spend · ${periodLabel.toLowerCase()}`} className={ACCOUNT_EMPTY.card} bodyClassName="flex flex-col px-2 py-2">
      {loading && !summary ? (
        <div className="flex flex-col px-2" aria-hidden>
          <div className="pb-2 pt-1">
            <Skeleton className="h-2.5 w-full max-w-24" />
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className={cn(GRID, 'h-8')}>
              <Skeleton className="h-2.5" />
              <Skeleton className="h-3" style={{ width: `${80 - i * 8}%` }} />
              <Skeleton className="h-1.5" style={{ width: `${100 - i * 14}%` }} />
              <Skeleton className="ml-auto h-3 w-12" />
              <Skeleton className="ml-auto h-2.5 w-8" />
              <Skeleton className="ml-auto h-2.5 w-6" />
            </div>
          ))}
        </div>
      ) : models.length === 0 && summary?.usageNote ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-2 py-10 text-center text-xs text-muted-foreground">
          <CircleDashed aria-hidden className="size-4" />
          <p>GMI could not measure LLM usage for this period.</p>
        </div>
      ) : models.length === 0 ? (
        <EmptyState
          dino="sleep"
          className={ACCOUNT_EMPTY.dino}
          title="No LLM usage in this period"
          description="Chats with GMI models land here, ranked by what they cost."
          action={
            <Button size="sm" variant="outline" onClick={() => navigate('chat', { new: '1' })}>
              <MessageSquarePlus /> Start a chat
            </Button>
          }
        />
      ) : (
        <div>
          <div aria-hidden className={cn(GRID, microLabel, 'px-2 pb-1.5 pt-0.5')}>
            <span>#</span>
            <span>Model</span>
            <span />
            <span className="text-right">Cost</span>
            <span className="text-right">Tokens</span>
            <span className="text-right">Req</span>
          </div>
          <ul aria-label="LLM spend by model">
            {models.map((m, i) => {
              const width = max > 0 ? (m.costUsd / max) * 100 : 0;
              const share = total && total > 0 ? Math.round((m.costUsd / total) * 1000) / 10 : null;
              const summaryText = `${formatUsd(m.costUsd)}${share !== null ? ` (${share}% of LLM spend)` : ''}, ${formatNumber(m.tokens)} tokens, ${formatNumber(m.requests)} requests`;
              const [provider, name] = splitModel(m.model);
              return (
                <li key={m.model}>
                  <Tooltip label={share !== null ? `${share}% of LLM spend · open in Models` : 'Open in Models'} side="top">
                    <button
                      type="button"
                      onClick={() => navigate('models', { model: m.model })}
                      aria-label={`${m.model}: ${summaryText}. Open in Models`}
                      className={cn(GRID, 'group h-8 w-full rounded-md px-2 text-left outline-offset-[-2px] hover:bg-accent focus-visible:bg-accent', rowPressMotion)}
                    >
                      <span className="font-mono text-3xs tabular-nums text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                      <span className="flex min-w-0 items-center gap-1 text-[13px]" title={m.model}>
                        <span className="min-w-0 truncate">
                          {provider ? <span className="text-muted-foreground">{provider}</span> : null}
                          {name}
                        </span>
                        <ChevronRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-visible:opacity-100" />
                      </span>
                      <span className="flex h-1.5 items-center overflow-hidden rounded-sm bg-muted dark:bg-white/[0.04]">
                        {width > 0 ? <span className={cn('block h-full rounded-sm', BAR_FILL)} style={{ width: `${Math.max(width, 2)}%` }} /> : null}
                      </span>
                      <span className="text-right text-[13px] font-medium tabular-nums">{formatUsd(m.costUsd)}</span>
                      <span className="text-right text-2xs tabular-nums text-muted-foreground">{formatTokens(m.tokens)}</span>
                      <span className="text-right text-2xs tabular-nums text-muted-foreground">{formatNumber(m.requests)}</span>
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
