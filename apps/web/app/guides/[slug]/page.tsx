import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { guideBySlug } from '@/lib/data';
import { SITE_URL } from '@/lib/env';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { GuideView } from '@/components/growth-view';
import { JsonLd } from '@/components/json-ld';

/**
 * `/guides/{slug}` (§8, §28). An unreviewed AI guide is still readable, but it is kept out of the
 * index: publishing machine-written prose at scale is the §30 failure, so a human check is what turns
 * it into an indexed document. The page itself always shows the review state and the disclosure.
 */

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata(props: Props): Promise<Metadata | undefined> {
  const { slug } = await props.params;
  const guide = (await guideBySlug(decodeURIComponent(slug))).data;
  if (!guide) return undefined;
  return {
    title: guide.title,
    description: guide.description,
    alternates: { canonical: `/guides/${guide.slug}` },
    robots: guide.reviewed_by_human ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      title: guide.title,
      description: guide.description,
      url: `${SITE_URL}/guides/${guide.slug}`,
      type: 'article',
    },
  };
}

export default async function GuidePage(props: Props) {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const { slug } = await props.params;
  const guide = (await guideBySlug(decodeURIComponent(slug))).data;
  if (!guide) notFound();

  return (
    <>
      <GuideView guide={guide} locale={locale} />
      <JsonLd
        value={{
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: guide.title,
          description: guide.description,
          datePublished: guide.published_at,
          dateModified: guide.updated_at,
          inLanguage: dict.locale,
          // The author field says who wrote it, and only what the payload actually knows: a model is
          // credited as a model, and a guide with no named human author gets no `author` at all.
          ...(guide.generated_by === 'ai'
            ? { author: { '@type': 'Organization', name: `${dict.brand.name} AI` } }
            : {}),
          publisher: { '@type': 'Organization', name: dict.brand.name, url: SITE_URL },
          mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE_URL}/guides/${guide.slug}` },
        }}
      />
    </>
  );
}
