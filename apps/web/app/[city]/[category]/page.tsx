import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { directoryJsonLdFor, directoryMetadata, directoryRender } from '@/lib/directory-server';
import { currentLocale } from '@/lib/i18n/server';
import { JsonLd } from '@/components/json-ld';
import { ProgrammaticView } from '@/components/directory-view';

/** `/{city}/{category}` — see `app/[city]/page.tsx` for why these pages exist at all (§29/§30). */

type Props = { params: Promise<{ city: string; category: string }> };

/**
 * A directory segment the platform cannot route is a real 404 (§8 "never an empty 200"), but the
 * live read throws when the platform answers with a not-found code that isn't the §1 `not_found`
 * token — `data.ts` only maps `not_found` to `null`. Translate that not-found family to `null`
 * (→ `notFound()`) so a non-routable route stays an honest 404; anything else (an unreachable
 * service, a 5xx) is re-thrown so a genuine fault is never laundered into a clean-looking miss.
 */
const NOT_ROUTABLE = new Set(['not_found', 'seo_route_not_found']);
async function renderOr404(city: string, category: string, locale: string) {
  try {
    return await directoryRender(city, category, null, locale);
  } catch (cause) {
    if (NOT_ROUTABLE.has((cause as { code?: string })?.code ?? '')) return null;
    throw cause;
  }
}

export async function generateMetadata(props: Props): Promise<Metadata | undefined> {
  const locale = await currentLocale();
  const { city, category } = await props.params;
  const render = await renderOr404(decodeURIComponent(city), decodeURIComponent(category), locale);
  if (!render) return undefined;
  return directoryMetadata(render);
}

export default async function CategoryPage(props: Props) {
  const locale = await currentLocale();
  const { city, category } = await props.params;
  const render = await renderOr404(decodeURIComponent(city), decodeURIComponent(category), locale);
  // A pair outside the grammar is a 404, not an empty page: `/hong-kong/nonsense` must not resolve.
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
