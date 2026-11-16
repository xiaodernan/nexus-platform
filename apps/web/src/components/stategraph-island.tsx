'use client';

/**
 * The StateGraph rehearsal island — step through the agent spine one node at a time.
 * Pure local state; no fetch, no timers, no storage. Keyboard: → next, ← back, Esc reset.
 */

import { useCallback, useState } from 'react';
import { Icon } from '@nexus/ui';

export interface StateGraphIslandCopy {
  startCta: string;
  nextCta: string;
  resetCta: string;
  stepLabel: string;
  steps: Array<{ title: string; node: string; body: string }>;
  doneLine: string;
}

export function StateGraphIsland({ copy }: { copy: StateGraphIslandCopy }) {
  const [step, setStep] = useState<number | null>(null);
  const total = copy.steps.length;

  const advance = useCallback(() => {
    setStep((current) => (current === null ? 0 : Math.min(current + 1, total - 1)));
  }, [total]);

  const retreat = useCallback(() => {
    setStep((current) => (current === null ? null : Math.max(current - 1, 0)));
  }, []);

  const reset = useCallback(() => setStep(null), []);

  const current = step === null ? null : copy.steps[step] ?? null;
  const started = step !== null;
  const atEnd = step === total - 1;

  const stepText = copy.stepLabel
    .replace('{current}', String((step ?? 0) + 1))
    .replace('{total}', String(total));

  return (
    <section className="rounded-2xl border border-line bg-surface p-5" aria-label={copy.steps[0]?.title ?? 'start'}>
      {!started ? (
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <Icon name="navigation" size={28} className="text-accent" aria-hidden="true" />
          <button
            type="button"
            onClick={advance}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-accent-ink shadow-sm transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            {copy.startCta}
            <Icon name="arrowRight" size={14} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <ol className="grid gap-2 text-left" aria-label="rehearsal steps">
            {copy.steps.map((entry, index) => {
              const done = index < (step ?? 0);
              const active = index === step;
              return (
                <li
                  key={entry.node}
                  className={[
                    'flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors',
                    active ? 'border-accent bg-accent-soft' : done ? 'border-line bg-canvas opacity-80' : 'border-line bg-canvas opacity-55',
                  ].join(' ')}
                >
                  <span
                    aria-hidden="true"
                    className={[
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
                      active ? 'bg-accent text-accent-ink ring-accent' : 'ring-accent-line text-accent',
                    ].join(' ')}
                  >
                    {done ? <Icon name="check" size={11} aria-hidden="true" /> : <span className="text-[10px] font-bold">{index + 1}</span>}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-semibold tracking-tight text-ink-strong">{entry.title}</span>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{entry.node}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="rounded-xl border border-accent-line bg-canvas px-5 py-4">
            <p className="max-w-prose text-sm leading-relaxed text-ink-strong">{current?.body}</p>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-accent">{stepText}</p>
          </div>
          {atEnd ? <p className="text-2xs leading-relaxed text-ink-muted">{copy.doneLine}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={advance}
              className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-xs font-semibold text-accent-ink transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {copy.nextCta}
              <Icon name="arrowRight" size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={retreat}
              className="inline-flex h-10 items-center rounded-full border border-line px-4 text-xs font-medium text-ink-muted transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              ←
            </button>
            <button
              type="button"
              onClick={reset}
              className="inline-flex h-10 items-center rounded-full border border-line px-4 text-xs font-medium text-ink-muted transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {copy.resetCta}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
