/**
 * MIRROR: docs/API_CONTRACT.md §4 — the platform's consumer catalog reads, projected into the
 * view-models `apps/web` renders. Pure functions, no fetch, no fixtures (§130 keeps those in `lib/mock`).
 *
 * Why this module exists: `GET /api/v1/merchants/{id}` answers with a §2 `EntityCard` plus the extra
 * columns a profile needs, and the web view-model has its own field names (`name` where the card says
 * `title`, `avg_price` where it says `price`, `themes` where the summary says `praise`/`complaints`).
 * Casting one type onto the other — which is what the data plane used to do — compiles and then
 * renders blank, because `undefined` in the view is indistinguishable from "the service said none".
 *
 * Two rules hold here:
 *  1. **Copy, never fill.** Every field is either the wire's own value or its honest absence. No
 *     default currency, no synthesised rating, no padded weekday frame, no placeholder slot.
 *  2. **Convert only the conventions the wire does not share, and only here:**
 *     - weekday numbering: `business_hours.weekday` is 0=Mon…6=Sun (V1 column comment), the UI's is
 *       0=Sun…6=Sat (`WEEKDAY_LABELS`), so a row that is not converted lands on the wrong day;
 *     - the hours attribute name: stored as `opening_hours`, rendered as `business_hours`, resolved by
 *       the alias table in `@nexus/ui/trust/fact.ts` (D25);
 *     - price model: `offerings.price_model` (`from_price|hourly|fixed|…`) versus `CardPrice.model`
 *       (`from|per_hour|…`). Translated where the two mean the same thing, nulled where they do not.
 *
 * Field narrowing (`str`/`num`) is a boundary check, not decoration: the payload is external input
 * (AGENT_CONTRACT §8), so a value that is not the type the contract promises is treated as absent.
 */

import type {
  CardImage,
  CardPrice,
  CursorPage,
  EntityFlags,
  Fact,
  GeoPoint,
  OpeningState,
  PriceModel,
} from '@nexus/ui/trust/types';
import type {
  AvailabilitySlot,
  BusinessHoursDay,
  MerchantDetail,
  MerchantLocation,
  OfferingSummary,
  Review,
  ReviewSummary,
} from './types';

/* ------------------------------------------------------------------ wire shapes */

export interface WireRating {
  value?: number | null;
  count?: number | null;
}

export interface WireImage {
  url?: string | null;
  alt?: string | null;
  credit?: string | null;
}

export interface WireMtr {
  station?: string | null;
  walk_minutes?: number | null;
}

export interface WireLocation {
  location_id?: string | null;
  label?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  district?: string | null;
  city?: string | null;
  geo?: GeoPoint | null;
  mtr?: WireMtr | null;
  is_primary?: boolean | null;
}

/** One `business_hours` row: a single range at a single location, in the platform's weekday numbering. */
export interface WireHourRow {
  weekday?: number | null;
  opens_at?: string | null;
  closes_at?: string | null;
  crosses_midnight?: boolean | null;
  location_id?: string | null;
}

export interface WireCategory {
  category_id?: string | null;
  slug?: string | null;
  name?: string | null;
  name_zh?: string | null;
  kind?: string | null;
  parent_slug?: string | null;
  parent_name?: string | null;
}

export interface WireOffering {
  offering_id?: string | null;
  merchant_id?: string | null;
  kind?: string | null;
  slug?: string | null;
  name?: string | null;
  name_zh?: string | null;
  description?: string | null;
  description_zh?: string | null;
  price?: { amount?: string | null; currency?: string | null } | null;
  price_model?: string | null;
  images?: WireImage[] | null;
  rating?: WireRating | null;
  facts?: Fact[] | null;
  flags?: EntityFlags | null;
}

/** `GET /api/v1/merchants/{idOrSlug}` — §2 card fields first, then the profile extras. */
export interface WireMerchantProfile {
  card_type?: string | null;
  id?: string | null;
  slug?: string | null;
  title?: string | null;
  subtitle?: string | null;
  description?: string | null;
  /** The §2 singleton image; `images[]` below carries the same object plus the rest. */
  image?: CardImage | null;
  price?: CardPrice | null;
  rating?: WireRating | null;
  open?: OpeningState | null;
  facts?: Fact[] | null;
  flags?: EntityFlags | null;
  district?: string | null;
  city?: string | null;
  category?: string | null;
  categories?: WireCategory[] | null;
  price_band?: string | null;
  /** The merchant's own contact block; `phone` is merchant-level, not per location. */
  contact?: { phone?: string | null; site?: string | null; email?: string | null; data_origin?: string | null } | null;
  images?: WireImage[] | null;
  locations?: WireLocation[] | null;
  business_hours?: WireHourRow[] | null;
  top_offerings?: WireOffering[] | null;
  review_summary?: WireReviewSummary | null;
}

export interface WireReview {
  review_id?: string | null;
  author?: { user_id?: string | null; display_name?: string | null } | null;
  rating?: number | null;
  title?: string | null;
  body?: string | null;
  helpful_count?: number | null;
  verified_purchase?: boolean | null;
  verified_reservation?: boolean | null;
  created_at?: string | null;
  flags?: EntityFlags | null;
}

/** One `review_summaries.praise` / `.complaints` bullet: V1 stores `[{label, evidence_count, review_ids}]`. */
export interface WireSummaryPoint {
  label?: string | { zh?: string | null; en?: string | null } | null;
  evidence_count?: number | null;
  review_ids?: string[] | null;
}

export interface WireReviewSummary {
  merchant_id?: string | null;
  overall?: number | null;
  praise?: WireSummaryPoint[] | null;
  complaints?: WireSummaryPoint[] | null;
  sample_size?: number | null;
  model?: string | null;
  generated_at?: string | null;
  evidence_review_ids?: string[] | null;
  text?: string | null;
  flags?: EntityFlags | null;
}

/** One `availability_slots` row as §4 reads it. The slot row is its own evidence: `fact_id` is null. */
export interface WireSlot {
  id?: string | null;
  pool_id?: string | null;
  pool?: { name?: string | null; kind?: string | null; capacity?: number | null } | null;
  starts_at?: string | null;
  ends_at?: string | null;
  capacity_total?: number | null;
  capacity_left?: number | null;
}

export interface WireAvailability {
  slots?: WireSlot[] | null;
  party_size?: number | null;
}

export interface WirePage<T> {
  items?: T[] | null;
  next_cursor?: string | null;
  total_estimate?: number | null;
}

/* ------------------------------------------------------------------- primitives */

function str(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
}

function num(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function money(value: { amount?: string | null; currency?: string | null } | null | undefined): CardPrice | null {
  const amount = str(value?.amount);
  const currency = str(value?.currency);
  // A number with no currency is not a price, and guessing HKD here would be the §19 failure.
  return amount && currency ? { amount, currency } : null;
}

/** `offerings.price_model` → the `CardPrice.model` vocabulary; ambiguous values render as no model. */
const PRICE_MODEL_BY_COLUMN: Record<string, PriceModel> = {
  from_price: 'from',
  per_person: 'per_person',
  per_item: 'per_item',
  per_party: 'per_party',
  hourly: 'per_hour',
  free: 'free',
};

function priceModel(value: string | null | undefined): PriceModel | null {
  const key = str(value);
  return key ? PRICE_MODEL_BY_COLUMN[key] ?? null : null;
}

/**
 * Images the card type can represent: `CardImage` requires a `url` and an `alt`, and an empty `alt`
 * would be a fabricated description for a screen reader, so an unlabelled image drops out.
 */
function images(list: WireImage[] | null | undefined): CardImage[] {
  const out: CardImage[] = [];
  for (const image of list ?? []) {
    const url = str(image?.url);
    const alt = str(image?.alt);
    if (!url || !alt) continue;
    out.push({ url, alt, credit: str(image.credit) });
  }
  return out;
}

function offeringPrice(offering: WireOffering): CardPrice | null {
  const base = money(offering.price);
  if (!base) return null;
  const model = priceModel(offering.price_model);
  return model ? { ...base, model } : base;
}

/* --------------------------------------------------------------- the projections */

/** §4 menu / `top_offerings` row → `OfferingSummary`. `merchant` names the listing the row belongs to. */
export function offeringFrom(
  offering: WireOffering,
  merchant?: { id: string; slug: string; name: string } | null,
): OfferingSummary | null {
  const id = str(offering.offering_id);
  const slug = str(offering.slug);
  if (!id || !slug) return null;
  const kind = str(offering.kind);
  const title = str(offering.name_zh) ?? str(offering.name);
  if (!title) return null;
  return {
    id,
    slug,
    title,
    kind: kind === 'service' || kind === 'experience' ? kind : 'product',
    description: str(offering.description_zh) ?? str(offering.description),
    price: offeringPrice(offering),
    image: images(offering.images)[0] ?? null,
    merchant: merchant ?? null,
    facts: offering.facts ?? [],
    flags: offering.flags ?? {},
  };
}

/**
 * `business_hours` rows → the seven-slot UI frame, in the UI's own weekday numbering.
 *
 * Only the days the wire actually describes are emitted: a merchant with no Friday row may be closed
 * on Friday or may simply never have reported it, and `closed: true` would pick one of those
 * (§19 "unknown is not cheap", and here it is not closed either). Rows are scoped to the primary
 * location because a branch's hours are not the profile's hours.
 */
export function businessHoursFrom(
  rows: WireHourRow[] | null | undefined,
  locations: WireLocation[] | null | undefined,
): BusinessHoursDay[] {
  const list = rows ?? [];
  const primary = (locations ?? []).find((location) => location?.is_primary === true);
  const primaryId = str(primary?.location_id);
  const own = primaryId
    ? list.filter((row) => {
        const location = str(row?.location_id);
        return location === null || location === primaryId;
      })
    : list;
  const dayRows = own.length ? own : list;

  const byUiWeekday = new Map<number, BusinessHoursDay['ranges']>();
  for (const row of dayRows) {
    const platformDay = num(row?.weekday);
    const open = str(row?.opens_at);
    const close = str(row?.closes_at);
    if (platformDay === null || platformDay < 0 || platformDay > 6 || !open || !close) continue;
    // 0=Mon…6=Sun on the column, 0=Sun…6=Sat in `WEEKDAY_LABELS`.
    const weekday = (platformDay + 1) % 7;
    byUiWeekday.set(weekday, [
      ...(byUiWeekday.get(weekday) ?? []),
      { open, close, crosses_midnight: row.crosses_midnight === true },
    ]);
  }

  const days: BusinessHoursDay[] = [];
  for (const [weekday, ranges] of byUiWeekday) {
    days.push({ weekday, ranges: ranges?.slice().sort((a, b) => a.open.localeCompare(b.open)) ?? null });
  }
  return days.sort((a, b) => a.weekday - b.weekday);
}

function locationsFrom(list: WireLocation[] | null | undefined, phone: string | null): MerchantLocation[] {
  const out: MerchantLocation[] = [];
  for (const location of list ?? []) {
    const id = str(location?.location_id);
    const address = str(location?.address_line1);
    const district = str(location?.district);
    const city = str(location?.city);
    const geo = location?.geo;
    if (!id || !address || !district || !city || !geo) continue;
    const line2 = str(location.address_line2);
    const station = str(location.mtr?.station);
    const walk = num(location.mtr?.walk_minutes);
    out.push({
      id,
      name: str(location.label) ?? district,
      address: line2 ? `${address}, ${line2}` : address,
      district,
      city,
      geo: { lat: geo.lat, lng: geo.lng },
      mtr: station && walk !== null ? { station, walk_minutes: walk } : null,
      // The wire has no per-location phone; `contact.phone` is the merchant's, so it is only shown
      // against the primary location rather than repeated onto every branch.
      phone: location.is_primary === true ? phone : null,
    });
  }
  return out;
}

/** §4 profile → the merchant page view-model. Throws on a payload with no id or no name: see `data.ts`. */
export function merchantDetailFrom(profile: WireMerchantProfile): MerchantDetail {
  const id = str(profile.id);
  const slug = str(profile.slug);
  const name = str(profile.title);
  if (!id || !slug || !name) {
    throw new Error('merchant_profile_incomplete: a §4 profile must carry id, slug and title');
  }
  const rating = profile.rating;
  const ratingValue = num(rating?.value);
  const ratingCount = num(rating?.count);
  const merchant = { id, slug, name };
  const priceBand = str(profile.price_band);
  const categories = (profile.categories ?? [])
    .map((category) => str(category?.name))
    .filter((category): category is string => category !== null);
  const primary = str(profile.category);

  return {
    id,
    slug,
    name,
    // `subtitle` is 「類別 · 地區」, which the header already shows as the category badge; promoting it
    // into a tagline would present a derived label as merchant-authored copy.
    tagline: null,
    description: str(profile.description),
    category: primary ?? categories[0] ?? '',
    cuisine: categories.filter((category) => category !== primary),
    price_band: priceModel(profile.price?.model),
    avg_price: money(profile.price),
    rating: ratingValue !== null && ratingCount !== null ? { value: ratingValue, count: ratingCount } : null,
    images: images(profile.images),
    locations: locationsFrom(profile.locations, str(profile.contact?.phone)),
    business_hours: businessHoursFrom(profile.business_hours, profile.locations),
    top_offerings: (profile.top_offerings ?? []).flatMap((offering) => {
      const view = offeringFrom(offering, merchant);
      return view ? [view] : [];
    }),
    review_summary: reviewSummaryFrom(profile.review_summary),
    facts: profile.facts ?? [],
    flags: profile.flags ?? {},
    attributes: priceBand ? { price_band: [priceBand] } : undefined,
  };
}

export function reviewFrom(review: WireReview): Review | null {
  const id = str(review.review_id);
  if (!id) return null;
  const title = str(review.title);
  const body = str(review.body);
  return {
    review_id: id,
    author: { display_name: str(review.author?.display_name) ?? '' },
    rating: num(review.rating) ?? 0,
    // The title is the reviewer's own summary of the text below it; dropping it would lose the only
    // thing most short reviews say, and joining them keeps both as quoted content.
    text: title && body ? `${title}：${body}` : (body ?? title ?? ''),
    created_at: str(review.created_at) ?? '',
    helpful_count: num(review.helpful_count) ?? 0,
    verified_reservation: review.verified_reservation === true,
    verified_purchase: review.verified_purchase === true,
    flags: review.flags ?? {},
  };
}

function pointTheme(point: WireSummaryPoint, sentiment: ReviewSummary['themes'][number]['sentiment']) {
  const label =
    typeof point?.label === 'string'
      ? str(point.label)
      : (str(point?.label?.zh) ?? str(point?.label?.en));
  const reviewIds = (point?.review_ids ?? []).filter((id): id is string => typeof id === 'string');
  const mentions = num(point?.evidence_count);
  if (!label || mentions === null) return null;
  return { label, sentiment, mentions, review_ids: reviewIds };
}

/**
 * §4 review summary → the §55 view-model. The platform stores praise/complaint bullets and no
 * narrative (`text` is null), so `summary` stays null and the panel renders the bullets with their
 * evidence count — composing a sentence here would be the web writing the copy §55 reserves for the
 * model, and every sentence in that block must trace to review ids.
 */
export function reviewSummaryFrom(summary: WireReviewSummary | null | undefined): ReviewSummary | null {
  if (!summary) return null;
  const themes = [
    ...(summary.praise ?? []).map((point) => pointTheme(point, 'positive')),
    ...(summary.complaints ?? []).map((point) => pointTheme(point, 'negative')),
  ].filter((theme): theme is NonNullable<typeof theme> => theme !== null);
  const evidence = (summary.evidence_review_ids ?? [])
    .concat(themes.flatMap((theme) => theme.review_ids))
    .filter((id, index, all) => all.indexOf(id) === index);
  const generatedAt = str(summary.generated_at);
  if (!generatedAt) return null;
  return {
    summary: str(summary.text),
    themes,
    evidence_review_ids: evidence,
    generated_at: generatedAt,
    model: str(summary.model),
    facts: null,
    flags: summary.flags ?? {},
  };
}

/**
 * Canonical slot rows → the strip's `AvailabilitySlot`. `status` is a display threshold over the
 * two capacity columns the row carries, not a third claim: a pool that is not full is "limited" once
 * less than half of it is left.
 */
export function slotsFrom(availability: WireAvailability | null | undefined): AvailabilitySlot[] {
  const out: AvailabilitySlot[] = [];
  for (const slot of availability?.slots ?? []) {
    const id = str(slot?.id);
    const startsAt = str(slot?.starts_at);
    const total = num(slot.capacity_total) ?? num(slot.pool?.capacity);
    const left = num(slot.capacity_left);
    const partySize = num(availability?.party_size) ?? total;
    if (!id || !startsAt || total === null || left === null || partySize === null) continue;
    out.push({
      slot_id: id,
      starts_at: startsAt,
      party_size: partySize,
      status: left <= 0 ? 'full' : left * 2 <= total ? 'limited' : 'available',
      remaining: left,
    });
  }
  return out;
}

/** A §4 cursor page of rows → the same page of view-models, with unreadable rows dropped. */
export function pageFrom<T, S>(page: WirePage<T> | null | undefined, map: (item: T) => S | null): CursorPage<S> {
  const items = (page?.items ?? []).flatMap((item) => {
    const view = map(item);
    return view === null ? [] : [view];
  });
  return { items, next_cursor: str(page?.next_cursor), total_estimate: num(page?.total_estimate) };
}
