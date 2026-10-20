import type { Dict } from './i18n';
import type { ProgrammaticPage } from './types';

/**
 * The URL grammar of §29 and the numbers a directory page shows, in one pure module so the routes,
 * the sitemap and the tests all agree on the same shape:
 *
 *   /{city}                        → categories with their listing counts
 *   /{city}/{category}             → that category's listings
 *   /{city}/{category}/{facet}     → a facet of it (cuisine, occasion, district)
 *
 * Nothing here decides *whether* a page may be indexed — `ProgrammaticPage.indexable` comes from the
 * data plane, because the §30 quality bar is the platform's call, not the view's.
 */

export interface DirectoryCrumb {
  label: string;
  href: string | null;
}

export interface DirectoryFacets {
  listings: number;
  openNow: number;
  underBudget: number;
  budgetHkd: number;
  districts: string[];
  priceRange: { min: number; max: number } | null;
}

export function cityPath(city: string): string {
  return `/${city}`;
}

export function categoryPath(city: string, category: string): string {
  return `/${city}/${category}`;
}

export function facetPath(city: string, category: string, facet: string): string {
  return `/${city}/${category}/${facet}`;
}

/** A facet slug is also a district slug in §29's grammar; both come from the payload, never here. */
export function labelFor(seo: Dict['seo'], kind: 'cities' | 'categories' | 'facets', slug: string): string {
  return seo[kind][slug] ?? slug;
}

/**
 * The counts on the page, read off the page's own listings. The payload already carries a facet
 * block; this re-derives the same figures defensively so a card that failed to render cannot be
 * counted in the summary (§19: a displayed number must be true of what is displayed).
 */
export function facetsOf(page: ProgrammaticPage): DirectoryFacets {
  return {
    listings: page.cards.length,
    openNow: page.cards.filter((card) => card.open?.is_open).length,
    underBudget: page.cards.filter((card) => card.price && Number(card.price.amount) <= page.facets.under_budget_hkd).length,
    budgetHkd: page.facets.under_budget_hkd,
    districts: page.facets.districts.filter(Boolean),
    priceRange: page.facets.price_range,
  };
}

/**
 * JSON-LD for a directory page (§29). `ItemList` names only the businesses actually on the page and
 * links them by URL; no `aggregateRating` appears here, because a page-level average of merchant
 * ratings is not a fact any merchant claimed.
 */
export function directoryJsonLd(input: {
  name: string;
  description: string;
  url: string;
  updatedAt: string;
  items: Array<{ name: string; url: string }>;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: input.name,
    description: input.description,
    url: input.url,
    dateModified: input.updatedAt,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: input.items.length,
      itemListElement: input.items.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        url: item.url,
      })),
    },
  };
}
