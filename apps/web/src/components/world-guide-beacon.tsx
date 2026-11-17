'use client';

import { useState } from 'react';
import type { MouseEvent } from 'react';
import Link from 'next/link';

export type WorldGuideLabels = {
  eyebrow: string;
  title: string;
  hint: string;
  cta: string;
  pending: string;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ready'; answer: string; suggestions: Array<{ slug: string; title: string }> }
  | { kind: 'gone' };

/**
 * D1306 — the world guide's client beacon: one button, one next step.
 *
 * The chapter stands fine without the model; this card only ADDS a compass. On ANY failure —
 * mock provider, unreachable service, a reply that breaks the fence (URL leak, wrong-language
 * draft, over-long draft) — the beacon removes itself and the page is untouched. The model is
 * handed the two curated doors and nothing else; when it cannot say, the card says nothing.
 *
 * The beacon never pre-fills, never polls, never retries, and stores nothing.
 */
export function WorldGuideBeacon({
  chapterSlug,
  locale,
  surface = 'chapter',
  minutes = 45,
  labels,
}: {
  chapterSlug?: string;
  locale: string;
  surface?: 'home' | 'guides' | 'chapter' | 'insights' | 'handbook';
  minutes?: number;
  labels: WorldGuideLabels;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const ask = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (phase.kind === 'pending') return;
    setPhase({ kind: 'pending' });
    try {
      const res = await fetch('/api/nexus/ai/world-guide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          locale,
          surface,
          chapterSlug: chapterSlug ?? null,
          minutes,
        }),
      });
      const data: unknown = res.ok ? await res.json() : null;
      const answer = (data as { answer?: unknown } | null)?.answer;
      const suggestions = (data as { suggestions?: unknown } | null)?.suggestions;
      // Any non-empty answer counts — including the lane's deterministic live fallback (clearly a
      // compass, never a model invention). Only an EMPTY answer (mock mode, hard failure) hides
      // the beacon; §105's discipline is about never faking model output, not about hiding signposts.
      if (
        data &&
        typeof answer === 'string' &&
        answer.trim().length > 0
      ) {
        setPhase({
          kind: 'ready',
          answer: answer.trim(),
          suggestions: Array.isArray(suggestions)
            ? suggestions
                .filter((s): s is { slug: string; title: string } =>
                  typeof (s as { slug?: unknown })?.slug === 'string'
                  && typeof (s as { title?: unknown })?.title === 'string')
                .slice(0, 2)
            : [],
        });
        return;
      }
      // §105 posture: an empty, inert answer hides the beacon; the chapter stands exactly as-is.
      setPhase({ kind: 'gone' });
    } catch {
      setPhase({ kind: 'gone' });
    }
  };

  if (phase.kind === 'gone') return null;

  return (
    <section
      aria-label={labels.title}
      className="mt-2 flex max-w-3xl flex-col gap-3 rounded-2xl border border-line bg-surface p-5"
    >
      <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{labels.eyebrow}</p>
      <h2 className="text-base font-semibold tracking-tight text-ink-strong">{labels.title}</h2>
      <p className="max-w-prose text-xs leading-relaxed text-ink-muted">{labels.hint}</p>
      <button
        type="button"
        onClick={ask}
        disabled={phase.kind === 'pending'}
        aria-label={labels.cta}
        className="inline-flex w-fit items-center justify-center gap-2 rounded-xl border border-accent-line bg-accent-soft px-5 py-2.5 text-sm font-semibold text-accent transition-colors hover:border-accent hover:bg-accent hover:text-accent-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span aria-hidden="true">🧭</span>
        {phase.kind === 'pending' ? labels.pending : labels.cta}
      </button>
      {phase.kind === 'ready' ? (
        <div className="flex flex-col gap-3 rounded-xl border border-accent-line bg-canvas p-4">
          <p className="max-w-prose text-sm leading-relaxed text-ink-strong">{phase.answer}</p>
          {phase.suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {phase.suggestions.map((s) => (
                <Link
                  key={s.slug}
                  href={`/guides/${s.slug}`}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3.5 py-2 text-xs font-medium text-ink-strong transition-colors hover:border-accent hover:text-accent"
                >
                  {s.title}
                  <span aria-hidden="true">→</span>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
