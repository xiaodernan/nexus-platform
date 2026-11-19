/**
 * D1430 — the header's wheel-direction control.
 *
 * One button, two states, both honest:
 *  - native: "follow the OS" — this module installs no listener at all.
 *  - reversed: this tab scrolls against the OS sign (for users whose driver is inverted).
 *
 * State lives in localStorage (`nexus.wheel.reverse`) so every page honours it
 * without a flash; the `storage` event keeps multiple open tabs in agreement.
 * All three arms get full interpolated copy from the dictionary — the button is
 * never a bare, unlabelled icon.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Icon, cx } from '@nexus/ui';

import {
  WHEEL_REVERSE_KEY,
  attachWheelReverse,
  readWheelReversePreference,
  writeWheelReversePreference,
} from '@/lib/wheel-reverse';

export interface WheelDirectionLabels {
  /** Button caption when the page follows the OS scroll sign. */
  native: string;
  /** Button caption when the page scrolls against the OS sign. */
  reversed: string;
  /** The accessible name AND the tooltip — full teaching copy, never a bare glyph. */
  hint: string;
}

export function WheelDirectionToggle({ labels }: { labels: WheelDirectionLabels }) {
  const [reversed, setReversed] = useState(false);

  // First paint follows the stored preference; no listener until we know.
  useEffect(() => {
    setReversed(readWheelReversePreference(window.localStorage));
  }, []);

  // The interceptor exists only while the preference is on.
  useEffect(() => {
    if (!reversed) return undefined;
    return attachWheelReverse(window);
  }, [reversed]);

  // Another tab flipped the toggle — follow along.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== WHEEL_REVERSE_KEY) return;
      setReversed(event.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggle = useCallback(() => {
    setReversed((previous) => {
      const next = !previous;
      writeWheelReversePreference(window.localStorage, next);
      return next;
    });
  }, []);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={reversed}
      title={labels.hint}
      aria-label={labels.hint}
      data-state={reversed ? 'reversed' : 'native'}
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-full border px-2 transition-colors',
        reversed
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line text-ink-muted hover:border-accent hover:text-accent',
      )}
    >
      <span className="flex flex-col items-center leading-none" aria-hidden="true">
        <Icon name="chevronUp" size={11} className="-mb-[2px]" />
        <Icon name="chevronDown" size={11} />
      </span>
      <span className="hidden text-2xs font-medium sm:inline">
        {reversed ? labels.reversed : labels.native}
      </span>
    </button>
  );
}
