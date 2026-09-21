'use client';

import * as React from 'react';
import { cx, cva } from '../utils';
import { Icon } from '../icons/Icon';

/**
 * Button — one control, five intents, three sizes.
 *
 * Design rules (§78/§79):
 *  - `primary` is the only accent-filled element on a screen; use once per view.
 *  - Radius is pill (`rounded-full`) for the discovery flows so buttons read as
 *    "actionable chips" next to the AI input; forms use `shape="md"`.
 *  - Focus ring is token-driven and always visible (WCAG 2.4.7).
 *  - `loading` keeps width stable and sets `aria-busy`, so streamed states never jump.
 */
const base =
  'relative inline-flex items-center justify-center gap-2 select-none whitespace-nowrap font-medium ' +
  'transition-[background-color,color,box-shadow,transform,border-color] duration-quick ease-nexusOut ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-45 ' +
  'active:scale-[0.985] motion-reduce:active:scale-100';

const button = cva(base, {
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

type Variant = 'primary' | 'secondary' | 'outline' | 'soft' | 'ghost' | 'danger' | 'quiet';
type Size = 'xs' | 'sm' | 'md' | 'lg' | 'icon';
type Shape = 'pill' | 'md';

/** Class string builder — also exported so `next/link` can be styled as a button. */
export function buttonVariants(opts?: {
  variant?: Variant;
  size?: Size;
  shape?: Shape;
  block?: boolean;
  className?: string;
}) {
  const { variant = 'primary', size = 'md', shape = 'pill', block = false, className } = opts ?? {};
  return button({ variant, size, shape, block, className });
}

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'prefix'> {
  variant?: Variant;
  size?: Size;
  shape?: Shape;
  block?: boolean;
  loading?: boolean;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  shape = 'pill',
  block,
  loading = false,
  leadingIcon,
  trailingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonVariants({ variant, size, shape, block, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Icon name="spinner" spin size={size === 'lg' ? 18 : 16} className="absolute left-1/2 -translate-x-1/2 opacity-90" />
      ) : null}
      <span className={cx('inline-flex items-center gap-2', loading && 'opacity-0')}>
        {leadingIcon}
        {children}
        {trailingIcon}
      </span>
    </button>
  );
}

/** Anchor-flavoured button for real navigation targets that are not router links. */
export function ButtonLink({
  variant = 'primary',
  size = 'md',
  shape = 'pill',
  block,
  className,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: Variant;
  size?: Size;
  shape?: Shape;
  block?: boolean;
}) {
  return (
    <a className={buttonVariants({ variant, size, shape, block, className })} {...rest}>
      <span className="inline-flex items-center gap-2">{children}</span>
    </a>
  );
}

export { base as buttonBaseClasses };
