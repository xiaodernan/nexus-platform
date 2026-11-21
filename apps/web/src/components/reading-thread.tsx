'use client';

/**
 * D1517 — the reading thread island (§六): which door to open next, and why.
 *
 * The corpus is 177 chapters and an index is a list, not a path. This island reads the read-set from
 * the same `nexus.hk-series.read` key the stamp collection and the progress strip write
 * (`chapter-read.ts`), hands it to the pure thread engine (`reading-thread.ts`) and prints three
 * doors with the reason each was offered. Local-first, zero network, zero identity — a reader who
 * clears storage restarts the world, which is honest behaviour for a client-side read state.
 *
 * It renders nothing until the read-set is known: server and first paint agree on the empty state,
 * so the island never flashes a ranking the reader did not earn.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { readChapters } from '@/lib/chapter-read';
import { readingThread, threadProgress } from '@/lib/reading-thread';
import type { Guide } from '@/lib/types';

export interface ReadingThreadCopy {
  eyebrow: string;
  title: string;
  intro: string;
  /** (read, total) */
  progress: string;
  percent: string;
  emptyTitle: string;
  emptyBody: string;
  doneTitle: string;
  doneBody: string;
  because: string;
  shared: string;
  via: string;
  open: string;
}

const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(read|total|percent|title)\}/g, (_m, key: string) => String(values[key] ?? ""));

export function ReadingThread({ guides, copy }: { guides: readonly Guide[]; copy: ReadingThreadCopy }) {
  const [read, setRead] = useState<readonly string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRead(readChapters());
    setReady(true);
  }, []);

  const titles = new Map(guides.map((guide) => [guide.slug, guide.title]));
  const progress = threadProgress(guides, read);
  const thread = ready ? readingThread(guides, read, { steps: 3 }) : [];

  return (
    <section aria-labelledby="reading-thread-title" className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
      <header className="flex flex-col gap-2">
        <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{copy.eyebrow}</span>
        <h2 id="reading-thread-title" className="text-balance text-xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-2xl">
          {copy.title}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{copy.intro}</p>
        <p className="text-xs text-ink-faint" data-testid="reading-thread-progress">
          {fill(copy.progress, { read: progress.read, total: progress.total })} ·{" "}
          {fill(copy.percent, { percent: progress.percent })}
        </p>
      </header>

      {!ready ? null : thread.length === 0 ? (
        <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface-2 p-4" data-testid="reading-thread-empty">
          <p className="text-sm font-semibold text-ink-strong">
            {progress.read === 0 ? copy.emptyTitle : copy.doneTitle}
          </p>
          <p className="text-sm leading-relaxed text-ink-muted">
            {progress.read === 0 ? copy.emptyBody : copy.doneBody}
          </p>
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-3">
          {thread.map((step) => (
            <li key={step.slug}>
              <Link
                href={step.href}
                data-testid="reading-thread-step"
                className="group flex h-full flex-col gap-2 rounded-xl border border-accent-line/70 bg-surface p-3 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-accent hover:shadow-md"
              >
                <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent">
                  <Icon name="navigation" size={14} />
                </span>
                <span className="text-sm font-semibold leading-snug text-ink-strong">{step.title}</span>
                <span className="text-2xs leading-relaxed text-ink-muted">
                  {copy.because}
                  {step.via ? fill(copy.via, { title: titles.get(step.via) ?? step.via }) : null}
                  {step.shared.length > 0 ? ` · ${copy.shared}${step.shared.join('、')}` : null}
                </span>
                <span className="mt-auto text-2xs font-semibold uppercase tracking-wide text-accent">{copy.open}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
