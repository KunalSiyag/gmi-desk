import type { ComponentProps, ReactNode } from 'react';
import { Command as Cmdk } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { useOverlayCount } from './overlay';

/**
 * cmdk primitives styled for the app (used by the command palette and the model picker). A mounted `Command` counts
 * as an open overlay (it only ever renders inside the palette dialog or a popover): mount it only in overlays.
 */
export function Command({ className, ...props }: ComponentProps<typeof Cmdk>) {
  useOverlayCount();
  return <Cmdk className={cn('flex h-full w-full flex-col overflow-hidden text-popover-foreground', className)} {...props} />;
}

export function CommandInput({ className, trailing, ...props }: ComponentProps<typeof Cmdk.Input> & { trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <Cmdk.Input
        className={cn('h-10 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground', className)}
        {...props}
      />
      {trailing}
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof Cmdk.List>) {
  return <Cmdk.List className={cn('max-h-[min(24rem,60vh)] overflow-y-auto overflow-x-hidden p-1', className)} {...props} />;
}

export function CommandEmpty(props: ComponentProps<typeof Cmdk.Empty>) {
  return <Cmdk.Empty className="py-10 text-center text-xs text-muted-foreground" {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      className={cn(
        // Group headings are GMI micro-labels (mono, uppercase, wide tracking).
        'overflow-hidden [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-3xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.16em] [&_[cmdk-group-heading]]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof Cmdk.Item>) {
  return (
    <Cmdk.Item
      className={cn(
        // The selected row (keyboard or pointer) gets the accent surface and a brand-ink icon; it changes instantly.
        'flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 text-[13px] text-foreground/90 outline-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-[selected=true]:[&_svg]:text-primary-ink',
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator(props: ComponentProps<typeof Cmdk.Separator>) {
  return <Cmdk.Separator className="my-1 h-px bg-border" {...props} />;
}
