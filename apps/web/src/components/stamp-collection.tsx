'use client';

/**
 * D1176 — the Stamp Collection. A chapter-by-chapter read tracker turned into an obvious
 * game: every chapter you finish collecting stamps you into a fan slowly. Local-first, zero
 * network, zero identity. The data-source of truth is the same `nexus.hk-series.read` key the
 * reading-progress strip already writes, so a reader who has been reading the series never
 * wakes up to a blank trophy case — everything they already earned is there.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { readChapters, slugFromGuideHref } from '@/lib/chapter-read';

export interface StampEntry {
  href: string;
  label: string;
  kicker: string;
}

export interface StampCopy {
  eyebrow: string;
  title: string;
  intro: string;
  continueCta: string;
  doneTitle: string;
  doneBody: string;
  collected: string;
  unfinished: string;
  completeKicker: string;
  completeEmber: string;
  completeWax: string;
  completeButton: string;
}

export function StampCollection({ copy, entries, currentDate }: { copy: StampCopy; entries: readonly StampEntry[]; currentDate: string }) {
  const [read, setRead] = useState<readonly string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRead(readChapters());
    setReady(true);
  }, []);

  const readSet = new Set(read);
  const total = entries.length;
  const earned = entries.filter((e) => readSet.has(slugFromGuideHref(e.href))).length;
  const allDone = earned >= total;

  return (
    <section aria-labelledby="stamp-title" className="flex flex-col gap-6 py-8">
      <header className="flex flex-col gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
        <h1 id="stamp-title" className="text-balance text-3xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-4xl">
          {copy.title}
        </h1>
        <p className="max-w-prose text-base leading-relaxed text-ink-muted">{copy.intro}</p>
      </header>

      {ready ? (
        <>
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-line">
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700"
              style={{ width: `${(earned / total) * 100}%`, background: 'var(--nexus-ai-gradient)' }}
            />
          </div>
          <p className="text-sm font-medium text-ink-muted">
            <span className="font-semibold text-accent">{earned}</span>
            <span aria-hidden="true"> / </span>
            <span>{total}</span> · {copy.collected}
          </p>
        </>
      ) : (
        <div aria-hidden="true" className="flex h-1.5 w-full rounded-full bg-line" />
      )}

      <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {entries.map((entry, index) => {
          const slug = slugFromGuideHref(entry.href);
          const collected = ready && readSet.has(slug);
          return (
            <li key={slug}>
              <Link
                href={entry.href}
                className={
                  'group flex h-full flex-col justify-between gap-4 overflow-hidden rounded-2xl border p-4 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 ' +
                  (collected
                    ? 'border-accent-line bg-accent-soft shadow-md ring-2 ring-accent/20 hover:shadow-lg'
                    : 'border-line bg-surface hover:border-accent hover:shadow-md')
                }
                aria-label={collected ? `${entry.label} (${copy.collected})` : entry.label}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{entry.kicker}</span>
                  <span
                    aria-hidden="true"
                    className={
                      'flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ' +
                      (collected ? 'bg-accent text-accent-ink' : 'border border-line text-ink-faint')
                    }
                  >
                    {collected ? <Icon name="check" size={11} /> : <span>{index + 1}</span>}
                  </span>
                </span>
                <span className="text-balance text-sm font-semibold leading-snug text-ink-strong">{entry.label}</span>
                {collected ? (
                  <span className="inline-flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide text-accent">
                    <Icon name="check" size={11} />
                    {copy.collected}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-ink-faint">
                    {copy.unfinished}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      {ready && allDone && (
        <section id="stamp-certificate" aria-labelledby="stamp-done" className="printable-root">
          <section className="flex flex-col items-center gap-5 rounded-3xl border border-accent-line bg-accent-soft p-8 text-center">
            <span className="text-2xs font-semibold uppercase tracking-[0.28em] text-accent">{copy.completeKicker}</span>
            <svg viewBox="0 0 320 320" className="h-56 w-56 sm:h-72 sm:w-72" role="img" aria-label="Sealed full passport">
              <circle cx="160" cy="160" r="150" fill="none" stroke="#b3232a" strokeWidth="10" />
              <circle cx="160" cy="160" r="140" fill="none" stroke="#b3232a" strokeWidth="2" strokeDasharray="5 7" />
              <circle cx="160" cy="160" r="124" fill="#fae8c8" stroke="#b3232a" strokeWidth="6" />
              <text x="160" y="148" textAnchor="middle" fontSize="92" fill="#6b1a1a" fontFamily="serif" fontWeight="700">章</text>
              <text x="160" y="181" textAnchor="middle" fontSize="10.5" fill="#6b1a1a" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" letterSpacing="1">{copy.completeWax}</text>
              <text x="160" y="201" textAnchor="middle" fontSize="9" fill="#6b1a1a" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" opacity="0.72">{currentDate}</text>
            </svg>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.completeEmber}</p>
            <h2 id="stamp-done" className="text-balance text-3xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-4xl">
              {copy.doneTitle}
            </h2>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.doneBody}</p>
            <button
              type="button"
              onClick={() => window.print()}
              className="print-hidden inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              {copy.completeButton}
            </button>
          </section>
        </section>
      )}
    </section>
  );
}
