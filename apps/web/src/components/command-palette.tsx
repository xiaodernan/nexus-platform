'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Icon } from '@nexus/ui';

import { isCloseShortcut, isOpenPaletteShortcut, isSubmitShortcut, isTypingTarget, paletteSearchPath } from '@/lib/palette';

/**
 * The global command palette (§78 discipline, Cmd/Ctrl+K). Opens from anywhere the app
 * owns a document, Esc closes, Enter hands the query to the ordinary search route —
 * the same surface the search box submits to, never a shadow feature with its own
 * results pane.
 *
 * Discipline lines, in the order they matter:
 *  - **Shortcuts yield to typing lanes.** Cmd/Ctrl+K is the ONLY binding, and it is
 *    honoured only when the keystroke did not originate inside a field (that is the
 *    change a reader expects from a palette: invoked globally, captured locally).
 *  - **One listener, one handler, one store.** No globals, no duplication: a single
 *    effect binds the key; the rest of the state (open/query/returnTo) is React state.
 *  - **Focus in, focus out.** Opening focuses the input; closing restores focus to the
 *    element that had it before (or <body> if none).
 *  - **Scroll lock while open.** body overflow is pinned and restored on every exit path.
 *  - **aria-modal.** The surface is a role=dialog, named by the search label; the scrim
 *    is aria-hidden. Esc closes; scrim click closes.
 *  - **prefers-reduced-motion honoured.** The panel animates with a single transform;
 *    the transition collapses to zero under the user's motion preference.
 *  - **SSR-safe.** The server renders nothing (no island, no dialog, no scrim), so first
 *    paint is untouched; the island mounts before hydration's interaction window opens.
 */
export function CommandPalette({
  locale,
  labels,
}: {
  locale: string;
  labels: { searchLabel: string; placeholder: string };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    const target = returnFocusRef.current;
    if (target && typeof target.focus === 'function') target.focus();
    returnFocusRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = isTypingTarget(event.target);
      if (!open && isOpenPaletteShortcut(event) && !target) {
        event.preventDefault();
        returnFocusRef.current = (event.target as HTMLElement) ?? null;
        setOpen(true);
        return;
      }
      if (open && isCloseShortcut(event)) {
        event.preventDefault();
        close();
        return;
      }
      if (open && isSubmitShortcut(event)) {
        const trimmed = query.trim();
        if (trimmed) {
          event.preventDefault();
          const path = paletteSearchPath(trimmed, locale);
          setOpen(false);
          setQuery('');
          router.push(path);
        }
        return;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, query, locale, close, router]);

  if (!open) return null;

  return (
    <div className="nexus-palette fixed inset-0 z-[70] flex items-start justify-center">
      <div
        aria-hidden="true"
        className="nexus-palette-scrim absolute inset-0"
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={labels.searchLabel}
        className="relative z-10 mt-24 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-xl focus:outline-none motion-safe:animate-[nexus-palette-in_160ms_cubic-bezier(0.16,1,0.3,1)]"
      >
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-[image:var(--nexus-ai-gradient)]" />
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Icon name="search" size={18} className="shrink-0 text-ink-faint" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.placeholder}
            aria-label={labels.searchLabel}
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full bg-transparent text-base text-ink-strong placeholder:text-ink-faint focus:outline-none"
          />
          <kbd className="inline-flex shrink-0 select-none items-center rounded-md border border-line bg-surface-muted px-1.5 py-1 font-mono text-2xs text-ink-faint">esc</kbd>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-2xs text-ink-faint">
          <span className="inline-flex items-center gap-1.5">
            <Icon name="ai" size={12} className="text-accent" />
            <span>{labels.searchLabel}</span>
          </span>
          <span className="inline-flex items-center gap-1"><Icon name="arrowRight" size={11} /><kbd className="font-mono">↵</kbd></span>
        </div>
      </div>
    </div>
  );
}
