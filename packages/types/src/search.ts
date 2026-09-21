/**
 * Search, recommendation and comparison payloads.
 *
 * Contracts: API_CONTRACT §7 (`POST /ai/v1/search`, `/recommend`, `/compare`, `/rag/retrieve`),
 * AGENT_CONTRACT §6 (hybrid search + ranking, sponsored separation, explanations).
 * Spec: §13 Hybrid Search, §17 Recommendation System, §18 Recommendation Explanation,
 * §36 AI Result Interface, §37 Comparison, §115 Search Result Types.
 */

import type { FACET_KIND, RANKING_FACTOR, SEARCH_STRATEGY } from "./enums.js";
import type {
  FilterMap,
  GeoBoundingBox,
  GeoPoint,
  IsoDateTime,
  PageRequest,
  Paginated,
  Slug,
  Uuid,
} from "./common.js";
import type { CardAction, EntityCard, RecommendationSlot } from "./card.js";
import type { FactRef, MatchExplanation } from "./fact.js";
import type { Intent, RequestContext } from "./intent.js";

/** `facets[].kind` — API_CONTRACT §7. */
export type FacetType = (typeof FACET_KIND)[number];
/** Ranking weight names — AGENT_CONTRACT §6 `score = w_relevance*rel + …`; config `infra/config/ranking_weights.yaml`. */
export type RankingFactorName = (typeof RANKING_FACTOR)[number];
/** Strategy ids, versioned into `recommendation_sets.strategy` (AGENT_CONTRACT §6, V1 line 594). */
export type StrategyId = (typeof SEARCH_STRATEGY)[number];

/**
 * `POST /ai/v1/search` request. **Source: API_CONTRACT §7**
 * (`{intent, geo?, filters?, limit}`), deterministic path — must work with no LLM at all
 * (API §1 failure ladder, DECISIONS D4).
 */
export interface SearchQuery {
  /** Understood intent driving the query — API §7. If null the service re-understands `raw_query`. */
  intent: Intent | null;
  /** Origin for distance/geo scoring; only present with consent (AGENT_CONTRACT §1). */
  geo?: GeoPoint | null;
  /** Explicit filter map (district, category, open_now, max_price) — API §4 query params. */
  filters?: FilterMap;
  /** Page size, 1..100; API §1 default 20. */
  limit?: number;
  /** Cursor for the next page — API §1 cursor pagination. */
  cursor?: string | null;
  /** Forced strategy for A/B or eval runs; null = router choice. */
  strategy?: StrategyId | null;
  /** Minimum relevance score to include; below the floor candidates are dropped before scoring (AGENT_CONTRACT §6). */
  relevance_floor?: number | null;
  /** Include sponsored slots at all (false = organic only, spec §66). */
  allow_sponsored?: boolean;
  /** Requesting session for feedback/personalisation joins — API §7 `/ai/v1/feedback`. */
  session_id?: string | null;
  /** Conversation to merge state from — API §7. */
  conversation_id?: Uuid | null;
  /** Context passed through to ranking personalisation (spec §33). */
  context?: Partial<RequestContext>;
}

/** One facet value bucket. Source: API_CONTRACT §7 `{…, facets, …}`. */
export interface FacetValue {
  /** Bucket key — snake_case / slug. */
  value: string;
  /** Localised label. */
  label: string;
  /** Count of matching results in this bucket. */
  count: number;
  /** Selected in the current query. */
  selected?: boolean;
  /** Lower bound for range facets. */
  min?: number | string | null;
  /** Upper bound for range facets. */
  max?: number | string | null;
}

/** A facet group (category, district, price band, open now). Source: API_CONTRACT §7. */
export interface Facet {
  /** Facet field name, snake_case — maps to a `SearchQuery.filters` key. */
  field: string;
  /** Aggregation kind. */
  kind: FacetType;
  /** Display label. */
  label: string;
  /** Ordered buckets; may be empty when nothing matches (valid empty state, DECISIONS D6). */
  values: FacetValue[];
  /** Total distinct values before truncation. */
  total_values?: number;
}

/**
 * `POST /ai/v1/search` response. **Source: API_CONTRACT §7**
 * (`{items:EntityCard[], facets, took_ms, strategy, degraded:false}`).
 */
export interface SearchResponse {
  /** Result cards; `[]` is a valid designed empty state. */
  items: EntityCard[];
  /** Aggregations for the filter rail. */
  facets: Facet[];
  /** Server-side elapsed milliseconds — API §7 `took_ms`, NFR §11 (p95 < 250ms warm). */
  took_ms: number;
  /** Strategy actually used, versioned — AGENT_CONTRACT §6. */
  strategy: StrategyId | (string & {});
  /**
   * True when the AI path degraded to deterministic search (API §1 failure ladder, §7 SSE
   * `done` event). North-star fulfilment only counts `degraded=false` intents (AGENT §10).
   */
  degraded: boolean;
  /** Total matches estimated server-side; null when the backend cannot estimate — API §1. */
  total_estimate: number | null;
  /** Cursor for the next page — API §1. */
  next_cursor: string | null;
  /** Set id for feedback attribution — API §7 `/ai/v1/recommend` `set_id`. */
  set_id?: Uuid | null;
  /** Echo of the understood intent, so the client can render "we understood X". */
  intent?: Intent | null;
  /** Applied ranking weights snapshot, for the transparency badge (spec §108). */
  weights?: Partial<Record<RankingFactorName, number>>;
  /** Warnings for the caller (e.g. `geo_precision_coarse`), never user-facing chain of thought (spec §116). */
  warnings?: string[];
}

/** One ranked item inside a persisted recommendation set. Source: V1 `recommendation_sets.items` (line 595). */
export interface RecommendationItem {
  /** What is being recommended. */
  subject_type: string;
  /** Subject row id — V1 items `subject_id`. */
  subject_id: Uuid;
  /** 0-based organic rank before sponsored insertion — AGENT_CONTRACT §6. */
  rank: number;
  /** 0..1 organic score; never a function of spend (spec §67). */
  score: number;
  /** Explanation bullets, each traceable — V1 items `explanations[]`, AGENT §4. */
  explanations: MatchExplanation[];
  /** Fact ids backing the item — V1 items `fact_ids[]`. */
  fact_ids: Uuid[];
  /** Optional slot label (spec §36 "Best match / Best value / Closest / Most popular"). */
  slot?: RecommendationSlot | null;
  /** Rendered card, when the set is returned inline (API §7 `/ai/v1/recommend`). */
  card?: EntityCard | null;
  /** True for a promoted slot inserted after organic scoring (AGENT_CONTRACT §6). */
  sponsored?: boolean;
}

/**
 * A persisted recommendation set. **Source: API_CONTRACT §7**
 * (`POST /ai/v1/recommend` → `{set_id, items:EntityCard[]}` with explanations + fact ids),
 * table V1 `recommendation_sets` (lines 587-598).
 */
export interface RecommendationSet {
  /** Set id — API §7 `set_id` / V1 `recommendation_sets.id`. */
  set_id: Uuid;
  /** Cards in display order (sponsored already inserted) — API §7 `items`. */
  items: EntityCard[];
  /** Machine-readable ranking rows, mirroring V1 `items jsonb`. */
  ranked?: RecommendationItem[];
  /** Intent snapshot the set was computed from — V1 `intent jsonb`. */
  intent: Intent | null;
  /** Query text — V1 `query`. */
  query?: string | null;
  /** Strategy + weights version — V1 `strategy`, AGENT §6. */
  strategy: StrategyId | (string & {});
  /** Tenant scope — V1 `tenant_id`. */
  tenant_id?: Uuid | null;
  /** Personalised-for user; null for anonymous — V1 `user_id`. */
  user_id?: Uuid | null;
  /** Owning conversation — V1 `conversation_id`. */
  conversation_id?: Uuid | null;
  /** Compute latency — V1 `latency_ms`. */
  latency_ms?: number | null;
  /** Server-generated summary text with citations — API §7 SSE `summary`. */
  summary?: string | null;
  /** Citations for the summary — API §7 `citations:[fact_id…]`. */
  citations?: FactRef[];
  /** Whether the set degraded to deterministic search — API §7. */
  degraded?: boolean;
  /** Creation instant — V1 `created_at`. */
  created_at?: IsoDateTime;
}

/** A comparison row: one attribute across N subjects. **Source: API_CONTRACT §7** `POST /ai/v1/compare`
 * (`{rows:[{attribute, cards:[{value,fact_id}]}]}`), spec §37 (Price/Rating/Distance/Opening/Match). */
export interface CompareRow {
  /** Attribute key being compared, snake_case — e.g. `price`, `rating`, `distance`, `opening`, `match`. */
  attribute: string;
  /** Localised row header. */
  label?: string;
  /** One cell per compared subject, in request order. */
  cards: CompareCell[];
  /** Which cell is "best" on this row (index into {@link cards}); null when not comparable. */
  best_index?: number | null;
  /** True when the row's values are estimates rather than facts (AGENT_CONTRACT §4). */
  estimated?: boolean;
}

/** One comparison cell. Source: API_CONTRACT §7 `/ai/v1/compare` — `{value, fact_id}`. */
export interface CompareCell {
  /** Display value; null when the subject has no value for this attribute — spec §37 shows blank cells, never a fabricated one. */
  value: string | number | null;
  /** Backing fact — API §7. Renderer drops the cell when null (AGENT_CONTRACT §4). */
  fact_id: Uuid | null;
  /** Subject the cell belongs to. */
  subject_id?: Uuid | null;
  /** Structured value behind `value` (e.g. Money) when the UI needs it. */
  detail?: Record<string, unknown> | null;
  /** Highlight the winning cell. */
  is_best?: boolean;
}

/**
 * Comparison table. **Source: API_CONTRACT §7 `POST /ai/v1/compare`**, spec §37 —
 * "所有数据必须来自真实来源".
 */
export interface CompareTable {
  /** Ordered subject ids — API §7 `subject_ids`. */
  subject_ids: Uuid[];
  /** Card headers, same order as {@link subject_ids}. */
  subjects: EntityCard[];
  /** Attribute rows — API §7 `rows`. */
  rows: CompareRow[];
  /** Set id for feedback joins — V1 `feedback_events.subject_id`. */
  set_id?: Uuid | null;
  /** Conversation that requested the table. */
  conversation_id?: Uuid | null;
  /** Strategy label for the transparency badge (spec §108). */
  strategy?: string | null;
  /** Generated header text (spec §36 AI summary, not chain of thought). */
  summary?: string | null;
}

/** `POST /ai/v1/compare` request body (API_CONTRACT §7). */
export interface CompareRequest {
  /** Subjects to compare, 2..N — API §7 `subject_ids`. */
  subject_ids: Uuid[];
  /** Optional attributes to restrict the table to. */
  attributes?: string[];
  /** Context for distance/opening computation — API §7. */
  context?: Partial<RequestContext>;
}

/** A retrieved chunk. **Source: API_CONTRACT §7 `POST /ai/v1/rag/retrieve`**
 * (`{chunks:[{id,text,score,document_id,source_uri,fact_ids}]}`), table V1 `chunks` (513-533). */
export interface RetrievedChunk {
  /** Chunk row id — V1 `chunks.id`. */
  id: Uuid;
  /** Chunk text — **untrusted content**, wrap in the data envelope (AGENT_CONTRACT §7/§8). */
  text: string;
  /** Similarity/rerank score, 0..1 — API §7 `score`. */
  score: number;
  /** Parent document — V1 `chunks.document_id`; kept so answers can cite (AGENT §7). */
  document_id: Uuid;
  /** Citable location of the source — V1 `documents.source_uri`. */
  source_uri: string | null;
  /** Facts extractable from this chunk — API §7 `fact_ids`. */
  fact_ids: Uuid[];
  /** Merchant scope of the chunk — V1 `chunks.merchant_id`; always filtered before ranking (AGENT §7). */
  merchant_id?: Uuid | null;
  /** Position within the document — V1 `chunks.ordinal`. */
  ordinal?: number;
  /** Section header, when section-aware chunking found one — V1 `chunks.section`. */
  section?: string | null;
  /** Token count — V1 `chunks.token_count`; chunk target 240-400 tokens (AGENT §7). */
  token_count?: number | null;
  /** Embedding model tag — V1 `chunks.embed_model`; dim is fixed at 1024 (DECISIONS D3). */
  embed_model?: string | null;
}

/** `POST /ai/v1/rag/retrieve` request (API_CONTRACT §7). */
export interface RetrieveRequest {
  /** Natural-language query. */
  query: string;
  /** Restrict to one merchant — required on the merchant-agent path (AGENT_CONTRACT §7). */
  merchant_id?: Uuid | null;
  /** Extra filters (`kind`, `lang`) — V1 `documents.kind`. */
  filters?: FilterMap;
  /** How many chunks to return; rerank window is top-40 (AGENT_CONTRACT §7). */
  top_k?: number;
  /** Drop chunks scoring below this — AGENT §7 "No answer without retrieval". */
  min_score?: number;
}

/** Retrieval response wrapper. Source: API_CONTRACT §7. */
export interface RetrieveResponse {
  /** Ranked chunks. */
  chunks: RetrievedChunk[];
  /** Elapsed milliseconds. */
  took_ms?: number;
  /** True when the caller must say "I don't know" and offer handoff (AGENT_CONTRACT §7). */
  below_threshold?: boolean;
  /** Strategy/version tag for eval tracing. */
  strategy?: string | null;
}

/** Public merchant list query — **API_CONTRACT §4** `GET /api/v1/merchants?district=&category=&max_price=&open_now=&rating=&cursor=`. */
export interface MerchantListQuery extends PageRequest {
  /** District slug/text — V1 `locations.district`. */
  district?: string;
  /** Category slug — V1 `merchants.category_primary`. */
  category?: string;
  /** Max average price in tenant currency — V1 `merchants.avg_price_hkd`. */
  max_price?: number;
  /** Only currently-open merchants (computed, never guessed — API §2 OpeningState). */
  open_now?: boolean;
  /** Minimum aggregate rating — V1 `merchants.rating_agg`. */
  rating?: number;
  /** Free-text keyword. */
  q?: string;
  /** Bbox for map-scoped lists — API §4 `/locations/geo?bbox=`. */
  bbox?: GeoBoundingBox;
}

/** Marker-cluster payload row for `GET /api/v1/locations/geo` (API_CONTRACT §4). */
export interface GeoMarker {
  /** Location id — V1 `locations.id`. */
  id: Uuid;
  /** Merchant the pin points at. */
  merchant_id: Uuid;
  /** Merchant slug for the link — V1 `merchants.slug`. */
  slug: Slug | null;
  /** Pin coordinate — V1 `locations.lat/lng numeric(9,6)`. */
  lat: number;
  /** @see lat */
  lng: number;
  /** Aggregate count when the marker represents a cluster at low zoom — API §4 "marker clustering payload". */
  count?: number;
  /** Card-lite title for the popup. */
  title?: string;
  /** Compact CTA list for the popup (spec §38 Maps). */
  actions?: CardAction[];
}

/** Re-exported for convenience so callers can type a paged list of any entity. */
export type EntityCardPage = Paginated<EntityCard>;
