import { describe, expect, it } from 'vitest';

import { getDict } from './i18n';
import { categoryPath, cityPath, directoryJsonLd, facetPath, facetsOf, labelFor } from './directory';
import type { ProgrammaticPage } from './types';
import type { EntityCard } from '@nexus/ui/trust/types';

/**
 * Guards for the pure directory layer (§29). What these tests protect is the promise the page makes
 * to a reader: the counts it prints are counts of what it actually rendered, its labels only ever
 * name slugs the payload used, and its structured data claims nothing the page cannot show.
 */

/** Only the fields `facetsOf` reads exist here — the helper must not reach for anything else. */
function card(open: boolean | undefined, amount: number | undefined): EntityCard {
  return {
    open: open === undefined ? undefined : { is_open: open },
    price: amount === undefined ? undefined : { amount, currency: 'HKD' },
  } as unknown as EntityCard;
}

function page(over: Partial<ProgrammaticPage> = {}): ProgrammaticPage {
  return {
    city: 'hong-kong',
    category: 'restaurants',
    subcategory: null,
    heading: '餐廳 · 香港',
    intro: '',
    listings: [],
    cards: [card(true, 120), card(false, 800), card(true, undefined), card(undefined, 200)],
    facets: {
      open_now_count: 99,
      under_budget_count: 99,
      under_budget_hkd: 200,
      districts: ['Central', '', 'Sha Tin'],
      price_range: { min: 120, max: 800 },
    },
    updated_at: '2026-09-20T00:00:00.000Z',
    indexable: true,
    reason: 'enough_listings',
    ...over,
  };
}

describe('§29 URL grammar', () => {
  it('builds city, category and facet paths from slugs only', () => {
    expect(cityPath('hong-kong')).toBe('/hong-kong');
    expect(categoryPath('hong-kong', 'restaurants')).toBe('/hong-kong/restaurants');
    expect(facetPath('hong-kong', 'restaurants', 'date-night')).toBe('/hong-kong/restaurants/date-night');
  });
});

describe('labelFor — no invented copy', () => {
  it('uses the dictionary when the slug is known', () => {
    const seo = getDict('zh-HK').seo;
    expect(labelFor(seo, 'cities', 'hong-kong')).toBe('香港');
    expect(labelFor(getDict('en').seo, 'cities', 'hong-kong')).toBe('Hong Kong');
  });

  it('degrades to the raw slug rather than guessing a translation', () => {
    const seo = getDict('zh-HK').seo;
    expect(labelFor(seo, 'cities', 'vancouver')).toBe('vancouver');
    expect(labelFor(seo, 'facets', 'unknown-facet')).toBe('unknown-facet');
  });
});

describe('facetsOf — numbers must be true of what the page shows (§19)', () => {
  it('re-derives the counts from the rendered cards, not the payload totals', () => {
    const facets = facetsOf(page());
    expect(facets.listings).toBe(4);
    expect(facets.openNow).toBe(2);
    expect(facets.underBudget).toBe(2);
    expect(facets.budgetHkd).toBe(200);
  });

  it('counts a missing price or missing opening state as neither', () => {
    const facets = facetsOf(page({ cards: [card(true, undefined), card(undefined, undefined)] }));
    expect(facets.openNow).toBe(1);
    expect(facets.underBudget).toBe(0);
  });

  it('drops empty district labels while keeping the rest', () => {
    expect(facetsOf(page()).districts).toEqual(['Central', 'Sha Tin']);
  });

  it('carries the price range through untouched, null included', () => {
    expect(facetsOf(page()).priceRange).toEqual({ min: 120, max: 800 });
    const empty = page({ cards: [], facets: { ...page().facets, price_range: null } });
    expect(facetsOf(empty).priceRange).toBeNull();
    expect(facetsOf(empty).listings).toBe(0);
  });
});

describe('directoryJsonLd — CollectionPage/ItemList', () => {
  const json = directoryJsonLd({
    name: '香港餐廳',
    description: 'd',
    url: 'https://nex.us/hong-kong/restaurants',
    updatedAt: '2026-09-20T00:00:00.000Z',
    items: [
      { name: 'A', url: 'https://nex.us/m/a' },
      { name: 'B', url: 'https://nex.us/m/b' },
    ],
  });

  it('names only the items it was given, in order', () => {
    const main = json.mainEntity as { numberOfItems: number; itemListElement: Array<{ position: number; name: string }> };
    expect(json['@type']).toBe('CollectionPage');
    expect(main.numberOfItems).toBe(2);
    expect(main.itemListElement.map((el) => el.position)).toEqual([1, 2]);
    expect(main.itemListElement.map((el) => el.name)).toEqual(['A', 'B']);
  });

  it('never publishes a page-level aggregateRating', () => {
    expect(JSON.stringify(json)).not.toContain('aggregateRating');
  });

  it('reports zero items for an empty page instead of omitting the list', () => {
    const empty = directoryJsonLd({
      name: 'n',
      description: 'd',
      url: 'https://nex.us/hong-kong/shopping',
      updatedAt: '2026-09-20T00:00:00.000Z',
      items: [],
    });
    const main = empty.mainEntity as { numberOfItems: number; itemListElement: unknown[] };
    expect(main.numberOfItems).toBe(0);
    expect(main.itemListElement).toEqual([]);
  });
});
