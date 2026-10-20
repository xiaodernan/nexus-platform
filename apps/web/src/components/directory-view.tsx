import Link from 'next/link';
import { Badge, Container, Icon } from '@nexus/ui';

import { formatDateTime, formatNumber } from '@/lib/format';
import { getDict } from '@/lib/i18n';
import type { DirectoryCrumb, DirectoryFacets } from '@/lib/directory';
import type { ProgrammaticPage } from '@/lib/types';
import { CardGrid } from './cards';
import { LocaleDemoBadge } from './locale-badges';

/**
 * The programmatic SEO pages (§29/§30), rendered on the server: whatever a crawler fetches has to be
 * in the HTML, not in a hydration effect.
 *
 * The panel of numbers is what separates a page with value from a city name dropped into a template
 * (§30 forbids the second one): each figure is counted from the listings on the page, and when the
 * count is too low to compare anything the page says so out loud instead of padding itself.
 */

export function Breadcrumbs({ items }: { items: DirectoryCrumb[] }) {
  return (
    <nav aria-label="breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
        {items.map((item, index) => (
          <li key={item.label} className="flex items-center gap-1.5">
            {index > 0 ? <Icon name="chevronRight" size={12} /> : null}
            {item.href ? (
              <Link href={item.href} className="rounded-sm hover:text-accent hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className="text-ink-muted">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="text-sm font-semibold text-ink-strong">{value}</dd>
    </div>
  );
}

export function FacetPanel({ facets, updatedAt, locale }: { facets: DirectoryFacets; updatedAt: string; locale: string }) {
  const dict = getDict(locale);
  const when = formatDateTime(updatedAt, locale);
  return (
    <section
      aria-labelledby="directory-facets"
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <h2 id="directory-facets" className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        {dict.seo.facetsTitle}
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label={dict.seo.listingsLabel} value={formatNumber(facets.listings, locale)} />
        <Stat label={dict.seo.openNowLabel} value={formatNumber(facets.openNow, locale)} />
        <Stat label={dict.seo.underBudgetLabel(facets.budgetHkd)} value={formatNumber(facets.underBudget, locale)} />
        <Stat
          label={dict.seo.priceRangeLabel}
          value={facets.priceRange ? dict.seo.priceRange(facets.priceRange.min, facets.priceRange.max) : '—'}
        />
      </dl>
      {facets.districts.length > 0 ? (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          <span className="font-medium text-ink-faint">{dict.seo.districtsLabel}</span>
          {facets.districts.map((district) => (
            <Badge key={district} tone="neutral" size="sm">
              {district}
            </Badge>
          ))}
        </p>
      ) : null}
      <p className="flex items-center gap-1.5 text-2xs text-ink-faint">
        <Icon name="clock" size={12} />
        {dict.seo.updatedLabel}
        {when ? `: ${when}` : ''}
      </p>
    </section>
  );
}

export function ProgrammaticView({
  page,
  facets,
  crumbs,
  title,
  intro,
  locale,
}: {
  page: ProgrammaticPage;
  facets: DirectoryFacets;
  crumbs: DirectoryCrumb[];
  title: string;
  intro: string;
  locale: string;
}) {
  const dict = getDict(locale);
  return (
    <Container size="shell" className="flex flex-col gap-7 py-8 sm:py-12">
      <div className="flex flex-col gap-3">
        <Breadcrumbs items={crumbs} />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-4xl">{title}</h1>
          {page.listings.some((listing) => listing.demo) ? <LocaleDemoBadge locale={locale} /> : null}
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-muted sm:text-base">{intro}</p>
        {!page.indexable ? (
          <div className="flex flex-col gap-1 rounded-lg border border-warning/70 bg-warning-soft px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-warning">
              <Icon name="warning" size={14} />
              {dict.seo.thinTitle}
            </span>
            <p className="text-xs leading-relaxed text-ink-muted">
              {dict.seo.thinText} {dict.seo.noIndexNote}
            </p>
          </div>
        ) : null}
      </div>

      <FacetPanel facets={facets} updatedAt={page.updated_at} locale={locale} />

      <section aria-labelledby="directory-listings" className="flex flex-col gap-4">
        <h2 id="directory-listings" className="text-xl font-semibold tracking-tight text-ink-strong sm:text-2xl">
          {dict.seo.listingsTitle}
        </h2>
        {page.cards.length > 0 ? (
          <CardGrid cards={page.cards} locale={locale} />
        ) : (
          <p className="text-sm text-ink-muted">{dict.states.empty}</p>
        )}
      </section>
    </Container>
  );
}
