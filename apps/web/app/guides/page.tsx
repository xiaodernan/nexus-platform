import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Icon } from '@nexus/ui';

import { guideList } from '@/lib/data';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { IS_MOCK } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { GrowthCardLink, GrowthIndex } from '@/components/growth-view';
import { EmptyState } from '@nexus/ui';


/** `/guides` (§8): the index of editorial/AI guides. Nothing is listed that the data plane omitted. */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.growth.guidesTitle,
    description: dict.growth.guidesIntro,
    alternates: { canonical: '/guides' },
  };
}

export default async function GuidesIndexPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const result = await guideList(locale);
  const guides = result.data.items;

  return (
    <GrowthIndex
      title={dict.growth.guidesTitle}
      intro={dict.growth.guidesIntro}
      locale={locale}
      notice={result.degraded ? dict.states.error : null}
    >
      {IS_MOCK ? (
        <section aria-labelledby="guides-hk-series" className="relative overflow-hidden rounded-2xl border border-accent-line bg-accent-soft p-5">
          <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full" style={{ background: 'var(--nexus-ai-gradient)', opacity: 0.12, filter: 'blur(40px)' }} />
          <div className="relative flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-2xs font-semibold uppercase tracking-[0.22em] text-accent">
                {dict.growth.hkSeriesFeatured.eyebrow}
              </span>
              <Badge tone="accent" size="sm">{dict.home.hkSeries.cards.length}</Badge>
            </div>
            <h2 id="guides-hk-series" className="text-balance text-2xl font-semibold leading-tight tracking-tight text-ink-strong">
              {dict.growth.hkSeriesFeatured.title}
            </h2>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">{dict.growth.hkSeriesFeatured.blurb}</p>
            <ul className="mt-1 grid gap-2 sm:grid-cols-2">
              {dict.home.hkSeries.cards.map((card) => (
                <li key={card.slug}>
                  <Link
                    href={`/guides/${card.slug}`}
                    className="group flex h-full items-start gap-3 rounded-xl border border-accent-line/70 bg-surface p-3 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-accent hover:shadow-md"
                  >
                    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-ink">
                      <Icon name="layers" size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-2xs uppercase tracking-wide text-ink-faint">{card.kicker}</span>
                      <span className="mt-0.5 block text-sm font-semibold leading-snug text-ink-strong">{card.label}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {guides.length === 0 ? (
        <EmptyState icon="pin" title={dict.states.empty} className="py-10" />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {guides.map((guide) => {
            const when = formatDateTime(guide.updated_at, locale);
            return (
              <li key={guide.slug}>
                <GrowthCardLink
                  href={`/guides/${guide.slug}`}
                  title={guide.title}
                  description={guide.description}
                  meta={dict.growth.updatedOn(when ?? guide.updated_at)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </GrowthIndex>
  );
}
