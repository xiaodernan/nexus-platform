/**
 * D1563 — the ticket-arc rail on a chapter page (§六).
 *
 * A reader who lands on chapter 181 from a search sees a story that clearly continues, but no
 * way to follow it. This rail makes the five-chapter arc visible from any of its chapters: the
 * current position, the two neighbouring doors, and the whole path as five numbered steps.
 * It is a SERVER component — the arc is curated data, the titles come from the corpus in this
 * locale, and there is no client state, no fetch and no model call behind any of it.
 */

import Link from 'next/link';

import type { TicketArcPosition } from '@/lib/ticket-arc';

export interface TicketArcCopy {
  eyebrow: string;
  title: string;
  intro: string;
  progress: string;
  previous: string;
  next: string;
  /** Label for the numbered path; the numbers themselves are Arabic and locale-free. */
  pathLabel: string;
}

interface Props {
  position: TicketArcPosition;
  /** Titles in the CURRENT locale, indexed by the arc's slug order. */
  titles: string[];
  copy: TicketArcCopy;
}

export function TicketArcRail({ position, titles, copy }: Props) {
  const { step, total, slugs, prev, next } = position;
  const progress = copy.progress.replace('{n}', String(step)).replace('{total}', String(total));
  // D1605: the rail was laid out for five steps. Longer curated arcs wrap to a column count that
  // fits the actual path, so seven steps become 4+3 rather than an unbalanced 5+2.
  const columns = total <= 5 ? 'sm:grid-cols-5' : total <= 8 ? 'sm:grid-cols-4' : 'sm:grid-cols-3 lg:grid-cols-4';

  return (
    <section aria-label={copy.title} className="rounded-2xl border border-accent-line bg-surface p-5 sm:p-6">
      <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
      <p className="mt-3 font-mono text-xs text-accent">{progress}</p>

      <ol className={`mt-4 grid gap-2 ${columns}`} aria-label={copy.pathLabel}>
        {slugs.map((slug, index) => {
          const here = index + 1 === step;
          return (
            <li key={slug}>
              <Link
                href={`/guides/${slug}`}
                aria-current={here ? 'step' : undefined}
                className={`block rounded-xl border px-3 py-2 text-2xs leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  here
                    ? 'border-accent bg-accent/10 font-semibold text-accent'
                    : 'border-line bg-canvas text-ink-strong hover:border-accent hover:text-accent'
                }`}
              >
                <span className="mr-1 font-mono">{index + 1}.</span>
                {titles[index] ?? ''}
              </Link>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 flex flex-wrap gap-2">
        {prev ? (
          <Link
            href={`/guides/${prev}`}
            className="rounded-xl border border-line bg-canvas px-3 py-2 text-2xs text-ink-strong transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            ← {copy.previous}
          </Link>
        ) : null}
        {next ? (
          <Link
            href={`/guides/${next}`}
            className="rounded-xl border border-line bg-canvas px-3 py-2 text-2xs text-ink-strong transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {copy.next} →
          </Link>
        ) : null}
      </div>
    </section>
  );
}
