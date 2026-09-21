import type { EntityCard, Fact, OpeningState } from '@nexus/ui/trust/types';
import { findFact, factById, factValue, isRenderable, isStale, isUncertain, pickFact } from '@nexus/ui/trust/fact';
import type { MerchantDetail, OfferingSummary, SeoListing } from './types';
import { computeOpening } from './format';

/**
 * App-side view of the trust layer (§19, AGENT_CONTRACT §4). The primitives in @nexus/ui
 * already refuse to render an unbacked number; this module is what pages use when they need
 * the *value* server-side (meta descriptions, JSON-LD, compare rows, map tooltips) — always
 * through these helpers, never by reading `card.price` directly.
 */

export { findFact, pickFact, factById, factValue, isRenderable, isStale, isUncertain };

export interface ResolvedPrice {
  amount: string;
  currency: string;
  model: string | null;
  stale: boolean;
  uncertain: boolean;
  factId: string;
  source: Fact['source'];
}

export interface ResolvedRating {
  value: number;
  count: number;
  stale: boolean;
  factId: string;
  source: Fact['source'];
}

export interface ResolvedDistance {
  meters: number;
  travelMinutes: number | null;
  text: string | null;
  factId: string;
}

/** Price the UI may show, or `null` ⇒ render 未验证. */
export function resolvedPrice(card: Pick<EntityCard, 'price' | 'facts'>): ResolvedPrice | null {
  const fact = findFact(card as EntityCard, 'price');
  if (!fact) return null;
  const value = factValue<{ amount?: string; currency?: string }>(fact) ?? {};
  const amount = value.amount ?? card.price?.amount;
  const currency = value.currency ?? card.price?.currency ?? 'HKD';
  if (!amount) return null;
  return {
    amount,
    currency,
    model: card.price?.model ?? null,
    stale: isStale(fact),
    uncertain: isUncertain(fact),
    factId: fact.fact_id,
    source: fact.source,
  };
}

export function resolvedRating(card: Pick<EntityCard, 'rating' | 'facts'>): ResolvedRating | null {
  const fact = findFact(card as EntityCard, 'rating');
  if (!fact) return null;
  const value = factValue<{ value?: number; count?: number }>(fact) ?? {};
  const numeric = value.value ?? card.rating?.value;
  const count = value.count ?? card.rating?.count;
  if (typeof numeric !== 'number' || typeof count !== 'number') return null;
  return { value: numeric, count, stale: isStale(fact), factId: fact.fact_id, source: fact.source };
}

export function resolvedDistance(card: Pick<EntityCard, 'distance' | 'facts'>): ResolvedDistance | null {
  const fact = findFact(card as EntityCard, 'distance');
  if (!fact) return null;
  const value = factValue<{ meters?: number; travel_minutes?: number; text?: string }>(fact) ?? {};
  const meters = value.meters ?? card.distance?.meters;
  if (typeof meters !== 'number') return null;
  return {
    meters,
    travelMinutes: value.travel_minutes ?? card.distance?.travel_minutes ?? null,
    text: value.text ?? card.distance?.text ?? null,
    factId: fact.fact_id,
  };
}

/**
 * Opening state for a card: the API sends `card.open` already computed, but it is only
 * showable when it names a fact the card actually carries (no orphan claims).
 */
export function resolvedOpening(card: Pick<EntityCard, 'open' | 'facts'>): (OpeningState & { factId: string }) | null {
  const open = card.open;
  if (!open) return null;
  const fact =
    (open.source_fact_id ? factById(card as EntityCard, open.source_fact_id) : null) ??
    findFact(card as EntityCard, 'business_hours');
  if (!fact || !isRenderable(fact)) return null;
  return { ...open, source_fact_id: fact.fact_id, factId: fact.fact_id };
}

/** Which of the four trust-bearing slots on a card are backed by facts (drives the "N 项已验证" line). */
export function trustCoverage(card: EntityCard): { verified: string[]; unverified: string[] } {
  const checks: Array<[string, Fact | null]> = [
    ['price', findFact(card, 'price')],
    ['rating', findFact(card, 'rating')],
    ['distance', findFact(card, 'distance')],
    ['business_hours', findFact(card, 'business_hours')],
  ];
  return {
    verified: checks.filter(([, fact]) => fact).map(([key]) => key),
    unverified: checks.filter(([, fact]) => !fact).map(([key]) => key),
  };
}

/** A bullet is only allowed when its fact id resolves inside the same card (§4 hard rule). */
export function renderableReasons(card: EntityCard) {
  return (card.ai_match?.reasons ?? []).filter((reason) => Boolean(factById(card, reason.fact_id)));
}

/* --------------------------------------------------------------- merchant detail */

export function merchantHoursFact(merchant: MerchantDetail): Fact | null {
  return pickFact(merchant.facts, 'business_hours');
}

/** Open/closed for the merchant page — computed from the hours fact's value, never a guess. */
export function merchantOpening(merchant: MerchantDetail, instant: Date = new Date()): OpeningState | null {
  const fact = merchantHoursFact(merchant);
  if (!fact) return null;
  const hours = factValue<MerchantDetail['business_hours']>(fact);
  const source = isRenderable(fact) ? (hours?.length ? hours : merchant.business_hours) : merchant.business_hours;
  if (!source?.length) return null;
  return computeOpening(source, fact.fact_id, instant);
}

export function offeringPrice(offering: OfferingSummary): ResolvedPrice | null {
  return resolvedPrice({ price: offering.price ?? null, facts: offering.facts });
}

/** SEO listing → the two numbers a programmatic page is allowed to publish. */
export function listingNumbers(listing: SeoListing): { price: string | null; rating: number | null; reviews: number | null } {
  const price = listing.price_fact_id ? resolvedPrice({ price: listing.avg_price, facts: listing.facts }) : null;
  const rating = listing.rating_fact_id ? resolvedRating({ rating: listing.rating, facts: listing.facts }) : null;
  return {
    price: price ? `${price.currency} ${price.amount}` : null,
    rating: rating ? rating.value : null,
    reviews: rating ? rating.count : null,
  };
}
