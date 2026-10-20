import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { directoryJsonLdFor, directoryMetadata, directoryRender } from '@/lib/directory-server';
import { currentLocale } from '@/lib/i18n/server';
import { JsonLd } from '@/components/json-ld';
import { ProgrammaticView } from '@/components/directory-view';

/**
 * `/{city}/{category}/{facet}` (§29) — the long-tail page: a cuisine, an occasion or a district
 * inside a category. Same rule as the category page: the data plane returns `null` for a facet that
 * no listing carries, and the route answers 404 rather than showing an empty aisle.
 */

type Props = { params: Promise<{ city: string; category: string; facet: string }> };

/** See `../page.tsx`: a segment the platform cannot route is an honest 404, not a laundered miss. */
const NOT_ROUTABLE = new Set(['not_found', 'seo_route_not_found']);
async function renderOr404(city: string, category: string, facet: string, locale: string) {
  try {
    return await directoryRender(city, category, facet, locale);
  } catch (cause) {
    if (NOT_ROUTABLE.has((cause as { code?: string })?.code ?? '')) return null;
    throw cause;
  }
}

export async function generateMetadata(props: Props): Promise<Metadata | undefined> {
  const locale = await currentLocale();
  const { city, category, facet } = await props.params;
  const render = await renderOr404(decodeURIComponent(city), decodeURIComponent(category), decodeURIComponent(facet), locale);
  if (!render) return undefined;
  return directoryMetadata(render);
}

export default async function FacetPage(props: Props) {
  const locale = await currentLocale();
  const { city, category, facet } = await props.params;
  const render = await renderOr404(decodeURIComponent(city), decodeURIComponent(category), decodeURIComponent(facet), locale);
  if (!render) notFound();

  return (
    <>
      <ProgrammaticView
        page={render.page}
        facets={render.facets}
        crumbs={render.crumbs}
        title={render.title}
        intro={render.intro}
        locale={locale}
      />
      <JsonLd value={directoryJsonLdFor(render)} />
    </>
  );
}
