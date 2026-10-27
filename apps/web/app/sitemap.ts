import type { MetadataRoute } from 'next';
import { notFound } from 'next/navigation';

import { collectionList, guideList, programmaticPage, programmaticRoutes } from '@/lib/data';
import { IS_MOCK, SEO_DISCOVERY_ENABLED, SITE_URL, TENANT } from '@/lib/env';
import { currentLocale } from '@/lib/i18n/server';
import { SEED_MERCHANTS } from '@/lib/mock';
import { sitemapEntries, type SitemapSource } from '@/lib/seo';

/**
 * `/sitemap.xml` (§29). The guide / collection / programmatic URLs are read through the data plane,
 * so this is async and genuinely dynamic (`force-dynamic` stops a live-mode build from baking
 * yesterday's URL list into the artifact).
 *
 * §27 keeps every publish behind a human action, and letting a crawler enumerate the site is a
 * publish: when discovery is not authorised this route calls `notFound()` and answers 404 rather
 * than returning `[]` — an empty sitemap that answers 200 falsely claims the surface exists.
 *
 * The URL inventory mirrors the pages the lead is building:
 *   `/`  ·  `/m/{slug}`  ·  `/o/{slug}`  ·  `/{city}`  ·  `/{city}/{category}`
 *   `/{city}/{category}/{facet}`  ·  `/guides`  ·  `/guides/{slug}`  ·  `/collections`  ·  `/collections/{slug}`
 * Merchants and offerings have no list endpoint in the data plane and no real timestamp on the seed,
 * so they come from the seed catalogue and ship without `lastModified` (§19/§155 forbid inventing
 * one). Guides/collections/programmatic rows carry `published_at`/`updated_at` straight from the
 * payload. Programmatic rows are gated per page by `indexable` (§29/§30) inside `sitemapEntries`.
 */
export const dynamic = 'force-dynamic';

function programmaticPath(city: string, category: string, subcategory: string | null): string {
  return `/${city}${category ? `/${category}` : ''}${subcategory ? `/${subcategory}` : ''}`;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!SEO_DISCOVERY_ENABLED) {
    notFound();
  }

  const sources: SitemapSource[] = [{ path: '/' }, { path: '/guides' }, { path: '/collections' }];

  // Merchant and offering slugs still come from the seed catalogue, because the data plane has no
  // directory read yet (`GET /api/v1/merchants` is contracted but unwrapped). Until it is wired,
  // those URLs are only ours to publish in mock mode: emitting fixture slugs as if they were live
  // listings is the §155 failure, so a live deployment publishes the pages it can actually enumerate.
  if (IS_MOCK) {
    sources.push(
      ...SEED_MERCHANTS.map((seed) => ({ path: `/m/${seed.slug}` })),
      ...SEED_MERCHANTS.flatMap((seed) => seed.offerings.map((offering) => ({ path: `/o/${offering.slug}` }))),
    );
  }

  // Programmatic pages: read the (category, facet) routes for the deployment city, then fetch each
  // page's own `indexable` flag + `updated_at` from the data plane, so a below-bar facet is dropped
  // while its parent category page stays listed. The bare `/{city}` landing is emitted only for
  // cities that actually returned routes — never for a city we merely guessed at.
  const routes = (await programmaticRoutes(TENANT)).data ?? [];
  for (const city of new Set(routes.map((route) => route.city))) {
    sources.push({ path: `/${city}` });
  }
  const programmaticResults = await Promise.all(
    routes.map(async (route) => ({
      route,
      page: (await programmaticPage(route.city, route.category, route.subcategory)).data,
    })),
  );
  for (const { route, page } of programmaticResults) {
    sources.push({
      path: programmaticPath(route.city, route.category, route.subcategory),
      lastModified: page?.updated_at ?? null,
      indexable: page ? page.indexable : false,
    });
  }

  // The sitemap carries paths and timestamps, not titles, but the reads it makes project the
  // payload's localized title pair — so it resolves the same locale the pages would.
  const locale = await currentLocale();

  const guides = (await guideList(locale)).data?.items ?? [];
  for (const guide of guides) {
    sources.push({
      path: `/guides/${guide.slug}`,
      lastModified: guide.published_at ?? guide.updated_at ?? null,
      // `app/guides/[slug]` noindexes an unreviewed AI guide; the sitemap has to agree with it,
      // otherwise the two surfaces disagree about the same document (§29/§30).
      indexable: guide.reviewed_by_human,
    });
  }

  const collections = (await collectionList(locale)).data?.items ?? [];
  for (const collection of collections) {
    sources.push({ path: `/collections/${collection.slug}`, lastModified: collection.updated_at ?? null });
  }

  return sitemapEntries(sources, SEO_DISCOVERY_ENABLED, SITE_URL);
}
