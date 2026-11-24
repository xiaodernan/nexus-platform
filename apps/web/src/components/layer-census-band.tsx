import Link from 'next/link';

import { layerCensus } from '@/lib/layer-census';
import type { Dict } from '@/lib/i18n';

type Chip = Dict['home']['hkHub']['clock'][number];

/**
 * D1600 — a server-fed statistics band: the world's seven layers, each with the REAL number of
 * curated clock chips it holds. No model, no network, no client state beyond the derived numbers.
 */
export interface LayerCensusCopy {
  eyebrow: string;
  title: string;
  hint: string;
  chaptersLabel: string;
  shareLabel: string;
}

export function LayerCensusBand({
  chips,
  layers,
  copy,
}: {
  chips: readonly Chip[];
  layers: Dict['world']['layers'];
  copy: LayerCensusCopy;
}) {
  const { total, rows } = layerCensus(chips, layers);
  return (
    <section aria-label={copy.title} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.hint}</p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => (
          <li key={row.code}>
            <Link
              href={`#world-layer-${row.code}`}
              className="block h-full rounded-xl border border-line bg-canvas px-3 py-2.5 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="font-mono text-2xs uppercase text-accent">{row.code}</span>
              <span className="mt-1 block text-2xs leading-snug text-ink-strong">{row.title}</span>
              <span className="mt-2 block font-mono text-xs text-ink-muted">
                {row.chapters} {copy.chaptersLabel} · {row.share}% {copy.shareLabel}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-mono text-2xs text-ink-faint">{total} · {rows.reduce((n, r) => n + r.chapters, 0)}</p>
    </section>
  );
}
