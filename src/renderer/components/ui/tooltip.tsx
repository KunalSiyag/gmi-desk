import type { ReactElement, ReactNode } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { cn } from '@renderer/lib/cn';
import { tooltipMotion } from './motion';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={350} closeDelay={0}>
      {children}
    </BaseTooltip.Provider>
  );
}

/**
 * Wraps `children` (a single element) with a tooltip. Falls back to the plain child when `label` is empty.
 * The first tooltip waits 350 ms and grows from its trigger; while one is open, neighbours open instantly.
 */
export function Tooltip({
  label,
  children,
  side = 'top',
}: {
  label: ReactNode;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  if (label === null || label === undefined || label === '') return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="z-[60]">
          <BaseTooltip.Popup className={cn('max-w-72 rounded-md border border-border bg-popover px-2 py-1 text-2xs leading-snug text-popover-foreground shadow-md dark:border-input', tooltipMotion)}>
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
