import type { MetadataRoute } from 'next';

import { SEO_DISCOVERY_ENABLED, SITE_URL } from '@/lib/env';

/**
 * `/robots.txt` (§29). Metadata routes are static by default: this one reads only `env` — no
 * cookies, no headers, no data plane — so it is reachable without a database and cannot quietly
 * break prerendering by touching request state.
 *
 * §27 treats "let the crawlers in" as a publish, so the default is closed: `Disallow: /` for every
 * user agent, and **no** `sitemap:` line, because advertising a sitemap that will itself 404 is
 * worse than silence. An operator opts the site into discovery by setting
 * `NEXUS_SEO_DISCOVERY_ENABLED=true`; flipping it is a human action, not a code change.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = new URL(SITE_URL);
  if (!SEO_DISCOVERY_ENABLED) {
    return {
      rules: [{ userAgent: '*', disallow: ['/'] }],
    };
  }
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        // §29: search results are a function of `?q=`, not documents, so they stay out of the index
        // even though the pages themselves remain followable via the meta robots tag. The BFF
        // catch-all under `/api/nexus/**` is internal plumbing and equally not for crawling.
        disallow: ['/search', '/api/'],
      },
    ],
    sitemap: new URL('/sitemap.xml', origin).toString(),
    host: origin.origin,
  };
}
