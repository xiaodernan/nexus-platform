import { cva } from '../utils';

/**
 * Button chrome, in a module with no `'use client'` on purpose (same shape as ./field-classes).
 *
 * `Button.tsx` is a client module, so anything it exports arrives on the server as a client
 * reference that throws when called. `buttonVariants` has to be callable from a Server Component —
 * a `next/link` styled as a button is the normal case, and dropping to a plain `<a>` there would
 * cost prefetch and client navigation.
 */
export const buttonBaseClasses =
  'relative inline-flex items-center justify-center gap-2 select-none whitespace-nowrap font-medium ' +
  'transition-[background-color,color,box-shadow,transform,border-color] duration-quick ease-nexusOut ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-45 ' +
  'active:scale-[0.985] motion-reduce:active:scale-100';

const button = cva(buttonBaseClasses, {
  variants: {
    variant: {
      primary:
        'bg-accent text-accent-ink shadow-sm hover:bg-accent-hover hover:shadow-md active:bg-accent-active',
      secondary:
        'bg-ink-strong text-ink-inverse shadow-sm hover:bg-ink-strong/90 active:bg-ink-strong/80',
      outline:
        'border border-line-strong bg-surface text-ink-strong shadow-xs hover:border-accent hover:text-accent active:bg-surface-muted',
      soft: 'bg-accent-soft text-accent-soft-ink hover:bg-accent-line/70 active:bg-accent-line',
      ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink-strong active:bg-surface-sunken',
      danger: 'bg-danger text-white shadow-sm hover:opacity-92 active:opacity-85',
      quiet: 'border border-line bg-transparent text-ink hover:bg-surface-muted',
    },
    size: {
      xs: 'h-7 px-2.5 text-xs rounded-full',
      sm: 'h-9 px-3.5 text-sm',
      md: 'h-11 px-5 text-[0.9375rem]',
      lg: 'h-[3.25rem] px-7 text-base',
      icon: 'h-10 w-10 px-0',
    },
    shape: {
      pill: 'rounded-full',
      md: 'rounded-lg',
    },
    block: {
      true: 'w-full',
      false: '',
    },
  },
});

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'soft' | 'ghost' | 'danger' | 'quiet';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon';
export type ButtonShape = 'pill' | 'md';

/** Class string builder — also exported so `next/link` can be styled as a button. */
export function buttonVariants(opts?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  block?: boolean;
  className?: string;
}) {
  const { variant = 'primary', size = 'md', shape = 'pill', block = false, className } = opts ?? {};
  return button({ variant, size, shape, block, className });
}
