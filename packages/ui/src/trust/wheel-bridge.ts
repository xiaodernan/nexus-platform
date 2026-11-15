/**
 * D1184 — the wheel bridge for horizontal snap-scroll rails.
 *
 * Why: a desktop wheel has one axis; a rail has the other. The browser natively does
 * nothing for a vertical wheel over an `overflow-x` strip, which reads to a reader as
 * "the wheel is dead, or something has swallowed my page" — the exact complaint that
 * lands as "the mouse feels broken on this site". This bridge maps vertical wheel
 * deltas onto the strip 1:1 — no easing, no inertia, no easing cult — and RELEASES the
 * event back to the page at either end. It never reverses direction: the OS scroll
 * setting (natural scrolling on/off) owns the sign, exactly as everywhere else on the
 * platform.
 *
 * Discipline:
 *  - Fine pointers only — `(hover: hover) and (pointer: fine)` at attach time. Touch
 *    keeps native pan-x; the bridge never interferes with fingers.
 *  - `|deltaX| >= |deltaY|` wins untouched — a trackpad's diagonal or native
 *    horizontal gesture belongs to the browser (and to Shift+wheel).
 *  - At either end of the run, or when there is nothing to bridge, the event is NOT
 *    prevented — the page keeps vertical scroll exactly as the OS promises.
 *  - `passive: false` is required for the one branch that consumes the event; the
 *    listener does no work on the branch that does not.
 *  - No rAF, no timers, no React state — one unsigned style write per real user event.
 */

export type WheelBridgeDecision =
  | { readonly kind: 'rail'; readonly scrollLeft: number }
  | { readonly kind: 'page' };

/**
 * Pure decision — exported for the unit pins. `page` means "do not touch the event".
 * The numbers are the strip's own live values at the moment of the wheel; call sites
 * read `el.scrollLeft`, `el.scrollWidth`, `el.clientWidth` and pass them through.
 */
export function decideWheelBridge(
  metrics: { readonly scrollLeft: number; readonly scrollWidth: number; readonly clientWidth: number },
  deltaX: number,
  deltaY: number,
): WheelBridgeDecision {
  if (deltaX === 0 && deltaY === 0) return { kind: 'page' };
  // A native horizontal gesture (or Shift+wheel, which surfaces as deltaX) wins untouched.
  if (Math.abs(deltaX) >= Math.abs(deltaY)) return { kind: 'page' };
  const max = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  if (max <= 1) return { kind: 'page' }; // nothing to bridge — release to the page
  if (deltaY > 0 && metrics.scrollLeft >= max - 1) return { kind: 'page' }; // far end — release
  if (deltaY < 0 && metrics.scrollLeft <= 1) return { kind: 'page' }; // near end — release
  return { kind: 'rail', scrollLeft: metrics.scrollLeft + deltaY };
}

/**
 * Attaches the bridge to one strip element. Returns a cleanup that removes the listener.
 * The matchMedia check is evaluated at attach time; a live change from touch to fine
 * pointer mid-session is deliberately not handled (rails are re-attached on route change).
 */
export function attachRailWheelBridge(el: HTMLElement): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  if (!finePointer.matches) return () => undefined;
  const onWheel = (event: WheelEvent) => {
    const decision = decideWheelBridge(
      { scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth },
      event.deltaX,
      event.deltaY,
    );
    if (decision.kind !== 'rail') return; // release the event to the page
    event.preventDefault();
    el.scrollLeft = decision.scrollLeft;
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    el.removeEventListener('wheel', onWheel);
  };
}
