'use client';

/**
 * The HK arc timeline — the eleven chapters of the series laid out by clock order
 * (03:10 → 22:45), one tappable checkpoint each. Client island so tapping a checkpoint can
 * chalk the chapter as read — the same persistence the reading-progress strip uses.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { CHAPTER_READ_KEY, markChapter, readChapters, slugFromGuideHref } from '@/lib/chapter-read';

export interface HkArcClockEntry {
  time: string;
  name: string;
  href: string;
}

interface HkArcClockCopy {
  title: string;
  hint: string;
  entries: readonly HkArcClockEntry[];
}

/** Re-exported for continuity with the progress-strip pins. */
export { CHAPTER_READ_KEY };

export function HkArcTimeline({ copy }: { copy: HkArcClockCopy }) {
  const [read, setRead] = useState<readonly string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRead(readChapters());
    setReady(true);
  }, []);

  const mark = (href: string) => {
    try {
      setRead(markChapter(slugFromGuideHref(href)));
    } catch {
      /* noop — private mode */
    }
  };

  const readSet = new Set(read);

  if (copy.entries.length === 0) return null;
  return (
    <section
      aria-labelledby="arc-timeline-title"
      className="overflow-hidden rounded-2xl border border-accent-line bg-surface"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <h2 id="arc-timeline-title" className="text-balance text-lg font-semibold tracking-tight text-ink-strong">
          {copy.title}
        </h2>
        <span className="text-2xs font-medium leading-relaxed text-ink-muted">{copy.hint}</span>
      </div>
      <ol className="grid grid-cols-6 gap-x-1 gap-y-4 px-5 pb-5 pt-3 sm:grid-cols-11 sm:gap-x-2">
        {copy.entries.map((entry) => {
          const slug = slugFromGuideHref(entry.href);
          const isRead = ready && readSet.has(slug);
          return (
            <li key={entry.href} className="flex min-w-0 flex-col items-center gap-1.5 text-center">
              <span className="relative flex h-3.5 w-3.5 items-center justify-center rounded-full ring-1 ring-inset ring-accent-line" style={{ background: 'var(--nexus-ai-gradient)' }} aria-hidden="true" />
              <span className="font-mono text-[10px] leading-none text-ink-faint">{entry.time}</span>
              <a
                href={entry.href}
                onClick={() => mark(entry.href)}
                className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-semibold leading-snug text-ink-strong transition-colors hover:text-accent"
              >
                {isRead ? <Icon name="check" size={10} className="shrink-0 text-accent" /> : null}
                {entry.name}
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
