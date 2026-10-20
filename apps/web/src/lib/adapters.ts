/**
 * Wire-type projections shared by server pages and client components.
 *
 * These are deliberately *not* in `@nexus/ui` (which owns the contract, not the mapping) and not in
 * `lib/mock` (which is the server-side data plane and must never be imported by a client bundle).
 * A projection only ever copies fields the source object already carries — it cannot invent a price,
 * rating or open state, so the fact lookup inside `@nexus/ui` still decides what renders (§19).
 */

import type { EntityCard, OpeningState } from '@nexus/ui/trust/types';
import { computeOpening, factOf } from './format';
import type { MerchantDetail, OfferingSummary } from './types';

/** The detail endpoint carries two extra fields the summary does not; both are optional so one projection serves both. */
export function offeringToCard(
  offering: OfferingSummary & { rating?: EntityCard['rating']; availability?: EntityCard['availability'] },
): EntityCard {
  return {
    card_type: offering.kind === 'service' ? 'service' : offering.kind === 'experience' ? 'experience' : 'product',
    id: offering.id,
    slug: offering.slug,
    title: offering.title,
    subtitle: offering.merchant?.name ?? null,
    href: `/o/${offering.slug}`,
    image: offering.image ?? null,
    price: offering.price ?? null,
    rating: offering.rating ?? null,
    availability: offering.availability ?? null,
    facts: offering.facts ?? null,
    flags: offering.flags ?? null,
  };
}

/**
 * The merchant page renders through the same card components as search results, so the detail is
 * projected rather than re-implemented — otherwise the page would get its own, weaker trust rules.
 */
export function merchantToCard(detail: MerchantDetail, instant: Date = new Date()): EntityCard {
  const hours = factOf({ facts: detail.facts }, 'business_hours');
  const open: OpeningState | null = computeOpening(detail.business_hours, hours?.fact_id ?? null, instant);
  const location = detail.locations[0];
  const image = detail.images[0];
  return {
    card_type: 'merchant',
    id: detail.id,
    slug: detail.slug,
    title: detail.name,
    subtitle: detail.tagline ?? detail.category,
    href: `/m/${detail.slug}`,
    image: image ? { url: image.url, alt: image.alt, credit: image.credit } : null,
    price: detail.avg_price ? { amount: detail.avg_price.amount, currency: detail.avg_price.currency, model: detail.price_band ?? null } : null,
    rating: detail.rating ?? null,
    open,
    geo: location?.geo ?? null,
    facts: detail.facts ?? null,
    flags: detail.flags ?? null,
  };
}
