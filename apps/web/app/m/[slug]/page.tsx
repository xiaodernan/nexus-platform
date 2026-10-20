import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { Container } from '@nexus/ui';

import { merchantBySlug } from '@/lib/data';
import { SITE_URL } from '@/lib/env';
import { factOf } from '@/lib/format';
import { resolveGeo } from '@/lib/geo';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import type { MerchantDetail } from '@/lib/types';
import { MerchantView } from '@/components/merchant-view';

/**
 * The public merchant profile (§34) — the page a search card or an SEO listing links to.
 *
 * `cache()` dedupes the data plane across `generateMetadata` and the body so one request performs one
 * upstream read, not two.
 */

const loadMerchant = cache(merchantBySlug);

function jsonLd(detail: MerchantDetail) {
  const location = detail.locations[0];
  const rating = factOf({ facts: detail.facts }, 'rating')?.value as { value?: number; count?: number } | undefined;
  const price = factOf({ facts: detail.facts }, 'price')?.value as { amount?: string; currency?: string } | undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: detail.name,
    description: detail.tagline ?? undefined,
    url: `${SITE_URL}/m/${detail.slug}`,
    telephone: location?.phone ?? undefined,
    priceRange: price?.amount ? `${price.currency ?? 'HKD'} ${price.amount}` : undefined,
    address: location
      ? { '@type': 'PostalAddress', streetAddress: location.address, addressLocality: location.district, addressCountry: 'HK' }
      : undefined,
    geo: location ? { '@type': 'GeoCoordinates', latitude: location.geo.lat, longitude: location.geo.lng } : undefined,
    // Schema only carries numbers that resolve to a fact; an unverified rating is omitted, not guessed.
    aggregateRating:
      rating && typeof rating.value === 'number'
        ? { '@type': 'AggregateRating', ratingValue: rating.value, reviewCount: rating.count ?? 0, bestRating: 5 }
        : undefined,
  };
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const { slug } = await props.params;
  const result = await loadMerchant(decodeURIComponent(slug));
  const detail = result.data?.detail;
  if (!detail) {
    // Raising the 404 from `generateMetadata` is what makes the status honest: once the page body
    // runs, the shell may already be streaming, and a missing profile would then return 200 around
    // the not-found UI — a soft 404, which is exactly what §29 tells us not to publish.
    notFound();
  }
  const location = detail.locations[0];
  return {
    title: `${detail.name} — ${detail.tagline ?? detail.category} · ${location?.district ?? ''}`.trim(),
    description: detail.description?.slice(0, 160) ?? detail.tagline ?? dict.merchant.about,
    alternates: { canonical: `/m/${detail.slug}` },
    openGraph: {
      title: detail.name,
      description: detail.tagline ?? undefined,
      type: 'profile',
      images: detail.images[0] ? [{ url: detail.images[0].url, alt: detail.images[0].alt }] : undefined,
    },
  };
}

export default async function MerchantPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, search] = await Promise.all([props.params, props.searchParams]);
  const locale = await currentLocale();
  const result = await loadMerchant(decodeURIComponent(slug));
  if (!result.data) {
    notFound();
  }
  const page = result.data;
  const geo = resolveGeo({ lat: search.lat, lng: search.lng, district: search.district });

  return (
    <Container size="shell" className="py-6 sm:py-10">
      <MerchantView page={page} locale={locale} geo={geo} degradedReason={result.degradedReason ?? null} />
      <script
        type="application/ld+json"
        // Structured data is generated from the same facts the page renders, never hand-written copy.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(page.detail)) }}
      />
    </Container>
  );
}
