import type { ReactElement, ReactNode } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { cn } from '@renderer/lib/cn';
import { popupMotion } from './motion';
import { OverlayMark } from './overlay';

export interface PopoverProps {
  /** Element that opens the popover (rendered via Base UI's `render` prop, e.g. a <Button />). */
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
}

/** Anchored popover: grows from its trigger (150 ms), instant when opened from the keyboard. */
export function Popover({ trigger, children, open, onOpenChange, side = 'bottom', align = 'start', sideOffset = 6, className }: PopoverProps) {
  return (
    <BasePopover.Root open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
          <BasePopover.Popup
            className={cn(
              'rounded-lg border border-border bg-popover text-popover-foreground shadow-xl outline-none dark:border-input',
              popupMotion,
              className,
            )}
          >
            <OverlayMark />
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
