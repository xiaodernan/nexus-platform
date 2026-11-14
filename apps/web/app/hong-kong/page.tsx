import type { Metadata } from 'next';
import Link from 'next/link';
import { Container, Icon } from '@nexus/ui';

import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';

export const dynamic = 'force-static';

/**
 * `/hong-kong` — the mega-hub of the Hong Kong story series. Every chapter of the series
 * is listed with inline pointers into the guides pages, plus the quiz chapter and the
 * one ready tap into the seed search. The content is dict-driven and works in any
 * data mode — the demo catalogue and the live plane both use the same copy.
 */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.home.hkHub.title,
    description: dict.home.hkHub.intro,
    alternates: { canonical: '/hong-kong' },
  };
}

export default async function HongKongHubPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const chapters = dict.home.hkSeries.cards;
  const hub = dict.home.hkHub;

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line bg-canvas">
        <div aria-hidden="true" className="nexus-dot-grid pointer-events-none absolute inset-0" />
        <Container size="shell" className="relative flex flex-col gap-5 py-12 sm:py-16">
          <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">{hub.eyebrow}</span>
          <h1 className="max-w-[24ch] text-4xl font-semibold leading-[1.12] tracking-tight text-ink-strong sm:text-5xl">
            {hub.title}
          </h1>
          <p className="max-w-prose text-base leading-relaxed text-ink-muted">{hub.intro}</p>
        </Container>
      </section>

      {/* Seven chapter cards */}
      <Container size="shell" className="flex flex-col gap-6 py-10">
        <h2 className="text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">{hub.chaptersTitle}</h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {chapters.map((card) => (
            <li key={card.slug}>
              <Link
                href={`/guides/${card.slug}`}
                className="group relative flex h-full flex-col justify-between gap-5 overflow-hidden rounded-2xl border border-line bg-surface p-5 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-md"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
                  style={{ background: 'var(--nexus-ai-gradient)' }}
                />
                <span className="relative flex flex-col gap-2">
                  <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">{card.kicker}</span>
                  <span className="text-balance text-lg font-semibold leading-snug tracking-tight text-ink-strong">
                    {card.label}
                  </span>
                </span>
                <span className="relative inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-accent">
                  Read the chapter
                  <Icon name="arrowRight" size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>

        {/* The quiz teaser */}
        <section aria-labelledby="hub-quiz" className="relative mt-2 overflow-hidden rounded-2xl border border-accent-line bg-accent-soft p-6">
          <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full" style={{ background: 'var(--nexus-ai-gradient)', opacity: 0.18, filter: 'blur(36px)' }} />
          <div className="relative flex flex-col items-start gap-5 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-col gap-3">
              <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">QUIZ</span>
              <h2 id="hub-quiz" className="text-2xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-3xl">
                {hub.quizCtaTitle}
              </h2>
              <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{hub.quizCtaBody}</p>
            </div>
            <Link
              href="/hk-type"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
            >
              {hub.quizCta}
              <Icon name="arrowRight" size={14} />
            </Link>
          </div>
        </section>

        {/* The search taster */}
        <section aria-labelledby="hub-search" className="rounded-2xl border border-line bg-surface p-6">
          <div className="flex flex-col items-start gap-3">
            <span className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">REAL SEARCH</span>
            <h2 id="hub-search" className="text-lg font-semibold tracking-tight text-ink-strong">
              {hub.searchCta}
            </h2>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{hub.searchCtaBody}</p>
            <Link
              href={hub.searchHref}
              className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium text-accent transition-colors hover:border-accent"
            >
              {hub.searchHrefLabel}
              <Icon name="arrowRight" size={14} />
            </Link>
          </div>
        </section>
      </Container>
    </div>
  );
}
