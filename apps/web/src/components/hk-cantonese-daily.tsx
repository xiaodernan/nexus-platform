'use client';

/**
 * 每日一句 · 廣東話 — one Cantonese sentence a day on the /hong-kong mega hub.
 *
 * Same discipline as the home-page almanac: the pick is `almanacIndex` applied to the Hong Kong
 * date, so it is stable per day, dependency-free, and identical for every reader — a regional
 * rhythm, not a personalized feed. No fetch, no telemetry, no state on the wire. The first paint
 * shows the placeholder line; the real sentence swaps in after mount, so SSR can never mismatch.
 *
 * The Jyutping is hand-written Traditional Romanization — every phrase in the pool is a real
 * phrase HK people actually say (no invented "standard" Mandarin-flavoured Cantonese).
 */

import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { almanacIndex, hkDateKey } from '@/lib/almanac';

export interface HkCantoneseEntry {
  phrase: string;
  jyutping: string;
  gloss: string;
}

export interface HkCantoneseDailyCopy {
  eyebrow: string;
  note: string;
  placeholder: string;
  pool: readonly HkCantoneseEntry[];
}

export function HkCantoneseDaily({ copy }: { copy: HkCantoneseDailyCopy }) {
  const [dateKey, setDateKey] = useState<string | null>(null);

  useEffect(() => {
    setDateKey(hkDateKey());
  }, []);

  const idx = dateKey === null ? null : almanacIndex(dateKey, copy.pool.length);
  const entry = idx === null ? null : copy.pool[idx] ?? null;

  return (
    <section
      aria-label={copy.eyebrow}
      className="relative overflow-hidden rounded-2xl border border-line bg-surface p-6"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
        style={{ background: 'var(--nexus-ai-gradient)' }}
      />
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Icon name="globe" size={14} className="text-accent" />
          <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
        </div>
        {entry === null ? (
          <p className="text-sm text-ink-faint">{copy.placeholder}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-balance text-2xl font-semibold leading-snug tracking-tight text-ink-strong">{entry.phrase}</p>
            <p className="font-mono text-xs leading-relaxed text-accent">{entry.jyutping}</p>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{entry.gloss}</p>
          </div>
        )}
        <p className="text-2xs leading-relaxed text-ink-faint">{copy.note}</p>
      </div>
    </section>
  );
}
