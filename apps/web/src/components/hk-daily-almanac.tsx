'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { almanacIndex, hkDateKey } from '@/lib/almanac';

export interface HkDailyAlmanacDict {
  eyebrow: string;
  note: string;
  placeholder: string;
  entries: readonly string[];
}

/**
 * 今日食運 — the home page's deterministic daily card.
 *
 * Purely cosmetic algorithmic flavour: the HK date's FNV-hash picks one of twelve Traditional-HK
 * entries, identical for everyone on the same local day. No fetch, no state beyond React's own,
 * no telemetry — the same day, the same card, for free, forever.
 *
 * The first paint shows the placeholder line (no hydration mismatch possible); the real line
 * swaps in after mount. Everything else about the card is plain markup.
 */
export function HkDailyAlmanac({ daily }: { daily: HkDailyAlmanacDict }) {
  const [dateKey, setDateKey] = useState<string | null>(null);

  useEffect(() => {
    setDateKey(hkDateKey());
  }, []);

  const idx = dateKey === null ? null : almanacIndex(dateKey, daily.entries.length);
  const line = idx === null ? null : daily.entries[idx];

  return (
    <section
      aria-label={daily.eyebrow}
      className="border-b border-line bg-canvas"
    >
      <div className="mx-auto flex w-full max-w-shell flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:gap-8 sm:px-6 lg:px-8">
        <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-accent-line bg-accent-soft">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-2xl"
            style={{ background: 'var(--nexus-ai-gradient)', opacity: 0.14 }}
          />
          <Icon name="ticket" size={22} className="relative text-accent" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{daily.eyebrow}</p>
          <h2 className="text-balance text-lg font-semibold leading-snug tracking-tight text-ink-strong">
            {line ?? daily.placeholder}
          </h2>
          <p className="text-2xs leading-relaxed text-ink-faint">{daily.note}</p>
        </div>
      </div>
    </section>
  );
}
