/**
 * Merchant profile, locations, opening hours, catalog (offerings) and the merchant workspace.
 *
 * Contracts: API_CONTRACT §4 (public merchant reads), §5 (workspace + required permissions),
 * §5.1 (AI import pipeline). Tables: V1 `merchants` (79-114), `locations` (153-175),
 * `business_hours` (178-189), `categories` (191-207), `offerings` (211-261),
 * `resource_pools` (265-275), `availability_slots` (277-292), `api_keys` (141-151),
 * `merchant_users` (116-125), `documents` (493-511).
 * Spec: §21 Merchant Onboarding, §22 AI Merchant Import, §23 Merchant Dashboard,
 * §38 Maps, §40 Reservation Architecture, §47-§49 tenancy/RBAC, §56 Analytics, §107 data ownership, §112 HK addressing.
 */

import type {
  DataOrigin,
  MembershipPlan,
  MerchantStatus,
  MerchantUserRole,
  OfferingKind,
  OfferingStatus,
  PermissionName,
  PriceModel,
  PriceSource,
  ResourcePoolKind,
} from "./enums.js";
import type {
  ContactInfo,
  GeoPoint,
  ImageAsset,
  IsoDateTime,
  LocalizedName,
  Money,
  Nullable,
  Price,
  RatingInfo,
  Slug,
  SocialsMap,
  Timestamps,
  Uuid,
} from "./common.js";
import type { OpeningState } from "./fact.js";

/* enum unions used below are declared in enums.ts */

/**
 * A merchant/location address in HK convention. **Source: V1 `locations` (155-171)**,
 * AGENT_CONTRACT §12 ("addresses use district/area + MTR proximity"), spec §112.
 */
export interface AddressInfo {
  /** Street line 1 — V1 `address_line1` (NOT NULL). */
  address_line1: string;
  /** Street line 2 — V1 `address_line2`. */
  address_line2: string | null;
  /** District name, e.g. `Sha Tin` — V1 `district`. */
  district: string | null;
  /** Area code `NT|KLN|HKI` — V1 `area`. */
  area: string | null;
  /** City — V1 `city` (NOT NULL). */
  city: string;
  /** Postcode; HK often has none — V1 `postcode`. */
  postcode: string | null;
  /** Nearest MTR station — V1 `mtr_station`. */
  mtr_station: string | null;
  /** Walk minutes from the MTR exit — V1 `mtr_walk_min`. */
  mtr_walk_min: number | null;
  /** Coordinate — V1 `lat/lng numeric(9,6)`. */
  point: GeoPoint;
}

/** A merchant location row. **Source: V1 `locations`, API_CONTRACT §4** (`GET /merchants/{id_or_slug}` returns "profile + locations + hours"). */
export interface MerchantLocation extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Owning merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Tenant — V1 `tenant_id` (NOT NULL). */
  tenant_id: Uuid;
  /** Optional label (`「新世紀廣場店」`) — V1 `label`. */
  label: string | null;
  /** Address block. */
  address: AddressInfo;
  /** Primary flag — V1 `is_primary` default true. */
  is_primary: boolean;
  /** Free-form geo properties (floor, entrance, accessibility) — V1 `geo_properties jsonb`. */
  geo_properties: Record<string, unknown>;
}

/** One weekly opening window. **Source: V1 `business_hours` (178-189)**; TTL 24h (AGENT §5). */
export interface BusinessHour {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Location the row applies to; null = all locations — V1 `location_id`. */
  location_id: Uuid | null;
  /** 0 = Monday .. 6 = Sunday — V1 `weekday smallint` comment. */
  weekday: number;
  /** Opening wall-clock time — V1 `opens_at time`. */
  opens_at: string;
  /** Closing wall-clock time — V1 `closes_at time`. */
  closes_at: string;
  /** True when `closes_at` is after midnight — V1 `crosses_midnight`. */
  crosses_midnight: boolean;
  /** Provenance of the hours — V1 `source` default `merchant`; feeds the fact layer (AGENT §4). */
  source: string;
  /** Last change — V1 `updated_at`; recompute trigger "merchant edit" (AGENT §5). */
  updated_at?: IsoDateTime;
  /** Fact id backing the computed {@link OpeningState} — API §2. */
  source_fact_id?: Uuid | null;
}

/** A category node. Source: V1 `categories` (191-201), spec §115. */
export interface Category {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant; null = global catalog — V1 `tenant_id` comment. */
  tenant_id: Uuid | null;
  /** Slug — V1 `slug`. */
  slug: Slug;
  /** English name — V1 `name`. */
  name: string;
  /** Traditional Chinese name — V1 `name_zh`. */
  name_zh: string | null;
  /** Parent for hierarchy — V1 `parent_id`. */
  parent_id: Uuid | null;
  /** `merchant|product|service|experience` — V1 `kind`. */
  kind: string;
  /** Manual ordering — V1 `sort_order`. */
  sort_order: number;
  /** Child nodes when the catalog is returned as a tree. */
  children?: Category[];
}

/**
 * An offering (product / service / experience). **Source: V1 `offerings` (211-247)**, surfaced by
 * `GET /api/v1/merchants/{id}/menu` (API §4) and `POST/PATCH/DELETE /api/v1/merchant/offerings`
 * (API §5, permission `write_products`). One table for all three kinds so the universal cart can
 * hold anything (spec §41).
 */
export interface Offering extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid;
  /** `product|service|experience` — V1 `kind`. */
  kind: OfferingKind;
  /** Catalog node — V1 `category_id`. */
  category_id: Uuid | null;
  /** Unique per merchant — V1 `UNIQUE (merchant_id, slug)`. */
  slug: Slug;
  /** Name pair — V1 `name` / `name_zh`. */
  name: LocalizedName;
  /** Description pair — V1 `description` / `description_zh`. Untrusted content (AGENT §8). */
  description: LocalizedName | null;
  /**
   * Primary price. Null when the merchant never published one — the card must then omit price
   * rather than invent it (DECISIONS D6). V1 `price_amount numeric(12,2)`.
   */
  price: Nullable<Money>;
  /** How to read {@link price} — V1 `price_model`. */
  price_model: PriceModel;
  /** Range lower bound — V1 `price_min`. */
  price_min: Nullable<Money>;
  /** Range upper bound — V1 `price_max`. */
  price_max: Nullable<Money>;
  /** Price provenance — V1 `price_source` (`merchant|imported|observed|estimated`). */
  price_source: PriceSource;
  /** Drives the 6h price TTL — V1 `price_updated_at`, AGENT §5. */
  price_updated_at: IsoDateTime;
  /** Stock left; null = untracked — V1 `stock_quantity` comment. */
  stock_quantity: Nullable<number>;
  /** Stock TTL is 15m — V1 `stock_updated_at`, AGENT §5. */
  stock_updated_at: IsoDateTime | null;
  /** Reservable/bookable — V1 `bookable`; spec §40. */
  bookable: boolean;
  /** Party bounds — V1 `min_party_size` / `max_party_size`. */
  min_party_size: Nullable<number>;
  /** @see min_party_size */
  max_party_size: Nullable<number>;
  /** Duration in minutes — V1 `duration_minutes`. */
  duration_minutes: Nullable<number>;
  /** Gallery — V1 `images jsonb`. */
  images: ImageAsset[];
  /** Structured attributes (`cuisine`, `spicy_level`, `accessibility`, `season`) — V1 `attributes jsonb`. */
  attributes: Record<string, unknown>;
  /** Hard constraints (`{"no_pork":true}`) — V1 `constraints jsonb`. */
  constraints: Record<string, unknown>;
  /** Variant/add-on definitions — V1 `options jsonb`. */
  options: OfferingOption[];
  /** `draft|active|archived|out_of_stock` — V1 `status`. */
  status: OfferingStatus;
  /** Popularity component of the organic score — V1 `popularity_score`, AGENT §6. */
  popularity_score: number;
  /** Aggregate rating — V1 `rating_agg`. */
  rating: RatingInfo;
  /** Relations (`related_to|upsell|bundle|belongs_to`) — V1 `offering_relations` (255-261). */
  relations?: OfferingRelation[];
  /** Fact ids backing every number above (API §2 renderer contract). */
  facts?: Uuid[];
}

/** A variant or add-on. Source: V1 `offerings.options jsonb`; consumed by `POST /carts/items` `options` (API §6). */
export interface OfferingOption {
  /** Stable key — snake_case. */
  key: string;
  /** Localised label. */
  label: LocalizedName;
  /** `single|multi|text|number` — free-form, validated by the platform. */
  type: string;
  /** Selectable values. */
  choices: Array<{ value: string; label: LocalizedName; price_delta: Nullable<Money>; default?: boolean }>;
  /** Whether a value is required. */
  required?: boolean;
}

/** Relation between two offerings — V1 `offering_relations` (255-261). */
export interface OfferingRelation {
  /** Other side — V1 `to_offering`. */
  to_offering: Uuid;
  /** `related_to|upsell|bundle|belongs_to` — V1 `relation`. */
  relation: string;
  /** Strength 0..1 — V1 `weight`. */
  weight: number;
}

/**
 * Public merchant profile. **Source: API_CONTRACT §4** (`GET /api/v1/merchants/{id_or_slug}` →
 * "profile + locations + hours + top offerings + review summary"), V1 `merchants` (79-114).
 */
export interface MerchantProfile extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid;
  /** Public slug — V1 `slug`, `UNIQUE (tenant_id, slug)`. */
  slug: Slug;
  /** Registered business name — V1 `legal_name`. */
  legal_name: string;
  /** Display name pair — V1 `display_name` / `display_name_zh`. */
  display_name: LocalizedName;
  /** Long description (untrusted, AGENT §8) — V1 `description`. */
  description: string | null;
  /** Denormalised primary category for listing speed — V1 `category_primary` comment. */
  category_primary: string | null;
  /** All category ids — V1 `merchant_categories` (203-207). */
  categories: Category[];
  /** `draft|pending_review|published|suspended` — V1 `status`; only `published` may be searched (AGENT §1). */
  status: MerchantStatus;
  /** Verified ownership badge — V1 `ownership_verified`; surfaced as `flags.unverified` on cards (API §2). */
  ownership_verified: boolean;
  /** Row provenance; `demo` must be badged in the UI — V1 `data_origin`, DECISIONS D6. */
  data_origin: DataOrigin;
  /** Contact block — V1 `contact jsonb`. */
  contact: ContactInfo;
  /** Social profiles — V1 `socials jsonb`. */
  socials: SocialsMap;
  /** Average price per person — V1 `avg_price_hkd numeric(10,2)`; null when unpublished. */
  avg_price: Nullable<Money>;
  /** Coarse band `$|$$|$$$|$$$$` — V1 `price_band`. */
  price_band: string | null;
  /** Aggregate rating — V1 `rating_agg` / `review_count`. */
  rating: RatingInfo;
  /** Popularity component — V1 `popularity_score`; never a function of spend (spec §67). */
  popularity_score: number;
  /** Tag chips — V1 `tags text[]`. */
  tags: string[];
  /** Structured attributes (`quiet_ambience`, `kid_friendly`, `mtr_within_5min`) — V1 `attributes jsonb`. */
  attributes: Record<string, unknown>;
  /** Gallery — V1 `images jsonb`. */
  images: ImageAsset[];
  /** SEO metadata — V1 `seo jsonb`, spec §29. */
  seo: Record<string, unknown>;
  /** Whether the merchant's own AI agent answers (API §5 `/ai-agent/config`, spec §24). */
  ai_agent_enabled: boolean;
  /** Subscription tier; must not affect organic rank (spec §65/§67). */
  plan: MembershipPlan;
  /** Locations with addresses + coordinates — API §4. */
  locations: MerchantLocation[];
  /** Weekly hours per location — API §4. */
  business_hours: BusinessHour[];
  /** Computed open/closed verdict — API §2 `OpeningState`; never guessed. */
  open: OpeningState | null;
  /** Top offerings preview — API §4 "top offerings". */
  top_offerings: Offering[];
  /** AI review summary with `review_ids` evidence — API §4 `/reviews/summary`, spec §55. */
  review_summary?: unknown | null;
}

/** A reservable resource pool (tables, rooms, treatment rooms…). **Source: V1 `resource_pools` (265-275)**, spec §40. */
export interface ResourcePool {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Offering the pool belongs to; null = house-level — V1 `offering_id`. */
  offering_id: Uuid | null;
  /** `table|room|seat|treatment_room|class_slot|ticket` — V1 `kind`. */
  kind: ResourcePoolKind;
  /** Display name — V1 `name`. */
  name: string;
  /** Seats/units in the pool — V1 `capacity`. */
  capacity: number;
  /** Pool attributes (window seat, private room) — V1 `attributes jsonb`. */
  attributes: Record<string, unknown>;
  /** `active|inactive` — V1 `status` default `active`. */
  status: string;
}

/** A bookable slot. **Source: V1 `availability_slots` (277-292)**; TTL 0 — real-time (AGENT §5), no-cache endpoint (API §4). */
export interface AvailabilitySlot {
  /** Row id — required by `POST /api/v1/reservations` `slot_id` (API §6). */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Pool — V1 `pool_id`. */
  pool_id: Uuid | null;
  /** Window start (UTC) — V1 `starts_at`; CHECK `ends_at > starts_at`. */
  starts_at: IsoDateTime;
  /** Window end (UTC) — V1 `ends_at`. */
  ends_at: IsoDateTime;
  /** Total capacity — V1 `capacity_total`. */
  capacity_total: number;
  /** Remaining capacity; the value the UI shows as "有位" — V1 `capacity_left`. */
  capacity_left: number;
  /** Slot surcharge/price; null = priced by offering — V1 `price_amount`. */
  price: Nullable<Money>;
  /** Provenance — V1 `source` default `merchant`. */
  source: string;
  /** Recomputed on every request — V1 `updated_at`. */
  updated_at: IsoDateTime;
  /** Backing fact for the rendered number (AGENT §4). */
  fact_id?: Uuid | null;
}

/** Response of `GET /api/v1/merchants/{id}/availability?starts_at&ends_at&party_size` (API_CONTRACT §4). */
export interface AvailabilityResponse {
  /** Merchant the window was queried for. */
  merchant_id: Uuid;
  /** Echoed window start. */
  starts_at: IsoDateTime;
  /** Echoed window end. */
  ends_at: IsoDateTime;
  /** Echoed party size; null when the caller did not state one (never defaulted, spec §8). */
  party_size: Nullable<number>;
  /** Slots with capacity; `[]` is a real answer (DECISIONS D6). */
  slots: AvailabilitySlot[];
  /** Computed open state over the window — API §2. */
  open: OpeningState | null;
  /** Always `null` — availability is never cached (API §11 no-store, AGENT §5). */
  cached_at: null;
  /** Whether the answer is degraded (e.g. the merchant's live source timed out). */
  degraded?: boolean;
}

/* --------------------------------------------------------------------------------------------
 * Merchant workspace (API_CONTRACT §5)
 * ------------------------------------------------------------------------------------------ */

/** `POST /api/v1/merchant/businesses` + `PATCH …/{id}` body (API §5, permission `write_profile`, spec §21). */
export interface MerchantProfileInput {
  /** Registered legal name — V1 `legal_name`. */
  legal_name: string;
  /** Display name — V1 `display_name`. */
  display_name: string;
  /** Optional Traditional-Chinese display name — V1 `display_name_zh`. */
  display_name_zh?: string | null;
  /** Description — V1 `description`. */
  description?: string | null;
  /** Primary category slug — V1 `category_primary`. */
  category_primary?: string | null;
  /** Category ids — V1 `merchant_categories`. */
  category_ids?: Uuid[];
  /** Contact block — V1 `contact`. */
  contact?: ContactInfo;
  /** Socials — V1 `socials`. */
  socials?: SocialsMap;
  /** Average price in tenant currency — V1 `avg_price_hkd`. */
  avg_price?: Nullable<number>;
  /** Price band — V1 `price_band`. */
  price_band?: string | null;
  /** Tags — V1 `tags`. */
  tags?: string[];
  /** Attributes — V1 `attributes`. */
  attributes?: Record<string, unknown>;
  /** Images — V1 `images`. */
  images?: ImageAsset[];
  /** Primary location. */
  location?: Partial<MerchantLocation> & { address: Partial<AddressInfo> };
  /** Weekly hours. */
  business_hours?: Array<Partial<BusinessHour>>;
  /** Toggle the merchant AI agent — V1 `ai_agent_enabled`, API §5 `configure_ai`. */
  ai_agent_enabled?: boolean;
  /** SEO overrides — V1 `seo`. */
  seo?: Record<string, unknown>;
}

/** `POST …/verification` payload (API_CONTRACT §5, permission `write_profile`, spec §21/§53). */
export interface VerificationSubmission {
  /** Merchant being verified. */
  merchant_id: Uuid;
  /** Business registration number, licence ids, documents — stored as references, never secrets (spec §131). */
  documents?: Array<{ kind: string; name: string; uri: string | null }>;
  /** Free-text note to the reviewer. */
  note?: string | null;
}

/** One row of `POST /api/v1/merchant/offerings/bulk` (API §5, permission `write_products`). */
export interface OfferingInput {
  /** @see Offering.kind */
  kind: OfferingKind;
  /** @see Offering.slug */
  slug?: Slug;
  /** @see Offering.name */
  name: string;
  /** @see Offering.name */
  name_zh?: string | null;
  /** @see Offering.description */
  description?: string | null;
  /** @see Offering.description */
  description_zh?: string | null;
  /** @see Offering.price */
  price?: Nullable<Money>;
  /** @see Offering.price_model */
  price_model?: PriceModel;
  /** @see Offering.price_min/max */
  price_min?: Nullable<number>;
  /** @see Offering.price_min/max */
  price_max?: Nullable<number>;
  /** @see Offering.price_source */
  price_source?: PriceSource;
  /** @see Offering.stock_quantity */
  stock_quantity?: Nullable<number>;
  /** @see Offering.bookable */
  bookable?: boolean;
  /** @see Offering.min_party_size */
  min_party_size?: Nullable<number>;
  /** @see Offering.max_party_size */
  max_party_size?: Nullable<number>;
  /** @see Offering.duration_minutes */
  duration_minutes?: Nullable<number>;
  /** @see Offering.images */
  images?: ImageAsset[];
  /** @see Offering.attributes */
  attributes?: Record<string, unknown>;
  /** @see Offering.constraints */
  constraints?: Record<string, unknown>;
  /** @see Offering.options */
  options?: OfferingOption[];
  /** Category slug or id — resolved by the platform. */
  category?: string | null;
}

/** `POST /api/v1/merchant/imports` request. **Source: API_CONTRACT §5.1** (verbatim body), spec §22. */
export interface ImportRequest {
  /** Target merchant — API §5.1 `merchant_id`. */
  merchant_id: Uuid;
  /** Where to crawl. `type` is `url` in the §5.1 example. */
  source: { type: ImportSourceTypeValue; value: string };
  /** Uploaded files as base64 (`{"name":"menu.pdf","content_base64":"..."}`) — API §5.1. */
  files?: Array<{ name: string; content_base64: string; mime_type?: string }>;
}

/** Literal of `IMPORT_SOURCE_TYPE` in `enums.ts`. */
export type ImportSourceTypeValue = "url" | "file" | "menu_pdf" | "spreadsheet" | "pos_export";

/** `POST /imports` → `202 {job_id, status:"queued"}` (API_CONTRACT §5.1). */
export interface ImportJobAccepted {
  /** Job id — API §5.1. */
  job_id: Uuid;
  /** Always `queued` on accept — API §5.1. */
  status: "queued";
}

/** A proposed offering from the import pipeline. **Source: API_CONTRACT §5.1**
 * (`proposals: [{offering_draft, evidence_fact_ids, confidence}]`) — "Nothing is published
 * without merchant review", spec §22. */
export interface ImportProposal {
  /** Draft row, pre-persistence — API §5.1 `offering_draft`. */
  offering_draft: OfferingInput & { name_zh?: string | null };
  /** Facts extracted from the source document — API §5.1 `evidence_fact_ids`. */
  evidence_fact_ids: Uuid[];
  /** 0..1 extraction confidence; `< 0.6` must be visibly flagged (AGENT §4). */
  confidence: number;
  /** Document the proposal came from — V1 `documents.id`. */
  document_id?: Uuid | null;
  /** Source page/row reference for the review UI — V1 `documents.source_uri`. */
  source_ref?: string | null;
  /** Merchant decision, filled on review; null until acted (spec §22). */
  decision?: Nullable<"accepted" | "rejected" | "edited">;
}

/** Poll result of `GET /api/v1/merchant/imports/{job_id}` (API_CONTRACT §5.1). */
export interface ImportJob {
  /** Job id. */
  job_id: Uuid;
  /** Pipeline state — API §5.1 async pipeline (crawl → parse → clean → chunk → embed → classify). */
  status: ImportJobStatusValue;
  /** Merchant — API §5.1. */
  merchant_id: Uuid;
  /** Progress 0..1 when the pipeline reports it. */
  progress?: Nullable<number>;
  /** Current pipeline stage. */
  stage?: string | null;
  /** Proposed offerings awaiting review. */
  proposals: ImportProposal[];
  /** Documents created by the crawl — V1 `documents.id`. */
  document_ids?: Uuid[];
  /** Non-fatal issues (unparseable rows, low-confidence extraction). */
  warnings?: string[];
  /** Failure detail when `status` is `failed`. */
  error?: string | null;
  /** Timing bookkeeping. */
  created_at?: IsoDateTime;
  /** @see created_at */
  finished_at?: IsoDateTime | null;
}

/** Literal of `IMPORT_JOB_STATUS` in `enums.ts`. */
export type ImportJobStatusValue =
  | "queued"
  | "crawling"
  | "parsing"
  | "classifying"
  | "completed"
  | "failed"
  | "cancelled";

/** Membership row for `GET /api/v1/merchant/members` (API §5, permission `admin_members`, spec §48). */
export interface MerchantMember {
  /** Row id — V1 `merchant_users.id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** User — V1 `user_id`. */
  user_id: Uuid;
  /** Display name for the roster UI. */
  display_name: string | null;
  /** Email for the invite line. */
  email: string | null;
  /** Role — V1 `role` (`owner|admin|manager|staff|marketing|analyst|ai_agent`). */
  role: MerchantUserRole;
  /** Membership state — V1 `status`. */
  status: string;
  /** Effective permissions after grant resolution (AGENT §8). */
  permissions: PermissionName[];
  /** Joined — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** `POST /api/v1/merchant/members` body (API §5). */
export interface MerchantMemberInvite {
  /** Invite by email (existing user is looked up). */
  email: string;
  /** Role to grant — V1 `merchant_users.role`. */
  role: MerchantUserRole;
  /** Explicit permission list; omit to take the role default (spec §49). */
  permissions?: PermissionName[];
  /** Grant expiry — V1 `permission_grants.expires_at`, AGENT §8. */
  expires_at?: IsoDateTime | null;
}

/** `POST /api/v1/merchant/api-keys` response. **Source: API_CONTRACT §5** (permission `admin_members`, spec §46). */
export interface ApiKeyRecord {
  /** Row id — V1 `api_keys.id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Label — V1 `name`. */
  name: string;
  /** Display prefix, e.g. `nx_live_ab12` — V1 `prefix`. The secret itself is shown once at creation. */
  prefix: string;
  /** Scopes — V1 `scopes text[]`. */
  scopes: string[];
  /** Plaintext secret, returned **only** by the create call (V1 stores `key_hash`). */
  secret?: string | null;
  /** Last use — V1 `last_used_at`. */
  last_used_at: IsoDateTime | null;
  /** Revocation — V1 `revoked_at`; null while live. */
  revoked_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** `POST /api/v1/merchant/ai-agent/config` body (API §5, permission `configure_ai`, spec §24). */
export interface MerchantAgentConfig {
  /** Merchant being configured. */
  merchant_id: Uuid;
  /** Master switch — V1 `merchants.ai_agent_enabled`. */
  enabled: boolean;
  /** Tone/persona for generated replies (localised, AGENT §12). */
  persona?: string | null;
  /** Topics the agent may answer; anything else hands off (spec §26). */
  allowed_topics?: string[];
  /** Topics it must never answer (refunds, legal) — spec §24, AGENT §8. */
  blocked_topics?: string[];
  /** Confidence floor below which the agent hands off — AGENT §1 `customer_service`. */
  handoff_threshold?: number;
  /** Whether the agent may create reservations — needs `create_reservation` grant (AGENT §8). */
  can_reserve?: boolean;
  /** Whether the agent may quote prices from the KB. */
  can_quote_price?: boolean;
  /** Escalation contact shown on handoff — V1 `merchants.contact`. */
  escalation_contact?: ContactInfo | null;
  /** Knowledge-base document ids the agent may retrieve — V1 `documents.merchant_id`. */
  knowledge_base_ids?: Uuid[];
}

/** `GET /api/v1/merchant/dashboard/overview` (API §5, permission `read_analytics`, spec §23). */
export interface MerchantDashboardOverview {
  /** Merchant the numbers belong to. */
  merchant_id: Uuid;
  /** Instant the aggregate was computed. */
  as_of: IsoDateTime;
  /** Impressions from `events.name='view'` — V1 `v_merchant_funnel.views`. */
  views: number;
  /** `events.name='click'` — V1 `v_merchant_funnel.clicks`. */
  clicks: number;
  /** `reserve|cart_add` — V1 `v_merchant_funnel.actions`. */
  actions: number;
  /** Confirmed/completed reservations — V1 `v_merchant_funnel.reservations`. */
  reservations: number;
  /** Non-cancelled orders — V1 `v_merchant_funnel.orders`. */
  orders: number;
  /** Revenue excluding cancelled/refunded — V1 `v_merchant_funnel.revenue`; a string decimal on the wire (API §1). */
  revenue: Money;
  /** Conversion rates derived from the funnel, 0..1. */
  conversion: { view_to_click: Nullable<number>; click_to_action: Nullable<number>; action_to_order: Nullable<number> };
  /** Count of open conversation/handoff items — API §5 `/merchant/conversations`. */
  open_conversations: number;
  /** Offerings awaiting review from an import — API §5.1. */
  pending_proposals: number;
  /** Whether the numbers include demo rows (DECISIONS D6). */
  data_origin: DataOrigin;
}

/** `GET /api/v1/merchant/analytics?from&to&metric` point (API §5, spec §56). */
export interface AnalyticsPoint {
  /** Bucket start (UTC day/hour). */
  bucket_start: IsoDateTime;
  /** Metric name requested, e.g. `views`, `revenue`. */
  metric: string;
  /** Value; null when the bucket genuinely has no data — never zero-filled (DECISIONS D6). */
  value: number | null;
  /** Money-valued metrics carry currency instead of a bare number. */
  amount?: Nullable<Money>;
  /** Comparison to the previous equal-length window. */
  delta_pct?: Nullable<number>;
}

/** Paged analytics series. */
export interface AnalyticsSeries {
  /** Merchant. */
  merchant_id: Uuid;
  /** Requested range start. */
  from: IsoDateTime;
  /** Requested range end. */
  to: IsoDateTime;
  /** Bucket granularity — `hour|day|week`. */
  granularity: string;
  /** Data points, ascending. */
  points: AnalyticsPoint[];
  /** Whether the window includes synthetic/demo data — V1 `data_origin`. */
  demo: boolean;
}

/** A knowledge-base entry. **Source: API_CONTRACT §5** (`/merchant/knowledge-base`, permission `read_products`), V1 `documents` (493-511). */
export interface KnowledgeBaseDocument {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid | null;
  /** Offering the doc describes — V1 `offering_id`. */
  offering_id: Uuid | null;
  /** `menu|policy|faq|description|review|image_meta|url|pdf|xlsx` — V1 `kind`. */
  kind: string;
  /** Original location — V1 `source_uri`; untrusted if external (AGENT §8). */
  source_uri: string | null;
  /** Title — V1 `title`. */
  title: string | null;
  /** MIME type — V1 `mime_type`. */
  mime_type: string | null;
  /** Language — V1 `lang`. */
  lang: string | null;
  /** Content hash used for embedding cache keys — V1 `content_hash`, AGENT §9. */
  content_hash: string;
  /** `pending|processing|indexed|failed` — V1 `status`. */
  status: string;
  /** Failure detail — V1 `error`. */
  error: string | null;
  /** Chunk count produced by the pipeline — derived from V1 `chunks`. */
  chunk_count?: number;
  /** Metadata — V1 `metadata jsonb`. */
  metadata?: Record<string, unknown>;
  /** Timestamps — V1 `created_at`/`updated_at`. */
  created_at?: IsoDateTime;
  /** @see created_at */
  updated_at?: IsoDateTime;
}

/** Response of `POST /api/v1/merchant/knowledge-base/reindex` (API §5, permission `configure_ai`). */
export interface ReindexJob {
  /** Job id for polling. */
  job_id: Uuid;
  /** Documents queued for reindex — AGENT §7 "editing a merchant doc enqueues reindex of that doc's chunks only". */
  document_ids: Uuid[];
  /** Queue state. */
  status: string;
  /** Estimated chunks. */
  chunk_estimate?: number;
}

/** Price quote used in cart re-pricing (API §6 `price-check`). */
export interface PriceQuote {
  /** Offering priced. */
  offering_id: Uuid;
  /** Current server price. */
  price: Price;
  /** Whether the cached price exceeded its TTL (AGENT §5: price 6h, inventory 15m). */
  stale: boolean;
  /** Freshness instant the verdict was computed at. */
  as_of: IsoDateTime;
  /** Fact backing the number (AGENT §4). */
  fact_id: Uuid | null;
}
