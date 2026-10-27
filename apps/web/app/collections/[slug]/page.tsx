import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { collectionBySlug } from '@/lib/data';
import { SITE_URL } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { CollectionView } from '@/components/growth-view';
import { JsonLd } from '@/components/json-ld';

/** `/collections/{slug}` (§8). */

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata(props: Props): Promise<Metadata | undefined> {
  const { slug } = await props.params;
  const locale = await currentLocale();
  const collection = (await collectionBySlug(decodeURIComponent(slug), locale)).data;
  if (!collection) return undefined;
  const cover = collection.cover_image;
  return {
    title: collection.title,
    description: collection.description,
    alternates: { canonical: `/collections/${collection.slug}` },
    openGraph: {
      title: collection.title,
      description: collection.description,
      url: `${SITE_URL}/collections/${collection.slug}`,
      type: 'website',
      images: cover ? [{ url: cover.url, alt: cover.alt }] : undefined,
    },
  };
}

export default async function CollectionPage(props: Props) {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const { slug } = await props.params;
  const collection = (await collectionBySlug(decodeURIComponent(slug), locale)).data;
  if (!collection) notFound();

  return (
    <>
      <CollectionView collection={collection} locale={locale} />
      <JsonLd
        value={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: collection.title,
          description: collection.description,
          url: `${SITE_URL}/collections/${collection.slug}`,
          dateModified: collection.updated_at,
          // A curated list is an opinion, so the schema names the curator — including when that
          // curator is the model, which is exactly what §66 asks the page to keep distinguishable.
          creator:
            collection.curated_by.type === 'ai'
              ? { '@type': 'Organization', name: `${dict.brand.name} AI` }
              : { '@type': 'Organization', name: collection.curated_by.name },
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: collection.items.length,
            itemListElement: collection.items.map((card, index) => ({
              '@type': 'ListItem',
              position: index + 1,
              name: card.title,
              url: `${SITE_URL}${card.href ?? ''}`,
            })),
          },
        }}
      />
    </>
  );
}
