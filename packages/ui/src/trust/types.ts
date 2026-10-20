/**
 * MIRROR: docs/API_CONTRACT.md §2 (EntityCard / Fact / MatchExplanation) —
 * replace with `@nexus/types` once packages/types builds. This is the only
 * machine-readable render contract shared by consumer UI, AI output and MCP.
 *
 * It lives in `packages/ui` (not `apps/web`) because the trust renderers are the
 * enforcement point: keeping the types next to the components means the UI cannot
 * accept a shape the contract does not allow.
 *
 * JSON is snake_case on the wire ([`API_CONTRACT.md`](../../docs/API_CONTRACT.md) §1); these
 * interfaces keep the wire names verbatim so no mapping layer can drift.
 */

export type CardType = 'merchant' | 'product' | 'service' | 'experience' | 'collection';
export type FactSubjectType = 'merchant' | 'offering' | 'location' | 'review' | 'user' | 'collection';
/**
 * `demo` is a source, not a flag: synthetic seed data must arrive with its provenance stated
 * rather than being clamped to a real-world one (spec §109, §155). It ranks below `inferred`, so
 * it can never out-claim merchant- or observation-backed data in a conflict.
 */
export type FactSource = 'merchant' | 'imported' | 'observed' | 'third_party' | 'inferred' | 'demo';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Money {
  amount: string;
  currency: string;
}

export type PriceModel = 'per_person' | 'per_item' | 'per_hour' | 'per_party' | 'from' | 'free';

/** `Fact` — the trust primitive (§19). Any rendered number must resolve to one of these. */
export interface Fact {
  fact_id: string;
  subject_type: FactSubjectType;
  subject_id: string;
  /** Wire attribute names, e.g. `price`, `rating`, `business_hours`, `distance`, `availability`. */
  attribute: string;
  value: unknown;
  source: FactSource;
  confidence: number;
  observed_at: string;
  expires_at?: string | null;
  stale?: boolean | null;
}

export interface OpeningState {
  is_open: boolean;
  text?: string | null;
  opens_at?: string | null;
  closes_at?: string | null;
  as_of?: string | null;
  source_fact_id?: string | null;
}

export interface AvailabilityState {
  status: 'available' | 'limited' | 'full' | 'unknown' | 'closed';
  next_slot?: string | null;
  source_fact_id?: string | null;
}

export interface MatchExplanation {
  /** Stable machine label, e.g. `within_budget`, `closest`, `highly_rated`. */
  label: string;
  text: string;
  value?: string | number | null;
  /** HARD RULE ([`AGENT_CONTRACT.md`](../../docs/AGENT_CONTRACT.md) §4): no fact_id ⇒ the bullet must not render. */
  fact_id?: string | null;
}

export interface CardImage {
  url: string;
  alt: string;
  /** Always present for synthetic data: "synthetic" | "merchant" | creator handle. */
  credit?: string | null;
}

export interface CardPrice {
  amount: string;
  currency: string;
  model?: PriceModel | null;
}

export interface CardRating {
  value: number;
  count: number;
}

export interface CardDistance {
  meters: number;
  text?: string | null;
  travel_minutes?: number | null;
}

export interface CardAction {
  type: 'reserve' | 'add_to_cart' | 'favorite' | 'share' | 'ask_ai' | 'view_menu' | 'directions' | 'details';
  label: string;
  endpoint?: string | null;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  payload?: Record<string, unknown> | null;
}

export interface EntityFlags {
  sponsored?: boolean | null;
  demo?: boolean | null;
  unverified?: boolean | null;
  /** Offering cards only: `price_source = 'estimated'`, so the number is a guess, not a claim. */
  estimated_price?: boolean | null;
  /** Review cards only: the reviewer transacted with this merchant (§55 evidence). */
  verified_visit?: boolean | null;
}

export interface EntityCard {
  card_type: CardType;
  id: string;
  slug: string;
  title: string;
  subtitle?: string | null;
  href?: string | null;
  image?: CardImage | null;
  price?: CardPrice | null;
  rating?: CardRating | null;
  distance?: CardDistance | null;
  open?: OpeningState | null;
  availability?: AvailabilityState | null;
  geo?: GeoPoint | null;
  ai_match?: { score: number; reasons: MatchExplanation[] } | null;
  actions?: CardAction[] | null;
  /** Every rendered number must be backed by one of these ([`AGENT_CONTRACT.md`](../../docs/AGENT_CONTRACT.md) §4). */
  facts?: Fact[] | null;
  flags?: EntityFlags | null;
  /** Grouping used by the AI result interface (§36): best_match | best_value | closest | most_popular. */
  group?: string | null;
}

/** `POST /ai/v1/compare` → `{rows:[{attribute, cards:[{value, fact_id}]}]}` (§37). */
export interface CompareCell {
  value: string | number | Money | CardRating | CardDistance | OpeningState | null;
  fact_id?: string | null;
  display?: string | null;
  stale?: boolean | null;
}

export interface CompareRow {
  attribute: string;
  cards: CompareCell[];
}

export interface CompareResult {
  rows: CompareRow[];
  cards?: EntityCard[] | null;
  degraded?: boolean | null;
}

/** Faceted deterministic search response (`POST /ai/v1/search`). */
export interface SearchResponse {
  items: EntityCard[];
  facets?: Record<string, unknown> | null;
  took_ms?: number | null;
  strategy?: string | null;
  degraded?: boolean | null;
}

export interface CursorPage<T> {
  items: T[];
  next_cursor?: string | null;
  total_estimate?: number | null;
}

/** Error envelope ([`API_CONTRACT.md`](../../docs/API_CONTRACT.md) §1). */
export interface ApiErrorEnvelope {
  error: {
    code:
      | 'validation_error'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'rate_limited'
      | 'ai_unavailable'
      | 'internal'
      | string;
    message: string;
    details?: Record<string, unknown> | null;
    request_id?: string | null;
  };
}
