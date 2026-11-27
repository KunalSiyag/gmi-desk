import { useContext, useState } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { MessageSquare, Receipt, Server, Sparkles } from 'lucide-react';
import type { ComputeState } from '@shared/contracts/compute';
import type { LocalSpend as LocalSpendData, SpendKind } from '@shared/contracts/usage';
import { formatNumber } from '@shared/lib/format';
import { formatUsd } from '@shared/lib/money';
import { cn } from '@renderer/lib/cn';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { Button } from '@renderer/components/ui/button';
import { EmptyState, MicroLabel, microLabel, Skeleton } from '@renderer/components/ui/misc';
import { formatWhen, Panel, SegmentedBar, SERIES } from './parts';

const COLLAPSED_ROWS = 8;
const KIND_LABEL: Record<SpendKind, string> = { chat: 'Chat', media: 'Media', compute: 'Compute', agent: 'Agents' };

/** Compute's swatch: a quiet neutral, so chat (lime) and media (olive) stay the two brand series. */
export const COMPUTE_SWATCH = 'bg-foreground/35';

function Swatch({ kind }: { kind: SpendKind }) {
  // Agent rows (not recorded yet) share the media swatch until their own series exists.
  const series = kind === 'chat' ? SERIES.chat : kind === 'compute' ? COMPUTE_SWATCH : SERIES.media;
  return <span aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', series)} />;
}

function KindTag({ kind }: { kind: SpendKind }) {
  const Icon = kind === 'chat' ? MessageSquare : kind === 'compute' ? Server : Sparkles;
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Swatch kind={kind} />
      <Icon aria-hidden className="size-3" />
      {KIND_LABEL[kind]}
    </span>
  );
}

/** Used only when no QueryClientProvider is mounted (markup tests): its query never runs. */
const DETACHED_CLIENT = new QueryClient();

/**
 * The compute slice's live figures (compute.md §9.3): today / month at list price and what bills now. Null while the
 * compute slice is unavailable (no key, stub) or when nothing was ever spent, so the row stays out of the way.
 */
function useComputeSpend(): ComputeState | null {
  const client = useContext(QueryClientContext);
  const query = useQuery(
    {
      queryKey: qk.computeState,
      queryFn: () => gmi.compute.getState(),
      enabled: client !== undefined,
      retry: false,
      staleTime: 30_000,
      refetchInterval: 60_000,
    },
    client ?? DETACHED_CLIENT,
  );
  return query.data ?? null;
}

/**
 * "This device" compute row: containers and sandboxes this app runs, estimated at list price. The figures are the
 * local day and month (the budget's windows), not the page period, because compute accrues continuously.
 */
export function ComputeSpendRow({ state }: { state: ComputeState | null }) {
  if (!state || (state.monthUsd <= 0 && state.running.count === 0)) return null;
  const { running } = state;
  return (
    <div data-compute-spend className="flex min-w-0 flex-col gap-1 border-t border-border pt-3">
      <span className="flex items-center gap-1.5">
        <Swatch kind="compute" />
        <MicroLabel>Compute</MicroLabel>
        <span className="truncate text-2xs text-muted-foreground">this month · list price</span>
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 tabular-nums">
        <span className="text-lg font-semibold leading-6 tracking-tight">{formatUsd(state.monthUsd)}</span>
        <span className="text-2xs text-muted-foreground">{formatUsd(state.todayUsd)} today</span>
        {running.count > 0 ? (
          <span className="text-2xs text-muted-foreground">
            · {formatNumber(running.count)} running at {formatUsd(running.usdPerHour)}/h
          </span>
        ) : null}
      </span>
      <p className="text-2xs text-muted-foreground">Containers and sandboxes started in GMI Desk; counted in your budget. Your organization may pay less.</p>
    </div>
  );
}

/** What this device spent (app estimates) for the period: the total, chat vs media split, compute, the latest entries. */
export function LocalSpend({ spend, loading, periodLabel }: { spend: LocalSpendData | undefined; loading: boolean; periodLabel: string }) {
  const [expanded, setExpanded] = useState(false);
  const compute = useComputeSpend();
  const total = spend ? spend.chatUsd + spend.mediaUsd : 0;
  const counts: Record<SpendKind, number> = { chat: 0, media: 0, compute: 0, agent: 0 };
  for (const m of spend?.byModel ?? []) counts[m.kind] += m.count;
  const entries = spend?.entries ?? [];
  const shown = expanded ? entries : entries.slice(0, COLLAPSED_ROWS);
  const now = new Date();
  const empty = !spend || spend.entries.length === 0;

  return (
    <Panel title="Spend" meta={periodLabel.toLowerCase()} bodyClassName="flex flex-col gap-4 pt-3.5">
      {loading && !spend ? (
        <div aria-hidden className="flex flex-col gap-3">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-2.5 w-3/4" />
          <div className="grid grid-cols-2 gap-3 pt-1">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
          <Skeleton className="h-1.5" />
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-3" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-[2rem] font-semibold leading-9 tracking-tight tabular-nums">{formatUsd(total)}</span>
            <p className="text-2xs text-muted-foreground">Estimated cost of chats and generations started in GMI Desk.</p>
          </div>

          {empty ? (
            // The kit empty state, like Media activity's (the one Dino on this page is in Top models).
            <EmptyState
              icon={<Receipt />}
              className="px-4 pb-4 pt-3"
              title="Nothing spent from this device"
              description={`No chats or generations in the ${periodLabel.toLowerCase()}.`}
            />
          ) : (
            <>
              <div className="flex flex-col gap-2.5">
                <div className="grid grid-cols-2 gap-3">
                  {(['chat', 'media'] as const).map((kind) => (
                    <div key={kind} className="flex min-w-0 flex-col gap-1">
                      <span className="flex items-center gap-1.5">
                        <Swatch kind={kind} />
                        <MicroLabel>{KIND_LABEL[kind]}</MicroLabel>
                      </span>
                      <span className="flex min-w-0 items-baseline gap-1.5 tabular-nums">
                        <span className="text-lg font-semibold leading-6 tracking-tight">{formatUsd(kind === 'chat' ? spend.chatUsd : spend.mediaUsd)}</span>
                        <span className="truncate text-2xs text-muted-foreground">
                          {formatNumber(counts[kind])} {counts[kind] === 1 ? 'entry' : 'entries'}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                <SegmentedBar
                  label="Chat and media share of this device's spend"
                  parts={[
                    { name: 'Chat', value: spend.chatUsd, className: SERIES.chat },
                    { name: 'Media', value: spend.mediaUsd, className: SERIES.media },
                  ]}
                />
              </div>

              <div className="min-w-0">
                <div className={cn('relative', expanded && 'max-h-72 overflow-y-auto')}>
                  <table className="w-full table-fixed text-xs">
                    <caption className="sr-only">Latest spend recorded on this device</caption>
                    <thead className="sticky top-0 bg-card">
                      <tr className={cn('text-left', microLabel)}>
                        <th scope="col" className="w-[6.5rem] pb-1.5 font-medium">
                          Time
                        </th>
                        <th scope="col" className="w-[5.5rem] pb-1.5 font-medium">
                          Kind
                        </th>
                        <th scope="col" className="pb-1.5 font-medium">
                          Model
                        </th>
                        <th scope="col" className="w-[4.5rem] pb-1.5 text-right font-medium">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((e) => (
                        <tr key={e.id} className="h-7 border-t border-border">
                          <td className="truncate tabular-nums text-muted-foreground">{formatWhen(e.at, now)}</td>
                          <td>
                            <KindTag kind={e.kind} />
                          </td>
                          <td className="truncate pr-2" title={e.modelId}>
                            {e.modelId}
                          </td>
                          <td className="text-right font-medium tabular-nums">{formatUsd(e.usd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {entries.length > COLLAPSED_ROWS ? (
                  <div className="flex items-center justify-between border-t border-border pt-1.5 text-2xs text-muted-foreground">
                    <span className="tabular-nums">
                      {expanded ? `${formatNumber(entries.length)}` : `${COLLAPSED_ROWS}`} of {formatNumber(spend.entryCount ?? entries.length)} entries
                    </span>
                    <Button variant="ghost" size="xs" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
                      {expanded ? 'Show fewer' : 'Show all'}
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          )}

          <ComputeSpendRow state={compute} />
        </>
      )}
    </Panel>
  );
}
