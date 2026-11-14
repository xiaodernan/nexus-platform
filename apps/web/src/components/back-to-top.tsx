'use client';

import { useEffect, useRef, useState } from 'react';

import { Icon } from '@nexus/ui';

/**
 * Back-to-top affordance for long pages. Appears only after the reader passes the first viewport
 * (never above it — no flicker on short content), focuses a real `<button>`, scrolls to top under
 * the reduced-motion discipline, and fades itself out once the reader is back at the head.
 *
 * Discipline lines:
 *  - **One listener, one write.** Passive scroll listener only; `requestAnimationFrame` is used to
 *    coalesce bursts without forcing a frame — the DOM event already brought us a paint budget.
 *  - **No hidden states.** Visibility is one boolean: "scrolled past the fold." No timers, no
 *    fade delays, no Easter eggs.
 *  - **aria-hidden while hidden.** Off-screen buttons are not in the accessibility tree.
 *  - **Reduced-motion discipline.** On a reduced-motion reader, `window.scrollTo` is NOT smooth.
 */
export function BackToTop({
  labels,
}: {
  labels: { toTop: string };
}) {
  const [visible, setVisible] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      const doc = document.documentElement;
      const next = (window.scrollY || doc.scrollTop) > window.innerHeight;
      setVisible(next);
      rafRef.current = null;
    };
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const jump = () => {
    const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  if (!visible) return null;

  return (
    <button
      type="button"
      aria-label={labels.toTop}
      title={labels.toTop}
      onClick={jump}
      className="fixed bottom-5 left-5 z-[55] inline-flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface/85 text-ink-muted shadow-md backdrop-blur transition-colors hover:border-accent hover:text-accent focus-visible:shadow-[0_0_0_3px_var(--nexus-accent-ring)]"
    >
      <Icon name="chevronUp" size={18} />
    </button>
  );
}
