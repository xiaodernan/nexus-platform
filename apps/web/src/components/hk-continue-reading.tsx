'use client';

/**
 * D1169 — the "pick up where you left off" CTA.
 *
 * One line of context: the reader scrolled this world before and walked away. The hub must
 * not make them remember which chapter they were on; it remembers, because the chapters do.
 * Everything here is local-first via `chapter-read.ts` — zero network, zero identity.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@nexus/ui';

import { readChapters, slugFromGuideHref } from '@/lib/chapter-read';

export interface HkContinueCopy {
  startTitle: string;
  continueTitle: string;
  doneTitle: string;
  startCta: string;
  continueCta: string;
  doneCta: string;
  newHere: string;
  allRead: string;
  /** Token-substituted client-side: contains `{n}`. */
  toGo: string;
}

const fill = (template: string, n: number): string => template.replaceAll('{n}', String(n));

interface HkContinueEntry {
  href: string;
  name: string;
}

export function HkContinueReading({
  copy,
  entries,
}: {
  copy: HkContinueCopy;
  entries: readonly HkContinueEntry[];
}) {
  const [read, setRead] = useState<readonly string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setRead(readChapters());
    setReady(true);
  }, []);

  if (!ready) {
    // render nothing on the server and nothing on the first client frame — no flash of wrong state
    return <div aria-hidden="true" className="h-14 w-full rounded-2xl border border-line bg-surface" />;
  }

  const readSet = new Set(read);
  const total = entries.length;
  const done = entries.filter((entry) => readSet.has(slugFromGuideHref(entry.href))).length;
  const next = entries.find((entry) => !readSet.has(slugFromGuideHref(entry.href)));

  const state: 'start' | 'continue' | 'done' = done === 0 ? 'start' : done >= total ? 'done' : 'continue';
  const target = next ?? entries[0];
  const title = state === 'start' ? copy.startTitle : state === 'done' ? copy.doneTitle : copy.continueTitle;
  const cta = state === 'start' ? copy.startCta : state === 'done' ? copy.doneCta : copy.continueCta;
  const remainder = total - done;

  return (
    <Link
      href={target?.href ?? '/hong-kong'}
      className="group flex flex-col gap-2 overflow-hidden rounded-2xl border border-accent-line bg-accent-soft p-4 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <span className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink" aria-hidden="true">
          <Icon name="bookmark" size={16} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            {state === 'start' ? copy.newHere : state === 'done' ? copy.allRead : fill(copy.toGo, remainder)}
          </span>
          <span className="text-balance text-sm font-semibold leading-snug text-ink-strong">{title}</span>
        </span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-accent-ink transition-colors group-hover:bg-accent-hover">
        {cta}
        <Icon name="arrowRight" size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
