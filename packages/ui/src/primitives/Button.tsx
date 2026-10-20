'use client';

import * as React from 'react';
import { cx } from '../utils';
import { Icon } from '../icons/Icon';
import {
  buttonVariants,
  type ButtonShape as Shape,
  type ButtonSize as Size,
  type ButtonVariant as Variant,
} from './button-classes';

/**
 * Button — one control, five intents, three sizes.
 *
 * Design rules (§78/§79):
 *  - `primary` is the only accent-filled element on a screen; use once per view.
 *  - Radius is pill (`rounded-full`) for the discovery flows so buttons read as
 *    "actionable chips" next to the AI input; forms use `shape="md"`.
 *  - Focus ring is token-driven and always visible (WCAG 2.4.7).
 *  - `loading` keeps width stable and sets `aria-busy`, so streamed states never jump.
 *
 * The class recipes and `buttonVariants` live in ./button-classes so a Server Component can style
 * a `next/link`; calling them through this module would hit the client boundary.
 */

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
