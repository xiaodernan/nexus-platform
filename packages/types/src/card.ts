/**
 * EntityCard — the **single render contract** for consumer UI, AI answers and MCP/UCP payloads.
 *
 * Contracts: API_CONTRACT §2 (`EntityCard`, "the single render contract for consumer + AI + MCP
 * surfaces (§35)"), AGENT_CONTRACT §4 (renderer contract: every rendered number needs a fact),
 * AGENT_CONTRACT §6 (`flags.sponsored` inserted after organic scoring).
 * Spec: §35 Recommendation Cards (image/title/price/rating/distance/open-AI-match/CTA),
 * §36 AI Result Interface, §115 Search Result Types.
 *
 * The union is discriminated by `card_type` (API_CONTRACT §2 comment
 * `merchant|product|service|experience|collection`), and every member shares {@link EntityCardBase}
 * so a renderer can switch on `card_type` without narrowing the common fields again.
 */

import type { CardActionType, CardType } from "./enums.js";
import type {
  DistanceInfo,
  GeoPoint,
  ImageAsset,
  IsoDateTime,
  Price,
  RatingInfo,
  Slug,
  Uuid,
} from "./common.js";
import type {
  AiMatchInfo,
  AvailabilityInfo,
  EntityFlags,
  Fact,
  OpeningState,
} from "./fact.js";

/** `CardType` (discriminant of {@link EntityCard}) and `CardActionType` come from `enums.ts`. */

/**
 * A call-to-action on a card. **Source: API_CONTRACT §2 `EntityCard.actions[]`**
 * (`{type,label,endpoint}`).
 *
 * `endpoint` is a *platform* path (`/api/v1/reservations`), never an AI-service path, because
 * mutations must go through the platform with a scoped token (API_CONTRACT §0, DECISIONS D5)
 * and require an explicit user action (AGENT_CONTRACT §8).
 */
export interface CardAction {
  /** CTA kind — see {@link CardActionType}. */
  type: CardActionType | (string & {});
  /** Localised button label, e.g. `"预订"` (API_CONTRACT §2, AGENT_CONTRACT §12). */
  label: string;
  /** Relative platform endpoint to call; null for client-side-only actions (e.g. `compare`). */
  endpoint: string | null;
  /** HTTP verb implied by the action; defaults to `POST` when absent. */
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Static body/params merged into the request (must not carry prices — server re-prices, API_CONTRACT §6). */
  payload?: Record<string, unknown> | null;
  /** Requires an authenticated session (API_CONTRACT §3). */
  requires_auth?: boolean;
  /** Muted/secondary styling hint. */
  secondary?: boolean;
}

/**
 * Fields common to every card type. Field optionality follows spec §8 / API_CONTRACT §8's
 * "必须允许不确定字段": an uncertain value is `T | null`, never a guessed default.
 */
export interface EntityCardBase {
  /** Discriminant — API_CONTRACT §2. */
  card_type: CardType;
  /** Subject id (merchant / offering / collection) — API_CONTRACT §2 `id`. */
  id: Uuid;
  /** URL slug — V1 `merchants.slug` / `offerings.slug` / `collections.slug`; API §4 accepts `id_or_slug`. */
  slug: Slug | null;
  /** Primary title — API_CONTRACT §2 `title` (e.g. `"龍苑 Kitchen"`). */
  title: string;
  /** Localised secondary line, e.g. `"Cantonese · Sha Tin"` — API_CONTRACT §2 `subtitle`. */
  subtitle?: string | null;
  /** Optional description snippet; treat as untrusted content (AGENT_CONTRACT §8). */
  description?: string | null;
  /** Cover image — API_CONTRACT §2 `image`. */
  image?: ImageAsset | null;
  /** Price block — API_CONTRACT §2 `price`. Rendered numbers must have a backing fact in {@link facts}. */
  price?: Price | null;
  /** Aggregate rating — API_CONTRACT §2 `rating`. */
  rating?: RatingInfo | null;
  /** Distance from the request origin — API_CONTRACT §2 `distance`. */
  distance?: DistanceInfo | null;
  /** Computed open/closed state — API_CONTRACT §2 `open`. */
  open?: OpeningState | null;
  /** Real-time availability — API_CONTRACT §2 `availability` (no cache, AGENT §5). */
  availability?: AvailabilityInfo | null;
  /** AI match score + explanation bullets — API_CONTRACT §2 `ai_match`. */
  ai_match?: AiMatchInfo | null;
  /** CTAs — API_CONTRACT §2 `actions`. */
  actions?: CardAction[];
  /**
   * Facts backing **every rendered number** on this card (API_CONTRACT §2 `facts`,
   * AGENT_CONTRACT §4). `[]` means "nothing on this card is claim-grade" and the renderer must
   * therefore not show prices/ratings/availability.
   */
  facts: Fact[];
  /** Sponsored / demo / unverified badges — API_CONTRACT §2 `flags`. */
  flags: EntityFlags;
  /** Owning tenant slug or id — API_CONTRACT §1 `X-Tenant`, DECISIONS D5. */
  tenant_id?: Uuid | string | null;
  /** Convenience: the merchant id even when the card is not a merchant card. */
  merchant_id?: Uuid | null;
  /** Category slug — V1 `merchants.category_primary`. */
  category?: string | null;
  /** Tags for chips — V1 `merchants.tags text[]`. */
  tags?: string[];
  /** Structured attributes (`quiet_ambience`, `kid_friendly`, `mtr_within_5min`, …) — V1 `merchants.attributes jsonb`. */
  attributes?: Record<string, unknown>;
  /** Location used for distance/geo rendering — V1 `locations.lat/lng`, API_CONTRACT §2 `GeoPoint`. */
  location?: GeoPoint | null;
  /** District label, HK convention — V1 `locations.district`, AGENT_CONTRACT §12. */
  district?: string | null;
  /** Nearest MTR station and walk minutes — V1 `locations.mtr_station`/`mtr_walk_min`. */
  transit?: { station: string | null; walk_minutes: number | null } | null;
  /** When this card payload was assembled — helps clients detect stale renders. */
  as_of?: IsoDateTime | null;
}

/** Merchant card (`card_type: "merchant"`). API_CONTRACT §2; spec §35 "Merchant Card". */
export interface MerchantCard extends EntityCardBase {
  card_type: "merchant";
  /** Primary location id — V1 `locations.id`. */
  location_id?: Uuid | null;
  /** Verified ownership badge — V1 `merchants.ownership_verified`. */
  ownership_verified?: boolean;
  /** Merchant plan tier; must never influence organic rank (AGENT_CONTRACT §6, spec §67). */
  plan?: string | null;
  /** Whether the merchant's own AI agent answers questions — V1 `merchants.ai_agent_enabled`. */
  ai_agent_enabled?: boolean;
}

/** Card for a sellable product. API_CONTRACT §2 / spec §35, §41 (universal cart holds it). */
export interface ProductCard extends EntityCardBase {
  card_type: "product";
  /** Owning merchant display name — V1 `merchants.display_name`. */
  merchant_name?: string | null;
  /** Stock left; null = untracked (V1 `offerings.stock_quantity` comment). */
  stock_quantity?: number | null;
  /** Whether the item can be added to the cart (API_CONTRACT §6 `POST /carts/items`). */
  purchasable?: boolean;
}

/** Card for a bookable service. API_CONTRACT §2 / spec §35; V1 `offerings.kind = 'service'`. */
export interface ServiceCard extends EntityCardBase {
  card_type: "service";
  merchant_name?: string | null;
  /** Duration in minutes — V1 `offerings.duration_minutes`. */
  duration_minutes?: number | null;
  /** Bookable via reservation flow — V1 `offerings.bookable`; API_CONTRACT §6. */
  bookable?: boolean;
  /** Party-size bounds — V1 `offerings.min_party_size` / `max_party_size`. */
  min_party_size?: number | null;
  /** @see min_party_size */
  max_party_size?: number | null;
}

/** Card for an experience / itinerary leg. API_CONTRACT §2 / spec §35; V1 `offerings.kind = 'experience'`. */
export interface ExperienceCard extends EntityCardBase {
  card_type: "experience";
  merchant_name?: string | null;
  duration_minutes?: number | null;
  bookable?: boolean;
  /** Season / theme attributes — V1 `offerings.attributes` (`season`, `cuisine`, `spicy_level`). */
  season?: string | null;
  /** Legs of a multi-stop experience, ordered. */
  legs?: EntityCard[];
}

/** Card for a curated collection or guide. API_CONTRACT §2 / §8 (`/api/v1/collections`), spec §63/§64. */
export interface CollectionCard extends EntityCardBase {
  card_type: "collection";
  /** `collection|guide|itinerary` — V1 `collections.kind`. */
  kind?: string | null;
  /** Author handle; guides may be AI-authored and must say so (spec §28/§64). */
  author?: string | null;
  /** Ordered member cards (already fact-backed, AGENT_CONTRACT §4). */
  items?: EntityCard[];
  /** Total member count before trimming. */
  item_count?: number | null;
  /** Publication instant — V1 `collections.published_at`. */
  published_at?: IsoDateTime | null;
}

/**
 * Discriminated union of all card variants. Narrow with `card.card_type`.
 * **Source: API_CONTRACT §2 `EntityCard`.**
 */
export type EntityCard =
  | MerchantCard
  | ProductCard
  | ServiceCard
  | ExperienceCard
  | CollectionCard;

/** `EntityCard` narrowed to one `card_type`. */
export type CardOfType<T extends CardType> = Extract<EntityCard, { card_type: T }>;

/**
 * Search result "slot label" used by the AI result interface (spec §36: "Best match",
 * "Best value", "Closest", "Most popular") and by {@link RecommendationSet} groups.
 */
export const RECOMMENDATION_SLOT = [
  "best_match",
  "best_value",
  "closest",
  "most_popular",
  "open_now",
  "sponsored",
  "organic",
] as const;
/** Named placement within a result set — spec §36, AGENT_CONTRACT §6. */
export type RecommendationSlot = (typeof RECOMMENDATION_SLOT)[number];
