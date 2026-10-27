import type { Metadata } from 'next';

import { guideList } from '@/lib/data';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { formatDateTime } from '@/lib/format';
import { GrowthCardLink, GrowthIndex } from '@/components/growth-view';

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
      {guides.length === 0 ? (
        <p className="text-sm text-ink-muted">{dict.states.empty}</p>
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
