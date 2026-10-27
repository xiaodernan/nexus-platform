import * as React from 'react';
import { cx, cva } from '../utils';
import { Icon, type IconName } from '../icons/Icon';

/**
 * Badge — compact status label.
 * Tone discipline: `accent` = actionable/brand, `positive` = open/verified,
 * `warning` = stale/uncertain, `neutral` = metadata (sponsored, demo, category).
 * Badges never carry a price or a rating — those are `PriceTag` / `RatingStars`
 * because they must render fact provenance (AGENT_CONTRACT §4).
 */
const badge = cva(
  'inline-flex items-center gap-1 rounded-full font-medium leading-none whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-chip text-chip-ink',
        accent: 'bg-accent-soft text-accent-soft-ink',
        positive: 'bg-positive-soft text-positive',
        warning: 'bg-warning-soft text-warning',
        danger: 'bg-danger-soft text-danger',
        outline: 'border border-line-strong text-ink-muted',
        solid: 'bg-ink-strong text-ink-inverse',
      },
      size: {
        sm: 'h-5 px-2 text-2xs',
        md: 'h-6 px-2.5 text-xs',
      },
      uppercase: { true: 'uppercase tracking-wide' },
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' | 'outline' | 'solid';
  size?: 'sm' | 'md';
  uppercase?: boolean;
  icon?: IconName;
}

export function Badge({
  tone = 'neutral',
  size = 'md',
  uppercase,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={badge({
        tone,
        size,
        uppercase: uppercase ? true : undefined,
        className,
      })}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 11 : 13} /> : null}
      <React.Fragment key="badge-content">{children}</React.Fragment>
    </span>
  );
}

/** Chip-shaped toggle/pill used for example prompts and refinement turns (§34). */
export function Chip({
  selected,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium',
        'transition-colors duration-quick ease-nexusOut focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        selected
          ? 'border-accent bg-accent-soft text-accent-soft-ink'
          : 'border-line-strong bg-surface text-ink hover:border-accent hover:text-accent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
