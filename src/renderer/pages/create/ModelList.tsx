import { useMemo, useRef, type KeyboardEvent } from 'react';
import { ArrowUpRight, Search, Workflow } from 'lucide-react';
import type { CatalogModel } from '@shared/contracts/catalog';
import { gmi } from '@renderer/lib/gmi';
import { useCatalog } from '@renderer/lib/hooks';
import { cn } from '@renderer/lib/cn';
import { ErrorNotice } from '@renderer/components/ErrorNotice';
import { modelPriceLabel } from '@renderer/components/ModelPicker';
import { ActiveBar } from '@renderer/components/ui/active-bar';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { EmptyState, Skeleton } from '@renderer/components/ui/misc';
import { rowPressMotion } from '@renderer/components/ui/motion';
import { TabStrip } from '@renderer/components/ui/tabs';
import { CREATE_TABS, modelsForTab, TAB_LABELS, type CreateTab } from './form';
import { useCreateUi } from './state';

const SEARCH_PLACEHOLDER: Record<CreateTab, string> = {
  image: 'Search image models',
  video: 'Search video models',
  audio: 'Search audio models',
  workflow: 'Search workflows',
};

function ModelRow({ model, selected, onSelect }: { model: CatalogModel; selected: boolean; onSelect: () => void }) {
  const price = modelPriceLabel(model);
  return (
    <button
      type="button"
      data-model-row
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cn(
        // Selection changes from the keyboard (arrow keys), so the selected row has no transition; the others take the
        // kit's row press (background, no scale).
        'relative flex w-full min-w-0 flex-col gap-0.5 rounded-md py-1.5 pl-3 pr-2.5 text-left outline-offset-[-2px]',
        selected ? 'bg-accent text-foreground' : cn('text-foreground/90 hover:bg-accent/60', rowPressMotion),
      )}
    >
      {selected ? <ActiveBar /> : null}
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={cn('truncate text-[13px]', selected && 'font-medium')} title={model.name}>
          {model.name}
        </span>
        {model.isNew ? <Badge variant="new" size="sm">New</Badge> : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-3xs text-muted-foreground">
        <span className="truncate">{model.provider ?? (model.kind === 'workflow' ? 'GMI Studio' : model.id)}</span>
        {price ? <span className={cn('ml-auto shrink-0 tabular-nums', selected && 'text-foreground/80')}>{price}</span> : null}
      </span>
    </button>
  );
}

/** Left pane: modality tabs, search, the live model list, and the GMI Studio link. */
export function ModelList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (model: CatalogModel) => void }) {
  const catalog = useCatalog();
  const tab = useCreateUi((s) => s.tab);
  const setTab = useCreateUi((s) => s.setTab);
  const query = useCreateUi((s) => s.query);
  const setQuery = useCreateUi((s) => s.setQuery);
  const listRef = useRef<HTMLDivElement>(null);

  const all = catalog.data?.models;
  const models = useMemo(() => modelsForTab(all ?? [], tab, query), [all, tab, query]);

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-row]') ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
    rows[index < 0 ? 0 : next]?.focus();
  };

  return (
    <aside aria-label="Models" className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar/40">
      <div className="flex flex-col gap-2 px-3 pt-3">
        <TabStrip
          value={tab}
          onValueChange={(next) => setTab(next)}
          items={CREATE_TABS.map((t) => ({ value: t, label: TAB_LABELS[t] }))}
          className="w-full justify-between [&>*]:flex-auto [&>*]:justify-center [&>*]:px-1.5"
        />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                listRef.current?.querySelector<HTMLButtonElement>('[data-model-row]')?.focus();
              } else if (e.key === 'Escape' && query) {
                e.preventDefault();
                setQuery('');
              }
            }}
            placeholder={SEARCH_PLACEHOLDER[tab]}
            aria-label={SEARCH_PLACEHOLDER[tab]}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <div ref={listRef} onKeyDown={onListKey} className="mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" role="list">
        {catalog.isLoading || (models.length === 0 && !query && catalog.data?.refreshing) ? (
          <div className="flex flex-col gap-1 px-1">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1 px-1.5 py-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            ))}
          </div>
        ) : catalog.error && !all ? (
          <div className="px-1.5 pt-1">
            <ErrorNotice error={catalog.error} onRetry={() => void catalog.refetch()} compact />
          </div>
        ) : models.length === 0 ? (
          <EmptyState
            className="px-3 py-10"
            dino={query ? undefined : 'sleep'}
            title={query ? 'No matches' : `No ${TAB_LABELS[tab].toLowerCase()} models yet`}
            description={query ? 'Try another name or provider.' : 'They appear here as soon as GMI lists them.'}
          />
        ) : (
          models.map((m) => (
            <div key={m.id} role="listitem">
              <ModelRow model={m} selected={m.id === selectedId} onSelect={() => onSelect(m)} />
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border px-3 py-3">
        <Button variant="outline" size="sm" className="w-full" onClick={() => void gmi.app.openConsole('studio').catch(() => undefined)}>
          <Workflow /> Open GMI Studio
          <ArrowUpRight className="ml-auto text-muted-foreground" />
        </Button>
        <p className="text-3xs leading-snug text-muted-foreground">Workflows are built and published in GMI Studio; run them from the Workflows tab.</p>
      </div>
    </aside>
  );
}
