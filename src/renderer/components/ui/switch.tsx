import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { cn } from '@renderer/lib/cn';

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  className,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <BaseSwitch.Root
      id={id}
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onCheckedChange(next)}
      className={cn(
        // Checked: GMI lime track with a black thumb (black on lime in both themes). Pressed: the kit's 0.97 dip.
        // Base UI renders a <span role="switch"> (no :disabled), so the disabled look keys off data-disabled.
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent bg-input transition-[background-color,scale] duration-150 ease-out active:scale-97 data-[unchecked]:hover:bg-foreground/20 data-[checked]:bg-primary data-[checked]:shadow-[var(--primary-edge)] data-[checked]:hover:bg-primary-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
    >
      <BaseSwitch.Thumb className="block size-3.5 translate-x-[1px] rounded-full bg-white shadow-sm transition-[translate,background-color] duration-150 ease-out data-[checked]:translate-x-[15px] data-[checked]:bg-primary-foreground motion-reduce:transition-none" />
    </BaseSwitch.Root>
  );
}
