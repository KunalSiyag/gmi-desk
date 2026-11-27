import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/lib/cn';
import { pressMotion } from './motion';

export const buttonVariants = cva(
  `inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 ${pressMotion}`,
  {
    variants: {
      variant: {
        /** GMI lime with black text: the one primary action in view. */
        default:
          'bg-primary text-primary-foreground shadow-[var(--primary-edge)] hover:bg-primary-hover data-[popup-open]:bg-primary-hover',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary-hover data-[popup-open]:bg-secondary-hover',
        /** Transparent on light, a faint lift on black (`--outline-fill`), so a `bg-*` in `className` wins in both themes. */
        outline:
          'border border-input bg-(--outline-fill) hover:border-foreground/20 hover:bg-accent hover:text-accent-foreground data-[popup-open]:bg-accent',
        ghost:
          'text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground',
        subtle: 'bg-accent text-accent-foreground hover:bg-foreground/10 data-[popup-open]:bg-foreground/10',
        destructive: 'bg-destructive text-white hover:bg-destructive/88',
        link: 'h-auto px-0 text-primary-ink underline-offset-[3px] decoration-primary-ink/40 hover:underline',
      },
      size: {
        xs: 'h-6 gap-1 rounded px-2 text-xs [&_svg]:size-3.5',
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3',
        lg: 'h-9 px-4',
        icon: 'size-8',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
        'icon-xs': 'size-6 rounded [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
