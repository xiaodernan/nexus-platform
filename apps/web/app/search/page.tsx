import type { Metadata } from 'next';
import { Container } from '@nexus/ui';

import { resolveGeo } from '@/lib/geo';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { SearchResults } from '@/components/search-results';

/**
 * The AI search page (§7, §116). The server renders the shell and the query; everything that comes
 * back from the model streams into the client component, so a slow or failed model degrades the page
 * rather than blocking the first byte.
 */

export const dynamic = 'force-dynamic';

/** Search results are a function of a query string, not a document — they must not be indexed (§29). */
export async function generateMetadata(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const params = await props.searchParams;
  const query = (typeof params.q === 'string' ? params.q : '').trim().slice(0, 200);
  return {
    title: query ? `${dict.search.title(query)} — ${dict.brand.name}` : `${dict.nav.search} — ${dict.brand.name}`,
    description: dict.home.subtitle,
    robots: { index: false, follow: true },
    alternates: { canonical: '/search' },
  };
}

export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await props.searchParams;
  const locale = await currentLocale();
  const raw = typeof params.q === 'string' ? params.q : '';
  const query = raw.trim().slice(0, 200);
  const geo = resolveGeo({ lat: params.lat, lng: params.lng, district: params.district });
  // `/search?q=…&degrade=1` asks the mock stream to fail, so a reviewer can see the §105 fallback
  // without killing a service. Live mode drops the flag at the BFF — see the stream route.
  const degrade = params.degrade === '1' || params.degrade === 'true';

  return (
    <Container size="shell" className="py-6 sm:py-10">
      <SearchResults initialQuery={query} geo={geo} locale={locale} forceStreamError={degrade} />
    </Container>
  );
}
