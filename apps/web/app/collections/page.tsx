import type { Metadata } from 'next';

import { collectionList } from '@/lib/data';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { GrowthCardLink, GrowthIndex } from '@/components/growth-view';

/** `/collections` (§8): curated lists, each one labelled with who curated it. */

export async function generateMetadata(): Promise<Metadata> {
  const dict = getDict(await currentLocale());
  return {
    title: dict.growth.collectionsTitle,
    description: dict.growth.collectionsIntro,
    alternates: { canonical: '/collections' },
  };
}

export default async function CollectionsIndexPage() {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const result = await collectionList();
  const collections = result.data.items;

  return (
    <GrowthIndex
      title={dict.growth.collectionsTitle}
      intro={dict.growth.collectionsIntro}
      locale={locale}
      notice={result.degraded ? dict.states.error : null}
    >
      {collections.length === 0 ? (
        <p className="text-sm text-ink-muted">{dict.states.empty}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {collections.map((collection) => (
            <li key={collection.slug}>
              <GrowthCardLink
                href={`/collections/${collection.slug}`}
                title={collection.title}
                description={collection.description}
                meta={dict.growth.curatedBy(collection.curated_by.name)}
              />
            </li>
          ))}
        </ul>
      )}
    </GrowthIndex>
  );
}
