'use client';

import Link from 'next/link';
import { AvailabilityBadge, CardMedia, DemoBadge, Icon, PriceTag, RatingStars } from '@nexus/ui';
import { getDict, trustLabels } from '@/lib/i18n';
import type { OfferingDetail } from '@/lib/types';
import { offeringToCard } from '@/lib/adapters';
import { FactList } from './fact-list';

/**
 * Offering detail (§34): the same projections and trust components as the merchant page. Prices here
 * are the most perishable number in the product, so a stale fact renders with the "may have changed"
 * marker rather than as a live price (§20).
 */
export function OfferingView({ offering, locale }: { offering: OfferingDetail; locale: string }) {
  const dict = getDict(locale);
  const labels = trustLabels(locale);
  const card = offeringToCard(offering);

  return (
    <article className="flex flex-col gap-6">
      <nav className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Link href={`/m/${offering.merchant.slug}`} className="inline-flex items-center gap-1 text-accent hover:underline">
          <Icon name="store" size={13} />
          {offering.merchant.name}
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate">{offering.title}</span>
      </nav>

      <header className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {offering.flags.demo ? <DemoBadge labels={labels} /> : null}
            <span className="text-xs text-ink-muted">{offering.merchant.district}</span>
            {card.availability ? <AvailabilityBadge card={card} labels={labels} /> : null}
          </div>
          <h1 className="mt-2 text-2xl font-semibold leading-tight tracking-tight text-ink-strong sm:text-3xl">
            {offering.title}
          </h1>
          {offering.description ? (
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-muted">{offering.description}</p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <PriceTag card={card} labels={labels} size="lg" />
            <RatingStars card={card} labels={labels} size="md" />
          </div>
        </div>
        <CardMedia card={card} ratio="4/3" className="min-w-0 rounded-lg border border-line" />
      </header>

      {offering.highlights?.length ? (
        <section aria-labelledby="highlights-title" className="rounded-lg border border-line bg-surface p-4 shadow-xs">
          <h2 id="highlights-title" className="text-sm font-semibold text-ink-strong">
            {dict.offering.highlights}
          </h2>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink-muted">
            {offering.highlights.map((highlight) => (
              <li key={highlight} className="flex items-start gap-2">
                <Icon name="check" size={14} className="mt-0.5 shrink-0 text-positive" />
                {highlight}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label={dict.facts.title} className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-strong">{dict.facts.title}</h2>
          <span className="text-2xs text-ink-faint">{dict.facts.note}</span>
        </div>
        <div className="rounded-lg border border-line bg-surface p-4 shadow-xs">
          <FactList facts={offering.facts} locale={locale} />
        </div>
      </section>
    </article>
  );
}
