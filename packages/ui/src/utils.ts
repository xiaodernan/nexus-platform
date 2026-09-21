import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as React from 'react';

/** Tailwind-aware className join. Later values win, so consumers can override variants. */
export function cx(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Minimal class-variance-authority: `cva(base, { variants, compoundVariants })`
 * returns a function taking the variant map (plus `className`/`cx` escape hatch).
 * Hand-rolled so the design system has no runtime dependency beyond clsx/merge.
 */
export type CvaProps<V extends Record<string, Record<string, string>>> = {
  /** A variant key, or a boolean for the conventional `true` / `false` keys. */
  [K in keyof V]?: keyof V[K] | boolean | null | undefined;
} & { className?: string | undefined };

export function cva<V extends Record<string, Record<string, string>>>(
  base: string,
  config?: { variants?: V; compoundVariants?: Array<Partial<CvaProps<V>> & { className: string }> },
) {
  const variants = config?.variants ?? ({} as V);
  const compounds = config?.compoundVariants ?? [];
  return (props?: CvaProps<V>) => {
    const selected: string[] = [base];
    if (props) {
      for (const key of Object.keys(variants) as Array<keyof V>) {
        const raw = props[key];
        const value = typeof raw === 'boolean' ? String(raw) : raw;
        if (typeof value === 'string' || typeof value === 'number') {
          const classes = variants[key]?.[value as string];
          if (classes) selected.push(classes);
        }
      }
      for (const rule of compounds) {
        const matched = Object.keys(rule).every(
          (key) => key !== 'className' && (rule as Record<string, unknown>)[key] === (props as Record<string, unknown>)[key],
        );
        if (matched && Object.keys(rule).length > 1) selected.push(rule.className);
      }
    }
    return cx(...selected, props?.className);
  };
}

/** Merge a forwarded ref (object or callback) — React 19 keeps refs as props but we stay compatible. */
export function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

/** Roving focus helper shared by Tabs / Select / toolbar-style components. */
export function useRovingFocus<T extends HTMLElement>(containerRef: React.RefObject<T | null>) {
  const [activeIndex, setActiveIndex] = React.useState(0);

  const items = React.useCallback(
    () =>
      Array.from(
        containerRef.current?.querySelectorAll<T>(
          '[data-roving-item]:not([data-disabled="true"])',
        ) ?? [],
      ),
    [containerRef],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      const list = items();
      if (list.length === 0) return;
      const current = list.findIndex((el) => el === document.activeElement);
      let next = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (Math.max(current, 0) + 1) % list.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
        next = (Math.max(current, 0) - 1 + list.length) % list.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = list.length - 1;
      if (next >= 0) {
        event.preventDefault();
        list[next]?.focus();
        setActiveIndex(next);
      }
    },
    [items],
  );

  return { activeIndex, setActiveIndex, onKeyDown, items };
}

/** Invoke all handler props in order (used to keep consumer onInterrupt/onClick working). */
export function callAll<Args extends unknown[]>(...fns: Array<((...args: Args) => void) | undefined>) {
  return (...args: Args) => {
    for (const fn of fns) fn?.(...args);
  };
}

/** Escape key subscription used by Dialog / Sheet / Select / Tooltip. */
export function useEscapeKey(active: boolean, onEscape: () => void) {
  React.useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, onEscape]);
}

/**
 * Focus trap + scroll lock + focus restore for modal surfaces (Dialog, Sheet).
 * Returns the container ref to attach to the panel.
 */
export function useModalA11y(open: boolean, onEscape: () => void) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreRef = React.useRef<HTMLElement | null>(null);

  useEscapeKey(open, onEscape);

  React.useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = panel ? queryFocusable(panel) : [];
    (focusables[0] ?? panel)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !panel) return;
      const list = queryFocusable(panel);
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  return panelRef;
}

export const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function queryFocusable(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/** Stable id that is SSR-safe (no hydration mismatch thanks to useId). */
export function useUniqueId(prefix: string, override?: string) {
  const id = React.useId();
  return override ?? `${prefix}${id.replace(/[^a-zA-Z0-9:-]/g, '')}`;
}
