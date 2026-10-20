import { describe, expect, it } from 'vitest';

import { sitemapEntries, type SitemapSource } from './seo';

/**
 * Guard tests for the pure SEO surface (§27 authorization, §29/§30 quality bar, §19/§155 no-invented
 * data). These exercise `sitemapEntries` directly — the Next route modules are thin wrappers around
 * it — so the rules that decide *what a crawler is allowed to see* hold without booting a server or
 * a database.
 *
 * The origin is passed explicitly everywhere, both to keep the assertions independent of `SITE_URL`
 * and to prove the emitted URLs are built from the configured origin rather than a hardcoded one.
 */

const ORIGIN = 'https://nex.us';

/** Category page clears the §30 bar; the facet under it is below it and must not ship. */
const PARENT_CATEGORY: SitemapSource = {
  path: '/hong-kong/restaurants',
  lastModified: '2026-09-20T00:00:00.000Z',
  indexable: true,
};
const THIN_FACET: SitemapSource = {
  path: '/hong-kong/restaurants/rainy-day',
  lastModified: '2026-09-20T00:00:00.000Z',
  indexable: false,
};

describe('sitemapEntries — §27 human authorization', () => {
  it('emits nothing at all while discovery is not authorised', () => {
    const sources: SitemapSource[] = [{ path: '/' }, PARENT_CATEGORY, THIN_FACET];
    expect(sitemapEntries(sources, false, ORIGIN)).toEqual([]);
  });
});

describe('sitemapEntries — §29/§30 content-quality bar', () => {
  it('drops a below-bar programmatic facet but keeps its parent category page', () => {
    const urls = sitemapEntries([PARENT_CATEGORY, THIN_FACET], true, ORIGIN).map((entry) => entry.url);
    expect(urls).toContain(`${ORIGIN}/hong-kong/restaurants`);
    expect(urls).not.toContain(`${ORIGIN}/hong-kong/restaurants/rainy-day`);
  });
});

describe('sitemapEntries — emitted URL shape', () => {
  const inventory: SitemapSource[] = [
    { path: '/' },
    { path: '/m/lung-yuen-kitchen' },
    { path: '/o/lung-yuen-set-dinner-two' },
    { path: '/hong-kong' },
    PARENT_CATEGORY,
    { path: '/hong-kong/restaurants/date-night', indexable: true },
    { path: '/guides', lastModified: null },
    { path: '/guides/first-date-in-saturn', lastModified: '2026-09-19T00:00:00.000Z' },
    { path: '/collections/quiet-corner-cafes', lastModified: '2026-09-18T00:00:00.000Z' },
    // A future regression that adds result pages to the index must trip assertion (d).
    { path: '/search' },
    { path: '/search', lastModified: null },
  ];

  it('builds every URL from the site origin (c)', () => {
    const entries = sitemapEntries(inventory, true, ORIGIN);
    expect(entries.length).toBeGreaterThan(0);
    const offOrigin = entries.filter((entry) => !entry.url.startsWith(`${ORIGIN}/`)).map((entry) => entry.url);
    expect(offOrigin, `URLs must be origin-qualified, never relative or foreign:\n${offOrigin.join('\n')}`).toEqual([]);
  });

  it('never lists a /search result page (d)', () => {
    const leaked = sitemapEntries(inventory, true, ORIGIN).filter((entry) => new URL(entry.url).pathname.startsWith('/search'));
    expect(leaked, `/search results are a function of a query string and must stay out of the index:\n${leaked.map((e) => e.url).join('\n')}`).toEqual([]);
  });

  it('carries lastModified only when the payload held a real timestamp (§19/§155)', () => {
    const withBadStamp: SitemapSource[] = [
      { path: '/m/no-timestamp' },
      { path: '/guides/real', lastModified: '2026-09-19T00:00:00.000Z' },
      { path: '/collections/junk', lastModified: 'not-a-date' },
    ];
    const byPath = new Map(sitemapEntries(withBadStamp, true, ORIGIN).map((entry) => [new URL(entry.url).pathname, entry]));
    expect(byPath.get('/m/no-timestamp')?.lastModified).toBeUndefined();
    expect(byPath.get('/guides/real')?.lastModified).toBe('2026-09-19T00:00:00.000Z');
    expect(byPath.get('/collections/junk')?.lastModified, 'an unparseable timestamp must be dropped, not passed through').toBeUndefined();
  });

  it('deduplicates the bare /{city} landing when it arrives from many routes', () => {
    const cities: SitemapSource[] = [
      { path: '/hong-kong' },
      { path: '/hong-kong' },
      PARENT_CATEGORY,
    ];
    const urls = sitemapEntries(cities, true, ORIGIN).map((entry) => entry.url);
    expect(urls.filter((url) => url === `${ORIGIN}/hong-kong`)).toHaveLength(1);
  });
});
