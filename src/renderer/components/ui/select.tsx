import { useState, type ReactNode } from 'react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { fieldBase } from './input';
import { popupMotion } from './motion';
import { useOverlayOpenState } from './overlay';

export interface SelectOption<V extends string = string> {
  value: V;
  /** Shown in the list and, for the selected option, in the trigger. */
  label: ReactNode;
  /** Quiet mono text at the item's right edge (a count, a unit). List only: the trigger shows the label. */
  hint?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V;
  onValueChange: (value: V) => void;
  options: ReadonlyArray<SelectOption<V>>;
  /**
   * - `field` (default): the boxed input look (border-input, brand focus ring), full width unless `className` sets one.
   * - `ghost`: no box, for toolbars: muted text that turns foreground on hover/open, with an optional leading `icon`.
   */
  variant?: 'field' | 'ghost';
  /** `md` = h-8, 13px; `sm` = h-7, 12px (default for `ghost`). */
  size?: 'md' | 'sm';
  /** Leading icon in the trigger (a lucide icon; sized 3.5). */
  icon?: ReactNode;
  /** Trigger text when `value` matches no option (default: the raw value). */
  placeholder?: ReactNode;
  /** Goes on the trigger button, so `<label htmlFor>` names and focuses it. */
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  /** Trigger classes (width, text size, invalid ring, ...). */
  className?: string;
  popupClassName?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
}

/** Trigger looks. Both keep the kit's keyboard ring; `data-popup-open` holds the hover look while the list is open. */
export const selectTriggerVariants = {
  field: cn(fieldBase, 'gap-2 pr-2 data-[popup-open]:border-foreground/25'),
  ghost:
    'w-auto shrink-0 gap-1.5 rounded-md px-2 text-muted-foreground transition-[color,background-color] duration-150 ease-out hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[popup-open]:bg-accent data-[popup-open]:text-foreground',
} as const;

/** `Select.Popup`: the kit's popover surface, at least as wide as the trigger. Grows from the trigger (popupMotion). */
export const selectPopupClass =
  'min-w-(--anchor-width) max-w-[min(22rem,var(--available-width))] select-none rounded-lg border border-border bg-popover text-popover-foreground shadow-xl outline-none dark:border-input';

/** `Select.List`: scrolls inside the space the positioner leaves. */
export const selectListClass = 'max-h-[min(20rem,var(--available-height))] scroll-py-1 overflow-y-auto overscroll-contain p-1 outline-none';

/** `Select.Item`: highlight is the accent surface and changes instantly (keyboard navigation); no lime fill. */
export const selectItemClass =
  'flex cursor-default select-none items-center gap-2 rounded-md pl-2 pr-2.5 text-[13px] text-foreground/90 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-foreground data-[selected]:text-foreground data-[disabled]:opacity-50';

/** The selected item's check: brand ink (lime on dark, olive on light). */
export const selectCheckClass = 'size-3.5 text-primary-ink';

export const selectHintClass = 'ml-auto shrink-0 pl-3 font-mono text-3xs tabular-nums text-muted-foreground';

/** A keyboard-opened (or -closed) list skips the transition, like Base UI's `data-instant` on menus and popovers. */
function fromKeyboard(event: Event | undefined): boolean {
  return typeof event?.type === 'string' && event.type.startsWith('key');
}

/**
 * The app's one select (Base UI Select): a themed trigger and a popover list instead of the OS-drawn native menu.
 * Keyboard: arrows, Home/End, type-ahead, Enter/Space, Escape (Base UI). The list opens under the trigger
 * (`side`, flips when there is no room) and is at least as wide as the trigger. Values are strings: map numbers with
 * String()/Number() at the call site.
 */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  variant = 'field',
  size,
  icon,
  placeholder,
  id,
  disabled,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  className,
  popupClassName,
  side = 'bottom',
  align = 'start',
}: SelectProps<V>) {
  const [instant, setInstant] = useState(false);
  // The list stays mounted (hidden) after the first interaction, so it counts as an overlay by open state.
  const overlay = useOverlayOpenState();
  const scale = size ?? (variant === 'ghost' ? 'sm' : 'md');
  const labelOf = (v: V): ReactNode => {
    const match = options.find((o) => o.value === v);
    return match ? match.label : (placeholder ?? v);
  };

  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      onOpenChange={(open, details) => {
        setInstant(fromKeyboard(details.event));
        overlay.onOpen(open);
      }}
      onOpenChangeComplete={overlay.onOpenComplete}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid || undefined}
        className={cn(
          'flex min-w-0 cursor-default select-none items-center text-left outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
          selectTriggerVariants[variant],
          scale === 'md' ? 'h-8 text-[13px]' : 'h-7 text-xs',
          variant === 'field' && (scale === 'md' ? 'pl-2.5' : 'pl-2'),
          className,
        )}
      >
        {icon ? (
          <span aria-hidden className="flex shrink-0 [&>svg]:size-3.5">
            {icon}
          </span>
        ) : null}
        <BaseSelect.Value className="min-w-0 flex-1 truncate">{(v: V) => labelOf(v)}</BaseSelect.Value>
        <BaseSelect.Icon className="flex shrink-0 text-muted-foreground">
          <ChevronDown className="size-3.5" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner side={side} align={align} sideOffset={4} alignItemWithTrigger={false} className="z-50 outline-none">
          <BaseSelect.Popup data-instant={instant ? '' : undefined} className={cn(selectPopupClass, popupMotion, popupClassName)}>
            <BaseSelect.List className={selectListClass}>
              {options.map((o) => (
                <BaseSelect.Item
                  key={o.value}
                  value={o.value}
                  disabled={o.disabled}
                  label={typeof o.label === 'string' ? o.label : undefined}
                  className={cn(selectItemClass, scale === 'md' ? 'h-8' : 'h-7')}
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    <BaseSelect.ItemIndicator className="flex">
                      <Check className={selectCheckClass} />
                    </BaseSelect.ItemIndicator>
                  </span>
                  <BaseSelect.ItemText className="min-w-0 flex-1 truncate">{o.label}</BaseSelect.ItemText>
                  {o.hint !== undefined && o.hint !== null ? <span className={selectHintClass}>{o.hint}</span> : null}
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
