import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import type { CatalogModel } from '@shared/contracts/catalog';
import { formatTokens } from '@shared/lib/format';
import { cn } from '@renderer/lib/cn';
import { activeBarBefore } from '@renderer/components/ui/active-bar';
import { Badge, DiscountBadge } from '@renderer/components/ui/badge';
import { microLabel } from '@renderer/components/ui/misc';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { Tooltip } from '@renderer/components/ui/tooltip';
import { kindLabel, type SortKey } from './filter';
import { FeaturedStar, ModalityIcons, ModelIcon, NewBadge, PriceCell } from './parts';

/**
 * icon · model · provider · [context] · price · in→out. Columns appear as the list gets wider (container queries);
 * the context column only exists where LLMs are listed.
 */
const GRID_BASE = 'grid items-center gap-x-3 grid-cols-[1.75rem_minmax(0,1fr)_7.25rem] @xl:grid-cols-[1.75rem_minmax(0,1fr)_7rem_7.25rem]';
const GRID_WITH_CONTEXT = `${GRID_BASE} @2xl:grid-cols-[1.75rem_minmax(0,1fr)_6.5rem_3rem_7.5rem_4rem]`;
const GRID_NO_CONTEXT = `${GRID_BASE} @2xl:grid-cols-[1.75rem_minmax(0,1fr)_7.5rem_7.5rem_4rem]`;

export interface ModelListHandle {
  focus(): void;
  /** Moves the selection by `delta` rows (clamped); used by the search box's arrow keys. */
  move(delta: number): void;
  scrollToSelected(): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Second line: the id when it says more than the name (LLMs), else the description. Workflow UUIDs are noise here. */
function subline(model: CatalogModel): { text: string; mono: boolean } | null {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!UUID.test(model.id) && squash(model.id) !== squash(model.name)) return { text: model.id, mono: true };
  if (model.description) return { text: model.description, mono: false };
  return null;
}

function HeaderCell({
  children,
  sortKey,
  sort,
  onSort,
  align = 'left',
  className,
}: {
  children: ReactNode;
  sortKey?: SortKey;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sortKey !== undefined && sort === sortKey;
  const base = cn('flex min-w-0 items-center', microLabel, align === 'right' && 'justify-end', className);
  if (!sortKey) return <div className={base}>{children}</div>;
  return (
    <div className={base} aria-sort={active ? (sortKey === 'name' || sortKey === 'price' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(active ? 'recommended' : sortKey)}
        className={cn(
          'inline-flex h-5 items-center gap-1 rounded-sm uppercase transition-colors duration-150 ease-out hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
        title={active ? 'Back to recommended order' : 'Sort by this column'}
      >
        {children}
        {active ? <ArrowDown className="size-3 text-primary-ink" aria-hidden /> : null}
      </button>
    </div>
  );
}

export interface ModelListProps {
  rows: CatalogModel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Enter or double-click: the model's primary action (chat / create). */
  onActivate?: (model: CatalogModel) => void;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  /** Show the kind under the provider (the All tab mixes kinds). */
  showKind: boolean;
  /** Show the context-window column (tabs that list LLMs). */
  showContext: boolean;
  /** Rendered instead of rows when there are none. */
  empty?: ReactNode;
}

export const ModelList = forwardRef<ModelListHandle, ModelListProps>(function ModelList(
  { rows, selectedId, onSelect, onActivate, sort, onSort, showKind, showContext, empty },
  ref,
) {
  const GRID = showContext ? GRID_WITH_CONTEXT : GRID_NO_CONTEXT;
  const listRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const selectedIndex = selectedId ? rows.findIndex((m) => m.id === selectedId) : -1;

  const scrollTo = useCallback((id: string | null) => {
    if (!id) return;
    rowEls.current.get(id)?.scrollIntoView({ block: 'nearest' });
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const from = selectedIndex < 0 ? (delta > 0 ? -1 : rows.length) : selectedIndex;
      const next = rows[Math.min(rows.length - 1, Math.max(0, from + delta))];
      if (next) {
        onSelect(next.id);
        // Let React render the new selection before scrolling to it.
        requestAnimationFrame(() => scrollTo(next.id));
      }
    },
    [rows, selectedIndex, onSelect, scrollTo],
  );

  useImperativeHandle(ref, () => ({ focus: () => listRef.current?.focus(), move, scrollToSelected: () => scrollTo(selectedId) }), [move, scrollTo, selectedId]);

  // Keep the selected row in view when the selection is changed from outside (search results, ?model=).
  useEffect(() => {
    scrollTo(selectedId);
  }, [selectedId, scrollTo]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      const current = rows[selectedIndex];
      if (current && onActivate) {
        event.preventDefault();
        onActivate(current);
      }
      return;
    }
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 400) / 44) - 1);
    const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -1e6, End: 1e6 };
    const delta = keys[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    move(delta);
  };

  const activeId = selectedIndex >= 0 ? `model-option-${selectedIndex}` : undefined;

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className={cn(GRID, 'h-7 shrink-0 border-b border-border px-5')}>
        <span aria-hidden />
        <HeaderCell sortKey="name" sort={sort} onSort={onSort}>
          Model
        </HeaderCell>
        <HeaderCell sort={sort} onSort={onSort} className="hidden @xl:flex">
          Provider
        </HeaderCell>
        {showContext ? (
          <HeaderCell sortKey="context" sort={sort} onSort={onSort} align="right" className="hidden @2xl:flex">
            Context
          </HeaderCell>
        ) : null}
        <HeaderCell sortKey="price" sort={sort} onSort={onSort} align="right">
          Price
        </HeaderCell>
        <HeaderCell sort={sort} onSort={onSort} align="right" className="hidden @2xl:flex">
          In → Out
        </HeaderCell>
      </div>
      {rows.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{empty}</div>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Models"
          aria-activedescendant={activeId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
        >
          {rows.map((m, i) => {
            const selected = i === selectedIndex;
            const sub = subline(m);
            return (
              <div
                key={m.id}
                id={`model-option-${i}`}
                role="option"
                aria-selected={selected}
                ref={(el) => {
                  if (el) rowEls.current.set(m.id, el);
                  else rowEls.current.delete(m.id);
                }}
                onMouseDown={(event) => {
                  // Keep keyboard focus on the listbox (not on the row) so arrows keep working.
                  event.preventDefault();
                  listRef.current?.focus({ preventScroll: true });
                }}
                onClick={() => onSelect(m.id)}
                onDoubleClick={onActivate ? () => onActivate(m) : undefined}
                className={cn(
                  GRID,
                  'relative h-11 cursor-default select-none rounded-md px-2 [contain-intrinsic-size:auto_44px] [content-visibility:auto]',
                  // Selected: the app's row selection (accent + the brand-ink bar on the inner edge), instant.
                  // Other rows take the kit's row press (background, no scale).
                  selected ? cn('bg-accent', activeBarBefore) : cn('hover:bg-accent/60', rowPressMotion),
                  !m.available && 'opacity-60',
                )}
              >
                <ModelIcon model={m} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium leading-[18px] text-foreground" title={m.name}>
                      {m.name}
                    </span>
                    {m.featured ? (
                      <Tooltip label="Featured on GMI">
                        <FeaturedStar />
                      </Tooltip>
                    ) : null}
                    {m.isNew ? <NewBadge /> : null}
                    <DiscountBadge discount={m.discount} />
                    {!m.available ? <Badge variant="warning">Unavailable</Badge> : null}
                  </span>
                  {sub ? (
                    <span className={cn('truncate leading-[15px] text-muted-foreground', sub.mono ? 'font-mono text-3xs' : 'text-2xs')} title={sub.text}>
                      {sub.text}
                    </span>
                  ) : null}
                </span>
                <span className="hidden min-w-0 flex-col @xl:flex">
                  <span className="truncate text-xs leading-[18px] text-foreground/90">{m.provider ?? '—'}</span>
                  {showKind || m.quantization ? (
                    <span className="truncate text-3xs leading-[14px] text-muted-foreground">
                      {[showKind ? kindLabel(m.kind) : null, m.quantization?.toUpperCase()].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                </span>
                {showContext ? (
                  <span className="hidden text-right text-xs tabular-nums text-foreground/90 @2xl:block">
                    {m.contextLength ? formatTokens(m.contextLength) : m.kind === 'llm' ? <span className="text-muted-foreground/50">—</span> : null}
                  </span>
                ) : null}
                <PriceCell model={m} />
                <span className="hidden justify-end @2xl:flex">
                  <ModalityIcons inputs={m.inputs} outputs={m.outputs} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
