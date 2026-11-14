'use client';

/**
 * The first-run strip — a five-chip "you are here" rail for brand-new readers on home.
 *
 * Pedagogic, not persuasive: three real anchors from the hero into the rest of the product,
 * one per click, so a new reader departs knowing SearchBox, the HK series, /hk-type, /me and
 * where the honesty contract lives. Dismissal writes `localStorage['nexus.newcomer-tour.off']`
 * and the strip never reappears — no nag, no modal trap, no telemetry. Placeholder-first paint:
 * first paint is an empty spacer strip; hydration reveals it (visible or not).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@nexus/ui';

export interface NewcomerTourCopy {
  eyebrow: string;
  dismiss: string;
  steps: Array<{ href: string; label: string }>;
}

const STORAGE_KEY = 'nexus.newcomer-tour.off';

export function NewcomerTour({ copy }: { copy: NewcomerTourCopy }) {
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setHidden(false);
    }
    setReady(true);
  }, []);

  if (!ready || hidden) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* private mode — hide for this session only */
    }
    setHidden(true);
  };

  return (
    <section
      aria-label={copy.eyebrow}
      className="relative border-b border-line bg-canvas"
    >
      <div className="mx-auto flex w-full max-w-shell flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-6 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent-line bg-accent-soft"
          >
            <Icon name="navigation" size={16} className="text-accent" />
          </span>
          <span className="text-2xs font-semibold uppercase leading-tight tracking-wide text-accent">{copy.eyebrow}</span>
        </div>
        <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {copy.steps.map((step, index) => (
            <li key={step.href}>
              <Link
                href={step.href}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-2xs font-medium text-ink-muted shadow-xs transition-colors hover:border-accent hover:text-accent"
              >
                <span aria-hidden="true" className="flex h-4 w-4 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold text-accent">
                  {index + 1}
                </span>
                {step.label}
              </Link>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded-full border border-line px-2.5 py-1.5 text-2xs font-medium text-ink-faint transition-colors hover:border-accent hover:text-accent"
        >
          {copy.dismiss}
        </button>
      </div>
    </section>
  );
}
