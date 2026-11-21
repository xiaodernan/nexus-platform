'use client';

/**
 * Guided play coach — the "快速上手演示 / 游玩教程" the product promises (§七).
 *
 * The `/try` page lists five real doors; this coach turns that list into a guided session:
 * a reader checks each step off as they actually visit it, sees honest progress, and gets a
 * completion state that hands them into the series. Progress lives in localStorage only —
 * no account, no network, no telemetry. Placeholder-first paint avoids hydration drift.
 *
 * All copy is dict-owned (`dict.home.guidedPlay`); this component holds no prose of its own.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@nexus/ui';

export interface GuidedPlayCopy {
  eyebrow: string;
  title: string;
  intro: string;
  /** D1522: a template, not a function — this payload crosses into a client island. */
  progress: string;
  mark: string;
  marked: string;
  reset: string;
  completeTitle: string;
  completeBody: string;
  nextCta: string;
}

export interface GuidedPlayStep {
  title: string;
  href: string;
}

const STORAGE_KEY = 'nexus.guided-play.v1';

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(done|total)\}/g, (_m, key: string) => String(values[key] ?? ""));

export function GuidedPlayCoach({ copy, steps }: { copy: GuidedPlayCopy; steps: GuidedPlayStep[] }) {
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState<number[]>([]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      setDone(Array.isArray(parsed) ? parsed.filter((n) => Number.isInteger(n)) : []);
    } catch {
      setDone([]);
    }
    setReady(true);
  }, []);

  const write = (next: number[]) => {
    setDone(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode — remember for this session only */
    }
  };

  const toggle = (index: number) => {
    write(done.includes(index) ? done.filter((n) => n !== index) : [...done, index]);
  };

  if (!ready) return <div aria-hidden="true" className="h-40" />;

  const total = steps.length;
  const complete = done.length === total && total > 0;
  const pct = total ? Math.round((done.length / total) * 100) : 0;

  return (
    <section
      aria-label={copy.title}
      className="rounded-2xl border border-accent-line bg-surface p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
        </div>
        <span className="font-mono text-2xs text-accent">{fill(copy.progress, { done: done.length, total })}</span>
      </div>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>

      <div
        className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-canvas"
        role="progressbar"
        aria-valuenow={done.length}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={fill(copy.progress, { done: done.length, total })}
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {steps.map((step, index) => {
          const checked = done.includes(index);
          return (
            <li key={`${step.href}-${index}`} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggle(index)}
                aria-pressed={checked}
                aria-label={`${checked ? copy.marked : copy.mark} · ${step.title}`}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  checked ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-canvas text-ink-faint'
                }`}
              >
                {checked ? <Icon name="check" size={14} aria-hidden="true" /> : <span className="font-mono text-2xs">{index + 1}</span>}
              </button>
              <Link
                href={step.href}
                className={`min-w-0 truncate text-2xs transition-colors hover:text-accent ${
                  checked ? 'text-ink-faint line-through' : 'text-ink-strong'
                }`}
              >
                {step.title}
              </Link>
            </li>
          );
        })}
      </ul>

      {complete ? (
        <div className="mt-5 rounded-xl border border-accent-line bg-accent-soft p-4">
          <p className="text-sm font-semibold text-accent">{copy.completeTitle}</p>
          <p className="mt-1 text-2xs leading-relaxed text-ink-muted">{copy.completeBody}</p>
          <Link
            href="/hong-kong"
            className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-2xs font-semibold text-accent-ink transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {copy.nextCta}
            <Icon name="arrowRight" size={12} aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      {done.length > 0 ? (
        <button
          type="button"
          onClick={() => write([])}
          className="mt-4 text-2xs text-ink-faint underline decoration-dotted underline-offset-4 transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {copy.reset}
        </button>
      ) : null}
    </section>
  );
}
