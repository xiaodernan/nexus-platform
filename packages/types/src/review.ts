/**
 * Reviews and AI review summaries.
 *
 * Contract: API_CONTRACT §4 (`GET /merchants/{id}/reviews`, `/reviews/summary` — "AI summary
 * **with review_ids as evidence** (§55)"; `POST /merchants/{id}/reviews` — "verified purchase/
 * reservation flags computed server-side"), §6 (`Idempotency-Key` required on review create).
 * Tables: V1 `reviews` (410-434), `review_summaries` (436-445).
 * Spec: §54 Review System, §55 Review Intelligence, §109 No Fake Reviews.
 */

import type { ReviewDataOrigin, ReviewSort, ReviewStatus } from "./enums.js";
import type { IsoDateTime, LocalizedName, Nullable, PageRequest, Timestamps, Uuid } from "./common.js";

/* enum unions used below are declared in enums.ts */

/** A photo attached to a review. Source: V1 `reviews.photos jsonb`. */
export interface ReviewPhoto {
  /** Stored object URL — V1 `photos[].url`. */
  url: string;
  /** Accessible alt text. */
  alt?: string | null;
  /** OCR/label result; **untrusted input** (AGENT_CONTRACT §8 lists "images' OCR" as untrusted). */
  detected?: string | null;
}

/**
 * A review. **Source: V1 `reviews` (410-431)**. `verified_purchase` / `verified_reservation` are
 * computed server-side from `orders` / `reservations` — a client may not set them
 * (API_CONTRACT §6, spec §109).
 */
export interface Review extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** Merchant reviewed — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Specific offering; null for a whole-merchant review — V1 `offering_id`. */
  offering_id: Uuid | null;
  /** Author; null for anonymous/imported — V1 `user_id`. */
  user_id: Uuid | null;
  /** Display label for anonymous or imported rows — V1 `author_label`. */
  author_label: string | null;
  /** 1..5 — V1 `rating numeric(2,1)` CHECK 1..5. */
  rating: number;
  /** Optional headline — V1 `title`. */
  title: string | null;
  /** Body text; untrusted content (AGENT_CONTRACT §8). V1 `body` (NOT NULL). */
  body: string;
  /** Language of the body — V1 `language` default `zh-HK` (AGENT §12). */
  language: string;
  /** Attached photos — V1 `photos jsonb`. */
  photos: ReviewPhoto[];
  /** Backed by a completed order — V1 `verified_purchase`. */
  verified_purchase: boolean;
  /** Backed by a completed reservation — V1 `verified_reservation`. */
  verified_reservation: boolean;
  /** `demo|user|imported` — V1 `data_origin`; `demo` must be badged (DECISIONS D6, spec §109). */
  data_origin: ReviewDataOrigin;
  /** `pending|published|rejected|flagged` — V1 `status`. */
  status: ReviewStatus;
  /** Moderation metadata (flags, reviewer, notes) — V1 `moderation jsonb`. */
  moderation: Record<string, unknown>;
  /** "Helpful" counter feeding `sort=helpful` — V1 `helpful_count`, API §4. */
  helpful_count: number;
  /** Aspect scores, e.g. `{"service":4.5,"waiting_time":2.0}` — V1 `aspects jsonb`. */
  aspects: Record<string, number>;
  /** Order/reservation that authorised the review, when known. */
  subject_order_id?: Nullable<Uuid>;
  /** @see subject_order_id */
  subject_reservation_id?: Nullable<Uuid>;
}

/** `POST /api/v1/merchants/{id}/reviews` body (API_CONTRACT §6). Verification flags are **not** accepted from clients. */
export interface ReviewCreateRequest {
  /** 1..5 integer or one-decimal rating — V1 CHECK. */
  rating: number;
  /** Optional headline — V1 `title`. */
  title?: string | null;
  /** Review text — V1 `body` (NOT NULL). */
  body: string;
  /** Offering being reviewed — V1 `offering_id`. */
  offering_id?: Uuid | null;
  /** Photo object keys — V1 `photos`. */
  photos?: Array<{ url: string; alt?: string | null }>;
  /** Aspect ratings — V1 `aspects`. */
  aspects?: Record<string, number>;
  /** Locale of the text — V1 `language`. */
  language?: string;
  /** Order or reservation the review is about; the server verifies it — API §6. */
  subject_id?: Uuid | null;
  /** `order|reservation` — tells the server which table to verify against. */
  subject_type?: "order" | "reservation" | null;
}

/** One evidence-backed bullet in an AI summary. **Source: API_CONTRACT §4** — the summary must
 * carry `review_ids` as evidence (spec §55); V1 `review_summaries.praise/complaints`
 * (`[{label, evidence_count, review_ids}]`). */
export interface ReviewSummaryPoint {
  /** Localised label, e.g. `「分量足」`. */
  label: LocalizedName | string;
  /** How many reviews support it — V1 `evidence_count`. */
  evidence_count: number;
  /** The supporting review ids — API §4; never invent quotes (AGENT §1 `review` agent). */
  review_ids: Uuid[];
  /** Sentiment of the point. */
  sentiment?: "praise" | "complaint";
  /** Confidence of the clustering, 0..1 (AGENT §4 phrasing rule). */
  confidence?: Nullable<number>;
}

/**
 * AI review summary for a merchant. **Source: API_CONTRACT §4**
 * (`GET /api/v1/merchants/{id}/reviews/summary`), V1 `review_summaries` (436-445);
 * recomputed at 24h or ≥5 new reviews (AGENT_CONTRACT §5).
 */
export interface ReviewSummary {
  /** Merchant — V1 `merchant_id` (primary key: one summary per merchant). */
  merchant_id: Uuid;
  /** Smoothed overall score — V1 `overall numeric(3,2)`. */
  overall: number;
  /** Frequently praised — V1 `praise jsonb`. */
  praise: ReviewSummaryPoint[];
  /** Frequently complained about — V1 `complaints jsonb`. */
  complaints: ReviewSummaryPoint[];
  /** Reviews included in the computation — V1 `sample_size`. */
  sample_size: number;
  /** Model that generated it, `mock` when heuristic (DECISIONS D4) — V1 `model`. */
  model: string | null;
  /** Generation instant — V1 `generated_at`. */
  generated_at: IsoDateTime;
  /** Last recompute — V1 `updated_at`. */
  updated_at?: IsoDateTime;
  /** Narrative text; every claim must trace to {@link ReviewSummaryPoint.review_ids} (spec §55). */
  text?: string | null;
  /** Review ids backing {@link text}. */
  evidence_review_ids?: Uuid[];
}

/** Distribution helper for the rating histogram UI. Not persisted; derived by the platform. */
export interface RatingDistribution {
  /** Bucket, 1..5. */
  bucket: number;
  /** Count in the bucket. */
  count: number;
  /** Share of the sample, 0..1. */
  share: number;
}

/**
 * Query for `GET /api/v1/merchants/{id}/reviews?sort=recent|helpful&cursor=`
 * (**API_CONTRACT §4**).
 */
export interface ReviewListQuery extends PageRequest {
  /** Ordering — API §4 `sort`. */
  sort?: ReviewSort;
  /** Restrict to one offering — V1 `reviews.offering_id`. */
  offering_id?: Uuid | null;
  /** Minimum rating filter. */
  min_rating?: number;
  /** Only verified-purchase / verified-reservation reviews (flags computed server-side, API §6). */
  verified_only?: boolean;
}
