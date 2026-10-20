import type { Metadata } from 'next';

import { SITE_URL } from './env';
import { getDict } from './i18n';
import { categoryPath, cityPath, directoryJsonLd, facetPath, facetsOf, labelFor, type DirectoryCrumb, type DirectoryFacets } from './directory';
import { programmaticPage, programmaticRoutes, type SeoRoute } from './data';
import type { ProgrammaticPage } from './types';

/**
 * Resolving a §29 directory page, server side. The pages themselves stay thin: this decides the
 * title, the breadcrumb trail and the canonical URL from the same payload, so the metadata, the
 * visible heading and the JSON-LD can never disagree about which page they are describing.
 */

export interface DirectoryRender {
  page: ProgrammaticPage;
  title: string;
  /** Used for the `<title>` and description only; the H1 gets `heading` so the page leads with place. */
  eyebrow: string;
  intro: string;
  crumbs: DirectoryCrumb[];
  facets: DirectoryFacets;
  canonical: string;
  /** Absolute URL — JSON-LD and OpenGraph both need one, and a relative `@id` is not a identity. */
  absoluteUrl: string;
}

/** `null` means "outside the grammar" — the route turns that into a real 404, never an empty page. */
export async function directoryRender(
  city: string,
  category: string,
  facet: string | null,
  locale: string,
): Promise<DirectoryRender | null> {
  const result = await programmaticPage(city, category, facet);
  const page = result.data;
  if (!page) return null;

  const dict = getDict(locale);
  const cityName = labelFor(dict.seo, 'cities', page.city);
  const categoryName = labelFor(dict.seo, 'categories', page.category);
  const facetName = page.subcategory ? labelFor(dict.seo, 'facets', page.subcategory) : null;

  const title = facetName
    ? dict.seo.facetHeading(facetName, categoryName)
    : dict.seo.categoryHeading(categoryName, cityName);
  const path = facetName
    ? facetPath(page.city, page.category, page.subcategory as string)
    : categoryPath(page.city, page.category);
  const facets = facetsOf(page);
  const intro = facetName
    ? dict.seo.facetIntro(facetName, categoryName, cityName, facets.listings)
    : dict.seo.categoryIntro(categoryName, cityName, facets.listings);

  return {
    page,
    title,
    eyebrow: facetName ?? categoryName,
    intro,
    crumbs: [
      { label: dict.seo.breadcrumbRoot, href: cityPath(page.city) },
      { label: categoryName, href: facetName ? categoryPath(page.city, page.category) : null },
      ...(facetName ? [{ label: facetName, href: null }] : []),
    ],
    facets,
    canonical: path,
    absoluteUrl: `${SITE_URL}${path}`,
  };
}

export interface CityLanding {
  city: string;
  cityName: string;
  categories: Array<{ slug: string; name: string; listings: number; href: string; facets: Array<{ slug: string; name: string; listings: number; href: string }> }>;
  listings: number;
  canonical: string;
  absoluteUrl: string;
}

/**
 * `/hong-kong`: the category index. It is only worth a URL because the counts are real — a category
 * with no listings is not offered, so the page cannot drift into advertising an empty aisle (§30).
 */
export async function cityLanding(city: string, locale: string): Promise<CityLanding | null> {
  const result = await programmaticRoutes(city);
  const routes = result.data;
  if (routes.length === 0) return null;

  const dict = getDict(locale);
  const cityName = labelFor(dict.seo, 'cities', city);
  const byCategory = new Map<string, { slug: string; name: string; listings: number; facets: CityLanding['categories'][number]['facets'] }>();
  for (const route of routes) {
    const name = labelFor(dict.seo, 'categories', route.category);
    const entry = byCategory.get(route.category) ?? { slug: route.category, name, listings: 0, facets: [] };
    if (route.subcategory === null) {
      entry.listings = route.listings;
    } else {
      entry.facets.push({
        slug: route.subcategory,
        name: labelFor(dict.seo, 'facets', route.subcategory),
        listings: route.listings,
        href: facetPath(city, route.category, route.subcategory),
      });
    }
    byCategory.set(route.category, entry);
  }

  const categories = Array.from(byCategory.values())
    .filter((entry) => entry.listings > 0)
    .sort((left, right) => right.listings - left.listings)
    .map((entry) => ({ ...entry, href: categoryPath(city, entry.slug) }));

  if (categories.length === 0) return null;
  return {
    city,
    cityName,
    categories,
    listings: categories.reduce((total, entry) => total + entry.listings, 0),
    canonical: cityPath(city),
    absoluteUrl: `${SITE_URL}${cityPath(city)}`,
  };
}

export type { SeoRoute };

/**
 * Metadata for a directory page. `indexable` decides the robots directive *and* the sitemap entry
 * (through the same payload field), so a page can never be simultaneously noindexed on itself and
 * advertised in the sitemap — the §30 rule enforced in one place instead of two.
 */
export function directoryMetadata(render: DirectoryRender): Metadata {
  return {
    title: render.title,
    description: render.intro,
    alternates: { canonical: render.canonical },
    robots: render.page.indexable ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: {
      title: render.title,
      description: render.intro,
      url: render.absoluteUrl,
      type: 'website',
    },
  };
}

export function directoryJsonLdFor(render: DirectoryRender): Record<string, unknown> {
  return directoryJsonLd({
    name: render.title,
    description: render.intro,
    url: render.absoluteUrl,
    updatedAt: render.page.updated_at,
    items: render.page.listings.map((listing) => ({
      name: listing.name,
      url: `${SITE_URL}/m/${listing.slug}`,
    })),
  });
}
