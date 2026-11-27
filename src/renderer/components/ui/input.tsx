import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/cn';

/**
 * Shared field look: 1px input border, brand focus ring (lime on dark, olive on light), invalid state from
 * aria-invalid. Colours ease; the ring itself appears instantly. Also the boxed Select trigger (./select).
 */
export const fieldBase =
  'w-full rounded-md border border-input bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground transition-[color,background-color,border-color] duration-150 ease-out hover:border-foreground/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20 aria-[invalid=true]:border-destructive/70 aria-[invalid=true]:ring-destructive/20 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-input dark:bg-white/[0.02]';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-8 px-2.5', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-16 px-2.5 py-2 leading-relaxed', className)} {...props} />;
});

/* Selects: ./select (Base UI, themed popup). The kit has no native select element: its OS-drawn list ignores the theme. */

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-xs font-medium text-foreground', className)} {...props} />;
}

/** Label + control + optional help text. */
export function Field({
  label,
  help,
  htmlFor,
  className,
  children,
}: {
  label: string;
  help?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {help ? <p className="text-2xs leading-relaxed text-muted-foreground">{help}</p> : null}
    </div>
  );
}
