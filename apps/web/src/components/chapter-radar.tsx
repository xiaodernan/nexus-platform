/**
 * D1530 — the chapter radar: the chapters that stand closest to the one being read.
 *
 * A server component, deliberately: the radar is a pure function of (corpus, current chapter) with
 * no read-state, no identity and no network, so there is nothing to hydrate and nothing to cross the
 * server/client boundary. That is also why its copy is strings — the boundary reader's rule holds
 * whether or not this file ever becomes an island.
 */

import Link from 'next/link';

import { relatedChapters } from '@/lib/reading-thread';
import type { Guide } from '@/lib/types';

export interface ChapterRadarCopy {
  eyebrow: string;
  title: string;
  hint: string;
  because: string;
  shared: string;
  empty: string;
}

export function ChapterRadar({ guides, slug, copy }: {
  guides: readonly Guide[];
  slug: string;
  copy: ChapterRadarCopy;
}) {
  const near = relatedChapters(guides, slug, { steps: 3 });
  if (near.length === 0) return null;

  return (
    <section aria-labelledby="chapter-radar-title" className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
      <header className="flex flex-col gap-1">
        <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
        <h2 id="chapter-radar-title" className="text-balance text-xl font-semibold leading-tight tracking-tight text-ink-strong">
          {copy.title}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.hint}</p>
      </header>
      <ul className="grid gap-2 sm:grid-cols-3">
        {near.map((entry) => (
          <li key={entry.slug}>
            <Link
              href={entry.href}
              data-testid="chapter-radar-step"
              className="group flex h-full flex-col gap-2 rounded-xl border border-accent-line/70 bg-surface p-3 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-accent hover:shadow-md"
            >
              <span className="text-sm font-semibold leading-snug text-ink-strong">{entry.title}</span>
              <span className="text-2xs leading-relaxed text-ink-muted">
                {copy.because}
                {entry.shared.length > 0 ? ` ${copy.shared}${entry.shared.join('、')}` : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {near.length === 0 ? <p className="text-sm text-ink-muted">{copy.empty}</p> : null}
    </section>
  );
}
