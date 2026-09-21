/**
 * Shared primitives used by every NEXUS surface.
 *
 * Contract: API_CONTRACT §1 "Global conventions" — JSON only, **snake_case** keys,
 * ISO-8601 UTC timestamps, `money` as string decimal + `currency` code.
 * Spec: §14 PostgreSQL (numeric columns), §111 Internationalization, §112 Hong Kong Specific.
 */

/** Type-only helpers for enum value sets live in `enums.ts`; the literals needed by the wire
 * primitives are re-declared here so this module stays free of runtime imports. */

/** PostgreSQL `uuid` / `gen_random_uuid()`. Canonical format is validated at the edge, not in types. */
export type Uuid = string;

/** PostgreSQL `text` slug, `[a-z0-9]+(-[a-z0-9]+)*`. API_CONTRACT §4 accepts `id_or_slug`. */
export type Slug = string;

/** ISO-8601 UTC timestamp with offset, e.g. `2026-09-22T02:00:00Z` (API_CONTRACT §1). */
export type IsoDateTime = string;

/** PostgreSQL `time` without date, `HH:MM` or `HH:MM:SS` (V1__init.sql `business_hours.opens_at`). */
export type IsoTime = string;

/** IANA timezone name, V1 `tenants.timezone` default `Asia/Hong_Kong` (AGENT_CONTRACT §12). */
export type IanaTimeZone = string;

/** ISO-4217 code. V1 defaults `currency text NOT NULL DEFAULT 'HKD'`; AGENT §12 fixes HKD as the tenant default. */
export type CurrencyCode = string;

/** A supported UI/AI locale (AGENT_CONTRACT §12: `en`, `zh-HK` default, `zh-CN`). Free-form is allowed because tenants carry `locales text[]`. */
export type Locale = SupportedLocaleLiteral | (string & {});

/** Literal member type of {@link SUPPORTED_LOCALE} without importing the value (keeps this module type-only). */
export type SupportedLocaleLiteral = "en" | "zh-HK" | "zh-CN";

/** Type helper: `T | null` for a field the contract says may be unknown (spec §8 「必须允许不确定字段」). */
export type Nullable<T> = T | null;

/** Unstructured JSON object payload — used for every `jsonb` column that the contracts leave open. */
export interface JsonObject {
  [key: string]: unknown;
}

/**
 * Money. **Source: API_CONTRACT §2 (`Money`)** — the amount is a string decimal so no float
 * rounding ever touches a price; pairs with V1 `numeric(12,2)` columns
 * (`offerings.price_amount`, `orders.total`, `payments.amount`, …).
 * Currency is always carried alongside; there is no implicit HKD at the wire layer.
 */
export interface Money {
  /** Decimal string, e.g. `"128.00"` — API_CONTRACT §1/§2. */
  amount: string;
  /** ISO-4217 code, e.g. `"HKD"` — API_CONTRACT §2. */
  currency: CurrencyCode;
}

/**
 * Price as rendered on a card. **Source: API_CONTRACT §2 `EntityCard.price`**
 * (`{amount, currency, model:"per_person"}`). `model` mirrors V1 `offerings.price_model`;
 * `min`/`max` mirror V1 `offerings.price_min`/`price_max` for `model: "range"`.
 */
export interface Price extends Money {
  /** How to read the number — V1 `offerings.price_model`; API_CONTRACT §2. */
  model?: PriceModelLiteral | (string & {});
  /** Lower bound when `model` is `range`/`from_price`; null when not published. */
  min?: string | null;
  /** Upper bound when `model` is `range`; null when not published. */
  max?: string | null;
  /**
   * Provenance of the number, because §20 freshness differs per source (price TTL 6h).
   * V1 `offerings.price_source`.
   */
  source?: PriceSourceLiteral | (string & {});
  /** When this price was last confirmed — V1 `offerings.price_updated_at`; AGENT_CONTRACT §5. */
  priced_at?: IsoDateTime | null;
  /** AGENT_CONTRACT §5: never silently charge a stale price (API_CONTRACT §6 `price-check`). */
  stale?: boolean;
}

/** Literal of {@link PRICE_MODEL} (`fixed|from_price|per_person|hourly|range`). */
export type PriceModelLiteral =
  | "fixed"
  | "from_price"
  | "per_person"
  | "hourly"
  | "range";

/** Literal of {@link PRICE_SOURCE} (`merchant|imported|observed|estimated`). */
export type PriceSourceLiteral = "merchant" | "imported" | "observed" | "estimated";

/**
 * Geographic point. **Source: API_CONTRACT §2 (`GeoPoint`)**; stored as V1
 * `locations.lat/lng numeric(9,6)`. Precision is consent-gated (AGENT_CONTRACT §1
 * `location` agent: "no precise geo without user consent").
 */
export interface GeoPoint {
  /** WGS-84 latitude, -90..90. */
  lat: number;
  /** WGS-84 longitude, -180..180. */
  lng: number;
  /** Accuracy radius in metres; null when unknown (never guessed — spec §8). */
  accuracy_m?: number | null;
}

/** Lat/long bbox used by `GET /api/v1/locations/geo?bbox=` (API_CONTRACT §4) and AGENT §6 geo prefilter. */
export interface GeoBoundingBox {
  /** Southern edge. */
  south: number;
  /** Western edge. */
  west: number;
  /** Northern edge. */
  north: number;
  /** Eastern edge. */
  east: number;
}

/**
 * Distance as rendered on a card. **Source: API_CONTRACT §2 `EntityCard.distance`**
 * (`{meters, text, travel_minutes}`); `text` is the localised string, computed server-side so
 * every surface renders identically.
 */
export interface DistanceInfo {
  /** Straight-line metres from the request origin; null when no origin was supplied. */
  meters: number | null;
  /** Pre-formatted label, e.g. `"700m"`, `"1.2km"`. */
  text: string | null;
  /** Estimated door-to-door minutes; null when the travel model has no data. */
  travel_minutes?: number | null;
  /** Origin the distance was measured from — never echoed back if it is precise geo. */
  from?: GeoPoint | null;
}

/** Rating value + sample size. **Source: API_CONTRACT §2 `EntityCard.rating`** (`{value:4.6,count:213}`). */
export interface RatingInfo {
  /** Aggregate score, 0-5. V1 `merchants.rating_agg numeric(3,2)` / `offerings.rating_agg`. */
  value: number | null;
  /** Review count the value was computed from — V1 `review_count`. A null/0 count means "not yet rated", and quality shrinks to the tenant mean (AGENT_CONTRACT §6). */
  count: number | null;
  /** True when `value` is a Bayesian-smoothed quality score rather than the raw mean (AGENT_CONTRACT §6). */
  smoothed?: boolean;
}

/** Image asset. **Source: API_CONTRACT §2 `EntityCard.image`** (`{url, alt, credit}`). `credit: "synthetic"` is the honesty marker for demo art (DECISIONS D6, spec §109). */
export interface ImageAsset {
  /** Absolute or CDN URL. */
  url: string;
  /** Accessible alt text, localised per AGENT_CONTRACT §12. */
  alt?: string | null;
  /** Attribution; `"synthetic"` for seeded assets. */
  credit?: string | null;
  /** Declared width in px, when the seed data knows it. */
  width?: number | null;
  /** Declared height in px. */
  height?: number | null;
  /** blurhash / dominant-colour placeholder token. */
  placeholder?: string | null;
}

/** Ordering + paging fields shared by V1 tables that carry `sort_order`/`created_at`. */
export interface Timestamps {
  /** Row creation time, V1 `created_at timestamptz DEFAULT now()`. */
  created_at: IsoDateTime;
  /** Last mutation, maintained by the `set_updated_at()` trigger (V1 line 960). */
  updated_at: IsoDateTime;
}

/** Tenant scoping present on every tenant-owned row (DECISIONS D5: "every tenant-owned table carries `tenant_id`"). */
export interface TenantScoped {
  /** Owning tenant id — V1 `<table>.tenant_id`. */
  tenant_id: Uuid;
}

/** Multi-language text field pair used across V1 (`display_name` / `display_name_zh`, `name` / `name_zh`, `title` / `title_zh`). */
export interface LocalizedName {
  /** Primary (usually English) text. */
  value: string;
  /** Traditional-Chinese text; null when not authored (AGENT_CONTRACT §12 makes zh-HK primary copy). */
  value_zh?: string | null;
  /** BCP-47 tag of {@link value}. */
  language?: Locale;
}

/** Contact block. Source: V1 `merchants.contact jsonb`, `reservations.contact jsonb`, `orders.contact jsonb` (API_CONTRACT §6). */
export interface ContactInfo {
  /** E.164 phone number. */
  phone?: string | null;
  /** Email address (V1 `citext`). */
  email?: string | null;
  /** WhatsApp handle/number for consumer contact (spec §123). */
  whatsapp?: string | null;
  /** Merchant website. Demo rows must use `example.*` domains (DECISIONS D6). */
  site?: string | null;
  /** Free-form contact name. */
  name?: string | null;
}

/** Social profile map. Source: V1 `merchants.socials jsonb`. Keys are lower-case network names. */
export type SocialsMap = Partial<Record<"instagram" | "facebook" | "threads" | "xiaohongshu" | "youtube" | "tiktok" | "site", string>>;

/**
 * Cursor pagination envelope. **Source: API_CONTRACT §1 Pagination** —
 * `?limit=20&cursor=…` → `{ items, next_cursor, total_estimate }`.
 * `total_estimate` is an estimate by contract, not an exact count; availability/pricing lists
 * are `no-store` (API_CONTRACT §11).
 */
export interface Paginated<T> {
  /** Page contents; empty array is a valid, designed empty state (DECISIONS D6). */
  items: T[];
  /** Opaque cursor for the next page; null on the last page. */
  next_cursor: string | null;
  /** Server-side estimate of the total match count; null when the backend cannot estimate. */
  total_estimate: number | null;
}

/** Request side of the cursor contract: `GET …?limit=&cursor=`. */
export interface PageRequest {
  /** Page size, 1..100, server-clamped. Default 20 (API_CONTRACT §1 example). */
  limit?: number;
  /** Opaque cursor returned as `next_cursor` by the previous page. */
  cursor?: string | null;
}

/** Free-form query/filter map carried on search-ish payloads. Keys stay snake_case (API_CONTRACT §1). */
export type FilterMap = Record<string, string | number | boolean | string[] | null>;
