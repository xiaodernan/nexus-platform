'use client';

import { useEffect, useRef } from 'react';

/**
 * The reading-progress hairline (§78 aesthetic pass). A single 2px gradient line pinned to the
 * viewport's top edge that scales horizontally as the reader travels down the document.
 *
 * Discipline lines, in the order they matter:
 *  - **Transform only.** `scaleX` on the element — compositor-only, no layout, no paint thrash.
 *    `will-change: transform` is deliberately absent (two layers never justify the memory).
 *  - **Passive, rAF-free.** The scroll listener is passive and the write happens straight from
 *    the handler: one style write per raw scroll event, no React state, no re-render, no frames.
 *  - **Reduced motion is honoured structurally.** The bar's gradient and fill are static
 *    (nothing animates); `transition` is scoped so a reader with reduced motion gets none.
 *  - **aria-hidden, decorative only.** It carries no information a heading route or progressbar
 *    role would duplicate or gate on; it is the page's weather, not its content.
 *  - **SSR-true zero width.** The server renders `transform: scaleX(0)` inline, so the hydration
 *    render matches byte-for-byte regardless of where the reader lands.
 */
export function ScrollProgress() {
  const barRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof window === 'undefined') return;

    const update = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      bar.style.transform = `scaleX(${progress})`;
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <span
      ref={barRef}
      aria-hidden="true"
      className="nexus-scroll-progress"
      style={{ transform: 'scaleX(0)' }}
    />
  );
}
