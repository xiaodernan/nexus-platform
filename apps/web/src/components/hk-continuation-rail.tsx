import Link from 'next/link';

import { hkContinuation } from '@/lib/hk-continuation';
import type { Guide } from '@/lib/types';

/**
 * D1580 — server-rendered, local-only. The main hub's clock/continue strip stops at chapter 106;
 * this rail reads the full corpus so a reader who finished the curated clock still has a next
 * chapter, and every card is one tap away. No model, no network, no client state.
 */
export interface HkContinuationCopy {
  eyebrow: string;
  title: string;
  hint: string;
  chapterLabel: string;
  cta: string;
  ctaHref: string;
}

export function HkContinuationRail({ guides, copy }: { guides: Guide[]; copy: HkContinuationCopy }) {
  const { total, chapters } = hkContinuation(guides, 8);
  if (!chapters.length) return null;
  return (
    <section aria-label={copy.title} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <span className="text-2xs font-semibold uppercase tracking-[0.2em] text-accent">{copy.eyebrow}</span>
      <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-strong">{copy.title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{copy.hint}</p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {chapters.map((c) => (
          <li key={c.slug}>
            <Link
              href={c.href}
              className="group block h-full rounded-xl border border-line bg-canvas px-3 py-2.5 transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="font-mono text-2xs text-accent">
                {copy.chapterLabel.replace('{n}', String(c.number))} · {total}
              </span>
              <span className="mt-1 block text-2xs leading-snug text-ink-strong group-hover:text-accent">
                {c.title}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <Link
        href={copy.ctaHref}
        className="mt-4 inline-flex items-center gap-2 rounded-full border border-accent-line px-4 py-2 text-2xs font-semibold text-accent transition-colors hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {copy.cta}
      </Link>
    </section>
  );
}
