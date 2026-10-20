/**
 * MIRROR: docs/API_CONTRACT.md §2 (EntityCard / Fact / MatchExplanation) and §7 (SSE + Intent) —
 * replace with `@nexus/types` once packages/types builds. The render-contract half is re-exported
 * from @nexus/ui (the enforcement point); everything here is the payload types for endpoints that
 * the UI reads but does not render directly.
 *
 * Kept byte-for-byte compatible with the contract: snake_case keys, nullable optional fields,
 * ISO-8601 strings for timestamps, `money` as string decimal + currency code.
 */

export type {
  ApiErrorEnvelope,
  AvailabilityState,
  CardAction,
  CardDistance,
  CardImage,
  CardPrice,
  CardRating,
  CardType,
  CompareCell,
  CompareResult,
  CompareRow,
  CursorPage,
  EntityCard,
  EntityFlags,
  Fact,
  FactSource,
  FactSubjectType,
  GeoPoint,
  MatchExplanation,
  Money,
  OpeningState,
  PriceModel,
  SearchResponse,
} from '@nexus/ui/trust/types';

import type { CardImage, CardPrice, EntityCard, EntityFlags, Fact, GeoPoint, PriceModel } from '@nexus/ui/trust/types';

/* ------------------------------------------------------------------ Intent (§7.1) */

export type IntentKind =
  | 'discover_merchant'
  | 'discover_offering'
  | 'reserve'
  | 'purchase'
  | 'ask_merchant'
  | 'compare'
  | 'plan_experience'
  | 'unknown';

export interface IntentLocation {
  type: 'district' | 'address' | 'landmark' | 'near_me' | 'city';
  value: string | null;
  resolved?: GeoPoint | null;
  radius_m?: number | null;
}

export interface IntentTime {
  type: 'explicit' | 'relative' | 'none';
  starts_at?: string | null;
  ends_at?: string | null;
}

export interface IntentBudget {
  min: number | null;
  max: number | null;
  currency: string;
  per: 'party' | 'person' | 'item';
}

export interface IntentPreference {
  key: string;
  value: string;
  polarity: 1 | -1;
}

export interface IntentConstraint {
  key: string;
  value: string;
}

export interface Intent {
  raw_query: string;
  intent: IntentKind;
  category: string | null;
  location: IntentLocation | null;
  time: IntentTime | null;
  budget: IntentBudget | null;
  party_size: number | null;
  preferences: IntentPreference[];
  constraints: IntentConstraint[];
  sort_preference: 'relevance' | 'distance' | 'price_low' | 'rating' | 'trending';
  urgency: 'now' | 'today' | 'normal' | 'flexible';
  language: string;
  confidence: Record<string, number>;
  /** §8 — fields the model deliberately did not guess; the UI asks in one follow-up. */
  unknowns: string[];
}

export interface SearchContext {
  geo?: GeoPoint | null;
  now?: string;
  locale?: string;
  party_size?: number | null;
  conversation_id?: string | null;
  session_id?: string | null;
}

/* --------------------------------------------------------- SSE stream (§7 events) */

export type StreamStage = 'understanding' | 'searching' | 'comparing' | 'summarizing' | 'done';

export interface StreamStatusEvent {
  stage: StreamStage | string;
  text: string;
}

export interface StreamResultsEvent {
  set_id: string;
  items: EntityCard[];
}

export interface StreamSummaryEvent {
  text: string;
  citations: string[];
}

export interface StreamDoneEvent {
  agent_run_id: string;
  latency_ms: number;
  cost_usd: number;
  degraded: boolean;
  provider?: 'mock' | 'anthropic' | 'openai' | string | null;
}

export interface StreamErrorEvent {
  code: string;
  message: string;
  request_id?: string | null;
}

/* ------------------------------------------------------------------ Merchant (§4) */

export interface BusinessHourRange {
  open: string;
  close: string;
  crosses_midnight?: boolean | null;
}

export interface BusinessHoursDay {
  weekday: number;
  closed?: boolean | null;
  ranges?: BusinessHourRange[] | null;
}

export interface MerchantLocation {
  id: string;
  name?: string | null;
  address: string;
  district: string;
  city: string;
  geo: GeoPoint;
  mtr?: { station: string; walk_minutes: number } | null;
  phone?: string | null;
}

export interface MerchantDetail {
  id: string;
  slug: string;
  name: string;
  tagline?: string | null;
  description?: string | null;
  /** `''` when the service sent no category at all: the view must test it, not assume a badge. */
  category: string;
  cuisine?: string[] | null;
  price_band?: PriceModel | null;
  avg_price: { amount: string; currency: string } | null;
  rating: { value: number; count: number } | null;
  images: CardImage[];
  locations: MerchantLocation[];
  business_hours: BusinessHoursDay[];
  top_offerings: OfferingSummary[];
  review_summary: ReviewSummary | null;
  facts: Fact[];
  flags: EntityFlags;
  links?: Array<{ type: string; url: string; label: string }> | null;
  attributes?: Record<string, string[]> | null;
}

export interface OfferingSummary {
  id: string;
  slug: string;
  title: string;
  kind: 'product' | 'service' | 'experience';
  description?: string | null;
  /** The card's own price shape: `model` is absent whenever the service did not state one. */
  price: CardPrice | null;
  image?: CardImage | null;
  merchant?: { id: string; slug: string; name: string } | null;
  facts: Fact[];
  flags: EntityFlags;
}

export type OfferingDetail = OfferingSummary & {
  merchant: { id: string; slug: string; name: string; district: string; geo: GeoPoint };
  highlights?: string[] | null;
  availability?: EntityCard['availability'] | null;
  rating?: { value: number; count: number } | null;
};

export interface Review {
  review_id: string;
  author: { display_name: string; avatar_url?: string | null };
  rating: number;
  text: string;
  created_at: string;
  helpful_count: number;
  verified_reservation?: boolean | null;
  verified_purchase?: boolean | null;
  flags: EntityFlags;
}

/** §55 — every sentence in the AI summary points at review ids as evidence. */
export interface ReviewSummary {
  /** The narrative line; `null` when the service sent only bullets, and the panel renders the bullets. */
  summary: string | null;
  themes: Array<{ label: string; sentiment: 'positive' | 'negative' | 'neutral'; mentions: number; review_ids: string[] }>;
  evidence_review_ids: string[];
  generated_at: string;
  model?: 'mock' | 'anthropic' | 'openai' | string | null;
  facts?: Fact[] | null;
  flags: EntityFlags;
}

export interface AvailabilitySlot {
  slot_id: string;
  starts_at: string;
  party_size: number;
  status: 'available' | 'limited' | 'full';
  remaining?: number | null;
}

/* --------------------------------------------------------------- Growth (§8) */

export interface Collection {
  slug: string;
  title: string;
  description: string;
  city: string;
  category?: string | null;
  /** Nullable because `collections.cover_url` is nullable: an uncredited photo must not gain a photographer. */
  cover_image: { url: string; alt: string; credit: string | null } | null;
  /** `model` = a named model version; `ai` = the platform's own AI curator, and both stay disclosed (§30). */
  curated_by: { type: 'editorial' | 'creator' | 'model' | 'ai'; name: string };
  items: EntityCard[];
  updated_at: string;
  flags: { demo?: boolean };
}

export interface Guide {
  slug: string;
  title: string;
  description: string;
  city: string;
  category: string;
  body_blocks: Array<
    | { type: 'paragraph'; text: string }
    | { type: 'heading'; text: string }
    | { type: 'list'; items: string[] }
    | { type: 'cards'; title: string; items: EntityCard[] }
  >;
  generated_by: 'ai' | 'editor' | 'creator';
  reviewed_by_human: boolean;
  published_at: string;
  updated_at: string;
  flags: { demo?: boolean };
}

/* --------------------------------------------------------------- Account (§3) */

export interface User {
  id: string;
  email: string;
  display_name: string;
  locale: string;
  avatar_url?: string | null;
  created_at: string;
  demo?: boolean;
  memberships?: Array<{ role: string; merchant_id?: string | null }> | null;
}

/** §32/§33 — preference memory is user-owned: viewable, editable, deletable. */
export interface UserPreference {
  id: string;
  key: string;
  value: string;
  scope: 'session' | 'long_term';
  source: 'declared' | 'inferred' | 'explicit_feedback';
  confidence: number;
  updated_at: string;
  used_by_ranking: boolean;
}

export interface Favorite {
  id: string;
  subject_type: 'merchant' | 'offering' | 'collection';
  subject_id: string;
  card: EntityCard;
  created_at: string;
}

export interface SavedSearch {
  id: string;
  query: string;
  intent: Intent;
  notify: boolean;
  created_at: string;
  result_count_estimate: number | null;
}

export interface OrderLine {
  offering_id: string;
  title: string;
  quantity: number;
  unit_price: { amount: string; currency: string };
  stale?: boolean;
}

export interface Order {
  id: string;
  code: string;
  status: 'pending_payment' | 'paid' | 'confirmed' | 'completed' | 'cancelled' | 'refunded';
  lines: OrderLine[];
  total: { amount: string; currency: string };
  created_at: string;
  merchant_name: string;
  demo?: boolean;
}

export interface Reservation {
  id: string;
  code: string;
  merchant_id: string;
  merchant_name: string;
  slot_start: string;
  party_size: number;
  status: 'requested' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show';
  notes?: string | null;
  created_at: string;
  demo?: boolean;
}

export interface AppNotification {
  id: string;
  type: 'reservation_confirmed' | 'price_drop' | 'new_review_reply' | 'guide_published' | 'system';
  title: string;
  body: string;
  href?: string | null;
  read_at: string | null;
  created_at: string;
}

export interface MeProfile {
  user: User;
  preferences: UserPreference[];
  favorites: Favorite[];
  saved_searches: SavedSearch[];
  orders: Order[];
  reservations: Reservation[];
  notifications: AppNotification[];
  personalization: { enabled: boolean; signals_used: number; last_updated_at: string | null };
}

/* ------------------------------------------------------------------- SEO (§29) */

export interface SeoListing {
  slug: string;
  name: string;
  district: string;
  category: string;
  subcategory: string | null;
  avg_price: { amount: string; currency: string } | null;
  rating: { value: number; count: number } | null;
  price_fact_id: string | null;
  rating_fact_id: string | null;
  facts: Fact[];
  demo: boolean;
}

export interface ProgrammaticPage {
  city: string;
  category: string;
  subcategory: string | null;
  heading: string;
  intro: string;
  listings: SeoListing[];
  cards: EntityCard[];
  /**
   * `under_budget_hkd` is the ceiling `under_budget_count` was counted against. It travels with the
   * count so the page can state it — a caption of "affordable" invented in the view would be a claim
   * the data never made (§19).
   */
  facets: {
    open_now_count: number;
    under_budget_count: number;
    under_budget_hkd: number;
    districts: string[];
    price_range: { min: number; max: number } | null;
  };
  updated_at: string;
  indexable: boolean;
  /**
   * The §30 verdict's machine-readable cause, enumerated in API_CONTRACT §8. The consumer view does not
   * narrate it (a shopper does not need "below_quality_bar"), but the type carries the whole set so a live
   * payload never fails to decode, and `reason` is what an operator column will bind to later.
   */
  reason: 'enough_listings' | 'too_few_listings' | 'below_quality_bar' | 'not_published' | 'unreviewed_ai';
}

/* ------------------------------------------------------------------ BFF result */

export interface NexusResult<T> {
  data: T;
  /** true when the payload came from `src/lib/mock` (NEXT_PUBLIC_DATA_MODE=mock). */
  mocked: boolean;
  /** §105: the stream failed and we served the deterministic endpoint instead. */
  degraded?: boolean;
  degradedReason?: string | null;
  requestId?: string | null;
}
