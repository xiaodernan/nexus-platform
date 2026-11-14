'use client';

/**
 * The HK series reading-progress strip — a local-first flourish for the /hong-kong mega hub.
 *
 * When the reader finishes a chapter, the card gets a checkmark badge and the thin progress bar
 * above the grid fills a little more. Everything lives in `localStorage` (`nexus.hk-series.read`):
 * no writes to the server, no identity, no telemetry, works identical in both data modes.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@nexus/ui';

import { CHAPTER_READ_KEY, markChapter, readChapters } from '@/lib/chapter-read';

export interface HkSeriesProgressCard {
  slug: string;
  label: string;
  kicker: string;
}

export interface HkSeriesProgressCopy {
  /** Template with {read} and {total} slots — functions cannot cross the island boundary. */
  done: string;
  reset: string;
  mark: string;
  readCta: string;
}

const formatDone = (template: string, read: number, total: number): string =>
  template.replaceAll('{read}', String(read)).replaceAll('{total}', String(total));

export const STORAGE_KEY = CHAPTER_READ_KEY;

export function HkSeriesProgress({
  cards,
  copy,
}: {
  cards: readonly HkSeriesProgressCard[];
  copy: HkSeriesProgressCopy;
}) {
  const [read, setRead] = useState<readonly string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRead(readChapters());
    setReady(true);
  }, []);

  const total = cards.length;
  const readSet = new Set(read);
  const readCount = cards.reduce((acc, card) => acc + (readSet.has(card.slug) ? 1 : 0), 0);
  const percent = total === 0 ? 0 : Math.round((readCount / total) * 100);

  const mark = (slug: string) => {
    try {
      setRead(markChapter(slug));
    } catch {
      setRead((current) => (current.includes(slug) ? current : [...current, slug]));
    }
  };

  const reset = () => {
    setRead([]);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* see above */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={readCount}
          aria-label={formatDone(copy.done, readCount, total)}
          className="relative h-1.5 w-40 overflow-hidden rounded-full bg-line sm:w-56"
        >
          <span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{ width: `${percent}%`, background: 'var(--nexus-ai-gradient)' }}
          />
        </span>
        <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
          {formatDone(copy.done, ready ? readCount : 0, total)}
        </span>
        {ready && readCount > 0 ? (
          <button
            type="button"
            onClick={reset}
            className="text-2xs font-medium text-ink-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
          >
            {copy.reset}
          </button>
        ) : null}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const isRead = ready && readSet.has(card.slug);
          return (
            <li key={card.slug}>
              <Link
                href={`/guides/${card.slug}`}
                onClick={() => mark(card.slug)}
                className="group relative flex h-full flex-col justify-between gap-5 overflow-hidden rounded-2xl border border-line bg-surface p-5 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-md"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: 'var(--nexus-ai-gradient)' }}
                />
                {isRead ? (
                  <span className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-ink" role="img" aria-label={copy.mark}>
                    <Icon name="check" size={13} />
                  </span>
                ) : null}
                <span className="relative flex flex-col gap-2">
                  <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{card.kicker}</span>
                  <span className="text-balance text-lg font-semibold leading-snug tracking-tight text-ink-strong">
                    {card.label}
                  </span>
                </span>
                <span className="relative inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-accent">
                  {copy.readCta}
                  <Icon name="arrowRight" size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

