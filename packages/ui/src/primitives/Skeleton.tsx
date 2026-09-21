import * as React from 'react';
import { cx } from '../utils';

/**
 * Skeleton — shimmer placeholder that stops animating under `prefers-reduced-motion`.
 * Use `SkeletonCard` for EntityCard rails so layout does not shift when results stream in.
 */
export function Skeleton({
  className,
  circle,
  style,
}: React.HTMLAttributes<HTMLSpanElement> & { circle?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'nexus-shimmer relative block overflow-hidden bg-surface-muted',
        circle ? 'rounded-full' : 'rounded-md',
        className,
      )}
      style={style}
    >
      <span className="nexus-shimmer absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/45 to-transparent [animation:nexus-shimmer_1.5s_infinite]" />
    </span>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cx('flex w-[268px] shrink-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4', className)}
    >
      <Skeleton className="h-36 w-full rounded-md" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-20" />
      </div>
    </div>
  );
}

/** Loading dots for inline "AI is working" affordances. */
export function Dots({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1', className)} role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="nexus-pulse inline-block h-1.5 w-1.5 rounded-full bg-current [animation:nexus-pulse-dot_1.1s_ease-in-out_infinite]"
          style={{ animationDelay: `${i * 140}ms` }}
        />
      ))}
    </span>
  );
}
