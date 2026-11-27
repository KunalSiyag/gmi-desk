import type { ReactElement, ReactNode } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { cn } from '@renderer/lib/cn';
import { popupMotion } from './motion';
import { OverlayMark } from './overlay';

export interface MenuItemSpec {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

/** Dropdown menu. `items` may include `'separator'` entries. Grows from its trigger; item highlight stays instant. */
export function DropdownMenu({
  trigger,
  items,
  align = 'end',
}: {
  trigger: ReactElement;
  items: Array<MenuItemSpec | 'separator'>;
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner align={align} sideOffset={4} className="z-50">
          <BaseMenu.Popup
            className={cn('min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl outline-none dark:border-input', popupMotion)}
          >
            <OverlayMark />
            {items.map((item, i) =>
              item === 'separator' ? (
                <BaseMenu.Separator key={`sep-${i}`} className="my-1 h-px bg-border" />
              ) : (
                <BaseMenu.Item
                  key={i}
                  disabled={item.disabled}
                  onClick={item.onSelect}
                  className={cn(
                    'flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-[highlighted]:[&_svg]:text-foreground',
                    item.destructive && 'text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive data-[highlighted]:[&_svg]:text-destructive',
                  )}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.shortcut ? <span className="font-mono text-3xs text-muted-foreground">{item.shortcut}</span> : null}
                </BaseMenu.Item>
              ),
            )}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
