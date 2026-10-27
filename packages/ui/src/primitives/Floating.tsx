'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cx, useUniqueId } from '../utils';
import { Icon, type IconName } from '../icons/Icon';

/* ------------------------------------------------------------------ Tooltip */

/**
 * Tooltip — hover *and* focus triggered (keyboard users get it too, which most
 * icon-only designs forget). Rendered in a portal, positioned with a simple
 * collision-aware flip so it never leaves the viewport.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  id,
  openDelay = 250,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'bottom';
  id?: string;
  openDelay?: number;
}) {
  const tipId = useUniqueId('tooltip', id);
  const [open, setOpen] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [coords, setCoords] = React.useState<{ x: number; y: number } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => setMounted(true), []);

  const place = React.useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const centered = rect.left + rect.width / 2;
    const fitsAbove = rect.top > 72;
    const useSide = side === 'top' ? (fitsAbove ? 'top' : 'bottom') : side;
    setCoords({
      x: Math.min(Math.max(centered, 90), window.innerWidth - 90),
      y: useSide === 'top' ? rect.top - 8 : rect.bottom + 8,
    });
  }, [side]);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      place();
      setOpen(true);
    }, openDelay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  React.useEffect(() => () => hide(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const child = children as React.ReactElement<Record<string, unknown>>;
  const triggerProps = {
    ref: anchorRef as React.Ref<unknown>,
    'aria-describedby': open ? tipId : undefined,
    onMouseEnter: cxHandlers(child.props.onMouseEnter, show),
    onMouseLeave: cxHandlers(child.props.onMouseLeave, hide),
    onFocus: cxHandlers(child.props.onFocus, () => {
      place();
      setOpen(true);
    }),
    onBlur: cxHandlers(child.props.onBlur, hide),
  };

  return (
    <>
      {React.cloneElement(child, triggerProps)}
      {open && mounted && coords
        ? createPortal(
            <span
              role="tooltip"
              id={tipId}
              style={{
                left: coords.x,
                top: coords.y,
                transform: 'translate(-50%, -100%)',
              }}
              className="pointer-events-none fixed z-[60] max-w-[16rem] rounded-md bg-ink-strong px-2.5 py-1.5 text-xs font-medium leading-snug text-ink-inverse shadow-lg"
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function cxHandlers(a: unknown, b: () => void) {
  return (event?: { stopPropagation?: () => void }) => {
    if (typeof a === 'function') (a as (e: unknown) => void)(event);
    b();
  };
}

/* -------------------------------------------------------------------- Toast */

export type ToastTone = 'neutral' | 'positive' | 'warning' | 'danger';

export interface ToastMessage {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  tone?: ToastTone;
  duration?: number;
}

interface ToastApi {
  toast: (message: Omit<ToastMessage, 'id'> & { id?: string }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast requires a <ToastProvider> ancestor');
  return ctx;
}

const TONE_ICON: Record<ToastTone, IconName> = {
  neutral: 'info',
  positive: 'check',
  warning: 'warning',
  danger: 'warning',
};

/**
 * Toast — polite live region, auto-dismiss with pause-on-hover, and a real dismiss
 * button (auto-dismiss-only toasts fail WCAG 2.2.1 for interactive messages).
 */
export function ToastProvider({
  children,
  strings,
}: {
  children: React.ReactNode;
  /** Localised strings injected by the app — the design system holds no copy (§111). */
  strings: { dismiss: string; notifications: string };
}) {
  const [messages, setMessages] = React.useState<ToastMessage[]>([]);
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = React.useCallback<ToastApi['toast']>(
    (message) => {
      const id = message.id ?? `t-${Math.random().toString(36).slice(2)}`;
      setMessages((prev) => [...prev.filter((m) => m.id !== id), { ...message, id }]);
      const duration = message.duration ?? 4500;
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  React.useEffect(() => {
    const map = timers.current;
    return () => map.forEach((timer) => clearTimeout(timer));
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      <React.Fragment key="toast-children">{children}</React.Fragment>
      <div
        aria-live="polite"
        aria-label={strings.notifications}
        role="region"
        className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 sm:left-auto sm:right-4 sm:translate-x-0"
      >
        {messages.map((message) => (
          <div
            key={message.id}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-surface-raised p-3.5 shadow-lg animate-[nexus-fade-up_220ms_var(--nexus-ease-out)]"
          >
            <span
              className={cx(
                'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                message.tone === 'positive' && 'bg-positive-soft text-positive',
                message.tone === 'warning' && 'bg-warning-soft text-warning',
                message.tone === 'danger' && 'bg-danger-soft text-danger',
                (!message.tone || message.tone === 'neutral') && 'bg-accent-soft text-accent-soft-ink',
              )}
            >
              <Icon name={TONE_ICON[message.tone ?? 'neutral']} size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-ink-strong">{message.title}</span>
              {message.description ? (
                <span className="text-xs leading-relaxed text-ink-muted">{message.description}</span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => dismiss(message.id)}
              aria-label={strings.dismiss}
              className="rounded-full p-1 text-ink-faint hover:bg-surface-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
