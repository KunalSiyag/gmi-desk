import type { ComponentProps, ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/cn';
import { backdropMotion, dialogMotion, pressMotion } from './motion';
import { OverlayMark } from './overlay';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Hide the corner close button (e.g. for blocking confirmations). */
  hideClose?: boolean;
  /**
   * What gets focus when the dialog opens (Base UI's `initialFocus`). Default: the first tabbable element, which is
   * the corner close button; pass the dialog's next action instead so Enter continues rather than closes.
   */
  initialFocus?: ComponentProps<typeof BaseDialog.Popup>['initialFocus'];
}

/** Centered modal dialog (Base UI). Fades/scales in from 0.96 (200 ms), out faster (150 ms); stays centred. */
export function Dialog({ open, onOpenChange, title, description, children, footer, className, hideClose, initialFocus }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={cn('fixed inset-0 z-50 bg-black/35 dark:bg-black/70', backdropMotion)} />
        <BaseDialog.Popup
          initialFocus={initialFocus}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none dark:border-input',
            dialogMotion,
            className,
          )}
        >
          <OverlayMark />
          <div className="flex items-start gap-3 px-5 pb-3 pt-[18px]">
            <div className="min-w-0 flex-1">
              <BaseDialog.Title className="text-[15px] font-semibold leading-tight tracking-tight">{title}</BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</BaseDialog.Description>
              ) : null}
            </div>
            {hideClose ? null : (
              <BaseDialog.Close
                aria-label="Close"
                className={cn('-mr-1.5 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground', pressMotion)}
              >
                <X className="size-4" />
              </BaseDialog.Close>
            )}
          </div>
          {children ? <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-1 text-[13px]">{children}</div> : null}
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-5 py-3 dark:bg-white/[0.02]">{footer}</div>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
