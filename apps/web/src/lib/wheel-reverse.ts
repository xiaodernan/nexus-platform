/**
 * D1430 — the in-app wheel-direction override.
 *
 * Why it exists: the OS/driver owns the wheel's sign on every page. A user whose
 * machine scrolls backwards (wheel-up shows lower content, wheel-down shows upper
 * content) reads this product as "the mouse is broken" — and no page-side CSS can
 * change that. The /wheel-check self-test diagnoses it and /handbook teaches the
 * OS-level fix; this module is the product-level one for users who cannot or will
 * not touch the OS setting (locked-down work machines, family PCs, driver rounds
 * where the sign silently flips).
 *
 * The contract:
 *  - Off by default. When off, this module installs nothing — zero listeners,
 *    zero work; the page behaves exactly as the OS promises.
 *  - When on, a capture-phase window interceptor runs BEFORE every other wheel
 *    listener (including the D1184 rail bridge). It re-issues the vertical wheel
 *    as a reversed `scrollBy` on the window and stops the event there — rails do
 *    not double-apply it, the palette does not see it twice.
 *  - Interactive targets keep native wheel behaviour (text fields owe the user
 *    their own wheel semantics). Pinch-zoom (ctrl/meta) and zoom shortcuts pass
 *    through untouched. An already-prevented event is left alone — whoever read it
 *    first handled it.
 *  - Pure helpers are exported for the unit pins; the DOM attach is tiny on
 *    purpose. Storage failures (private mode) degrade to in-memory only.
 */

export const WHEEL_REVERSE_KEY = 'nexus.wheel.reverse';

/** Normalize wheel delta to pixels (deltaMode: 0=pixel, 1=line, 2=page). */
export function wheelReversePixels(event: { deltaY: number; deltaMode: number }): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * 80;
  return event.deltaY;
}

/** True when `target` is inside a control that needs its native wheel. */
export function isInteractiveWheelTarget(target: unknown): boolean {
  if (
    target &&
    typeof target === 'object' &&
    typeof (target as { closest?: unknown }).closest === 'function'
  ) {
    try {
      const el = (target as Element);
      if (el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="slider"]')) {
        return true;
      }
      // The arc-timeline strip owns a deliberate vertical-wheel bridge (D1184): a wheel
      // over it scrolls the strip sideways. The reversed interceptor must leave that
      // feature whole — exempt anything inside the strip.
      if (el.closest('[aria-labelledby="arc-timeline-title"]')) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

/** Pure intercept decision for the capture listener. */
export function wheelReverseShouldIntercept(event: {
  defaultPrevented: boolean;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  target: unknown;
}): boolean {
  if (event.defaultPrevented) return false;
  if (event.ctrlKey || event.metaKey) return false;
  if (event.deltaY === 0) return false;
  return !isInteractiveWheelTarget(event.target);
}

export function readWheelReversePreference(storage: Pick<Storage, 'getItem'> | null): boolean {
  // The stored value is explicit: '1' = reversed, '0' = native (a reader who flipped the
  // toggle back has spoken). No stored value inherits the product default — reversed,
  // because the owner's driver inverts the wheel sign and the §五 contract is that the
  // page follows the reader: wheel-up shows upper content, wheel-down shows lower.
  // (The scroll-direction spec pinned the site's own scroll as native-correct in a clean
  // browser; the inversion lives in the driver, and this default is the product-level
  // counter-act for readers who cannot or will not touch the OS setting.)
  if (!storage) return true;
  try {
    const stored = storage.getItem(WHEEL_REVERSE_KEY);
    if (stored === null) return true;
    return stored === '1';
  } catch {
    return true;
  }
}

export function writeWheelReversePreference(
  storage: Pick<Storage, 'setItem'> | null,
  on: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(WHEEL_REVERSE_KEY, on ? '1' : '0');
  } catch {
    // private-mode storage — the toggle still works for this session
  }
}

/**
 * Attaches the capture interceptor. Returns the cleanup. Only call when the
 * preference is ON — an always-on listener would add capture work for every
 * page even for users who never asked for inversion.
 */
export function attachWheelReverse(win: Window): () => void {
  const onWheel = (event: WheelEvent) => {
    if (
      !wheelReverseShouldIntercept({
        defaultPrevented: event.defaultPrevented,
        deltaY: event.deltaY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        target: event.target,
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    win.scrollBy({ top: -wheelReversePixels(event), behavior: 'auto' });
  };
  win.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    win.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  };
}
