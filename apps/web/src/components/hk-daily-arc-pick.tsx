'use client';

/**
 * 今日讀一章 — the /daily page's "one chapter a day" island.
 *
 * Deterministic, client-side, dependency-free: the HK date's cyrb53 hash picks one of the HK series
 * chapters. The same day yields the same suggestion for every reader — a shared city rhythm, not a
 * personalized feed. No fetch, no state, no telemetry; placeholder first paint, the real pick
 * after mount, so SSR can never mismatch.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@nexus/ui';

import { almanacIndex, hkDateKey } from '@/lib/almanac';

export interface HkDailyArcCard {
  slug: string;
  label: string;
  kicker: string;
}

export interface HkDailyArcPickDict {
  eyebrow: string;
  note: string;
  cta: string;
}

export function HkDailyArcPick({ cards, dict }: { cards: readonly HkDailyArcCard[]; dict: HkDailyArcPickDict }) {
  const [dateKey, setDateKey] = useState<string | null>(null);

  useEffect(() => {
    setDateKey(hkDateKey());
  }, []);

  const pick = dateKey === null ? null : cards[almanacIndex(dateKey, cards.length)] ?? null;

  return (
    <section aria-label={dict.eyebrow} className="rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center gap-2">
        <Icon name="ticket" size={14} className="text-accent" />
        <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{dict.eyebrow}</span>
      </div>
      <div className="mt-4">
        {pick === null ? (
          <p className="text-sm text-ink-faint">…</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-balance text-2xl font-semibold leading-snug tracking-tight text-ink-strong">
              {pick.label}
            </p>
            <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-ink-faint">{pick.kicker}</p>
            <p className="text-sm leading-relaxed text-ink-muted">{dict.note}</p>
            <Link
              href={`/guides/${pick.slug}`}
              className="inline-flex w-fit items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
            >
              {dict.cta}
              <Icon name="arrowRight" size={14} />
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
