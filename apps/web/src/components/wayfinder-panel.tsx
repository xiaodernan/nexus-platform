'use client';

/**
 * Wayfinder — the reader-state LLM lane finally given a door (§四).
 *
 * A reader names where they are in the series and a fixed mood (never free text); one
 * explicit click asks the StateGraph to choose ONE real chapter the product already
 * carries, and the code fences every field. No automatic call, no background token spend.
 * All copy is dict-owned; this component holds no prose of its own.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Icon } from '@nexus/ui';

export interface WayfinderCopy {
  eyebrow: string;
  title: string;
  intro: string;
  positionLabel: string;
  moodLabel: string;
  moods: Record<string, string>;
  cta: string;
  pending: string;
  chapterLabel: string;
  whyLabel: string;
  degraded: string;
  hubCta: string;
}

interface Result {
  chapter: number;
  title: string;
  why: string;
  notice: string;
  confidence: string;
  degraded: boolean;
  reason?: string;
}

const MOODS = ['continue', 'revisit', 'late_night', 'warm_food', 'keep_the_promise'] as const;

export function WayfinderPanel({ locale, copy }: { locale: string; copy: WayfinderCopy }) {
  const [position, setPosition] = useState(0);
  const [mood, setMood] = useState<string>('continue');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const ask = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/nexus/ai/wayfinder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale, position, mood }),
      });
      setResult(await res.json() as Result);
    } catch {
      setResult({ chapter: 0, title: '', why: '', notice: '', confidence: 'low', degraded: true, reason: 'ai_unavailable' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={copy.title} className="rounded-2xl border border-accent-line bg-surface p-5 sm:p-6">
      <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-2xs font-medium text-ink-muted">
          {copy.positionLabel}
          <input
            type="number"
            min={0}
            max={1000}
            value={position}
            onChange={(e) => setPosition(Number(e.target.value))}
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-strong outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-2xs font-medium text-ink-muted">
          {copy.moodLabel}
          <select
            value={mood}
            onChange={(e) => setMood(e.target.value)}
            className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-strong outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {MOODS.map((m) => (
              <option key={m} value={m}>{copy.moods[m] ?? m}</option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        onClick={ask}
        disabled={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
      >
        {busy ? copy.pending : copy.cta}
        <Icon name="arrowRight" size={14} aria-hidden="true" />
      </button>

      {result ? (
        <div className="mt-4 rounded-xl border border-line bg-canvas p-4">
          {result.degraded || !result.chapter ? (
            <p className="text-sm text-ink-muted">{copy.degraded}{result.reason ? ` · ${result.reason}` : ''}</p>
          ) : (
            <>
              <p className="text-2xs uppercase tracking-wide text-accent">{copy.chapterLabel} {result.chapter}</p>
              <p className="mt-1 text-sm font-semibold text-ink-strong">{result.title}</p>
              <p className="mt-1 text-2xs leading-relaxed text-ink-muted">{copy.whyLabel} {result.why}</p>
              {result.notice ? <p className="mt-1 text-2xs text-ink-faint">{result.notice}</p> : null}
              <Link
                href="/hong-kong"
                className="mt-3 inline-flex items-center gap-1.5 text-2xs font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {copy.hubCta}
                <Icon name="arrowRight" size={12} aria-hidden="true" />
              </Link>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
