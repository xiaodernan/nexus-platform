import { cva } from '../utils';

/**
 * Shared field chrome for Input / Textarea / Select so border, focus ring, sizing and
 * error treatment cannot drift between form components (§78 consistency rule).
 */
export const fieldClasses = cva(
  'w-full bg-surface text-ink-strong placeholder:text-ink-faint border border-line rounded-lg ' +
    'transition-[border-color,box-shadow,background-color] duration-quick ease-nexusOut ' +
    'hover:border-line-strong focus:outline-none focus-visible:border-accent focus-visible:ring-2 ' +
    'focus-visible:ring-accent/35 disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface-muted',
  {
    variants: {
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-3.5 text-[0.9375rem]',
        lg: 'h-14 px-5 text-base',
      },
      invalid: { true: 'border-danger focus-visible:border-danger focus-visible:ring-danger/30' },
    },
  },
);
