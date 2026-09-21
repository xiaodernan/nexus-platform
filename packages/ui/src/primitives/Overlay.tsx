'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cx, useModalA11y } from '../utils';
import { Icon } from '../icons/Icon';

/**
 * Dialog — accessible modal (role=dialog, aria-modal, escape, focus trap, scroll lock,
 * focus restore) implemented without a headless dependency.
 *
 * `DialogTrigger`/`DialogClose` let callers wire open/close without owning state;
 * the compound keeps a single source of truth so nested sheets behave correctly.
 */
export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  footer?: React.ReactNode;
  closeLabel?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  children,
  footer,
  closeLabel = 'Close',
}: DialogProps) {
  const panelRef = useModalA11y(open, () => onOpenChange(false));
  const titleId = React.useId();
  const descId = React.useId();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label={closeLabel}
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-surface-overlay backdrop-blur-[2px] animate-[nexus-fade-up_180ms_ease-out]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cx(
          'relative m-0 flex max-h-[92vh] w-full flex-col gap-4 rounded-t-2xl border border-line bg-surface p-5 shadow-xl outline-none',
          'sm:m-4 sm:rounded-2xl sm:p-6',
          'animate-[nexus-fade-up_260ms_var(--nexus-ease-out)]',
          size === 'sm' && 'sm:max-w-sm',
          size === 'md' && 'sm:max-w-lg',
          size === 'lg' && 'sm:max-w-3xl',
        )}
      >
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-xl font-semibold tracking-tight text-ink-strong">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="text-sm leading-relaxed text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={closeLabel}
            className="-mr-1 -mt-1 rounded-full p-2 text-ink-faint transition-colors hover:bg-surface-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">{children}</div>
        {footer ? <footer className="flex flex-wrap justify-end gap-2 pt-1">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Sheet — the same behaviour as Dialog, anchored to a screen edge, for mobile-first
 * panels (comparison tray, filters, marker detail).
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  side = 'right',
  children,
  footer,
  label,
  closeLabel = 'Close panel',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  side?: 'right' | 'bottom';
  children?: React.ReactNode;
  footer?: React.ReactNode;
  label?: string;
  closeLabel?: string;
}) {
  const panelRef = useModalA11y(open, () => onOpenChange(false));
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label={closeLabel}
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-surface-overlay"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
        tabIndex={-1}
        className={cx(
          'absolute flex flex-col gap-4 border-line bg-surface shadow-xl outline-none',
          'animate-[nexus-fade-up_260ms_var(--nexus-ease-out)]',
          side === 'right' && 'inset-y-0 right-0 w-full max-w-[26rem] border-l p-5',
          side === 'bottom' && 'inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t p-5',
        )}
      >
        {title ? (
          <header className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold tracking-tight text-ink-strong">{title}</h2>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={closeLabel}
              className="rounded-full p-2 text-ink-faint hover:bg-surface-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon name="close" size={18} />
            </button>
          </header>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <footer className="flex gap-2 border-t border-line pt-4">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
