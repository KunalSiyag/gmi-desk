import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { CatalogModel, LeaderboardEntry } from '@shared/contracts/catalog';
import { formatUsd } from '@shared/lib/money';
import { gmi } from '@renderer/lib/gmi';
import { qk } from '@renderer/lib/query';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { Button } from '@renderer/components/ui/button';
import { activeBarBefore } from '@renderer/components/ui/active-bar';
import { EmptyState, microLabel, Skeleton } from '@renderer/components/ui/misc';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { leaderboardBest, sortLeaderboard } from './filter';

/** Short column headings for GMI's category labels (full label in the tooltip / aria-label). */
const SHORT: Record<string, string> = {
  agentic: 'Agent',
  instruction: 'Instr',
  reasoning: 'Reason',
  knowledge: 'Knowl',
  language: 'Lang',
  'data-analysis': 'Data',
};


export function useLeaderboard(enabled = true) {
  return useQuery({ queryKey: qk.leaderboard, queryFn: () => gmi.catalog.getLeaderboard(), staleTime: 10 * 60_000, enabled });
}

/** The best-ranked leaderboard model that is in the catalog (the panel shows it until the user picks one). */
export function topLeaderboardModel(entries: LeaderboardEntry[] | undefined, catalog: Map<string, CatalogModel>): CatalogModel | null {
  for (const e of entries ?? []) {
    const m = catalog.get(e.modelId.toLowerCase());
    if (m) return m;
  }
  return null;
}

export interface LeaderboardViewProps {
  query: string;
  /** Catalog models by lower-case id, to link rows to the detail panel. */
  catalog: Map<string, CatalogModel>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Clears the search box (offered when nothing matches). */
  onClearQuery?: () => void;
}

export function LeaderboardView({ query, catalog, selectedId, onSelect, onClearQuery }: LeaderboardViewProps) {
  const board = useLeaderboard();
  const [sortKey, setSortKey] = useState('overall');

  const columns = useMemo(() => [{ key: 'overall', label: 'Overall' }, ...(board.data?.categories ?? []).filter((c) => c.key !== 'overall')], [board.data]);
  const rows = useMemo(() => sortLeaderboard(board.data?.entries ?? [], sortKey, query), [board.data, sortKey, query]);
  const best = useMemo(() => leaderboardBest(board.data?.entries ?? []), [board.data]);

  if (board.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" aria-busy>
        <div className="h-7 shrink-0 border-b border-border" />
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 pl-5 pr-5">
            <Skeleton className="h-2.5 w-3" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2 w-20" />
            </div>
            <Skeleton className="h-3 w-2/5" />
          </div>
        ))}
      </div>
    );
  }
  if (board.error && !board.data) {
    return (
      <div className="p-5">
        <ErrorNotice error={board.error} onRetry={() => void board.refetch()} />
      </div>
    );
  }
  if (!board.data || board.data.entries.length === 0) {
    return (
      <EmptyState
        dino="sleep"
        title="No leaderboard yet"
        description="GMI has not published benchmark scores. Refresh the catalog to try again."
        className="flex-1 pb-20"
      />
    );
  }

  const costFor = (e: LeaderboardEntry) => e.cost[sortKey] ?? e.cost.overall ?? null;
  // The kit micro-label; narrow score columns use SHORT labels, and Overall (the default sort) gets a wider column.
  const th = cn('h-7 border-b border-border', microLabel);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full min-w-[44rem] table-fixed border-separate border-spacing-0 text-xs">
        <colgroup>
          <col className="w-9" />
          <col />
          {columns.map((c) => (
            <col key={c.key} className={c.key === 'overall' ? 'w-[3.9rem]' : 'w-[3.4rem]'} />
          ))}
          <col className="w-[4.5rem]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            <th scope="col" className={cn(th, 'pl-5 text-left')}>
              #
            </th>
            <th scope="col" className={cn(th, 'px-2 text-left')}>
              Model
            </th>
            {columns.map((c) => {
              const active = c.key === sortKey;
              const short = SHORT[c.key] ?? c.label;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? 'descending' : 'none'}
                  // The sorted column: brand-ink rule under the heading, tinted cells below.
                  className={cn(th, 'px-1 text-right', active && 'bg-muted/50 text-foreground shadow-[inset_0_-2px_0_var(--color-primary-ink)]')}
                >
                  <button
                    type="button"
                    onClick={() => setSortKey(c.key)}
                    aria-label={`Sort by ${c.label}`}
                    title={active ? `Sorted by ${c.label}, highest first` : `Sort by ${c.label}`}
                    className={cn('inline-flex h-5 max-w-full items-center whitespace-nowrap uppercase transition-colors duration-150 ease-out hover:text-foreground', active && 'text-foreground')}
                  >
                    <span className="truncate">{short}</span>
                  </button>
                </th>
              );
            })}
            <th scope="col" className={cn(th, 'pl-1 pr-5 text-right')}>
              <Tooltip label="What GMI's benchmark run cost for the sorted category (USD), as GMI publishes it">
                <span className="cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-[3px]">Cost</span>
              </Tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => {
            const model = catalog.get(e.modelId.toLowerCase()) ?? null;
            const selected = model !== null && model.id === selectedId;
            const td = 'h-10 border-b border-border/60';
            return (
              <tr
                key={e.modelId}
                onClick={model ? () => onSelect(model.id) : undefined}
                aria-selected={model ? selected : undefined}
                // Selected: the app's row selection (accent + the brand-ink bar on the first cell's inner edge), instant.
                // The bar sits 12px in (like the model list), not on the app sidebar's border.
                className={cn(selected ? 'bg-accent' : model ? cn('hover:bg-accent/60', rowPressMotion) : undefined)}
              >
                <td
                  className={cn(
                    td,
                    'relative pl-5 font-mono text-2xs tabular-nums',
                    i === 0 && !query ? 'font-medium text-primary-ink' : 'text-muted-foreground',
                    selected && cn(activeBarBefore, 'before:left-3'),
                  )}
                >
                  {i + 1}
                </td>
                <td className={cn(td, 'px-2')}>
                  {model ? (
                    <button type="button" onClick={() => onSelect(model.id)} className="flex w-full min-w-0 flex-col rounded-sm text-left" title={e.name}>
                      <span className="truncate text-[13px] font-medium leading-[18px] text-foreground">{e.name}</span>
                      <span className="truncate text-3xs leading-[14px] text-muted-foreground">
                        {e.provider ?? '—'}
                        {e.openSource ? ' · open weights' : ''}
                      </span>
                    </button>
                  ) : (
                    <Tooltip label="A benchmark reference: GMI does not serve this model to your account">
                      <span className="flex min-w-0 cursor-default flex-col text-muted-foreground">
                        <span className="truncate text-[13px] leading-[18px]">{e.name}</span>
                        <span className="truncate text-3xs leading-[14px]">{e.provider ?? '—'} · reference, not on GMI</span>
                      </span>
                    </Tooltip>
                  )}
                </td>
                {columns.map((c) => {
                  const v = e.quality[c.key];
                  const top = v !== undefined && best[c.key] === v;
                  const sorted = c.key === sortKey;
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        td,
                        'px-1 text-right tabular-nums',
                        sorted && 'bg-muted/50',
                        top ? 'font-semibold text-primary-ink' : model ? 'text-foreground/85' : 'text-muted-foreground',
                      )}
                    >
                      {v === undefined ? <span className="text-muted-foreground/50">—</span> : v.toFixed(1)}
                    </td>
                  );
                })}
                <td className={cn(td, 'pl-1 pr-5 text-right tabular-nums text-muted-foreground')}>{formatUsd(costFor(e))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <EmptyState
          dino="idle"
          title="No leaderboard models match"
          description={`Nothing on GMI’s leaderboard matches “${query}”.`}
          action={
            onClearQuery ? (
              <Button size="sm" variant="outline" onClick={onClearQuery}>
                <X /> Clear search
              </Button>
            ) : undefined
          }
          className="pt-16"
        />
      ) : null}
    </div>
  );
}
