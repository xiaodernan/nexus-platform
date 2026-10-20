import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { Container } from '@nexus/ui';

import { offeringBySlug } from '@/lib/data';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { OfferingView } from '@/components/offering-view';

/** The public offering page (§34): one product, service or experience, with its price provenance. */

const loadOffering = cache(offeringBySlug);

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const { slug } = await props.params;
  const offering = (await loadOffering(decodeURIComponent(slug))).data;
  if (!offering) {
    // Same reason as the merchant page: a 404 decided in `generateMetadata` keeps the status honest.
    notFound();
  }
  return {
    title: `${offering.title} — ${offering.merchant.name} · ${dict.brand.name}`,
    description: offering.description?.slice(0, 160) ?? dict.offering.merchant,
    alternates: { canonical: `/o/${offering.slug}` },
  };
}

export default async function OfferingPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const locale = await currentLocale();
  const result = await loadOffering(decodeURIComponent(slug));
  if (!result.data) {
    notFound();
  }
  return (
    <Container size="prose" className="py-6 sm:py-10">
      <OfferingView offering={result.data} locale={locale} />
    </Container>
  );
}
