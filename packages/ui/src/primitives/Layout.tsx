import * as React from 'react';
import { cx } from '../utils';

/** Divider — hairline rule or labelled section break. */
export function Divider({
  orientation = 'horizontal',
  label,
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  label?: string;
  className?: string;
}) {
  if (label && orientation === 'horizontal') {
    return (
      <div className={cx('flex items-center gap-3', className)} role="separator" aria-orientation="horizontal">
        <span className="h-px flex-1 bg-line" />
        <span className="text-2xs uppercase tracking-wide text-ink-faint">{label}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
    );
  }
  return (
    <hr
      className={cx(
        orientation === 'horizontal' ? 'h-px w-full border-0 bg-line' : 'w-px self-stretch border-0 bg-line',
        className,
      )}
      aria-orientation={orientation}
    />
  );
}

/**
 * Container — the single horizontal rhythm of the app (§77 responsive).
 *  - `shell` 72rem for pages, `prose` 46rem for reading, `wide` full-bleed with padding.
 *  - Gutters grow 16 → 24 → 32 so type never touches the edge on desktop.
 */
export function Container({
  size = 'shell',
  className,
  as: Tag = 'div',
  children,
  ...rest
}: React.HTMLAttributes<HTMLElement> & {
  size?: 'shell' | 'prose' | 'wide' | 'narrow';
  as?: 'div' | 'section' | 'main' | 'header' | 'footer' | 'article';
}) {
  return (
    <Tag
      className={cx(
        'mx-auto w-full px-4 sm:px-6 lg:px-8',
        size === 'shell' && 'max-w-shell',
        size === 'prose' && 'max-w-prose',
        size === 'narrow' && 'max-w-[36rem]',
        size === 'wide' && 'max-w-[88rem]',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** Vertical spacing that stays consistent across pages (§78 "禁止页面之间风格不一致"). */
export function Stack({
  gap = 'md',
  className,
  children,
}: {
  gap?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cx(
        'flex flex-col',
        gap === 'xs' && 'gap-2',
        gap === 'sm' && 'gap-3',
        gap === 'md' && 'gap-5',
        gap === 'lg' && 'gap-8 sm:gap-10',
        gap === 'xl' && 'gap-12 sm:gap-16',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Page section with the canonical top/bottom rhythm + optional eyebrow/title/subtitle. */
export function Section({
  title,
  eyebrow,
  description,
  actions,
  id,
  className,
  children,
}: {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  id?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section id={id} className={cx('py-10 sm:py-14', className)}>
      {title || eyebrow || actions ? (
        <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            {eyebrow ? (
              <span className="text-2xs font-semibold uppercase tracking-wide text-accent">{eyebrow}</span>
            ) : null}
            {title ? (
              <h2 className="text-2xl font-semibold tracking-tight text-ink-strong sm:text-3xl">{title}</h2>
            ) : null}
            {description ? <p className="max-w-prose text-sm text-ink-muted sm:text-base">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <React.Fragment key="section-content">{children}</React.Fragment>
    </section>
  );
}
