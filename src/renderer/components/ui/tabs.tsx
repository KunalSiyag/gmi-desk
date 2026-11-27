import type { ReactNode } from 'react';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { cn } from '@renderer/lib/cn';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

/**
 * Segmented tab strip (controlled). Render the selected panel yourself.
 * The active pill (background, shadow, text) switches instantly: tabs change tens of times a day and from the
 * keyboard (arrow keys), and a sliding Tabs.Indicator would animate width (layout), not just transform.
 * Only the hover text colour of inactive tabs eases.
 */
export function TabStrip<T extends string>({
  value,
  onValueChange,
  items,
  className,
}: {
  value: T;
  onValueChange: (value: T) => void;
  items: Array<TabItem<T>>;
  className?: string;
}) {
  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onValueChange(next as T)}>
      <BaseTabs.List className={cn('inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 ring-1 ring-inset ring-border', className)}>
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className={cn(
              'group/tab inline-flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-[color] duration-150 ease-out hover:text-foreground data-[active]:transition-none',
              'data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-sm dark:data-[active]:bg-white/10',
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="font-mono text-3xs tabular-nums text-muted-foreground group-data-[active]/tab:text-primary-ink">{item.count}</span>
            ) : null}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}
