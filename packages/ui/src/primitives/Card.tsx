import * as React from 'react';
import { cx } from '../utils';

/**
 * Card — the surface layer of the system.
 *  - `interactive` adds hover lift + focus ring (cards that navigate).
 *  - `flat` drops the shadow for dense grids (search results).
 * Radius is `lg` (16px) which is also the EntityCard radius, so rails and grids align.
 */
export function Card({
  variant = 'elevated',
  interactive,
  padding = 'md',
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  variant?: 'elevated' | 'outline' | 'flat';
  interactive?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}) {
  return (
    <div
      className={cx(
        'rounded-lg bg-surface text-ink shadow-xs transition-[box-shadow,transform,border-color] duration-base ease-nexusOut',
        variant === 'elevated' && 'border border-line',
        variant === 'outline' && 'border border-line-strong shadow-none',
        variant === 'flat' && 'border border-transparent shadow-none bg-surface',
        padding === 'sm' && 'p-3',
        padding === 'md' && 'p-4 sm:p-5',
        padding === 'lg' && 'p-5 sm:p-7',
        interactive &&
          'cursor-pointer hover:-translate-y-0.5 hover:shadow-md focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2 focus-within:ring-offset-canvas motion-reduce:hover:translate-y-0',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('flex items-start justify-between gap-3', className)} {...rest} />;
}

export function CardTitle({
  level = 3,
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement> & { level?: 2 | 3 | 4 }) {
  const Tag: 'h2' | 'h3' | 'h4' = level === 2 ? 'h2' : level === 4 ? 'h4' : 'h3';
  return (
    <Tag
      className={cx(
        'text-lg font-semibold tracking-tight text-ink-strong',
        level === 4 && 'text-base',
        className,
      )}
      {...rest}
    />
  );
}

export function CardDescription({ className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx('text-sm leading-relaxed text-ink-muted', className)} {...rest} />;
}

export function CardBody({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('mt-3', className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4', className)}
      {...rest}
    />
  );
}
