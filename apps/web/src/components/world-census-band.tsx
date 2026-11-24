'use client';

/**
 * D1560 — the world's bigness, measured; and a way back in when the visible arc ends.
 * The statistics band is computed from the guides the product actually carries (no static
 * claim), and the re-entry doors are deterministic unvisited chapters from other hours.
 * All copy is dict-owned; no network, no LLM, no telemetry.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Guide } from '@/lib/types';
import { readChapters } from '@/lib/chapter-read';
import { endlessDoors, worldCensus } from '@/lib/world-census';

export interface WorldCensusCopy {
  eyebrow: string;
  title: string;
  intro: string;
  chaptersLabel: string;
  armsLabel: string;
  blocksLabel: string;
  cardsLabel: string;
  hoursLabel: string;
  layersLabel: string;
  doorsTitle: string;
  doorsHint: string;
  doorHint: string;
}

export function WorldCensusBand({ guides, copy, layers }: { guides: Guide[]; copy: WorldCensusCopy; layers: number }) {
  // D1592: the layer count comes from the real world.layers list, never a hardcoded number.
  const census = worldCensus(guides, layers);
  const [doors, setDoors] = useState<Guide[]>([]);

  useEffect(() => {
    setDoors(endlessDoors(guides, new Set(readChapters()), 3));
  }, [guides]);

  const stats: Array<[string, number]> = [
    [copy.chaptersLabel, census.chapters],
    [copy.armsLabel, census.englishArms],
    [copy.blocksLabel, census.bodyBlocks],
    [copy.cardsLabel, census.cardSets],
    [copy.hoursLabel, census.timeBands],
    [copy.layersLabel, census.layers],
  ];

  return (
    <section aria-label={copy.title} className="rounded-2xl border border-accent-line bg-surface p-5 sm:p-6">
      <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-canvas px-3 py-2">
            <dt className="text-2xs text-ink-faint">{label}</dt>
            <dd className="font-mono text-lg font-semibold text-accent">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-ink-strong">{copy.doorsTitle}</h3>
        <p className="mt-1 text-2xs leading-relaxed text-ink-muted">{copy.doorsHint}</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          {doors.map((g) => (
            <li key={g.slug}>
              <Link
                href={`/guides/${g.slug}`}
              title={copy.doorHint}
                className="block rounded-xl border border-line bg-canvas px-3 py-2 text-2xs leading-snug text-ink-strong transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {g.title}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
