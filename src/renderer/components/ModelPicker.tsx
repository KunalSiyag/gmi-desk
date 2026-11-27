import { useMemo, useState } from 'react';
import { Check, ChevronDown, Sparkles, Wand2 } from 'lucide-react';
import type { CatalogModel, ModelKind } from '@shared/contracts/catalog';
import { formatTokens } from '@shared/lib/format';
import { applyDiscount, formatUsd } from '@shared/lib/money';
import { useCatalog } from '@renderer/lib/hooks';
import { cn } from '@renderer/lib/cn';
import { Plates } from './brand/Plates';
import { Badge, DiscountBadge } from './ui/badge';
import { Button } from './ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { Popover } from './ui/popover';

/** Value used for "let GMI Router pick" in chat. */
export const AUTO_MODEL = '__auto__';

/** One-line price summary: "$0.70 / $2.20 per 1M" for LLMs, "$0.07 / second" for media. Discount applied. */
export function modelPriceLabel(model: CatalogModel): string | null {
  if (model.llmPricing && model.llmPricing.inputPerMTok !== null && model.llmPricing.outputPerMTok !== null) {
    const input = applyDiscount(model.llmPricing.inputPerMTok, model.discount);
    const output = applyDiscount(model.llmPricing.outputPerMTok, model.discount);
    return `${formatUsd(input)} / ${formatUsd(output)} per 1M`;
  }
  if (model.mediaPricing && model.mediaPricing.usdPerUnit === 0) return 'Priced after it runs';
  if (model.mediaPricing && model.mediaPricing.usdPerUnit !== null) {
    const charged = applyDiscount(model.mediaPricing.usdPerUnit, model.discount);
    return `${formatUsd(charged)} / ${model.mediaPricing.unit ?? 'unit'}`;
  }
  return null;
}

export interface ModelPickerProps {
  value: string | null;
  onChange: (modelId: string) => void;
  kinds?: ModelKind[];
  /** Adds "Auto · GMI Router" as the first option (value AUTO_MODEL). */
  allowAuto?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom';
}

/** Searchable model selector fed by the live catalog. */
export function ModelPicker({
  value,
  onChange,
  kinds = ['llm'],
  allowAuto = false,
  placeholder = 'Choose a model',
  className,
  disabled,
  align = 'start',
  side = 'bottom',
}: ModelPickerProps) {
  const catalog = useCatalog();
  const [open, setOpen] = useState(false);

  const models = useMemo(
    () => (catalog.data?.models ?? []).filter((m) => kinds.includes(m.kind) && m.available),
    [catalog.data, kinds],
  );
  const selected = models.find((m) => m.id === value) ?? null;

  const groups = useMemo(() => {
    const featured = models.filter((m) => m.featured);
    const fresh = models.filter((m) => m.isNew && !m.featured);
    const byProvider = new Map<string, CatalogModel[]>();
    for (const m of models) {
      const key = m.provider ?? 'Other';
      const list = byProvider.get(key) ?? [];
      list.push(m);
      byProvider.set(key, list);
    }
    const providers = [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return { featured, fresh, providers };
  }, [models]);

  const label =
    value === AUTO_MODEL ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <Wand2 className="text-primary-ink" />
        <span className="truncate">Auto · GMI Router</span>
      </span>
    ) : selected ? (
      <span className="truncate" title={selected.name}>
        {selected.name}
      </span>
    ) : (
      <span className="truncate text-muted-foreground">{catalog.isLoading ? 'Loading models…' : placeholder}</span>
    );

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const renderItem = (m: CatalogModel, group: string) => (
    <CommandItem key={`${group}:${m.id}`} value={`${group} ${m.id} ${m.name} ${m.provider ?? ''}`} onSelect={() => pick(m.id)} className="h-auto min-h-8 py-1.5">
      <Check className={cn('size-3.5 !text-primary-ink', value === m.id ? 'opacity-100' : 'opacity-0')} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn('truncate', value === m.id && 'font-medium')}>{m.name}</span>
          {m.isNew ? <Badge variant="new">New</Badge> : null}
          <DiscountBadge discount={m.discount} />
        </span>
        <span className="truncate font-mono text-3xs text-muted-foreground">
          {m.id}
          {m.contextLength ? ` · ${formatTokens(m.contextLength)} ctx` : ''}
        </span>
      </div>
      <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">{modelPriceLabel(m) ?? ''}</span>
    </CommandItem>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      side={side}
      className="w-[min(34rem,calc(100vw-2rem))] p-0"
      trigger={
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn('max-w-72 justify-between gap-2 font-normal text-foreground', className)}
        >
          {label}
          {/* The kit's one select look (the Select trigger's chevron). */}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      }
    >
      <Command loop>
        <CommandInput placeholder="Search models…" autoFocus />
        <CommandList>
          <CommandEmpty>
            {catalog.isLoading ? (
              <span role="status" className="inline-flex items-center gap-2">
                <Plates size="sm" /> Loading models
              </span>
            ) : (
              'No models match.'
            )}
          </CommandEmpty>
          {allowAuto ? (
            <CommandGroup heading="Router">
              <CommandItem value="auto gmi router" onSelect={() => pick(AUTO_MODEL)} className="h-auto py-1.5">
                <Check className={cn('size-3.5 !text-primary-ink', value === AUTO_MODEL ? 'opacity-100' : 'opacity-0')} />
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-primary-ink/25 bg-primary/10 dark:bg-primary/[0.08]">
                  <Wand2 className="!text-primary-ink" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('text-primary-ink', value === AUTO_MODEL && 'font-medium')}>Auto · GMI Router</span>
                  <span className="truncate text-3xs text-muted-foreground">GMI picks the best model for each message (plain chat)</span>
                </div>
              </CommandItem>
            </CommandGroup>
          ) : null}
          {groups.featured.length ? <CommandGroup heading="Featured">{groups.featured.map((m) => renderItem(m, 'featured'))}</CommandGroup> : null}
          {groups.fresh.length ? (
            <CommandGroup
              heading={
                <span className="flex items-center gap-1">
                  <Sparkles className="size-3" /> New
                </span>
              }
            >
              {groups.fresh.map((m) => renderItem(m, 'new'))}
            </CommandGroup>
          ) : null}
          {groups.providers.map(([provider, list]) => (
            <CommandGroup key={provider} heading={provider}>
              {list.map((m) => renderItem(m, provider))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </Popover>
  );
}
