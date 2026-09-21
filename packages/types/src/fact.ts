/**
 * Trust-layer primitives: facts, computed opening state, availability, explanations, flags.
 *
 * Contracts: API_CONTRACT §2 (object shapes) and AGENT_CONTRACT §4 "Trust layer — non-negotiable"
 * + §5 "Freshness policy". Spec: §19 Trust Layer, §18 Recommendation Explanation, §20 Freshness,
 * §109 No Fake Reviews.
 *
 * The invariant encoded by these types: **any number a user can see must resolve to a `Fact`**
 * (or be visibly marked as an estimate). `MatchExplanation.fact_id` is therefore part of the
 * type contract, and the renderer must drop a bullet whose `fact_id` is missing
 * (AGENT_CONTRACT §4 "Renderer contract").
 */

import type {
  AvailabilityStatus,
  FactAttribute,
  FactSource,
  FactSubjectType,
} from "./enums.js";
import type { IsoDateTime, Money, Uuid } from "./common.js";

/* The enum unions above come from `enums.ts` (single source of truth). This module deliberately
 * does not re-export them, so `index.ts` can star-export every module without name collisions. */

/**
 * Fact — the trust-layer primitive. **Source: API_CONTRACT §2 (`Fact`)**, persisted in
 * V1__init.sql `facts` (lines 537-553).
 *
 * Naming note: the wire field is **`fact_id`** while the column is `id` (V1 line 538); the
 * API shape is authoritative for transports, and the platform layer maps `id → fact_id` on
 * serialisation. `facts.merchant_id`, `unit`, `source_uri` and `created_at` exist in the table
 * but are not part of the public §2 object, so they are optional here.
 */
export interface Fact {
  /** Stable id for citation — API_CONTRACT §2 `fact_id`; V1 `facts.id`. */
  fact_id: Uuid;
  /** What the fact is about — API_CONTRACT §2 / V1 `facts.subject_type`. */
  subject_type: FactSubjectType;
  /** Id of the subject row — API_CONTRACT §2 / V1 `facts.subject_id` (NOT NULL). */
  subject_id: Uuid;
  /** Denormalised merchant for tenant-filtered lookups — V1 `facts.merchant_id`. */
  merchant_id?: Uuid | null;
  /** Attribute name, e.g. `price`, `opening_hours` — API_CONTRACT §2 / V1 `facts.attribute`. */
  attribute: string;
  /**
   * Typed value. Anything the user may be shown; for prices it is a {@link Money} object
   * (API_CONTRACT §2 example). Must be JSON-serialisable (V1 `facts.value jsonb`).
   */
  value: Money | string | number | boolean | IsoDateTime | Record<string, unknown> | unknown[];
  /** Unit for non-money scalars (`"minutes"`, `"meters"`) — V1 `facts.unit`. */
  unit?: string | null;
  /** Currency when `value` is a bare number — V1 `facts.currency`. */
  currency?: string | null;
  /** Provenance, drives conflict resolution — API_CONTRACT §2 / AGENT_CONTRACT §4. */
  source: FactSource;
  /** Where an `imported`/`third_party` value came from — V1 `facts.source_uri`. */
  source_uri?: string | null;
  /**
   * 0..1. **Never upgraded for presentation** (AGENT_CONTRACT §4): `< 0.6` must be phrased as
   * uncertain, `< 0.4` omitted with a handoff offer. V1 `numeric(4,3) DEFAULT 1.000`.
   */
  confidence: number;
  /** When the value was observed — API_CONTRACT §2 / V1 `facts.observed_at`. */
  observed_at: IsoDateTime;
  /** Freshness expiry — API_CONTRACT §2 / V1 `facts.expires_at`; TTLs per AGENT_CONTRACT §5. Null = no declared expiry. */
  expires_at: IsoDateTime | null;
  /** Server-computed staleness; must be surfaced as 「价格可能已更新」 in cart (AGENT_CONTRACT §5). */
  stale: boolean;
  /** Row insert time — V1 `facts.created_at`. Optional on the wire. */
  created_at?: IsoDateTime;
}

/** Minimal citation pointer embedded in explanations and recommendation items. */
export interface FactRef {
  /** Cited fact — API_CONTRACT §2 `MatchExplanation.fact_id`. */
  fact_id: Uuid;
  /** Optional attribute so the UI can label the citation without a fetch. */
  attribute?: FactAttribute | (string & {});
  /** Optional confidence snapshot for the 「不确定」 copy rule (AGENT_CONTRACT §4). */
  confidence?: number;
}

/**
 * Opening state — **computed, never guessed**. **Source: API_CONTRACT §2 (`OpeningState`)**.
 * Derived from V1 `business_hours` (weekday 0=Mon..6=Sun, `crosses_midnight`) and cached for
 * 24h at most (AGENT_CONTRACT §5).
 */
export interface OpeningState {
  /** Current open/closed verdict; null when the merchant has no published hours. */
  is_open: boolean | null;
  /** Next opening instant, when computable. */
  opens_at: IsoDateTime | null;
  /** Closing instant of the current (or next) session. */
  closes_at: IsoDateTime | null;
  /** The instant the verdict was computed at — required so a cached answer is never read as live. */
  as_of: IsoDateTime;
  /** Backing fact for the whole object (renderer contract, AGENT_CONTRACT §4). */
  source_fact_id: Uuid | null;
  /** Localised label, e.g. `"Open until 22:00"` — API_CONTRACT §2 `EntityCard.open.text`. */
  text?: string | null;
  /** Whether today's session crosses midnight — V1 `business_hours.crosses_midnight`. */
  crosses_midnight?: boolean;
}

/**
 * Availability as rendered on a card. **Source: API_CONTRACT §2 `EntityCard.availability`**
 * (`{status, next_slot}`). Real-time only: V1 `availability_slots.capacity_left`, TTL 0
 * (AGENT_CONTRACT §5), and `GET /merchants/{id}/availability` is explicitly no-cache
 * (API_CONTRACT §4, spec §20).
 */
export interface AvailabilityInfo {
  /** Coarse status — API_CONTRACT §2. `unknown` is a valid answer; fabricating a slot is not (DECISIONS D6). */
  status: AvailabilityStatus;
  /** Next reservable instant in UTC; null when nothing is bookable / not bookable at all. */
  next_slot: IsoDateTime | null;
  /** Slot end time, when the pool publishes durations — V1 `availability_slots.ends_at`. */
  next_slot_ends_at?: IsoDateTime | null;
  /** Seats/tables left on `next_slot` — V1 `availability_slots.capacity_left`. */
  capacity_left?: number | null;
  /** Pool the slot belongs to — V1 `availability_slots.pool_id`. */
  pool_id?: Uuid | null;
  /** Slot row id, needed to create a reservation (API_CONTRACT §6 `slot_id`). */
  slot_id?: Uuid | null;
  /** Backing fact — AGENT_CONTRACT §4 (a rendered availability must cite). */
  fact_id?: Uuid | null;
  /** `as_of` stamp; availability caches must not exceed 60s (AGENT_CONTRACT §1 `availability`). */
  as_of?: IsoDateTime | null;
}

/**
 * MatchExplanation bullet. **Source: API_CONTRACT §2 (`MatchExplanation`)** — "every bullet must
 * trace to a fact id"; AGENT_CONTRACT §1 forbids the `recommendation` agent from emitting a
 * bullet without `fact_id`; spec §18 fixes the copy format
 * (`✓ 距离你 700m · ✓ 符合预算 · ✓ 评分 4.7(200+ 条)`).
 */
export interface MatchExplanation {
  /** Machine label for styling/i18n — API_CONTRACT §2 `label` (`within_budget`). */
  label: string;
  /** User-legible sentence, already localised (AGENT_CONTRACT §12). */
  text: string;
  /** Raw value behind the sentence, as a string — API_CONTRACT §2 `value` (`"128.00"`). */
  value?: string | number | null;
  /** Normalised 0..1 feature weight of this bullet, from the top contributing features (AGENT_CONTRACT §6). */
  weight?: number | null;
  /**
   * Citation. Required by the renderer contract (AGENT_CONTRACT §4): a bullet with a null/absent
   * `fact_id` must not be rendered.
   */
  fact_id: Uuid | null;
}

/** AI match block on a card. **Source: API_CONTRACT §2 `EntityCard.ai_match`** (`{score, reasons[]}`). */
export interface AiMatchInfo {
  /** 0..1 organic match score. Sponsored placement is a separate flag and never feeds this number (AGENT_CONTRACT §6, spec §67). */
  score: number | null;
  /** Explanation bullets, each traceable to a fact. */
  reasons: MatchExplanation[];
  /** Strategy version that produced the score — V1 `recommendation_sets.strategy`; AGENT §6. */
  strategy?: string | null;
  /** Rank position within the owning set (0-based). */
  rank?: number | null;
}

/**
 * Card flags. **Source: API_CONTRACT §2 `EntityCard.flags`** (`{sponsored, demo, unverified}`).
 * - `demo` → seeded/synthetic row, must be surfaced in the UI and mirrored by the
 *   `X-Demo-Data` response header (DECISIONS D6, API_CONTRACT §2 note, spec §109/§155).
 * - `sponsored` → paid slot inserted **after** organic scoring, capped at 1 in the top 5
 *   (AGENT_CONTRACT §6, spec §66-67).
 */
export interface EntityFlags {
  /** Paid placement — AGENT_CONTRACT §6. */
  sponsored: boolean;
  /** Synthetic/seeded data — DECISIONS D6. */
  demo: boolean;
  /** Unverified ownership (`merchants.ownership_verified = false`, V1 line 89). */
  unverified: boolean;
  /** Price/availability may have moved (AGENT_CONTRACT §5). */
  stale?: boolean;
  /** Text came from an untrusted source and was sanitised (AGENT_CONTRACT §7/§8). */
  untrusted_content?: boolean;
  /** Extra flags, snake_case (API_CONTRACT §1). */
  [flag: string]: boolean | undefined;
}

/**
 * Freshness TTL table in seconds — the machine-readable form of AGENT_CONTRACT §5
 * (spec §20). `0` means "never cache" (availability).
 */
export const FRESHNESS_TTL_SECONDS = {
  /** opening hours — 24h */
  opening_hours: 86_400,
  /** description / KB docs — 7d */
  description: 604_800,
  /** price — 6h */
  price: 21_600,
  /** inventory — 15m */
  inventory: 900,
  /** availability — real-time */
  availability: 0,
  /** review summary — 24h (or ≥5 new reviews) */
  review_summary: 86_400,
  /** popularity/trending — 1h */
  popularity: 3_600,
} as const;

/** Attribute keys of {@link FRESHNESS_TTL_SECONDS}. */
export type FreshnessAttribute = keyof typeof FRESHNESS_TTL_SECONDS;

/** Minimum new reviews that force a summary recompute — AGENT_CONTRACT §5. */
export const REVIEW_SUMMARY_NEW_REVIEW_TRIGGER = 5;

/** Confidence bands from AGENT_CONTRACT §4 (`<0.6` hedge, `<0.4` omit + offer handoff). */
export const CONFIDENCE_FLOOR_PHRASE = 0.6;
/** @see CONFIDENCE_FLOOR_PHRASE — below this the claim is omitted and handoff offered. */
export const CONFIDENCE_FLOOR_OMIT = 0.4;
