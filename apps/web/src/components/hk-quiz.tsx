'use client';

/**
 * The /hk-type island — a third chapter of the Hong Kong story series, interactive this time:
 * ten questions, five archetypes derived from scoring, zero telemetry, zero persistence.
 *
 * The page is a product tour of the eight chapters and of the product's ability to
 * carry a whole HK voice — not a psychological assessment. Every answer option exists for the
 * laugh, not the profile.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@nexus/ui';
import { getDict } from '@/lib/i18n';
import { almanacIndex, hkDateKey } from '@/lib/almanac';

type Archetype = 'yum_cha' | 'siu_mei' | 'cha_chaan_teng' | 'temple_street' | 'cha_chaan';
type Phase = 'idle' | 'playing' | 'result';

export function HkQuiz({ locale }: { locale: string }) {
  const dict = getDict(locale);
  const copy = dict.hkType;
  const [phase, setPhase] = useState<Phase>('idle');
  const [step, setStep] = useState(0);
  const [scores, setScores] = useState<Record<Archetype, number>>({
    yum_cha: 0,
    siu_mei: 0,
    cha_chaan_teng: 0,
    temple_street: 0,
    cha_chaan: 0,
  });
  const [shared, setShared] = useState(false);

  const question = copy.questions[step];
  const total = copy.questions.length;
  const isLast = step + 1 >= total;

  function answer(points: Partial<Record<Archetype, number | undefined>> | undefined) {
    if (!points) return;
    setScores((current) => {
      const next = { ...current };
      for (const [key, delta] of Object.entries(points)) {
        if (delta) next[key as Archetype] = (next[key as Archetype] ?? 0) + delta;
      }
      return next;
    });
    if (isLast) setPhase('result');
    else setStep((current) => current + 1);
  }

  const result = useMemo(() => {
    let best: Archetype = 'cha_chaan_teng';
    let bestScore = -1;
    for (const key of ['yum_cha', 'siu_mei', 'cha_chaan_teng', 'temple_street', 'cha_chaan'] as const) {
      if (scores[key] > bestScore) {
        best = key;
        bestScore = scores[key];
      }
    }
    return copy.results[best];
  }, [scores, copy]);

  async function share() {
    if (typeof window === 'undefined') return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      setShared(false);
    }
  }

  if (phase === 'idle') {
    return (
      <section className="relative mx-auto flex max-w-2xl flex-col items-center gap-6 rounded-2xl border border-line bg-surface px-6 py-12 text-center shadow-md">
        <div className="pointer-events-none absolute inset-0 rounded-2xl nx-ghost-frame" aria-hidden="true" />
        <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
        <h1 className="max-w-[20ch] text-4xl font-semibold leading-[1.1] tracking-tight text-ink-strong sm:text-5xl">
          {copy.title}
        </h1>
        <p className="max-w-prose text-base leading-relaxed text-ink-muted">{copy.intro}</p>
        <p className="text-2xs uppercase tracking-wide text-ink-faint">{copy.seriesLabel}</p>
        <button
          type="button"
          onClick={() => setPhase('playing')}
          className="relative inline-flex items-center gap-2 rounded-full bg-accent px-8 py-3 text-base font-semibold text-accent-ink shadow-md transition-colors hover:bg-accent-hover"
        >
          {copy.start}
          <Icon name="arrowRight" size={16} />
        </button>
      </section>
    );
  }

  if (phase === 'playing') {
    const progress = Math.round(((step + 1) / total) * 100);
    return (
      <section className="relative mx-auto flex max-w-2xl flex-col gap-6 rounded-2xl border border-line bg-surface p-6 shadow-md">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-2xs font-medium uppercase tracking-wide text-ink-faint">
            {copy.progress(step + 1, total)}
          </span>
          <span className="font-mono text-2xs text-ink-faint">{progress}%</span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
        <h2 className="text-balance text-2xl font-semibold leading-snug tracking-tight text-ink-strong sm:text-3xl">
          {question?.text}
        </h2>
        <div role="group" aria-label={copy.questionAria} className="grid gap-3">
          {question?.options.map((option, index) => {
            const letters = ['A', 'B', 'C'];
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => answer(option.scores)}
                className="group flex items-start gap-4 rounded-2xl border border-line bg-surface p-4 text-left transition-colors hover:border-accent hover:bg-accent-soft hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent-line bg-accent-soft font-mono text-base font-bold text-accent transition-colors group-hover:bg-accent group-hover:text-accent-ink">
                  {letters[index]}
                </span>
                <span className="min-w-0 flex-1 text-base leading-snug text-ink-strong">{option.label}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  }

  // The daily pick is a pure function of the HK date — computed straight in the result branch,
  // which only ever renders on the client (phase transitions follow a tap), so there is no
  // server/client mismatch to guard.
  const daily = dict.home.hkDaily;
  const dailyIdx = phase === 'result' ? almanacIndex(hkDateKey(), daily.entries.length) : null;
  const dailyLine: string | null = dailyIdx === null ? null : daily.entries[dailyIdx] ?? null;

  const guideHref = result.guideHref;
  return (
    <section className="relative mx-auto flex max-w-2xl flex-col gap-6 rounded-2xl border border-line bg-surface p-6 shadow-md">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-2xl nx-ghost-frame" />
      <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.resultEyebrow}</span>
      <h2 className="text-3xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-4xl">
        {result.title}
      </h2>
      <p className="max-w-prose text-base leading-relaxed text-ink-muted">{result.blurb}</p>
      {dailyLine ? (
        <p className="flex items-start gap-2 rounded-lg border border-accent-line bg-accent-soft px-3 py-2 text-xs leading-relaxed text-accent">
          <Icon name="ticket" size={12} className="mt-0.5 shrink-0" />
          <span><span className="font-semibold uppercase tracking-wide">{daily.eyebrow}</span>{' · '}{dailyLine}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Link
          href={guideHref}
          className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
        >
          {result.guideTitle}
          <Icon name="arrowRight" size={14} />
        </Link>
        <button
          type="button"
          onClick={share}
          className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent"
        >
          <Icon name={shared ? 'check' : 'share'} size={14} />
          {shared ? copy.shareCopied : copy.copyShare}
        </button>
        <button
          type="button"
          onClick={() => {
            setPhase('idle');
            setStep(0);
            setScores({ yum_cha: 0, siu_mei: 0, cha_chaan_teng: 0, temple_street: 0, cha_chaan: 0 });
          }}
          className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-medium text-ink-muted transition-colors hover:border-accent hover:text-accent"
        >
          {copy.restart}
        </button>
      </div>
      <p className="flex items-start gap-2 text-2xs leading-relaxed text-ink-faint">
        <Icon name="info" size={12} className="mt-0.5 shrink-0" />
        {copy.noTracking}
      </p>
    </section>
  );
}
