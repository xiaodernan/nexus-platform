'use client';

/**
 * Teaching mode — the per-control help the main surface promises (§5 / §7).
 *
 * The newcomer tour points at FIVE doors once; this strip stays, so a reader who arrives
 * later (or forgot what a control does) can toggle full teaching copy for every primary
 * control without leaving the page. State lives in localStorage — no account, no telemetry —
 * and the first paint is an empty spacer so hydration never disagrees with the server.
 *
 * All copy is dict-owned (`dict.home.teaching`); this component holds no prose of its own.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

export interface TeachingCopy {
  eyebrow: string;
  show: string;
  hide: string;
  intro: string;
  items: Array<{ control: string; hint: string }>;
}

const STORAGE_KEY = 'nexus.teaching.on';

export function TeachingMode({ copy }: { copy: TeachingCopy }) {
  const [ready, setReady] = useState(false);
  const [on, setOn] = useState(false);

  useEffect(() => {
    try {
      setOn(window.localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setOn(false);
    }
    setReady(true);
  }, []);

  const toggle = () => {
    const next = !on;
    setOn(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* private mode — remember for this session only */
    }
  };

  if (!ready) return <div aria-hidden="true" className="h-11" />;

  return (
    <section aria-label={copy.eyebrow} className="border-b border-line bg-surface/60">
      <div className="mx-auto w-full max-w-shell px-4 py-2.5 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">{copy.eyebrow}</span>
          <button
            type="button"
            onClick={toggle}
            aria-pressed={on}
            aria-label={on ? copy.hide : copy.show}
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1.5 text-2xs font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon name="info" size={13} aria-hidden="true" />
            {on ? copy.hide : copy.show}
          </button>
        </div>
        {on ? (
          <div className="mt-3">
            <p className="mb-2 text-2xs leading-relaxed text-ink-muted">{copy.intro}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {copy.items.map((item) => (
                <li
                  key={item.control}
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-2xs leading-relaxed text-ink-muted"
                >
                  <strong className="mr-1 font-semibold text-ink-strong">{item.control}</strong>
                  <span aria-hidden="true"> — </span>
                  {item.hint}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
