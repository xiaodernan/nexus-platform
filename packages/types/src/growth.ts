/**
 * Growth & creator surfaces: campaigns, coupons, collections/guides, referrals, subscriptions,
 * SEO pages, share links.
 *
 * Contract: API_CONTRACT §8 (referrals, collections, guides, share), §5 (merchant campaigns and
 * coupons, `Idempotency-Key` on campaign publish; "AI drafts land in `draft`", publish is an
 * **explicit human action**), §9 (admin moderation of content).
 * Tables: V1 `campaigns` (679-699), `coupons` (658-677), `collections` (636-655),
 * `referrals` (701-715), `subscriptions` (717-732), `seo_pages` (735-759).
 * Spec: §27 Merchant AI Marketing Agent, §28-§30 SEO agents/architecture, §59-§62 growth + viral
 * loop + referrals, §63 Creator System, §64 AI-generated Local Guides, §65 monetization, §110 no fake traffic.
 */

import type {
  CampaignChannel,
  CampaignGenerator,
  CampaignStatus,
  CollectionKind,
  CouponKind,
  CouponStatus,
  DataOrigin,
  MembershipPlan,
  ReferralKind,
  ReferralStatus,
  ReferrerType,
  SeoPageKind,
  SeoPageStatus,
  Visibility,
} from "./enums.js";
import type { EntityCard } from "./card.js";
import type { IsoDateTime, LocalizedName, Money, Nullable, Slug, Timestamps, Uuid } from "./common.js";

/* enum unions used below are declared in enums.ts */

/** Audience targeting definition. Source: V1 `campaigns.audience jsonb`; spec §27/§59. */
export interface CampaignAudience {
  /** Named segment, e.g. `nearby_regulars`. */
  segment?: string | null;
  /** Districts to target — V1 `locations.district`. */
  districts?: string[];
  /** Minimum past-visit count; only real events may be used (spec §110). */
  min_visits?: number;
  /** Target fans of the merchant — V1 `favorites`. */
  favorites_only?: boolean;
  /** Estimated reach computed from real rows; null until the preview runs. */
  estimated_reach?: Nullable<number>;
  /** Free-form filters, snake_case. */
  [filter: string]: unknown;
}

/** Generated creative for a campaign. Source: V1 `campaigns.creative jsonb` ("generated copy, images, landing page"); spec §27. */
export interface CampaignCreative {
  /** Localised headline pair. */
  headline?: LocalizedName;
  /** Localised body copy. */
  body?: LocalizedName;
  /** Creative images; seeded ones must be labelled synthetic (DECISIONS D6). */
  images?: Array<{ url: string; alt?: string | null; credit?: string | null }>;
  /** Landing page path or id — V1 `seo_pages.path`. */
  landing_page?: string | null;
  /** Call to action label. */
  cta_label?: string | null;
  /** CTA target. */
  cta_url?: string | null;
}

/** Per-channel campaign metrics. Source: V1 `campaigns.metrics jsonb`; derived only from real events (spec §110, §161). */
export interface CampaignMetrics {
  /** Delivered per channel — key is a {@link CampaignChannel}. */
  sent: Partial<Record<CampaignChannel, number>>;
  /** Opens/clicks. */
  opens?: number;
  clicks?: number;
  /** Attributed conversions (reserve/purchase) — V1 `events`. */
  conversions?: number;
  /** Revenue attributed, string decimal on the wire (API §1). */
  revenue?: Nullable<Money>;
  /** Spend charged to the merchant — V1 `subscriptions.amount`; must not affect organic rank (spec §67). */
  spend?: Nullable<Money>;
  /** Computed conversion rate 0..1. */
  conversion_rate?: Nullable<number>;
}

/**
 * A marketing campaign. **Source: API_CONTRACT §5** (`POST /merchant/campaigns`, AI drafts land
 * in `draft`; `approve-publish` is the explicit human action), V1 `campaigns` (679-698);
 * AGENT_CONTRACT §1 forbids the `marketing` agent from publishing (spec §27).
 */
export interface Campaign extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** Title — V1 `title`. */
  title: string;
  /** Business goal in the merchant's words — V1 `goal` (`'increase weekday afternoon traffic'`). */
  goal: string | null;
  /** `push|email|whatsapp|landing|social` — V1 `channel text[]`, spec §27. */
  channel: CampaignChannel[];
  /** Targeting — V1 `audience jsonb`. */
  audience: CampaignAudience;
  /** Generated copy/creative — V1 `creative jsonb`. */
  creative: CampaignCreative;
  /** Coupons attached — V1 `coupon_ids uuid[]`. */
  coupon_ids: Uuid[];
  /** `draft|awaiting_approval|scheduled|live|paused|ended` — V1 `status`. */
  status: CampaignStatus;
  /** `ai_marketing_agent|merchant|platform_ops` — V1 `generated_by`; the AI badge in the UI (spec §108). */
  generated_by: CampaignGenerator;
  /** Results so far — V1 `metrics jsonb`. */
  metrics: CampaignMetrics;
  /** Human approver — V1 `approved_by`; never an agent (AGENT §8, spec §27). */
  approved_by: Uuid | null;
  /** Approval instant — V1 `approved_at`. */
  approved_at: IsoDateTime | null;
  /** Flight window — V1 `starts_at` / `ends_at`. */
  starts_at: IsoDateTime | null;
  /** @see starts_at */
  ends_at: IsoDateTime | null;
}

/** `POST /api/v1/merchant/campaigns` body (API_CONTRACT §5, permission `create_draft_campaign`). */
export interface CampaignCreateRequest {
  /** @see Campaign.title */
  title: string;
  /** @see Campaign.goal */
  goal?: string | null;
  /** @see Campaign.channel */
  channel: CampaignChannel[];
  /** @see Campaign.audience */
  audience?: CampaignAudience;
  /** @see Campaign.creative */
  creative?: CampaignCreative;
  /** @see Campaign.coupon_ids */
  coupon_ids?: Uuid[];
  /** @see Campaign.starts_at */
  starts_at?: IsoDateTime | null;
  /** @see Campaign.ends_at */
  ends_at?: IsoDateTime | null;
  /** Drafts are always created as `draft`; a client cannot request `live` (AGENT §1). */
  merchant_id: Uuid;
}

/** `POST /api/v1/merchant/campaigns/{id}/approve-publish` body (API_CONTRACT §5, permission `publish_campaign`, `Idempotency-Key` required). */
export interface CampaignPublishRequest {
  /** Human approver's decision note, written to `audit_logs` — API §1/§9. */
  note?: string | null;
  /** Publish immediately or schedule. */
  schedule_at?: IsoDateTime | null;
  /** Optional override of the flight end. */
  ends_at?: IsoDateTime | null;
}

/**
 * A coupon. **Source: API_CONTRACT §5** (`POST /merchant/coupons`, permission
 * `create_draft_campaign` — AI-authored coupons stay in `draft`), V1 `coupons` (658-677).
 */
export interface Coupon {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** Merchant; null for a platform coupon — V1 `merchant_id`. */
  merchant_id: Uuid | null;
  /** Code, unique per tenant — V1 `code`, `UNIQUE (tenant_id, code)`. */
  code: string;
  /** `percent|fixed|free_item` — V1 `kind`. */
  kind: CouponKind;
  /**
   * Discount magnitude in the unit implied by {@link kind} (percent points, an amount, or a count
   * of free items) — V1 `value numeric(12,2)`. Use {@link amount} when a currency is required.
   */
  value: number;
  /** Money form of {@link value} when `kind` is `fixed`. */
  amount?: Nullable<Money>;
  /** Minimum basket total — V1 `min_spend`. */
  min_spend: Nullable<number>;
  /** Global redemption cap — V1 `max_uses`. */
  max_uses: Nullable<number>;
  /** Redemptions so far — V1 `used_count`. */
  used_count: number;
  /** Restriction map (`offering_ids`, `categories`, `weekday`) — V1 `applies_to jsonb`. */
  applies_to: Record<string, unknown>;
  /** Validity window — V1 `starts_at` / `ends_at` (both NOT NULL). */
  starts_at: IsoDateTime;
  /** @see starts_at */
  ends_at: IsoDateTime;
  /** `draft|scheduled|active|exhausted|retired` — V1 `status`. */
  status: CouponStatus;
  /** Creator (may be the marketing agent) — V1 `created_by`. */
  created_by: Uuid | null;
  /** Human who published it — V1 `published_by` comment "explicit human authorization (§27)". */
  published_by: Uuid | null;
  /** Publish instant — V1 `published_at`. */
  published_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at?: IsoDateTime;
}

/** `POST /api/v1/merchant/coupons` body (API_CONTRACT §5). */
export interface CouponCreateRequest {
  /** @see Coupon.kind */
  kind: CouponKind;
  /** @see Coupon.value */
  value: number;
  /** @see Coupon.code */
  code?: string | null;
  /** @see Coupon.min_spend */
  min_spend?: Nullable<number>;
  /** @see Coupon.max_uses */
  max_uses?: Nullable<number>;
  /** @see Coupon.applies_to */
  applies_to?: Record<string, unknown>;
  /** @see Coupon.starts_at */
  starts_at: IsoDateTime;
  /** @see Coupon.ends_at */
  ends_at: IsoDateTime;
  /** Merchant scope — V1 `merchant_id`. */
  merchant_id: Uuid;
}

/** An ordered member of a collection. Source: V1 `collections.items jsonb` comment
 * (`ordered [{subject_type,subject_id,note}]`). */
export interface CollectionItem {
  /** `merchant|offering|guide|collection` — overlaps V1 `favorites.subject_type`. */
  subject_type: string;
  /** Target id — V1 items `subject_id`. */
  subject_id: Uuid;
  /** Curator note shown under the item — V1 items `note`. */
  note: string | null;
  /** 0-based order — V1 "ordered". */
  position?: number;
  /** Resolved card, when the collection is returned with hydrated items (API §8). */
  card?: EntityCard | null;
}

/**
 * A curated collection or AI-generated local guide. **Source: API_CONTRACT §8**
 * (`GET/POST /api/v1/collections`, `GET /api/v1/guides/{slug}` "SSR + JSON-LD"),
 * V1 `collections` (636-655); spec §63 Creator System, §64 AI Local Guides.
 */
export interface Collection extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid;
  /** Author; null for AI-generated guides (must be labelled, spec §28/§108) — V1 `author_id`. */
  author_id: Uuid | null;
  /** `collection|guide|itinerary` — V1 `kind`. */
  kind: CollectionKind;
  /** URL slug, unique per tenant — V1 `slug`. */
  slug: Slug;
  /** Title pair — V1 `title` / `title_zh`. */
  title: LocalizedName;
  /** Description — V1 `description`. */
  description: string | null;
  /** Cover image — V1 `cover_url`. */
  cover_url: string | null;
  /** Ordered members — V1 `items jsonb`. */
  items: CollectionItem[];
  /** `private|unlisted|public` — V1 `visibility`. */
  visibility: Visibility;
  /** `demo` for seeded guides — V1 `data_origin`, DECISIONS D6. */
  data_origin: DataOrigin;
  /** SEO payload incl. JSON-LD — V1 `seo jsonb`, API §8. */
  seo: Record<string, unknown>;
  /** Publication instant — V1 `published_at`. */
  published_at: IsoDateTime | null;
}

/** `POST /api/v1/collections` body (API_CONTRACT §8). */
export interface CollectionCreateRequest {
  /** @see Collection.kind */
  kind?: CollectionKind;
  /** @see Collection.slug */
  slug?: Slug;
  /** @see Collection.title */
  title: string;
  /** @see Collection.title */
  title_zh?: string | null;
  /** @see Collection.description */
  description?: string | null;
  /** @see Collection.cover_url */
  cover_url?: string | null;
  /** Members to add — V1 `items`. */
  items: Array<{ subject_type: string; subject_id: Uuid; note?: string | null }>;
  /** @see Collection.visibility */
  visibility?: Visibility;
}

/** A referral row. **Source: API_CONTRACT §8** (`/api/v1/referrals/*`), V1 `referrals` (701-715);
 * spec §60 viral loop, §61 merchant referral, §62 consumer referral.
 * Rewards are written **only** on genuine conversion events — spec §110 forbids fake growth.
 */
export interface Referral {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** `consumer|merchant|creator` — V1 `kind`, API §8 `{kind,email}`. */
  kind: ReferralKind;
  /** `user|merchant` — V1 `referrer_type`. */
  referrer_type: ReferrerType;
  /** Referrer id — V1 `referrer_id` (NOT NULL). */
  referrer_id: Uuid;
  /** Invited address — V1 `invitee_email`. */
  invitee_email: string | null;
  /** Converted account — V1 `invitee_id`. */
  invitee_id: Uuid | null;
  /** Share code, unique per referrer — V1 `code`, `UNIQUE (code, referrer_id)`. */
  code: string;
  /** `invited|signed_up|first_value|rewarded|expired` — V1 `status`. */
  status: ReferralStatus;
  /** Reward definition/snapshot — V1 `reward jsonb`. */
  reward: Record<string, unknown>;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
  /** Conversion instant — V1 `converted_at`. */
  converted_at: IsoDateTime | null;
}

/** `POST /api/v1/referrals/invite` body (API_CONTRACT §8: `{kind,email}`). */
export interface ReferralInviteRequest {
  /** @see Referral.kind */
  kind: ReferralKind;
  /** Invitee email — API §8. */
  email: string;
  /** Optional message appended to the template. */
  message?: string | null;
}

/** `GET /api/v1/referrals/me/stats` response (API_CONTRACT §8, spec §59/§161). */
export interface ReferralStats {
  /** Invites sent. */
  invited: number;
  /** Invitees who signed up. */
  signed_up: number;
  /** Invitees who reached first value (genuine conversion only, spec §110). */
  first_value: number;
  /** Rewards actually paid out. */
  rewarded: number;
  /** Value credited to the referrer. */
  earned: Nullable<Money>;
  /** Pending/expired counts. */
  expired: number;
  /** Attribution window in days used for the counts. */
  window_days: number;
}

/** `POST /api/v1/share` response (API_CONTRACT §8: "short link + OG payload"). */
export interface SharePayload {
  /** Subject kind — V1 `favorites.subject_type` vocabulary. */
  subject_type: string;
  /** Subject id. */
  subject_id: Uuid;
  /** Short link path, e.g. `/s/Ab3xK`. */
  short_url: string;
  /** Absolute canonical URL. */
  canonical_url: string;
  /** Open Graph payload for social unfurl. */
  og: {
    /** og:title */
    title: string;
    /** og:description */
    description: string | null;
    /** og:image */
    image: string | null;
    /** og:locale — AGENT §12. */
    locale: string;
    /** og:type, e.g. `business.restaurant`. */
    type?: string;
  };
  /** JSON-LD embedded in the page — V1 `seo_pages.jsonld`, API §8 (`/guides/{slug}` SSR + JSON-LD). */
  jsonld?: Record<string, unknown> | null;
  /** Tracking params appended server-side. */
  utm?: Record<string, string>;
}

/** A merchant subscription. Source: V1 `subscriptions` (717-732); spec §65 monetization. */
export interface Subscription {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** `free|pro|enterprise` — V1 `plan`. */
  plan: MembershipPlan;
  /** `active|past_due|cancelled|trialing` — V1 `status` default `active`. */
  status: string;
  /** Seats — V1 `seats`. */
  seats: number;
  /** AI credits granted — V1 `credits_total`. */
  credits_total: number;
  /** Credits consumed — V1 `credits_used`; ties to the cost roll-up (spec §160). */
  credits_used: number;
  /** Recurring amount — V1 `amount`. */
  amount: Money;
  /** Billing interval — V1 `interval` default `month`. */
  interval: string;
  /** Next renewal — V1 `renews_at`. */
  renews_at: IsoDateTime | null;
  /** Trial end — V1 `trial_ends_at`. */
  trial_ends_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
  /** @see created_at */
  updated_at: IsoDateTime;
}

/**
 * A programmatic SEO page / local guide. **Source: V1 `seo_pages` (735-758)**,
 * API_CONTRACT §8 (`GET /guides/{slug}`), §9 admin review; spec §28 (quality bar), §29 architecture,
 * §30 (must be backed by real listings), §64.
 */
export interface SeoPage extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** Path, e.g. `/hong-kong/restaurants/date-night` — V1 `path`. */
  path: string;
  /** `city|category|category_district|theme|merchant|offering|guide` — V1 `kind`. */
  kind: SeoPageKind;
  /** Title pair — V1 `title` / `title_zh`. */
  title: LocalizedName | null;
  /** Meta description — V1 `description`. */
  description: string | null;
  /** H1 — V1 `h1`. */
  h1: string | null;
  /** Body copy — V1 `body`. */
  body: string | null;
  /** FAQ entries for rich results — V1 `faq jsonb`. */
  faq: Array<{ question: string; answer: string }>;
  /** Real listings backing the page — V1 `data jsonb`; the anti-doorway guard (spec §30). */
  data: Record<string, unknown>;
  /** JSON-LD graph — V1 `jsonld jsonb`. */
  jsonld: Record<string, unknown>;
  /** Canonical URL — V1 `canonical`. */
  canonical: string | null;
  /** Language — V1 `lang` default `zh-HK`. */
  lang: string;
  /** `draft|published|noindex|retired` — V1 `status`; the seo agent may only write `draft` (AGENT §1, spec §28). */
  status: SeoPageStatus;
  /** Anti-spam quality score 0..1 — V1 `quality_score`; below the bar cannot publish (AGENT §1 `seo`). */
  quality_score: Nullable<number>;
  /** Generator identity — V1 `generated_by` default `ai_seo_agent`. */
  generated_by: string;
  /** Human reviewer — V1 `reviewed_by`. */
  reviewed_by: Uuid | null;
  /** Publication — V1 `published_at`. */
  published_at: IsoDateTime | null;
}
