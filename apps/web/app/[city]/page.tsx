import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Container, Icon } from '@nexus/ui';

import { cityLanding } from '@/lib/directory-server';
import { getDict } from '@/lib/i18n';
import { currentLocale } from '@/lib/i18n/server';
import { JsonLd } from '@/components/json-ld';
import { Breadcrumbs } from '@/components/directory-view';

/**
 * A `/{city}` the platform cannot route is a real 404, not an error boundary (§8). The platform
 * answers `seo_route_not_found` when the market id is outside the directory grammar — mirrored from
 * the `[category]` segment's own `NOT_ROUTABLE` discipline. Anything else (service down, 5xx) bubbles
 * so a genuine fault is never laundered into a clean miss.
 */
const NOT_ROUTABLE = new Set(['seo_route_not_found', 'not_found']);

type Props = { params: Promise<{ city: string }> };

async function landingOrNull(city: string, locale: string) {
  try {
    return await cityLanding(city, locale);
  } catch (cause) {
    if (NOT_ROUTABLE.has((cause as { code?: string })?.code ?? '')) return null;
    throw cause;
  }
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const { city } = await props.params;
  const landing = await landingOrNull(decodeURIComponent(city), locale);
  if (!landing) notFound();
  return {
    title: dict.seo.cityHeading(landing.cityName),
    description: dict.seo.cityIntro(landing.cityName, landing.categories.length),
    alternates: { canonical: landing.canonical },
    openGraph: { title: dict.seo.cityHeading(landing.cityName), url: landing.absoluteUrl, type: 'website' },
  };
}

export default async function CityPage(props: Props) {
  const locale = await currentLocale();
  const dict = getDict(locale);
  const { city } = await props.params;
  const landing = await landingOrNull(decodeURIComponent(city), locale);
  if (!landing) notFound();

  return (
    <>
      <Container size="shell" className="flex flex-col gap-7 py-8 sm:py-12">
        <div className="flex flex-col gap-3">
          <Breadcrumbs items={[{ label: dict.seo.breadcrumbRoot, href: null }]} />
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-4xl">
            {dict.seo.cityHeading(landing.cityName)}
          </h1>
          <p className="max-w-3xl text-sm leading-relaxed text-ink-muted sm:text-base">
            {dict.seo.cityIntro(landing.cityName, landing.categories.length)}
          </p>
        </div>

        <section aria-labelledby="city-categories" className="flex flex-col gap-4">
          <div>
            <h2 id="city-categories" className="text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">
              {dict.seo.browseTitle}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">{dict.seo.browseIntro}</p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {landing.categories.map((category) => (
              <li key={category.slug} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
                <Link
                  href={category.href}
                  className="flex items-center justify-between gap-2 rounded-sm text-base font-semibold text-ink-strong hover:text-accent"
                >
                  {category.name}
                  <span className="flex items-center gap-1 text-xs font-normal text-ink-faint">
                    {category.listings}
                    <Icon name="chevronRight" size={13} />
                  </span>
                </Link>
                {category.facets.length > 0 ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {category.facets.map((facet) => (
                      <li key={facet.slug}>
                        <Link
                          href={facet.href}
                          className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs text-ink-muted transition-colors hover:border-accent hover:text-accent"
                        >
                          {facet.name}
                          <span className="text-ink-faint">{facet.listings}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </Container>
      <JsonLd
        value={{
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: dict.seo.cityHeading(landing.cityName),
          description: dict.seo.cityIntro(landing.cityName, landing.categories.length),
          url: landing.absoluteUrl,
          mainEntity: {
            '@type': 'ItemList',
            itemListElement: landing.categories.map((category, index) => ({
              '@type': 'ListItem',
              position: index + 1,
              name: category.name,
              url: `${landing.absoluteUrl.replace(/\/$/, '')}/${category.slug}`,
            })),
          },
        }}
      />
    </>
  );
}
